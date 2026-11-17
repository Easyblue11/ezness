'use strict';

/**
 * Owns the SSH connections that back remote workspaces.
 *
 *   - one pending "session" while the user browses a host and picks a folder
 *   - one live connection per open remote workspace
 *   - credentials encrypted with Electron safeStorage (DPAPI on Windows) in
 *     <data root>/remote-secrets.json; they never enter workspaces.json, the
 *     renderer's saved state, or the model's context
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');
const { SshBridge } = require('./bridge');
const { RemoteWorkspaceFs } = require('./remote-fs');

const SECRETS_FILE = 'remote-secrets.json';

function cleanConfig(config = {}) {
  return {
    host: String(config.host ?? '').trim(),
    port: Math.min(Math.max(Number(config.port) || 22, 1), 65535),
    username: String(config.username ?? '').trim(),
    password: config.password ? String(config.password) : '',
    privateKeyPath: String(config.privateKeyPath ?? '').trim(),
    privateKeyPassphrase: config.privateKeyPassphrase
      ? String(config.privateKeyPassphrase)
      : '',
    fingerprint: String(config.fingerprint ?? '').trim(),
  };
}

class RemoteManager {
  constructor(storageRoot) {
    this.storageRoot = String(storageRoot ?? '');
    this.pending = new Map();
    this.workspaces = new Map();
  }

  secretsFile() {
    return path.join(this.storageRoot, SECRETS_FILE);
  }

  async #readSecrets() {
    try {
      return JSON.parse(await fs.readFile(this.secretsFile(), 'utf8'));
    } catch {
      return {};
    }
  }

  async #writeSecrets(data) {
    const file = this.secretsFile();
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data), 'utf8');
    await fs.rename(temp, file);
  }

  #encrypt(values) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密不可用，无法安全保存远程登录凭据。');
    }
    return safeStorage
      .encryptString(JSON.stringify(values))
      .toString('base64');
  }

  #decrypt(encoded) {
    if (!encoded || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const text = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async saveSecret(workspaceId, values) {
    const id = String(workspaceId ?? '');
    if (!id) return;
    const secrets = await this.#readSecrets();
    secrets[id] = this.#encrypt({
      password: values.password ?? '',
      privateKeyPath: values.privateKeyPath ?? '',
      privateKeyPassphrase: values.privateKeyPassphrase ?? '',
    });
    await this.#writeSecrets(secrets);
  }

  async secretFor(workspaceId) {
    const secrets = await this.#readSecrets();
    return this.#decrypt(secrets[String(workspaceId ?? '')]);
  }

  /** Drop credentials for workspaces that no longer exist. */
  async pruneSecrets(knownIds) {
    const keep = new Set((knownIds ?? []).map(String));
    const secrets = await this.#readSecrets();
    let changed = false;
    for (const id of Object.keys(secrets)) {
      if (!keep.has(id)) {
        delete secrets[id];
        changed = true;
      }
    }
    if (changed) await this.#writeSecrets(secrets);
  }

  /** Start a connection that only exists while the user picks a folder. */
  async connect(input) {
    const config = cleanConfig(input);
    if (!config.host) throw new Error('请填写主机地址。');
    if (!config.username) throw new Error('请填写用户名。');
    if (!config.password && !config.privateKeyPath) {
      throw new Error('请填写密码，或选择私钥文件。');
    }

    const bridge = new SshBridge();
    let info;
    try {
      info = await bridge.connect(config);
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }

    const sessionId = crypto.randomUUID();
    this.pending.set(sessionId, {
      bridge,
      config,
      home: info.home,
      fingerprint: info.fingerprint,
      createdAt: Date.now(),
    });
    return {
      sessionId,
      home: info.home,
      fingerprint: info.fingerprint,
      host: config.host,
      port: config.port,
      username: config.username,
    };
  }

  #pendingSession(sessionId) {
    const session = this.pending.get(String(sessionId ?? ''));
    if (!session) throw new Error('这次连接已经过期，请重新输入地址和凭据。');
    return session;
  }

  async list(sessionId, dir) {
    const session = this.#pendingSession(sessionId);
    const target = String(dir ?? '').trim() || session.home;
    const resolved = await session.bridge.request('resolve', { path: target });
    const targetPath = String(resolved?.path ?? target);
    const result = await session.bridge.request('list', { path: targetPath });
    const user = session.config.username;
    return {
      path: targetPath,
      home: session.home,
      parent: targetPath === '/' ? '' : path.posix.dirname(targetPath),
      entries: (result?.entries ?? [])
        .filter((entry) => entry.isDir)
        .map((entry) => ({
          name: entry.name,
          path: path.posix.join(targetPath, entry.name),
          hidden: entry.name.startsWith('.'),
        })),
      label: `${user}@${session.config.host}:${targetPath}`,
    };
  }

  /**
   * Turn a pending session into a workspace root. Returns the canonical path
   * and the connection now belongs to the workspace.
   */
  async open({ sessionId, dir, workspaceId }) {
    const session = this.#pendingSession(sessionId);
    const target = String(dir ?? '').trim() || session.home;
    const resolved = await session.bridge.request('resolve', { path: target });
    const root = String(resolved?.path ?? target);
    const info = await session.bridge.request('stat', { path: root });
    if (!info?.isDir) throw new Error('这个位置不是文件夹，不能作为工作空间。');

    const id = String(workspaceId ?? '').trim();
    if (!id) throw new Error('缺少工作空间 ID。');

    // Remember the credentials first: a failed save must not leave an
    // unreachable workspace behind.
    await this.saveSecret(id, session.config);
    this.pending.delete(String(sessionId));

    this.workspaces.get(id)?.bridge?.close().catch(() => undefined);
    this.workspaces.set(id, { bridge: session.bridge, config: session.config, root });

    return {
      root,
      name: path.posix.basename(root) || root,
      fingerprint: session.fingerprint ?? '',
    };
  }

  async close(sessionId) {
    const session = this.pending.get(String(sessionId ?? ''));
    if (!session) return false;
    this.pending.delete(String(sessionId));
    await session.bridge.close().catch(() => undefined);
    return true;
  }

  closeWorkspace(workspaceId) {
    const entry = this.workspaces.get(String(workspaceId ?? ''));
    if (!entry) return;
    this.workspaces.delete(String(workspaceId));
    entry.bridge.close().catch(() => undefined);
  }

  /** Drop live connections whose workspace the renderer no longer has. */
  closeMissing(knownIds) {
    const keep = new Set((knownIds ?? []).map(String));
    for (const id of [...this.workspaces.keys()]) {
      if (!keep.has(id)) this.closeWorkspace(id);
    }
  }

  closeAll() {
    for (const [, entry] of this.workspaces) entry.bridge.close().catch(() => undefined);
    for (const [, session] of this.pending) session.bridge.close().catch(() => undefined);
    this.workspaces.clear();
    this.pending.clear();
  }

  /**
   * The adapter for one saved remote workspace. Reconnects transparently if
   * the host dropped the connection.
   */
  async fsFor(workspaceId, remote = {}) {
    const id = String(workspaceId ?? '');
    const config = cleanConfig(remote);
    const root = String(remote.root ?? '');
    if (!root) throw new Error('远程工作空间缺少根目录。');

    let entry = this.workspaces.get(id);
    if (entry && !entry.bridge.closed && entry.root === root) {
      return new RemoteWorkspaceFs({ bridge: entry.bridge, root, config });
    }
    if (entry) {
      entry.bridge.close().catch(() => undefined);
      this.workspaces.delete(id);
    }

    const stored = (await this.secretFor(id)) ?? {};
    const merged = {
      ...config,
      password: config.password || stored.password || '',
      privateKeyPath: config.privateKeyPath || stored.privateKeyPath || '',
      privateKeyPassphrase: config.privateKeyPassphrase || stored.privateKeyPassphrase || '',
    };
    if (!merged.password && !merged.privateKeyPath) {
      throw new Error(
        '远程工作空间没有可用的登录凭据（可能是在另一台机器或另一个系统账户下保存的），请重新添加这个远程地址。',
      );
    }

    const bridge = new SshBridge();
    try {
      await bridge.connect(merged);
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }
    this.workspaces.set(id, { bridge, config: merged, root });
    return new RemoteWorkspaceFs({ bridge, root, config: merged });
  }
}

module.exports = { RemoteManager, cleanConfig };
