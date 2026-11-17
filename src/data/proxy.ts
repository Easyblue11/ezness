import type {
  ProxyMode,
  ProxyRule,
  ProxyScheme,
  ProxyServerSettings,
  ProxySettings,
} from '../types';

/** 出厂默认：代理关着，所有请求直连；要用代理得自己去设置里打开。 */
export const DEFAULT_PROXY: ProxySettings = {
  enabled: false,
  mode: 'direct',
  server: {
    scheme: 'http',
    host: '',
    port: 7890,
    username: '',
    password: '',
    sshAuth: 'password',
    privateKeyPath: '',
    privateKeyPassphrase: '',
    fingerprint: '',
  },
  bypass: 'localhost\n127.0.0.1\n::1',
  rules: [],
  autoDefault: 'proxy',
};

export const PROXY_MODES: { mode: ProxyMode; label: string; desc: string }[] = [
  { mode: 'direct', label: '直接连接', desc: '所有请求直连，不使用任何代理。' },
  { mode: 'system', label: '系统代理', desc: '跟随 Windows / macOS 的系统代理设置。' },
  { mode: 'fixed', label: '固定代理', desc: '所有请求都走下面这一台代理服务器。' },
  { mode: 'auto', label: '自动切换', desc: '按域名规则分流，未命中时用默认动作。' },
];

export const PROXY_SCHEMES: { scheme: ProxyScheme; label: string; desc: string }[] = [
  { scheme: 'http', label: 'HTTP 代理', desc: '最常见的代理；HTTPS 网站也通过 CONNECT 走它。' },
  { scheme: 'https', label: 'HTTPS 代理', desc: '与代理服务器之间使用 TLS 加密，不是「用来访问 HTTPS 网站」。' },
  { scheme: 'socks5', label: 'SOCKS5 代理', desc: '支持域名转发，适合本地代理客户端。' },
  { scheme: 'ssh', label: 'SSH 代理', desc: '通过 SSH 登录远程主机建立本地 SOCKS5 隧道。' },
];

export function proxyRuleId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function trimText(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max);
}

function flag(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function normalizeServer(saved?: Partial<ProxyServerSettings> | null): ProxyServerSettings {
  const rawPort = Math.trunc(Number(saved?.port));
  return {
    scheme: flag(saved?.scheme, ['http', 'https', 'socks5', 'ssh'], 'http') as ProxyScheme,
    host: trimText(saved?.host, 260),
    port: Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : DEFAULT_PROXY.server.port,
    username: trimText(saved?.username, 200),
    // A password may intentionally contain spaces; only the length is bounded.
    password: String(saved?.password ?? '').slice(0, 400),
    sshAuth: flag(saved?.sshAuth, ['password', 'key'], 'password') as 'password' | 'key',
    privateKeyPath: trimText(saved?.privateKeyPath, 1000),
    privateKeyPassphrase: String(saved?.privateKeyPassphrase ?? '').slice(0, 400),
    fingerprint: trimText(saved?.fingerprint, 200),
  };
}

function normalizeRules(saved: unknown): ProxyRule[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((rule) => rule && typeof rule === 'object')
    .slice(0, 200)
    .map((rule, index) => ({
      id: trimText(rule.id, 80) || `rule-${index}`,
      pattern: trimText(rule.pattern, 200),
      action: rule.action === 'direct' ? ('direct' as const) : ('proxy' as const),
    }));
}

/**
 * Settings written by older versions have no proxy block; anything unusable
 * falls back to the shipped default rather than breaking the network stack.
 */
export function normalizeProxy(saved?: Partial<ProxySettings> | null): ProxySettings {
  return {
    // 只有明确存过「开」才算开：老设置和全新安装都落到「关 + 直连」。
    enabled: saved?.enabled === true,
    mode: flag(saved?.mode, ['direct', 'system', 'fixed', 'auto'], 'direct') as ProxyMode,
    server: normalizeServer(saved?.server),
    bypass: String(saved?.bypass ?? DEFAULT_PROXY.bypass).slice(0, 4000),
    rules: normalizeRules(saved?.rules),
    autoDefault: saved?.autoDefault === 'direct' ? 'direct' : 'proxy',
  };
}

/**
 * What would stop this configuration from being applied. Returns null when it
 * is usable. Hosts are also validated against a character allow-list because
 * they end up inside Chromium proxy rules and the generated PAC script.
 */
export function proxyProblem(settings: ProxySettings): string | null {
  const { mode, server } = settings;
  if (!settings.enabled || mode === 'direct' || mode === 'system') return null;

  if (!server.host) return '请填写代理服务器地址。';
  if (!/^[A-Za-z0-9._\-:[\]]+$/.test(server.host)) {
    return '代理服务器地址只能包含域名或 IP，不要带协议前缀和路径。';
  }
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    return '端口需要在 1–65535 之间。';
  }

  if (server.scheme === 'ssh') {
    if (!server.username) return '请填写 SSH 登录用户名。';
    if (server.sshAuth === 'password' && !server.password) return '请填写 SSH 密码。';
    if (server.sshAuth === 'key' && !server.privateKeyPath) return '请选择私钥文件。';
  }

  if (mode === 'auto') {
    const broken = settings.rules.find(
      (rule) => rule.pattern && !/^[A-Za-z0-9.*_\-[\]]+$/.test(rule.pattern),
    );
    if (broken) return `规则「${broken.pattern}」不合法，只支持域名、IP 和 * 通配符。`;
  }
  return null;
}

/** Short human label used by the status pill. */
export function proxySummary(settings: ProxySettings): string {
  const { mode, server } = settings;
  if (!settings.enabled) return '已关闭';
  if (mode === 'direct') return '直接连接';
  if (mode === 'system') return '系统代理';
  const scheme =
    PROXY_SCHEMES.find((item) => item.scheme === server.scheme)?.label.replace(' 代理', '') ?? 'HTTP';
  const address = `${server.host}:${server.port}`;
  return mode === 'auto' ? `自动切换 · ${settings.rules.length} 条规则` : `固定代理 · ${scheme} ${address}`;
}
