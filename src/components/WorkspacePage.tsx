import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentActivity,
  AgentDefinition,
  AgentPermission,
  AgentQuestion,
  AgentRunSnapshot,
  AgentStreamEvent,
  AskLevel,
  ChatTarget,
  CompressionInfo,
  DirectorActiveUsage,
  DirectorInboxView,
  DirectorLedgerEntry,
  DirectorSpawnResult,
  DirectorSpaceRef,
  DirectorState,
  DirectorTaskAction,
  DirectorTaskRef,
  DirectorWorkspaceOption,
  KbChatSettings,
  Message,
  ModelOption,
  OcrSettings,
  PermissionMode,
  Session,
  TodoItem,
  ToolHealthMap,
  ToolStep,
  UsageRecord,
  VoiceSettings,
  WarehouseItem,
  WebSettings,
  WorkSettings,
  WorkspaceDataAccess,
  WorkspaceLibrary,
} from '../types';
import { buildAttachmentContext, buildSessionMarkdown, estimateTokens } from '../lib/chat';
import {
  appendStreamText,
  clearStreamText,
  takeStreamText,
} from '../lib/streamText';
import { readWebMode } from '../data/web';
import {
  compressConversation,
  contextTokensFromUsage,
  conversationTokens,
  isVisible,
  selectCompressible,
  type CompressionToken,
} from '../lib/compression';
import { findSnippet, textByConversation } from '../lib/search';
import { useI18n } from '../i18n';
import { ActivityDot, type ActivityStatus } from './ActivityDot';
import type { Translate } from './AskLevelSlider';
import { ChatView } from './ChatView';
import { ConfirmDialog } from './ConfirmDialog';
import { DirectorPage } from './DirectorPage';
import { TaskBubbleDialog } from './TaskBubbleDialog';
import {
  RemoteWorkspaceDialog,
  type RemoteWorkspaceResult,
} from './RemoteWorkspaceDialog';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspaceVisualize } from './WorkspaceVisualize';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DirectorIcon,
  FolderIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  WorkspaceIcon,
} from './Icons';

/**
 * A workspace is a folder on disk. Conversations live under it and stay
 * independent from the ones in 对话 — separate lists, separate transcripts.
 * Like the main conversation list, they are kept in memory for now.
 */
interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  pinned?: boolean;
  /** `tool-editor` is a virtual workspace bound to one tool category.
   *  `director` holds the single conversation with the 工作总监. */
  kind?: 'folder' | 'tool-editor' | 'agent-editor' | 'director' | 'remote';
  /** `remote` workspaces live on an SSH host; credentials are never in here. */
  remote?: {
    host: string;
    port: number;
    username: string;
    root: string;
    fingerprint?: string;
  };
  categoryId?: string;
  categoryName?: string;
  /** `agent-editor` binds the conversation to one Agent definition. */
  agentId?: string;
  agentName?: string;
}

/** Last reachability result for one real workspace (not the virtual editors). */
interface SpaceHealth {
  ok: boolean;
  /** missing | not-dir | unreachable | error — drives the wording. */
  reason?: string;
  error?: string;
  at: number;
}

/** Full reason for the sidebar tooltip. */
function spaceHealthDetail(workspace: Workspace, health: SpaceHealth, t: Translate): string {
  const target =
    workspace.kind === 'remote' && workspace.remote
      ? `${workspace.remote.username}@${workspace.remote.host}:${workspace.remote.root}`
      : workspace.path;
  const suffix = health.error ? `\n${health.error}` : '';
  if (health.reason === 'missing') {
    return t('workspace.health.pathMissing', { target, suffix });
  }
  if (health.reason === 'not-dir') {
    return t('workspace.health.notDir', { target, suffix });
  }
  if (health.reason === 'unreachable') {
    return t('workspace.health.remoteFailed', { target, suffix });
  }
  return t('workspace.health.unreachable', { target, suffix });
}

/** One short line above the task list when the open workspace is unhealthy. */
function spaceHealthSummary(workspace: Workspace, health: SpaceHealth, t: Translate): string {
  if (health.reason === 'missing') {
    return workspace.kind === 'remote'
      ? t('workspace.health.remoteMissing')
      : t('workspace.health.localMissing');
  }
  if (health.reason === 'not-dir') return t('workspace.health.notDirSummary');
  if (health.reason === 'unreachable') return t('workspace.health.remoteUnreachable');
  return t('workspace.health.unavailable');
}

interface WorkspaceChat extends Session {
  workspaceId: string;
  /** How much the agent may do without asking; defaults to 工作区写入. */
  permission?: PermissionMode;
  /** Per-task question level; undefined follows the global 工作设置. */
  askLevel?: AskLevel;
  /** Commands this task may re-run without asking again. */
  allowedCommands?: string[];
  /** Checklist the agent last published, kept so it survives a restart. */
  todos?: TodoItem[];
  /** When that checklist was last written; used to tell a fresh plan from a stale one. */
  todosAt?: number;
  /** Knowledge-base / warehouse access activated for this task (off by default). */
  dataAccess?: WorkspaceDataAccess;
  /** Agent enabled for this task; its role, prompt and capability scope apply. */
  agentId?: string;
  /** 总监派工建出来的任务：员工标识与所属分配。 */
  employee?: string;
  dispatchId?: string;
  /**
   * Position the user dragged this task to inside its workspace. Tasks without
   * one are new since the last drag and stay on top, newest first.
   */
  order?: number;
  /**
   * Prompt size predicted right after a manual compaction, in provider terms.
   * The last usage record still describes the pre-compaction request, so the
   * ring uses this until a newer request reports the real number — including
   * after a restart.
   */
  contextAfter?: { tokens: number; at: number };
}

