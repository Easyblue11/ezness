import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { LocalePackError, LocalePackInfo, LocalePackPayload } from '../types';
import enUS from './en-US.json';
import zhCN from './zh-CN.json';

export type LanguageVars = Record<string, string | number>;

export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  builtin: boolean;
  custom: boolean;
}

interface LocaleMeta {
  code: string;
  name: string;
  nativeName: string;
  dir?: 'ltr' | 'rtl';
  version?: number;
}

interface Pack {
  meta: LocaleMeta;
  messages: Record<string, string>;
}

interface I18nValue {
  language: string;
  locale: string;
  dir: 'ltr' | 'rtl';
  languages: LanguageOption[];
  errors: LocalePackError[];
  loading: boolean;
  /** Translate a key, interpolating `{name}` placeholders. */
  t: (key: string, vars?: LanguageVars) => string;
  setLanguage: (code: string) => void;
  /** Re-scan the language folder and reload the active pack. */
  refresh: () => Promise<void>;
  /** Create `<dataRoot>/locales` with a README + example pack, then open it. */
  openFolder: () => Promise<{ ok: boolean; dir?: string; error?: string }>;
}

const BUILTIN_ORDER = ['zh-CN', 'en-US'];
const FALLBACK_LANGUAGE = 'zh-CN';

function splitPack(raw: unknown): Pack {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawMeta =
    source._meta && typeof source._meta === 'object'
      ? (source._meta as Record<string, unknown>)
      : {};
  const meta: LocaleMeta = {
    code: typeof rawMeta.code === 'string' ? rawMeta.code : '',
    name: typeof rawMeta.name === 'string' ? rawMeta.name : '',
    nativeName: typeof rawMeta.nativeName === 'string' ? rawMeta.nativeName : '',
    dir: rawMeta.dir === 'rtl' ? 'rtl' : 'ltr',
    version: typeof rawMeta.version === 'number' ? rawMeta.version : undefined,
  };
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== '_meta' && typeof value === 'string') messages[key] = value;
  }
  return { meta, messages };
}

const BUILTIN: Record<string, Pack> = {
  'zh-CN': splitPack(zhCN),
  'en-US': splitPack(enUS),
};

