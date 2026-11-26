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
const uiText = require('../ui-text');

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
      throw new Error(uiText.t('main.remote.error.noSafeStorage'));
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
    if (!config.host) throw new Error(uiText.t('main.remote.error.hostRequired'));
    if (!config.username) throw new Error(uiText.t('main.remote.error.userRequired'));
    if (!config.password && !config.privateKeyPath) {
      throw new Error(uiText.t('main.remote.error.passwordOrKey'));
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
    if (!session) throw new Error(uiText.t('main.remote.error.sessionExpired'));
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
    if (!info?.isDir) throw new Error(uiText.t('main.remote.error.notFolder'));

    const id = String(workspaceId ?? '').trim();
    if (!id) throw new Error(uiText.t('main.remote.error.missingWorkspaceId'));

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
  async fsFor(workspaceId, remote = {}, options = {}) {
    const id = String(workspaceId ?? '');
    const config = cleanConfig(remote);
    const root = String(remote.root ?? '');
    if (!root) throw new Error(uiText.t('main.remote.error.noRoot'));

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
      throw new Error(uiText.t('main.remote.error.noCredentials'));
    }

    const bridge = new SshBridge();
    try {
      await bridge.connect(merged, options.connectTimeoutMs);
    } catch (error) {
      await bridge.close().catch(() => undefined);
      throw error;
    }
    this.workspaces.set(id, { bridge, config: merged, root });
    return new RemoteWorkspaceFs({ bridge, root, config: merged });
  }

  /**
   * Lightweight reachability check used by the workspace list. Reuses a live
   * connection when there is one; otherwise connects with a shorter timeout so
   * a dead host is marked quickly instead of tying up a full 60-second connect.
   * A failed check drops the cached connection so the next attempt reconnects
   * from scratch.
   */
  async probe(workspaceId, remote = {}) {
    const id = String(workspaceId ?? '');
    let fs;
    try {
      fs = await this.fsFor(id, remote, { connectTimeoutMs: 15000 });
    } catch (error) {
      this.closeWorkspace(id);
      return { ok: false, phase: 'connect', error: error?.message || String(error) };
    }
    try {
      const info = await fs.stat(fs.root);
      return info.isDirectory
        ? { ok: true }
        : { ok: false, phase: 'stat', error: uiText.t('main.remote.error.rootNotFolder') };
    } catch (error) {
      // Drop the connection as well: a stat can fail because the bridge died
      // quietly, and the next check should start from a fresh one.
      this.closeWorkspace(id);
      return { ok: false, phase: 'stat', error: error?.message || String(error) };
    }
  }
}

module.exports = { RemoteManager, cleanConfig };
