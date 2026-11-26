import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentPage } from './components/AgentPage';
import { BillingPage } from './components/BillingPage';
import { ChatView } from './components/ChatView';
import type { ActivityStatus } from './components/ActivityDot';
import { KnowledgePage } from './components/KnowledgePage';
import { PromptsPage } from './components/PromptsPage';
import { RailNav } from './components/RailNav';
import { SensoryPage } from './components/SensoryPage';
import { SettingsPage } from './components/SettingsPage';
import { I18nProvider, useI18n } from './i18n';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { WarehousePage } from './components/WarehousePage';
import { WorkspacePage } from './components/WorkspacePage';
import { INITIAL_MESSAGES, INITIAL_SESSIONS } from './data/mock';
import { renderPrompt } from './data/prompts';
import { DEFAULT_WEB, normalizeWeb, readWebMode } from './data/web';
import { DEFAULT_PROXY, normalizeProxy } from './data/proxy';
import { DEFAULT_WORK, normalizeWork } from './data/work';
import { isDefaultTitle, sessionTitle } from './lib/sessionTitle';
import {
  buildRagSystemPrompt,
  buildWebSystemPrompt,
  collectCitations,
  collectSources,
  type RagContext,
} from './lib/rag';
import { buildAttachmentContext, buildSessionMarkdown } from './lib/chat';
import { DEFAULT_FX_RATE } from './lib/usage';
import {
  compressConversation,
  contextTokensFromUsage,
  conversationTokens,
  isVisible,
  selectCompressible,
  summarySavingSince,
  type CompressionToken,
} from './lib/compression';
import {
  createDefaultProviders,
  EMPTY_DEFAULTS,
  joinModelKey,
  splitModelKey,
} from './data/providers';
import type {
  ChatStreamEvent,
  ChatTarget,
  ChatTurn,
  CitationLink,
  CloseAction,
  CompressionInfo,
  Defaults,
  DefaultsKey,
  KbChatSettings,
  KbSearchHit,
  Message,
  ModelOption,
  OcrSettings,
  ProviderConfig,
  ProxySettings,
  Session,
  StoredSettings,
  Theme,
  UsageEvent,
  UsageRecord,
  UsageSnapshot,
  ViewKey,
  VoiceSettings,
  WarehouseItem,
  WarehouseUsage,
  WebMode,
  WebSettings,
  WorkSettings,
  WorkspaceLibrary,
} from './types';

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/**
 * Token count for the live rate readout. Providers only report exact usage at
 * the very end of a stream, so live rate has to be estimated: CJK characters
 * are close to one token each, everything else averages ~4 characters per token.
 */
function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return cjk + (text.length - cjk) / 4;
}

const EMPTY_WORKSPACE_LIBRARY: WorkspaceLibrary = {
  workspaces: [],
  chats: [],
  messages: [],
};

const DEFAULT_KB: KbChatSettings = {
  enabled: false,
  categoryId: null,
  mode: 'balanced',
  // Auto is the default: the model decides whether a turn needs the web, so
  // 「你好」 no longer triggers a search while fresh facts still do.
  webMode: 'auto',
};

/**
 * Session-level KB settings survive in memory only today. Sessions created
 * before the three-state switch have no `webMode` — they fall back to the
 * 默认联网方式 from 设置 → 网络设置.
 */
function readKb(
  session: Session | null | undefined,
  webDefault: WebMode,
): KbChatSettings {
  const kb = session?.kb;
  if (!kb) return { ...DEFAULT_KB, webMode: webDefault };
  const merged: KbChatSettings & { web?: boolean } = {
    ...DEFAULT_KB,
    ...kb,
    webMode: readWebMode(kb, webDefault),
  };
  // Drop the boolean switch from older saves so it cannot come back to life.
  delete merged.web;
  return merged;
}

const THEME_KEY = 'ezness.theme';

/**
 * Theme for the very first paint. The durable copy lives in settings.json
 * (theme), but that file is read asynchronously — without this synchronous
 * cache the app would flash dark on every launch before switching to light.
 * A fresh install follows the OS preference instead of forcing dark.
 */
function cachedTheme(): Theme | null {
  try {
    const cached = localStorage.getItem(THEME_KEY);
    if (cached === 'dark' || cached === 'light') return cached;
  } catch {
    /* storage blocked */
  }
  return null;
}

function initialTheme(): Theme {
  return cachedTheme() ?? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

const LANGUAGE_KEY = 'ezness.language';
const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

/**
 * Interface language for the first paint, mirroring the theme cache. The
 * durable copy is settings.json; this only avoids a flash of Chinese when the
 * user picked another language and the async file read is still in flight.
 */
function cachedLanguage(): string | null {
  try {
    const cached = localStorage.getItem(LANGUAGE_KEY);
    if (cached && LANGUAGE_CODE.test(cached)) return cached;
  } catch {
    /* storage blocked */
  }
  return null;
}

function initialLanguage(): string {
  // Installed builds ship English-first for a wider audience; development
  // (`electron .`) keeps Chinese, matching the rest of the working tree.
  return cachedLanguage() ?? (window.ezness?.isPackaged ? 'en-US' : 'zh-CN');
}

const DEFAULT_VOICE: VoiceSettings = { inputDeviceId: '' };
// -1 = 不限制扫描版 PDF 的识别页数（默认）。
const DEFAULT_OCR: OcrSettings = { enabled: true, pdf: true, maxPages: -1 };
const EMPTY_PROMPT_VARIABLES: Record<string, string> = {};

/**
 * Every view stays mounted and is only hidden. Switching to the knowledge base
 * or settings and back must not throw away a draft message, a scroll position
 * or a half-typed search. `display: contents` keeps the children as direct grid
 * items of the workspace while the wrapper collapses out of layout when shown.
 */
function ViewSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={`view-slot ${active ? '' : 'is-hidden'}`}>{children}</div>;
}

export default function App() {
  const [language, setLanguage] = useState<string>(initialLanguage);
  return (
    <I18nProvider language={language} onLanguageChange={setLanguage}>
      <AppBody language={language} onLanguageChange={setLanguage} />
    </I18nProvider>
  );
}