/** IPC returns `{meta, messages}`; built-ins are flat files, so normalise here. */
function packFromPayload(payload: LocalePackPayload, info: LocalePackInfo): Pack | null {
  if (!payload || typeof payload !== 'object' || !payload.messages) return null;
  return {
    meta: {
      code: payload.meta?.code || info.code,
      name: payload.meta?.name || info.name,
      nativeName: payload.meta?.nativeName || info.nativeName,
      dir: payload.meta?.dir === 'rtl' ? 'rtl' : 'ltr',
    },
    messages: payload.messages,
  };
}
const FALLBACK_MESSAGES = BUILTIN[FALLBACK_LANGUAGE].messages;
const EXAMPLE_PACK = zhCN as unknown as Record<string, unknown>;

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function formatMessage(text: string, vars?: LanguageVars): string {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

function countOf(vars?: LanguageVars): number | null {
  const value = vars?.count;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function lookup(
  messages: Record<string, string>,
  key: string,
  vars: LanguageVars | undefined,
  locale: string,
): string | undefined {
  const count = countOf(vars);
  if (count !== null) {
    let category = count === 1 ? 'one' : 'other';
    try {
      category = new Intl.PluralRules(locale).select(count);
    } catch {
      /* invalid locale: keep the simple one/other split */
    }
    const plural =
      messages[`${key}.${category}`] ??
      messages[`${key}.${category === 'one' ? 'other' : 'one'}`];
    if (plural !== undefined) return plural;
  }
  return messages[key];
}

function sameCode(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const I18nContext = createContext<I18nValue | null>(null);

interface ProviderProps {
  language: string;
  onLanguageChange: (code: string) => void;
  children: ReactNode;
}

export function I18nProvider({ language, onLanguageChange, children }: ProviderProps) {
  const [packInfos, setPackInfos] = useState<LocalePackInfo[]>([]);
  const [errors, setErrors] = useState<LocalePackError[]>([]);
  const [customPacks, setCustomPacks] = useState<Record<string, Pack>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const api = window.ezness;
    if (!api?.localesList) return;
    setLoading(true);
    try {
      const result = await api.localesList();
      setPackInfos(result?.packs ?? []);
      setErrors(result?.errors ?? []);
      // Force the active pack to be re-read even if it was loaded before.
      setCustomPacks({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeInfo = useMemo(
    () => packInfos.find((pack) => sameCode(pack.code, language)) ?? null,
    [packInfos, language],
  );

  // Load the pack for the current language. A custom file with the same code as
  // a built-in language intentionally wins, key by key.
  useEffect(() => {
    const api = window.ezness;
    if (!activeInfo || !api?.localesRead) return;
    if (Object.keys(customPacks).some((code) => sameCode(code, activeInfo.code))) return;

    let cancelled = false;
    void (async () => {
      const payload: LocalePackPayload | null = await api.localesRead(activeInfo.file);
      if (cancelled || !payload) return;
      const pack = packFromPayload(payload, activeInfo);
      if (!pack) return;
      setCustomPacks((current) => {
        if (Object.keys(current).some((code) => sameCode(code, activeInfo.code))) return current;
        return { ...current, [pack.meta.code || activeInfo.code]: pack };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeInfo, customPacks]);

  const activeMessages = useMemo(() => {
    const exact = Object.keys(customPacks).find((code) => sameCode(code, language));
    const custom = exact ? customPacks[exact].messages : {};
    const builtinCode = BUILTIN_ORDER.find((code) => sameCode(code, language));
    const builtin = builtinCode ? BUILTIN[builtinCode].messages : {};
    return { ...builtin, ...custom };
  }, [customPacks, language]);

  const locale = useMemo(() => {
    const exact = Object.keys(customPacks).find((code) => sameCode(code, language));
    const meta = exact ? customPacks[exact].meta : undefined;
    const code = meta?.code || activeInfo?.code || language;
    // A pack may use an underscore (`pt_BR`); Intl wants a hyphen.
    return code.replace(/_/g, '-');
  }, [customPacks, language, activeInfo]);

  const dir = useMemo(() => {
    const exact = Object.keys(customPacks).find((code) => sameCode(code, language));
    const customDir = exact ? customPacks[exact].meta.dir : undefined;
    if (customDir === 'rtl' || customDir === 'ltr') return customDir;
    const builtin = BUILTIN_ORDER.find((code) => sameCode(code, language));
    return BUILTIN[builtin ?? '']?.meta.dir === 'rtl' ? 'rtl' : 'ltr';
  }, [customPacks, language]);

  const t = useCallback(
    (key: string, vars?: LanguageVars) => {
      const text =
        lookup(activeMessages, key, vars, locale) ??
        lookup(FALLBACK_MESSAGES, key, vars, FALLBACK_LANGUAGE);
      return text === undefined ? key : formatMessage(text, vars);
    },
    [activeMessages, locale],
  );

  const languages = useMemo(() => {
    const options = new Map<string, LanguageOption>();

    for (const code of BUILTIN_ORDER) {
      const meta = BUILTIN[code].meta;
      options.set(code, {
        code,
        name: meta.name || code,
        nativeName: meta.nativeName || meta.name || code,
        builtin: true,
        custom: false,
      });
    }

    for (const info of packInfos) {
      const option: LanguageOption = {
        code: info.code,
        name: info.name || info.code,
        nativeName: info.nativeName || info.name || info.code,
        builtin: BUILTIN_ORDER.some((code) => sameCode(code, info.code)),
        custom: true,
      };
      const existingKey = [...options.keys()].find((code) => sameCode(code, info.code));
      options.set(existingKey ?? info.code, option);
    }

    // A stored language whose pack was removed still has to appear, otherwise
    // the select would silently show a different option than the real state.
    if (![...options.keys()].some((code) => sameCode(code, language))) {
      options.set(language, {
        code: language,
        name: language,
        nativeName: language,
        builtin: false,
        custom: false,
      });
    }

    return [...options.values()].sort((a, b) => {
      const ai = BUILTIN_ORDER.findIndex((code) => sameCode(code, a.code));
      const bi = BUILTIN_ORDER.findIndex((code) => sameCode(code, b.code));
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.nativeName.localeCompare(b.nativeName, 'en');
    });
  }, [packInfos, language]);

  const setLanguage = useCallback(
    (code: string) => {
      const next = code.trim();
      if (next && !sameCode(next, language)) onLanguageChange(next);
    },
    [language, onLanguageChange],
  );

  const openFolder = useCallback(async () => {
    const api = window.ezness;
    if (!api?.localesOpenFolder) {
      return { ok: false, error: t('system.language.desktopOnly') };
    }
    const result = await api.localesOpenFolder(EXAMPLE_PACK);
    if (result?.ok) {
      // A new folder usually means the user is about to add a pack; rescan so
      // the picker is current when they come back from Explorer.
      void refresh();
    }
    return result ?? { ok: false };
  }, [refresh, t]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const value = useMemo<I18nValue>(
    () => ({
      language,
      locale,
      dir,
      languages,
      errors,
      loading,
      t,
      setLanguage,
      refresh,
      openFolder,
    }),
    [language, locale, dir, languages, errors, loading, t, setLanguage, refresh, openFolder],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

/** Built-in language codes, in menu order. */
export const BUILTIN_LANGUAGES: readonly string[] = BUILTIN_ORDER;
