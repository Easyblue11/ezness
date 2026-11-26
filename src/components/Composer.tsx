import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentDefinition,
  KbCategory,
  KbChatMode,
  KbChatSettings,
  ModelOption,
  PermissionMode,
  PromptTemplate,
  VoiceSettings,
  WarehouseItem,
  WebMode,
  WorkspaceDataAccess,
} from '../types';
import { useI18n } from '../i18n';
import { formatDateTime } from '../lib/time';
import { startVoiceCapture, toInt16, type VoiceCaptureHandle } from '../lib/voiceCapture';
import { parseWarehouseRef } from '../lib/warehouseRef';
import {
  BookIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  GlobeIcon,
  MicIcon,
  SendIcon,
  SparkleIcon,
  StopIcon,
  UploadIcon,
  WarehouseIcon,
} from './Icons';
import { ContextRing, type CompressionUi } from './ContextRing';
import { WebModeSlider } from './WebModeSlider';

type VoiceState = 'idle' | 'starting' | 'listening' | 'stopping';

interface Props {
  models: ModelOption[];
  model: string;
  kb: KbChatSettings;
  promptId: string | null;
  promptVariables: Record<string, string>;
  streaming: boolean;
  speed: number | null;
  voice: VoiceSettings;
  /** Estimated tokens this conversation already holds, and the window to measure against. */
  context?: { used: number; limit: number };
  /** Clicking the ring folds older turns into a summary. */
  compression?: CompressionUi;
  /** Workspace conversations: model, warehouse and web only. */
  compact?: boolean;
  /** Workspace agent: how much the agent may do without asking. */
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Workspace only: Agents that can be enabled for this task. */
  agents?: AgentDefinition[];
  /** Workspace only: the Agent currently enabled for this task. */
  agentId?: string | null;
  onAgentChange?: (agent: AgentDefinition | null) => void;
  /** Refresh the Agent list when the picker opens. */
  onRefreshAgents?: () => void;
  /** Workspace only: which personal data sources this task may read. */
  dataAccess?: WorkspaceDataAccess;
  onDataAccessChange?: (next: WorkspaceDataAccess) => void;
  onModelChange: (id: string) => void;
  onKbChange: (patch: Partial<KbChatSettings>) => void;
  onPromptChange: (id: string | null) => void;
  onPromptVariableChange: (name: string, value: string) => void;
  onSend: (text: string, attachments?: WarehouseItem[]) => void;
  onStop: () => void;
  onConfigure: () => void;
  /** 总监对话：用户正在输入时，总监先别说话。 */
  onTyping?: (active: boolean) => void;
}

const MODES: { key: KbChatMode; titleKey: string; descKey: string }[] = [
  { key: 'strict', titleKey: 'composer.mode.strict.title', descKey: 'composer.mode.strict.desc' },
  { key: 'balanced', titleKey: 'composer.mode.balanced.title', descKey: 'composer.mode.balanced.desc' },
  { key: 'web', titleKey: 'composer.mode.web.title', descKey: 'composer.mode.web.desc' },
];

const MODE_LABEL: Record<KbChatMode, string> = {
  strict: 'composer.modeLabel.strict',
  balanced: 'composer.modeLabel.balanced',
  web: 'composer.modeLabel.web',
};

/** Agent permission ceiling. The hovered row explains what it allows. */
const PERM_MODES: { key: PermissionMode; labelKey: string; descKey: string }[] = [
  {
    key: 'read-only',
    labelKey: 'composer.perm.readOnly.label',
    descKey: 'composer.perm.readOnly.desc',
  },
  {
    key: 'plan',
    labelKey: 'composer.perm.plan.label',
    descKey: 'composer.perm.plan.desc',
  },
  {
    key: 'workspace-write',
    labelKey: 'composer.perm.workspaceWrite.label',
    descKey: 'composer.perm.workspaceWrite.desc',
  },
  {
    key: 'danger-full-access',
    labelKey: 'composer.perm.fullAccess.label',
    descKey: 'composer.perm.fullAccess.desc',
  },
];

const WEB_MODE_KEYS: Record<WebMode, string> = {
  off: 'composer.web.mode.off',
  auto: 'composer.web.mode.auto',
  always: 'composer.web.mode.always',
};

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function extLabel(ext: string): string {
  const label = (ext || 'file').toUpperCase();
  return label.length > 4 ? label.slice(0, 4) : label;
}