function AppBody({
  language,
  onLanguageChange,
}: {
  /** 界面语言；默认中文，其他语言由内置包或 locales/ 里的自定义包提供。 */
  language: string;
  onLanguageChange: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  /** Whether localStorage already had a choice before this launch's cache write. */
  const hadCachedLanguage = useRef(cachedLanguage() !== null);
  /** 系统设置里的「金额动画」开关；关掉后花费不再触发金币动画。 */
  const [rmbAnimation, setRmbAnimation] = useState(true);
  /** 关闭窗口时：'tray' 最小化到托盘，'quit' 直接退出，'' = 第一次关时询问。 */
  const [closeAction, setCloseAction] = useState<CloseAction>('');
  const [view, setView] = useState<ViewKey>('chat');
  const [sessions, setSessions] = useState<Session[]>(INITIAL_SESSIONS);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [activeId, setActiveId] = useState(INITIAL_SESSIONS[0].id);
  const [query, setQuery] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  /**
   * 会话列表的红点：该会话在用户没看它的时候跑完了。点开会话即清除。
   * 只记在内存里——重启后不保留「没看过」的旧状态。
   */
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(() => new Set());
  // Set when the warehouse asks to jump to an attachment in a conversation.
  const [focusTarget, setFocusTarget] = useState<{
    messageId: string;
    nonce: number;
  } | null>(null);
  // Set when a chat attachment asks to locate its file in the warehouse.
  const [warehouseFocus, setWarehouseFocus] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  // Set when the warehouse asks to jump into a 工作空间 conversation.
  const [workspaceFocus, setWorkspaceFocus] = useState<{
    workspaceId: string;
    chatId: string;
    messageId: string;
    nonce: number;
  } | null>(null);
  // Set when AI能力 asks to open (or create) the 功能编辑-<分类> workspace.
  const [toolEditorFocus, setToolEditorFocus] = useState<{
    categoryId: string;
    categoryName: string;
    nonce: number;
  } | null>(null);
  // Set when the Agent page asks to open Agent编辑-<hash> for one definition.
  const [agentEditorFocus, setAgentEditorFocus] = useState<{
    agentId: string;
    agentName: string;
    nonce: number;
  } | null>(null);
  // Workspace chats/messages live in WorkspacePage; it reports a snapshot here
  // so warehouse usage can include them without lifting all of its state.
  const [workspaceLibrary, setWorkspaceLibrary] =
    useState<WorkspaceLibrary>(EMPTY_WORKSPACE_LIBRARY);
  const [streamPhase, setStreamPhase] = useState<'retrieving' | 'generating'>('generating');
  const [streamSpeed, setStreamSpeed] = useState<number | null>(null);

  const [providers, setProviders] = useState<Record<string, ProviderConfig>>(createDefaultProviders);
  const [defaults, setDefaults] = useState<Defaults>(EMPTY_DEFAULTS);
  const [voice, setVoice] = useState<VoiceSettings>(DEFAULT_VOICE);
  const [ocr, setOcr] = useState<OcrSettings>(DEFAULT_OCR);
  const [web, setWeb] = useState<WebSettings>(DEFAULT_WEB);
  const [proxy, setProxy] = useState<ProxySettings>(DEFAULT_PROXY);
  const [work, setWork] = useState<WorkSettings>(DEFAULT_WORK);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Spend ledger: the full history for the billing page and today's rollup for
  // the rail tooltip. The main process owns the file; this is its mirror.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  /** 每次累计花费跨过 0.1 元就 +1，侧边栏据此重放金币动画。 */
  const [coinKey, setCoinKey] = useState(0);
  /** 侧边栏「重新加载」按钮：主进程重读定义后整窗刷新。 */
  const [reloading, setReloading] = useState(false);
  const coinStepRef = useRef<number | null>(null);

  const streamRef = useRef<{ requestId: string; messageId: string; sessionId: string } | null>(null);
  const retrievalRef = useRef<{
    messageId: string;
    canceled: boolean;
    /** 自动联网 judge request, so Stop does not leave it running. */
    judgeRequestId?: string;
  } | null>(null);

  // The stream listener below is registered once; read the current translator
  // from a ref so switching language does not re-subscribe mid-stream.
  const tRef = useRef(t);
  tRef.current = t;

  // The stream event listener below is registered once, so it reads the
  // current session from a ref: a run that finishes while the user is in
  // another conversation must still be marked as unread.
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
    setUnreadSessions((prev) => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      return next;
    });
  }, [activeId]);

  // Context compression runs as its own activation: a separate request id and
  // stream, so it never interferes with the chat bubble being generated.
  const [compressingId, setCompressingId] = useState<string | null>(null);
  const [compressionStep, setCompressionStep] = useState<{
    sessionId: string;
    step: number;
    total: number;
    phase: 'map' | 'reduce';
  } | null>(null);
  const [compressionError, setCompressionError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const compressionToken = useRef<CompressionToken | null>(null);
  const autoCompressGuard = useRef<string | null>(null);
  const compressHandlerRef = useRef<(sessionId: string) => void>(() => undefined);

  // Tokens arrive far faster than React can paint; batch them into ~20 fps.
  const deltaBuffer = useRef<{
    messageId: string | null;
    content: string;
    thinking: string;
    timer: number | null;
  }>({ messageId: null, content: '', thinking: '', timer: null });

  // Live output rate: estimated tokens seen so far, and the last 2s sample.
  const speedRef = useRef({ tokens: 0, sampled: 0, sampledAt: 0 });

  useEffect(() => {
    if (streamingId === null) {
      setStreamSpeed(null);
      return;
    }
    const tick = () => {
      const now = Date.now();
      const elapsed = (now - speedRef.current.sampledAt) / 1000;
      const produced = speedRef.current.tokens - speedRef.current.sampled;
      speedRef.current.sampled = speedRef.current.tokens;
      speedRef.current.sampledAt = now;
      setStreamSpeed(elapsed > 0 ? produced / elapsed : 0);
    };
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, [streamingId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* settings.json still carries it */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch {
      /* settings.json still carries it */
    }
  }, [language]);

  // The ledger is written by the main process as requests finish; subscribe so
  // the rail tooltip and an open billing page update without a refresh.
  useEffect(() => {
    let cancelled = false;
    let midnightTimer = 0;

    const reloadUsage = async () => {
      try {
        const snapshot = await window.ezness?.usageLoad?.();
        if (!cancelled && snapshot) setUsage(snapshot);
      } catch {
        /* keep the last snapshot */
      }
    };

    // "Today" is a rolling window: refresh just after midnight so an app left
    // open all night does not keep showing yesterday's rollup.
    const scheduleMidnight = () => {
      const next = new Date();
      next.setHours(24, 0, 5, 0);
      midnightTimer = window.setTimeout(() => {
        void reloadUsage().finally(() => {
          if (!cancelled) scheduleMidnight();
        });
      }, Math.max(1000, next.getTime() - Date.now()));
    };

    void reloadUsage();
    scheduleMidnight();

    const unsubscribe = window.ezness?.onUsageEvent?.((event: UsageEvent) => {
      if (event.type === 'reload') {
        setUsage(event.snapshot);
        return;
      }
      const record: UsageRecord = event.record;
      setUsage((prev) => ({
        records: prev ? [...prev.records, record] : [record],
        today: event.today,
        fxRate: prev?.fxRate ?? DEFAULT_FX_RATE,
      }));
    });

    return () => {
      cancelled = true;
      window.clearTimeout(midnightTimer);
      unsubscribe?.();
    };
  }, []);

  // 累计花费每跨过 0.1 元，就让侧边栏的计费按钮播放一次金币动画。
  // 第一次拿到账本（启动或重载）只记基线，不播放，免得一打开应用就跳。
  const totalCents = useMemo(() => {
    if (!usage) return null;
    const total = usage.records.reduce(
      (sum, record) => sum + (typeof record.cost === 'number' ? record.cost : 0),
      0,
    );
    return Math.round(total * 100);
  }, [usage]);

  useEffect(() => {
    if (totalCents === null) return;
    const nextStep = Math.floor(totalCents / 10) * 10 + 10;
    if (coinStepRef.current === null) {
      coinStepRef.current = nextStep;
      return;
    }
    if (totalCents >= coinStepRef.current) {
      // 一次跨过多个 0.1 元也只播一次，避免连续请求时动画叠成一片。
      coinStepRef.current = nextStep;
      if (rmbAnimation) setCoinKey((key) => key + 1);
    }
  }, [totalCents, rmbAnimation]);

  // 对话 history is restored from <data root>/chats.json on mount and written
  // back debounced. Without this every restart started from 新对话 and threw
  // away everything that had been said — 工作空间 tasks were the only ones kept.
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await window.ezness?.chatsLoad?.();
      if (!cancelled && saved) {
        const savedSessions = (Array.isArray(saved.sessions) ? saved.sessions : []).filter(
          (session): session is Session =>
            typeof (session as Session | null)?.id === 'string' &&
            typeof (session as Session | null)?.title === 'string',
        );
        const savedMessages = (Array.isArray(saved.messages) ? saved.messages : []).filter(
          (message): message is Message =>
            typeof (message as Message | null)?.sessionId === 'string' &&
            typeof (message as Message | null)?.content === 'string',
        );
        if (savedSessions.length > 0) {
          const known = new Set(savedSessions.map((session) => session.id));
          setSessions(savedSessions);
          setMessages(savedMessages.filter((message) => known.has(message.sessionId)));
          const active =
            saved.activeId && known.has(saved.activeId) ? saved.activeId : savedSessions[0].id;
          setActiveId(active);
        }
      }
      if (!cancelled) setHistoryLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    const timer = window.setTimeout(() => {
      void window.ezness?.chatsSave?.({ sessions, messages, activeId });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [historyLoaded, sessions, messages, activeId]);

  // Load persisted settings once, then debounce-save every change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await window.ezness?.loadSettings?.();
      if (!cancelled && saved?.providers) {
        // 只认用户自己存下的接入：出厂没有任何预设，也不往列表里补模型。
        setProviders((prev) => ({ ...prev, ...saved.providers }));
        setDefaults((prev) => ({ ...prev, ...saved.defaults }));
      }
      if (!cancelled && saved?.voice) {
        setVoice({ ...DEFAULT_VOICE, ...saved.voice });
      }
      if (!cancelled && saved?.ocr) {
        setOcr({ ...DEFAULT_OCR, ...saved.ocr });
      }
      if (!cancelled && saved?.web) {
        setWeb(normalizeWeb(saved.web));
      }
      if (!cancelled && saved?.work) {
        setWork(normalizeWork(saved.work));
      }
      if (!cancelled && saved?.proxy) {
        setProxy(normalizeProxy(saved.proxy));
      }
      if (!cancelled && saved?.rmbAnimation === false) {
        setRmbAnimation(false);
      }
      if (
        !cancelled &&
        (saved?.closeAction === 'tray' || saved?.closeAction === 'quit')
      ) {
        setCloseAction(saved.closeAction);
      }
      if (
        !cancelled &&
        !hadCachedLanguage.current &&
        typeof saved?.language === 'string' &&
        LANGUAGE_CODE.test(saved.language)
      ) {
        onLanguageChange(saved.language);
      }
      // settings.json is debounced by 500ms; the localStorage copy is written
      // the instant the toggle flips. A refresh right after a switch must not
      // let the older file undo the newer choice.
      if (!cancelled && !cachedTheme() && (saved?.theme === 'dark' || saved?.theme === 'light')) {
        setTheme(saved.theme);
      }
      if (!cancelled) setSettingsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = window.setTimeout(() => {
      const payload: StoredSettings = {
        providers,
        defaults,
        voice,
        ocr,
        web,
        proxy,
        work,
        theme,
        rmbAnimation,
        language,
        closeAction,
      };
      window.ezness?.saveSettings?.(payload);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    settingsLoaded,
    providers,
    defaults,
    voice,
    ocr,
    web,
    proxy,
    work,
    theme,
    rmbAnimation,
    language,
    closeAction,
  ]);

  // The first-close dialog (and the tray) lives in the main process; mirror its
  // choice here so the next settings save does not write an older value back.
  useEffect(() => {
    const unsubscribe = window.ezness?.onCloseAction?.((value) => {
      setCloseAction(value === 'tray' || value === 'quit' ? value : '');
    });
    return () => unsubscribe?.();
  }, []);

  // Ollama runs locally, so pull its model list once on startup instead of
  // making the user click「获取模型」before the chat dropdown is useful.
  // 出厂没有 Ollama 预设，所以这里盯的是用户自己加的那条 Ollama 接入。
  const autoFetched = useRef(false);

  useEffect(() => {
    if (!settingsLoaded || autoFetched.current) return;

    const api = window.ezness;
    const ollama = Object.values(providers).find(
      (provider) => provider.apiType === 'ollama' && provider.baseUrl && provider.models.length === 0,
    );
    if (!api || !ollama) return;
    autoFetched.current = true;

    (async () => {
      const result = await api.fetchModels({
        baseUrl: ollama.baseUrl,
        apiType: 'ollama',
        apiKey: ollama.apiKey,
      });
      if (!result.ok || !result.models?.length) return;

      setProviders((prev) => {
        const current = prev[ollama.id];
        if (!current) return prev;
        const merged = [...new Set([...current.models, ...(result.models ?? [])])];
        if (merged.length === current.models.length) return prev;
        return { ...prev, [ollama.id]: { ...current, models: merged } };
      });
    })();
  }, [settingsLoaded, providers]);

  // Keep the knowledge base pointing at whatever the embedding default says.
  const embeddingTarget = useMemo(() => {
    const parts = splitModelKey(defaults.embedding);
    if (!parts) return null;
    const provider = providers[parts.providerId];
    if (!provider) return null;
    return { baseUrl: provider.baseUrl, model: parts.model, apiKey: provider.apiKey };
  }, [defaults.embedding, providers]);

  // 提示词页「生成英文」用的模型；没配置翻译模型时为 null，按钮保持禁用。
  const translationTarget = useMemo<ChatTarget | null>(() => {
    const parts = splitModelKey(defaults.translation);
    if (!parts) return null;
    const provider = providers[parts.providerId];
    if (!provider?.baseUrl || !provider.models.includes(parts.model)) return null;
    return {
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: parts.model,
      providerId: provider.id,
      providerName: provider.name,
    };
  }, [defaults.translation, providers]);

  const lastEmbeddingSync = useRef('');

  useEffect(() => {
    if (!settingsLoaded || !embeddingTarget) return;
    const { baseUrl, model, apiKey } = embeddingTarget;
    const signature = `${baseUrl}|${model}|${apiKey}`;
    if (signature === lastEmbeddingSync.current) return;

    const timer = window.setTimeout(() => {
      lastEmbeddingSync.current = signature;
      window.ezness?.kbSetConfig?.({ embedding: embeddingTarget });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [settingsLoaded, embeddingTarget]);

  // Chat models come from the providers the user actually connected. The
  // embedding model is indexed and searched, not chatted with, so it stays out.
  const modelOptions = useMemo<ModelOption[]>(() => {
    const options: ModelOption[] = [];
    for (const provider of Object.values(providers)) {
      for (const model of provider.models) {
        const id = joinModelKey(provider.id, model);
        // Embedding-only models are for the knowledge base, not conversation.
        if (id === defaults.embedding || /embed/i.test(model)) continue;
        options.push({
          id,
          label: model,
          hint: provider.name,
          providerId: provider.id,
          providerName: provider.name,
        });
      }
    }
    return options;
  }, [providers, defaults.embedding]);

  const fallbackModel = useMemo(() => {
    if (modelOptions.some((option) => option.id === defaults.chat)) return defaults.chat;
    return modelOptions[0]?.id ?? '';
  }, [modelOptions, defaults.chat]);

  // A default chat model makes the setting page and new sessions agree.
  useEffect(() => {
    if (!settingsLoaded || !fallbackModel) return;
    if (defaults.chat && modelOptions.some((option) => option.id === defaults.chat)) return;
    setDefaults((prev) => ({ ...prev, chat: fallbackModel }));
  }, [settingsLoaded, fallbackModel, modelOptions, defaults.chat]);

  // Sessions created before a model was connected still point at placeholder ids.
  useEffect(() => {
    if (modelOptions.length === 0) return;
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (session.model && modelOptions.some((option) => option.id === session.model)) return session;
        changed = true;
        return { ...session, model: fallbackModel };
      });
      return changed ? next : prev;
    });
  }, [modelOptions, fallbackModel]);

  function flushDeltas() {
    const buffer = deltaBuffer.current;
    if (buffer.timer !== null) {
      window.clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (!buffer.messageId || (!buffer.content && !buffer.thinking)) return;

    const { messageId, content, thinking } = buffer;
    buffer.content = '';
    buffer.thinking = '';

    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: content ? message.content + content : message.content,
              thinking: thinking ? (message.thinking ?? '') + thinking : message.thinking,
            }
          : message,
      ),
    );
  }

  // Stream deltas from the main process into the matching assistant bubble.
  useEffect(() => {
    const unsubscribe = window.ezness?.onChatEvent?.((event: ChatStreamEvent) => {
      const active = streamRef.current;
      if (!active || event.requestId !== active.requestId) return;
      const messageId = active.messageId;

      if (event.type === 'delta' || event.type === 'thinking') {
        if (!event.text) return;
        speedRef.current.tokens += estimateTokens(event.text);
        const buffer = deltaBuffer.current;
        buffer.messageId = messageId;
        if (event.type === 'delta') buffer.content += event.text;
        else buffer.thinking += event.text;
        if (buffer.timer === null) buffer.timer = window.setTimeout(flushDeltas, 50);
        return;
      }

      flushDeltas();
      streamRef.current = null;
      setStreamingId(null);

      // 用户切到了别的会话时，这一轮跑完要留个红点提醒；用户主动停止不算。
      if ((event.type === 'done' || event.type === 'error') && active.sessionId !== activeIdRef.current) {
        setUnreadSessions((prev) =>
          prev.has(active.sessionId) ? prev : new Set(prev).add(active.sessionId),
        );
      }

      if (event.type === 'done') {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId && !message.content.trim()
              ? { ...message, content: tRef.current('app.chat.emptyReply') }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'aborted') {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, stopped: true, content: message.content || tRef.current('app.chat.stopped') }
              : message,
          ),
        );
        return;
      }

      const note = tRef.current('app.chat.requestFailed', {
        error: event.error ?? tRef.current('app.error.unknown'),
      });
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? { ...message, content: message.content ? `${message.content}\n\n${note}` : note }
            : message,
        ),
      );
    });

    return () => unsubscribe?.();
  }, []);

  const activeSession = sessions.find((session) => session.id === activeId);

  // 会话列表的状态圆点：正在生成的会话是绿的；用户没看时跑完的是红的。
  // 普通对话没有权限确认，所以这里不会出现黄色。
  const streamingSessionId = useMemo(
    () =>
      streamingId
        ? messages.find((message) => message.id === streamingId)?.sessionId ?? null
        : null,
    [streamingId, messages],
  );
  const sessionActivity = useMemo(() => {
    const map = new Map<string, ActivityStatus>();
    for (const id of unreadSessions) map.set(id, 'done');
    if (streamingSessionId) map.set(streamingSessionId, 'running');
    return map;
  }, [unreadSessions, streamingSessionId]);
  // Compressed originals stay in `messages` (search and export can still find
  // them) but never reach the transcript view, the ring or the model.
  const activeMessages = useMemo(
    () => messages.filter((message) => message.sessionId === activeId && isVisible(message)),
    [messages, activeId],
  );

  /**
   * The ring follows the provider's own count for the last request — system
   * prompt, tool schemas, knowledge/web context and every message included.
   * Summaries created after that request have not been sent yet, so their
   * saving is subtracted until the next turn reports fresh numbers.
   */
  const activeContextUsed = useMemo(() => {
    const reported = contextTokensFromUsage(usage?.records ?? [], activeId, 'chat');
    if (!reported) return conversationTokens(activeMessages);
    return Math.max(0, reported.used - summarySavingSince(activeMessages, reported.at));
  }, [usage, activeId, activeMessages]);

  /** Every request this conversation spent, for the header stats panel. */
  const activeSessionUsage = useMemo(
    () => (usage?.records ?? []).filter((record) => record.sessionId === activeId),
    [usage, activeId],
  );

  /**
   * Which conversations reference each warehouse file. One entry per session
   * (the latest turn that carried the file), because jumping asks the reader to
   * pick a conversation, not a message. Workspace conversations are included
   * and tagged so the picker can say where each one lives.
   */
  const warehouseUsage = useMemo(() => {
    const byItem = new Map<string, Map<string, WarehouseUsage>>();

    const record = (
      fileId: string,
      key: string,
      make: () => WarehouseUsage,
      at: number,
      messageId: string,
    ) => {
      let perSession = byItem.get(fileId);
      if (!perSession) {
        perSession = new Map();
        byItem.set(fileId, perSession);
      }
      const current = perSession.get(key);
      if (current) {
        // Several turns in one conversation can carry the same file; the
        // jump target stays on the latest one.
        current.count += 1;
        if (at >= current.at) {
          current.messageId = messageId;
          current.at = at;
        }
        return;
      }
      perSession.set(key, make());
    };

    const titles = new Map(sessions.map((session) => [session.id, sessionTitle(session.title, t)]));
    for (const message of messages) {
      if (!message.attachments || message.attachments.length === 0) continue;
      for (const file of message.attachments) {
        record(
          file.id,
          message.sessionId,
          () => ({
            kind: 'chat',
            sessionId: message.sessionId,
            sessionTitle: titles.get(message.sessionId) ?? t('app.session.untitled'),
            messageId: message.id,
            at: message.createdAt,
            count: 1,
          }),
          message.createdAt,
          message.id,
        );
      }
    }

    const chatById = new Map(workspaceLibrary.chats.map((chat) => [chat.id, chat]));
    const workspaceNames = new Map(
      workspaceLibrary.workspaces.map((workspace) => [workspace.id, workspace.name]),
    );
    for (const message of workspaceLibrary.messages) {
      if (!message.attachments || message.attachments.length === 0) continue;
      const chat = chatById.get(message.sessionId);
      if (!chat) continue;
      for (const file of message.attachments) {
        record(
          file.id,
          chat.id,
          () => ({
            kind: 'workspace',
            sessionId: chat.id,
            sessionTitle: chat.title || t('app.session.untitled'),
            workspaceId: chat.workspaceId,
            workspaceName: workspaceNames.get(chat.workspaceId) ?? t('app.workspace.untitled'),
            messageId: message.id,
            at: message.createdAt,
            count: 1,
          }),
          message.createdAt,
          message.id,
        );
      }
    }

    const result: Record<string, WarehouseUsage[]> = {};
    for (const [itemId, perSession] of byItem) {
      result[itemId] = [...perSession.values()].sort((a, b) => b.at - a.at);
    }
    return result;
  }, [messages, sessions, workspaceLibrary, t]);

  function handleJumpToMessage(usage: WarehouseUsage) {
    if (usage.kind === 'workspace' && usage.workspaceId) {
      setView('workspace');
      setWorkspaceFocus({
        workspaceId: usage.workspaceId,
        chatId: usage.sessionId,
        messageId: usage.messageId,
        nonce: Date.now(),
      });
      return;
    }
    setActiveId(usage.sessionId);
    setView('chat');
    setFocusTarget({ messageId: usage.messageId, nonce: Date.now() });
  }

  function handleShowWarehouseFile(id: string) {
    setView('warehouse');
    setWarehouseFocus({ id, nonce: Date.now() });
  }

  function handleOpenToolEditor(category: { id: string; name: string }) {
    setToolEditorFocus({
      categoryId: category.id,
      categoryName: category.name,
      nonce: Date.now(),
    });
    setView('workspace');
  }

  function handleOpenAgentEditor(agent: { id: string; name: string }) {
    setAgentEditorFocus({
      agentId: agent.id,
      agentName: agent.name,
      nonce: Date.now(),
    });
    setView('workspace');
  }

  const activeModel = useMemo(() => {
    if (activeSession && modelOptions.some((option) => option.id === activeSession.model)) {
      return activeSession.model;
    }
    return fallbackModel;
  }, [activeSession, modelOptions, fallbackModel]);

  function updateSession(id: string, patch: Partial<Session>) {
    setSessions((prev) => prev.map((session) => (session.id === id ? { ...session, ...patch } : session)));
  }

  const activeKb = readKb(activeSession, web.defaultMode);
  const activePromptId = activeSession?.promptId ?? null;
  const activePromptVariables = activeSession?.promptVariables ?? EMPTY_PROMPT_VARIABLES;

  function handlePromptChange(promptId: string | null) {
    // Re-picking the current template must not wipe the values just typed.
    if (promptId === activePromptId) return;
    // Switching templates (or turning the prompt off) drops every temporary
    // value; the new template starts from its own saved defaults.
    updateSession(activeId, { promptId, promptVariables: {} });
  }

  function handlePromptVariableChange(name: string, value: string) {
    updateSession(activeId, {
      promptVariables: { ...(activeSession?.promptVariables ?? {}), [name]: value },
    });
  }

  function handleKbChange(patch: Partial<KbChatSettings>) {
    const next = { ...activeKb, ...patch };
    // 「知识库 + 联网补充」必须留一条联网通道：把关闭改成自动，由 AI 判断
    // 什么时候真的需要联网。反过来，关掉联网时这个模式也就不成立了。
    // Turning 联网 off while on 「知识库 + 联网补充」 drops that mode; choosing
    // that mode while 联网 is off raises the web mode to 自动 instead.
    if (patch.webMode === 'off' && next.mode === 'web') next.mode = 'balanced';
    if (next.mode === 'web' && next.webMode === 'off') next.webMode = 'auto';
    updateSession(activeId, { kb: next });
  }

  /** The model a session talks to, falling back to the app default. */
  function modelForSession(session: Session | undefined): string {
    if (session && modelOptions.some((option) => option.id === session.model)) {
      return session.model;
    }
    return fallbackModel;
  }

  /**
   * Fold everything older than the keep window into one summary card. Runs on
   * the conversation's model but as a separate activation (own request id and
   * abort handle); nothing is written until the whole summary succeeds.
   */
  async function handleCompress(sessionId: string) {
    if (compressingId) return;
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (streamingId !== null && sessionId === activeId) {
      setCompressionError({ sessionId, message: t('app.compression.wait') });
      return;
    }

    const target = resolveTarget(modelForSession(session));
    if (!target) {
      setCompressionError({ sessionId, message: t('app.compression.noModelReady') });
      return;
    }
    target.sessionId = sessionId;

    const all = messages.filter((message) => message.sessionId === sessionId);
    const selected = selectCompressible(all, work.compressionKeepTurns);
    if (selected.length < 2) {
      setCompressionError({ sessionId, message: t('app.compression.tooFew') });
      return;
    }

    const token: CompressionToken = { canceled: false, abort: null };
    compressionToken.current = token;
    setCompressingId(sessionId);
    setCompressionError(null);
    setCompressionStep({ sessionId, step: 1, total: 1, phase: 'map' });

    try {
      const result = await compressConversation({
        target,
        messages: selected,
        token,
        onProgress: (progress) => setCompressionStep({ sessionId, ...progress }),
        t,
      });
      if (token.canceled) return;

      const summaryId = uid();
      const summary: CompressionInfo = {
        count: result.count,
        tokensBefore: result.tokensBefore,
        tokensAfter: estimateTokens(result.summary),
        messageIds: selected.map((message) => message.id),
      };
      const card: Message = {
        id: summaryId,
        sessionId,
        role: 'assistant',
        content: result.summary,
        summary,
        createdAt: Date.now(),
      };

      setMessages((prev) => {
        const at = prev.findIndex((message) => message.id === selected[0].id);
        const ids = new Set(selected.map((message) => message.id));
        const patched = prev.map((message) =>
          ids.has(message.id) ? { ...message, hiddenBy: summaryId } : message,
        );
        if (at === -1) return [...patched, card];
        return [...patched.slice(0, at), card, ...patched.slice(at)];
      });
      updateSession(sessionId, { updatedAt: Date.now() });
    } catch (error) {
      if (!token.canceled) {
        setCompressionError({
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (compressionToken.current === token) compressionToken.current = null;
      setCompressingId(null);
      setCompressionStep(null);
    }
  }

  function handleCancelCompression() {
    const token = compressionToken.current;
    if (!token) return;
    token.canceled = true;
    token.abort?.();
  }

  /** Restore the messages a summary card replaced. Nothing was ever deleted. */
  function handleUndoCompression(sessionId: string, summaryId: string) {
    // Undo must stick: without this the auto trigger would immediately fold the
    // same block again, making the button useless. A new message changes the
    // signature, so automatic compression can still kick in later.
    const restored = messages
      .filter((message) => message.sessionId === sessionId && message.id !== summaryId)
      .map((message) =>
        message.hiddenBy === summaryId ? { ...message, hiddenBy: undefined } : message,
      )
      .filter(isVisible);
    autoCompressGuard.current = `${sessionId}:${restored.length}:${conversationTokens(restored)}`;

    setMessages((prev) =>
      prev
        .filter((message) => message.id !== summaryId)
        .map((message) => {
          if (message.hiddenBy !== summaryId) return message;
          const next = { ...message };
          delete next.hiddenBy;
          return next;
        }),
    );
    updateSession(sessionId, { updatedAt: Date.now() });
  }

  // Effects call through a ref so they do not depend on a new handler identity
  // on every render.
  compressHandlerRef.current = handleCompress;

  // Nearing the window triggers compression on its own, once per over-limit
  // state; a failed attempt is not retried until the conversation changes. The
  // trigger uses the same number the ring shows (provider-reported once a
  // request exists), so "90%" means the same thing in both places.
  useEffect(() => {
    if (!settingsLoaded || !activeSession) return;
    const used = activeContextUsed;
    if (used < work.contextLimit * 0.9) {
      autoCompressGuard.current = null;
      return;
    }
    if (streamingId !== null || compressingId !== null) return;

    const selected = selectCompressible(
      messages.filter((message) => message.sessionId === activeId),
      work.compressionKeepTurns,
    );
    if (selected.length < 2) return;

    const signature = `${activeId}:${activeMessages.length}:${used}`;
    if (autoCompressGuard.current === signature) return;
    autoCompressGuard.current = signature;
    compressHandlerRef.current(activeId);
  }, [
    settingsLoaded,
    activeSession,
    activeId,
    activeMessages,
    activeContextUsed,
    messages,
    streamingId,
    compressingId,
    work.contextLimit,
    work.compressionKeepTurns,
  ]);

  function resolveTarget(modelKey: string): ChatTarget | null {
    const parts = splitModelKey(modelKey);
    if (!parts) return null;
    const provider = providers[parts.providerId];
    if (!provider?.baseUrl) return null;
    return {
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: parts.model,
      providerId: provider.id,
      providerName: provider.name,
    };
  }

  async function handleSend(text: string, attachments: WarehouseItem[] = []) {
    const timestamp = Date.now();
    const sessionId = activeId;
    const api = window.ezness;
    const kb = readKb(activeSession, web.defaultMode);
    // 「知识库 + 联网补充」不能完全没有联网通道；其余情况完全听会话设置。
    const webMode: WebMode =
      kb.mode === 'web' && kb.webMode === 'off' ? 'auto' : kb.webMode;
    const webActive = webMode !== 'off';

    // A template picked in the composer shapes this turn: 系统指令 becomes an
    // extra system message, 包装消息 wraps the user's text inside the template.
    let userText = text;
    let promptSystem = '';
    if (activePromptId && api) {
      const templates = (await api.promptsLoad?.()) ?? [];
      const template = templates.find((item) => item.id === activePromptId);
      const overrides = activePromptVariables;
      const variables = (template?.variables ?? []).map((variable) =>
        overrides[variable.name] !== undefined
          ? { name: variable.name, value: overrides[variable.name] }
          : variable,
      );
      const rendered = template ? renderPrompt(template.body, variables).trim() : '';
      if (rendered) {
        if (template?.wrap) userText = `${rendered}\n\n${text}`;
        else promptSystem = rendered;
      }
    }

    // Attachments are read from the warehouse and folded into the user turn,
    // so the model sees the file text before the question. The same text is
    // kept on the message and replayed in later turns.
    let attachmentContext = '';
    if (attachments.length > 0 && api) {
      try {
        const reads = await api.warehouseReadText(
          attachments.map((item) => item.id),
          { enabled: ocr.enabled, pdf: ocr.pdf, maxPages: ocr.maxPages },
        );
        attachmentContext = buildAttachmentContext(reads ?? []);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        attachmentContext = `用户附带了文件，但读取失败：${detail}`;
      }
      if (attachmentContext) {
        userText = [attachmentContext, userText].filter(Boolean).join('\n\n');
      }
    }

    const history: ChatTurn[] = [
      ...messages
        .filter((message) => message.sessionId === sessionId && isVisible(message))
        .map((message) => ({
          role: message.role,
          content: message.summary
            ? `【对话摘要 · 已压缩 ${message.summary.count} 条较早消息】\n${message.content}`
            : message.role === 'user' && message.attachmentContext
              ? `${message.attachmentContext}\n\n${message.content}`
              : message.content,
        })),
      { role: 'user', content: userText },
    ];

    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        sessionId,
        role: 'user',
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        attachmentContext: attachmentContext || undefined,
        createdAt: timestamp,
      },
    ]);

    const patch: Partial<Session> = { updatedAt: timestamp };
    if (isDefaultTitle(activeSession?.title)) {
      const title = text.trim() || attachments[0]?.name || '';
      if (title) patch.title = title.slice(0, 24);
    }
    updateSession(sessionId, patch);

    // A turn still waiting on retrieval has no chat request to abort yet. Mark
    // it canceled so its judge/search cannot open a second stream under the new
    // turn once the network answers.
    const stalled = retrievalRef.current;
    if (stalled) {
      stalled.canceled = true;
      if (stalled.judgeRequestId) {
        void api?.chatAbort?.(stalled.judgeRequestId);
      }
      retrievalRef.current = null;
      setMessages((prev) =>
        prev.map((message) =>
          message.id === stalled.messageId
            ? { ...message, stopped: true, content: message.content || tRef.current('app.chat.stopped') }
            : message,
        ),
      );
    }

    // One stream at a time: close the previous one before opening a new bubble.
    const previous = streamRef.current;
    if (previous) {
      streamRef.current = null;
      void api?.chatAbort?.(previous.requestId);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === previous.messageId
            ? { ...message, stopped: true, content: message.content || tRef.current('app.chat.stopped') }
            : message,
        ),
      );
    }

    // Open the answer bubble right away so the user sees progress during
    // retrieval, not a silent gap.
    const assistantId = uid();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, sessionId, role: 'assistant', content: '', createdAt: Date.now() },
    ]);
    setStreamingId(assistantId);
    setStreamPhase(kb.enabled || webActive ? 'retrieving' : 'generating');
    speedRef.current = { tokens: 0, sampled: 0, sampledAt: Date.now() };
    setStreamSpeed(null);

    const fail = (content: string) => {
      setMessages((prev) =>
        prev.map((message) => (message.id === assistantId ? { ...message, content } : message)),
      );
      setStreamingId(null);
    };

    if (!api) {
      fail(t('app.error.desktopChatOnly'));
      return;
    }

    const target = resolveTarget(activeModel);
    if (!target) {
      fail(t('app.error.noModel'));
      return;
    }
    target.sessionId = sessionId;

    // Retrieve before the request goes out, so the model already has the
    // excerpts as a system message when the stream starts.
    let systemPrompt = '';
    let sources: string[] = [];
    let citations: CitationLink[] = [];

    if (kb.enabled || webActive) {
      const retrieval: {
        messageId: string;
        canceled: boolean;
        judgeRequestId?: string;
      } = { messageId: assistantId, canceled: false };
      retrievalRef.current = retrieval;

      try {
        let hits: KbSearchHit[] = [];
        let note: string | null = null;
        let categoryName: string | null = null;

        if (kb.enabled) {
          const snapshot = await api.kbSnapshot();
          if (retrieval.canceled) return;
          categoryName = kb.categoryId
            ? snapshot.categories.find((category) => category.id === kb.categoryId)?.name ?? '已删除的分类'
            : null;

          const search = await api.kbSearch(text, { categoryId: kb.categoryId });
          if (retrieval.canceled) return;
          hits = (search.results ?? []).slice(0, 6);
          note = search.note ?? null;
        }

        // Independent of the knowledge base: web search runs against every
        // enabled 网络入口 in parallel. 总是 searches right away; 自动 asks the
        // model first and only pays for a search when the answer needs fresh
        // facts. Greetings and follow-ups are handled by a local rule inside
        // the judge, so they cost nothing at all.
        let webContext: RagContext['web'] = null;
        const entries = web.entries.filter((entry) => entry.enabled);
        let searchQuery = text;
        let shouldSearch = webMode === 'always';

        if (webMode === 'auto') {
          if (entries.length === 0) {
            shouldSearch = false;
          } else if (typeof api.webJudge === 'function') {
            const judgeRequestId = uid();
            retrieval.judgeRequestId = judgeRequestId;
            try {
              const decision = await api.webJudge({
                requestId: judgeRequestId,
                provider: target,
                text,
                recent: history
                  .slice(0, -1)
                  .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
                  .slice(-6)
                  .map((turn) => ({
                    role: turn.role as 'user' | 'assistant',
                    content: turn.content.slice(0, 600),
                  })),
              });
              if (decision.aborted || retrieval.canceled) return;
              shouldSearch = decision.search !== false;
              if (decision.query?.trim()) searchQuery = decision.query.trim();
            } catch {
              // The judge failed (timeout, network): search rather than
              // silently dropping the user's 联网 setting.
              shouldSearch = true;
            } finally {
              retrieval.judgeRequestId = undefined;
            }
          } else {
            // Older preload without the judge: keep the old behaviour.
            shouldSearch = true;
          }
          if (retrieval.canceled) return;
        }

        if (shouldSearch) {
          webContext = (await api.webSearch(searchQuery, entries)) ?? {
            ok: false,
            error: t('app.error.webUnavailable'),
          };
          if (retrieval.canceled) return;
        }

        systemPrompt = kb.enabled
          ? buildRagSystemPrompt({ hits, mode: kb.mode, categoryName, note, web: webContext })
          : buildWebSystemPrompt(webContext);
        sources = collectSources(hits, webContext);
        citations = collectCitations(hits, webContext, t);
      } catch {
        // Retrieval failure is a technical detail, not part of the answer.
        // Answer from the model's own knowledge instead of injecting a
        // 「本次联网失败」 disclaimer the user never asked about.
        systemPrompt = '';
      } finally {
        if (retrievalRef.current === retrieval) retrievalRef.current = null;
      }

      if (retrieval.canceled) return;
      setStreamPhase('generating');
    }

    const systemParts = [promptSystem, systemPrompt].filter(Boolean);
    if (systemParts.length > 0) {
      history.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }

    if (sources.length > 0 || citations.length > 0) {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, sources, citations } : message,
        ),
      );
    }

    const requestId = uid();
    streamRef.current = { requestId, messageId: assistantId, sessionId };

    await api.chatSend({ requestId, provider: target, messages: history, feature: 'chat' });
  }

  function handleStop() {
    const active = streamRef.current;
    if (active) {
      void window.ezness?.chatAbort?.(active.requestId);
      return;
    }

    // Still retrieving: cancel the turn locally, there is no request to abort.
    const retrieval = retrievalRef.current;
    if (!retrieval) return;
    retrieval.canceled = true;
    if (retrieval.judgeRequestId) {
      void window.ezness?.chatAbort?.(retrieval.judgeRequestId);
    }
    retrievalRef.current = null;
    setStreamingId(null);
    setStreamPhase('generating');
    setMessages((prev) =>
      prev.map((message) =>
        message.id === retrieval.messageId
          ? { ...message, stopped: true, content: message.content || tRef.current('app.chat.stopped') }
          : message,
      ),
    );
  }

  /**
   * 重新加载：主进程按磁盘重读所有功能定义，然后整窗刷新——和手动重启一样，
   * 但不用关掉窗口。生成中的回答会被打断，所以按钮在生成期间是禁用的。
   */
  const canReload = streamingId === null && compressingId === null && !reloading;

  async function handleReload() {
    if (!canReload) return;
    setReloading(true);
    const result = await window.ezness?.reloadRuntime?.().catch(() => null);
    if (result && !result.ok) {
      setReloading(false);
      window.alert(
        t('app.reload.failed', { error: result.error ?? t('app.error.unknown') }),
      );
      return;
    }
    // The main process now holds the fresh definitions; remounting the window
    // re-reads settings, chats and every page from it.
    window.location.reload();
  }

  function handleRenameSession(id: string, title: string) {
    updateSession(id, { title });
  }

  async function handleExportSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;

    const label =
      modelOptions.find((option) => option.id === session.model)?.label ??
      t('app.export.unspecifiedModel');
    const result = await window.ezness?.exportSession?.({
      title: sessionTitle(session.title, t) || t('app.export.untitledSession'),
      markdown: buildSessionMarkdown(session, messages, label, { t, locale }),
    });

    if (result && !result.ok && !result.canceled) {
      window.alert(t('app.export.failed', { error: result.error ?? t('app.error.unknown') }));
    }
  }

  /** Delete one or many sessions and keep exactly one conversation on screen. */
  function removeSessions(ids: string[]) {
    if (ids.length === 0) return;
    const removed = new Set(ids);

    if (streamRef.current && removed.has(activeId)) {
      void window.ezness?.chatAbort?.(streamRef.current.requestId);
      streamRef.current = null;
      setStreamingId(null);
    }

    setMessages((prev) => prev.filter((message) => !removed.has(message.sessionId)));

    const rest = sessions.filter((item) => !removed.has(item.id));
    if (rest.length === 0) {
      const fresh: Session = {
        id: uid(),
        title: t('app.session.defaultTitle'),
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      setSessions([fresh]);
      setActiveId(fresh.id);
      return;
    }

    setSessions(rest);
    if (removed.has(activeId)) setActiveId(rest[0].id);
  }

  function handleDeleteSession(id: string) {
    const target = sessions.find((item) => item.id === id);
    if (!window.confirm(t('app.confirm.deleteSession', { title: sessionTitle(target?.title, t) }))) return;
    removeSessions([id]);
  }

  function handleNew() {
    const id = uid();
    setSessions((prev) => [
      {
        id,
        title: t('app.session.defaultTitle'),
        updatedAt: Date.now(),
        model: fallbackModel,
      },
      ...prev,
    ]);
    setActiveId(id);
    setQuery('');
    setView('chat');
  }

  function handleProviderChange(id: string, patch: Partial<ProviderConfig>) {
    setProviders((prev) => {
      const current = prev[id] ?? {
        id,
        name: id,
        apiType: 'openai' as const,
        baseUrl: '',
        apiKey: '',
        models: [],
      };
      return { ...prev, [id]: { ...current, ...patch, id } };
    });
  }

  function handleProviderRemove(id: string) {
    setProviders((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // 默认模型不能再指向一个已经删掉的接入。
    setDefaults((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next) as DefaultsKey[]) {
        if (String(next[key]).startsWith(`${id}::`)) next[key] = '';
      }
      return next;
    });
  }

  function handleDefaultChange(key: DefaultsKey, value: string) {
    setDefaults((prev) => ({ ...prev, [key]: value }));
  }

  function handleVoiceChange(patch: Partial<VoiceSettings>) {
    setVoice((prev) => ({ ...prev, ...patch }));
  }

  function handleOcrChange(patch: Partial<OcrSettings>) {
    setOcr((prev) => ({ ...prev, ...patch }));
  }

  const compressionBusy = compressingId === activeId;
  const compressionProgressLabel =
    compressionStep && compressionStep.sessionId === activeId
      ? compressionStep.phase === 'reduce'
        ? t('app.compression.merging', {
            step: compressionStep.step,
            total: compressionStep.total,
          })
        : t('app.compression.mapping', {
            step: compressionStep.step,
            total: compressionStep.total,
          })
      : null;
  const compressionErrorText =
    compressionError && compressionError.sessionId === activeId ? compressionError.message : null;
  const compressionDisabledReason = (() => {
    if (compressionBusy) return null;
    if (streamingId !== null) return t('app.compression.wait');
    if (!resolveTarget(activeModel)) return t('app.compression.noModel');
    const older = selectCompressible(
      messages.filter((message) => message.sessionId === activeId),
      work.compressionKeepTurns,
    );
    return older.length < 2 ? t('app.compression.tooFew') : null;
  })();

  return (
    <div className="app">
      <TitleBar />

        <div className="workspace">
          <RailNav
            active={view}
            onChange={setView}
            theme={theme}
            onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            usageToday={usage?.today ?? null}
            rmbAnimation={rmbAnimation}
            coinKey={coinKey}
            onReload={canReload ? handleReload : null}
            reloading={reloading}
          />

          <ViewSlot active={view === 'chat'}>
            <Sidebar
              sessions={sessions}
              messages={messages}
              activeId={activeId}
              query={query}
              modelLabel={modelOptions.find((option) => option.id === activeModel)?.label ?? ''}
              onQuery={setQuery}
              onSelect={setActiveId}
              onNew={handleNew}
              onRename={handleRenameSession}
              onDelete={handleDeleteSession}
              onDeleteMany={removeSessions}
              onExport={(id) => void handleExportSession(id)}
              onPin={(id, pinned) => updateSession(id, { pinned })}
              activity={sessionActivity}
            />
            <ChatView
              session={activeSession}
              messages={activeMessages}
              models={modelOptions}
              model={activeModel}
              kb={activeKb}
              promptId={activePromptId}
              promptVariables={activePromptVariables}
              streamingId={streamingId}
              phase={streamPhase}
              speed={streamSpeed}
              voice={voice}
              contextLimit={work.contextLimit}
              contextUsed={activeContextUsed}
              sessionUsage={activeSessionUsage}
              focus={focusTarget}
              onModelChange={(model) => updateSession(activeId, { model })}
              onKbChange={handleKbChange}
              onPromptChange={handlePromptChange}
              onPromptVariableChange={handlePromptVariableChange}
              onSend={handleSend}
              onStop={handleStop}
              onConfigure={() => setView('settings')}
              onShowWarehouse={handleShowWarehouseFile}
              compressionKeepTurns={work.compressionKeepTurns}
              compressing={compressionBusy}
              compressionProgress={compressionProgressLabel}
              compressionError={compressionErrorText}
              compressionDisabledReason={compressionDisabledReason}
              onCompress={() => void handleCompress(activeId)}
              onCancelCompress={handleCancelCompression}
              onUndoCompression={(summaryId) => handleUndoCompression(activeId, summaryId)}
            />
          </ViewSlot>

          <ViewSlot active={view === 'workspace'}>
            <WorkspacePage
              models={modelOptions}
              fallbackModel={fallbackModel}
              voice={voice}
              ocr={ocr}
              web={web}
              work={work}
              usage={usage?.records ?? []}
              onConfigure={() => setView('settings')}
              onShowWarehouse={handleShowWarehouseFile}
              resolveTarget={resolveTarget}
              onLibraryChange={setWorkspaceLibrary}
              focus={workspaceFocus}
              toolEditorFocus={toolEditorFocus}
              agentEditorFocus={agentEditorFocus}
            />
          </ViewSlot>

          <ViewSlot active={view === 'billing'}>
            <BillingPage
              records={usage?.records ?? []}
              fxRate={usage?.fxRate ?? DEFAULT_FX_RATE}
              onClear={async () => {
                const snapshot = await window.ezness?.usageClear?.();
                if (snapshot) setUsage(snapshot);
              }}
            />
          </ViewSlot>

          <ViewSlot active={view === 'settings'}>
            <SettingsPage
              providers={providers}
              onProviderChange={handleProviderChange}
              onProviderRemove={handleProviderRemove}
              defaults={defaults}
              onDefaultChange={handleDefaultChange}
              voice={voice}
              onVoiceChange={handleVoiceChange}
              ocr={ocr}
              onOcrChange={handleOcrChange}
              web={web}
              onWebChange={setWeb}
              proxy={proxy}
              onProxyChange={setProxy}
              work={work}
              onWorkChange={setWork}
              rmbAnimation={rmbAnimation}
              onRmbAnimationChange={setRmbAnimation}
              closeAction={closeAction}
              onCloseActionChange={(action) => {
                setCloseAction(action);
                // Take effect before the debounced settings.json write lands.
                void window.ezness?.setCloseAction?.(action);
              }}
            />
          </ViewSlot>

          <ViewSlot active={view === 'knowledge'}>
            <KnowledgePage />
          </ViewSlot>

          <ViewSlot active={view === 'warehouse'}>
            <WarehousePage
              usage={warehouseUsage}
              onJump={handleJumpToMessage}
              focus={warehouseFocus}
            />

          </ViewSlot>

          <ViewSlot active={view === 'assistants'}>
            <PromptsPage translationTarget={translationTarget} />
          </ViewSlot>

          <ViewSlot active={view === 'sensory'}>
            <SensoryPage
              aiTarget={resolveTarget(fallbackModel)}
              active={view === 'sensory'}
              onOpenToolEditor={handleOpenToolEditor}
            />
          </ViewSlot>

          <ViewSlot active={view === 'agent'}>
            <AgentPage
              active={view === 'agent'}
              onOpenAgentEditor={handleOpenAgentEditor}
              reviewTarget={resolveTarget(fallbackModel)}
            />
          </ViewSlot>
        </div>
    </div>
  );
}
