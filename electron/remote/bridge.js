'use strict';

/**
 * Node side of the SSH bridge.
 *
 * A long-lived Python process (ssh_bridge.py, paramiko) holds one SSH/SFTP
 * connection. Requests and responses are newline-delimited JSON over its
 * stdin/stdout. Credentials go in the first request, never in argv.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const customTools = require('../agent/custom-tools');

const SCRIPT = path.join(__dirname, 'ssh_bridge.py');

class BridgeError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

class SshBridge {
  constructor(options = {}) {
    this.python = options.python ?? null;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.fingerprint = '';
    this.home = '';
    this.platform = '';
    this.launching = null;
  }

  /** Start the process (once) and open the SSH connection. */
  async connect(config) {
    if (this.child) throw new BridgeError('这条连接已经建立。', 'already_connected');
    this.launching = this.#spawn();
    await this.launching;
    const info = await this.request('connect', { config }, 60000);
    this.home = info?.home ?? '/';
    this.fingerprint = info?.fingerprint ?? '';
    this.platform = info?.platform ?? '';
    this.os = info?.os ?? '';
    return {
      home: this.home,
      fingerprint: this.fingerprint,
      platform: this.platform,
      os: this.os,
    };
  }

  async #spawn() {
    const python = this.python ?? (await customTools.resolveRuntime('python'));
    const args = [...(python.prefix ?? []), '-u', '-I', SCRIPT];
    const child = spawn(python.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => this.#failAll(error));
    child.on('exit', (code) => {
      this.closed = true;
      this.#failAll(
        new BridgeError(
          `SSH 桥接进程已退出（代码 ${code}）。${this.stderr ? `\n${this.stderr.trim().slice(-600)}` : ''}`,
          'bridge_exit',
        ),
      );
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new BridgeError(message.error || '远程操作失败。', message.code || ''));
    }
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error instanceof BridgeError ? error : new BridgeError(String(error), 'bridge_error'));
    }
    this.pending.clear();
  }

  request(op, params = {}, timeoutMs = 30000) {
    if (!this.child || this.closed) {
      return Promise.reject(new BridgeError('SSH 连接已经断开。', 'not_connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`远程操作超时：${op}`, 'timeout'));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(`无法把请求发给 SSH 桥：${error?.message || String(error)}`, 'write_failed'));
      }
    });
  }

  /**
   * Run a command on the remote host. The bridge starts it on its own channel
   * and answers poll requests, so an abort can cancel it instead of waiting
   * out the timeout.
   */
  async exec({ command, cwd, timeoutMs = 120000, signal, onSnapshot } = {}) {
    const { jobId } = await this.request('exec', { command, cwd, timeoutMs }, 20000);
    try {
      for (;;) {
        if (signal?.aborted) {
          await this.request('cancel', { jobId }, 5000).catch(() => undefined);
          const aborted = new Error('命令被用户中断。');
          aborted.aborted = true;
          throw aborted;
        }
        const snapshot = await this.request(
          'poll',
          { jobId, waitMs: 250 },
          Math.max(timeoutMs, 10000),
        );
        onSnapshot?.(snapshot);
        if (!snapshot.running) {
          return {
            stdout: snapshot.stdout ?? '',
            stderr: snapshot.stderr ?? '',
            exit: snapshot.exit ?? -1,
            timedOut: Boolean(snapshot.timedOut),
            cancelled: Boolean(snapshot.cancelled),
          };
        }
      }
    } finally {
      await this.request('forget-job', { jobId }, 5000).catch(() => undefined);
    }
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    try {
      if (!this.closed) await this.request('close', {}, 3000);
    } catch {
      /* the connection is going away anyway */
    }
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* exited */
      }
    }, 800).unref?.();
    this.closed = true;
    this.child = null;
  }
}

module.exports = { SshBridge, BridgeError, SCRIPT };
