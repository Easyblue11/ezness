'use strict';

/**
 * App-wide outbound proxy.
 *
 * Chromium owns the network stack, so one `session.setProxy` call covers the
 * renderer and every main-process request made through `app-net.js`. HTTP,
 * HTTPS and SOCKS5 proxies are native there; SSH is turned into a local SOCKS5
 * tunnel by ssh_proxy.py (paramiko, the same SSH stack remote workspaces use).
 *
 * The manager is deliberately boring about failure: an invalid or unreachable
 * configuration leaves the previous one in place, and a failed SSH tunnel falls
 * back to a direct connection so a typo cannot take the whole app offline.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const customTools = require('../agent/custom-tools');
const { AuthRelay } = require('./auth-relay');

const SCRIPT = path.join(__dirname, 'ssh_proxy.py');
const MODES = ['direct', 'system', 'fixed', 'auto'];
const SCHEMES = ['http', 'https', 'socks5', 'ssh'];
const TUNNEL_TIMEOUT = 45000;
// Neutral endpoints used by the 测试 button. Any HTTP response counts as
// connected, so a captive portal or a 403 still proves the route works.
const TEST_TARGETS = [
  'https://www.gstatic.com/generate_204',
  'https://www.cloudflare.com/cdn-cgi/trace',
];

const HOST_PATTERN = /^[A-Za-z0-9._\-:[\]]+$/;
const RULE_PATTERN = /^[A-Za-z0-9.*_\-[\]]+$/;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeServer(saved) {
  const rawPort = Math.trunc(Number(saved?.port));
  return {
    scheme: SCHEMES.includes(saved?.scheme) ? saved.scheme : 'http',
    host: text(saved?.host, 260),
    port: Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 7890,
    username: text(saved?.username, 200),
    password: String(saved?.password ?? '').slice(0, 400),
    sshAuth: saved?.sshAuth === 'key' ? 'key' : 'password',
    privateKeyPath: text(saved?.privateKeyPath, 1000),
    privateKeyPassphrase: String(saved?.privateKeyPassphrase ?? '').slice(0, 400),
    fingerprint: text(saved?.fingerprint, 200),
  };
}

function normalize(raw) {
  const rules = Array.isArray(raw?.rules)
    ? raw.rules
        .filter((rule) => rule && typeof rule === 'object')
        .slice(0, 200)
        .map((rule, index) => ({
          id: text(rule.id, 80) || `rule-${index}`,
          pattern: text(rule.pattern, 200),
          action: rule.action === 'direct' ? 'direct' : 'proxy',
        }))
    : [];
  return {
    // 与渲染进程一致：没存过「开」就是关，默认直连。
    enabled: raw?.enabled === true,
    mode: MODES.includes(raw?.mode) ? raw.mode : 'direct',
    server: normalizeServer(raw?.server),
    bypass: String(raw?.bypass ?? '').slice(0, 4000),
    rules,
    autoDefault: raw?.autoDefault === 'direct' ? 'direct' : 'proxy',
  };
}

/** Same checks as src/data/proxy.ts; the main process must not trust the renderer. */
function problemOf(settings) {
  const { mode, server } = settings;
  if (!settings.enabled || mode === 'direct' || mode === 'system') return null;
  if (!server.host) return '请填写代理服务器地址。';
  if (!HOST_PATTERN.test(server.host)) return '代理服务器地址不合法。';
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    return '端口需要在 1–65535 之间。';
  }
  if (server.scheme === 'ssh') {
    if (!server.username) return '请填写 SSH 登录用户名。';
    if (server.sshAuth === 'password' && !server.password) return '请填写 SSH 密码。';
    if (server.sshAuth === 'key' && !server.privateKeyPath) return '请选择私钥文件。';
  }
  if (mode === 'auto') {
    const broken = settings.rules.find((rule) => rule.pattern && !RULE_PATTERN.test(rule.pattern));
    if (broken) return `规则「${broken.pattern}」不合法。`;
  }
  return null;
}

function bypassRules(raw) {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100)
    .join(',');
}

function schemeName(scheme) {
  if (scheme === 'socks5' || scheme === 'ssh') return 'SOCKS5';
  if (scheme === 'https') return 'HTTPS';
  return 'HTTP';
}

function displayScheme(scheme) {
  if (scheme === 'ssh') return 'SSH';
  return schemeName(scheme);
}

