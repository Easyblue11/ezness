#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ezness 远程工作空间桥。

标准输入输出上的 NDJSON 请求/响应，背后是一条常驻的 SSH/SFTP 连接。
凭据只从第一行 stdin 读入，从不进入命令行参数（否则会出现在进程列表里）。

请求：  {"id": 1, "op": "list", "path": "/home/me"}
响应：  {"id": 1, "ok": true, "result": {...}}
        {"id": 1, "ok": false, "error": "..."}

操作：
    connect   {config}                     建立连接，返回 {home, fingerprint, platform}
    list      {path}                       列目录
    stat      {path}                       文件属性
    resolve   {path}                       规范化（解析符号链接，不存在的尾部保留）
    read      {path, maxBytes, encoding}   读文件
    write     {path, content, encoding}    写文件（先写临时文件再改名）
    mkdir     {path, recursive}
    rename    {from, to}
    remove    {path, recursive}
    exec      {command, cwd, timeoutMs}    在远端执行命令
    close
"""

import base64
import hashlib
import json
import os
import posixpath
import shlex
import stat as stat_module
import sys
import threading
import time
import uuid

MAX_STDOUT = 200 * 1024
MAX_STDERR = 60 * 1024
MAX_READ = 32 * 1024 * 1024


class BridgeError(Exception):
    def __init__(self, message, code=''):
        super().__init__(message)
        self.code = code


EMIT_LOCK = threading.Lock()


def emit(payload):
    with EMIT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
        sys.stdout.flush()


def fingerprint_of(key):
    digest = hashlib.sha256(key.asbytes()).digest()
    return 'SHA256:' + base64.b64encode(digest).decode('ascii').rstrip('=')


def make_client(config):
    import paramiko

    client = paramiko.SSHClient()
    expected = str(config.get('fingerprint') or '').strip()

    class Policy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client, hostname, key):
            actual = fingerprint_of(key)
            if expected and actual != expected:
                raise BridgeError(
                    '主机指纹与保存的不一致：期望 %s，实际 %s。' % (expected, actual),
                    'fingerprint_mismatch',
                )

    client.set_missing_host_key_policy(Policy())

    host = str(config.get('host') or '').strip()
    if not host:
        raise BridgeError('没有填写主机地址。', 'invalid_config')
    port = int(config.get('port') or 22)
    username = str(config.get('username') or '').strip()
    password = config.get('password') or None
    key_path = str(config.get('privateKeyPath') or '').strip()
    passphrase = config.get('privateKeyPassphrase') or None

    kwargs = {
        'hostname': host,
        'port': port,
        'username': username,
        'timeout': 15,
        'banner_timeout': 20,
        'auth_timeout': 25,
        'allow_agent': not (password or key_path),
        'look_for_keys': not (password or key_path),
    }
    if password:
        kwargs['password'] = password
    if key_path:
        if not os.path.isfile(key_path):
            raise BridgeError('找不到私钥文件：%s' % key_path, 'missing_key')
        pkey = None
        # DSSKey was removed in paramiko 4; do not require it to exist.
        key_types = [paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey]
        dss_key = getattr(paramiko, 'DSSKey', None)
        if dss_key is not None:
            key_types.append(dss_key)
        for key_type in key_types:
            try:
                pkey = key_type.from_private_key_file(key_path, password=passphrase)
                break
            except paramiko.PasswordRequiredException:
                raise BridgeError('私钥需要口令，请填写私钥口令。', 'key_passphrase_required')
            except paramiko.SSHException:
                continue
            except Exception:
                continue
        if pkey is None:
            raise BridgeError('无法读取这个私钥文件（格式不支持或口令不正确）。', 'bad_key')
        kwargs['pkey'] = pkey

    try:
        client.connect(**kwargs)
    except BridgeError:
        raise
    except paramiko.AuthenticationException:
        raise BridgeError('认证失败：请检查用户名、密码 / 私钥，以及服务器是否允许这种登录方式。', 'auth_failed')
    except paramiko.BadHostKeyException:
        raise BridgeError('服务器的主机密钥发生了变化，为安全起见已中止连接。', 'host_key_changed')
    except paramiko.SSHException as exc:
        raise BridgeError('SSH 握手失败：%s' % exc, 'ssh_error')
    except OSError as exc:
        raise BridgeError('无法连接 %s:%s（%s）' % (host, port, exc), 'connect_failed')
    return client


class ExecJob(object):
    """One remote command. Runs in its own thread so the bridge stays responsive
    and the Node side can cancel it without waiting for the timeout."""

    def __init__(self, channel, timeout):
        self.channel = channel
        self.timeout = timeout
        self.out = []
        self.err = []
        self.out_len = 0
        self.err_len = 0
        self.done = False
        self.exit = -1
        self.timed_out = False
        self.cancelled = False
        self.condition = threading.Condition()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def run(self):
        deadline = time.time() + self.timeout
        try:
            while True:
                progressed = False
                try:
                    while self.channel.recv_ready():
                        chunk = self.channel.recv(65536)
                        progressed = True
                        if self.out_len < MAX_STDOUT:
                            take = chunk[: MAX_STDOUT - self.out_len]
                            self.out.append(take)
                            self.out_len += len(take)
                    while self.channel.recv_stderr_ready():
                        chunk = self.channel.recv_stderr(65536)
                        progressed = True
                        if self.err_len < MAX_STDERR:
                            take = chunk[: MAX_STDERR - self.err_len]
                            self.err.append(take)
                            self.err_len += len(take)
                except Exception:
                    # A 1s socket timeout on an idle channel is normal.
                    pass
                if progressed:
                    with self.condition:
                        self.condition.notify_all()
                # cancel() closes the channel from another thread; a closed
                # channel has no exit status to wait for, so stop here.
                if self.cancelled or self.channel.closed:
                    break
                if self.channel.exit_status_ready():
                    # Drain whatever is still buffered, then finish.
                    try:
                        while self.channel.recv_ready():
                            chunk = self.channel.recv(65536)
                            if self.out_len < MAX_STDOUT:
                                take = chunk[: MAX_STDOUT - self.out_len]
                                self.out.append(take)
                                self.out_len += len(take)
                        while self.channel.recv_stderr_ready():
                            chunk = self.channel.recv_stderr(65536)
                            if self.err_len < MAX_STDERR:
                                take = chunk[: MAX_STDERR - self.err_len]
                                self.err.append(take)
                                self.err_len += len(take)
                    except Exception:
                        pass
                    try:
                        self.exit = self.channel.recv_exit_status()
                    except Exception:
                        self.exit = -1
                    break
                if time.time() > deadline:
                    self.timed_out = True
                    break
                if not progressed:
                    with self.condition:
                        self.condition.wait(0.2)
        finally:
            try:
                self.channel.close()
            except Exception:
                pass
            with self.condition:
                self.done = True
                self.condition.notify_all()

    def cancel(self):
        self.cancelled = True
        try:
            self.channel.close()
        except Exception:
            pass

    def snapshot(self):
        return {
            'running': not self.done,
            'stdout': b''.join(self.out).decode('utf-8', 'replace'),
            'stderr': b''.join(self.err).decode('utf-8', 'replace'),
            'exit': self.exit,
            'timedOut': self.timed_out,
            'cancelled': self.cancelled,
        }


class Session(object):
    def __init__(self, client, home, fingerprint, platform):
        self.client = client
        self.sftp = client.open_sftp()
        self.home = home
        self.fingerprint = fingerprint
        self.platform = platform
        self.lock = threading.Lock()
        self.jobs = {}
        self.jobs_lock = threading.Lock()

    # -- 基础操作 ------------------------------------------------------

    def resolve(self, path):
        """规范化路径：已存在就取服务器 realpath，不存在就解析最近的已存在祖先。"""
        raw = str(path or '').strip() or self.home
        raw = posixpath.normpath(raw if raw.startswith('/') else posixpath.join(self.home, raw))
        current = raw
        rest = []
        for _ in range(64):
            try:
                real = self.sftp.normalize(current)
                return posixpath.join(real, *reversed(rest)) if rest else real
            except IOError:
                parent = posixpath.dirname(current)
                if parent == current:
                    return raw
                rest.append(posixpath.basename(current))
                current = parent
        return raw

    def stat(self, path):
        try:
            attr = self.sftp.stat(path)
        except IOError as exc:
            raise BridgeError(fs_error(exc, path), 'ENOENT' if 'No such file' in str(exc) else '')
        return attr_payload(attr)

    def list(self, path):
        try:
            entries = self.sftp.listdir_attr(path)
        except IOError as exc:
            raise BridgeError(fs_error(exc, path), 'ENOENT' if 'No such file' in str(exc) else '')
        rows = []
        for attr in entries:
            mode = attr.st_mode or 0
            rows.append({
                'name': attr.filename,
                'isDir': stat_module.S_ISDIR(mode),
                'isLink': stat_module.S_ISLNK(mode),
                'size': attr.st_size or 0,
                'mtime': int((attr.st_mtime or 0) * 1000),
            })
        rows.sort(key=lambda row: (not row['isDir'], row['name'].lower()))
        return {'path': path, 'entries': rows}

    def read(self, path, max_bytes, encoding, truncate=False):
        attr = self.sftp.stat(path)
        if stat_module.S_ISDIR(attr.st_mode or 0):
            raise BridgeError('这是一个文件夹。', 'EISDIR')
        limit = min(int(max_bytes or MAX_READ), MAX_READ)
        if (attr.st_size or 0) > limit and not truncate:
            raise BridgeError(
                '文件太大（%d 字节），远程读取上限 %d 字节。' % (attr.st_size, limit),
                'too_large',
            )
        with self.sftp.open(path, 'rb') as handle:
            data = handle.read(limit)
        if encoding == 'base64':
            return {
                'content': base64.b64encode(data).decode('ascii'),
                'size': len(data),
                'encoding': 'base64',
            }
        return {
            'content': data.decode('utf-8', 'replace'),
            'size': len(data),
            'encoding': 'utf8',
        }

    def mkdir(self, path, recursive):
        if not recursive:
            self.sftp.mkdir(path)
            return
        if path in ('/', ''):
            return
        current = '/'
        for part in [item for item in path.split('/') if item]:
            current = posixpath.join(current, part)
            try:
                attr = self.sftp.stat(current)
                if not stat_module.S_ISDIR(attr.st_mode or 0):
                    raise BridgeError('%s 已经存在且不是文件夹。' % current, 'EEXIST')
            except IOError:
                self.sftp.mkdir(current)

    def write(self, path, content, encoding):
        data = (
            base64.b64decode(content)
            if encoding == 'base64'
            else str(content).encode('utf-8')
        )
        parent = posixpath.dirname(path)
        if parent:
            self.mkdir(parent, True)
        # Overwriting must not turn an executable script into 0644.
        try:
            existing_mode = stat_module.S_IMODE(self.sftp.stat(path).st_mode or 0)
        except IOError:
            existing_mode = None
        temp = '%s.ezness-%d.tmp' % (path, int(time.time() * 1000))
        with self.sftp.open(temp, 'wb') as handle:
            handle.write(data)
        try:
            try:
                self.sftp.posix_rename(temp, path)
            except IOError:
                try:
                    self.sftp.remove(path)
                except IOError:
                    pass
                self.sftp.rename(temp, path)
        except IOError:
            try:
                self.sftp.remove(temp)
            except IOError:
                pass
            raise
        if existing_mode is not None:
            try:
                self.sftp.chmod(path, existing_mode)
            except IOError:
                pass
        return {'size': len(data)}

    def rename(self, source, target):
        self.sftp.rename(source, target)

    def remove(self, path, recursive):
        attr = self.sftp.stat(path)
        if stat_module.S_ISDIR(attr.st_mode or 0):
            if not recursive:
                self.sftp.rmdir(path)
                return
            for entry in self.sftp.listdir_attr(path):
                self.remove(posixpath.join(path, entry.filename), True)
            self.sftp.rmdir(path)
            return
        self.sftp.remove(path)

    def start_exec(self, command, cwd, timeout_ms):
        """Start a command on its own channel and return immediately."""
        timeout = max(1, min(int(timeout_ms or 120000), 300000)) / 1000.0
        wrapped = command
        if cwd:
            wrapped = 'cd %s && %s' % (shlex.quote(cwd), command)
        channel = self.client.get_transport().open_session()
        channel.settimeout(1.0)
        channel.exec_command(wrapped)
        job = ExecJob(channel, timeout)
        with self.jobs_lock:
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = job
        job.start()
        return job_id

    def take_job(self, job_id):
        with self.jobs_lock:
            return self.jobs.get(job_id)

    def close(self):
        with self.jobs_lock:
            jobs = list(self.jobs.values())
            self.jobs.clear()
        for job in jobs:
            job.cancel()
        for handle in (self.sftp, self.client):
            try:
                handle.close()
            except Exception:
                pass


def attr_payload(attr):
    mode = attr.st_mode or 0
    mtime = attr.st_mtime or 0
    # SFTP attributes carry only atime/mtime; there is no creation time.
    ctime = getattr(attr, 'st_atime', None) or mtime
    return {
        'isDir': stat_module.S_ISDIR(mode),
        'isLink': stat_module.S_ISLNK(mode),
        'size': attr.st_size or 0,
        'mtime': int(mtime * 1000),
        'ctime': int(ctime * 1000),
        'mode': stat_module.S_IMODE(mode),
    }


def fs_error(exc, path):
    text = str(exc)
    if 'No such file' in text:
        return '路径不存在：%s' % path
    if 'Permission denied' in text:
        return '没有权限访问：%s' % path
    if 'Not a directory' in text:
        return '这不是文件夹：%s' % path
    return '%s（%s）' % (text, path)


def main():
    session = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            emit({'id': None, 'ok': False, 'error': '请求不是合法 JSON。', 'code': 'bad_request'})
            continue
        request_id = request.get('id')
        op = request.get('op')
        try:
            if op == 'connect':
                if session is not None:
                    session.close()
                client = make_client(request.get('config') or {})
                transport = client.get_transport()
                key = transport.get_remote_server_key()
                fingerprint = fingerprint_of(key)
                expected = str((request.get('config') or {}).get('fingerprint') or '').strip()
                if expected and expected != fingerprint:
                    client.close()
                    raise BridgeError(
                        '主机指纹与保存的不一致：期望 %s，实际 %s。' % (expected, fingerprint),
                        'fingerprint_mismatch',
                    )
                sftp = client.open_sftp()
                home = sftp.normalize('.')
                sftp.close()
                try:
                    platform = transport.remote_version or ''
                except Exception:
                    platform = ''
                # The agent writes shell commands for this OS, so ask instead of
                # assuming the client's platform. Some restricted servers refuse
                # exec; that only costs the POSIX hint, never the connection.
                os_name = ''
                for _attempt in range(2):
                    try:
                        _stdin, stdout, _stderr = client.exec_command('uname -s', timeout=6)
                        os_name = stdout.read(64).decode('utf-8', 'replace').strip()
                    except Exception:
                        os_name = ''
                    if os_name:
                        break
                    time.sleep(0.1)
                session = Session(client, home, fingerprint, platform)
                session.os_name = os_name
                emit({'id': request_id, 'ok': True, 'result': {
                    'home': home,
                    'fingerprint': fingerprint,
                    'platform': platform,
                    'os': os_name,
                }})
            elif op == 'close':
                if session is not None:
                    session.close()
                    session = None
                emit({'id': request_id, 'ok': True, 'result': {'closed': True}})
            else:
                if session is None:
                    raise BridgeError('还没有连接。', 'not_connected')
                result = dispatch(session, op, request)
                emit({'id': request_id, 'ok': True, 'result': result})
        except BridgeError as exc:
            emit({'id': request_id, 'ok': False, 'error': str(exc), 'code': exc.code})
        except Exception as exc:  # noqa: BLE001 - the UI needs a readable reason
            emit({'id': request_id, 'ok': False, 'error': str(exc), 'code': ''})


def dispatch(session, op, request):
    if op == 'list':
        return session.list(session.resolve(request.get('path')))
    if op == 'stat':
        return session.stat(session.resolve(request.get('path')))
    if op == 'resolve':
        return {'path': session.resolve(request.get('path'))}
    if op == 'read':
        return session.read(
            session.resolve(request.get('path')),
            request.get('maxBytes'),
            request.get('encoding') or 'utf8',
            bool(request.get('truncate')),
        )
    if op == 'write':
        return session.write(
            session.resolve(request.get('path')),
            request.get('content', ''),
            request.get('encoding') or 'utf8',
        )
    if op == 'mkdir':
        path = session.resolve(request.get('path'))
        session.mkdir(path, bool(request.get('recursive')))
        return {'path': path}
    if op == 'rename':
        session.rename(
            session.resolve(request.get('from')),
            session.resolve(request.get('to')),
        )
        return {'ok': True}
    if op == 'remove':
        session.remove(session.resolve(request.get('path')), bool(request.get('recursive')))
        return {'ok': True}
    if op == 'exec':
        job_id = session.start_exec(
            str(request.get('command') or ''),
            session.resolve(request.get('cwd')) if request.get('cwd') else session.home,
            request.get('timeoutMs'),
        )
        return {'jobId': job_id}
    if op == 'poll':
        job = session.take_job(str(request.get('jobId') or ''))
        if job is None:
            raise BridgeError('这条命令已经结束或不存在。', 'no_such_job')
        deadline = time.time() + max(0, int(request.get('waitMs') or 0)) / 1000.0
        with job.condition:
            while not job.done and time.time() < deadline:
                job.condition.wait(max(0.02, deadline - time.time()))
        return job.snapshot()
    if op == 'cancel':
        job = session.take_job(str(request.get('jobId') or ''))
        if job is not None:
            job.cancel()
        return {'cancelled': job is not None}
    if op == 'forget-job':
        job_id = str(request.get('jobId') or '')
        with session.jobs_lock:
            session.jobs.pop(job_id, None)
        return {'ok': True}
    raise BridgeError('未知操作：%s' % op, 'unknown_op')


if __name__ == '__main__':
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