interface Props {
  models: ModelOption[];
  fallbackModel: string;
  voice: VoiceSettings;
  ocr: OcrSettings;
  web: WebSettings;
  /** Global work settings: fallback limits for every task. */
  work: WorkSettings;
  /** Token ledger; the ring reads the last real request for this task. */
  usage: UsageRecord[];
  onConfigure: () => void;
  onShowWarehouse: (id: string) => void;
  resolveTarget: (modelKey: string) => ChatTarget | null;
  /** Hand the workspace's chats up so warehouse jumps can find them. */
  onLibraryChange?: (library: WorkspaceLibrary) => void;
  /** Jump from the warehouse into a workspace conversation. */
  focus?: {
    workspaceId: string;
    chatId: string;
    messageId: string;
    nonce: number;
  } | null;
  /** Jump from AI能力 into the category-locked editing workspace. */
  toolEditorFocus?: {
    categoryId: string;
    categoryName: string;
    nonce: number;
  } | null;
  /** Jump from the Agent page into its AI editing workspace. */
  agentEditorFocus?: {
    agentId: string;
    agentName: string;
    nonce: number;
  } | null;
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

const DEFAULT_CHAT_KB: KbChatSettings = {
  enabled: false,
  categoryId: null,
  mode: 'balanced',
  // Every new task starts on 自动; the composer menu still changes it per task.
  webMode: 'auto',
};

const EMPTY_PROMPT_VARIABLES: Record<string, string> = {};

/** Stable empty search index for the no-query case. */
const NO_MESSAGE_TEXTS: Map<string, string[]> = new Map();

/** One in-flight agent run; each task may own at most one at a time. */
interface StreamEntry {
  requestId: string;
  messageId: string;
  chatId: string;
  /** 这一轮开始的时间；总监页只统计本轮的花费。 */
  startedAt: number;
}

/** 总监页左侧浮着的任务：跑完不消失，点一下跳过去才移除。 */
type FloatingStatus = 'running' | 'done' | 'error' | 'stopped';

interface FloatingTask {
  id: string;
  title: string;
  status: FloatingStatus;
}

const FLOATING_STATUS_KEY: Record<FloatingStatus, string> = {
  running: 'workspace.status.running',
  done: 'workspace.status.done',
  error: 'workspace.status.error',
  stopped: 'workspace.status.stopped',
};

/** Stable ids for the locally generated editor welcome messages. */
const TOOL_EDITOR_INTRO_ID = 'tool-editor-intro';
const AGENT_EDITOR_INTRO_ID = 'agent-editor-intro';

/**
 * Two groups share the left slot: 工作空间 + 任务 open together as one unit,
 * 文件 shows the folder tree. Clicking the active icon closes its group.
 */
const WORKSPACE_PANELS = [
  { key: 'work', labelKey: 'workspace.panel.work', icon: WorkspaceIcon },
  { key: 'files', labelKey: 'workspace.panel.files', icon: FolderIcon },
  { key: 'director', labelKey: 'workspace.panel.director', icon: DirectorIcon },
] as const;

type WorkspacePanel = (typeof WORKSPACE_PANELS)[number]['key'];

function basename(target: string, fallback: string): string {
  return target.split(/[\\/]/).filter(Boolean).pop() || fallback;
}

/** What the current workspace points at, shown above its task list. */
function workspacePathLabel(
  workspace: {
    kind?: 'folder' | 'tool-editor' | 'agent-editor' | 'director' | 'remote';
    path: string;
    categoryName?: string;
    agentName?: string;
    remote?: { host: string; port: number; username: string; root: string };
  },
  t: Translate,
): string {
  if (workspace.kind === 'tool-editor') {
    return t('workspace.path.toolEditor', { name: workspace.categoryName ?? '' });
  }
  if (workspace.kind === 'agent-editor') {
    return t('workspace.path.agent', { name: workspace.agentName ?? '' });
  }
  if (workspace.kind === 'director') return t('workspace.path.global');
  if (workspace.kind === 'remote' && workspace.remote) {
    const { username, host, port, root } = workspace.remote;
    return `${username}@${host}${Number(port || 22) === 22 ? '' : `:${port}`}:${root}`;
  }
  return workspace.path;
}

/**
 * Stable short hash shown as `Agent编辑-<hash>`. The main process derives the
 * same value from the agent id, so the title matches the running session.
 */
function agentHash(agentId: string): string {
  const raw = String(agentId ?? '').replace(/^agt_/, '').replace(/[^a-zA-Z0-9]/g, '');
  return (raw || 'agent').slice(0, 8);
}

/** Pinned rows stay on top; Array.sort is stable, so the rest keeps its order. */
function pinnedFirst(a: { pinned?: boolean }, b: { pinned?: boolean }): number {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
}

/** Compact stamp for the conversation list: time today, date otherwise. */
function shortStamp(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (value: number) => String(value).padStart(2, '0');
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function WorkspacePage({
  models,
  fallbackModel,
  voice,
  ocr,
  web,
  work,
  usage,
  onConfigure,
  onShowWarehouse,
  resolveTarget,
  onLibraryChange,
  focus,
  toolEditorFocus,
  agentEditorFocus,
}: Props) {
  const { t } = useI18n();
  /** Long-lived subscriptions keep the latest translator without re-binding. */
  const tRef = useRef(t);
  tRef.current = t;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  /** Reachability per real workspace: missing local path or unreachable host. */
  const [spaceHealth, setSpaceHealth] = useState<Record<string, SpaceHealth>>({});
  /** Workspaces with a probe in flight, so the interval never stacks them. */
  const probingSpaces = useRef<Set<string>>(new Set());
  const [panel, setPanel] = useState<WorkspacePanel | null>('work');
  const [spaceQuery, setSpaceQuery] = useState('');
  const [chatQuery, setChatQuery] = useState('');
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [chats, setChats] = useState<WorkspaceChat[]>([]);
  /** 工作总监: mandate + who drives each task. null until loaded. */
  const [director, setDirector] = useState<DirectorState | null>(null);
  const [directorInbox, setDirectorInbox] = useState<DirectorInboxView | null>(null);
  const [directorLedger, setDirectorLedger] = useState<DirectorLedgerEntry[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [vizOpen, setVizOpen] = useState(false);
  /** Agents listed in the composer picker; refreshed whenever it opens. */
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  // Context compression for the active task's transcript. Same rules as the
  // 对话 page: separate request, originals archived with hiddenBy, undoable.
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
  /**
   * Tokens the agent history just shed. The ring reads the provider's last
   * prompt count, which still describes the pre-compaction request until the
   * next turn, so subtract this meanwhile.
   */
  const [agentCompactSaving, setAgentCompactSaving] = useState<{
    sessionId: string;
    saving: number;
    at: number;
  } | null>(null);
  /**
   * Live estimate of the task's agent history. Provider usage wins while it is
   * current; after a manual compaction (which writes the file without making a
   * request) the old count is far above this estimate, and the ring must not
   * keep showing it — including after a restart.
   */
  const [agentContext, setAgentContext] = useState<{
    sessionId: string;
    tokens: number;
    at: number;
    digested: boolean;
  } | null>(null);
  const compressionToken = useRef<CompressionToken | null>(null);
  /** Mirror of streamsRef so renders see which tasks are still streaming. */
  const [activeStreams, setActiveStreams] = useState<StreamEntry[]>([]);
  const [floatingTasks, setFloatingTasks] = useState<FloatingTask[]>([]);
  /** 左键点开的气泡：看这个任务的对话，可以直接说话，也能进入工作。 */
  const [bubbleTaskId, setBubbleTaskId] = useState<string | null>(null);
  /** 用户点掉的任务：这一轮结束不再冒出来，下一轮开始才重新出现。 */
  const dismissedFloating = useRef(new Set<string>());
  const [phase, setPhase] = useState<'retrieving' | 'generating'>('generating');
  /**
   * What the active run is doing right now, keyed by its assistant message.
   * A task alternates between the model writing (text, reasoning, tool
   * arguments) and the app running tools; between the two the screen is silent
   * for however long the next request takes, so this drives the live line.
   */
  const [activity, setActivity] = useState<{
    messageId: string;
    value: AgentActivity;
  } | null>(null);
  /** Tool calls currently executing, keyed `${requestId}:${callId}`. */
  const runningCalls = useRef(new Set<string>());
  const [speed, setSpeed] = useState<number | null>(null);
  /** 所有在跑任务的合计输出速度（总监页用）。 */
  const [totalSpeed, setTotalSpeed] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef(0);
  const [menu, setMenu] = useState<{
    kind: 'space' | 'chat';
    id: string;
    top: number;
    right: number;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: 'space' | 'chat'; id: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** The "+" opens a small menu: local folder or a remote SSH host. */
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  /** Set while the remote workspace dialog is open; holds the new workspace id. */
  const [remoteDialogId, setRemoteDialogId] = useState('');
  /** 总监选空间卡片里点了「添加在线空间」：连接成功后直接选这张卡。 */
  const directorPickRef = useRef('');
  /** Drag-to-reorder inside the workspace list; the array order is what gets saved. */
  const [dragSpaceId, setDragSpaceId] = useState<string | null>(null);
  const [dropSpaceAt, setDropSpaceAt] = useState<{ id: string; before: boolean } | null>(null);
  /** Same gesture for the task list; the written `order` field is what persists. */
  const [dragChatId, setDragChatId] = useState<string | null>(null);
  const [dropChatAt, setDropChatAt] = useState<{ id: string; before: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'space' | 'chat';
    id: string;
  } | null>(null);
  /**
   * Multi-select for the two lists. Only one kind can be selected at a time:
   * workspaces and tasks live side by side, and a bar in both panels at once
   * would make it unclear what 删除 applies to.
   */
  const [selection, setSelection] = useState<{
    kind: 'space' | 'chat';
    ids: Set<string>;
  } | null>(null);
  /** Batch delete waits for this second confirmation. */
  const [pendingBatch, setPendingBatch] = useState<{
    kind: 'space' | 'chat';
    ids: string[];
  } | null>(null);

  // A task selection belongs to one workspace; switching away drops it.
  useEffect(() => {
    setSelection((prev) => (prev?.kind === 'chat' ? null : prev));
  }, [activeWorkspaceId]);
  /**
   * Concurrent tasks can each ask something; the queue keeps prompts from
   * being overwritten, and the oldest unanswered one is shown first.
   */
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const permission = permissions[0] ?? null;
  const permissionQueue = useMemo(
    () =>
      permission
        ? permissions.filter((item) => item.requestId === permission.requestId)
        : [],
    [permission, permissions],
  );
  const question = questions[0] ?? null;
  /** Chats whose last plan-mode turn finished and can be executed. */
  const [planReady, setPlanReady] = useState<Set<string>>(() => new Set());
  const planRuns = useRef<Set<string>>(new Set());
  /**
   * 任务列表的红点：任务在用户没看它的时候跑完了。点开任务即清除。
   * 只记在内存里；用户主动停止的任务不算。
   */
  const [unreadChats, setUnreadChats] = useState<Set<string>>(() => new Set());
  /**
   * 总监派工建出来的员工任务收成一个折叠组：一次派工就有好几个，留展开状态
   * 会把用户自己建的任务挤出屏幕。折叠状态记在 localStorage，重启保持。
   */
  const [employeesOpen, setEmployeesOpen] = useState(() => {
    try {
      return window.localStorage.getItem('ezness.employeesOpen') === '1';
    } catch {
      return false;
    }
  });
  const activeChatIdRef = useRef<string | null>(activeChatId);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    if (!activeChatId) return;
    setUnreadChats((prev) => {
      if (!prev.has(activeChatId)) return prev;
      const next = new Set(prev);
      next.delete(activeChatId);
      return next;
    });
  }, [activeChatId]);

  const streamsRef = useRef(new Map<string, StreamEntry>());
  // Deltas are buffered per assistant message: with several tasks streaming at
  // once, one shared buffer would interleave their text.
  const deltaBuffers = useRef(
    new Map<string, { content: string; thinking: string; timer: number | null }>(),
  );
  const speedRef = useRef({ tokens: 0, sampled: 0, sampledAt: 0 });
  /** 所有正在跑的任务合在一起的输出速度；总监页底部显示这个数。 */
  const totalSpeedRef = useRef({ tokens: 0, sampled: 0, sampledAt: 0 });
  /** Last cumulative tool-call token count per `${messageId}:${toolName}`. */
  const toolProgressRef = useRef(new Map<string, number>());

  const activeWorkspace = workspaces.find((item) => item.id === activeWorkspaceId) ?? null;
  const activeHealth = activeWorkspace ? spaceHealth[activeWorkspace.id] : undefined;
  /** 总监视察任务时工具调用只带 taskId，这里补上任务本来的名字。 */
  const taskTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const chat of chats) map[chat.id] = chat.title;
    return map;
  }, [chats]);
  const workspaceChats = useMemo(
    () => chats.filter((chat) => chat.workspaceId === activeWorkspaceId),
    [chats, activeWorkspaceId],
  );

  const spaceKeyword = spaceQuery.trim().toLowerCase();
  const visibleWorkspaces = useMemo(() => {
    // 总监会话不是用户的工作空间，只出现在它自己的面板里。
    const named = workspaces.filter((workspace) => workspace.kind !== 'director');
    const list = spaceKeyword
      ? named.filter(
          (workspace) =>
            workspace.name.toLowerCase().includes(spaceKeyword) ||
            workspace.path.toLowerCase().includes(spaceKeyword),
        )
      : named;
    return [...list].sort(pinnedFirst);
  }, [workspaces, spaceKeyword]);
  const chatKeyword = chatQuery.trim().toLowerCase();
  // Search covers the transcript, not just the title: a task whose messages
  // mention the words is listed too, with a snippet showing where.
  // Building this index walks every message; `messages` changes on every
  // streamed token. Only pay for it while the task search box has a query.
  const messageTexts = useMemo(
    () => (chatKeyword ? textByConversation(messages) : NO_MESSAGE_TEXTS),
    [messages, chatKeyword],
  );
  const chatSnippets = useMemo(() => {
    const map = new Map<string, string>();
    if (!chatKeyword) return map;
    for (const chat of workspaceChats) {
      if (chat.title.toLowerCase().includes(chatKeyword)) continue;
      const snippet = findSnippet(messageTexts.get(chat.id), chatKeyword);
      if (snippet) map.set(chat.id, snippet);
    }
    return map;
  }, [workspaceChats, chatKeyword, messageTexts]);
  const visibleChats = useMemo(() => {
    const list = chatKeyword
      ? workspaceChats.filter(
          (chat) => chat.title.toLowerCase().includes(chatKeyword) || chatSnippets.has(chat.id),
        )
      : workspaceChats;
    // 置顶优先；手动拖过顺序的任务按 order 排；还没拖过的（order 为空）视为
    // 新任务，按最近活动时间排在它们上面。
    return [...list].sort((a, b) => {
      const pin = pinnedFirst(a, b);
      if (pin) return pin;
      if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
      if (a.order === undefined && b.order === undefined) return b.updatedAt - a.updatedAt;
      return a.order === undefined ? -1 : 1;
    });
  }, [workspaceChats, chatKeyword, chatSnippets]);
  // 总监派出的员工单独成组。置顶的员工留在普通列表里——用户主动置顶的东西
  // 不该再被藏起来。
  const isEmployeeChat = (chat: WorkspaceChat) => Boolean(chat.employee) && !chat.pinned;
  const ownChats = useMemo(
    () => visibleChats.filter((chat) => !isEmployeeChat(chat)),
    [visibleChats],
  );
  const employeeChats = useMemo(
    () => visibleChats.filter((chat) => isEmployeeChat(chat)),
    [visibleChats],
  );
  const menuPinned = menu
    ? Boolean(
        menu.kind === 'space'
          ? workspaces.find((workspace) => workspace.id === menu.id)?.pinned
          : chats.find((chat) => chat.id === menu.id)?.pinned,
      )
    : false;
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  // The dialog is mounted on these. A state reload can leave `chats` empty for
  // a render; without the last known pair the dialog would unmount mid-run and
  // look like it closed itself.
  const lastViz = useRef<{ workspace: Workspace; chat: WorkspaceChat } | null>(null);
  if (activeWorkspace && activeChat) lastViz.current = { workspace: activeWorkspace, chat: activeChat };
  const vizSpace = activeWorkspace ?? lastViz.current?.workspace ?? null;
  const vizChat = activeChat ?? lastViz.current?.chat ?? null;
  /** 可视化工具 uses the task's model when it is still available. */
  const vizTarget = vizChat
    ? resolveTarget(
        vizChat.model && models.some((item) => item.id === vizChat.model)
          ? vizChat.model
          : fallbackModel,
      )
    : null;
  /** Virtual editors have no user workspace and no general agent tools. */
  const activeEditorWorkspace =
    activeWorkspace?.kind === 'tool-editor' || activeWorkspace?.kind === 'agent-editor';
  /** The director chat is not a task: no permission switch, no Agent picker. */
  const activeDirectorWorkspace = activeWorkspace?.kind === 'director';
  const chatLocked = Boolean(activeEditorWorkspace || activeDirectorWorkspace);
  /** The task's own level wins; otherwise the global 工作设置 decides. */
  const askLevel: AskLevel = activeChat?.askLevel ?? work.askLevel;
  const activeMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.sessionId === activeChatId && isVisible(message),
      ),
    [messages, activeChatId],
  );

  /** 气泡弹窗跟着已跑任务走：任务被删/气泡被收起时，弹窗自然关掉。 */
  const bubbleTask = bubbleTaskId
    ? floatingTasks.find((item) => item.id === bubbleTaskId) ?? null
    : null;
  const bubbleMessages = useMemo(
    () =>
      bubbleTask
        ? messages.filter((message) => message.sessionId === bubbleTask.id && isVisible(message))
        : [],
    [messages, bubbleTask],
  );
  /** 打开气泡 = 亲临这个任务，总监在这期间不要往里塞指令。 */
  const bubblePresenceChat = bubbleTask
    ? chats.find((item) => item.id === bubbleTask.id) ?? null
    : null;
  /**
   * Task context lives in the agent's session file, not in this transcript, so
   * a text estimate here is off by an order of magnitude. The ledger records
   * the provider's own prompt count for every model request — use that.
   */
  useEffect(() => {
    if (!activeChatId) {
      setAgentContext(null);
      return;
    }
    let live = true;
    const request = window.ezness?.agentContext?.(activeChatId);
    if (request) {
      void request.then((info) => {
        if (!live) return;
        setAgentContext(info ? { sessionId: activeChatId, ...info } : null);
      });
    }
    return () => {
      live = false;
    };
  }, [activeChatId]);

  const activeContextUsed = useMemo(() => {
    const reported = contextTokensFromUsage(usage, activeChatId, 'workspace');
    const live =
      agentContext && agentContext.sessionId === activeChatId ? agentContext : null;
    const chat = chats.find((item) => item.id === activeChatId);
    const after = chat?.contextAfter;
    // A prediction made at compression time beats both the stale provider
    // count and the raw local estimate; the next real request replaces it.
    if (after && (!reported || reported.at < after.at)) return after.tokens;
    if (!reported) return live?.tokens ?? conversationTokens(activeMessages);
    const pending =
      agentCompactSaving &&
      agentCompactSaving.sessionId === activeChatId &&
      reported.at < agentCompactSaving.at
        ? Math.min(agentCompactSaving.saving, reported.used)
        : 0;
    if (pending > 0) return Math.max(0, reported.used - pending);
    // A compacted session whose estimate is far below the reported prompt can
    // only mean the file was rewritten after that request (manual compaction,
    // possibly before a restart). The estimate is the honest number until the
    // next request reports the real one.
    if (live?.digested && reported.used > live.tokens * 1.6) return live.tokens;
    return reported.used;
  }, [usage, activeChatId, activeMessages, agentCompactSaving, agentContext, chats]);

  /** Every request this task spent, for the header stats panel. */
  const activeSessionUsage = useMemo(
    () => usage.filter((record) => record.sessionId === activeChatId),
    [usage, activeChatId],
  );
  const activeStream = activeChatId
    ? activeStreams.find((stream) => stream.chatId === activeChatId) ?? null
    : null;
  const streamingId = activeStream?.messageId ?? null;

  /**
   * 总监页顶部：当前每个正在执行的任务这一轮花了多少。只算本轮开始后的
   * 用量记录，不把任务以前的历史算进来。
   */
  const activeUsageRows = useMemo<DirectorActiveUsage[]>(() => {
    if (activeStreams.length === 0) return [];
    const rows = new Map<string, DirectorActiveUsage>();
    const startedAt = new Map<string, number>();
    for (const stream of activeStreams) {
      const chat = chats.find((item) => item.id === stream.chatId);
      if (!chat) continue;
      startedAt.set(stream.chatId, Math.min(startedAt.get(stream.chatId) ?? Infinity, stream.startedAt));
      if (rows.has(stream.chatId)) continue;
      rows.set(stream.chatId, {
        taskId: stream.chatId,
        title: chat.title,
        cost: 0,
        unpriced: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      });
    }
    for (const record of usage) {
      const row = record.sessionId ? rows.get(record.sessionId) : undefined;
      if (!row || record.at < (startedAt.get(row.taskId) ?? 0)) continue;
      row.requests += 1;
      row.inputTokens += record.inputTokens || 0;
      row.outputTokens += record.outputTokens || 0;
      if (record.priced && typeof record.cost === 'number') row.cost += record.cost;
      else row.unpriced += 1;
    }
    return [...rows.values()];
  }, [usage, activeStreams, chats]);

  /** 总监选工作空间时列出的真实空间：本地文件夹 + 在线空间，不含虚拟空间。 */
  const directorSpaces = useMemo<DirectorWorkspaceOption[]>(
    () =>
      workspaces
        .filter(
          (space) => !space.kind || space.kind === 'folder' || space.kind === 'remote',
        )
        .map((space) => ({
          id: space.id,
          name: space.name,
          path: space.path,
          kind: space.kind === 'remote' ? ('remote' as const) : ('folder' as const),
          remote: space.remote,
        })),
    [workspaces],
  );

  /**
   * 任务列表的状态圆点，优先级：等待确认（黄）> 运行中（绿）> 已完成未查看（红）。
   * 权限/提问按 requestId 归属到发起它的任务；计划完成也归入黄色。
   */
  const chatActivity = useMemo(() => {
    const waiting = new Set<string>();
    for (const item of permissions) {
      const stream = activeStreams.find((entry) => entry.requestId === item.requestId);
      if (stream) waiting.add(stream.chatId);
    }
    for (const item of questions) {
      const stream = activeStreams.find((entry) => entry.requestId === item.requestId);
      if (stream) waiting.add(stream.chatId);
    }
    for (const id of planReady) waiting.add(id);

    const map = new Map<string, ActivityStatus>();
    for (const id of waiting) map.set(id, 'attention');
    for (const stream of activeStreams) {
      if (!map.has(stream.chatId)) map.set(stream.chatId, 'running');
    }
    for (const id of unreadChats) {
      if (!map.has(id)) map.set(id, 'done');
    }
    return map;
  }, [activeStreams, permissions, questions, planReady, unreadChats]);

  /**
   * 工作空间行上的圆点：它下面任意一个任务在跑/在等/跑完了没看，就把这件事
   * 冒泡到工作空间本身，不用点开也能看见。优先级与任务列表一致。
   */
  const spaceActivity = useMemo(() => {
    const rank: Record<ActivityStatus, number> = { done: 1, running: 2, attention: 3 };
    const map = new Map<string, ActivityStatus>();
    for (const chat of chats) {
      const status = chatActivity.get(chat.id);
      if (!status) continue;
      const current = map.get(chat.workspaceId);
      if (!current || rank[status] > rank[current]) map.set(chat.workspaceId, status);
    }
    return map;
  }, [chats, chatActivity]);

  // Keep the parent's warehouse-usage index in sync with this page. The ref
  // keeps the reporting effect from re-firing when the callback identity
  // changes on every parent render.
  const libraryRef = useRef(onLibraryChange);
  useEffect(() => {
    libraryRef.current = onLibraryChange;
  }, [onLibraryChange]);
  useEffect(() => {
    libraryRef.current?.({ workspaces, chats, messages });
  }, [workspaces, chats, messages]);

  // Workspaces, tasks and their transcripts are restored from
  // <data root>/workspaces.json on mount, then written back debounced. Without
  // this, every restart would forget which folder each task was working in.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await window.ezness?.workspaceLoad?.();
      if (!cancelled && data) {
        const savedWorkspaces = Array.isArray(data.workspaces) ? (data.workspaces as Workspace[]) : [];
        const savedChats = Array.isArray(data.chats) ? (data.chats as WorkspaceChat[]) : [];
        const savedMessages = (Array.isArray(data.messages) ? (data.messages as Message[]) : []).map(
          (message) =>
            Array.isArray(message.steps) && message.steps.some((step) => step.status === 'running')
              ? {
                  ...message,
                  // A step still marked running at load belonged to a process
                  // that died with the app; do not keep it spinning forever.
                  steps: message.steps.map((step) =>
                    step.status === 'running'
                      ? {
                          ...step,
                          status: 'error' as const,
                          result:
                            step.result ?? tRef.current('workspace.step.restartInterrupted'),
                          endedAt: step.endedAt ?? Date.now(),
                        }
                      : step,
                  ),
                }
              : message,
        );
        setWorkspaces(savedWorkspaces);
        setChats(savedChats);
        setMessages(savedMessages);
        const workspace =
          savedWorkspaces.find((item) => item.id === data.activeWorkspaceId) ?? savedWorkspaces[0];
        setActiveWorkspaceId(workspace?.id ?? null);
        const chat =
          savedChats.find((item) => item.id === data.activeChatId) ??
          savedChats.find((item) => item.workspaceId === workspace?.id) ??
          null;
        setActiveChatId(chat?.id ?? null);
        // Reopening the app where you left it should keep the director bar too.
        if (workspace?.kind === 'director') setPanel('director');
      }
      if (!cancelled) setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Keep every real workspace's reachability current. A local folder is gone,
   * or a remote host cannot be reached, and the sidebar marks it instead of
   * letting the next task fail with a raw tool error. Probes run on load, when
   * the window regains focus, and once a minute while visible — a live remote
   * connection answers with a single stat, so this stays cheap.
   */
  useEffect(() => {
    if (!restored) return;
    const targets = workspaces.filter(
      (space) => !space.kind || space.kind === 'folder' || space.kind === 'remote',
    );
    if (targets.length === 0) return;

    let cancelled = false;
    const probe = (space: Workspace) => {
      if (probingSpaces.current.has(space.id)) return;
      const request = window.ezness?.workspaceProbe?.({
        id: space.id,
        kind: space.kind === 'remote' ? 'remote' : 'folder',
        path: space.path,
        remote: space.remote,
      });
      if (!request) return;
      probingSpaces.current.add(space.id);
      void request
        .then((result) => {
          if (cancelled || !result) return;
          setSpaceHealth((prev) => ({
            ...prev,
            [space.id]: {
              ok: result.ok,
              reason: result.reason,
              error: result.error,
              at: Date.now(),
            },
          }));
        })
        .finally(() => {
          probingSpaces.current.delete(space.id);
        });
    };

    const run = () => targets.forEach(probe);
    run();
    const timer = window.setInterval(() => {
      if (!document.hidden) run();
    }, 60_000);
    window.addEventListener('focus', run);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
  }, [restored, workspaces]);

  /** 总监对话的 id；汇报会作为消息写进这条对话，不再是单独的收件箱界面。 */
  const directorChatId = useMemo(() => {
    const space = workspaces.find((item) => item.kind === 'director');
    return space ? chats.find((item) => item.workspaceId === space.id)?.id ?? null : null;
  }, [workspaces, chats]);

  // 清空对话时已经删掉的条目。收件箱刷新可能比清空晚一步返回旧数据，
  // 用这个集合挡住，免得刚清掉的汇报又被塞回对话。
  const clearedDirectorIds = useRef<Set<string>>(new Set());

  // 总监主动发来的每一条汇报，都追加到总监对话的消息流里。已存在的按 itemId
  // 就地更新（已批准/已回答），所以刷新、重启都不会重复。
  useEffect(() => {
    if (!restored || !directorChatId || !directorInbox?.items.length) return;
    const items = [...directorInbox.items]
      .filter((item) => !clearedDirectorIds.current.has(item.id))
      .sort((a, b) => a.at - b.at);
    setMessages((prev) => {
      const indexOf = new Map<string, number>();
      prev.forEach((message, index) => {
        if (message.sessionId === directorChatId && message.director) {
          indexOf.set(message.director.itemId, index);
        }
      });
      let changed = false;
      const next = [...prev];
      for (const item of items) {
        const existing = indexOf.get(item.id);
        if (existing === undefined) {
          // 历史收件箱第一次迁移过来时，按时间插到对话的对应位置。
          let at = next.length;
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const message = next[i];
            if (message.sessionId === directorChatId && message.createdAt <= item.at) {
              at = i + 1;
              break;
            }
          }
          next.splice(at, 0, {
            id: `director-${item.id}`,
            sessionId: directorChatId,
            role: 'assistant',
            content: item.body,
            createdAt: item.at,
            director: {
              itemId: item.id,
              kind: item.kind,
              speaker: item.speaker,
              title: item.title,
              status: item.status,
              resolution: item.resolution,
              actions: item.actions,
              taskId: item.taskId || undefined,
              taskTitle: item.taskTitle || undefined,
              read: item.read,
              files: item.files,
              needsRead: item.needsRead,
              mustRead: item.mustRead,
              payload: item.payload,
            },
          });
          indexOf.clear();
          next.forEach((message, index) => {
            if (message.sessionId === directorChatId && message.director) {
              indexOf.set(message.director.itemId, index);
            }
          });
          changed = true;
          continue;
        }
        const current = next[existing];
        const before = current.director;
        if (
          !before ||
          before.speaker !== item.speaker ||
          before.status !== item.status ||
          before.resolution !== item.resolution ||
          before.title !== item.title ||
          current.content !== item.body ||
          before.actions.length !== item.actions.length ||
          before.needsRead !== item.needsRead ||
          Boolean(before.mustRead) !== Boolean(item.mustRead) ||
          JSON.stringify(before.payload ?? null) !== JSON.stringify(item.payload ?? null) ||
          (before.files?.length ?? 0) !== (item.files?.length ?? 0)
        ) {
          next[existing] = {
            ...current,
            content: item.body,
            director: {
              itemId: item.id,
              kind: item.kind,
              speaker: item.speaker,
              title: item.title,
              status: item.status,
              resolution: item.resolution,
              actions: item.actions,
              taskId: item.taskId || undefined,
              taskTitle: item.taskTitle || undefined,
              read: item.read,
              files: item.files,
              needsRead: item.needsRead,
              mustRead: item.mustRead,
              payload: item.payload,
            },
          };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [restored, directorChatId, directorInbox]);

  // 一次派工真正收口后，总监写的计划就过期了。模型有时忘了回头勾最后几项，
  // 结果活都干完了，“待办”还挂在那里。以派工汇总为准：只要这份计划早于
  // 汇总，就整份收掉；汇总之后新写的计划（todosAt 更新）不受影响。
  // 有员工没通过验收的汇总不算收口，计划留着让用户看到问题。
  const planDoneAt = useMemo(() => {
    let latest = 0;
    for (const item of directorInbox?.items ?? []) {
      const settled =
        item.payload?.kind === 'plan-done' ||
        (/^分配/.test(item.title) && !/没通过/.test(item.title));
      if (settled) latest = Math.max(latest, item.at);
    }
    // 汇总条目可能已经被清空/删档，不能只靠收件箱：服务端记着项目收口时间。
    return Math.max(latest, Number(directorInbox?.planDoneAt) || 0);
  }, [directorInbox]);
  const planClearedAt = useRef(0);
  useEffect(() => {
    if (!restored || !directorChatId || planDoneAt <= planClearedAt.current) return;
    planClearedAt.current = planDoneAt;
    setChats((prev) => {
      let changed = false;
      const next = prev.map((chat) => {
        if (chat.id !== directorChatId) return chat;
        if (!chat.todos || chat.todos.length === 0) return chat;
        // 旧数据没有 todosAt：当作很早以前写的，让这次收口把它清掉。
        if ((chat.todosAt ?? 0) >= planDoneAt) return chat;
        changed = true;
        return { ...chat, todos: undefined, todosAt: planDoneAt };
      });
      return changed ? next : prev;
    });
  }, [restored, directorChatId, planDoneAt]);

  // 重启后不会有“还在跑”的计划：上一次结束却没勾完的清单留着只会误导。
  // 非总监对话统一收掉；总监自己的计划由上面的 planDoneAt 按派工收口处理。
  useEffect(() => {
    if (!restored) return;
    setChats((prev) => {
      let changed = false;
      const next = prev.map((chat) => {
        const list = Array.isArray(chat.todos) ? chat.todos : [];
        if (list.length === 0 || list.every((item) => item.status === 'completed')) return chat;
        const space = workspacesRef.current.find((item) => item.id === chat.workspaceId);
        if (space?.kind === 'director') return chat;
        changed = true;
        return { ...chat, todos: undefined, todosAt: Date.now() };
      });
      return changed ? next : prev;
    });
    // 只在刚加载完时清一次旧计划。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored]);

  // 总监面板开着就是在看汇报：红点不必等用户再点一次。待确认的计数不受影响。
  useEffect(() => {
    if (panel !== 'director' || !directorChatId || activeChatId !== directorChatId) return;
    if ((directorInbox?.unread ?? 0) === 0) return;
    const timer = window.setTimeout(() => {
      void window.ezness
        ?.directorMarkRead?.()
        .then(() => refreshDirector())
        .catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, activeChatId, directorChatId, directorInbox?.unread]);

  // 工作总监 state lives in the main process; this mirrors it for the panel and
  // the director's own conversation.
  useEffect(() => {
    let cancelled = false;
    const apply = (next: DirectorState | null) => {
      if (cancelled || !next) return;
      setDirector(next);
    };
    void window.ezness?.directorGet?.().then(apply).catch(() => undefined);
    const unsubscribe = window.ezness?.onDirectorEvent?.(apply);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  /**
   * 总监主动发来的汇报。收件箱的未读/待确认数是推送的，列表每 30 秒补一次，
   * 开销很小。
   */
  function refreshDirector() {
    void window.ezness
      ?.directorSnapshot?.()
      .then((snapshot) => {
        if (!snapshot) return;
        setDirectorInbox(snapshot.inbox);
      })
      .catch(() => undefined);
  }

  function refreshDirectorLedger() {
    void window.ezness
      ?.directorLedger?.(80)
      .then((result) => setDirectorLedger(result?.items ?? []))
      .catch(() => undefined);
  }

  useEffect(() => {
    refreshDirector();
    const offInbox = window.ezness?.onDirectorInbox?.((view) => {
      setDirectorInbox((prev) => ({ ...(prev ?? { items: [] }), ...view }));
      // The summary has no items; fetch the list once it changed.
      void window.ezness
        ?.directorInbox?.()
        .then((full) => setDirectorInbox(full))
        .catch(() => undefined);
    });
    const timer = window.setInterval(refreshDirector, 30_000);
    return () => {
      offInbox?.();
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 工作总监有自己的会话。打开总监面板就切进这条会话，离开时回到原来的任务。
   * 会话和工作空间都是普通条目（kind: 'director'），所以刷新后还在。
   */
  const lastTaskRef = useRef<{ workspaceId: string; chatId: string } | null>(null);

  function ensureDirectorChat(): { workspaceId: string; chatId: string } | null {
    let space = workspaces.find((item) => item.kind === 'director') ?? null;
    let chat = space
      ? chats.find((item) => item.workspaceId === space!.id) ?? null
      : null;

    if (!space) {
      const created: Workspace = {
        id: uid(),
        name: t('workspace.director.name'),
        path: '',
        kind: 'director',
        createdAt: Date.now(),
      };
      space = created;
      chat = {
        id: uid(),
        workspaceId: created.id,
        title: t('workspace.director.name'),
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextChat = chat;
      const nextSpace = created;
      setWorkspaces((prev) => [...prev, nextSpace]);
      setChats((prev) => [nextChat, ...prev]);
    } else if (!chat) {
      chat = {
        id: uid(),
        workspaceId: space.id,
        title: t('workspace.director.name'),
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextChat = chat;
      setChats((prev) => [nextChat, ...prev]);
    }
    return { workspaceId: space.id, chatId: chat.id };
  }

  useEffect(() => {
    if (!restored) return;
    const directorIds = new Set(
      workspaces.filter((item) => item.kind === 'director').map((item) => item.id),
    );
    const current = chats.find((item) => item.id === activeChatId) ?? null;
    const inDirectorChat = Boolean(current && directorIds.has(current.workspaceId));

    if (panel === 'director' && !inDirectorChat) {
      const previousSpace = workspaces.find((item) => item.id === activeWorkspaceId);
      const returnable =
        previousSpace &&
        previousSpace.kind !== 'tool-editor' &&
        previousSpace.kind !== 'agent-editor' &&
        previousSpace.kind !== 'director';
      if (current && returnable) {
        lastTaskRef.current = { workspaceId: previousSpace.id, chatId: current.id };
      }
      const target = ensureDirectorChat();
      if (!target) return;
      setActiveWorkspaceId(target.workspaceId);
      setActiveChatId(target.chatId);
      return;
    }

    if (panel !== 'director' && inDirectorChat) {
      const last = lastTaskRef.current;
      lastTaskRef.current = null;
      const space = last && workspaces.find((item) => item.id === last.workspaceId);
      const chat = last && chats.find((item) => item.id === last.chatId);
      if (space && chat) {
        setActiveWorkspaceId(space.id);
        setActiveChatId(chat.id);
      } else {
        // Nothing to restore (e.g. the app reopened straight into the director):
        // land on the most recent real task instead of the director's own chat.
        const fallback = chats
          .filter((item) => {
            const owner = workspaces.find((entry) => entry.id === item.workspaceId);
            return (
              owner &&
              owner.kind !== 'director' &&
              owner.kind !== 'tool-editor' &&
              owner.kind !== 'agent-editor'
            );
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (fallback) {
          setActiveWorkspaceId(fallback.workspaceId);
          setActiveChatId(fallback.id);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, restored, activeChatId, activeWorkspaceId, chats, workspaces]);

  /**
   * 总监的“所有权”就是用户站在哪：进任务就归你，离开就自动回到总监。
   * 主进程只记一个 presence，并让它过期，避免崩溃后任务被永远锁在人手里。
   */
  const presenceRef = useRef('');
  useEffect(() => {
    if (!restored) return;
    const chat =
      bubblePresenceChat ?? chats.find((item) => item.id === activeChatId) ?? null;
    const space = chat ? workspaces.find((item) => item.id === chat.workspaceId) ?? null : null;
    const taskLike =
      chat &&
      space &&
      space.kind !== 'director' &&
      space.kind !== 'tool-editor' &&
      space.kind !== 'agent-editor';
    const next = taskLike
      ? { sessionId: chat!.id, workspaceId: space!.id }
      : { sessionId: null };
    const key = next.sessionId ? `${next.sessionId}|${next.workspaceId}` : '';
    if (key === presenceRef.current) return;
    presenceRef.current = key;
    void window.ezness?.directorPresence?.(next)?.catch(() => undefined);
  }, [restored, activeChatId, chats, workspaces, bubblePresenceChat]);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setInterval(() => {
      const key = presenceRef.current;
      if (!key) return;
      const [sessionId, workspaceId] = key.split('|');
      void window.ezness
        ?.directorPresence?.({ sessionId, workspaceId })
        ?.catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [restored]);

  /**
   * 总监的任务板。主进程不读聊天记录，所以这里把每个任务的 id、标题、空间和
   * 是否在生成推过去；只在必要时变更，并每 30 秒补一次。
   */
  const directorBoard = useMemo<DirectorTaskRef[]>(
    () =>
      chats.flatMap((chat) => {
        const space = workspaces.find((item) => item.id === chat.workspaceId);
        if (
          !space ||
          space.kind === 'director' ||
          space.kind === 'tool-editor' ||
          space.kind === 'agent-editor'
        ) {
          return [];
        }
        const busy = activeStreams.some((stream) => stream.chatId === chat.id);
        return [
          {
            id: chat.id,
            title: chat.title,
            space: space.name,
            workspaceId: space.id,
            workspacePath: space.path,
            busy,
            status: busy ? 'running' : undefined,
            askLevel: chat.askLevel ?? work.askLevel,
            updatedAt: chat.updatedAt,
          },
        ];
      }),
    [chats, workspaces, activeStreams, work.askLevel],
  );

  /** 分管空间本身（id/名称/路径）：任务全删光时总监也要能看空间里还剩什么。 */
  const directorSpacesBoard = useMemo<DirectorSpaceRef[]>(
    () =>
      workspaces
        .filter(
          (space) =>
            space.kind !== 'director' &&
            space.kind !== 'tool-editor' &&
            space.kind !== 'agent-editor',
        )
        .map((space) => ({ id: space.id, name: space.name, path: space.path })),
    [workspaces],
  );

  useEffect(() => {
    if (!restored) return;
    const push = () => {
      void window.ezness
        ?.directorSync?.(directorBoard, directorSpacesBoard)
        ?.catch(() => undefined);
    };
    push();
    const timer = window.setInterval(push, 30_000);
    return () => window.clearInterval(timer);
  }, [restored, directorBoard, directorSpacesBoard]);

  /**
   * 总监下发的指令：主进程决定什么时候可以开始（工人空闲、用户不在场），
   * 这里只负责把它像用户消息一样送进对应任务的 run。
   */
  const chatsRef = useRef<WorkspaceChat[]>(chats);
  chatsRef.current = chats;
  const workspacesRef = useRef<Workspace[]>(workspaces);
  workspacesRef.current = workspaces;
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const modelsRef = useRef<ModelOption[]>(models);
  modelsRef.current = models;
  const removeTargetsRef = useRef<(kind: 'space' | 'chat', ids: string[]) => void>(() => {});
  const handleSendRef = useRef<
    | ((
        text: string,
        attachments?: WarehouseItem[],
        modeOverride?: PermissionMode,
        forChatId?: string,
      ) => Promise<void>)
    | null
  >(null);
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  useEffect(() => {
    const off = window.ezness?.onDirectorInstruction?.((payload) => {
      const instruction = payload?.instruction;
      if (!instruction?.id) return;
      const chat = chatsRef.current.find((item) => item.id === instruction.taskId);
      if (!chat) {
        void window.ezness
          ?.directorInstructionAck?.({
            id: instruction.id,
            ok: false,
            error: tRef.current('workspace.error.taskGone'),
          })
          ?.catch(() => undefined);
        return;
      }
      const text = `【工作总监】${instruction.text}\n\n（这是工作总监下发的指令，不是用户本人。按指令执行；完成后用一句话说明结果和验证情况。）`;
      void window.ezness
        ?.directorInstructionAck?.({ id: instruction.id, ok: true })
        ?.catch(() => undefined);
      void handleSendRef.current?.(text, [], undefined, chat.id);
    });
    return () => off?.();
  }, []);

  /**
   * 总监派工：在这里把员工任务真正建出来（任务归界面所有），再把 taskId
   * 交回主进程；后续的开跑、验收、返工复用普通的指令队列。
   */
  useEffect(() => {
    const off = window.ezness?.onDirectorSpawn?.((payload) => {
      const dispatchId = String(payload?.dispatchId ?? '');
      if (!dispatchId) return;
      const spaces = workspacesRef.current;
      const space = spaces.find((item) => item.id === payload.workspaceId) ?? null;
      const fresh: WorkspaceChat[] = [];
      const results: DirectorSpawnResult[] = [];
      for (const employee of Array.isArray(payload.employees) ? payload.employees : []) {
        if (!employee?.employeeId) continue;
        if (!space) {
          results.push({
            employeeId: employee.employeeId,
            ok: false,
            error: tRef.current('workspace.error.spaceGone'),
          });
          continue;
        }
        const firstLine = String(employee.task ?? '')
          .split('\n')[0]
          .replace(/\s+/g, ' ')
          .trim();
        const title = `${employee.name} · ${firstLine || tRef.current('workspace.taskFallback')}`.slice(0, 60);
        const categoryIds = Array.isArray(employee.kbCategoryIds)
          ? employee.kbCategoryIds
          : [];
        const dataAccess: WorkspaceDataAccess | undefined =
          categoryIds.length > 0 || employee.useWarehouse
            ? {
                ...(categoryIds.length > 0
                  ? { kb: { enabled: true, categoryIds } }
                  : {}),
                ...(employee.useWarehouse ? { warehouse: true } : {}),
              }
            : undefined;
        const agent = employee.agentId
          ? agents.find((item) => item.id === employee.agentId)
          : null;
        const chat: WorkspaceChat = {
          id: uid(),
          workspaceId: space.id,
          title,
          updatedAt: Date.now(),
          model: employee.model || fallbackModel,
          employee: employee.name,
          dispatchId,
          agentId: agent?.id,
          dataAccess,
          kb: {
            enabled: false,
            categoryId: null,
            mode: 'balanced',
            webMode: employee.web === 'off' || employee.web === 'always' ? employee.web : 'auto',
          },
        };
        fresh.push(chat);
        results.push({
          employeeId: employee.employeeId,
          ok: true,
          taskId: chat.id,
          title,
          space: space.name,
          workspaceId: space.id,
          workspacePath: space.path,
        });
      }
      if (fresh.length > 0) {
        // 回执一到，主进程会立刻投递员工指令；指令处理按 chatsRef 找任务，
        // 所以先把它同步进去，不等 React 这一轮渲染。
        chatsRef.current = [...fresh, ...chatsRef.current];
        setChats((prev) => [...fresh, ...prev]);
      }
      void window.ezness
        ?.directorSpawnAck?.({ dispatchId, items: results })
        ?.catch(() => undefined);
    });
    return () => off?.();
  }, [agents, fallbackModel]);

  /**
   * 总监对任务本身的操作（置顶/取消置顶、重命名、导出 Markdown、删除）。
   * 任务归界面所有，主进程只能广播；删除在主进程已经过了用户的确认卡。
   */
  useEffect(() => {
    const off = window.ezness?.onDirectorTaskAction?.((payload: DirectorTaskAction) => {
      const action = payload?.action;
      const ids = (Array.isArray(payload?.taskIds) ? payload.taskIds : [])
        .map((id) => String(id))
        .filter(Boolean);
      if (!action || ids.length === 0) return;

      // 总监叫停：和用户按「停止」一样，只中断这一轮，任务和文件都留着。
      if (action === 'stop') {
        for (const id of ids) {
          const stream = [...streamsRef.current.values()].find((item) => item.chatId === id);
          if (stream) void window.ezness?.agentAbort?.(stream.requestId);
        }
        return;
      }

      if (action === 'pin' || action === 'unpin') {
        const pinned = action === 'pin';
        setChats((prev) =>
          prev.map((chat) => (ids.includes(chat.id) ? { ...chat, pinned } : chat)),
        );
        return;
      }

      if (action === 'rename') {
        const title = String(payload?.title ?? '').trim();
        if (!title) return;
        setChats((prev) =>
          prev.map((chat) =>
            ids.includes(chat.id) ? { ...chat, title, updatedAt: Date.now() } : chat,
          ),
        );
        return;
      }

      if (action === 'delete') {
        const titles = chatsRef.current
          .filter((chat) => ids.includes(chat.id))
          .map((chat) => chat.title);
        removeTargetsRef.current('chat', ids);
        void window.ezness
          ?.directorTaskAck?.({ opId: payload?.opId, ok: true, deleted: titles })
          ?.catch(() => undefined);
        return;
      }

      if (action === 'export') {
        void (async () => {
          const files: Array<{ taskId: string; path: string; name: string }> = [];
          const failures: string[] = [];
          for (const id of ids) {
            const chat = chatsRef.current.find((item) => item.id === id);
            if (!chat) {
              failures.push(tRef.current('workspace.error.taskGone'));
              continue;
            }
            const label =
              modelsRef.current.find((option) => option.id === chat.model)?.label ??
              tRef.current('workspace.modelUnspecified');
            // 优先写进任务所在的工作空间；路径不可用（远程空间等）时主进程落到 exports/。
            const folder =
              workspacesRef.current.find((item) => item.id === chat.workspaceId)?.path ?? '';
            const result = await window.ezness?.exportSession?.({
              title: chat.title || tRef.current('workspace.taskFallback'),
              markdown: buildSessionMarkdown(chat, messagesRef.current, label),
              folder,
            });
            if (result?.ok && result.path) {
              files.push({
                taskId: chat.id,
                path: result.path,
                name:
                  result.path.split(/[\\/]/).pop() ||
                  `${chat.title || tRef.current('workspace.taskFallback')}.md`,
              });
            } else if (!result?.canceled) {
              failures.push(
                result?.error || chat.title || tRef.current('workspace.export.failed'),
              );
            }
          }
          await window.ezness
            ?.directorTaskAck?.({
              opId: payload?.opId,
              ok: files.length > 0,
              files,
              error: failures.join('；'),
            })
            ?.catch(() => undefined);
        })();
      }
    });
    return () => off?.();
  }, []);

  /** 从汇报里跳进对应任务，并把总监面板收起来。 */
  /**
   * 清空总监对话：旧记录先由主进程留档（含原始会话），模型上下文一起删；
   * 只把还没处理、需要用户点按钮的待确认消息留在对话里。
   */
  async function clearDirectorHistory(): Promise<boolean> {
    if (!directorChatId) {
      flash(t('workspace.director.noChat'));
      return false;
    }
    if (streamingId === directorChatId) {
      flash(t('workspace.director.waitToClear'));
      return false;
    }
    const current = messages.filter((message) => message.sessionId === directorChatId);
    if (current.length === 0) {
      flash(t('workspace.director.alreadyEmpty'));
      return false;
    }
    let result: { ok: boolean; id?: string; keep?: string[] | null; error?: string } | undefined;
    try {
      result = await window.ezness?.directorClear?.({
        sessionId: directorChatId,
        messages: current,
      });
    } catch (error) {
      flash(
        t('workspace.director.clearFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
    if (!result?.ok) {
      flash(result?.error ?? t('workspace.director.clearFailedShort'));
      return false;
    }
    // 以主进程清空后的收件箱为准：已经处理过的确认（已确认/已放弃/已回答…）
    // 即使本地状态还没来得及刷新，也不会被留下。
    const keepIds = Array.isArray(result.keep) ? new Set(result.keep) : null;
    const keep = current.filter((message) =>
      keepIds
        ? Boolean(message.director?.itemId && keepIds.has(message.director.itemId))
        : Boolean(
            message.director &&
              message.director.status === 'open' &&
              !message.director.resolution &&
              message.director.actions.length > 0,
          ),
    );
    const keptIds = new Set(keep.map((message) => message.director?.itemId));
    for (const message of current) {
      const itemId = message.director?.itemId;
      if (itemId && !keptIds.has(itemId)) clearedDirectorIds.current.add(itemId);
    }
    setMessages((prev) => [
      ...prev.filter((message) => message.sessionId !== directorChatId),
      ...keep,
    ]);
    flash(
      keep.length > 0
        ? t('workspace.director.clearedWithKeep')
        : t('workspace.director.cleared'),
    );
    return true;
  }

  /** 总监对话里的汇报卡片：批准/回答/忽略，和以前的汇报面板是同一个入口。 */
  async function actDirector(itemId: string, action: string, value?: string) {
    // 选工作空间 = 用户当面授权：先把这个空间交给总监写入，再让它派工。
    if (action === 'choose' && value) {
      const saved = await window.ezness?.directorSave?.({
        spaces: { [value]: 'write' },
      });
      if (!saved?.ok) {
        flash(saved?.error ?? t('workspace.director.authFailed'));
        return;
      }
      refreshDirector();
    }
    // 换模型：先把任务自己的模型换掉（同步更新 ref，指令回执可能赶在渲染前到），
    // 再让总监把原来的要求重排一遍。
    let retryTaskId = '';
    if (action === 'choose-model' && value) {
      const item = directorInbox?.items.find((entry) => entry.id === itemId);
      // 收件箱只保留最近 80 条；老卡片从对话消息里拿同样的 payload。
      const card = item
        ? null
        : messages.find((message) => message.director?.itemId === itemId)?.director;
      retryTaskId = String(
        item?.payload?.taskId ?? item?.taskId ?? card?.payload?.taskId ?? card?.taskId ?? '',
      );
      if (retryTaskId) {
        const next = chatsRef.current.map((chat) =>
          chat.id === retryTaskId ? { ...chat, model: value } : chat,
        );
        chatsRef.current = next;
        setChats(next);
      }
    }
    const result = await window.ezness?.directorResolve?.({ id: itemId, action, value });
    if (!result?.ok) {
      flash(result?.error ?? t('workspace.director.actionFailed'));
      return;
    }
    if (result.openTask) openDirectorTask(result.openTask);
    if (action === 'choose-model') {
      // 用户自己跑的那轮没有总监指令可重排：拿回原话，像刚发出去一样再跑一次。
      if (result.retryText && retryTaskId) {
        void handleSendRef.current?.(result.retryText, [], undefined, retryTaskId);
        flash(t('workspace.director.modelSwitched'));
      } else {
        flash(
          result.retried
            ? t('workspace.director.modelSwitched')
            : t('workspace.director.modelSwitchedResend'),
        );
      }
    }
    refreshDirector();
  }

  function openDirectorTask(taskId: string) {
    const chat = chats.find((item) => item.id === taskId);
    if (!chat) return;
    const space = workspaces.find((item) => item.id === chat.workspaceId);
    if (
      !space ||
      space.kind === 'director' ||
      space.kind === 'tool-editor' ||
      space.kind === 'agent-editor'
    ) {
      return;
    }
    lastTaskRef.current = { workspaceId: space.id, chatId: chat.id };
    setActiveWorkspaceId(space.id);
    setActiveChatId(chat.id);
    setPanel('work');
  }

  const saveTimer = useRef(0);
  useEffect(() => {
    if (!restored) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void window.ezness?.workspaceSave?.({
        workspaces,
        chats,
        messages,
        activeWorkspaceId,
        activeChatId,
      });
    }, 500);
  }, [restored, workspaces, chats, messages, activeWorkspaceId, activeChatId]);

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  // Agents live in the Agent page; the composer only needs the list when its
  // picker is opened, but loading once on mount keeps the chip label correct
  // after a restart (a task remembers which Agent it was using).
  const refreshAgents = () => {
    void window.ezness?.agentsList?.().then((list) => {
      if (Array.isArray(list)) setAgents(list);
    });
  };
  useEffect(() => {
    refreshAgents();
  }, []);

  // Ctrl+R reloads this page, but the agent keeps running in the main process.
  // Reattach to those runs; without this the transcript freezes at the last
  // saved delta, permission prompts never come back, and the task looks dead.
  useEffect(() => {
    if (!restored) return;
    let cancelled = false;
    void (async () => {
      const runs: AgentRunSnapshot[] | undefined = await window.ezness?.agentActive?.();
      if (cancelled || !Array.isArray(runs) || runs.length === 0) return;

      const live = runs.filter((run) => run.status === 'running');
      const settled = runs.filter((run) => run.status !== 'running');
      const now = Date.now();

      setMessages((prev) => {
        let next = prev;
        for (const run of [...live, ...settled]) {
          const messageId =
            run.messageId ?? (run.status === 'running' ? `resume-${run.requestId}` : '');
          if (!messageId) continue;
          if (next === prev) next = [...prev];

          let at = next.findIndex((message) => message.id === messageId);

          // A reload right after sending can beat the 500ms transcript save.
          // Restore the user's turn too so the exchange stays in order.
          const userMissing =
            Boolean(run.userMessageId) &&
            !next.some((message) => message.id === run.userMessageId) &&
            !next.some(
              (message) =>
                message.sessionId === run.sessionId &&
                message.role === 'user' &&
                Math.abs((message.createdAt ?? 0) - run.startedAt) < 15000,
            );
          if (userMissing) {
            const insertAt = at === -1 ? next.length : at;
            next.splice(insertAt, 0, {
              id: run.userMessageId as string,
              sessionId: run.sessionId,
              role: 'user',
              content: run.userMessage ?? '',
              createdAt: run.startedAt - 1,
            });
            if (at !== -1) at += 1;
          }

          const existing = at === -1 ? null : next[at];
          let content = run.content;
          let stopped = false;
          let steps = run.steps.length > 0 ? run.steps : existing?.steps;

          if (run.status === 'aborted') {
            stopped = true;
            content = content || tRef.current('workspace.chat.stopped');
            steps = steps?.map((step) =>
              step.status === 'running'
                ? {
                    ...step,
                    status: 'error' as const,
                    result: step.result ?? tRef.current('workspace.chat.interrupted'),
                    endedAt: step.endedAt ?? now,
                  }
                : step,
            );
          } else if (run.status === 'error') {
            const note = tRef.current('workspace.chat.modelFailed', {
              error: run.error || tRef.current('workspace.chat.unknownError'),
            });
            content = content ? `${content}\n\n${note}` : note;
          } else if (run.status === 'done' && !content.trim() && !steps?.length) {
            content = tRef.current('workspace.chat.emptyReply');
          }

          const message: Message = {
            id: messageId,
            sessionId: run.sessionId,
            role: 'assistant',
            content,
            thinking: run.thinking || existing?.thinking,
            steps,
            stopped,
            createdAt: existing?.createdAt ?? run.startedAt,
          };
          if (at === -1) next.push(message);
          else next[at] = { ...(existing ?? message), ...message };
        }
        return next;
      });

      // Prompts the user never saw because the reload happened under them.
      const pendingPermissions = live.flatMap((run) => run.permissions);
      if (pendingPermissions.length > 0) {
        setPermissions((prev) => [
          ...prev,
          ...pendingPermissions.filter(
            (item) =>
              !prev.some(
                (known) => known.requestId === item.requestId && known.callId === item.callId,
              ),
          ),
        ]);
      }
      const pendingQuestions = live.flatMap((run) => run.questions);
      if (pendingQuestions.length > 0) {
        setQuestions((prev) => [
          ...prev,
          ...pendingQuestions.filter(
            (item) =>
              !prev.some(
                (known) => known.requestId === item.requestId && known.callId === item.callId,
              ),
          ),
        ]);
      }

      for (const run of live) {
        streamsRef.current.set(run.requestId, {
          requestId: run.requestId,
          messageId: run.messageId ?? `resume-${run.requestId}`,
          chatId: run.sessionId,
          startedAt: Number(run.startedAt) || Date.now(),
        });
        touchFloating(run.sessionId, 'running');
        if (run.todos) {
          const todos = run.todos;
          setChats((prev) =>
            prev.map((chat) =>
              chat.id === run.sessionId ? { ...chat, todos, todosAt: Date.now() } : chat,
            ),
          );
        }
        if (run.mode === 'plan') planRuns.current.add(run.sessionId);
      }
      for (const run of settled) {
        if (run.status === 'done' && run.mode === 'plan') {
          setPlanReady((prev) => new Set(prev).add(run.sessionId));
        }
      }

      if (live.length > 0) {
        syncStreams();
        speedRef.current = { tokens: 0, sampled: 0, sampledAt: now };
        toolProgressRef.current.clear();
        setStreamSpeed(null);
        setPhase('generating');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restored]);

  // A warehouse jump opens the right workspace and chat first; ChatView then
  // scrolls to the turn via its own focus prop.
  useEffect(() => {
    if (!focus) return;
    if (!workspaces.some((item) => item.id === focus.workspaceId)) return;
    if (!chats.some((item) => item.id === focus.chatId)) return;
    setActiveWorkspaceId(focus.workspaceId);
    setActiveChatId(focus.chatId);
  }, [focus, workspaces, chats]);

  const chatFocus = useMemo(
    () =>
      focus && focus.chatId === activeChatId
        ? { messageId: focus.messageId, nonce: focus.nonce }
        : null,
    [focus, activeChatId],
  );

  /**
   * A local opening message for the editing workspace. It is not generated by
   * the model: the health snapshot is deterministic and must be visible even
   * when no provider is configured.
   */
  async function toolEditorIntro(categoryName: string): Promise<string> {
    const api = window.ezness;
    const defs = (await api?.agentCustomTools?.()) ?? [];
    const health: ToolHealthMap = (await api?.agentToolHealth?.()) ?? {};
    const broken = defs.filter(
      (definition) =>
        definition.category === categoryName && health?.[definition.id]?.status === 'broken',
    );
    const translate = tRef.current;
    if (broken.length === 0) {
      return [
        translate('workspace.editor.toolTag'),
        translate('workspace.editor.toolOk', { name: categoryName }),
        translate('workspace.editor.toolOkHint'),
      ].join('\n');
    }
    const lines = [
      translate('workspace.editor.toolTag'),
      translate('workspace.editor.toolBroken', {
        name: categoryName,
        count: broken.length,
      }),
    ];
    for (const definition of broken) {
      const error =
        health?.[definition.id]?.errors?.[0]?.message ??
        translate('workspace.editor.toolTestFailed');
      lines.push(translate('workspace.editor.toolErrorLine', { name: definition.name, error }));
    }
    lines.push(''), lines.push(translate('workspace.editor.toolFixAsk'));
    return lines.join('\n');
  }

  const appliedToolEditorFocus = useRef(0);

  // AI能力 → 功能编辑-<分类>. The workspace is virtual (no folder); the main
  // process binds the conversation to the category id and only exposes the
  // tool-editor tools for it.
  useEffect(() => {
    if (!toolEditorFocus || !restored) return;
    if (appliedToolEditorFocus.current === toolEditorFocus.nonce) return;
    appliedToolEditorFocus.current = toolEditorFocus.nonce;

    const { categoryId, categoryName } = toolEditorFocus;
    const workspaceName = tRef.current('workspace.editor.toolWorkspaceName', {
      name: categoryName,
    });
    const existingSpace = workspaces.find(
      (item) => item.kind === 'tool-editor' && item.categoryId === categoryId,
    );
    let space = existingSpace ?? null;
    let chat = space
      ? chats.find((item) => item.workspaceId === space!.id) ?? null
      : null;

    if (!space) {
      space = {
        id: uid(),
        name: workspaceName,
        path: '',
        kind: 'tool-editor',
        categoryId,
        categoryName,
        createdAt: Date.now(),
      };
      chat = {
        id: uid(),
        workspaceId: space.id,
        title: workspaceName,
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextSpace = space;
      const nextChat = chat;
      setWorkspaces((prev) => [...prev, nextSpace]);
      setChats((prev) => [nextChat, ...prev]);
    } else if (space.name !== workspaceName || space.categoryName !== categoryName) {
      const spaceId = space.id;
      setWorkspaces((prev) =>
        prev.map((item) =>
          item.id === spaceId
            ? { ...item, name: workspaceName, categoryName }
            : item,
        ),
      );
    }

    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: space.id,
        title: workspaceName,
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextChat = chat;
      setChats((prev) => [nextChat, ...prev]);
    }

    const activeSpace = space;
    const activeChat = chat;
    setActiveWorkspaceId(activeSpace.id);
    setActiveChatId(activeChat.id);
    setSpaceQuery('');
    setChatQuery('');

    void (async () => {
      const text = await toolEditorIntro(categoryName);
      setMessages((prev) => {
        if (
          prev.some(
            (message) =>
              message.sessionId === activeChat.id && message.id === TOOL_EDITOR_INTRO_ID,
          )
        ) {
          return prev;
        }
        return [
          ...prev,
          {
            id: TOOL_EDITOR_INTRO_ID,
            sessionId: activeChat.id,
            role: 'assistant' as const,
            content: text,
            createdAt: Date.now(),
          },
        ];
      });
    })();
  }, [toolEditorFocus, restored, workspaces, chats, fallbackModel]);

  /**
   * The Agent editor's opening note. Like the tool editor's, it is local text:
   * it must show even when no provider is configured.
   */
  function agentEditorIntro(agentName: string): string {
    const translate = tRef.current;
    return [
      translate('workspace.editor.agentTag'),
      translate('workspace.editor.agentIntro', { name: agentName }),
      translate('workspace.editor.agentScope'),
      translate('workspace.editor.agentSaved'),
    ].join('\n');
  }

  const appliedAgentEditorFocus = useRef(0);

  // Agent → Agent编辑-<hash>. The workspace is virtual (no folder); the main
  // process binds the conversation to one agent id and only exposes
  // agent_editor_get / agent_editor_update, so nothing else can be touched.
  useEffect(() => {
    if (!agentEditorFocus || !restored) return;
    if (appliedAgentEditorFocus.current === agentEditorFocus.nonce) return;
    appliedAgentEditorFocus.current = agentEditorFocus.nonce;

    const { agentId, agentName } = agentEditorFocus;
    const workspaceName = tRef.current('workspace.editor.agentWorkspaceName', {
      hash: agentHash(agentId),
    });
    const existingSpace = workspaces.find(
      (item) => item.kind === 'agent-editor' && item.agentId === agentId,
    );
    let space = existingSpace ?? null;
    let chat = space ? chats.find((item) => item.workspaceId === space!.id) ?? null : null;

    if (!space) {
      space = {
        id: uid(),
        name: workspaceName,
        path: '',
        kind: 'agent-editor',
        agentId,
        agentName,
        createdAt: Date.now(),
      };
      chat = {
        id: uid(),
        workspaceId: space.id,
        title: workspaceName,
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextSpace = space;
      const nextChat = chat;
      setWorkspaces((prev) => [...prev, nextSpace]);
      setChats((prev) => [nextChat, ...prev]);
    } else if (space.name !== workspaceName || space.agentName !== agentName) {
      const spaceId = space.id;
      setWorkspaces((prev) =>
        prev.map((item) =>
          item.id === spaceId ? { ...item, name: workspaceName, agentName } : item,
        ),
      );
    }

    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: space.id,
        title: workspaceName,
        updatedAt: Date.now(),
        model: fallbackModel,
      };
      const nextChat = chat;
      setChats((prev) => [nextChat, ...prev]);
    }

    const activeSpace = space;
    const activeChat = chat;
    setActiveWorkspaceId(activeSpace.id);
    setActiveChatId(activeChat.id);
    setSpaceQuery('');
    setChatQuery('');

    setMessages((prev) => {
      if (
        prev.some(
          (message) =>
            message.sessionId === activeChat.id && message.id === AGENT_EDITOR_INTRO_ID,
        )
      ) {
        return prev;
      }
      return [
        ...prev,
        {
          id: AGENT_EDITOR_INTRO_ID,
          sessionId: activeChat.id,
          role: 'assistant' as const,
          content: agentEditorIntro(agentName),
          createdAt: Date.now(),
        },
      ];
    });
  }, [agentEditorFocus, restored, workspaces, chats, fallbackModel]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);

  // A chat keeps pointing at the default model until the user picks another.
  const model = activeChat && models.some((item) => item.id === activeChat.model)
    ? activeChat.model
    : fallbackModel;

  const chatKb: KbChatSettings = (() => {
    const merged: KbChatSettings & { web?: boolean } = {
      ...DEFAULT_CHAT_KB,
      ...(activeChat?.kb ?? {}),
      // The workspace composer has no knowledge-base switch; only 联网 is shared.
      enabled: false,
      categoryId: null,
      mode: 'balanced',
      webMode: readWebMode(activeChat?.kb, web.defaultMode),
    };
    // Old saves used a boolean `web`; do not let it travel back into the menu.
    delete merged.web;
    return merged;
  })();

  function flash(message: string) {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200);
  }

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // Late-loaded settings can leave new chats on an empty model id.
  useEffect(() => {
    if (!fallbackModel) return;
    setChats((prev) => {
      let changed = false;
      const next = prev.map((chat) => {
        if (chat.model && models.some((item) => item.id === chat.model)) return chat;
        changed = true;
        return { ...chat, model: fallbackModel };
      });
      return changed ? next : prev;
    });
  }, [fallbackModel, models]);

  function syncStreams() {
    setActiveStreams([...streamsRef.current.values()]);
  }

  /** 跑起来就出现在左侧；跑完只改状态，等用户点过才移除。 */
  function touchFloating(chatId: string, status: FloatingStatus) {
    // 用户已经点过这个任务：这一轮结束别再把它冒出来；下一轮开始才重新出现。
    if (status === 'running') dismissedFloating.current.delete(chatId);
    else if (dismissedFloating.current.has(chatId)) return;
    const chat = chatsRef.current.find((item) => item.id === chatId);
    if (!chat) return;
    const space = workspacesRef.current.find((item) => item.id === chat.workspaceId);
    // 总监自己的对话和两个编辑器不是「任务」，不上浮。
    if (
      !space ||
      space.kind === 'director' ||
      space.kind === 'tool-editor' ||
      space.kind === 'agent-editor'
    ) {
      return;
    }
    setFloatingTasks((prev) => {
      const existing = prev.find((item) => item.id === chatId);
      if (existing) {
        return prev.map((item) =>
          item.id === chatId
            ? { ...item, title: chat?.title || item.title, status }
            : item,
        );
      }
      return [
        ...prev,
        { id: chatId, title: chat?.title || tRef.current('workspace.chat.untitledTask'), status },
      ];
    });
  }

  /** 收起一个已经不跑了的胶囊；还在跑的收不掉（跑完还要提醒用户）。 */
  function dismissFloatingTask(taskId: string) {
    const task = floatingTasks.find((item) => item.id === taskId);
    if (!task || task.status === 'running') return;
    dismissedFloating.current.add(taskId);
    setFloatingTasks((prev) => prev.filter((item) => item.id !== taskId));
  }

  function openFloatingTask(taskId: string) {
    // 还在跑的任务只是跳过去看看，气泡留着（跑完还要提醒我）；
    // 已经跑完/出错/停下的，点过才算处理完，气泡收起。
    dismissFloatingTask(taskId);
    openDirectorTask(taskId);
  }

  function dropDeltaBuffer(messageId: string) {
    const buffer = deltaBuffers.current.get(messageId);
    if (!buffer) return;
    if (buffer.timer !== null) window.clearTimeout(buffer.timer);
    deltaBuffers.current.delete(messageId);
  }

  function flushDeltas(messageId: string) {
    const buffer = deltaBuffers.current.get(messageId);
    if (!buffer) return;
    if (buffer.timer !== null) {
      window.clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (!buffer.content && !buffer.thinking) return;

    const { content, thinking } = buffer;
    buffer.content = '';
    buffer.thinking = '';

    // Only the streaming bubble listens to this; the task list and the
    // composer stay untouched while a run writes.
    if (content) appendStreamText(messageId, 'content', content);
    if (thinking) appendStreamText(messageId, 'thinking', thinking);
  }

  /** Move the live tail into the stored message, then drop the tail. */
  function commitStreamText(messageId: string) {
    flushDeltas(messageId);
    const live = takeStreamText(messageId);
    if (!live.content && !live.thinking) return;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: message.content + live.content,
              thinking: live.thinking
                ? (message.thinking ?? '') + live.thinking
                : message.thinking,
            }
          : message,
      ),
    );
  }

  // Workspace tasks run the agent loop. Its stream carries everything the
  // plain chat protocol had, plus tool steps, permission requests and
  // questions the user has to answer before the loop can continue.
  useEffect(() => {
    const unsubscribe = window.ezness?.onAgentEvent?.((event: AgentStreamEvent) => {
      const active = [...streamsRef.current.values()].find(
        (stream) => stream.requestId === event.requestId,
      );
      if (!active) return;
      const messageId = active.messageId;

      // 总监在后台代答了权限/提问；卡片必须收起，否则再点会得到“已失效”。
      if (event.type === 'permission-resolved' && event.callId) {
        setPermissions((prev) => prev.filter((item) => item.callId !== event.callId));
        setQuestions((prev) => prev.filter((item) => item.callId !== event.callId));
        return;
      }

      if (event.type === 'delta' || event.type === 'thinking') {
        if (!event.text) return;
        // The model is talking again; whatever it was doing before is over.
        setActivity((prev) => (prev?.messageId === messageId ? null : prev));
        const produced = estimateTokens(event.text);
        speedRef.current.tokens += produced;
        totalSpeedRef.current.tokens += produced;
        const buffer = deltaBuffers.current.get(messageId) ?? {
          content: '',
          thinking: '',
          timer: null,
        };
        deltaBuffers.current.set(messageId, buffer);
        if (event.type === 'delta') buffer.content += event.text;
        else buffer.thinking += event.text;
        if (buffer.timer === null) {
          buffer.timer = window.setTimeout(() => flushDeltas(messageId), 50);
        }
        return;
      }

      // The model is streaming a tool call's arguments. No text arrives for it,
      // so this is the only sign of life until the call itself is dispatched.
      if (event.type === 'phase' && event.phase === 'tool_call') {
        const name = event.name ?? '';
        const chars = event.chars ?? 0;
        // Argument JSON is generated output too. A make_docx writes its whole
        // document there, so leaving it out left the rate readout at 0 for the
        // entire generation — exactly the stretch people watch it.
        const toolTokens = event.tokens ?? 0;
        const progressKey = `${messageId}:${name}`;
        const seen = toolProgressRef.current.get(progressKey) ?? 0;
        // A second call to the same tool in one turn restarts its counter.
        const grown = toolTokens >= seen ? toolTokens - seen : toolTokens;
        toolProgressRef.current.set(progressKey, toolTokens);
        if (grown > 0) {
          speedRef.current.tokens += grown;
          totalSpeedRef.current.tokens += grown;
        }
        setActivity((prev) => {
          if (
            prev?.messageId === messageId &&
            prev.value.kind === 'tool_call' &&
            prev.value.name === name &&
            chars >= prev.value.chars
          ) {
            return chars === prev.value.chars ? prev : { ...prev, value: { ...prev.value, chars } };
          }
          return { messageId, value: { kind: 'tool_call', name, chars, since: Date.now() } };
        });
        return;
      }

      if (event.type === 'tool' && event.call) {
        const call = event.call;
        const key = `${event.requestId}:${call.id}`;
        if ((event.status ?? 'running') === 'running') {
          runningCalls.current.add(key);
          setActivity((prev) => (prev?.messageId === messageId ? null : prev));
        } else {
          runningCalls.current.delete(key);
          // Tools in a batch run one after another; the run only waits for the
          // model once this request's whole batch is finished. Other tasks'
          // tools must not keep this one from saying it is waiting.
          const stillRunning = [...runningCalls.current].some((entry) =>
            entry.startsWith(`${event.requestId}:`),
          );
          if (!stillRunning) {
            const waiting: AgentActivity = { kind: 'waiting', since: Date.now() };
            setActivity((prev) =>
              prev?.messageId === messageId && prev.value.kind === 'waiting'
                ? prev
                : { messageId, value: waiting },
            );
          }
        }
        setMessages((prev) =>
          prev.map((message) => {
            if (message.id !== messageId) return message;
            const steps = message.steps ? [...message.steps] : [];
            const index = steps.findIndex((step) => step.id === call.id);
            const previous = index === -1 ? null : steps[index];
            const step: ToolStep = {
              id: call.id,
              name: call.name,
              args: call.args,
              summary: event.summary ?? previous?.summary,
              status: event.status ?? 'running',
              result: event.result ?? previous?.result,
              startedAt: event.startedAt ?? previous?.startedAt,
              endedAt: event.endedAt ?? previous?.endedAt,
            };
            if (index === -1) steps.push(step);
            else steps[index] = step;
            return { ...message, steps };
          }),
        );
        return;
      }

      if (event.type === 'permission' && event.call) {
        const call = event.call;
        setPermissions((prev) =>
          prev.some((item) => item.requestId === event.requestId && item.callId === call.id)
            ? prev
            : [
                ...prev,
                {
                  requestId: event.requestId,
                  callId: call.id,
                  name: call.name,
                  args: call.args,
                  summary: event.summary ?? '',
                  reason: event.reason ?? '',
                  danger: Boolean(event.danger),
                  reviewReason: event.reviewReason ?? '',
                  secrets: Array.isArray(event.secrets) ? event.secrets : undefined,
                },
              ],
        );
        return;
      }

      if (event.type === 'question' && event.call) {
        const call = event.call;
        setQuestions((prev) =>
          prev.some((item) => item.requestId === event.requestId && item.callId === call.id)
            ? prev
            : [
                ...prev,
                {
                  requestId: event.requestId,
                  callId: call.id,
                  question: event.question ?? tRef.current('workspace.chat.questionFallback'),
                  options: event.options ?? [],
                },
              ],
        );
        return;
      }

      // The checklist belongs to the task, not the message, so it survives a
      // restart with the rest of workspaces.json.
      if (event.type === 'todo' && event.todos) {
        const chatId = active.chatId;
        const todos = event.todos;
        setChats((prev) =>
          prev.map((chat) =>
            chat.id === chatId ? { ...chat, todos, todosAt: Date.now() } : chat,
          ),
        );
        return;
      }

      // Older turns were folded away before this step; leave a visible trace so
      // a suddenly shorter context is not a mystery.
      if (event.type === 'compact') {
        const step: ToolStep = {
          id: `compact-${Date.now()}`,
          name: 'compact',
          args: {},
          summary: tRef.current('workspace.chat.compactedStep', {
            before: Math.round((event.before ?? 0) / 1000),
            after: Math.round((event.after ?? 0) / 1000),
          }),
          status: 'done',
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, steps: [...(message.steps ?? []), step] }
              : message,
          ),
        );
        return;
      }

      // Every event type that streams mid-run returns above; arriving here
      // means this run is over (done, aborted or failed).
      setActivity((prev) => (prev?.messageId === messageId ? null : prev));
      for (const key of runningCalls.current) {
        if (key.startsWith(`${event.requestId}:`)) runningCalls.current.delete(key);
      }

      commitStreamText(messageId);
      dropDeltaBuffer(messageId);
      // Only this run ends; the other tasks keep their entries and streams.
      streamsRef.current.delete(active.requestId);
      touchFloating(
        active.chatId,
        event.type === 'done' ? 'done' : event.type === 'error' ? 'error' : 'stopped',
      );
      syncStreams();
      setPermissions((prev) => prev.filter((item) => item.requestId !== active.requestId));
      setQuestions((prev) => prev.filter((item) => item.requestId !== active.requestId));

      // 用户没看这个任务时它跑完了 → 红点。主动停止（aborted）不算。
      if (
        (event.type === 'done' || event.type === 'error') &&
        active.chatId !== activeChatIdRef.current
      ) {
        setUnreadChats((prev) =>
          prev.has(active.chatId) ? prev : new Set(prev).add(active.chatId),
        );
      }

      // 刚有输出或刚失败的任务算“最近活动”，浮到所在分组的最上面。
      if (event.type === 'done' || event.type === 'error') {
        const finishedAt = Date.now();
        setChats((prev) =>
          prev.map((chat) =>
            chat.id === active.chatId ? { ...chat, updatedAt: finishedAt } : chat,
          ),
        );
      }

      if (event.type === 'done') {
        // 活干完了，没勾完的待办就收掉：留着一排没做的计划，看起来像工作还没完。
        // 总监自己的对话除外——它的计划要等整次派工收口（planDoneAt）再收，
        // 否则刚派完工、员工还在跑，计划就被清掉了。
        const finishedChat = chatsRef.current.find((chat) => chat.id === active.chatId);
        const finishedSpace = workspacesRef.current.find(
          (space) => space.id === finishedChat?.workspaceId,
        );
        if (finishedSpace?.kind !== 'director') {
          const finishedAt = Date.now();
          setChats((prev) =>
            prev.map((chat) => {
              if (chat.id !== active.chatId) return chat;
              const list = Array.isArray(chat.todos) ? chat.todos : [];
              if (list.length === 0 || list.every((item) => item.status === 'completed')) {
                return chat;
              }
              return { ...chat, todos: undefined, todosAt: finishedAt };
            }),
          );
        }
        if (planRuns.current.delete(active.chatId)) {
          setPlanReady((prev) => new Set(prev).add(active.chatId));
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId && !message.content.trim() && !message.steps?.length
              ? { ...message, content: tRef.current('workspace.chat.emptyReply') }
              : message,
          ),
        );
        return;
      }

      if (event.type === 'aborted') {
        planRuns.current.delete(active.chatId);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  stopped: true,
                  content: message.content || tRef.current('workspace.chat.stopped'),
                  // The run is gone; a step that was mid-flight will not report
                  // again, so do not leave it spinning.
                  steps: message.steps?.map((step) =>
                    step.status === 'running'
                      ? {
                          ...step,
                          status: 'error' as const,
                          result: step.result ?? tRef.current('workspace.chat.interrupted'),
                          endedAt: step.endedAt ?? Date.now(),
                        }
                      : step,
                  ),
                }
              : message,
          ),
        );
        return;
      }

      planRuns.current.delete(active.chatId);
      const note = tRef.current('workspace.chat.modelFailed', {
        error: event.error ?? tRef.current('workspace.chat.unknownError'),
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

  useEffect(() => {
    if (streamingId === null) {
      setStreamSpeed(null);
      toolProgressRef.current.clear();
      return;
    }
    const tick = () => {
      const now = Date.now();
      const elapsed = (now - speedRef.current.sampledAt) / 1000;
      const produced = speedRef.current.tokens - speedRef.current.sampled;
      speedRef.current.sampled = speedRef.current.tokens;
      speedRef.current.sampledAt = now;
      setSpeed(elapsed > 0 ? produced / elapsed : 0);
    };
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, [streamingId]);

  // 总监页的速度要看“所有员工”：任何一个任务在跑就采样，合计所有流。
  const anyStreaming = activeStreams.length > 0;
  useEffect(() => {
    if (!anyStreaming) {
      setTotalSpeed(null);
      totalSpeedRef.current = { tokens: 0, sampled: 0, sampledAt: 0 };
      return;
    }
    if (totalSpeedRef.current.sampledAt === 0) {
      totalSpeedRef.current = { tokens: totalSpeedRef.current.tokens, sampled: totalSpeedRef.current.tokens, sampledAt: Date.now() };
    }
    const tick = () => {
      const now = Date.now();
      const elapsed = (now - totalSpeedRef.current.sampledAt) / 1000;
      const produced = totalSpeedRef.current.tokens - totalSpeedRef.current.sampled;
      totalSpeedRef.current.sampled = totalSpeedRef.current.tokens;
      totalSpeedRef.current.sampledAt = now;
      setTotalSpeed(elapsed > 0 ? produced / elapsed : 0);
    };
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, [anyStreaming]);

  function setStreamSpeed(value: number | null) {
    setSpeed(value);
  }

  /**
   * 建一个本地工作空间和它的第一个任务。不切界面——普通「新建工作空间」
   * 和总监选空间时的「添加文件夹」共用这一份逻辑。
   */
  function addLocalWorkspace(folder: string): { workspace: Workspace; chatId: string } {
    const workspace: Workspace = {
      id: uid(),
      name: basename(folder, t('workspace.workspace.untitled')),
      path: folder,
      createdAt: Date.now(),
    };
    const chat: WorkspaceChat = {
      id: uid(),
      workspaceId: workspace.id,
      title: t('workspace.chat.newTask'),
      updatedAt: Date.now(),
      model: fallbackModel,
    };

    // 回执/选空间可能紧接着就要用这个 id，先把 ref 同步过去。
    setWorkspaces((prev) => [...prev, workspace]);
    workspacesRef.current = [...workspacesRef.current, workspace];
    setChats((prev) => [chat, ...prev]);
    chatsRef.current = [chat, ...chatsRef.current];
    return { workspace, chatId: chat.id };
  }

  async function createWorkspace() {
    const api = window.ezness;
    if (!api?.workspacePickFolder) {
      flash(t('workspace.error.desktopOnly'));
      return;
    }

    const folder = await api.workspacePickFolder();
    if (!folder) return;

    const existing = workspaces.find(
      (item) => item.path.toLowerCase() === folder.toLowerCase(),
    );
    if (existing) {
      selectWorkspace(existing.id);
      flash(t('workspace.error.folderExists'));
      return;
    }

    const { workspace, chatId } = addLocalWorkspace(folder);
    setActiveWorkspaceId(workspace.id);
    setActiveChatId(chatId);
    setSpaceQuery('');
    setChatQuery('');
  }

  /** Add a workspace that lives on an SSH host (the dialog already connected). */
  function addRemoteWorkspace(info: RemoteWorkspaceResult) {
    const workspace: Workspace = {
      id: info.id,
      name: info.name,
      path: info.path,
      kind: 'remote',
      remote: info.remote,
      createdAt: Date.now(),
    };
    const chat: WorkspaceChat = {
      id: uid(),
      workspaceId: workspace.id,
      title: t('workspace.chat.newTask'),
      updatedAt: Date.now(),
      model: fallbackModel,
    };

    setWorkspaces((prev) => [...prev, workspace]);
    workspacesRef.current = [...workspacesRef.current, workspace];
    setChats((prev) => [chat, ...prev]);
    chatsRef.current = [chat, ...chatsRef.current];
    setRemoteDialogId('');

    // 从总监的选空间卡片里添加的：建好就直接选中它，不切走。
    if (directorPickRef.current) {
      const itemId = directorPickRef.current;
      directorPickRef.current = '';
      void actDirector(itemId, 'choose', workspace.id);
      return;
    }

    setActiveWorkspaceId(workspace.id);
    setActiveChatId(chat.id);
    setSpaceQuery('');
    setChatQuery('');
  }

  /**
   * 总监的工作空间选择卡里点「添加」：本地走和左侧栏一样的选文件夹，
   * 在线走同一个 SSH 对话框；建好后直接选中，不把用户从总监对话里带走。
   */
  async function addDirectorSpace(kind: 'local' | 'remote', itemId: string) {
    if (kind === 'remote') {
      directorPickRef.current = itemId;
      setRemoteDialogId(uid());
      return;
    }
    const api = window.ezness;
    if (!api?.workspacePickFolder) {
      flash(t('workspace.error.desktopOnly'));
      return;
    }
    const folder = await api.workspacePickFolder();
    if (!folder) return;
    const existing = workspacesRef.current.find(
      (item) => item.path.toLowerCase() === folder.toLowerCase(),
    );
    if (existing) {
      await actDirector(itemId, 'choose', existing.id);
      return;
    }
    const { workspace } = addLocalWorkspace(folder);
    await actDirector(itemId, 'choose', workspace.id);
  }

  /** 选择卡里的删除：和左侧栏的「删除工作空间」走同一个确认框。 */
  function deleteDirectorSpace(id: string) {
    setPendingDelete({ kind: 'space', id });
  }

  function selectWorkspace(id: string) {
    setActiveWorkspaceId(id);
    const first = chats.find((chat) => chat.workspaceId === id);
    setActiveChatId(first?.id ?? null);
    setChatQuery('');
  }

  function createChat() {
    if (!activeWorkspaceId) return;
    const chat: WorkspaceChat = {
      id: uid(),
      workspaceId: activeWorkspaceId,
      title: t('workspace.chat.newTask'),
      updatedAt: Date.now(),
      model,
    };
    setChats((prev) => [chat, ...prev]);
    setActiveChatId(chat.id);
    setChatQuery('');
  }

  function openMenu(event: React.MouseEvent<HTMLButtonElement>, kind: 'space' | 'chat', id: string) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    // 工作空间 menus may also carry 复制路径 / 打开文件夹, so they are tall too.
    const height = kind === 'chat' ? 176 : 212;
    const wouldOverflow = rect.bottom + height > window.innerHeight;
    setMenu({
      kind,
      id,
      top: wouldOverflow ? Math.max(8, rect.top - height) : rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }

  function togglePin(kind: 'space' | 'chat', id: string) {
    if (kind === 'space') {
      setWorkspaces((prev) =>
        prev.map((workspace) => (workspace.id === id ? { ...workspace, pinned: !workspace.pinned } : workspace)),
      );
    } else {
      setChats((prev) =>
        prev.map((chat) => (chat.id === id ? { ...chat, pinned: !chat.pinned } : chat)),
      );
    }
    setMenu(null);
  }

  /**
   * Rows are grouped by pin state (pinned first) and the saved array order is
   * the rest, so a drag is only accepted between rows in the same group —
   * otherwise the pin sort would snap it back. While a search is active the
   * list is filtered, so there is no unambiguous "between these two".
   */
  function canDropSpace(target: Workspace): boolean {
    if (!dragSpaceId || dragSpaceId === target.id) return false;
    if (spaceKeyword) return false;
    const dragged = workspaces.find((workspace) => workspace.id === dragSpaceId);
    return Boolean(dragged?.pinned) === Boolean(target.pinned);
  }

  function clearSpaceDrag() {
    setDragSpaceId(null);
    setDropSpaceAt(null);
  }

  function reorderSpace(fromId: string, toId: string, before: boolean) {
    setWorkspaces((prev) => {
      const from = prev.findIndex((workspace) => workspace.id === fromId);
      if (from < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      const anchor = next.findIndex((workspace) => workspace.id === toId);
      if (anchor < 0) return prev;
      next.splice(before ? anchor : anchor + 1, 0, moved);
      return next;
    });
  }

  /**
   * Tasks reorder inside one workspace only, inside one pin group, and never
   * while a search filter is hiding rows — same rules as the workspace list.
   */
  function canDropChat(target: WorkspaceChat): boolean {
    if (!dragChatId || dragChatId === target.id) return false;
    if (chatKeyword) return false;
    const dragged = chats.find((chat) => chat.id === dragChatId);
    if (!dragged || dragged.workspaceId !== target.workspaceId) return false;
    // 员工的顺序由总监的派工节奏决定，不参与手动排序。
    if (dragged.employee || target.employee) return false;
    return Boolean(dragged.pinned) === Boolean(target.pinned);
  }

  function clearChatDrag() {
    setDragChatId(null);
    setDropChatAt(null);
  }

  /**
   * The list the user sees is `visibleChats`, so the new position is computed
   * there and every task in it gets an explicit index. Plain array order would
   * not survive: the list is sorted, not stored.
   */
  function reorderChat(fromId: string, toId: string, before: boolean) {
    const ids = visibleChats.map((chat) => chat.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    const anchor = next.indexOf(toId);
    if (anchor < 0) return;
    next.splice(before ? anchor : anchor + 1, 0, moved);
    const orderById = new Map(next.map((id, index) => [id, index]));
    setChats((prev) =>
      prev.map((chat) =>
        orderById.has(chat.id) ? { ...chat, order: orderById.get(chat.id) } : chat,
      ),
    );
  }

  async function copyWorkspacePath(workspace: Workspace) {
    setMenu(null);
    if (!workspace.path) return;
    try {
      const copied = await window.ezness?.copyText?.(workspace.path);
      flash(copied ? t('workspace.flash.pathCopied') : t('workspace.flash.copyFailed'));
    } catch {
      flash(t('workspace.flash.copyFailed'));
    }
  }

  async function revealWorkspace(workspace: Workspace) {
    setMenu(null);
    if (!workspace.path) return;
    const result = await window.ezness?.workspaceReveal?.({
      workspaceId: workspace.id,
      path: '',
    });
    if (result && !result.ok) flash(result.error || t('workspace.error.openFolder'));
  }

  function startRename(kind: 'space' | 'chat', id: string) {
    const current =
      kind === 'space'
        ? workspaces.find((workspace) => workspace.id === id)?.name
        : chats.find((chat) => chat.id === id)?.title;
    setRenameDraft(current ?? '');
    setRenaming({ kind, id });
    setMenu(null);
  }

  function commitRename() {
    const target = renaming;
    if (!target) return;
    const value = renameDraft.trim();
    if (value) {
      if (target.kind === 'space') {
        setWorkspaces((prev) =>
          prev.map((workspace) =>
            workspace.id === target.id ? { ...workspace, name: value } : workspace,
          ),
        );
      } else {
        setChats((prev) =>
          prev.map((chat) => (chat.id === target.id ? { ...chat, title: value } : chat)),
        );
      }
    }
    setRenaming(null);
  }

  function requestDelete(kind: 'space' | 'chat', id: string) {
    setMenu(null);
    setPendingDelete({ kind, id });
  }

  /**
   * Remove workspaces (with all their tasks) or tasks, one or many at once.
   * Deleting a workspace takes its tasks and transcripts with it, exactly like
   * deleting each row by hand.
   */
  function removeTargets(kind: 'space' | 'chat', ids: string[]) {
    if (ids.length === 0) return;
    const removedSpaces = new Set(kind === 'space' ? ids : []);
    const removedIds =
      kind === 'space'
        ? chats
            .filter((chat) => removedSpaces.has(chat.workspaceId))
            .map((chat) => chat.id)
        : ids;
    const affected = new Set(removedIds);

    // Deleted rows must not leave their streams writing into vanished messages.
    const removedRequests: string[] = [];
    for (const stream of [...streamsRef.current.values()]) {
      if (!affected.has(stream.chatId)) continue;
      streamsRef.current.delete(stream.requestId);
      clearStreamText(stream.messageId);
      dropDeltaBuffer(stream.messageId);
      removedRequests.push(stream.requestId);
      void window.ezness?.agentAbort?.(stream.requestId);
      planRuns.current.delete(stream.chatId);
    }
    if (removedRequests.length > 0) {
      syncStreams();
      setPermissions((prev) =>
        prev.filter((item) => !removedRequests.includes(item.requestId)),
      );
      setQuestions((prev) => prev.filter((item) => !removedRequests.includes(item.requestId)));
    }

    setMessages((prev) => prev.filter((message) => !affected.has(message.sessionId)));
    const restChats = chats.filter((chat) => !affected.has(chat.id));
    setChats(restChats);

    // The agent's own conversation log lives beside the data root; deleting a
    // task should not leave its transcript behind.
    for (const id of removedIds) {
      void window.ezness?.agentDeleteSession?.(id);
    }

    let restWorkspaces = workspaces;
    if (kind === 'space') {
      restWorkspaces = workspaces.filter((workspace) => !removedSpaces.has(workspace.id));
      setWorkspaces(restWorkspaces);
    }
    if (activeWorkspaceId && removedSpaces.has(activeWorkspaceId)) {
      const next = restWorkspaces[0] ?? null;
      setActiveWorkspaceId(next?.id ?? null);
      setActiveChatId(
        next ? restChats.find((chat) => chat.workspaceId === next.id)?.id ?? null : null,
      );
    } else if (activeChatId && affected.has(activeChatId)) {
      const next = restChats.find((chat) => chat.workspaceId === activeWorkspaceId);
      setActiveChatId(next?.id ?? null);
    }

    setSelection(null);
    setPendingDelete(null);
    setPendingBatch(null);
    const label = kind === 'space' ? t('workspace.kind.space') : t('workspace.kind.task');
    flash(
      ids.length > 1
        ? t('workspace.flash.deletedMany', { count: ids.length, kind: label })
        : t('workspace.flash.deletedOne', { kind: label }),
    );
  }
  removeTargetsRef.current = removeTargets;

  function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    removeTargets(target.kind, [target.id]);
  }

  function confirmBatchDelete() {
    if (!pendingBatch) return;
    removeTargets(pendingBatch.kind, pendingBatch.ids);
  }

  function toggleSelect(kind: 'space' | 'chat', id: string) {
    setSelection((prev) => {
      if (prev?.kind !== kind) return { kind, ids: new Set([id]) };
      const ids = new Set(prev.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { kind, ids };
    });
  }

  /** Select or clear every row currently visible (the search filter applies). */
  function selectAllVisible(kind: 'space' | 'chat', ids: string[], checked: boolean) {
    setSelection((prev) => {
      const base = prev?.kind === kind ? new Set(prev.ids) : new Set<string>();
      for (const id of ids) {
        if (checked) base.add(id);
        else base.delete(id);
      }
      return { kind, ids: base };
    });
  }

  async function exportChat(id: string) {
    const chat = chats.find((item) => item.id === id);
    if (!chat) return;
    const label =
      models.find((option) => option.id === chat.model)?.label ??
      t('workspace.export.unspecified');
    const result = await window.ezness?.exportSession?.({
      title: chat.title || t('workspace.kind.task'),
      markdown: buildSessionMarkdown(chat, messages, label),
    });
    if (result && !result.ok && !result.canceled) {
      flash(
        t('workspace.export.failed', {
          error: result.error ?? t('workspace.error.unknown'),
        }),
      );
    }
  }

  function renameInput(kind: 'space' | 'chat') {
    return (
      <input
        className="ws-rename"
        value={renameDraft}
        autoFocus
        spellCheck={false}
        aria-label={
          kind === 'space' ? t('workspace.rename.spaceAria') : t('workspace.rename.chatAria')
        }
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setRenameDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onBlur={commitRename}
        onKeyDown={(event) => {
          // Space and Enter belong to the input while renaming, not the row.
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setRenaming(null);
          }
        }}
      />
    );
  }

  function handleModelChange(id: string) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) => (chat.id === activeChatId ? { ...chat, model: id } : chat)),
    );
  }

  function handleKbChange(patch: Partial<KbChatSettings>) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) => {
        if (chat.id !== activeChatId) return chat;
        const merged: KbChatSettings & { web?: boolean } = {
          ...DEFAULT_CHAT_KB,
          webMode: web.defaultMode,
          ...(chat.kb ?? {}),
          ...patch,
        };
        delete merged.web;
        return { ...chat, kb: merged };
      }),
    );
  }

  function handleDataAccessChange(next: WorkspaceDataAccess) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) => (chat.id === activeChatId ? { ...chat, dataAccess: next } : chat)),
    );
  }

  function handleStop() {
    // Stop only the task the user is looking at; background tasks keep running.
    const owner = activeStream;
    if (!owner) return;
    void window.ezness?.agentAbort?.(owner.requestId);
  }

  function chatTarget(
    chat: { id?: string; model?: string } | null | undefined,
  ): ChatTarget | null {
    const key = chat?.model && models.some((item) => item.id === chat.model) ? chat.model : model;
    const target = resolveTarget(key);
    if (target && chat?.id) target.sessionId = chat.id;
    return target;
  }

  /**
   * Manual compression of a task. Two layers move together: the page's display
   * transcript folds into a summary card the user can undo, and the agent's own
   * session file — the history the model actually reads — is compacted by the
   * main process. The second part cannot be undone one message at a time, so it
   * runs only after the display phase finishes and the user has not cancelled.
   */
  async function handleCompress(sessionId: string) {
    if (compressingId) return;
    const chat = chats.find((item) => item.id === sessionId);
    if (!chat) return;
    if (sessionId === activeChatId && streamingId !== null) {
      setCompressionError({ sessionId, message: t('workspace.compress.wait') });
      return;
    }

    const target = chatTarget(chat);
    if (!target) {
      setCompressionError({ sessionId, message: t('workspace.compress.noModel') });
      return;
    }

    const all = messages.filter((message) => message.sessionId === sessionId);
    const selected = selectCompressible(all, work.compressionKeepTurns);

    const token: CompressionToken = { canceled: false, abort: null };
    compressionToken.current = token;
    setCompressingId(sessionId);
    setCompressionError(null);
    setCompressionStep({ sessionId, step: 1, total: 1, phase: 'map' });

    let agentCompacted = false;
    try {
      // 1) Fold the visible transcript first: it is the slow, cancellable
      // phase. Cancelling here must stop before the agent file — the part the
      // model actually reads — is rewritten.
      let displayError: Error | null = null;
      if (selected.length >= 2) {
        try {
          const result = await compressConversation({
            target,
            messages: selected,
            token,
            onProgress: (progress) => setCompressionStep({ sessionId, ...progress }),
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
        } catch (error) {
          if (token.canceled) return;
          displayError = error instanceof Error ? error : new Error(String(error));
        }
      }

      // 2) Fold the task's own agent history. Without this the next request
      // still carries the same enormous prompt; the card above only changes
      // what this page shows.
      const agent = await window.ezness?.agentCompact?.({
        sessionId,
        contextLimit: work.contextLimit,
      });
      if (!agent) throw new Error(t('workspace.compress.desktopOnly'));
      if (agent.ok === false) throw new Error(agent.error || t('workspace.compress.agentFailed'));
      if (agent.compacted) {
        agentCompacted = true;
        const saving = Math.max(0, (agent.before ?? 0) - (agent.after ?? 0));
        if (saving > 0) {
          setAgentCompactSaving({ sessionId, saving, at: Date.now() });
        }
        flash(
          t('workspace.compress.done', {
            before: Math.round((agent.before ?? 0) / 1000),
            after: Math.round((agent.after ?? 0) / 1000),
          }),
        );
        // The provider count from the last request describes the old, larger
        // prompt. Predict the next one with the same estimate-to-provider
        // ratio, and keep it with the task so a restart does not fall back to
        // the stale number.
        const reported = contextTokensFromUsage(usage, sessionId, 'workspace');
        const before = agent.before ?? 0;
        const after = agent.after ?? 0;
        const ratio =
          reported && before > 0
            ? Math.min(4, Math.max(0.5, reported.used / before))
            : 1;
        setChats((prev) =>
          prev.map((item) =>
            item.id === sessionId
              ? {
                  ...item,
                  contextAfter: {
                    tokens: Math.round(after * ratio),
                    at: Date.now(),
                  },
                }
              : item,
          ),
        );
      }
      // Refresh the live size even when the fold was a no-op: the ring may
      // still be showing a provider count from before an earlier compaction.
      const refreshed = window.ezness?.agentContext?.(sessionId);
      if (refreshed) {
        void refreshed.then((info) => {
          if (info) setAgentContext({ sessionId, ...info });
        });
      }

      if (displayError) {
        setCompressionError({
          sessionId,
          message: agentCompacted
            ? t('workspace.compress.displayFailedAfter', { error: displayError.message })
            : t('workspace.compress.displayFailed', { error: displayError.message }),
        });
      } else if (selected.length < 2 && !agentCompacted) {
        setCompressionError({
          sessionId,
          message: t('workspace.compress.nothing', {
            size: Math.round((agent.before ?? 0) / 1000),
          }),
        });
      }
    } catch (error) {
      if (!token.canceled) {
        const message = error instanceof Error ? error.message : String(error);
        setCompressionError({
          sessionId,
          message: agentCompacted
            ? t('workspace.compress.followUpFailed', { error: message })
            : message,
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

  function handleUndoCompression(_sessionId: string, summaryId: string) {
    // Restoring the transcript never touches the agent's own session file.
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
  }

  async function handleSend(
    text: string,
    attachments: WarehouseItem[] = [],
    modeOverride?: PermissionMode,
    forChatId?: string,
  ) {
    // A director instruction starts a run in its own task without moving the
    // user's selection; everything below still keys off `chat`. The ref is the
    // freshest list: a freshly spawned employee task may not have rendered yet.
    const chat = chatsRef.current.find((item) => item.id === (forChatId ?? activeChatId));
    if (!chat) return;

    // 在任务里说话本身就是“亲临”，presence 已经把所有权交给用户，不需要交接。
    const api = window.ezness;
    const timestamp = Date.now();
    const webOn = readWebMode(chat.kb, web.defaultMode) !== 'off';
    let userText = text;

    // Warehouse files are read before the request and folded into the turn,
    // exactly like the main conversation does it.
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

    const userId = uid();
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        sessionId: chat.id,
        role: 'user',
        content: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        attachmentContext: attachmentContext || undefined,
        createdAt: timestamp,
      },
    ]);

    const fallbackTitle = text.trim() || attachments[0]?.name || '';
    setChats((prev) =>
      prev.map((item) =>
        item.id === chat.id
          ? {
              ...item,
              updatedAt: timestamp,
              title:
                item.title === t('workspace.chat.newTask') && fallbackTitle
                  ? fallbackTitle.slice(0, 24)
                  : item.title,
            }
          : item,
      ),
    );

    // Sending again in *this* task supersedes its own previous turn only.
    // Tasks in other chats keep streaming.
    const previous = [...streamsRef.current.values()].find((stream) => stream.chatId === chat.id);
    if (previous) {
      streamsRef.current.delete(previous.requestId);
      commitStreamText(previous.messageId);
      dropDeltaBuffer(previous.messageId);
      syncStreams();
      for (const key of runningCalls.current) {
        if (key.startsWith(`${previous.requestId}:`)) runningCalls.current.delete(key);
      }
      planRuns.current.delete(chat.id);
      setPermissions((prev) => prev.filter((item) => item.requestId !== previous.requestId));
      setQuestions((prev) => prev.filter((item) => item.requestId !== previous.requestId));
      void api?.agentAbort?.(previous.requestId);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === previous.messageId
            ? {
                ...message,
                stopped: true,
                content: message.content || t('workspace.chat.stoppedParenthesized'),
                // The run is gone; a step that was mid-flight will not report again.
                steps: message.steps?.map((step) =>
                  step.status === 'running'
                    ? {
                        ...step,
                        status: 'error' as const,
                        result: step.result ?? t('workspace.chat.interrupted'),
                        endedAt: step.endedAt ?? Date.now(),
                      }
                    : step,
                ),
              }
            : message,
        ),
      );
    }

    const assistantId = uid();
    const requestId = uid();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, sessionId: chat.id, role: 'assistant', content: '', createdAt: Date.now() },
    ]);
    streamsRef.current.set(requestId, {
      requestId,
      messageId: assistantId,
      chatId: chat.id,
      startedAt: Date.now(),
    });
    touchFloating(chat.id, 'running');
    syncStreams();
    // The first token can take a while on a long transcript; say so right away
    // instead of showing a message bubble that looks stuck.
    setActivity({ messageId: assistantId, value: { kind: 'waiting', since: Date.now() } });
    setPhase('generating');
    speedRef.current = { tokens: 0, sampled: 0, sampledAt: Date.now() };
    toolProgressRef.current.clear();
    setStreamSpeed(null);

    const fail = (content: string) => {
      streamsRef.current.delete(requestId);
      touchFloating(chat.id, 'error');
      clearStreamText(assistantId);
      dropDeltaBuffer(assistantId);
      syncStreams();
      setActivity((prev) => (prev?.messageId === assistantId ? null : prev));
      setMessages((prev) =>
        prev.map((message) => (message.id === assistantId ? { ...message, content } : message)),
      );
    };

    if (!api) {
      fail(t('workspace.error.desktopOnlyTask'));
      return;
    }

    const target = chatTarget(chat);
    if (!target) {
      fail(t('workspace.error.noTarget'));
      // 总监那边只知道“任务起不来”；把原因递过去，它才能把换模型的选择交给用户。
      const space = workspacesRef.current.find((item) => item.id === chat.workspaceId);
      if (
        space &&
        space.kind !== 'director' &&
        space.kind !== 'tool-editor' &&
        space.kind !== 'agent-editor'
      ) {
        void window.ezness
          ?.directorRunBlocked?.({
            taskId: chat.id,
            reason: t('workspace.director.noModelConfig'),
          })
          ?.catch(() => undefined);
      }
      return;
    }

    const workspace = workspaces.find((item) => item.id === chat.workspaceId);
    if (!workspace) {
      fail(t('workspace.error.spaceGone'));
      return;
    }

    // 用户亲口下的指令优先级最高：总监排在同一任务里的重复指令应当被丢弃，
    // 其余等他离开后再下发。总监自己的对话不需要这条。
    if (
      workspace.kind !== 'director' &&
      workspace.kind !== 'tool-editor' &&
      workspace.kind !== 'agent-editor'
    ) {
      void window.ezness
        ?.directorUserMessage?.({ taskId: chat.id, text })
        ?.catch(() => undefined);
    }

    // Earlier turns live in the session file, not in this request: the agent
    // resumes its own JSONL log, which also carries tool calls and results the
    // display transcript never shows in full.
    const toolEditor = workspace.kind === 'tool-editor';
    const agentEditor = workspace.kind === 'agent-editor';
    const directorChat = workspace.kind === 'director';
    const virtualEditor = toolEditor || agentEditor || directorChat;
    const effectiveMode = virtualEditor
      ? 'workspace-write'
      : modeOverride ?? chat.permission ?? 'workspace-write';
    if (effectiveMode === 'plan') planRuns.current.add(chat.id);
    else planRuns.current.delete(chat.id);
    setPlanReady((prev) => {
      if (!prev.has(chat.id)) return prev;
      const next = new Set(prev);
      next.delete(chat.id);
      return next;
    });

    // 总监看不到会话正文，只能看到这张任务清单；每轮都传最新的，提示词不会过期。
    const directorTasks = directorChat
      ? chats
          .filter((item) => {
            const space = workspaces.find((entry) => entry.id === item.workspaceId);
            return (
              space &&
              space.kind !== 'tool-editor' &&
              space.kind !== 'agent-editor' &&
              space.kind !== 'director' &&
              // 未分管的空间连任务名都不给总监看。
              (director?.spaces[space.id] ?? 'off') !== 'off'
            );
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 40)
          .map((item) => {
            const space = workspaces.find((entry) => entry.id === item.workspaceId);
            return {
              id: item.id,
              title: item.title,
              space: space?.name ?? '',
              busy: item.id === streamingId,
              workspaceId: item.workspaceId,
              workspacePath: space?.path ?? '',
            };
          })
      : undefined;
    const directorSpaces = directorChat
      ? workspaces
          .filter(
            (item) =>
              item.kind !== 'tool-editor' &&
              item.kind !== 'agent-editor' &&
              item.kind !== 'director' &&
              (director?.spaces[item.id] ?? 'off') !== 'off',
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            access: director?.spaces[item.id] ?? 'off',
          }))
      : undefined;

    try {
      await api.agentStart({
        requestId,
        provider: target,
        // A remote workspace connects by id; credentials never leave main.
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        workspaceName: workspace.name,
        workspaceKind: toolEditor
          ? 'tool-editor'
          : agentEditor
            ? 'agent-editor'
            : directorChat
              ? 'director'
              : 'folder',
        categoryId: workspace.categoryId,
        // Agent editors bind the workspace; a folder task binds its own pick.
        agentId: agentEditor ? workspace.agentId : chat.agentId,
        sessionId: chat.id,
        message: userText,
        // Per-task level; undefined would fall back to the global setting in
        // main, so send the resolved value.
        askLevel: chat.askLevel ?? work.askLevel,
        // Main mirrors the run with these ids, so a Ctrl+R reload can put the
        // stream back on the same two messages instead of orphaning it.
        messageId: assistantId,
        userMessageId: userId,
        userMessage: text,
        mode: effectiveMode,
        allowedCommands: chat.allowedCommands ?? [],
        // 关闭 disables the web tool; 自动 and 总是 both leave it available and
        // the agent decides when to call it, so the query and results show up
        // in the step list.
        webEnabled: webOn,
        webEntries: web.entries.filter((entry) => entry.enabled),
        // Main ticks items off from actual tool results; handing over the
        // current list keeps that state and the display in sync across turns.
        todos: chat.todos ?? [],
        // Activation only: main builds the read tools and every content read
        // still asks unless this task is on 自动.
        dataAccess: virtualEditor ? undefined : chat.dataAccess,
        directorTasks,
        directorSpaces,
      });
    } catch (error) {
      // The IPC itself failed (the run's own errors arrive as stream events),
      // so this stream would otherwise stay registered forever.
      streamsRef.current.delete(requestId);
      clearStreamText(assistantId);
      dropDeltaBuffer(assistantId);
      syncStreams();
      setActivity((prev) => (prev?.messageId === assistantId ? null : prev));
      const detail = error instanceof Error ? error.message : String(error);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, content: t('workspace.chat.startFailed', { error: detail }) }
            : message,
        ),
      );
    }
  }

  // Plan mode ends with a button rather than a guess: switch to workspace-write
  // and hand the agent its own plan back as the next instruction.
  function handleStartPlan() {
    if (activeStream) return;
    handlePermissionChange('workspace-write');
    void handleSend(t('workspace.chat.startPlan'), [], 'workspace-write');
  }

  function resolvePermission(
    allow: boolean,
    remember: boolean,
    note = '',
    secrets: Record<string, string> = {},
    rememberSecrets = true,
  ) {
    const pending = permission;
    if (!pending) return;
    setPermissions((prev) =>
      prev.filter(
        (item) => item.requestId !== pending.requestId || item.callId !== pending.callId,
      ),
    );
    void window.ezness?.agentResolve?.({
      requestId: pending.requestId,
      callId: pending.callId,
      // Credentials go straight to the main process. They are not part of the
      // message list, so neither the model nor the saved session sees them.
      decision: {
        allow,
        remember,
        note,
        secrets: allow ? secrets : undefined,
        rememberSecrets,
      },
    });

    // "始终允许" remembers the exact command for this task, across restarts.
    if (allow && remember && pending.name === 'run_command') {
      const command = String(pending.args?.command ?? '').trim();
      const owner = [...streamsRef.current.values()].find(
        (stream) => stream.requestId === pending.requestId,
      );
      const chatId = owner?.chatId ?? activeChatId;
      if (command && chatId) {
        setChats((prev) =>
          prev.map((chat) =>
            chat.id === chatId
              ? {
                  ...chat,
                  allowedCommands: Array.from(
                    new Set([...(chat.allowedCommands ?? []), command]),
                  ),
                }
              : chat,
          ),
        );
      }
    }
  }

  /**
   * Answer every pending card of the same run at once. The loop started these
   * calls in parallel, so it is waiting on all of them; resolving one by one
   * would just add clicks. Anything not marked true is denied.
   */
  function resolvePermissionQueue(decisions: Record<string, boolean>) {
    const pending = permissionQueue;
    if (pending.length === 0) return;
    const requestId = pending[0].requestId;
    setPermissions((prev) => prev.filter((item) => item.requestId !== requestId));
    for (const item of pending) {
      void window.ezness?.agentResolve?.({
        requestId: item.requestId,
        callId: item.callId,
        decision: { allow: Boolean(decisions[item.callId]), remember: false, note: '' },
      });
    }
  }

  function resolveQuestion(answer: string) {
    const pending = question;
    if (!pending) return;
    setQuestions((prev) =>
      prev.filter(
        (item) => item.requestId !== pending.requestId || item.callId !== pending.callId,
      ),
    );
    void window.ezness?.agentResolve?.({
      requestId: pending.requestId,
      callId: pending.callId,
      decision: { allow: true, answer },
    });
  }

  function handleAskLevelChange(level: AskLevel) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) => (chat.id === activeChatId ? { ...chat, askLevel: level } : chat)),
    );
  }

  /**
   * Enabling an Agent applies it to this task right away. A disabled draft is
   * also turned on globally, which is what "选择 Agent 来启用" means in the
   * composer; the Agent page then shows it as 已启用.
   */
  function handleAgentChange(agent: AgentDefinition | null) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === activeChatId ? { ...chat, agentId: agent?.id ?? undefined } : chat,
      ),
    );
    if (!agent) {
      flash(t('workspace.agent.switchedToPlain'));
      return;
    }
    flash(t('workspace.agent.enabled', { name: agent.name }));
    if (agent.enabled) return;
    void window.ezness?.agentsSave?.({ ...agent, enabled: true }).then((result) => {
      if (result?.ok) {
        setAgents(result.agents ?? []);
      } else {
        flash(
          result?.error ||
            t('workspace.agent.enableFailed', { name: agent.name }),
        );
      }
    });
  }

  function handlePermissionChange(mode: PermissionMode) {
    if (!activeChatId) return;
    setChats((prev) =>
      prev.map((chat) => (chat.id === activeChatId ? { ...chat, permission: mode } : chat)),
    );
    if (mode !== 'plan') {
      setPlanReady((prev) => {
        if (!prev.has(activeChatId)) return prev;
        const next = new Set(prev);
        next.delete(activeChatId);
        return next;
      });
    }
  }

  const compressionBusy = Boolean(activeChatId && compressingId === activeChatId);
  const compressionProgressLabel =
    compressionStep && compressionStep.sessionId === activeChatId
      ? compressionStep.phase === 'reduce'
        ? t('workspace.compress.progressReduce', {
            step: compressionStep.step,
            total: compressionStep.total,
          })
        : t('workspace.compress.progressMap', {
            step: compressionStep.step,
            total: compressionStep.total,
          })
      : null;
  const compressionErrorText =
    compressionError && compressionError.sessionId === activeChatId
      ? compressionError.message
      : null;
  const compressionDisabledReason = (() => {
    if (compressionBusy) return null;
    if (streamingId !== null) return t('workspace.compress.wait');
    if (!chatTarget(activeChat)) return t('workspace.compress.noModelShort');
    // The visible transcript may be short while the agent's own history is
    // long, so the page cannot decide "nothing to compress" from its messages.
    // The handler compacts the agent file and reports when both are empty.
    return null;
  })();

  // 待确认的条目读过后仍然是待确认，红点不能因为点开过就消失。
  const directorAlerts = Math.max(directorInbox?.unread ?? 0, directorInbox?.confirms ?? 0);

  const selectingSpaces = selection?.kind === 'space';
  const selectingChats = selection?.kind === 'chat';
  const selectedSpaceIds = selectingSpaces ? selection.ids : null;
  const selectedChatIds = selectingChats ? selection.ids : null;

  /**
   * 搜索时平铺（组里也要能搜到）；批量选择和当前打开的员工任务自动展开，
   * 免得选中的东西被折叠藏起来。
   */
  const groupingEmployees = !chatKeyword;
  const showEmployees =
    !groupingEmployees ||
    employeesOpen ||
    selectingChats ||
    Boolean(activeChat?.employee && activeChat.workspaceId === activeWorkspaceId);
  const employeesWaiting = employeeChats.filter(
    (chat) => chatActivity.get(chat.id) === 'attention',
  ).length;
  const employeesRunning = employeeChats.filter(
    (chat) => chatActivity.get(chat.id) === 'running',
  ).length;
  function toggleEmployees() {
    setEmployeesOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('ezness.employeesOpen', next ? '1' : '0');
      } catch {
        /* storage unavailable: keep it in memory for this session */
      }
      return next;
    });
  }

  /** One task row: the normal list and the employee group render the same thing. */
  const renderChatRow = (chat: WorkspaceChat) => {
    const renamingThis = renaming?.kind === 'chat' && renaming.id === chat.id;
    return (
      <div
        key={chat.id}
        className={[
          'ws-chat',
          chat.id === activeChatId ? 'is-active' : '',
          selectedChatIds?.has(chat.id) ? 'is-selected' : '',
          dragChatId === chat.id ? 'is-dragging' : '',
          dropChatAt?.id === chat.id
            ? dropChatAt.before
              ? 'is-drop-before'
              : 'is-drop-after'
            : '',
        ]
          .filter(Boolean)
          .join(' ')}
        title={chat.title}
        role={selectingChats ? 'checkbox' : 'button'}
        aria-checked={selectingChats ? selectedChatIds?.has(chat.id) : undefined}
        tabIndex={0}
        draggable={!renamingThis && !chatKeyword && !selectingChats && !chat.employee}
        onClick={() =>
          selectingChats ? toggleSelect('chat', chat.id) : setActiveChatId(chat.id)
        }
        onDragStart={(event) => {
          setDragChatId(chat.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', chat.id);
        }}
        onDragOver={(event) => {
          if (!canDropChat(chat)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          setDropChatAt({
            id: chat.id,
            before: event.clientY < rect.top + rect.height / 2,
          });
        }}
        onDrop={(event) => {
          if (!canDropChat(chat)) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          if (dragChatId) {
            reorderChat(
              dragChatId,
              chat.id,
              event.clientY < rect.top + rect.height / 2,
            );
          }
          clearChatDrag();
        }}
        onDragEnd={clearChatDrag}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (selectingChats) toggleSelect('chat', chat.id);
            else setActiveChatId(chat.id);
          }
        }}
      >
        <ActivityDot status={chatActivity.get(chat.id) ?? null} />
        {renamingThis ? (
          renameInput('chat')
        ) : (
          <span className="ws-chat__text">
            <span className="ws-chat__title">{chat.title}</span>
            {chatSnippets.has(chat.id) && (
              <span className="ws-chat__snippet">{chatSnippets.get(chat.id)}</span>
            )}
          </span>
        )}
        {selectingChats ? (
          <span
            className={`select-box ${selectedChatIds?.has(chat.id) ? 'is-checked' : ''}`}
            aria-hidden="true"
          >
            {selectedChatIds?.has(chat.id) && <CheckIcon size={12} />}
          </span>
        ) : (
          <>
            {chat.pinned && !renamingThis && (
              <span className="ws-item__pin" title={t('workspace.item.pinned')}>
                <PinIcon size={11} />
              </span>
            )}
            <span className="ws-chat__meta">{shortStamp(chat.updatedAt)}</span>
            {!renamingThis && (
              <button
                className="ws-item__more"
                title={t('workspace.item.more')}
                onClick={(event) => openMenu(event, 'chat', chat.id)}
              >
                <MoreIcon size={15} />
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={`ws ${panel ? `ws--${panel}` : ''}`}>
      <nav className="ws__rail" aria-label={t('workspace.rail.aria')}>
        {WORKSPACE_PANELS.map(({ key, labelKey, icon: PanelIcon }) => {
          const active = panel === key;
          const label = t(labelKey);
          return (
            <button
              key={key}
              type="button"
              className={`ws__rail-btn ${active ? 'is-active' : ''}`}
              title={active ? t('workspace.rail.collapse', { label }) : label}
              aria-label={label}
              aria-pressed={active}
              onClick={() => setPanel((prev) => (prev === key ? null : key))}
            >
              <PanelIcon size={21} />
              {key === 'director' && directorAlerts > 0 && (
                <span className="ws__rail-badge">
                  {directorAlerts > 99 ? '99+' : directorAlerts}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <aside
        className={`ws__panel ws__spaces ${panel === 'work' ? '' : 'is-collapsed'}`}
        inert={panel !== 'work'}
      >
        <div className="ws__head">
          <span className="ws__heading">{t('workspace.sidebar.spaces')}</span>
          {visibleWorkspaces.length > 0 && (
            <button
              type="button"
              className={`ws__select-toggle ${selectingSpaces ? 'is-active' : ''}`}
              aria-pressed={Boolean(selectingSpaces)}
              title={
                selectingSpaces
                  ? t('workspace.select.exit')
                  : t('workspace.select.spaces')
              }
              onClick={() =>
                setSelection((prev) =>
                  prev?.kind === 'space' ? null : { kind: 'space', ids: new Set() },
                )
              }
            >
              {selectingSpaces
                ? t('workspace.select.done')
                : t('workspace.select.start')}
            </button>
          )}
        </div>
        <div className="ws__tools">
          <div className="search ws__search">
            <SearchIcon size={14} />
            <input
              value={spaceQuery}
              placeholder={t('workspace.search.spaces')}
              spellCheck={false}
              aria-label={t('workspace.search.spaces')}
              onChange={(event) => setSpaceQuery(event.target.value)}
            />
          </div>
          <button
            className="newchat"
            title={t('workspace.newSpace')}
            aria-label={t('workspace.newSpace')}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setAddMenu((prev) => (prev ? null : { x: rect.left, y: rect.bottom + 6 }));
            }}
          >
            <PlusIcon size={17} />
          </button>
        </div>
        {selectingSpaces && selectedSpaceIds && (
          <div className="ws__selectbar">
            <label className="ws__selectall">
              <input
                type="checkbox"
                checked={
                  visibleWorkspaces.length > 0 &&
                  visibleWorkspaces.every((workspace) => selectedSpaceIds.has(workspace.id))
                }
                onChange={(event) =>
                  selectAllVisible(
                    'space',
                    visibleWorkspaces.map((workspace) => workspace.id),
                    event.target.checked,
                  )
                }
              />
              {t('workspace.select.all')}
            </label>
            <span className="ws__selectcount">
              {t('workspace.select.count', { count: selectedSpaceIds.size })}
            </span>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={selectedSpaceIds.size === 0}
              onClick={() =>
                setPendingBatch({ kind: 'space', ids: [...selectedSpaceIds] })
              }
            >
              {t('workspace.select.delete')}
            </button>
          </div>
        )}
        <div className="ws__list">
          {visibleWorkspaces.map((workspace) => {
            const renamingThis = renaming?.kind === 'space' && renaming.id === workspace.id;
            const editor =
              workspace.kind === 'tool-editor' || workspace.kind === 'agent-editor';
            const health = spaceHealth[workspace.id];
            const offline = Boolean(health && !health.ok);
            return (
              <div
                key={workspace.id}
                className={[
                  'ws-space',
                  workspace.id === activeWorkspaceId ? 'is-active' : '',
                  editor ? 'ws-space--editor' : '',
                  offline ? 'is-offline' : '',
                  selectedSpaceIds?.has(workspace.id) ? 'is-selected' : '',
                  dragSpaceId === workspace.id ? 'is-dragging' : '',
                  dropSpaceAt?.id === workspace.id
                    ? dropSpaceAt.before
                      ? 'is-drop-before'
                      : 'is-drop-after'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={
                  offline && health
                    ? spaceHealthDetail(workspace, health, t)
                    : editor
                      ? workspacePathLabel(workspace, t)
                      : workspace.path
                }
                role={selectingSpaces ? 'checkbox' : 'button'}
                aria-checked={selectingSpaces ? selectedSpaceIds?.has(workspace.id) : undefined}
                aria-selected={selectingSpaces ? undefined : workspace.id === activeWorkspaceId}
                tabIndex={0}
                draggable={!renamingThis && !spaceKeyword && !selectingSpaces}
                onClick={() =>
                  selectingSpaces
                    ? toggleSelect('space', workspace.id)
                    : selectWorkspace(workspace.id)
                }
                onDragStart={(event) => {
                  setDragSpaceId(workspace.id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', workspace.id);
                }}
                onDragOver={(event) => {
                  if (!canDropSpace(workspace)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  setDropSpaceAt({
                    id: workspace.id,
                    before: event.clientY < rect.top + rect.height / 2,
                  });
                }}
                onDrop={(event) => {
                  if (!canDropSpace(workspace)) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (dragSpaceId) {
                    reorderSpace(
                      dragSpaceId,
                      workspace.id,
                      event.clientY < rect.top + rect.height / 2,
                    );
                  }
                  clearSpaceDrag();
                }}
                onDragEnd={clearSpaceDrag}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (selectingSpaces) toggleSelect('space', workspace.id);
                    else selectWorkspace(workspace.id);
                  }
                }}
              >
                {editor ? (
                  <SparkleIcon size={15} className="ws-space__icon" />
                ) : (
                  <FolderIcon size={15} className="ws-space__icon" />
                )}
                <ActivityDot status={spaceActivity.get(workspace.id) ?? null} />
                <span className="ws-space__text">
                  <span className="ws-space__title">
                    {renamingThis ? renameInput('space') : (
                      <span className="ws-space__name">
                        {/* The director workspace is a fixed part of the app, not
                            data: its stored name is Chinese on existing installs. */}
                        {workspace.kind === 'director'
                          ? t('workspace.name.director')
                          : workspace.name}
                      </span>
                    )}
                    {!renamingThis && offline && health && (
                      <span
                        className="ws-space__warn"
                        role="img"
                        title={spaceHealthDetail(workspace, health, t)}
                        aria-label={spaceHealthDetail(workspace, health, t)}
                      >
                        <AlertIcon size={11} />
                      </span>
                    )}
                  </span>
                  <span className="ws-space__path">
                    {editor ? workspacePathLabel(workspace, t) : workspace.path}
                  </span>
                </span>
                {selectingSpaces ? (
                  <span
                    className={`select-box ${selectedSpaceIds?.has(workspace.id) ? 'is-checked' : ''}`}
                    aria-hidden="true"
                  >
                    {selectedSpaceIds?.has(workspace.id) && <CheckIcon size={12} />}
                  </span>
                ) : (
                  <>
                    {workspace.pinned && !renamingThis && (
                      <span className="ws-item__pin" title={t('workspace.item.pinned')}>
                        <PinIcon size={11} />
                      </span>
                    )}
                    {!renamingThis && (
                      <button
                        className="ws-item__more"
                        title={t('workspace.item.more')}
                        onClick={(event) => openMenu(event, 'space', workspace.id)}
                      >
                        <MoreIcon size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {visibleWorkspaces.length === 0 && (
            <div className="ws-hint">
              {spaceKeyword ? (
                t('workspace.empty.noSpaceMatch', { query: spaceQuery.trim() })
              ) : (
                <>
                  {t('workspace.empty.noSpaces')}
                  <br />
                  {t('workspace.empty.noSpacesHint')}
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      <aside
        className={`ws__panel ws__chats ${panel === 'work' ? '' : 'is-collapsed'}`}
        inert={panel !== 'work'}
      >
        <div className="ws__head ws__head--stack">
          <div className="ws__head-row">
            <span className="ws__heading">{t('workspace.sidebar.tasks')}</span>
            {activeWorkspace && visibleChats.length > 0 && (
              <button
                type="button"
                className={`ws__select-toggle ${selectingChats ? 'is-active' : ''}`}
                aria-pressed={Boolean(selectingChats)}
                title={
                  selectingChats
                    ? t('workspace.select.exit')
                    : t('workspace.select.chats')
                }
                onClick={() =>
                  setSelection((prev) =>
                    prev?.kind === 'chat' ? null : { kind: 'chat', ids: new Set() },
                  )
                }
              >
                {selectingChats
                  ? t('workspace.select.done')
                  : t('workspace.select.start')}
              </button>
            )}
          </div>
          {activeWorkspace && (
            <button
              type="button"
              className="ws__path"
              title={workspacePathLabel(activeWorkspace, t)}
              disabled={!activeWorkspace.path || activeWorkspace.kind === 'remote'}
              onClick={() => void revealWorkspace(activeWorkspace)}
            >
              {workspacePathLabel(activeWorkspace, t)}
            </button>
          )}
          {activeWorkspace && activeHealth && !activeHealth.ok && (
            <div
              className="ws__health"
              role="status"
              title={spaceHealthDetail(activeWorkspace, activeHealth, t)}
            >
              <AlertIcon size={12} />
              <span>{spaceHealthSummary(activeWorkspace, activeHealth, t)}</span>
            </div>
          )}
        </div>
        <div className="ws__tools">
          <div className="search ws__search">
            <SearchIcon size={14} />
            <input
              value={chatQuery}
              placeholder={t('workspace.search.chats')}
              spellCheck={false}
              aria-label={t('workspace.search.tasksAria')}
              disabled={!activeWorkspace}
              onChange={(event) => setChatQuery(event.target.value)}
            />
          </div>
          <button
            className="newchat"
            title={
              activeWorkspace
                ? t('workspace.newTask')
                : t('workspace.newTaskFirstSpace')
            }
            aria-label={t('workspace.newTask')}
            disabled={!activeWorkspace}
            onClick={createChat}
          >
            <PlusIcon size={17} />
          </button>
        </div>
        {selectingChats && selectedChatIds && (
          <div className="ws__selectbar">
            <label className="ws__selectall">
              <input
                type="checkbox"
                checked={
                  visibleChats.length > 0 &&
                  visibleChats.every((chat) => selectedChatIds.has(chat.id))
                }
                onChange={(event) =>
                  selectAllVisible(
                    'chat',
                    visibleChats.map((chat) => chat.id),
                    event.target.checked,
                  )
                }
              />
              {t('workspace.select.all')}
            </label>
            <span className="ws__selectcount">
              {t('workspace.select.count', { count: selectedChatIds.size })}
            </span>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={selectedChatIds.size === 0}
              onClick={() => setPendingBatch({ kind: 'chat', ids: [...selectedChatIds] })}
            >
              {t('workspace.select.delete')}
            </button>
          </div>
        )}
        <div className="ws__list">
          {!activeWorkspace && (
            <div className="ws-hint">{t('workspace.empty.pickSpace')}</div>
          )}
          {activeWorkspace && visibleChats.length === 0 && (
            <div className="ws-hint">
              {chatKeyword
                ? t('workspace.empty.noChatMatch', { query: chatQuery.trim() })
                : t('workspace.empty.spaceNoChats')}
            </div>
          )}
          {(groupingEmployees ? ownChats : visibleChats).map(renderChatRow)}
          {groupingEmployees && employeeChats.length > 0 && (
            <button
              type="button"
              className="ws-group"
              aria-expanded={showEmployees}
              onClick={toggleEmployees}
            >
              {showEmployees ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
              <span className="ws-group__title">{t('workspace.group.employees')}</span>
              <span className="ws-group__count">{employeeChats.length}</span>
              {/* 折叠着也要知道里面有东西在动；等确认比在跑更要紧，只显示一个。 */}
              {employeesWaiting > 0 ? (
                <span className="ws-group__running is-attention">
                  {t('workspace.group.waiting', { count: employeesWaiting })}
                </span>
              ) : employeesRunning > 0 ? (
                <span className="ws-group__running">
                  {t('workspace.group.running', { count: employeesRunning })}
                </span>
              ) : null}
            </button>
          )}
          {groupingEmployees && showEmployees && (
            <div className="ws-group__items">{employeeChats.map(renderChatRow)}</div>
          )}
        </div>
      </aside>

      <aside
        className={`ws__panel ws__files ${panel === 'files' ? '' : 'is-collapsed'}`}
        inert={panel !== 'files'}
      >
        <WorkspaceFiles workspace={activeWorkspace} />
      </aside>

      <div className="ws__main">
        {panel === 'director' && (
          <DirectorPage
            state={director}
            workspaces={workspaces}
            ledger={directorLedger}
            onChange={setDirector}
            onRefreshLedger={refreshDirectorLedger}
            onClearHistory={clearDirectorHistory}
            canClear={Boolean(directorChatId) && streamingId !== directorChatId}
            usageRows={activeUsageRows}
            speed={totalSpeed}
          />
        )}

        {panel === 'director' && floatingTasks.length > 0 && (
          <div className="director__running" aria-label={t('workspace.floating.statusAria')}>
            {floatingTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                className={`director__running-pill is-${task.status}`}
                title={
                  task.status === 'running'
                    ? t('workspace.floating.viewRunning', { title: task.title })
                    : t('workspace.floating.viewDone', { title: task.title })
                }
                onClick={() => setBubbleTaskId(task.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  dismissFloatingTask(task.id);
                }}
              >
                <span className="director__running-dot" aria-hidden="true" />
                <span className="director__running-title">{task.title}</span>
                <span className="director__running-status">
                  {t(FLOATING_STATUS_KEY[task.status])}
                </span>
                <ChevronRightIcon className="director__running-go" size={13} />
              </button>
            ))}
          </div>
        )}

        {bubbleTask && (
          <TaskBubbleDialog
            task={bubbleTask}
            messages={bubbleMessages}
            onClose={() => setBubbleTaskId(null)}
            onSend={(text) => void handleSend(text, [], undefined, bubbleTask.id)}
            onEnter={() => {
              const id = bubbleTask.id;
              setBubbleTaskId(null);
              openFloatingTask(id);
            }}
          />
        )}

        {activeChat ? (
        <ChatView
          compact
          session={activeChat}
          messages={activeMessages}
          models={models}
          model={model}
          kb={chatKb}
          promptId={null}
          promptVariables={EMPTY_PROMPT_VARIABLES}
          streamingId={streamingId}
          phase={phase}
          activity={activity && activity.messageId === streamingId ? activity.value : null}
          // 总监页底部的速度是“所有员工合起来”的速度。
          speed={panel === 'director' ? totalSpeed : speed}
          voice={voice}
          contextLimit={work.contextLimit}
          contextUsed={activeContextUsed}
          sessionUsage={activeSessionUsage}
          focus={chatFocus}
          permissionMode={activeChat.permission ?? 'workspace-write'}
          askLevel={askLevel}
          agents={agents}
          agentId={activeChat.agentId ?? null}
          permission={permission}
          permissionQueue={permissionQueue}
          question={question}
          todos={activeChat.todos}
          planReady={chatLocked ? false : planReady.has(activeChat.id)}
          onPermissionModeChange={chatLocked ? undefined : handlePermissionChange}
          onAskLevelChange={chatLocked ? undefined : handleAskLevelChange}
          onAgentChange={chatLocked ? undefined : handleAgentChange}
          onRefreshAgents={chatLocked ? undefined : refreshAgents}
          dataAccess={chatLocked ? undefined : activeChat.dataAccess}
          onDataAccessChange={chatLocked ? undefined : handleDataAccessChange}
          onResolvePermission={resolvePermission}
          onResolvePermissionQueue={resolvePermissionQueue}
          onResolveQuestion={resolveQuestion}
          onStartPlan={chatLocked ? undefined : handleStartPlan}
          onModelChange={handleModelChange}
          onKbChange={handleKbChange}
          onPromptChange={() => undefined}
          onPromptVariableChange={() => undefined}
          onSend={(text, attachments) => void handleSend(text, attachments)}
          onStop={handleStop}
          onConfigure={onConfigure}
          onTyping={
            activeDirectorWorkspace
              ? (active) => {
                  void window.ezness
                    ?.directorTyping?.(active)
                    ?.catch(() => undefined);
                }
              : undefined
          }
          onDirectorAct={(itemId, action, value) => void actDirector(itemId, action, value)}
          onDirectorOpenTask={openDirectorTask}
          directorSpaces={directorSpaces}
          onDirectorAddSpace={(kind, itemId) => void addDirectorSpace(kind, itemId)}
          onDirectorDeleteSpace={deleteDirectorSpace}
          taskTitles={taskTitles}
          compressionKeepTurns={work.compressionKeepTurns}
          compressing={compressionBusy}
          compressionProgress={compressionProgressLabel}
          compressionError={compressionErrorText}
          compressionDisabledReason={compressionDisabledReason}
          contextMode="task"
          onCompress={() => activeChat && void handleCompress(activeChat.id)}
          onCancelCompress={handleCancelCompression}
          onUndoCompression={(summaryId) =>
            activeChatId && handleUndoCompression(activeChatId, summaryId)
          }
          onShowWarehouse={onShowWarehouse}
          onVisualize={() => setVizOpen(true)}
        />
      ) : (
        <section className="ws-empty">
          <div className="ws-empty__icon">
            <WorkspaceIcon size={24} />
          </div>
          <h2 className="ws-empty__title">
            {activeWorkspace
              ? t('workspace.empty.noChats')
              : t('workspace.sidebar.spaces')}
          </h2>
          <p className="ws-empty__sub">
            {activeWorkspace
              ? t('workspace.empty.hintSpace')
              : t('workspace.empty.hintFirst')}
          </p>
          <button
            className="btn btn--primary"
            onClick={activeWorkspace ? createChat : createWorkspace}
          >
            {activeWorkspace ? t('workspace.newTask') : t('workspace.newSpace')}
          </button>
        </section>
        )}
      </div>

      {notice && <div className="ws__toast">{notice}</div>}

      {vizOpen && vizSpace && vizChat && (
        <WorkspaceVisualize
          workspace={vizSpace}
          workspaceId={vizSpace.id}
          activeChatId={vizChat.id}
          chats={workspaceChats}
          messages={messages}
          usage={usage}
          agents={agents}
          target={vizTarget}
          onClose={() => setVizOpen(false)}
        />
      )}

      {menu &&
        createPortal(
          <>
            <div className="menu-backdrop" onMouseDown={() => setMenu(null)} />
            <div className="session-menu" style={{ top: menu.top, right: menu.right }}>
              <button className="menu__item" onClick={() => togglePin(menu.kind, menu.id)}>
                <span className="menu__label">
                  {menuPinned
                    ? t('workspace.menu.unpin')
                    : menu.kind === 'space'
                      ? t('workspace.menu.pinSpace')
                      : t('workspace.menu.pinChat')}
                </span>
              </button>
              <button className="menu__item" onClick={() => startRename(menu.kind, menu.id)}>
                <span className="menu__label">{t('workspace.menu.rename')}</span>
              </button>
              {menu.kind === 'space' &&
                (() => {
                  const space = workspaces.find((workspace) => workspace.id === menu.id);
                  if (!space?.path) return null;
                  return (
                    <>
                      <button
                        className="menu__item"
                        onClick={() => void copyWorkspacePath(space)}
                      >
                        <span className="menu__label">{t('workspace.menu.copyPath')}</span>
                      </button>
                      {space.kind !== 'remote' && (
                        <button
                          className="menu__item"
                          onClick={() => void revealWorkspace(space)}
                        >
                          <span className="menu__label">{t('workspace.menu.reveal')}</span>
                        </button>
                      )}
                    </>
                  );
                })()}
              {menu.kind === 'chat' && (
                <button
                  className="menu__item"
                  onClick={() => {
                    setMenu(null);
                    void exportChat(menu.id);
                  }}
                >
                  <span className="menu__label">{t('workspace.menu.export')}</span>
                </button>
              )}
              <button
                className="menu__item menu__item--danger"
                onClick={() => requestDelete(menu.kind, menu.id)}
              >
                <span className="menu__label">
                  {menu.kind === 'space'
                    ? t('workspace.menu.deleteSpace')
                    : t('workspace.menu.deleteChat')}
                </span>
              </button>
            </div>
          </>,
          document.body,
        )}

      {pendingDelete &&
        (() => {
          const space =
            pendingDelete.kind === 'space'
              ? workspaces.find((workspace) => workspace.id === pendingDelete.id)
              : null;
          const chat =
            pendingDelete.kind === 'chat'
              ? chats.find((item) => item.id === pendingDelete.id)
              : null;
          const taskCount = space
            ? chats.filter((item) => item.workspaceId === space.id).length
            : 0;
          return (
            <ConfirmDialog
              title={
                space
                  ? t('workspace.menu.deleteSpace')
                  : t('workspace.menu.deleteChat')
              }
              message={
                space
                  ? t('workspace.confirm.deleteSpace', {
                      name: space.name,
                      tasks:
                        taskCount > 0
                          ? t('workspace.confirm.tasksAlso', { count: taskCount })
                          : '',
                    })
                  : t('workspace.confirm.deleteChat', { title: chat?.title ?? '' })
              }
              confirmLabel={t('workspace.confirm.delete')}
              danger
              onConfirm={confirmDelete}
              onCancel={() => setPendingDelete(null)}
            />
          );
        })()}

      {pendingBatch &&
        (() => {
          const count = pendingBatch.ids.length;
          const taskCount =
            pendingBatch.kind === 'space'
              ? chats.filter((chat) => pendingBatch.ids.includes(chat.workspaceId)).length
              : 0;
          return (
            <ConfirmDialog
              title={
                pendingBatch.kind === 'space'
                  ? t('workspace.confirm.batchSpaceTitle')
                  : t('workspace.confirm.batchChatTitle')
              }
              message={
                pendingBatch.kind === 'space'
                  ? t('workspace.confirm.batchSpace', {
                      count,
                      tasks:
                        taskCount > 0
                          ? t('workspace.confirm.tasksAlso', { count: taskCount })
                          : '',
                    })
                  : t('workspace.confirm.batchChat', { count })
              }
              confirmLabel={t('workspace.confirm.batchDelete', { count })}
              danger
              onConfirm={confirmBatchDelete}
              onCancel={() => setPendingBatch(null)}
            />
          );
        })()}

      {addMenu &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onMouseDown={() => setAddMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setAddMenu(null);
              }}
            />
            <div
              className="session-menu add-menu"
              style={{ top: addMenu.y, left: addMenu.x }}
              role="menu"
            >
              <button
                className="menu__item"
                onClick={() => {
                  setAddMenu(null);
                  void createWorkspace();
                }}
              >
                {t('workspace.add.local')}
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  setAddMenu(null);
                  setRemoteDialogId(uid());
                }}
              >
                {t('workspace.add.remote')}
              </button>
            </div>
          </>,
          document.body,
        )}

      {remoteDialogId && (
        <RemoteWorkspaceDialog
          workspaceId={remoteDialogId}
          onCancel={() => {
            directorPickRef.current = '';
            setRemoteDialogId('');
          }}
          onCreated={addRemoteWorkspace}
        />
      )}
    </div>
  );
}