function summary(settings) {
  if (!settings.enabled) return '已关闭';
  if (settings.mode === 'direct') return '直接连接';
  if (settings.mode === 'system') return '系统代理';
  const scheme = displayScheme(settings.server.scheme);
  if (settings.mode === 'auto') return `自动切换 · ${settings.rules.length} 条规则`;
  return `固定代理 · ${scheme} ${settings.server.host}:${settings.server.port}`;
}

/**
 * PAC `FindProxyForURL` return string for the configured server.
 * PAC only knows `PROXY` (plain HTTP), `HTTPS` (TLS to the proxy), `SOCKS5`
 * and `DIRECT`; anything else makes Chromium fall back to a direct connection.
 */
function pacProxy(settings, tunnelPort, relayPort) {
  if (relayPort) return `PROXY 127.0.0.1:${relayPort}`;
  const { scheme, host, port } = settings.server;
  if (scheme === 'ssh') return `SOCKS5 127.0.0.1:${tunnelPort}`;
  if (scheme === 'socks5') return `SOCKS5 ${host}:${port}`;
  if (scheme === 'https') return `HTTPS ${host}:${port}`;
  return `PROXY ${host}:${port}`;
}

function pacRegex(pattern) {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return `new RegExp('^${source}$', 'i')`;
}

/**
 * Auto-switch PAC. Rules are checked in order and only against the host, so a
 * rule cannot accidentally match a URL path or a query string.
 */
