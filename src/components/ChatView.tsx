import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useI18n, type LanguageVars } from '../i18n';
import { sessionTitle } from '../lib/sessionTitle';
import type {
  AgentActivity,
  AgentDefinition,
  AgentPermission,
  AgentQuestion,
  AskLevel,
  DirectorDeliveredFile,
  DirectorMessageReport,
  DirectorWorkspaceOption,
  KbChatSettings,
  Message,
  ModelOption,
  PermissionMode,
  Session,
  TodoItem,
  ToolStep,
  UsageRecord,
  VoiceSettings,
  WarehouseItem,
  WorkspaceDataAccess,
} from '../types';
import { Composer } from './Composer';
import { AskLevelMenu } from './AskLevelMenu';
import {
  ChartIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  PlugIcon,
  SearchIcon,
  SparkleIcon,
  TrashIcon,
} from './Icons';
import { MarkdownView } from './MarkdownView';
import { MaterialFileIcon } from './MaterialFileIcon';
import { SessionStats } from './SessionStats';
import { formatTokens } from './ContextRing';
import { conversationTokens, isVisible } from '../lib/compression';
import { useStreamText, type StreamText } from '../lib/streamText';

/** Suggestion chips on the empty screen; resolved through `t` when rendered. */
const SUGGESTION_KEYS = ['chat.suggestion.1', 'chat.suggestion.2', 'chat.suggestion.3'] as const;

type Translate = (key: string, vars?: LanguageVars) => string;

/**
 * How many messages stay mounted. Every rendered row is real DOM plus a
 * Markdown tree; a conversation of a few thousand turns made the page itself
 * sluggish. Older rows are unloaded and brought back a page at a time.
 */
const WINDOW_SIZE = 60;
const WINDOW_STEP = 60;

/** Stable fallback so the stats panel's memo does not rebuild every render. */
const EMPTY_USAGE: UsageRecord[] = [];

/** Stable empty list so a missing prop does not defeat the row memo. */
const NO_SPACES: DirectorWorkspaceOption[] = [];

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

interface Props {
  session?: Session;
  messages: Message[];
  models: ModelOption[];
  model: string;
  kb: KbChatSettings;
  promptId: string | null;
  promptVariables: Record<string, string>;
  streamingId: string | null;
  phase: 'retrieving' | 'generating';
  /** Live state of the active run; drives the line under the last message. */
  activity?: AgentActivity | null;
  speed: number | null;
  voice: VoiceSettings;
  /** 设置 → 工作设置 → 最大上下文; the ring in the composer measures against it. */
  contextLimit: number;
  /**
   * Tokens in the last real request for this conversation, provider-reported.
   * Omit while there is no request yet; the ring then estimates from the text.
   */
  contextUsed?: number | null;
  /** Usage ledger rows for this session; fed to the header stats panel. */
  sessionUsage?: UsageRecord[];
  /** Workspace chat: only model, warehouse and web in the composer. */
  compact?: boolean;
  /** Message to scroll to and flash after a warehouse jump. */
  focus?: { messageId: string; nonce: number } | null;
  /** Workspace agent: how much the agent may do without asking. */
  permissionMode?: PermissionMode;
  /** Workspace agent: how often it stops to ask (0 自动 … 3 常规). */
  askLevel?: AskLevel;
  permission?: AgentPermission | null;
  /** Every pending permission from the same run; 2+ renders as one batch card. */
  permissionQueue?: AgentPermission[];
  question?: AgentQuestion | null;
  /** Checklist the agent published for the current task. */
  todos?: TodoItem[];
  /** The last turn ran in plan mode and produced a plan. */
  planReady?: boolean;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onAskLevelChange?: (level: AskLevel) => void;
  /** Workspace only: Agents the composer can enable for this task. */
  agents?: AgentDefinition[];
  /** Workspace only: the Agent enabled for this task, if any. */
  agentId?: string | null;
  onAgentChange?: (agent: AgentDefinition | null) => void;
  /** Reload the Agent list just before the picker opens. */
  onRefreshAgents?: () => void;
  /** Workspace only: which personal data sources the agent may read. */
  dataAccess?: WorkspaceDataAccess;
  onDataAccessChange?: (next: WorkspaceDataAccess) => void;
  onResolvePermission?: (
    allow: boolean,
    remember: boolean,
    note?: string,
    secrets?: Record<string, string>,
    rememberSecrets?: boolean,
  ) => void;
  /** Resolve a whole batch: callId → allow. Missing entries are denied. */
  onResolvePermissionQueue?: (decisions: Record<string, boolean>) => void;
  onResolveQuestion?: (answer: string) => void;
  /** Plan mode finished: switch to execution and send the plan back. */
  onStartPlan?: () => void;
  onModelChange: (id: string) => void;
  onKbChange: (patch: Partial<KbChatSettings>) => void;
  onPromptChange: (id: string | null) => void;
  onPromptVariableChange: (name: string, value: string) => void;
  onSend: (text: string, attachments?: WarehouseItem[]) => void;
  onStop: () => void;
  onConfigure: () => void;
  /** 总监对话：用户正在输入时，总监先别说话。 */
  onTyping?: (active: boolean) => void;
  /** 总监汇报卡片上的按钮（批准/忽略/替工人作答）。 */
  onDirectorAct?: (itemId: string, action: string, value?: string) => void;
  /** 从总监的汇报跳到它提到的任务。 */
  onDirectorOpenTask?: (taskId: string) => void;
  /** 总监等用户选工作空间时，卡片里列出的全部真实空间。 */
  directorSpaces?: DirectorWorkspaceOption[];
  /** 在选空间卡片里添加本地文件夹 / 在线空间。 */
  onDirectorAddSpace?: (kind: 'local' | 'remote', itemId: string) => void;
  /** 在选空间卡片里删除一个工作空间（走确认框）。 */
  onDirectorDeleteSpace?: (id: string) => void;
  /** 任务 id → 任务名，工具调用归并行上显示真正在操作哪个任务。 */
  taskTitles?: Record<string, string>;
  /** Open the warehouse page focused on this file. */
  onShowWarehouse: (id: string) => void;
  /** Workspace only: open the 可视化工具 dialog for the whole workspace. */
  onVisualize?: () => void;
  /* ---- context compression (ring popover) ---- */
  compressionKeepTurns?: number;
  compressing?: boolean;
  compressionProgress?: string | null;
  compressionError?: string | null;
  compressionDisabledReason?: string | null;
  onCompress?: () => void;
  onCancelCompress?: () => void;
  /** Restore the messages a summary card replaced. */
  onUndoCompression?: (summaryId: string) => void;
  /**
   * `task` compression also folds the agent's own history, which cannot be
   * restored one message at a time; the popover says so.
   */
  contextMode?: 'chat' | 'task';
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (window.ezness?.copyText) await window.ezness.copyText(text);
      else await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — leave the button silent */
    }
  }

  return (
    <button className="msg__copy" title={t('chat.copy.title')} onClick={copy}>
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      {copied ? t('chat.copy.copied') : t('chat.copy.label')}
    </button>
  );
}

