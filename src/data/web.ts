import type { KbChatSettings, WebEntry, WebMode, WebSettings } from '../types';

/**
 * Built-in network entries for the 联网 switch. All are parsed from public HTML
 * pages in the main process; `{query}` is replaced with the encoded question.
 * DuckDuckGo is off by default: it is often unreachable from mainland networks.
 */
export const DEFAULT_WEB_ENTRIES: WebEntry[] = [
  {
    id: 'bing',
    name: 'Bing',
    url: 'https://www.bing.com/search?q={query}&setlang=zh-Hans',
    parser: 'bing',
    enabled: true,
    builtin: true,
  },
  {
    id: 'so',
    name: '360 搜索',
    url: 'https://www.so.com/s?q={query}',
    parser: 'so',
    enabled: true,
    builtin: true,
  },
  {
    id: 'baidu',
    name: '百度',
    url: 'https://www.baidu.com/s?wd={query}',
    parser: 'baidu',
    enabled: true,
    builtin: true,
  },
  {
    id: 'shenma',
    name: '神马搜索',
    url: 'https://m.sm.cn/s?q={query}',
    parser: 'shenma',
    enabled: true,
    builtin: true,
  },
  {
    id: 'quark',
    name: '夸克搜索',
    url: 'https://quark.sm.cn/s?q={query}',
    parser: 'quark',
    enabled: false,
    builtin: true,
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    url: 'https://lite.duckduckgo.com/lite/?q={query}',
    parser: 'duckduckgo',
    enabled: false,
    builtin: true,
  },
];

export const DEFAULT_WEB: WebSettings = { entries: DEFAULT_WEB_ENTRIES, defaultMode: 'auto' };

export function normalizeWebMode(value: unknown, fallback: WebMode = 'auto'): WebMode {
  return value === 'off' || value === 'auto' || value === 'always' ? value : fallback;
}

/**
 * 联网 mode for one conversation/task. Older builds stored a boolean `web`
 * (`true` = search before every message); it maps to 自动, so an upgrade stops
 * searching on greetings while still looking up facts that need the web.
 */
export function readWebMode(
  kb: KbChatSettings | null | undefined,
  fallback: WebMode = 'auto',
): WebMode {
  if (!kb) return normalizeWebMode(fallback);
  if (kb.webMode === 'off' || kb.webMode === 'auto' || kb.webMode === 'always') {
    return kb.webMode;
  }
  const legacy = (kb as KbChatSettings & { web?: boolean }).web;
  if (legacy === false) return 'off';
  if (legacy === true) return 'auto';
  return normalizeWebMode(fallback);
}

export function webEntryId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/**
 * Merge a saved list over the built-ins: new built-in entries show up after an
 * upgrade, user edits (URLs, toggles) survive, and custom entries are kept.
 */
export function normalizeWeb(saved?: WebSettings | null): WebSettings {
  // Older builds stored a boolean `defaultOn`. `true` becomes 自动 (not 总是),
  // so an upgrade stops searching before every 「你好」 while still looking
  // things up when the answer actually needs the web; `false` stays off.
  const legacy = saved as (WebSettings & { defaultOn?: boolean }) | null | undefined;
  const defaultMode: WebMode = saved?.defaultMode
    ? normalizeWebMode(saved.defaultMode)
    : legacy?.defaultOn === false
      ? 'off'
      : 'auto';

  if (!Array.isArray(saved?.entries) || saved.entries.length === 0) {
    return { entries: DEFAULT_WEB_ENTRIES.map((entry) => ({ ...entry })), defaultMode };
  }

  const savedEntries: WebEntry[] = [];
  for (const entry of saved.entries) {
    if (!entry || typeof entry.url !== 'string') continue;
    savedEntries.push({
      id: String(entry.id || webEntryId()),
      name: String(entry.name || '网络入口'),
      url: entry.url,
      parser: entry.parser ?? 'html',
      enabled: entry.enabled !== false,
      builtin: Boolean(DEFAULT_WEB_ENTRIES.some((item) => item.id === entry.id)) || entry.builtin,
    });
  }

  // Built-ins keep their canonical order (new ones from an upgrade included),
  // then the user's custom entries follow in their saved order.
  const entries: WebEntry[] = DEFAULT_WEB_ENTRIES.map(
    (builtin) => savedEntries.find((entry) => entry.id === builtin.id) ?? { ...builtin },
  );
  for (const entry of savedEntries) {
    if (!DEFAULT_WEB_ENTRIES.some((builtin) => builtin.id === entry.id)) entries.push(entry);
  }

  return { entries, defaultMode };
}