function buildPac(settings, tunnelPort, relayPort) {
  const proxy = pacProxy(settings, tunnelPort, relayPort).replace(/'/g, "\\'");
  const fallback = settings.autoDefault === 'direct' ? 'DIRECT' : proxy;
  const lines = [
    'function FindProxyForURL(url, host) {',
    "  host = String(host || '').toLowerCase();",
    "  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.indexOf('.') === -1) return 'DIRECT';",
  ];
  for (const rule of settings.rules) {
    if (!rule.pattern) continue;
    const target = rule.action === 'direct' ? 'DIRECT' : proxy;
    lines.push(`  if (${pacRegex(rule.pattern)}.test(host)) return '${target}';`);
  }
  lines.push(`  return '${fallback}';`, '}', '');
  return lines.join('\n');
}

function tunnelKey(server) {
  return [
    server.host,
    server.port,
    server.username,
    server.sshAuth,
    server.sshAuth === 'password' ? server.password : '',
    server.privateKeyPath,
    server.privateKeyPassphrase,
    server.fingerprint,
  ].join('\u0000');
}

class ProxyManager {
  constructor({ session, root }) {
    this.session = session;
    this.root = typeof root === 'function' ? root : () => '';
    this.settingsFile = '';
    this.settings = normalize(null);
    // 出厂状态跟默认配置一致：代理关着，直连。
    this.state = {
      ok: true,
      applied: false,
      enabled: this.settings.enabled,
      mode: 'direct',
      detail: '直接连接',
    };
    this.appliedKey = '';
    this.tunnel = null;
    this.relay = null;
    this.queue = Promise.resolve();
    this.#listenForAuth();
  }

  init({ settingsFile }) {
    this.settingsFile = settingsFile;
  }

  #listenForAuth() {
    // Chromium asks for proxy credentials here; reply only for the proxy the
    // user configured, never for an unrelated server asking for a login.
    this.session.on('login', (event, _webContents, _details, authInfo, callback) => {
      const server = this.settings.server;
      if (!authInfo?.isProxy || !server.username) return;
      if (server.scheme === 'ssh') return;
      if (String(authInfo.host || '').toLowerCase() !== server.host.toLowerCase()) return;
      if (Number(authInfo.port) !== server.port) return;
      event.preventDefault();
      callback(server.username, server.password || '');
    });
  }

  /** Read `proxy` out of settings.json at startup and apply it. */
  async loadSaved() {
    if (!this.settingsFile) return this.status();
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.settingsFile, 'utf8'));
      return await this.apply(saved?.proxy);
    } catch {
      return this.status();
    }
  }

  status() {
    return { ...this.state };
  }

  /**
   * Connectivity check for the 测试 button. It uses the session as configured,
   * so it measures the real route (and never touches stored credentials).
   */
  async test(rawUrl) {
    const custom = typeof rawUrl === 'string' ? rawUrl.trim().slice(0, 2000) : '';
    if (custom && !/^https?:\/\//i.test(custom)) {
      return { ok: false, latencyMs: 0, detail: '连接失败', error: '测试地址必须是 http(s) 链接。' };
    }
    const targets = custom ? [custom] : TEST_TARGETS;
    let lastError = '';
    for (const target of targets) {
      const started = performance.now();
      try {
        const response = await this.session.fetch(target, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        const latencyMs = Math.max(1, Math.round(performance.now() - started));
        // Drain the body so the connection is released promptly.
        try {
          await response.arrayBuffer();
        } catch {
          /* body errors do not change reachability */
        }
        return { ok: true, latencyMs, detail: `已连接 · ${latencyMs} ms` };
      } catch (error) {
        lastError = error?.cause?.message || error?.message || String(error);
      }
    }
    return { ok: false, latencyMs: 0, detail: '连接失败', error: lastError };
  }

  /** Serialize applications so two quick saves cannot race the tunnel. */
  apply(raw) {
    const settings = normalize(raw);
    const problem = problemOf(settings);
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.#apply(settings, problem));
    return this.queue;
  }

  async #apply(settings, problem) {
    this.settings = settings; // credentials for the login handler, even if applying fails

    if (problem) {
      this.state = {
        ok: false,
        applied: false,
        enabled: settings.enabled,
        mode: settings.mode,
        detail: summary(settings),
        error: problem,
      };
      return this.status();
    }

    const key = JSON.stringify({
      enabled: settings.enabled,
      mode: settings.mode,
      server: settings.server,
      bypass: settings.bypass,
      rules: settings.rules,
      autoDefault: settings.autoDefault,
    });
    const tunnelAlive =
      !settings.enabled ||
      settings.server.scheme !== 'ssh' ||
      (settings.mode !== 'fixed' && settings.mode !== 'auto') ||
      Boolean(this.tunnel?.port);
    const relayAlive = !this.#needsRelay(settings) || Boolean(this.relay?.listeningPort);
    if (key === this.appliedKey && tunnelAlive && relayAlive) return this.status();

    try {
      if (!settings.enabled || settings.mode === 'direct' || settings.mode === 'system') {
        await this.#stopTunnel();
        await this.#stopRelay();
        await this.#setProxy(
          settings.enabled && settings.mode === 'system' ? { mode: 'system' } : { mode: 'direct' },
        );
        this.appliedKey = key;
        this.state = {
          ok: true,
          applied: true,
          enabled: settings.enabled,
          mode: settings.mode,
          detail: summary(settings),
        };
        return this.status();
      }

      let tunnelPort = 0;
      if (settings.server.scheme === 'ssh') {
        try {
          tunnelPort = await this.#ensureTunnel(settings.server);
        } catch (error) {
          // Keep the app usable: no proxy is better than a dead session.
          await this.#stopTunnel();
          await this.#stopRelay();
          await this.#setProxy({ mode: 'direct' });
          this.appliedKey = '';
          this.state = {
            ok: false,
            applied: false,
            enabled: settings.enabled,
            mode: settings.mode,
            detail: summary(settings),
            error: `SSH 隧道启动失败：${error?.message || String(error)}`,
          };
          return this.status();
        }
      } else {
        await this.#stopTunnel();
      }

      // Chromium cannot answer a 407 for `session.fetch`, so authenticated
      // HTTP/HTTPS proxies go through the loopback relay instead.
      let relayPort = 0;
      if (this.#needsRelay(settings)) {
        try {
          relayPort = await this.#ensureRelay(settings.server);
        } catch (error) {
          await this.#stopRelay();
          await this.#setProxy({ mode: 'direct' });
          this.appliedKey = '';
          this.state = {
            ok: false,
            applied: false,
            enabled: settings.enabled,
            mode: settings.mode,
            detail: summary(settings),
            error: `代理认证转发启动失败：${error?.message || String(error)}`,
          };
          return this.status();
        }
      } else {
        await this.#stopRelay();
      }

      const bypass = bypassRules(settings.bypass);
      if (settings.mode === 'auto') {
        // A data: URL is the one PAC form Chromium accepts here without a file
        // or a local HTTP server; file:// PACs never compile.
        const pac = buildPac(settings, tunnelPort, relayPort);
        const pacScript = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
          pac,
          'utf8',
        ).toString('base64')}`;
        await this.#setProxy({
          mode: 'pac_script',
          pacScript,
          proxyBypassRules: bypass,
        });
      } else {
        const { scheme, host, port } = settings.server;
        let proxyRules;
        if (relayPort) proxyRules = `127.0.0.1:${relayPort}`;
        else if (scheme === 'ssh') proxyRules = `socks5://127.0.0.1:${tunnelPort}`;
        else if (scheme === 'socks5') proxyRules = `socks5://${host}:${port}`;
        else if (scheme === 'https') proxyRules = `https://${host}:${port}`;
        else proxyRules = `${host}:${port}`;
        await this.#setProxy({ mode: 'fixed_servers', proxyRules, proxyBypassRules: bypass });
      }

      this.appliedKey = key;
      this.state = {
        ok: true,
        applied: true,
        enabled: settings.enabled,
        mode: settings.mode,
        detail: summary(settings),
        ...(tunnelPort ? { tunnelPort } : {}),
      };
      return this.status();
    } catch (error) {
      this.appliedKey = '';
      this.state = {
        ok: false,
        applied: false,
        enabled: settings.enabled,
        mode: settings.mode,
        detail: summary(settings),
        error: error?.message || String(error),
      };
      return this.status();
    }
  }

  #needsRelay(settings) {
    return (
      settings.enabled &&
      (settings.mode === 'fixed' || settings.mode === 'auto') &&
      (settings.server.scheme === 'http' || settings.server.scheme === 'https') &&
      Boolean(settings.server.username)
    );
  }

  async #ensureRelay(server) {
    const key = [server.scheme, server.host, server.port, server.username, server.password].join(
      '\u0000',
    );
    if (this.relay && this.relay.key === key && this.relay.instance.listeningPort) {
      return this.relay.instance.listeningPort;
    }
    await this.#stopRelay();
    const instance = new AuthRelay(server);
    await instance.start();
    this.relay = { key, instance };
    return instance.listeningPort;
  }

  async #stopRelay() {
    const relay = this.relay;
    this.relay = null;
    if (!relay) return;
    try {
      await relay.instance.stop();
    } catch {
      /* already closed */
    }
  }

  async #setProxy(config) {
    await this.session.setProxy(config);
    // Pooled sockets would otherwise keep using the old route.
    try {
      await this.session.closeAllConnections();
    } catch {
      /* older Electron builds do not expose it */
    }
  }

  async #ensureTunnel(server) {
    const key = tunnelKey(server);
    if (this.tunnel && this.tunnel.key === key && this.tunnel.port) return this.tunnel.port;
    await this.#stopTunnel();

    const python = await customTools.resolveRuntime('python');
    const child = spawn(python.command, [...(python.prefix ?? []), '-u', '-I', SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PYTHONIOENCODING: 'utf-8' },
    });
    const tunnel = { key, child, port: 0, stderr: '' };
    this.tunnel = tunnel;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tunnel.stderr = `${tunnel.stderr}${chunk}`.slice(-4000);
    });
    child.on('exit', () => {
      if (this.tunnel === tunnel) this.tunnel = null;
    });

    // Credentials go over stdin, never argv (argv is visible in the process list).
    child.stdin.write(
      `${JSON.stringify({
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.sshAuth === 'password' ? server.password : '',
        privateKeyPath: server.sshAuth === 'key' ? server.privateKeyPath : '',
        privateKeyPassphrase: server.privateKeyPassphrase,
        fingerprint: server.fingerprint,
      })}\n`,
    );

    try {
      const answer = await this.#readPort(child, () => tunnel.stderr);
      if (!answer?.ok || !answer.port) {
        throw new Error(answer?.error || '没有拿到本地隧道端口。');
      }
      tunnel.port = Number(answer.port);
      return tunnel.port;
    } catch (error) {
      await this.#stopTunnel();
      throw error;
    }
  }

  #readPort(child, stderrText) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
        fn(value);
      };
      const onData = (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index === -1) return;
        try {
          finish(resolve, JSON.parse(buffer.slice(0, index)));
        } catch {
          finish(reject, new Error('SSH 隧道返回了无法识别的内容。'));
        }
      };
      const onExit = (code) => {
        finish(
          reject,
          new Error(
            `SSH 隧道进程退出（代码 ${code}）。${stderrText() ? `\n${stderrText().trim().slice(-600)}` : ''}`,
          ),
        );
      };
      const onError = (error) => finish(reject, error);
      const timer = setTimeout(() => {
        finish(reject, new Error('SSH 隧道连接超时，请检查地址、端口和凭据。'));
      }, TUNNEL_TIMEOUT);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  async #stopTunnel() {
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (!tunnel) return;
    try {
      tunnel.child.stdin.write('close\n');
    } catch {
      /* already gone */
    }
    try {
      tunnel.child.stdin.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        tunnel.child.kill();
      } catch {
        /* exited */
      }
    }, 400).unref?.();
  }

  async stop() {
    await this.#stopTunnel();
    await this.#stopRelay();
  }
}

module.exports = { ProxyManager, normalize, problemOf, buildPac, bypassRules, summary };
