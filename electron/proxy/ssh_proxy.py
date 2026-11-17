#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ezness SSH 代理隧道。

第一行 stdin 读入连接配置（凭据不进入命令行），用 ssh_bridge 里同一套
paramiko 认证连上服务器，然后在 127.0.0.1 的随机端口开一个 SOCKS5 服务，
每个 CONNECT 请求转成 SSH 的 direct-tcpip 通道。

成功时 stdout 第一行输出 {"ok": true, "port": N}；失败时输出
{"ok": false, "error": "..."}。stdin 关闭或收到 close 时退出。
"""

import json
import os
import socket
import struct
import sys
import threading

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'remote')
)
from ssh_bridge import make_client, BridgeError  # noqa: E402


def read_exact(sock, count):
    data = b''
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def send_reply(sock, code):
    # VER REP RSV ATYP BND.ADDR BND.PORT — the bound address is never used by
    # the client, so a zero address is enough.
    try:
        sock.sendall(bytes([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
    except OSError:
        pass


def pump_socket_to_channel(sock, channel):
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            channel.sendall(data)
    except Exception:
        pass
    finally:
        try:
            channel.shutdown_write()
        except Exception:
            pass


def pump_channel_to_socket(channel, sock):
    try:
        while True:
            data = channel.recv(65536)
            if not data:
                break
            sock.sendall(data)
    except Exception:
        pass
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client, transport):
    channel = None
    try:
        client.settimeout(20)
        greeting = read_exact(client, 2)
        if not greeting or greeting[0] != 5:
            return
        methods = read_exact(client, greeting[1])
        if methods is None:
            return
        # No authentication: the tunnel is bound to loopback for this process.
        client.sendall(b'\x05\x00')

        head = read_exact(client, 4)
        if not head or head[0] != 5:
            return
        command, atyp = head[1], head[3]
        if command != 1:  # CONNECT only
            send_reply(client, 7)
            return

        if atyp == 1:
            raw = read_exact(client, 4)
            if raw is None:
                return
            host = socket.inet_ntoa(raw)
        elif atyp == 3:
            size = read_exact(client, 1)
            if not size:
                return
            raw = read_exact(client, size[0])
            if raw is None:
                return
            host = raw.decode('ascii', 'replace')
        elif atyp == 4:
            raw = read_exact(client, 16)
            if raw is None:
                return
            host = socket.inet_ntop(socket.AF_INET6, raw)
        else:
            send_reply(client, 8)
            return

        raw_port = read_exact(client, 2)
        if raw_port is None:
            return
        port = struct.unpack('!H', raw_port)[0]

        client.settimeout(None)
        try:
            channel = transport.open_channel(
                'direct-tcpip', (host, port), ('127.0.0.1', 0), timeout=20
            )
        except Exception:
            channel = None
        if channel is None:
            send_reply(client, 5)
            return

        send_reply(client, 0)
        up = threading.Thread(target=pump_socket_to_channel, args=(client, channel), daemon=True)
        down = threading.Thread(target=pump_channel_to_socket, args=(channel, client), daemon=True)
        up.start()
        down.start()
        up.join()
        down.join()
    except Exception:
        pass
    finally:
        if channel is not None:
            try:
                channel.close()
            except Exception:
                pass
        try:
            client.close()
        except OSError:
            pass


def serve(transport):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', 0))
    server.listen(128)
    port = server.getsockname()[1]

    def watch_stdin():
        try:
            for line in sys.stdin:
                if line.strip().lower() == 'close':
                    break
        except Exception:
            pass
        try:
            server.close()
        except OSError:
            pass
        os._exit(0)

    threading.Thread(target=watch_stdin, daemon=True).start()
    print(json.dumps({'ok': True, 'port': port}), flush=True)

    while True:
        try:
            client, _addr = server.accept()
        except OSError:
            return
        threading.Thread(target=handle, args=(client, transport), daemon=True).start()


def main():
    line = sys.stdin.readline()
    if not line.strip():
        print(json.dumps({'ok': False, 'error': '没有收到 SSH 连接配置。'}), flush=True)
        return 1
    try:
        config = json.loads(line)
    except ValueError:
        print(json.dumps({'ok': False, 'error': 'SSH 连接配置不是合法 JSON。'}), flush=True)
        return 1

    try:
        client = make_client(config)
    except BridgeError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False), flush=True)
        return 1
    except Exception as exc:  # noqa: BLE001 - the UI needs a readable reason
        print(json.dumps({'ok': False, 'error': 'SSH 连接失败：%s' % exc}, ensure_ascii=False), flush=True)
        return 1

    transport = client.get_transport()
    if transport is None or not transport.is_active():
        print(json.dumps({'ok': False, 'error': 'SSH 连接没有建立起来。'}, ensure_ascii=False), flush=True)
        return 1
    try:
        transport.set_keepalive(30)
    except Exception:
        pass

    try:
        serve(transport)
    finally:
        try:
            client.close()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
