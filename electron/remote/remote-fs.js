'use strict';

/**
 * RemoteWorkspaceFs: the same interface tools use for a local folder, backed
 * by one SSH/SFTP connection. Paths are absolute POSIX paths on the server and
 * every one is resolved and checked against the workspace root, so a symlink
 * planted inside the workspace cannot hand the agent the rest of the host.
 */

const posix = require('node:path').posix;
const { clip } = require('../agent/workspace-fs');
const uiText = require('../ui-text');

class RemotePathEscapeError extends Error {
  constructor(requested) {
    super(uiText.t('main.remote.pathEscape', { path: requested }));
    this.code = 'path_escape';
  }
}

function osLabel(name) {
  const value = String(name ?? '').trim();
  if (/^linux/i.test(value)) return 'Linux（shell 命令按 POSIX 语法书写）';
  if (/^darwin/i.test(value)) return 'macOS（shell 命令按 POSIX 语法书写）';
  if (/bsd/i.test(value)) return `${value}（shell 命令按 POSIX 语法书写）`;
  return value ? `${value}（远程主机）` : '远程主机（shell 命令按 POSIX 语法书写）';
}

function insideRemote(target, root) {
  if (root === '/') return target.startsWith('/');
  return target === root || target.startsWith(`${root}/`);
}

class RemoteWorkspaceFs {
  /**
   * @param {object} options
   * @param {import('./bridge').SshBridge} options.bridge  connected bridge
   * @param {string} options.root  absolute POSIX path on the server
   * @param {object} [options.config] host/port/username, for display only
   */
  constructor({ bridge, root, config = {} }) {
    this.bridge = bridge;
    this.root = String(root ?? '');
    this.config = config;
    this.remote = true;
    this.sep = '/';
    /** Remote OS from `uname -s`; empty when the host would not say. */
    this.os = bridge?.os ?? '';
    this.platformLabel = osLabel(this.os);
  }

  async ready() {
    return this.root;
  }

  label() {
    const user = this.config.username ? `${this.config.username}@` : '';
    const host = this.config.host ?? '';
    const port = this.config.port && Number(this.config.port) !== 22 ? `:${this.config.port}` : '';
    return `${user}${host}${port}:${this.root}`;
  }

  async resolve(relative) {
    const raw = String(relative ?? '.').trim() || '.';
    if (raw.includes('\0')) throw new RemotePathEscapeError(raw);
    const normalized = raw.startsWith('/') ? posix.normalize(raw) : posix.resolve(this.root, raw);
    if (!insideRemote(normalized, this.root)) throw new RemotePathEscapeError(raw);
    // Server-side canonical path: resolves symlinks and catches a link that
    // points outside the workspace.
    const result = await this.bridge.request('resolve', { path: normalized });
    const real = String(result?.path ?? normalized);
    if (!insideRemote(real, this.root)) throw new RemotePathEscapeError(raw);
    return real;
  }

  join(base, name) {
    return posix.join(base, name);
  }

  dirname(target) {
    return posix.dirname(target);
  }

  display(target) {
    return posix.relative(this.root, target) || '.';
  }

  async stat(target) {
    const info = await this.bridge.request('stat', { path: target });
    return {
      isDirectory: Boolean(info?.isDir),
      isFile: !info?.isDir,
      size: Number(info?.size ?? 0),
      mtimeMs: Number(info?.mtime ?? 0),
      birthtimeMs: Number(info?.ctime ?? info?.mtime ?? 0),
      ctimeMs: Number(info?.ctime ?? info?.mtime ?? 0),
    };
  }

  async readdir(target) {
    const result = await this.bridge.request('list', { path: target });
    return (result?.entries ?? []).map((entry) => ({
      name: entry.name,
      isDir: Boolean(entry.isDir),
      isFile: !entry.isDir && !entry.isLink,
    }));
  }

  async readText(target) {
    const result = await this.bridge.request(
      'read',
      { path: target, maxBytes: 128 * 1024 * 1024, encoding: 'utf8' },
      120000,
    );
    return String(result?.content ?? '');
  }

  async readBuffer(target, options = {}) {
    const maxBytes = Number(options.maxBytes) || 128 * 1024 * 1024;
    const result = await this.bridge.request(
      'read',
      { path: target, maxBytes, encoding: 'base64', truncate: Boolean(options.maxBytes) },
      120000,
    );
    return Buffer.from(String(result?.content ?? ''), 'base64');
  }

  async writeText(target, text) {
    await this.bridge.request(
      'write',
      { path: target, content: String(text ?? ''), encoding: 'utf8' },
      120000,
    );
  }

  async mkdir(target, options = {}) {
    await this.bridge.request('mkdir', {
      path: target,
      recursive: options.recursive !== false,
    });
  }

  async rename(from, to) {
    await this.bridge.request('rename', { from, to }, 60000);
  }

  async remove(target, options = {}) {
    await this.bridge.request(
      'remove',
      { path: target, recursive: options.recursive !== false },
      120000,
    );
  }

  async exists(target) {
    try {
      await this.bridge.request('stat', { path: target });
      return true;
    } catch {
      return false;
    }
  }

  async exec(command, { cwd, timeoutMs = 120000, signal } = {}) {
    const result = await this.bridge.exec({
      command,
      cwd: cwd || this.root,
      timeoutMs,
      signal,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || '（没有输出）';
    if (result.cancelled) return `命令被用户中断。\n${clip(output)}`;
    if (result.timedOut) {
      return `命令超时（${Math.round(timeoutMs / 1000)} 秒）被终止。\n${clip(output)}`;
    }
    return `退出码 ${result.exit}\n${clip(output)}`;
  }
}

module.exports = { RemoteWorkspaceFs, RemotePathEscapeError, insideRemote, osLabel };