function formatClock(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const DIRECTOR_KIND_KEYS: Record<DirectorMessageReport['kind'], string> = {
  report: 'chat.director.kind.report',
  alert: 'chat.director.kind.alert',
  confirm: 'chat.director.kind.confirm',
  question: 'chat.director.kind.question',
  advice: 'chat.director.kind.advice',
  audit: 'chat.director.kind.audit',
};

/** 用户处理过之后的落款；没有它就说“已处理”。 */
const DIRECTOR_DONE_KEYS: Record<string, string> = {
  dismiss: 'chat.director.done.dismiss',
  allow: 'chat.director.done.confirmed',
  deny: 'chat.director.done.denied',
  answer: 'chat.director.done.answered',
  approve: 'chat.director.done.confirmed',
  rework: 'chat.director.done.rework',
  accept: 'chat.director.done.accept',
  abandon: 'chat.director.done.abandon',
  choose: 'chat.director.done.choose',
  'choose-model': 'chat.director.done.model',
  ack: 'chat.director.done.ack',
  ignore: 'chat.director.done.ignore',
};

/**
 * 总监交付的文件：这里只拿到工作空间里的路径，不复制文件。
 * 点文件用系统默认程序打开，点文件夹（项目）用文件管理器打开。
 */
function DirectorFileList({
  files,
  onOpened,
}: {
  files: DirectorDeliveredFile[];
  onOpened?: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  if (files.length === 0) return null;

  async function open(file: DirectorDeliveredFile) {
    setError(null);
    const result = await window.ezness
      ?.workspaceOpenFile?.({ workspaceId: file.workspaceId, path: file.path || '.' })
      .catch((cause) => ({ ok: false, error: String(cause?.message ?? cause) }));
    if (!result?.ok) {
      setError(result?.error || t('chat.dirCard.openError'));
      return;
    }
    onOpened?.();
  }

  return (
    <div className="dir-files">
      {files.map((file) => (
        <button
          key={`${file.workspaceId}:${file.path}`}
          type="button"
          className={`dir-file ${file.kind === 'directory' ? 'is-folder' : ''}`}
          title={
            file.kind === 'directory'
              ? t('chat.dirCard.openFolderTitle', { name: file.name })
              : t('chat.dirCard.openTitle', { name: file.name })
          }
          onClick={() => void open(file)}
        >
          <span className="dir-file__icon">
            <MaterialFileIcon
              name={file.name}
              isDir={file.kind === 'directory'}
              size={16}
            />
          </span>
          <span className="dir-file__name">{file.name}</span>
          <span className="dir-file__meta">
            {file.kind === 'directory' ? t('chat.dirCard.openProject') : formatSize(file.size)}
          </span>
        </button>
      ))}
      {error && <p className="dir-files__error">{error}</p>}
    </div>
  );
}

/** 总监在对话里调用发送工具时显示的文件卡片（不占普通工具行）。 */
function DirectorShareCard({ step }: { step: ToolStep }) {
  const { t } = useI18n();
  let data: { note?: string; files?: DirectorDeliveredFile[]; skipped?: string[] } = {};
  try {
    data = JSON.parse(step.result || '{}');
  } catch {
    /* 失败时 result 是错误文本，下面按状态显示 */
  }
  const files = Array.isArray(data.files) ? data.files : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const note = String(data.note ?? step.args?.note ?? '');
  const failed = step.status === 'error' || step.status === 'denied';
  return (
    <div className={`dir-share ${failed ? 'is-error' : ''}`}>
      <div className="dir-share__head">
        <span className="dir-share__title">
          {failed ? t('chat.share.failedTitle') : t('chat.share.title')}
        </span>
        {note && <span className="dir-share__note">{note}</span>}
      </div>
      {files.length > 0 ? (
        <DirectorFileList files={files} />
      ) : (
        <p className="dir-share__empty">
          {failed
            ? step.result || t('chat.share.failed')
            : step.status === 'running'
              ? t('chat.share.sending')
              : t('chat.share.none')}
        </p>
      )}
      {skipped.length > 0 && (
        <p className="dir-share__skipped">
          {t('chat.share.skipped', { files: skipped.join(t('chat.share.separator')) })}
        </p>
      )}
    </div>
  );
}

/**
 * 总监主动发进对话里的那条消息。它和普通回答排在同一个消息流里，需要用户
 * 拍板时就地给按钮，不再单独开一个汇报面板。
 */
/** 总监问「用哪个工作空间」时，卡片里的空间选择器：列表、搜索、增删。 */
function DirectorSpacePicker({
  itemId,
  spaces,
  onAct,
  onAddSpace,
  onDeleteSpace,
}: {
  itemId: string;
  spaces: DirectorWorkspaceOption[];
  onAct?: (itemId: string, action: string, value?: string) => void;
  onAddSpace?: (kind: 'local' | 'remote', itemId: string) => void;
  onDeleteSpace?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const list = useMemo(() => {
    if (!needle) return spaces;
    return spaces.filter((space) => {
      const remote = space.remote
        ? `${space.remote.username}@${space.remote.host}:${space.remote.root}`
        : '';
      return `${space.name} ${space.path} ${remote}`.toLowerCase().includes(needle);
    });
  }, [needle, spaces]);

  return (
    <div className="dir-space">
      <label className="dir-space__search">
        <SearchIcon size={13} />
        <input
          value={query}
          placeholder={t('chat.space.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="dir-space__list" role="listbox" aria-label={t('chat.space.listAria')}>
        {list.length === 0 && (
          <p className="dir-space__empty">
            {spaces.length > 0 ? t('chat.space.noMatch') : t('chat.space.empty')}
          </p>
        )}
        {list.map((space) => {
          const address = space.remote
            ? `${space.remote.username}@${space.remote.host}:${space.remote.root}`
            : space.path;
          return (
            <div key={space.id} className="dir-space__row">
              <button
                type="button"
                className="dir-space__pick"
                title={t('chat.space.useTitle', { name: space.name })}
                onClick={() => onAct?.(itemId, 'choose', space.id)}
              >
                <span className="dir-space__icon">
                  {space.kind === 'remote' ? <GlobeIcon size={14} /> : <FolderIcon size={14} />}
                </span>
                <span className="dir-space__text">
                  <span className="dir-space__name">
                    {space.name}
                    {space.kind === 'remote' && (
                      <em className="dir-space__tag">{t('chat.space.online')}</em>
                    )}
                  </span>
                  <span className="dir-space__path" title={address}>
                    {address}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="dir-space__del"
                title={t('chat.space.deleteTitle')}
                aria-label={t('chat.space.deleteAria', { name: space.name })}
                onClick={() => onDeleteSpace?.(space.id)}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="dir-space__add">
        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => onAddSpace?.('local', itemId)}
        >
          {t('chat.space.addLocal')}
        </button>
        <button
          type="button"
          className="btn btn--tiny"
          onClick={() => onAddSpace?.('remote', itemId)}
        >
          {t('chat.space.addRemote')}
        </button>
        <button
          type="button"
          className="btn btn--tiny dir-space__cancel"
          onClick={() => onAct?.(itemId, 'dismiss')}
        >
          {t('chat.space.cancel')}
        </button>
      </div>
      <p className="dir-space__hint">{t('chat.space.hint')}</p>
    </div>
  );
}

/** 总监发现任务被模型卡住时，卡片里的模型选择器：搜索结果、供应商、直接重试。 */
function DirectorModelPicker({
  itemId,
  models,
  reason,
  onAct,
}: {
  itemId: string;
  models: ModelOption[];
  reason: string;
  onAct?: (itemId: string, action: string, value?: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const list = useMemo(() => {
    if (!needle) return models;
    return models.filter((option) =>
      `${option.label} ${option.providerName} ${option.id}`.toLowerCase().includes(needle),
    );
  }, [needle, models]);

  return (
    <div className="dir-space dir-model">
      <label className="dir-space__search">
        <SearchIcon size={13} />
        <input
          value={query}
          placeholder={t('chat.model.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="dir-space__list" role="listbox" aria-label={t('chat.model.listAria')}>
        {list.length === 0 && (
          <p className="dir-space__empty">
            {models.length > 0 ? t('chat.model.noMatch') : t('chat.model.empty')}
          </p>
        )}
        {list.map((option) => (
          <div key={option.id} className="dir-space__row">
            <button
              type="button"
              className="dir-space__pick"
              title={t('chat.model.retryTitle', { name: option.label })}
              onClick={() => onAct?.(itemId, 'choose-model', option.id)}
            >
              <span className="dir-space__icon">
                <SparkleIcon size={14} />
              </span>
              <span className="dir-space__text">
                <span className="dir-space__name">
                  {option.label}
                  <em className="dir-space__tag">{option.providerName}</em>
                </span>
                <span className="dir-space__path" title={option.hint || option.id}>
                  {option.hint || option.id}
                </span>
              </span>
            </button>
          </div>
        ))}
      </div>
      <div className="dir-space__add">
        <button
          type="button"
          className="btn btn--tiny dir-space__cancel"
          onClick={() => onAct?.(itemId, 'dismiss')}
        >
          {t('chat.model.cancel')}
        </button>
      </div>
      <p className="dir-space__hint">
        {reason ? t('chat.model.reason', { reason }) : t('chat.model.hint')}
      </p>
    </div>
  );
}

function DirectorReportCard({
  message,
  report,
  spaces,
  models,
  onAct,
  onOpenTask,
  onAddSpace,
  onDeleteSpace,
}: {
  message: Message;
  report: DirectorMessageReport;
  spaces: DirectorWorkspaceOption[];
  models: ModelOption[];
  onAct?: (itemId: string, action: string, value?: string) => void;
  onOpenTask?: (taskId: string) => void;
  onAddSpace?: (kind: 'local' | 'remote', itemId: string) => void;
  onDeleteSpace?: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState('');
  const open = report.status === 'open';
  // 审计组的消息不是总监本人说的：换个署名，免得领导以为总监在汇报自己。
  const audit = report.speaker === 'audit';
  const doneKey = DIRECTOR_DONE_KEYS[report.resolution ?? ''];
  return (
    <article
      className={`msg msg--assistant msg--director ${audit ? 'msg--audit' : ''} ${
        open ? '' : 'is-done'
      }`}
      data-message-id={message.id}
    >
      <div className="msg__avatar">
        {audit ? t('chat.director.avatarAudit') : t('chat.director.avatarDirector')}
      </div>
      <div className="msg__content">
        <div className={`dir-msg dir-msg--${report.kind} ${audit ? 'is-audit' : ''}`}>
          <header className="dir-msg__head">
            <span className="dir-msg__kind">
              {audit ? t('chat.director.auditGroup') : t(DIRECTOR_KIND_KEYS[report.kind])}
            </span>
            <span className="dir-msg__title">{report.title}</span>
            {report.mustRead && open && (
              <span className="dir-msg__must">{t('chat.director.mustRead')}</span>
            )}
            {report.needsRead && (
              <span className="dir-msg__need">{t('chat.director.needsRead')}</span>
            )}
            {!open && (
              <span
                className={`dir-msg__state is-${
                  report.status === 'dismissed'
                    ? 'muted'
                    : report.resolution === 'deny' || report.resolution === 'abandon'
                      ? 'no'
                      : 'yes'
                }`}
              >
                {doneKey ? t(doneKey) : t('chat.director.done.handled')}
              </span>
            )}
            <time className="dir-msg__time">{formatClock(message.createdAt, locale)}</time>
          </header>
          <div className="dir-msg__body">
            <MarkdownView text={message.content} />
          </div>
          {open && report.payload?.kind === 'workspace' && (
            <DirectorSpacePicker
              itemId={report.itemId}
              spaces={spaces}
              onAct={onAct}
              onAddSpace={onAddSpace}
              onDeleteSpace={onDeleteSpace}
            />
          )}
          {open && report.payload?.kind === 'model' && (
            <DirectorModelPicker
              itemId={report.itemId}
              models={models}
              reason={typeof report.payload.reason === 'string' ? report.payload.reason : ''}
              onAct={onAct}
            />
          )}
          {report.files && report.files.length > 0 && (
            <DirectorFileList
              files={report.files}
              onOpened={() => {
                // 点开过文件就算读过了，不用再点一次“标记已读”。
                if (report.needsRead) onAct?.(report.itemId, 'read');
              }}
            />
          )}
          {report.needsRead && (
            <button
              type="button"
              className="dir-msg__read"
              onClick={() => onAct?.(report.itemId, 'read')}
            >
              {t('chat.director.markRead')}
            </button>
          )}
          {report.taskTitle && report.taskId && (
            <button
              type="button"
              className="dir-msg__task"
              onClick={() => onOpenTask?.(report.taskId!)}
            >
              {t('chat.director.openTask', { title: report.taskTitle })}
            </button>
          )}
          {open &&
            report.actions.length > 0 &&
            report.payload?.kind !== 'workspace' &&
            report.payload?.kind !== 'model' && (
            <div className="dir-msg__actions">
              {report.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`btn btn--tiny ${
                    action.style === 'primary'
                      ? 'btn--primary'
                      : action.style === 'danger'
                        ? 'btn--danger'
                        : ''
                  }`}
                  onClick={() => onAct?.(report.itemId, action.id)}
                >
                  {action.label}
                </button>
              ))}
              {report.actions.some((action) => action.id === 'answer') && (
                <span className="dir-msg__answer">
                  <input
                    className="input"
                    value={draft}
                    placeholder={t('chat.director.answerPlaceholder')}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--tiny btn--primary"
                    disabled={!draft.trim()}
                    onClick={() => onAct?.(report.itemId, 'answer', draft)}
                  >
                    {t('chat.director.send')}
                  </button>
                </span>
              )}
              <button
                type="button"
                className="btn btn--tiny"
                onClick={() => onAct?.(report.itemId, 'dismiss')}
              >
                {t('chat.director.ack')}
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

const TOOL_KEYS: Record<string, string> = {
  list_files: 'chat.tool.listFiles',
  read_file: 'chat.tool.readFile',
  glob_search: 'chat.tool.globSearch',
  grep_search: 'chat.tool.grepSearch',
  write_file: 'chat.tool.writeFile',
  edit_file: 'chat.tool.editFile',
  run_command: 'chat.tool.runCommand',
  todo_write: 'chat.tool.todoWrite',
  web_search: 'chat.tool.webSearch',
  web_fetch: 'chat.tool.webFetch',
  compact: 'chat.tool.compact',
  ask_user: 'chat.tool.askUser',
  tool_editor_list: 'chat.tool.editorList',
  tool_editor_get: 'chat.tool.editorGet',
  tool_editor_create: 'chat.tool.editorCreate',
  tool_editor_update: 'chat.tool.editorUpdate',
  tool_editor_delete: 'chat.tool.editorDelete',
  tool_editor_test: 'chat.tool.editorTest',
  ai_review: 'chat.tool.aiReview',
};

/** A tool's display name; unknown tools keep their raw identifier. */
function toolLabel(t: Translate, name: string): string {
  const key = TOOL_KEYS[name];
  return key ? t(key) : name;
}

function StepIcon({ name }: { name: string }) {
  const props = { size: 12 };
  if (name === 'run_command') return <PlugIcon {...props} />;
  if (name === 'read_file') return <FileIcon {...props} />;
  if (name === 'write_file' || name === 'edit_file' || name === 'tool_editor_update') {
    return <EditIcon {...props} />;
  }
  if (name === 'list_files' || name === 'tool_editor_list') return <FolderIcon {...props} />;
  if (name === 'todo_write') return <CheckIcon {...props} />;
  if (name === 'compact' || name === 'tool_editor_create') return <SparkleIcon {...props} />;
  if (name === 'tool_editor_delete') return <TrashIcon {...props} />;
  return <SearchIcon {...props} />;
}

function stepSummary(step: ToolStep): string {
  if (step.summary) return step.summary;
  const value = step.args?.path ?? step.args?.pattern ?? step.args?.question ?? '';
  return String(value);
}

/**
 * 同一个工具作用在哪个任务上。不同任务必须分开显示，否则总监连着查两个任务
 * 会被并成一行，看不出中间换了对象。
 */
function stepTarget(step: ToolStep): string | undefined {
  const taskId = step.args?.taskId;
  return typeof taskId === 'string' && taskId ? taskId : undefined;
}

function ToolStepRow({
  step,
  targetLabel,
}: {
  step: ToolStep;
  targetLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status =
    step.status === 'running'
      ? t('chat.step.running')
      : step.status === 'done'
        ? t('chat.step.done')
        : step.status === 'denied'
          ? t('chat.step.denied')
          : t('chat.step.failed');
  const seconds =
    step.status !== 'running' && step.startedAt && step.endedAt
      ? (step.endedAt - step.startedAt) / 1000
      : null;

  return (
    <div className={`step step--${step.status}`}>
      <button
        type="button"
        className="step__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="step__tool">
          <StepIcon name={step.name} />
          {toolLabel(t, step.name)}
        </span>
        <span className="step__summary">{stepSummary(step) || targetLabel}</span>
        <span className="step__status">
          {status}
          {/* A long command is just as silent as a long model call; the timer
              proves it is still running. */}
          {step.status === 'running' && step.startedAt ? (
            <>
              {' · '}
              <Elapsed since={step.startedAt} />
            </>
          ) : (
            seconds !== null ? ` · ${seconds.toFixed(1)}s` : ''
          )}
        </span>
      </button>
      {open && (
        <div className="step__body">
          <pre className="step__args">{JSON.stringify(step.args, null, 2).slice(0, 2400)}</pre>
          {step.result && <pre className="step__result">{step.result.slice(0, 6000)}</pre>}
        </div>
      )}
    </div>
  );
}

/** 连续调用同一工具时收成一行，点开才逐条看每次的内容和参数。 */
function ToolStepGroup({
  name,
  steps,
  taskTitles,
}: {
  name: string;
  steps: ToolStep[];
  taskTitles?: Record<string, string>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const running = steps.some((step) => step.status === 'running');
  const failed = steps.some(
    (step) => step.status === 'error' || step.status === 'denied',
  );
  const status = running
    ? t('chat.step.running')
    : failed
      ? t('chat.step.someFailed')
      : t('chat.step.done');
  const runningSince = steps.find((step) => step.status === 'running')?.startedAt;

  return (
    <div
      className={`step step--group ${
        running ? 'step--running' : failed ? 'step--error' : 'step--done'
      }`}
    >
      <button
        type="button"
        className="step__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="step__tool">
          <StepIcon name={name} />
          {toolLabel(t, name)}
        </span>
        <span className="step__count" title={t('chat.step.countTitle', { count: steps.length })}>
          {steps.length}
        </span>
        <span className="step__status">
          {status}
          {running && runningSince ? (
            <>
              {' · '}
              <Elapsed since={runningSince} />
            </>
          ) : null}
        </span>
      </button>
      {open && (
        <div className="step-group__list">
          {steps.map((step) => {
            const target = stepTarget(step);
            return (
              <ToolStepRow
                key={step.id}
                step={step}
                targetLabel={target ? taskTitles?.[target] : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface RowActions {
  showAttachment: (file: WarehouseItem) => void;
  undoCompression?: (summaryId: string) => void;
  directorAct?: (itemId: string, action: string, value?: string) => void;
  directorOpenTask?: (taskId: string) => void;
  directorAddSpace?: (kind: 'local' | 'remote', itemId: string) => void;
  directorDeleteSpace?: (id: string) => void;
}

interface RowProps {
  message: Message;
  /** This row is the one still being written. */
  streaming: boolean;
  /** Live tail for the streaming row; the stored message gets it when the run ends. */
  live?: StreamText;
  phase: 'retrieving' | 'generating';
  activity?: AgentActivity | null;
  taskTitles?: Record<string, string>;
  spaces: DirectorWorkspaceOption[];
  models: ModelOption[];
  /** Translator identity changes with the language pack, so rows re-render. */
  t: Translate;
  /** Intl locale for the timestamps in this row. */
  locale: string;
  /** A summary card can offer "撤销压缩" only when the parent can handle it. */
  canUndo: boolean;
  /** Stable dispatcher: the parent's callbacks change identity every render. */
  actions: RowActions;
}

/**
 * One transcript row. Memoised on purpose: while an answer streams, the parent
 * re-renders ~20 times a second, and re-parsing the Markdown of every finished
 * message at that rate is what made long conversations lag — even while typing.
 * Only the row whose message object actually changed is rendered again.
 */
function ChatMessageRowView({
  message,
  streaming,
  live,
  phase,
  activity,
  taskTitles,
  spaces,
  models,
  t,
  locale,
  canUndo,
  actions,
}: RowProps) {
  if (message.director) {
    return (
      <DirectorReportCard
        message={message}
        report={message.director}
        spaces={spaces}
        models={models}
        onAct={actions.directorAct}
        onOpenTask={actions.directorOpenTask}
        onAddSpace={actions.directorAddSpace}
        onDeleteSpace={actions.directorDeleteSpace}
      />
    );
  }

  if (message.summary) {
    return (
      <article className="msg msg--assistant msg--summary" data-message-id={message.id}>
        <div className="msg__avatar">{t('chat.summary.avatar')}</div>
        <div className="msg__content">
          <div className="msg__bubble summary-card">
            <div className="summary-card__head">
              <span className="summary-card__badge">{t('chat.summary.title')}</span>
              <span className="summary-card__stats">
                {t('chat.summary.stats', {
                  count: message.summary.count,
                  before: formatTokens(message.summary.tokensBefore),
                  after: formatTokens(message.summary.tokensAfter),
                })}
              </span>
            </div>
            <MarkdownView text={message.content} />
            <div className="summary-card__foot">
              <span>{t('chat.summary.note')}</span>
              {canUndo && (
                <button
                  className="summary-card__undo"
                  onClick={() => actions.undoCompression?.(message.id)}
                >
                  {t('chat.summary.undo')}
                </button>
              )}
            </div>
          </div>
        </div>
      </article>
    );
  }

  // The streaming row shows what has arrived so far; finished rows have no live
  // tail and read straight from the stored message.
  const thinking = live ? (message.thinking ?? '') + live.thinking : message.thinking;
  const content = live ? message.content + live.content : message.content;

  return (
    <article className={`msg msg--${message.role}`} data-message-id={message.id}>
      <div className="msg__avatar">
        {message.role === 'user' ? t('chat.avatar.user') : 'E'}
      </div>
      <div className="msg__content">
        {message.role === 'assistant' && thinking && (
          <details className="msg__think" open={streaming}>
            <summary>{t('chat.thinking')}</summary>
            <div className="msg__think-body">{thinking}</div>
          </details>
        )}

        {message.role === 'assistant' && message.steps && message.steps.length > 0 && (
          <ToolSteps steps={message.steps} taskTitles={taskTitles} />
        )}

        {(message.role === 'assistant' || content) && (
          <div className="msg__bubble">
            {message.role === 'assistant' ? (
              <MarkdownView text={content} citations={message.citations} />
            ) : (
              content
            )}
            {streaming &&
              (activity ? (
                <ActivityLine activity={activity} />
              ) : (
                !content && (
                  <span className="msg__typing">
                    {phase === 'retrieving'
                      ? t('chat.typing.retrieving')
                      : message.thinking
                        ? t('chat.typing.thinking')
                        : t('chat.typing.generating')}
                  </span>
                )
              ))}
          </div>
        )}

        {message.role === 'user' && message.attachments && message.attachments.length > 0 && (
          <div className="msg__files">
            {message.attachments.map((file) => (
              <button
                key={file.id}
                className="msg__file"
                title={t('chat.attachment.title', {
                  name: file.name,
                  size: formatSize(file.size),
                })}
                onClick={() => actions.showAttachment(file)}
              >
                <span className="msg__file-ext">{extLabel(file.ext)}</span>
                <span className="msg__file-name">{file.name}</span>
                <span className="msg__file-size">{formatSize(file.size)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="msg__foot">
          <time className="msg__time">{formatClock(message.createdAt, locale)}</time>
          {message.stopped && <span className="msg__stopped">{t('chat.stopped')}</span>}
          {content && <CopyButton text={content} />}
        </div>

        {message.role === 'assistant' && message.sources && message.sources.length > 0 && (
          <div
            className="msg__sources"
            title={message.sources.join(t('chat.sources.separator'))}
          >
            {t('chat.sources.prefix', { list: message.sources.join(' · ') })}
          </div>
        )}
      </div>
    </article>
  );
}

function sameRow(prev: RowProps, next: RowProps): boolean {
  if (prev.message !== next.message) return false;
  if (prev.streaming !== next.streaming) return false;
  if (prev.live !== next.live) return false;
  if (prev.taskTitles !== next.taskTitles) return false;
  if (prev.canUndo !== next.canUndo) return false;
  // `t` changes identity when the language pack changes; rows that cached
  // translated text must not be skipped then.
  if (prev.t !== next.t) return false;
  if (prev.locale !== next.locale) return false;
  // Only the streaming row needs the live activity/phase; everyone else keeps
  // whatever they had, so a phase flip does not wake the whole transcript.
  if (next.streaming) {
    if (prev.activity !== next.activity) return false;
    if (prev.phase !== next.phase) return false;
  }
  if (next.message.director && (prev.spaces !== next.spaces || prev.models !== next.models)) {
    return false;
  }
  return true;
}

const ChatMessageRow = memo(ChatMessageRowView, sameRow);

export function ToolSteps({
  steps,
  taskTitles,
}: {
  steps: ToolStep[];
  taskTitles?: Record<string, string>;
}) {
  // Todo updates are shown as a live checklist instead of one row per call.
  const visible = steps.filter((step) => step.name !== 'todo_write');
  if (visible.length === 0) return null;
  // 只合并“连续”的同名调用，不看参数、不看 taskId：
  // A A A → 一行 ×3；A B A → 三行。中途换了工具就另起一行，
  // 回头再做同一件事也另起一行，压缩以后仍然按时间链展开。
  // 发文件是交付动作，单独成卡片，不塞进工具行里。
  type Run =
    | { kind: 'steps'; name: string; steps: ToolStep[] }
    | { kind: 'share'; step: ToolStep };
  const runs: Run[] = [];
  for (const step of visible) {
    if (step.name === 'director_send') {
      runs.push({ kind: 'share', step });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last?.kind === 'steps' && last.name === step.name) last.steps.push(step);
    else runs.push({ kind: 'steps', name: step.name, steps: [step] });
  }
  return (
    <div className="steps">
      {runs.map((run) => {
        if (run.kind === 'share') {
          return <DirectorShareCard key={run.step.id} step={run.step} />;
        }
        if (run.steps.length > 1) {
          return (
            <ToolStepGroup
              key={`${run.name}:${run.steps[0].id}`}
              name={run.name}
              steps={run.steps}
              taskTitles={taskTitles}
            />
          );
        }
        // 单条时补上任务本名，别让「查看任务」这类说法顶替掉它。
        const target = stepTarget(run.steps[0]);
        return (
          <ToolStepRow
            key={run.steps[0].id}
            step={run.steps[0]}
            targetLabel={target ? taskTitles?.[target] : undefined}
          />
        );
      })}
    </div>
  );
}

/** Seconds since `since`, re-rendered once a second. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <>{seconds}s</>;
}

/**
 * One line explaining the silence: either the model is still writing a tool
 * call's arguments (which stream no text), or every tool has finished and the
 * app is waiting for the model's next step.
 */
function ActivityLine({ activity }: { activity: AgentActivity }) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity.since]);
  const seconds = Math.max(0, Math.floor((now - activity.since) / 1000));
  // 模型/网络挂住时，这里会一直停在“正在生成”；超过两分钟就把“可能卡住”
  // 说出来，别让用户以为只是慢。真正的判断和处置在总监那边做。
  const stalled = seconds >= 120;
  const stallHint = stalled ? (
    <span className="msg__activity-stalled">
      {' '}· {t('chat.activity.stalled', { minutes: Math.floor(seconds / 60) })}
    </span>
  ) : null;
  if (activity.kind === 'tool_call') {
    const label = activity.name
      ? toolLabel(t, activity.name)
      : t('chat.activity.toolFallback');
    return (
      <span className={`msg__activity${stalled ? ' is-stalled' : ''}`}>
        {t('chat.activity.generatingTool', { tool: label })}
        {activity.chars >= 200 && (
          <>
            {' '}
            {t('chat.activity.chars', {
              count: activity.chars.toLocaleString(locale),
            })}
          </>
        )}
        {activity.chars < 200 ? ' ' : ''}
        <Elapsed since={activity.since} />
        {stallHint}
      </span>
    );
  }
  return (
    <span className={`msg__activity${stalled ? ' is-stalled' : ''}`}>
      {t('chat.activity.waiting')} <Elapsed since={activity.since} />
      {stallHint}
    </span>
  );
}

export function ChatView({
  session,
  messages,
  models,
  model,
  kb,
  promptId,
  promptVariables,
  streamingId,
  phase,
  activity,
  speed,
  voice,
  contextLimit,
  contextUsed: reportedContextUsed,
  sessionUsage,
  compact = false,
  focus,
  permissionMode,
  askLevel,
  permission,
  permissionQueue,
  question,
  todos,
  planReady = false,
  agents,
  agentId = null,
  onPermissionModeChange,
  onAskLevelChange,
  onAgentChange,
  onRefreshAgents,
  dataAccess,
  onDataAccessChange,
  onResolvePermission,
  onResolvePermissionQueue,
  onResolveQuestion,
  onStartPlan,
  onModelChange,
  onKbChange,
  onPromptChange,
  onPromptVariableChange,
  onSend,
  onStop,
  onConfigure,
  onTyping,
  onDirectorAct,
  onDirectorOpenTask,
  directorSpaces = NO_SPACES,
  onDirectorAddSpace,
  onDirectorDeleteSpace,
  taskTitles,
  onShowWarehouse,
  onVisualize,
  compressionKeepTurns = 3,
  compressing = false,
  compressionProgress = null,
  compressionError = null,
  compressionDisabledReason = null,
  onCompress,
  onCancelCompress,
  onUndoCompression,
  contextMode = 'chat',
}: Props) {
  const { t, locale } = useI18n();
  // The tail of the answer being written. Subscribing here keeps this view in
  // step without the page that owns the transcript re-rendering per token. A
  // run in some other conversation is none of this view's business.
  const liveId =
    streamingId && messages.some((message) => message.id === streamingId)
      ? streamingId
      : null;
  const liveText = useStreamText(liveId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState('');
  /**
   * The user's own prompt that the reader has scrolled past, pinned to the top
   * of the transcript. Long tool-heavy answers make it easy to forget what was
   * actually asked; this keeps it in view without stealing list space.
   */
  const [stuckPrompt, setStuckPrompt] = useState<{ id: string; text: string } | null>(null);
  /**
   * 还有需要用户拍板的总监消息没在视野里时，显示一个带数字的箭头指向上/下。
   * 它只数真正“待操作”的（open 且带按钮），普通汇报不打扰。
   */
  const [pendingHint, setPendingHint] = useState<{
    count: number;
    direction: 'up' | 'down';
  } | null>(null);

  // Credentials for a permission card. They live in this component only: never
  // in the message list, never in the composer, never in a model request.
  const secretFields = permission?.secrets ?? [];
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretReveal, setSecretReveal] = useState<Record<string, boolean>>({});
  const [secretRemember, setSecretRemember] = useState(true);
  useEffect(() => {
    setSecretValues({});
    setSecretReveal({});
    setSecretRemember(true);
  }, [permission?.callId]);
  const secretsReady = secretFields.every(
    (field) => !field.required || String(secretValues[field.name] ?? '').trim() !== '',
  );

  // Batch approvals: when a step fired several independent reads, the loop is
  // waiting on all of them at once. One card answers the whole step. Dangerous
  // items start unchecked, so approving one always takes a deliberate click.
  const batchPermission = permissionQueue && permissionQueue.length > 1 ? permissionQueue : null;
  const batchKey = batchPermission
    ? batchPermission.map((item) => `${item.requestId}:${item.callId}`).join('|')
    : '';
  const [batchAllow, setBatchAllow] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!batchPermission) return;
    const next: Record<string, boolean> = {};
    for (const item of batchPermission) next[item.callId] = !item.danger;
    setBatchAllow(next);
    // batchKey is the identity of the queue; the array is rebuilt on every
    // parent render, but the selection must survive streaming deltas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchKey]);
  const batchAllowed = batchPermission
    ? batchPermission.filter((item) => batchAllow[item.callId] ?? !item.danger).length
    : 0;

  // What the next turn will carry. A recorded request is exact and already
  // includes the system prompt, tool schemas and tool results the transcript
  // never shows; without one, fall back to the visible text.
  const contextUsed = useMemo(() => {
    if (typeof reportedContextUsed === 'number' && Number.isFinite(reportedContextUsed)) {
      return Math.max(0, Math.round(reportedContextUsed));
    }
    return conversationTokens(messages.filter(isVisible));
  }, [messages, reportedContextUsed]);

  // The checklist floats above the composer, so it folds itself away once the
  // last item is done. A new checklist (or a reopened item) unfolds it again.
  const completedTodos = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
  const allTodosDone = Boolean(todos && todos.length > 0 && completedTodos === todos.length);
  const [todosCollapsed, setTodosCollapsed] = useState(allTodosDone);
  const prevAllDone = useRef(allTodosDone);
  useEffect(() => {
    if (prevAllDone.current === allTodosDone) return;
    prevAllDone.current = allTodosDone;
    setTodosCollapsed(allTodosDone);
  }, [allTodosDone]);

  useEffect(() => {
    setAnswerDraft('');
  }, [question?.callId]);
  const toastTimer = useRef(0);
  const lastContent = (messages[messages.length - 1]?.content ?? '') + liveText.content;
  const lastThinking = (messages[messages.length - 1]?.thinking ?? '') + liveText.thinking;

  /** Follow new tokens only while the reader is at the bottom of the list. */
  const stickRef = useRef(true);
  const pinnedAt = useRef(0);
  const prevSession = useRef(session?.id);
  const prevCount = useRef(messages.length);

  // The trailing window of messages that is actually mounted. Reset in the
  // render phase so switching between two long conversations never paints the
  // previous window size over the new transcript for a frame.
  const [windowState, setWindowState] = useState<{ session?: string; count: number }>({
    session: session?.id,
    count: WINDOW_SIZE,
  });
  if (windowState.session !== session?.id) {
    setWindowState({ session: session?.id, count: WINDOW_SIZE });
  }
  const visibleCount =
    windowState.session === session?.id ? windowState.count : WINDOW_SIZE;
  const hiddenCount = Math.max(0, messages.length - visibleCount);
  const shownMessages = hiddenCount > 0 ? messages.slice(hiddenCount) : messages;

  /** While prepending older rows, keep the reader's line where it was. */
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const pendingJump = useRef<{
    id: string;
    block: ScrollLogicalPosition;
    flash?: boolean;
  } | null>(null);

  function growWindow(count: number) {
    setWindowState((prev) => ({
      session: session?.id,
      count: Math.max(prev.session === session?.id ? prev.count : WINDOW_SIZE, count),
    }));
  }

  function loadEarlier() {
    const el = bodyRef.current;
    scrollAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    stickRef.current = false;
    growWindow(visibleCount + WINDOW_STEP);
  }

  useLayoutEffect(() => {
    const el = bodyRef.current;
    const anchor = scrollAnchor.current;
    scrollAnchor.current = null;
    if (!el || !anchor || el.clientHeight === 0) return;
    // Height above the viewport grew by exactly the restored rows.
    el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    pinnedAt.current = performance.now();
  }, [visibleCount]);

  // A jump target can live above the mounted window: grow first, scroll once
  // the row is actually in the DOM.
  useEffect(() => {
    const jump = pendingJump.current;
    if (!jump) return;
    const node = bodyRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${jump.id}"]`,
    );
    if (!node) return;
    pendingJump.current = null;
    stickRef.current = false;
    node.scrollIntoView({ block: jump.block, behavior: 'smooth' });
    if (jump.flash) {
      node.classList.add('msg--target');
      window.setTimeout(() => node.classList.remove('msg--target'), 2200);
    }
  }, [visibleCount, messages.length]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const awayFromBottom = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight > 80;

    // An upward wheel is the reader saying "I want to look at history".
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickRef.current = false;
    };
    const onScroll = () => {
      // Our own pin animates scrollTop too and its scroll event lands a frame
      // later, after more tokens may have grown the page — that distance says
      // nothing about where the reader wants to be. Ignore those, and only
      // read real user scrolls.
      if (performance.now() - pinnedAt.current < 200) return;
      stickRef.current = !awayFromBottom();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    // Track session switches and new messages even while the view is hidden:
    // the page that is not shown has display:none, so its scroll height is 0.
    if (prevSession.current !== session?.id) {
      prevSession.current = session?.id;
      stickRef.current = true;
    }
    // A brand-new message (not just a token) always pulls the view down.
    if (messages.length > prevCount.current) stickRef.current = true;
    prevCount.current = messages.length;

    const el = bodyRef.current;
    if (!el || el.clientHeight === 0) return;
    if (!stickRef.current) return;
    pinnedAt.current = performance.now();
    el.scrollTop = el.scrollHeight;
    // Code highlighting and images settle a beat later; without this second
    // pin the view can stop slightly above the newest message.
    const settle = window.setTimeout(() => {
      if (!stickRef.current) return;
      pinnedAt.current = performance.now();
      el.scrollTop = el.scrollHeight;
    }, 120);
    return () => window.clearTimeout(settle);
  }, [messages.length, lastContent, lastThinking, session?.id]);

  /**
   * A view hidden by `display:none` has no height when a session is opened from
   * another page, so the effect above could not scroll it. The moment it gets a
   * height again, land on the newest message — the place the user expects to
   * start reading.
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let hidden = el.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        hidden = true;
        return;
      }
      if (!hidden) return;
      hidden = false;
      if (!stickRef.current) return;
      pinnedAt.current = performance.now();
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const userMessages = useMemo(
    () => messages.filter((message) => message.role === 'user' && !message.summary),
    [messages],
  );

  // 总监发来的、还等着用户点按钮的消息。
  const pendingConfirms = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.director &&
          message.director.status === 'open' &&
          message.director.actions.length > 0,
      ),
    [messages],
  );
  const pendingRef = useRef(pendingConfirms);
  pendingRef.current = pendingConfirms;
  const pendingKey = pendingConfirms
    .map((message) => `${message.id}:${message.director?.status}`)
    .join('|');

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || pendingRef.current.length === 0) {
      setPendingHint(null);
      return;
    }
    const nodes = pendingRef.current
      .map((message) =>
        el.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`),
      )
      .filter((node): node is HTMLElement => Boolean(node));
    if (nodes.length === 0) {
      // Nothing to measure — every pending card sits above the mounted window.
      setPendingHint({ count: pendingRef.current.length, direction: 'up' });
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (el.clientHeight === 0) return;
      const box = el.getBoundingClientRect();
      let above = 0;
      let below = 0;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= box.top + 2) above += 1;
        else if (rect.top >= box.bottom - 2) below += 1;
      }
      const count = pendingRef.current.length;
      setPendingHint(
        count === 0
          ? null
          : below > 0
            ? { count, direction: 'down' }
            : above > 0
              ? { count, direction: 'up' }
              : null,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    const list = el.querySelector('.messages');
    if (list) observer.observe(list);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [pendingKey, session?.id]);

  function jumpToPending(direction: 'up' | 'down') {
    const el = bodyRef.current;
    if (!el) return;
    // 有待确认的卡片在窗口之外（更早的历史）：先把那段载回来再滚过去。
    const rendered = new Set<string>();
    for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const id = node.dataset.messageId;
      if (id) rendered.add(id);
    }
    const offWindow = pendingRef.current.find((message) => !rendered.has(message.id));
    if (offWindow) {
      const index = messages.findIndex((message) => message.id === offWindow.id);
      if (index >= 0) {
        pendingJump.current = { id: offWindow.id, block: 'center' };
        growWindow(messages.length - index + 8);
        return;
      }
    }
    const box = el.getBoundingClientRect();
    const nodes = pendingRef.current
      .map((message) =>
        el.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`),
      )
      .filter((node): node is HTMLElement => Boolean(node));
    if (nodes.length === 0) return;
    const target =
      direction === 'down'
        ? nodes.find((node) => node.getBoundingClientRect().top >= box.bottom - 2) ??
          nodes[nodes.length - 1]
        : [...nodes]
            .reverse()
            .find((node) => node.getBoundingClientRect().bottom <= box.top + 2) ??
          nodes[0];
    stickRef.current = false;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // The scroll handler is attached once per conversation; the list it reads
  // changes on every streamed token, so it reads the latest array via a ref.
  // 滚动时每帧都要判断“哪条提问被卷上去了”。按 id 建一次表，量的是已挂载的
  // DOM 节点，而不是拿每条历史消息去 querySelector 一遍。
  const userTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of userMessages) map.set(message.id, message.content);
    return map;
  }, [userMessages]);
  const userTextRef = useRef(userTextById);
  userTextRef.current = userTextById;
  // Only a conversation switch clears the pin; a growing transcript re-measures
  // in place, so the reader keeps the question they were looking at.
  const stuckSession = useRef<string | undefined>(session?.id);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stuckSession.current !== session?.id) {
      stuckSession.current = session?.id;
      setStuckPrompt(null);
    }
    let frame = 0;

    const measure = () => {
      frame = 0;
      // display:none views have no geometry; the next visible scroll measures.
      if (el.clientHeight === 0) return;
      const top = el.getBoundingClientRect().top;
      let found: { id: string; text: string } | null = null;
      // Walk the mounted rows in document order; only user rows count.
      for (const node of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const id = node.dataset.messageId;
        if (!id) continue;
        const text = userTextRef.current.get(id);
        if (text === undefined) continue;
        // Fully above the scrollport: this is the prompt now hidden by answers.
        if (node.getBoundingClientRect().bottom <= top + 4) {
          found = { id, text };
        } else {
          break;
        }
      }
      setStuckPrompt((prev) =>
        prev?.id === found?.id && prev?.text === found?.text ? prev : found,
      );
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // Re-attach on conversation switch and when the transcript grows.
  }, [session?.id, messages.length]);

  function jumpToPrompt(id: string) {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!el) {
      // The prompt is older than the mounted window — load up to it, then jump.
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return;
      pendingJump.current = { id, block: 'start' };
      growWindow(messages.length - index + 8);
      return;
    }
    stickRef.current = false;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // Warehouse jump: center the referenced turn and flash it briefly. The frame
  // lets a just-activated view lay out before scrollIntoView measures it.
  useEffect(() => {
    if (!focus) return;
    const node = bodyRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${focus.messageId}"]`,
    );
    if (!node) {
      const index = messages.findIndex((message) => message.id === focus.messageId);
      if (index >= 0) {
        pendingJump.current = { id: focus.messageId, block: 'center', flash: true };
        growWindow(messages.length - index + 8);
      }
      return;
    }
    stickRef.current = false;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${focus.messageId}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('msg--target');
      timer = window.setTimeout(() => el.classList.remove('msg--target'), 2200);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
    // `messages` is only read to locate an off-window target; re-running on
    // every token would keep re-centering the same message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  function flash(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }

  /**
   * A message keeps its attachment list forever, but the warehouse file behind
   * it can be deleted. Check the manifest first: missing → explain it, present
   * → open the warehouse and land on that row.
   */
  async function showAttachment(file: WarehouseItem) {
    const snapshot = await window.ezness?.warehouseSnapshot();
    if (!snapshot || !snapshot.items.some((item) => item.id === file.id)) {
      flash(t('chat.attachment.missing', { name: file.name }));
      return;
    }
    onShowWarehouse(file.id);
  }

  // Rows stay mounted across renders, so the callbacks they hold must be one
  // stable object that always forwards to this render's props.
  const actionsRef = useRef<RowActions>({ showAttachment });
  actionsRef.current = {
    showAttachment,
    undoCompression: onUndoCompression,
    directorAct: onDirectorAct,
    directorOpenTask: onDirectorOpenTask,
    directorAddSpace: onDirectorAddSpace,
    directorDeleteSpace: onDirectorDeleteSpace,
  };
  const rowActions = useMemo<RowActions>(
    () => ({
      showAttachment: (file) => void actionsRef.current.showAttachment(file),
      undoCompression: (id) => actionsRef.current.undoCompression?.(id),
      directorAct: (itemId, action, value) =>
        actionsRef.current.directorAct?.(itemId, action, value),
      directorOpenTask: (taskId) => actionsRef.current.directorOpenTask?.(taskId),
      directorAddSpace: (kind, itemId) =>
        actionsRef.current.directorAddSpace?.(kind, itemId),
      directorDeleteSpace: (id) => actionsRef.current.directorDeleteSpace?.(id),
    }),
    [],
  );

  const current = models.find((item) => item.id === model) ?? null;

  return (
    <main className="chat">
      <header className="chat__head">
        <div className="chat__title">
          <span>{session ? sessionTitle(session.title, t) : compact ? t('chat.newTask') : t('chat.newChat')}</span>
          {messages.length > 0 && (
            <span className="chat__count">
              {t('chat.messageCount', { count: messages.length })}
            </span>
          )}
        </div>
        <div className="chat__actions">
          <SessionStats records={sessionUsage ?? EMPTY_USAGE} compact={compact} />
          {compact && askLevel !== undefined && onAskLevelChange && (
            <AskLevelMenu
              value={askLevel}
              disabled={streamingId !== null}
              onChange={onAskLevelChange}
            />
          )}
          <span className={`pill ${current ? '' : 'pill--warn'}`}>
            {current ? current.label : t('chat.noModel')}
          </span>
          {compact && onVisualize && (
            <button
              type="button"
              className="chat__viz"
              title={t('chat.visualize.title')}
              onClick={onVisualize}
            >
              <ChartIcon size={14} />
              {t('chat.visualize.label')}
            </button>
          )}
        </div>
      </header>

      {stuckPrompt && (
        <button
          type="button"
          className="chat__stuck"
          title={t('chat.stuck.jumpTitle')}
          onClick={() => jumpToPrompt(stuckPrompt.id)}
        >
          <span className="chat__stuck-tag">{t('chat.stuck.tag')}</span>
          <span className="chat__stuck-text">
            {stuckPrompt.text.replace(/\s+/g, ' ').trim() || t('chat.stuck.attachment')}
          </span>
        </button>
      )}

      <div className="chat__body" ref={bodyRef}>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty__logo">
              <SparkleIcon size={26} />
            </div>
            <h1 className="empty__title">
              {compact ? t('chat.empty.newTaskTitle') : t('chat.empty.newChatTitle')}
            </h1>
            <p className="empty__sub">
              {current
                ? t('chat.empty.currentModel', {
                    model: current.label,
                    hint: current.hint ?? t('chat.empty.local'),
                  })
                : t('chat.empty.noModel')}
            </p>
            {current ? (
              <div className="empty__chips">
                {SUGGESTION_KEYS.map((key) => {
                  const text = t(key);
                  return (
                    <button
                      key={key}
                      className="empty__chip"
                      onClick={() => onSend(text)}
                    >
                      {text}
                    </button>
                  );
                })}
              </div>
            ) : (
              <button className="btn btn--primary" onClick={onConfigure}>
                {t('chat.empty.connect')}
              </button>
            )}
          </div>
        ) : (
          <div className="messages">
            {hiddenCount > 0 && (
              <button type="button" className="messages__earlier" onClick={loadEarlier}>
                <span>
                  {t('chat.window.loadEarlier', {
                    count: Math.min(WINDOW_STEP, hiddenCount),
                  })}
                </span>
                <span className="messages__earlier-rest">
                  {t('chat.window.hidden', { count: hiddenCount })}
                </span>
              </button>
            )}
            {shownMessages.map((message) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                streaming={message.id === streamingId}
                live={message.id === liveId ? liveText : undefined}
                phase={phase}
                activity={message.id === streamingId ? activity : undefined}
                taskTitles={taskTitles}
                spaces={directorSpaces}
                models={models}
                t={t}
                locale={locale}
                canUndo={Boolean(onUndoCompression)}
                actions={rowActions}
              />
            ))}
          </div>
        )}
      </div>

      {pendingHint && (
        <button
          type="button"
          className={`chat__pending chat__pending--${pendingHint.direction}`}
          title={t(
            pendingHint.direction === 'down'
              ? 'chat.pending.titleDown'
              : 'chat.pending.titleUp',
            { count: pendingHint.count },
          )}
          aria-label={t('chat.pending.aria', { count: pendingHint.count })}
          onClick={() => jumpToPending(pendingHint.direction)}
        >
          <svg className="chat__pending-shape" viewBox="0 0 36 42" aria-hidden="true">
            <path d="M 2 17 A 16 16 0 0 1 34 17 L 21.5 34.5 Q 18 40 14.5 34.5 Z" />
          </svg>
          <span className="chat__pending-count">
            {pendingHint.count > 99 ? '99+' : pendingHint.count}
          </span>
        </button>
      )}

      {batchPermission ? (
        <div className="perm perm--batch">
          <div className="perm__title">
            {t('chat.batch.title', { count: batchPermission.length })}
          </div>
          <div className="perm__reason">{t('chat.batch.reason')}</div>
          <div className="perm__list">
            {batchPermission.map((item) => {
              const checked = batchAllow[item.callId] ?? !item.danger;
              return (
                <label
                  key={`${item.requestId}:${item.callId}`}
                  className={`perm__item ${item.danger ? 'is-danger' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      setBatchAllow((prev) => ({ ...prev, [item.callId]: event.target.checked }))
                    }
                  />
                  <span className="perm__item-body">
                    <span className="perm__item-name">{item.name}</span>
                    <span className="perm__item-summary">{item.summary || item.reason}</span>
                    {item.danger && (
                      <span className="perm__tag">{t('chat.batch.danger')}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="perm__actions">
            <button
              className="btn btn--primary"
              onClick={() => onResolvePermissionQueue?.(batchAllow)}
            >
              {t('chat.batch.allow', {
                allowed: batchAllowed,
                denied: batchPermission.length - batchAllowed,
              })}
            </button>
            <button className="btn" onClick={() => onResolvePermissionQueue?.({})}>
              {t('chat.batch.denyAll')}
            </button>
          </div>
        </div>
      ) : permission && (
        <div className={`perm ${permission.danger ? 'perm--danger' : ''}`}>
          <div className="perm__title">
            {permission.reviewReason
              ? t('chat.perm.reviewTitle')
              : permission.danger
                ? t('chat.perm.dangerTitle')
                : t('chat.perm.title')}
          </div>
          {permission.reviewReason && (
            <div className="perm__review">
              <span className="perm__review-label">{t('chat.perm.reviewLabel')}</span>
              <p className="perm__review-text">{permission.reviewReason}</p>
            </div>
          )}
          <div className="perm__reason">
            <span>{permission.reason}</span>
            {permission.summary && <code className="perm__cmd">{permission.summary}</code>}
          </div>
          {secretFields.length > 0 && (
            <div className="perm__secrets">
              <div className="perm__secrets-head">{t('chat.perm.secretsIntro')}</div>
              {secretFields.map((field) => (
                <label className="perm__secret" key={field.name}>
                  <span className="perm__secret-label">
                    {field.description || field.name}
                    {field.required && <em>{t('chat.perm.required')}</em>}
                  </span>
                  {field.kind === 'file' ? (
                    <div
                      className="perm__secret-file"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        const picked = file ? window.ezness?.getPathForFile?.(file) : '';
                        if (picked) {
                          setSecretValues((prev) => ({ ...prev, [field.name]: picked }));
                        }
                      }}
                    >
                      <input
                        className="input"
                        value={secretValues[field.name] ?? ''}
                        onChange={(event) =>
                          setSecretValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                        }
                        placeholder={t('chat.perm.dropFile')}
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={async () => {
                          const picked = await window.ezness?.agentPickSecretFile?.({
                            title: field.description || t('chat.perm.pickFile'),
                          });
                          if (picked) {
                            setSecretValues((prev) => ({ ...prev, [field.name]: picked }));
                          }
                        }}
                      >
                        {t('chat.perm.pickFile')}
                      </button>
                    </div>
                  ) : (
                    <div className="perm__secret-text">
                      <input
                        className="input"
                        type={secretReveal[field.name] ? 'text' : 'password'}
                        value={secretValues[field.name] ?? ''}
                        onChange={(event) =>
                          setSecretValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                        }
                        placeholder={t('chat.perm.secretPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setSecretReveal((prev) => ({ ...prev, [field.name]: !prev[field.name] }))
                        }
                      >
                        {secretReveal[field.name] ? t('chat.perm.hide') : t('chat.perm.show')}
                      </button>
                    </div>
                  )}
                </label>
              ))}
              <label className="cap-check perm__secret-remember">
                <input
                  type="checkbox"
                  checked={secretRemember}
                  onChange={(event) => setSecretRemember(event.target.checked)}
                />
                {t('chat.perm.remember')}
              </label>
            </div>
          )}
          <div className="perm__actions">
            <button
              className="btn btn--primary"
              disabled={!secretsReady}
              onClick={() =>
                onResolvePermission?.(true, false, '', secretValues, secretRemember)
              }
            >
              {t('chat.perm.allow')}
            </button>
            {permission.name === 'run_command' && !permission.danger && (
              <button
                className="btn"
                disabled={!secretsReady}
                onClick={() => onResolvePermission?.(true, true, '', secretValues, secretRemember)}
              >
                {t('chat.perm.allowAlways')}
              </button>
            )}
            <button className="btn" onClick={() => onResolvePermission?.(false, false)}>
              {t('chat.perm.deny')}
            </button>
          </div>
        </div>
      )}

      {question && (
        <div className="perm perm--ask">
          <div className="perm__title">{t('chat.question.title')}</div>
          <div className="perm__reason">{question.question}</div>
          {question.options.length > 0 && (
            <div className="perm__options">
              {question.options.map((option) => (
                <button key={option} className="btn" onClick={() => onResolveQuestion?.(option)}>
                  {option}
                </button>
              ))}
            </div>
          )}
          <form
            className="perm__free"
            onSubmit={(event) => {
              event.preventDefault();
              const value = answerDraft.trim();
              if (!value) return;
              onResolveQuestion?.(value);
            }}
          >
            <input
              value={answerDraft}
              placeholder={
                question.options.length > 0
                  ? t('chat.question.placeholderOption')
                  : t('chat.question.placeholder')
              }
              onChange={(event) => setAnswerDraft(event.target.value)}
            />
            <button className="btn" type="submit" disabled={!answerDraft.trim()}>
              {t('chat.question.answer')}
            </button>
          </form>
        </div>
      )}

      {compact && todos && todos.length > 0 && (
        <div className={`todos ${todosCollapsed ? 'todos--collapsed' : ''}`}>
          <button
            type="button"
            className="todos__head"
            aria-expanded={!todosCollapsed}
            title={
              todosCollapsed
                ? allTodosDone
                  ? t('chat.todos.expandDone')
                  : t('chat.todos.expand')
                : allTodosDone
                  ? t('chat.todos.collapseDone')
                  : t('chat.todos.collapse')
            }
            onClick={() => setTodosCollapsed((value) => !value)}
          >
            <span className="todos__title">
              <ChevronDownIcon size={12} className="todos__chevron" />
              {allTodosDone ? t('chat.todos.titleDone') : t('chat.todos.title')}
            </span>
            <span className={`todos__count ${allTodosDone ? 'todos__count--done' : ''}`}>
              {completedTodos}/{todos.length}
            </span>
          </button>
          {!todosCollapsed && (
            <ul className="todos__list">
              {todos.map((todo, index) => (
                <li
                  key={`${index}-${todo.content}`}
                  className={`todos__item todos__item--${todo.status}`}
                >
                  <span className="todos__mark">
                    {todo.status === 'completed' ? (
                      <CheckIcon size={11} />
                    ) : todo.status === 'in_progress' ? (
                      <span className="todos__dot" />
                    ) : null}
                  </span>
                  <span className="todos__text">{todo.content}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {compact && planReady && streamingId === null && !permission && !question && (
        <div className="plan-start">
          <span className="plan-start__hint">{t('chat.plan.hint')}</span>
          <button className="btn btn--primary" onClick={() => onStartPlan?.()}>
            {t('chat.plan.start')}
          </button>
        </div>
      )}

      <Composer
        models={models}
        model={model}
        kb={kb}
        promptId={promptId}
        promptVariables={promptVariables}
        streaming={streamingId !== null}
        speed={speed}
        voice={voice}
        context={{ used: contextUsed, limit: contextLimit }}
        compression={
          onCompress
            ? {
                keepTurns: compressionKeepTurns,
                busy: compressing,
                progress: compressionProgress,
                error: compressionError,
                disabledReason: compressionDisabledReason,
                sessionKey: session?.id ?? 'none',
                agentBacked: contextMode === 'task',
                onCompress,
                onCancel: onCancelCompress ?? (() => undefined),
              }
            : undefined
        }
        compact={compact}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        dataAccess={dataAccess}
        onDataAccessChange={onDataAccessChange}
        agents={agents}
        agentId={agentId}
        onAgentChange={onAgentChange}
        onRefreshAgents={onRefreshAgents}
        onModelChange={onModelChange}
        onKbChange={onKbChange}
        onPromptChange={onPromptChange}
        onPromptVariableChange={onPromptVariableChange}
        onSend={onSend}
        onStop={onStop}
        onConfigure={onConfigure}
        onTyping={onTyping}
      />

      {toast && <div className="chat__toast">{toast}</div>}
    </main>
  );
}
