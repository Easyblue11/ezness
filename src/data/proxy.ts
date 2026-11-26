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
  { mode: 'direct', label: 'settings.proxy.mode.direct', desc: 'settings.proxy.modes.directDesc' },
  { mode: 'system', label: 'settings.proxy.mode.system', desc: 'settings.proxy.modes.systemDesc' },
  { mode: 'fixed', label: 'settings.proxy.mode.fixed', desc: 'settings.proxy.modes.fixedDesc' },
  { mode: 'auto', label: 'settings.proxy.mode.auto', desc: 'settings.proxy.modes.autoDesc' },
];

export const PROXY_SCHEMES: { scheme: ProxyScheme; label: string; desc: string }[] = [
  {
    scheme: 'http',
    label: 'settings.proxy.schemes.http.label',
    desc: 'settings.proxy.schemes.http.desc',
  },
  {
    scheme: 'https',
    label: 'settings.proxy.schemes.https.label',
    desc: 'settings.proxy.schemes.https.desc',
  },
  {
    scheme: 'socks5',
    label: 'settings.proxy.schemes.socks5.label',
    desc: 'settings.proxy.schemes.socks5.desc',
  },
  {
    scheme: 'ssh',
    label: 'settings.proxy.schemes.ssh.label',
    desc: 'settings.proxy.schemes.ssh.desc',
  },
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

/** A user-facing validation problem: an i18n key plus its interpolation values. */
export interface ProxyProblem {
  key: string;
  vars?: Record<string, string | number>;
}

/**
 * What would stop this configuration from being applied. Returns null when it
 * is usable. Hosts are also validated against a character allow-list because
 * they end up inside Chromium proxy rules and the generated PAC script.
 */
export function proxyProblem(settings: ProxySettings): ProxyProblem | null {
  const { mode, server } = settings;
  if (!settings.enabled || mode === 'direct' || mode === 'system') return null;

  if (!server.host) return { key: 'settings.proxy.problem.hostRequired' };
  if (!/^[A-Za-z0-9._\-:[\]]+$/.test(server.host)) {
    return { key: 'settings.proxy.problem.hostInvalid' };
  }
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    return { key: 'settings.proxy.problem.portRange' };
  }

  if (server.scheme === 'ssh') {
    if (!server.username) return { key: 'settings.proxy.problem.sshUserRequired' };
    if (server.sshAuth === 'password' && !server.password) {
      return { key: 'settings.proxy.problem.sshPasswordRequired' };
    }
    if (server.sshAuth === 'key' && !server.privateKeyPath) {
      return { key: 'settings.proxy.problem.sshKeyRequired' };
    }
  }

  if (mode === 'auto') {
    const broken = settings.rules.find(
      (rule) => rule.pattern && !/^[A-Za-z0-9.*_\-[\]]+$/.test(rule.pattern),
    );
    if (broken) {
      return { key: 'settings.proxy.problem.ruleInvalid', vars: { pattern: broken.pattern } };
    }
  }
  return null;
}