export function Composer({
  models,
  model,
  kb,
  promptId,
  promptVariables,
  streaming,
  speed,
  voice,
  context,
  compression,
  compact = false,
  permissionMode,
  onPermissionModeChange,
  agents,
  agentId = null,
  onAgentChange,
  onRefreshAgents,
  dataAccess,
  onDataAccessChange,
  onModelChange,
  onKbChange,
  onPromptChange,
  onPromptVariableChange,
  onSend,
  onStop,
  onConfigure,
  onTyping,
}: Props) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptQuery, setPromptQuery] = useState('');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [categories, setCategories] = useState<KbCategory[]>([]);
  const [docCount, setDocCount] = useState<number | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [catQuery, setCatQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const publishComposerHeight = useRef<() => void>(() => undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const kbRef = useRef<HTMLDivElement>(null);
  const webRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const captureRef = useRef<VoiceCaptureHandle | null>(null);
  const ignoreTranscript = useRef(false);
  // Files dropped or pasted into the composer. They are copied into the
  // warehouse right away, so the chips are just handles to stored items.
  const [attachments, setAttachments] = useState<WarehouseItem[]>([]);
  // Duplicates resolved to files that already sat in the warehouse. Removing
  // such a chip must not delete the original copy from the warehouse.
  const reusedAttachments = useRef<Set<string>>(new Set());
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);

  // Warehouse picker: selections are kept by id, so changing the search filter
  // never clears what the user ticked; they only leave via「取消」or confirm.
  const [whOpen, setWhOpen] = useState(false);
  const [whItems, setWhItems] = useState<WarehouseItem[]>([]);
  const [whQuery, setWhQuery] = useState('');
  const [whSelected, setWhSelected] = useState<Set<string>>(new Set());
  const whRef = useRef<HTMLDivElement>(null);

  // Workspace data access: activation is opt-in and never sends anything by
  // itself. The warehouse toggle picks no files; the agent looks them up.
  const [dataOpen, setDataOpen] = useState(false);
  const dataRef = useRef<HTMLDivElement>(null);

  // Agent controls live in the composer next to the model chip. The permission
  // menu explains the hovered mode instead of a static tooltip.
  const [permOpen, setPermOpen] = useState(false);
  const [permHover, setPermHover] = useState<PermissionMode>('workspace-write');
  const permRef = useRef<HTMLDivElement>(null);
  // Agent picker: choosing one enables it for this task (and for the Agent
  // itself if it was still a disabled draft).
  const [agentOpen, setAgentOpen] = useState(false);
  const agentRef = useRef<HTMLDivElement>(null);

  const mode = permissionMode ?? 'workspace-write';
  const permInfo = PERM_MODES.find((item) => item.key === mode) ?? PERM_MODES[2];
  const hoverInfo = PERM_MODES.find((item) => item.key === permHover) ?? permInfo;
  const activeAgent = (agents ?? []).find((agent) => agent.id === agentId) ?? null;

  const current = models.find((item) => item.id === model) ?? null;

  // Models grouped under their provider so the picker shows where each one
  // comes from instead of one long unlabeled list.
  const modelGroups = useMemo(() => {
    const groups: { id: string; name: string; items: ModelOption[] }[] = [];
    for (const item of models) {
      const key = item.providerId || item.providerName || 'other';
      let group = groups.find((entry) => entry.id === key);
      if (!group) {
        group = { id: key, name: item.providerName || item.hint || key, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }, [models]);
  const categoryName = kb.categoryId
    ? categories.find((item) => item.id === kb.categoryId)?.name ?? t('composer.category.deleted')
    : t('composer.category.all');

  const catKeyword = catQuery.trim().toLowerCase();
  const catMatches = categories.filter((category) =>
    category.name.toLowerCase().includes(catKeyword),
  );
  const showsAll = t('composer.category.all').includes(catKeyword);

  function chooseCategory(id: string | null) {
    onKbChange({ categoryId: id });
    setCatOpen(false);
    setCatQuery('');
  }

  const dataKbIds = dataAccess?.kb?.categoryIds ?? [];
  const dataKbOn = Boolean(dataAccess?.kb?.enabled);
  const dataActive = dataKbOn && dataKbIds.length > 0;
  const dataBadge = dataKbOn ? dataKbIds.length : 0;

  function patchDataAccess(next: WorkspaceDataAccess) {
    onDataAccessChange?.(next);
  }

  function toggleDataKb() {
    patchDataAccess({
      ...dataAccess,
      kb: { enabled: !dataKbOn, categoryIds: dataKbIds },
    });
  }

  function toggleDataCategory(id: string) {
    const next = dataKbIds.includes(id)
      ? dataKbIds.filter((item) => item !== id)
      : [...dataKbIds, id];
    patchDataAccess({ ...dataAccess, kb: { enabled: true, categoryIds: next } });
  }

  function toggleDataWarehouse() {
    patchDataAccess({ ...dataAccess, warehouse: !dataAccess?.warehouse });
  }

  const whKeyword = whQuery.trim().toLowerCase();
  const whMatches = useMemo(
    () =>
      whKeyword
        ? whItems.filter(
            (item) =>
              item.name.toLowerCase().includes(whKeyword) ||
              item.ext.toLowerCase().includes(whKeyword),
          )
        : whItems,
    [whItems, whKeyword],
  );

  function toggleWarehouseItem(id: string) {
    setWhSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmWarehousePick() {
    const picked = whItems.filter((item) => whSelected.has(item.id));
    if (picked.length > 0) {
      // These are warehouse originals, not new uploads: removing a chip must
      // not delete them from the warehouse.
      picked.forEach((item) => reusedAttachments.current.add(item.id));
      setAttachments((prev) => {
        const seen = new Set(prev.map((entry) => entry.id));
        return [...prev, ...picked.filter((item) => !seen.has(item.id))];
      });
    }
    setWhSelected(new Set());
    setWhQuery('');
    setWhOpen(false);
    setAttachError(null);
  }

  const selectedPrompt = templates.find((template) => template.id === promptId) ?? null;
  const promptKeyword = promptQuery.trim().toLowerCase();
  const promptMatches = promptKeyword
    ? templates.filter(
        (template) =>
          template.name.toLowerCase().includes(promptKeyword) ||
          template.description.toLowerCase().includes(promptKeyword) ||
          template.tags.some((tag) => tag.toLowerCase().includes(promptKeyword)),
      )
    : templates;

  const loadTemplates = useCallback(async () => {
    const loaded = await window.ezness?.promptsLoad?.();
    if (loaded) setTemplates(loaded);
  }, []);

  // Read once so a session's selected template shows its name right away, and
  // again whenever the picker opens in case the library changed meanwhile.
  useEffect(() => {
    if (compact) return;
    void loadTemplates();
  }, [compact, loadTemplates]);

  useEffect(() => {
    if (promptOpen) void loadTemplates();
  }, [promptOpen, loadTemplates]);

  function choosePrompt(id: string | null) {
    onPromptChange(id);
    setPromptQuery('');
    // A template keeps the panel open so its temporary parameters can be set
    // right away; turning the prompt off leaves nothing to configure.
    if (!id) setPromptOpen(false);
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    publishComposerHeight.current();
  }, [value]);

  // The composer floats over the transcript, so its height is published as a
  // CSS variable that the scroll box reserves as bottom padding. Only real size
  // changes (a new line, an attachment strip) reach it — typing inside one line
  // does not — so the conversation is never re-laid-out on a keystroke.
  useEffect(() => {
    const el = rootRef.current;
    const host = el?.closest('.chat') as HTMLElement | null;
    const slot = el?.closest('.view-slot') as HTMLElement | null;
    if (!el || !host) return;
    let last = -1;
    const publish = () => {
      const height = el.getBoundingClientRect().height;
      // A view that is not on screen has no box; keep the last real value.
      if (height <= 0) return;
      const next = Math.round(height);
      if (next === last) return;
      const scroll = host.querySelector('.chat__body') as HTMLElement | null;
      // Growing the reserved space pushes the transcript up; if the reader was
      // at the bottom, move with it so the newest message stays visible.
      const pinned = scroll
        ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48
        : false;
      last = next;
      host.style.setProperty('--composer-h', `${next}px`);
      if (pinned && scroll) scroll.scrollTop = scroll.scrollHeight;
    };
    publishComposerHeight.current = publish;
    publish();
    // ResizeObserver alone is not enough: this view may finish mounting while
    // its slot is still hidden, and a hidden window does not deliver resize
    // notifications at all. The slot's class change is what makes it visible.
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    const reveal = new MutationObserver(publish);
    if (slot) reveal.observe(slot, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      reveal.disconnect();
      publishComposerHeight.current = () => undefined;
      host.style.removeProperty('--composer-h');
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!kbOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (kbRef.current && !kbRef.current.contains(event.target as Node)) setKbOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setKbOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [kbOpen]);

  useEffect(() => {
    if (!webOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (webRef.current && !webRef.current.contains(event.target as Node)) setWebOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWebOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [webOpen]);

  useEffect(() => {
    if (!promptOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (promptRef.current && !promptRef.current.contains(event.target as Node)) {
        setPromptOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPromptOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [promptOpen]);

  useEffect(() => {
    if (!permOpen) return;
    const onDown = (event: MouseEvent) => {
      if (permRef.current && !permRef.current.contains(event.target as Node)) setPermOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPermOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [permOpen]);

  useEffect(() => {
    if (!agentOpen) return;
    const onDown = (event: MouseEvent) => {
      if (agentRef.current && !agentRef.current.contains(event.target as Node)) setAgentOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAgentOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentOpen]);

  // Pull a fresh warehouse listing every time the picker opens.
  useEffect(() => {
    if (!whOpen) return;
    let cancelled = false;
    void window.ezness?.warehouseSnapshot().then((snapshot) => {
      if (cancelled || !snapshot) return;
      setWhItems(snapshot.items);
      // Drop ticks that point at files deleted since the last open.
      const alive = new Set(snapshot.items.map((item) => item.id));
      setWhSelected((prev) => {
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [whOpen]);

  useEffect(() => {
    if (!whOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (whRef.current && !whRef.current.contains(event.target as Node)) setWhOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWhOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [whOpen]);

  // Categories change in the knowledge page, so read them fresh each time.
  useEffect(() => {
    if (!kbOpen && !dataOpen) return;
    let cancelled = false;
    (async () => {
      const snapshot = await window.ezness?.kbSnapshot?.();
      if (cancelled || !snapshot) return;
      setCategories(snapshot.categories);
      setDocCount(snapshot.documents.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [kbOpen, dataOpen]);

  useEffect(() => {
    if (!dataOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (dataRef.current && !dataRef.current.contains(event.target as Node)) setDataOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDataOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [dataOpen]);

  // Transcripts are appended as each VAD segment finishes decoding.
  useEffect(() => {
    const unsubscribe = window.ezness?.onVoiceEvent?.((event) => {
      if (event.type === 'final' && event.text) {
        if (ignoreTranscript.current) return;
        const text = event.text.trim();
        if (!text) return;
        setValue((prev) => {
          if (!prev) return text;
          return /[\s\n]$/.test(prev) ? prev + text : `${prev} ${text}`;
        });
      } else if (event.type === 'error') {
        setVoiceError(event.error ?? t('composer.voice.recognizeError'));
      }
    });
    return () => unsubscribe?.();
  }, [t]);

  // Leaving the composer entirely (app close) must release the microphone.
  useEffect(
    () => () => {
      ignoreTranscript.current = true;
      void captureRef.current?.stop();
      captureRef.current = null;
      void window.ezness?.voiceCancel();
    },
    [],
  );

  async function startVoice() {
    const api = window.ezness;
    if (!api) {
      window.alert(t('composer.voice.desktopOnly'));
      return;
    }

    setVoiceError(null);
    ignoreTranscript.current = false;
    setVoiceState('starting');

    try {
      const started = await api.voiceStart();
      if (!started?.ok) {
        setVoiceState('idle');
        window.alert(started?.error ?? t('composer.voice.startError'));
        return;
      }

      const capture = await startVoiceCapture({
        deviceId: voice.inputDeviceId,
        onChunk: (samples) => {
          const pcm = toInt16(samples);
          void api.voiceChunk(pcm.buffer as ArrayBuffer);
        },
      });
      captureRef.current = capture;
      setVoiceState('listening');
    } catch (error) {
      captureRef.current = null;
      setVoiceState('idle');
      void api.voiceCancel();
      window.alert(
        t('composer.voice.micError', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function stopVoice() {
    setVoiceState('stopping');
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop().catch(() => undefined);
    await window.ezness?.voiceStop();
    setVoiceState('idle');
  }

  async function cancelVoice() {
    ignoreTranscript.current = true;
    setVoiceState('stopping');
    const capture = captureRef.current;
    captureRef.current = null;
    await capture?.stop().catch(() => undefined);
    await window.ezness?.voiceCancel();
    setVoiceState('idle');
  }

  /**
   * Save dropped/pasted files into the warehouse and show them as chips.
   * Real files on disk are referenced by path; clipboard blobs (screenshots,
   * files copied from apps) have no path, so their bytes are sent instead.
   */
  async function addAttachments(files: File[]) {
    const api = window.ezness;
    const picked = files.filter(Boolean);
    if (!api || picked.length === 0) return;

    const paths: string[] = [];
    const blobs: { name: string; data: ArrayBuffer }[] = [];
    const errors: string[] = [];

    for (const file of picked) {
      let filePath = '';
      try {
        filePath = api.getPathForFile(file) ?? '';
      } catch {
        filePath = '';
      }
      if (filePath) {
        paths.push(filePath);
        continue;
      }
      try {
        blobs.push({
          name: file.name || t('composer.attach.pastedFile'),
          data: await file.arrayBuffer(),
        });
      } catch (error) {
        errors.push(
          t('composer.attach.readError', {
            name: file.name || t('composer.attach.clipboardFile'),
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    if (paths.length === 0 && blobs.length === 0) {
      if (errors.length > 0) setAttachError(errors[0]);
      return;
    }

    setAttaching(true);
    setAttachError(null);
    const added: WarehouseItem[] = [];

    try {
      if (paths.length > 0) {
        const result = await api.warehouseAddFiles(paths, 'chat');
        if (result?.added) added.push(...result.added);
        // Byte-identical files already in the warehouse come back here; attach
        // the existing item rather than storing a second copy.
        if (result?.duplicates) {
          added.push(...result.duplicates);
          result.duplicates.forEach((entry) => reusedAttachments.current.add(entry.id));
        }
        if (result?.errors?.length) errors.push(...result.errors);
      }
      if (blobs.length > 0) {
        const result = await api.warehouseAddBlobs(blobs, 'chat');
        if (result?.added) added.push(...result.added);
        if (result?.duplicates) {
          added.push(...result.duplicates);
          result.duplicates.forEach((entry) => reusedAttachments.current.add(entry.id));
        }
        if (result?.errors?.length) errors.push(...result.errors);
      }
    } catch (error) {
      errors.push(
        t('composer.attach.addError', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setAttaching(false);
    }

    if (added.length > 0) {
      setAttachments((prev) => {
        const seen = new Set(prev.map((entry) => entry.id));
        return [...prev, ...added.filter((entry) => !seen.has(entry.id))];
      });
    }
    if (errors.length > 0) setAttachError(errors[0]);
  }

  /**
   * A warehouse「引用」token pasted into the composer. The file already exists
   * in the warehouse, so attach that item directly instead of storing a copy.
   */
  async function attachReferencedFile(id: string) {
    const api = window.ezness;
    if (!api) return;
    const snapshot = await api.warehouseSnapshot();
    const item = snapshot?.items.find((entry) => entry.id === id);
    if (!item) {
      setAttachError(t('composer.attach.refMissing'));
      return;
    }
    reusedAttachments.current.add(item.id);
    setAttachments((prev) =>
      prev.some((entry) => entry.id === item.id) ? prev : [...prev, item],
    );
    setAttachError(null);
  }

  async function openAttachment(item: WarehouseItem) {
    const result = await window.ezness?.warehouseOpen(item.id);
    if (result && !result.ok) setAttachError(result.error ?? t('composer.attach.openError'));
  }

  async function removeAttachment(item: WarehouseItem) {
    setAttachments((prev) => prev.filter((entry) => entry.id !== item.id));
    setAttachError(null);
    // Files newly staged for this message are dropped from the warehouse with
    // the chip; reused duplicates belong to the warehouse already, so leave
    // the original in place.
    if (reusedAttachments.current.delete(item.id)) return;
    await window.ezness?.warehouseDelete(item.id);
  }

  function submit() {
    // Never send while a picked file is still being copied into the warehouse;
    // its chip is not on screen yet and would be silently left out.
    if (attaching) return;
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    if (voiceState !== 'idle') void cancelVoice();
    onSend(text, attachments);
    setValue('');
    onTyping?.(false);
    setAttachments([]);
    reusedAttachments.current.clear();
  }

  const micTitle =
    voiceState === 'starting'
      ? t('composer.voice.loadingModel')
      : voiceState === 'listening'
        ? t('composer.voice.listening')
        : voiceState === 'stopping'
          ? t('composer.voice.transcribing')
          : t('composer.voice.title');

  const kbTitle = kb.enabled
    ? t('composer.kb.titleEnabled', {
        category: categoryName,
        mode: t(MODE_LABEL[kb.mode]),
      })
    : t('composer.kb.titleDisabled');

  const promptTitle = selectedPrompt
    ? t('composer.prompt.titleEnabled', {
        name: selectedPrompt.name,
        kind: t(selectedPrompt.wrap ? 'composer.prompt.wrap' : 'composer.prompt.system'),
      })
    : t('composer.prompt.titleDisabled');

  // 普通对话的仓库多选器。工作区把它换成开关，所以这里只有非紧凑模式
  // 和功能编辑工作空间会用到。
  const warehousePicker = (
    <div className="whmenu" ref={whRef}>
      <button
        className={`chip chip--warehouse ${whSelected.size > 0 ? 'is-on' : ''}`}
        title={t('composer.warehouse.pickTitle')}
        onClick={() => setWhOpen((open) => !open)}
      >
        <WarehouseIcon size={14} />
        {t('composer.warehouse.label')}
        {whSelected.size > 0 && (
          <span className="whmenu__badge">{whSelected.size}</span>
        )}
      </button>

      {whOpen && (
        <div
          className="whmenu__panel"
          role="dialog"
          aria-label={t('composer.warehouse.pickLabel')}
        >
          <div className="whmenu__head">
            <span className="whmenu__title">{t('composer.warehouse.pickLabel')}</span>
            <span className="whmenu__sub">
              {whSelected.size > 0
                ? t('composer.warehouse.selected', { count: whSelected.size })
                : t('composer.warehouse.fileCount', { count: whItems.length })}
            </span>
          </div>

          <input
            className="input whmenu__search"
            value={whQuery}
            placeholder={t('composer.warehouse.search')}
            spellCheck={false}
            autoFocus
            onChange={(event) => setWhQuery(event.target.value)}
          />

          <div className="whmenu__list">
            {whMatches.map((item) => {
              const selected = whSelected.has(item.id);
              return (
                <button
                  key={item.id}
                  className={`whmenu__item ${selected ? 'is-active' : ''}`}
                  title={item.name}
                  aria-pressed={selected}
                  onClick={() => toggleWarehouseItem(item.id)}
                >
                  <span className={`whmenu__check ${selected ? 'is-on' : ''}`}>
                    {selected && <CheckIcon size={11} />}
                  </span>
                  <span className="whmenu__main">
                    <span className="whmenu__name">{item.name}</span>
                    <span className="whmenu__meta">
                      {formatSize(item.size)} · {formatDateTime(item.addedAt)}
                    </span>
                  </span>
                </button>
              );
            })}

            {whMatches.length === 0 && (
              <div className="pmenu__empty">
                {whItems.length === 0
                  ? t('composer.warehouse.empty')
                  : t('composer.warehouse.noMatch')}
              </div>
            )}
          </div>

          <div className="whmenu__foot">
            <span className="whmenu__count">
              {t('composer.warehouse.filtered', { count: whMatches.length })}
            </span>
            <button
              className="btn btn--ghost"
              onClick={() => {
                setWhSelected(new Set());
                setWhQuery('');
                setWhOpen(false);
              }}
            >
              {t('composer.cancel')}
            </button>
            <button
              className="btn btn--primary"
              disabled={whSelected.size === 0}
              onClick={confirmWarehousePick}
            >
              {t('composer.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="composer" ref={rootRef}>
      <div
        className={`composer__box ${dropActive ? 'is-drop' : ''}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          if (dragDepth.current === 0) return;
          dragDepth.current -= 1;
          if (dragDepth.current === 0) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          void addAttachments([...event.dataTransfer.files]);
        }}
      >
        {(attachments.length > 0 || attaching) && (
          <div className="attachlist">
            {attachments.map((item) => (
              <div
                className="attachcard"
                key={item.id}
                title={t('composer.attach.chipTitle', {
                  name: item.name,
                  size: formatSize(item.size),
                })}
                onDoubleClick={() => void openAttachment(item)}
              >
                <span className={`attachcard__badge ${item.kind === 'image' ? 'is-image' : ''}`}>
                  {extLabel(item.ext)}
                </span>
                <span className="attachcard__main">
                  <span className="attachcard__name">{item.name}</span>
                  <span className="attachcard__meta">
                    {item.ext ? item.ext.toUpperCase() : t('composer.attach.fileLabel')} ·{' '}
                    {formatSize(item.size)}
                  </span>
                </span>
                <button
                  className="attachcard__remove"
                  title={t('composer.attach.removeTitle', { name: item.name })}
                  aria-label={t('composer.attach.removeAria', { name: item.name })}
                  onClick={() => void removeAttachment(item)}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
            {attaching && (
              <span className="attachlist__busy">{t('composer.attach.adding')}</span>
            )}
          </div>
        )}

        {attachError && <div className="composer__attach-error">{attachError}</div>}

        {dropActive && (
          <div className="composer__dropmask">
            <UploadIcon size={16} />
            {t('composer.attach.dropHint')}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer__input"
          value={value}
          rows={1}
          placeholder={
            voiceState === 'listening'
              ? t('composer.placeholder.listening')
              : t('composer.placeholder.default')
          }
          onChange={(event) => {
            setValue(event.target.value);
            onTyping?.(event.target.value.trim().length > 0);
          }}
          onPaste={(event) => {
            //「引用」from the warehouse puts a single-line token on the
            // clipboard; expand it into the attachment chip instead of text.
            const text = event.clipboardData?.getData('text/plain') ?? '';
            const referenced = parseWarehouseRef(text);
            if (referenced) {
              event.preventDefault();
              void attachReferencedFile(referenced);
              return;
            }

            const files = event.clipboardData?.files;
            if (!files || files.length === 0) return;
            // A copied file also puts its name on the clipboard as text; keep
            // that out of the message and treat the paste as an attachment.
            event.preventDefault();
            void addAttachments([...files]);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="composer__bar">
          <div className="composer__tools">
            <div className="model-menu" ref={menuRef}>
              <button
                className={`chip ${current ? '' : 'chip--warn'}`}
                title={current ? current.hint : t('composer.model.noModelHint')}
                onClick={() => {
                  if (models.length === 0) {
                    onConfigure();
                    return;
                  }
                  setMenuOpen((open) => !open);
                }}
              >
                <span className="chip__dot" />
                {current?.label ?? t('composer.model.notConnected')}
                {models.length > 0 && <ChevronDownIcon size={13} />}
              </button>
              {menuOpen && (
                <div className="menu menu--models">
                  {modelGroups.map((group) => (
                    <div key={group.id} className="menu__group">
                      <div className="menu__group-title">
                        <span>{group.name}</span>
                        <span className="menu__group-count">{group.items.length}</span>
                      </div>
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          className={`menu__item ${item.id === model ? 'is-active' : ''}`}
                          title={item.hint}
                          onClick={() => {
                            onModelChange(item.id);
                            setMenuOpen(false);
                          }}
                        >
                          <span className="menu__label">{item.label}</span>
                          {item.id === model && <CheckIcon size={14} className="menu__check" />}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {compact && onPermissionModeChange && (
              <div className="perm-menu" ref={permRef}>
                <button
                  type="button"
                  className={`chip perm-menu__trigger ${permOpen ? 'is-open' : ''}`}
                  disabled={streaming}
                  aria-haspopup="dialog"
                  aria-expanded={permOpen}
                  title={t('composer.perm.menuTitle', { mode: t(permInfo.labelKey) })}
                  onClick={() => {
                    setPermHover(mode);
                    setPermOpen((open) => !open);
                  }}
                >
                  {t(permInfo.labelKey)}
                  <ChevronDownIcon size={13} />
                </button>
                {permOpen && (
                  <div
                    className="perm-menu__panel"
                    role="dialog"
                    aria-label={t('composer.perm.menuAria')}
                  >
                    <div className="perm-menu__head">
                      <span>{t('composer.perm.menuAria')}</span>
                      <em>{t('composer.perm.menuHint')}</em>
                    </div>
                    <p className="perm-menu__desc">{t(hoverInfo.descKey)}</p>
                    <div className="perm-menu__list">
                      {PERM_MODES.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className={`perm-menu__item ${item.key === mode ? 'is-active' : ''}`}
                          aria-pressed={item.key === mode}
                          onMouseEnter={() => setPermHover(item.key)}
                          onFocus={() => setPermHover(item.key)}
                          onClick={() => {
                            onPermissionModeChange(item.key);
                            setPermOpen(false);
                          }}
                        >
                          <span className="perm-menu__name">{t(item.labelKey)}</span>
                          {item.key === mode && <CheckIcon size={13} />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {compact && onAgentChange && (
              <div className="agent-menu" ref={agentRef}>
                <button
                  type="button"
                  className={`chip agent-menu__trigger ${agentOpen ? 'is-open' : ''} ${
                    activeAgent ? 'is-on' : ''
                  } ${agentId && !activeAgent ? 'chip--warn' : ''}`}
                  disabled={streaming}
                  aria-haspopup="dialog"
                  aria-expanded={agentOpen}
                  title={
                    activeAgent
                      ? t('composer.agent.activeTitle', { name: activeAgent.name })
                      : agentId
                        ? t('composer.agent.deletedTitle')
                        : t('composer.agent.pickTitle')
                  }
                  onClick={() => {
                    const next = !agentOpen;
                    setAgentOpen(next);
                    if (next) onRefreshAgents?.();
                  }}
                >
                  <SparkleIcon size={14} />
                  {activeAgent
                    ? activeAgent.name
                    : agentId
                      ? t('composer.agent.deletedLabel')
                      : 'Agent'}
                  <ChevronDownIcon size={13} />
                </button>
                {agentOpen && (
                  <div
                    className="agent-menu__panel"
                    role="dialog"
                    aria-label={t('composer.agent.menuAria')}
                  >
                    <div className="agent-menu__head">
                      <span>{t('composer.agent.menuTitle')}</span>
                      <em>{t('composer.agent.menuHint')}</em>
                    </div>
                    <div className="agent-menu__list">
                      <button
                        type="button"
                        className={`agent-menu__item ${!agentId ? 'is-active' : ''}`}
                        onClick={() => {
                          onAgentChange(null);
                          setAgentOpen(false);
                        }}
                      >
                        <span className="agent-menu__name">{t('composer.agent.none')}</span>
                        {!agentId && <CheckIcon size={13} />}
                      </button>
                      {(agents ?? []).map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          className={`agent-menu__item ${
                            agent.id === agentId ? 'is-active' : ''
                          }`}
                          onClick={() => {
                            onAgentChange(agent);
                            setAgentOpen(false);
                          }}
                        >
                          <span className="agent-menu__body">
                            <span className="agent-menu__name">
                              {agent.name}
                              {!agent.enabled && (
                                <em className="agent-menu__badge">
                                  {t('composer.agent.disabled')}
                                </em>
                              )}
                            </span>
                            {agent.role && (
                              <span className="agent-menu__role">{agent.role}</span>
                            )}
                          </span>
                          {agent.id === agentId && <CheckIcon size={13} />}
                        </button>
                      ))}
                    </div>
                    {(agents ?? []).length === 0 && (
                      <p className="agent-menu__empty">{t('composer.agent.empty')}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {compact && onDataAccessChange ? (
              // Workspace tasks activate the warehouse; they do not pick files.
              // The agent looks a file up by name only when the conversation
              // needs one, and every content read still asks first.
              <button
                type="button"
                className={`chip chip--warehouse ${dataAccess?.warehouse ? 'is-on' : ''}`}
                title={
                  dataAccess?.warehouse
                    ? t('composer.data.warehouseOn')
                    : t('composer.data.warehouseOff')
                }
                aria-pressed={Boolean(dataAccess?.warehouse)}
                onClick={toggleDataWarehouse}
              >
                <WarehouseIcon size={14} />
                {t('composer.warehouse.label')}
                <span className={`kbmenu__dot ${dataAccess?.warehouse ? 'is-on' : ''}`} />
              </button>
            ) : null}

            {compact && onDataAccessChange && (
              <div className="datamenu" ref={dataRef}>
                <button
                  className={`chip ${dataActive ? 'is-on' : ''}`}
                  title={t('composer.data.kbTitle')}
                  aria-expanded={dataOpen}
                  onClick={() => setDataOpen((open) => !open)}
                >
                  <BookIcon size={14} />
                  {t('composer.kb.label')}
                  {dataBadge > 0 && <span className="whmenu__badge">{dataBadge}</span>}
                </button>

                {dataOpen && (
                  <div
                    className="datamenu__panel"
                    role="dialog"
                    aria-label={t('composer.data.panelAria')}
                  >
                    <div className="datamenu__head">
                      <span className="datamenu__title">{t('composer.data.panelTitle')}</span>
                      <span className="datamenu__sub">{t('composer.data.panelSub')}</span>
                    </div>

                    <div className="datamenu__section">
                      <div className="datamenu__row">
                        <div>
                          <div className="datamenu__name">{t('composer.data.enableTitle')}</div>
                          <div className="datamenu__hint">
                            {t('composer.data.enableHint')}
                          </div>
                        </div>
                        <button
                          className={`switch ${dataKbOn ? 'is-on' : ''}`}
                          role="switch"
                          aria-checked={dataKbOn}
                          aria-label={t('composer.data.toggleAria')}
                          onClick={toggleDataKb}
                        >
                          <span />
                        </button>
                      </div>

                      <div className={`datamenu__cats ${dataKbOn ? '' : 'is-disabled'}`}>
                        {categories.map((category) => {
                          const checked = dataKbIds.includes(category.id);
                          return (
                            <button
                              key={category.id}
                              type="button"
                              className={`datamenu__cat ${checked ? 'is-active' : ''}`}
                              aria-pressed={checked}
                              disabled={!dataKbOn}
                              onClick={() => toggleDataCategory(category.id)}
                            >
                              <span className={`datamenu__check ${checked ? 'is-on' : ''}`}>
                                {checked && <CheckIcon size={11} />}
                              </span>
                              <span className="datamenu__cat-name">{category.name}</span>
                              {category.kind === 'group' && (
                                <span className="datamenu__tag">{t('composer.data.groupTag')}</span>
                              )}
                            </button>
                          );
                        })}
                        {categories.length === 0 && (
                          <div className="datamenu__empty">{t('composer.data.empty')}</div>
                        )}
                      </div>

                      {dataKbOn && dataKbIds.length === 0 && (
                        <div className="datamenu__warn">{t('composer.data.warn')}</div>
                      )}
                    </div>

                    <p className="datamenu__foot">{t('composer.data.foot')}</p>
                  </div>
                )}
              </div>
            )}

            {!compact && (
              <>
            <div className="pmenu" ref={promptRef}>
              <button
                className={`chip chip--prompt ${promptId ? 'is-on' : ''}`}
                title={promptTitle}
                onClick={() => setPromptOpen((open) => !open)}
              >
                <SparkleIcon size={14} />
                {t('composer.prompt.label')}
                {selectedPrompt && <span className="pmenu__name">{selectedPrompt.name}</span>}
                <span className={`kbmenu__dot ${promptId ? 'is-on' : ''}`} />
              </button>

              {promptOpen && (
                <div
                  className="pmenu__panel"
                  role="dialog"
                  aria-label={t('composer.prompt.menuAria')}
                >
                  <input
                    className="input pmenu__search"
                    value={promptQuery}
                    placeholder={t('composer.prompt.search')}
                    spellCheck={false}
                    autoFocus
                    onChange={(event) => setPromptQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setPromptOpen(false);
                      } else if (event.key === 'Enter') {
                        event.preventDefault();
                        if (promptMatches[0]) choosePrompt(promptMatches[0].id);
                      }
                    }}
                  />

                  {selectedPrompt && selectedPrompt.variables.length > 0 && (
                    <div className="pmenu__params">
                      <div className="pmenu__params-head">
                        <span>
                          {t('composer.prompt.paramsTitle', { name: selectedPrompt.name })}
                        </span>
                        <span className="pmenu__params-hint">{t('composer.prompt.paramsHint')}</span>
                      </div>
                      {selectedPrompt.variables.map((variable) => (
                        <label key={variable.name} className="pmenu__param">
                          <span className="pmenu__param-name" title={`{{${variable.name}}}`}>
                            {variable.name}
                          </span>
                          <input
                            className="input pmenu__param-input"
                            value={promptVariables[variable.name] ?? variable.value}
                            spellCheck={false}
                            onChange={(event) =>
                              onPromptVariableChange(variable.name, event.target.value)
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  <div className="pmenu__list">
                    <button
                      className={`pmenu__item ${promptId ? '' : 'is-active'}`}
                      onClick={() => choosePrompt(null)}
                    >
                      <span className="pmenu__item-name">{t('composer.prompt.none')}</span>
                      {!promptId && <CheckIcon size={13} />}
                    </button>

                    {promptMatches.map((template) => (
                      <button
                        key={template.id}
                        className={`pmenu__item ${template.id === promptId ? 'is-active' : ''}`}
                        title={template.description || template.name}
                        onClick={() => choosePrompt(template.id)}
                      >
                        <span className="pmenu__item-main">
                          <span className="pmenu__item-name">{template.name}</span>
                          {template.description && (
                            <span className="pmenu__item-desc">{template.description}</span>
                          )}
                        </span>
                        {template.id === promptId && <CheckIcon size={13} />}
                      </button>
                    ))}

                    {promptMatches.length === 0 && (
                      <div className="pmenu__empty">
                        {templates.length === 0
                          ? t('composer.prompt.empty')
                          : t('composer.prompt.noMatch')}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {warehousePicker}

            <div className="kbmenu" ref={kbRef}>
              <button
                className={`chip chip--kb ${kb.enabled ? 'is-on' : ''}`}
                title={kbTitle}
                onClick={() => {
                  setWebOpen(false);
                  setKbOpen((open) => !open);
                }}
              >
                <BookIcon size={14} />
                {t('composer.kb.label')}
                <span className={`kbmenu__dot ${kb.enabled ? 'is-on' : ''}`} />
              </button>

              {kbOpen && (
                <div
                  className="kbmenu__panel"
                  role="dialog"
                  aria-label={t('composer.kb.panelAria')}
                >
                  <div className="kbmenu__head">
                    <div>
                      <div className="kbmenu__title">{t('composer.kb.panelTitle')}</div>
                      <div className="kbmenu__sub">
                        {kb.enabled
                          ? t('composer.kb.subEnabled')
                          : t('composer.kb.subDisabled')}
                      </div>
                    </div>
                    <button
                      className={`switch ${kb.enabled ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={kb.enabled}
                      title={kb.enabled ? t('composer.kb.disableTitle') : t('composer.kb.enableTitle')}
                      onClick={() => onKbChange({ enabled: !kb.enabled })}
                    >
                      <span />
                    </button>
                  </div>

                  <div className="kbmenu__field">
                    <span className="kbmenu__field-label">{t('composer.kb.categoryLabel')}</span>
                    <div className="kbmenu__combo">
                      <input
                        className="input kbmenu__combo-input"
                        value={catOpen ? catQuery : categoryName}
                        placeholder={t('composer.kb.categoryPlaceholder')}
                        spellCheck={false}
                        disabled={!kb.enabled}
                        onFocus={() => {
                          setCatQuery('');
                          setCatOpen(true);
                        }}
                        onClick={() => {
                          if (!catOpen) setCatOpen(true);
                        }}
                        onChange={(event) => {
                          setCatQuery(event.target.value);
                          setCatOpen(true);
                        }}
                        onBlur={() => setCatOpen(false)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && catOpen) {
                            event.stopPropagation();
                            setCatOpen(false);
                          } else if (event.key === 'Enter' && catOpen) {
                            event.preventDefault();
                            if (catKeyword === '') setCatOpen(false);
                            else chooseCategory(catMatches[0]?.id ?? null);
                          }
                        }}
                      />

                      {catOpen && (
                        <div className="kbmenu__combo-list">
                          {showsAll && (
                            <button
                              className={`kbmenu__combo-item ${kb.categoryId === null ? 'is-active' : ''}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => chooseCategory(null)}
                            >
                              {t('composer.category.all')}
                            </button>
                          )}
                          {catMatches.map((category) => (
                            <button
                              key={category.id}
                              className={`kbmenu__combo-item ${kb.categoryId === category.id ? 'is-active' : ''}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => chooseCategory(category.id)}
                            >
                              {category.name}
                            </button>
                          ))}
                          {!showsAll && catMatches.length === 0 && (
                            <div className="kbmenu__combo-empty">
                              {t('composer.kb.categoryNoMatch')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="kbmenu__field-label">{t('composer.kb.modeLabel')}</div>
                  <div className={`kbmenu__modes ${kb.enabled ? '' : 'is-disabled'}`}>
                    {MODES.map((mode) => (
                      <button
                        key={mode.key}
                        className={`kbmenu__mode ${kb.mode === mode.key ? 'is-active' : ''}`}
                        disabled={!kb.enabled}
                        onClick={() => onKbChange({ mode: mode.key })}
                      >
                        <span className="kbmenu__mode-text">
                          <span className="kbmenu__mode-title">{t(mode.titleKey)}</span>
                          <span className="kbmenu__mode-desc">{t(mode.descKey)}</span>
                        </span>
                        {kb.mode === mode.key && <CheckIcon size={14} />}
                      </button>
                    ))}
                  </div>

                  {docCount === 0 && (
                    <div className="kbmenu__empty">{t('composer.kb.empty')}</div>
                  )}
                </div>
              )}
            </div>
              </>
            )}

            {compact && !onDataAccessChange && warehousePicker}

            <div className="kbmenu" ref={webRef}>
              <button
                className={`chip chip--web ${kb.webMode !== 'off' ? 'is-on' : ''}`}
                title={
                  kb.webMode === 'off'
                    ? t('composer.web.offTitle')
                    : kb.webMode === 'auto'
                      ? t('composer.web.autoTitle')
                      : t('composer.web.alwaysTitle')
                }
                aria-pressed={kb.webMode !== 'off'}
                aria-haspopup="dialog"
                onClick={() => {
                  setKbOpen(false);
                  setWebOpen((open) => !open);
                }}
              >
                <GlobeIcon size={14} />
                {t('composer.web.label')}
                <span className={`kbmenu__dot ${kb.webMode === 'always' ? 'is-on' : kb.webMode === 'auto' ? 'is-auto' : ''}`} />
                <span className="chip__state">{t(WEB_MODE_KEYS[kb.webMode])}</span>
              </button>

              {webOpen && (
                <div
                  className="kbmenu__panel kbmenu__panel--web"
                  role="dialog"
                  aria-label={t('composer.web.panelAria')}
                >
                  <div className="kbmenu__head">
                    <div>
                      <div className="kbmenu__title">{t('composer.web.panelTitle')}</div>
                      <div className="kbmenu__sub">{t('composer.web.panelSub')}</div>
                    </div>
                  </div>
                  <WebModeSlider
                    value={kb.webMode}
                    onChange={(webMode: WebMode) => onKbChange({ webMode })}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="composer__actions">
            {context && (
              <ContextRing used={context.used} limit={context.limit} compression={compression} />
            )}
            <button
              className={`mic ${voiceState === 'listening' ? 'is-listening' : ''} ${
                voiceState === 'starting' || voiceState === 'stopping' ? 'is-busy' : ''
              }`}
              title={micTitle}
              aria-label={micTitle}
              aria-pressed={voiceState === 'listening'}
              disabled={voiceState === 'starting' || voiceState === 'stopping'}
              onClick={() => {
                if (voiceState === 'listening') void stopVoice();
                else void startVoice();
              }}
            >
              <MicIcon size={16} />
            </button>

            <button
              className={`send ${streaming ? 'send--stop' : ''}`}
              title={streaming ? t('composer.action.stop') : t('composer.action.send')}
              onClick={streaming ? onStop : submit}
              disabled={!streaming && (attaching || (!value.trim() && attachments.length === 0))}
            >
              {streaming ? <StopIcon size={15} /> : <SendIcon size={16} />}
            </button>
          </div>
        </div>
      </div>
      <div className="composer__hint">{t('composer.hint')}</div>
      <div className="composer__speed" title={t('composer.speedTitle')}>
        {speed !== null && speed > 0 ? `${speed.toFixed(1)} tok/s` : ''}
      </div>
      {voiceError && <div className="composer__voice-error">{voiceError}</div>}
    </div>
  );
}
