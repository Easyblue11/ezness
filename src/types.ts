export type ViewKey =
  | 'chat'
  | 'workspace'
  | 'assistants'
  | 'knowledge'
  | 'warehouse'
  | 'sensory'
  | 'agent'
  | 'billing'
  | 'settings';

export type SettingsSection =
  | 'system'
  | 'providers'
  | 'defaults'
  | 'kb'
  | 'warehouse'
  | 'python'
  | 'voice'
  | 'web'
  | 'proxy'
  | 'work'
  | 'about';

/** UI theme, persisted so the app opens the way the user left it. */
export type Theme = 'dark' | 'light';

export type Role = 'user' | 'assistant' | 'system';

/** How much the answer may lean on the knowledge base. */
export type KbChatMode = 'strict' | 'balanced' | 'web';

/**
 * 联网策略:
 *   off    — 不检索网页
 *   auto   — 由模型判断这条消息是否需要最新信息，需要才检索
 *   always — 每次发送前都检索
 */
export type WebMode = 'off' | 'auto' | 'always';

export interface KbChatSettings {
  enabled: boolean;
  /** null means 全部 (every category). */
  categoryId: string | null;
  mode: KbChatMode;
  /** Live web search policy for this conversation. Independent of the knowledge base. */
  webMode: WebMode;
}

/**
 * What a workspace task may read from the app's own data.
 *
 * Only the categories the user activated are visible to the agent; activation
 * alone does not send anything. Every content read still asks for permission
 * unless the task is on 自动 (ask level 0).
 */
export interface WorkspaceDataAccess {
  kb?: {
    enabled: boolean;
    /** Category ids the user activated for this task. */
    categoryIds: string[];
  };
  /** Warehouse access is activation-only; the agent picks files by name. */
  warehouse?: boolean;
}

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  model: string;
  pinned?: boolean;
  kb?: KbChatSettings;
  /** Template applied to every turn of this session; undefined = none. */
  promptId?: string | null;
  /**
   * Temporary values for the selected template's variables, keyed by variable
   * name. They stay in memory for this conversation and override the defaults
   * saved in the template.
   */
  promptVariables?: Record<string, string>;
}

export interface PromptVariable {
  name: string;
  value: string;
}

/**
 * Everything a template contributes to a request. History entries store this
 * shape, so restoring a version never drags old ids or old history along.
 */
export interface PromptSnapshot {
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  /** false = 系统指令 system, true = 包装消息 wrap */
  wrap: boolean;
  tags: string[];
  body: string;
  bodyEn: string;
  variables: PromptVariable[];
}

export interface PromptVersion {
  id: string;
  at: number;
  snapshot: PromptSnapshot;
}

export interface PromptTemplate extends PromptSnapshot {
  id: string;
  updatedAt: number;
  history: PromptVersion[];
}

/**
 * One numbered source an answer can point at as [联网N] / [资料N]. The label is
 * exactly the marker the model was given, so the UI can turn the marker in the
 * answer into something hoverable and clickable.
 */
export interface CitationLink {
  /** Marker without brackets: 联网1, 资料2 … */
  label: string;
  kind: 'web' | 'kb';
  /** Page title, or the document name for knowledge-base material. */
  title: string;
  /** Web only: the page the citation opens. */
  url?: string;
  /** One line of context, e.g. the host or the section/page. */
  detail?: string;
}

export interface CompressionInfo {
  /** How many original messages this card stands for. */
  count: number;
  /** Estimated tokens of those originals. */
  tokensBefore: number;
  /** Estimated tokens of the summary card itself. */
  tokensAfter: number;
  /** Ids of the messages it hid; undo clears their hiddenBy. */
  messageIds: string[];
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /** What [联网N] / [资料N] in this answer refer to. */
  citations?: CitationLink[];
  /**
   * Original message folded into a summary card. Hidden messages stay in the
   * transcript file (and in search) but are left out of the view and of every
   * request until the compression is undone.
   */
  hiddenBy?: string;
  /** Set on the card that replaces a block of older messages. */
  summary?: CompressionInfo;
  /** Reasoning the model emitted; shown collapsed above the answer. */
  thinking?: string;
  /** Generation was interrupted by the user. */
  stopped?: boolean;
  /** Documents (and web pages) whose excerpts fed this answer. */
  sources?: string[];
  /** Files the user attached to this turn, shown as chips under the bubble. */
  attachments?: WarehouseItem[];
  /** Attachment text injected into the request; kept so follow-ups still see it. */
  attachmentContext?: string;
  /** Tool calls the workspace agent made while producing this answer. */
  steps?: ToolStep[];
  /**
   * 工作总监主动发进对话里的汇报/待确认。它是一条普通消息，所以会随对话存档；
   * itemId 用来和收件箱里的同一条去重，刷新后不会重复。
   */
  director?: DirectorMessageReport;
  createdAt: number;
}

export interface DirectorMessageReport {
  itemId: string;
  kind: DirectorInboxKind;
  /** 署名：缺省是工作总监；'audit' 显示成「审计组」。 */
  speaker?: 'audit';
  title: string;
  status: DirectorInboxItem['status'];
  /** 用户怎么处理的：dismiss/allow/deny/answer/approve/rework/accept/abandon。 */
  resolution?: string;
  actions: DirectorInboxAction[];
  taskId?: string;
  taskTitle?: string;
  read?: boolean;
  files?: DirectorDeliveredFile[];
  needsRead?: boolean;
  /** 必读：箭头和红点一直保留到用户点「知道了」或「先不用」。 */
  mustRead?: boolean;
  /** 卡片里带的交互数据（例如等用户选工作空间的草稿）。 */
  payload?: Record<string, unknown> | null;
}

/** 总监选工作空间时列出的条目：本地文件夹或在线（SSH）空间。 */
/** 分管空间本身：即使任务全删了，总监也要知道路径才能看里面还剩什么。 */
export interface DirectorSpaceRef {
  id: string;
  name: string;
  path: string;
}

export interface DirectorWorkspaceOption {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'remote';
  remote?: { host: string; port: number; username: string; root: string };
}

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  ok: boolean;
  results?: WebSearchItem[];
  error?: string;
  /** Which entries (network sources) produced results this turn. */
  engines?: { id: string; name: string; count: number }[];
  /** Every entry returned a poor match; results are the closest ones. */
  weak?: boolean;
  /** Per-entry notes for entries that were skipped (blocked, unmatched, …). */
  errors?: string[];
}

/** How a result page is turned into titles + links. */
export type WebParser = 'bing' | 'so' | 'baidu' | 'shenma' | 'quark' | 'duckduckgo' | 'html';

/** One configurable search endpoint used when the 联网 switch is on. */
export interface WebEntry {
  id: string;
  name: string;
  /** URL template; `{query}` is replaced with the encoded query. */
  url: string;
  parser: WebParser;
  enabled: boolean;
  /** Built-in sources can be edited but not deleted. */
  builtin?: boolean;
}

export interface WebSettings {
  entries: WebEntry[];
  /** 联网 mode new conversations/tasks start with. */
  defaultMode: WebMode;
}

/* ---------------- proxy ---------------- */

/**
 * How the app reaches the network:
 *   direct — no proxy at all
 *   system — follow the operating system's proxy settings
 *   fixed  — always use the one server configured below
 *   auto   — use the server only for hosts matching the rule list
 */
export type ProxyMode = 'direct' | 'system' | 'fixed' | 'auto';

/** The protocol spoken to the proxy server. */
export type ProxyScheme = 'http' | 'https' | 'socks5' | 'ssh';

export interface ProxyServerSettings {
  scheme: ProxyScheme;
  host: string;
  port: number;
  /**
   * HTTP / HTTPS / SOCKS5 authentication, and the SSH login name for the SSH
   * scheme. Empty means the proxy needs no authentication.
   */
  username: string;
  password: string;
  /** SSH only: authenticate with a password or a private key. */
  sshAuth: 'password' | 'key';
  privateKeyPath: string;
  privateKeyPassphrase: string;
  /** Optional pinned host key (SHA256:...); when set, a mismatch aborts. */
  fingerprint: string;
}

export interface ProxyRule {
  id: string;
  /** Host or host wildcard, e.g. `*.openai.com`. Order matters: first match wins. */
  pattern: string;
  action: 'proxy' | 'direct';
}

export interface ProxySettings {
  /** Master switch; false means every request goes direct even if a mode is configured. */
  enabled: boolean;
  mode: ProxyMode;
  server: ProxyServerSettings;
  /** Hosts that never use the proxy, one per line. */
  bypass: string;
  /** 自动切换 rules; evaluated in order before `autoDefault`. */
  rules: ProxyRule[];
  autoDefault: 'proxy' | 'direct';
}

/** Live state of the main-process proxy manager, shown in the settings page. */
export interface ProxyStatus {
  ok: boolean;
  applied: boolean;
  enabled: boolean;
  mode: ProxyMode;
  detail: string;
  error?: string;
  /** Local SOCKS5 port when the SSH tunnel is up. */
  tunnelPort?: number;
}

/** Result of the connectivity check behind the 测试 button. */
export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
  error?: string;
}

/** Work-related limits shared by every workspace task. */
/**
 * How often the agent interrupts to ask for permission.
 *   0 自动    — approve everything the policy would otherwise ask about
 *   1 严重    — only destructive or out-of-workspace operations ask
 *   2 关键    — unknown commands and custom tools ask too
 *   3 常规    — routine file writes ask as well (the original behaviour)
 */
export type AskLevel = 0 | 1 | 2 | 3;

export interface WorkSettings {
  /** Tool-calling steps a single task may take; -1 means no limit. */
  maxSteps: number;
  /** Delete the workspace's `.ezness` scratch folder after a task finishes. */
  autoDeleteTemp: boolean;
  /** Install a custom tool's pip/npm dependencies automatically. */
  autoInstallDeps: boolean;
  /** Default permission-question level; a task can override it. */
  askLevel: AskLevel;
  /**
   * How many tokens one conversation may carry before the ring in the composer
   * reads 100%. It is a yardstick for the user, not an enforced cut-off.
   */
  contextLimit: number;
  /** Rounds kept verbatim (from the end) when older history is compressed. */
  compressionKeepTurns: number;
}

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  /** Provider the model came from, used to group the model picker. */
  providerId: string;
  providerName: string;
}

/** Wire format used when listing models. */
export type ApiType = 'openai' | 'anthropic' | 'ollama';

export interface ProviderPreset {
  id: string;
  name: string;
  initials: string;
  apiType: ApiType;
  baseUrl: string;
  description: string;
  /** Ollama runs locally and accepts an empty key. */
  keyOptional?: boolean;
  /** Custom entry: name and API type are editable. */
  editable?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export type DefaultsKey = 'chat' | 'embedding' | 'translation';

/** Values look like "providerId::modelId". */
export type Defaults = Record<DefaultsKey, string>;

export interface VoiceSettings {
  /** Empty string means the system default input device. */
  inputDeviceId: string;
}

/** Local PaddleOCR PP-OCRv5. Models ship with the app; these are use options. */
export interface OcrSettings {
  /** OCR chat image attachments before sending them to the model. */
  enabled: boolean;
  /** Fall back to OCR when a PDF has no usable text layer. */
  pdf: boolean;
  /** How many scanned pages to recognise at most; -1 means no limit. */
  maxPages: number;
}

export interface OcrModelFile {
  key: string;
  label: string;
  file: string;
  path: string;
  size: number;
  expected: number;
  ready: boolean;
}

export interface OcrModelStatus {
  name: string;
  dir: string;
  ready: boolean;
  files: OcrModelFile[];
}

export interface OcrReadOptions {
  enabled?: boolean;
  pdf?: boolean;
  /** -1 (or omitted) = no page limit. */
  maxPages?: number;
}

export interface StoredSettings {
  providers: Record<string, ProviderConfig>;
  defaults: Defaults;
  voice?: VoiceSettings;
  ocr?: OcrSettings;
  web?: WebSettings;
  proxy?: ProxySettings;
  work?: WorkSettings;
  theme?: Theme;
  /** 累计花费每增加 0.1 元时，播放侧边栏的金币动画。默认开启。 */
  rmbAnimation?: boolean;
  /** 界面语言代码（BCP 47，例如 zh-CN、en-US）。默认 zh-CN。 */
  language?: string;
}

/* ---------------- voice input ---------------- */

export interface VoiceFileStatus {
  key: string;
  label: string;
  path: string;
  size: number;
  expected: number;
  ready: boolean;
}

export interface VoiceModelStatus {
  dir: string;
  ready: boolean;
  files: VoiceFileStatus[];
}

export interface VoiceDownloadResult {
  ok: boolean;
  status?: VoiceModelStatus;
  error?: string;
}

export interface VoiceEvent {
  type:
    | 'loading'
    | 'started'
    | 'speech-start'
    | 'speech-end'
    | 'final'
    | 'stopped'
    | 'error'
    | 'download';
  message?: string;
  error?: string;
  text?: string;
  seconds?: number;
  file?: string;
  label?: string;
  received?: number;
  total?: number;
  done?: boolean;
}

export interface FetchModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

/* ---------------- chat ---------------- */

export interface ChatTurn {
  role: Role;
  content: string;
}

export interface ChatTarget {
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Conversation id, used by providers that route on a session header
   * (OpenCode Go wants a stable `x-opencode-session` per conversation).
   * Optional so callers that have no conversation still work.
   */
  sessionId?: string;
  /** Stable provider id/name, kept for the usage ledger. */
  providerId?: string;
  providerName?: string;
}

export interface ChatRequest {
  requestId: string;
  provider: ChatTarget;
  messages: ChatTurn[];
  /** Which feature spends this request; defaults to 对话. */
  feature?: UsageFeature;
}

/**
 * One cheap model call that decides whether a message needs a live web search.
 * `recent` holds the turns before the current one so pronouns such as「那它呢」
 * can be rewritten into a query that stands on its own.
 */
export interface WebJudgeRequest {
  requestId: string;
  provider: ChatTarget;
  text: string;
  recent?: { role: 'user' | 'assistant'; content: string }[];
}

export interface WebJudgeResult {
  search: boolean;
  /** Query to send to the search engines; falls back to the raw text. */
  query: string;
  /** 'rule' when an obvious greeting/acknowledgement skipped the model call. */
  source?: 'model' | 'rule';
  /** The model call failed and the safe fallback (search) was used. */
  fallback?: boolean;
  aborted?: boolean;
  error?: string;
}

export interface ChatStreamEvent {
  requestId: string;
  type: 'delta' | 'thinking' | 'done' | 'error' | 'aborted';
  text?: string;
  error?: string;
}

/* ---------------- usage / billing ---------------- */

export type UsageFeature =
  | 'chat'
  | 'compression'
  | 'prompt'
  | 'workspace'
  | 'review'
  | 'sensory'
  | 'agent-review'
  | 'workspace-viz'
  | 'other';

/** One model request. Tokens are provider-reported where possible. */
export interface UsageRecord {
  id: string;
  at: number;
  feature: UsageFeature;
  providerId: string;
  providerName: string;
  model: string;
  /** CNY, snapshotted from USD at record time. Null when the model has no price. */
  cost: number | null;
  currency: 'CNY';
  /** USD→CNY rate used for this record. */
  fxRate: number;
  priced: boolean;
  priceSource: 'catalog' | 'builtin' | 'none';
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** True when the provider reported exact usage; false = char-based estimate. */
  reported: boolean;
  /** Wall-clock time of the request. Absent on records written before timing. */
  durationMs?: number;
  /** Time from request start to the first streamed token. */
  firstTokenMs?: number;
  /** Time between the first and last streamed token. */
  generationMs?: number;
  /** Output tokens per second over the generation window. */
  tokensPerSecond?: number;
  /** Fastest one-second window during the stream. */
  peakTokensPerSecond?: number;
  sessionId?: string;
  workspaceName?: string;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
  requests: number;
  unpricedRequests: number;
}

export interface UsageSnapshot {
  records: UsageRecord[];
  today: UsageSummary;
  /** Current USD→CNY rate, shown on the billing page. */
  fxRate: number;
}

export type UsageEvent =
  | { type: 'record'; record: UsageRecord; today: UsageSummary }
  | { type: 'reload'; snapshot: UsageSnapshot };


/* ---------------- workspace agent ---------------- */

export type PermissionMode =
  | 'read-only'
  | 'plan'
  | 'workspace-write'
  | 'danger-full-access';

export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary?: string;
  status: 'running' | 'done' | 'error' | 'denied';
  result?: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * What a run is doing right now. Renderer-only and never persisted: it exists
 * so a long silence shows "正在生成写入文件… 12s" instead of nothing.
 */
export type AgentActivity =
  | { kind: 'tool_call'; name: string; chars: number; since: number }
  | { kind: 'waiting'; since: number };

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** Which successful tool call finishes a plan item. */
export interface TodoDoneWhen {
  /** Tool name, e.g. run_command / write_file. */
  tool?: string;
  /** Fragment that appears in that call's arguments. */
  match?: string;
}

export interface TodoItem {
  content: string;
  status: TodoStatus;
  done_when?: TodoDoneWhen;
}

/** A credential the confirmation card asks the user for. Never sent to the model. */
export interface AgentSecretField {
  name: string;
  kind: 'text' | 'file';
  required: boolean;
  description: string;
}

export interface AgentPermission {
  requestId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  reason: string;
  danger: boolean;
  /** 自动 mode: the independent reviewer's reason for flagging this call. */
  reviewReason?: string;
  /** Fields to fill before the call may run; values go to the local executor only. */
  secrets?: AgentSecretField[];
}

export interface AgentQuestion {
  requestId: string;
  callId: string;
  question: string;
  options: string[];
}

/**
 * Main's mirror of a run, used when a page reload (Ctrl+R) has to reconnect to
 * a task that never stopped. Finished runs stay readable for a short while so a
 * reload racing the final events still learns the outcome.
 */
export interface AgentRunSnapshot {
  requestId: string;
  /** Task (chat) this run belongs to. */
  sessionId: string;
  /** The two messages the run fills, so the reloaded page can place them again. */
  messageId: string | null;
  userMessageId: string | null;
  /** The user's visible turn; used only if it was not persisted before the reload. */
  userMessage: string | null;
  workspaceName: string;
  mode: PermissionMode;
  startedAt: number;
  status: 'running' | 'done' | 'aborted' | 'error';
  content: string;
  thinking: string;
  steps: ToolStep[];
  permissions: AgentPermission[];
  questions: AgentQuestion[];
  todos: TodoItem[] | null;
  error: string | null;
  finishedAt: number | null;
}

export interface AgentStreamEvent {
  requestId: string;
  type:
    | 'delta'
    | 'thinking'
    | 'phase'
    | 'tool'
    | 'permission'
    | 'question'
    /** 总监在后台替用户答复了；前端据此收起卡片。 */
    | 'permission-resolved'
    | 'todo'
    | 'compact'
    | 'done'
    | 'error'
    | 'aborted';
  /** permission-resolved: which card is no longer pending. */
  callId?: string;
  text?: string;
  error?: string;
  /** Live progress while the model is still producing a tool call. */
  phase?: 'tool_call';
  name?: string;
  chars?: number;
  /** Estimated tokens streamed into the tool call so far (same cumulative span). */
  tokens?: number;
  call?: { id: string; name: string; args: Record<string, unknown> };
  status?: 'running' | 'done' | 'error' | 'denied';
  summary?: string;
  result?: string;
  reason?: string;
  danger?: boolean;
  /** 自动 mode: the independent reviewer's reason for flagging this call. */
  reviewReason?: string;
  /** Credential fields the card must collect before the call may run. */
  secrets?: AgentSecretField[];
  question?: string;
  options?: string[];
  todos?: TodoItem[];
  /** Estimated tokens in the history before and after a compaction. */
  before?: number;
  after?: number;
  startedAt?: number;
  endedAt?: number;
}

/* ---------------- AI能力：本地工具能力 ---------------- */

export type CapabilityMode = 'read-only' | 'plan' | 'workspace-write' | 'danger-full-access';
export type CapabilityDecision = 'allow' | 'ask' | 'deny';

export interface AgentToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
  values: string[] | null;
}

export interface AgentToolStats {
  calls: number;
  errors: number;
  denied: number;
  interrupted: number;
}

export interface AgentToolImplementation {
  file: string;
  fn: string;
  process: string;
  limits: string[];
}

export interface AgentToolCapability {
  name: string;
  description: string;
  category: string;
  custom: boolean;
  readOnly: boolean;
  network: boolean;
  interactive: boolean;
  parameters: AgentToolParameter[];
  policy: Record<CapabilityMode, CapabilityDecision>;
  policyNote: string;
  /** Only for custom tools: the command the runner spawns (executable mode). */
  command: string;
  /** Only for custom tools: node / python / executable. */
  runtime: string;
  cwd: string;
  timeoutMs: number;
  /** Only for built-in tools: where and how the implementation runs. */
  implementation: AgentToolImplementation | null;
  stats: AgentToolStats;
}

export type CustomToolParamType = 'string' | 'number' | 'boolean';
export type CustomToolRuntime = 'node' | 'python' | 'executable';

export interface AgentRuntimeInfo {
  id: CustomToolRuntime;
  label: string;
  available: boolean;
  version: string;
  detail: string;
  hint: string;
  /** Where the interpreter came from: bundled, a portable folder, or this machine. */
  source: 'builtin' | 'portable' | 'system' | '';
}

export interface PythonEnvStatus {
  dir: string;
  runtimesDir: string;
  installed: boolean;
  exe: string;
  version: string;
  targetVersion: string;
  pip: boolean;
  pipVersion: string;
  indexUrl: string;
  defaultIndex: string;
  configFile: string;
}

export interface PythonModule {
  name: string;
  version: string;
}

export interface CustomToolParameter {
  name: string;
  type: CustomToolParamType;
  required: boolean;
  description: string;
  /**
   * Filled in the confirmation card by the user instead of by the model; the
   * name is left out of the schema the model sees. `file` opens a picker, so
   * the value is a local path rather than the secret itself.
   */
  secret?: boolean;
  secretKind?: 'text' | 'file';
  /**
   * Value used when the caller leaves the argument out. Declared rather than
   * described in prose so the model can omit it instead of guessing `0`.
   */
  default?: string | number | boolean;
}

export interface CustomToolDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  runtime: CustomToolRuntime;
  /** Inline program for node/python. */
  script: string;
  /** Command template for runtime === 'executable'. */
  command: string;
  cwd: string;
  timeoutMs: number;
  readOnly: boolean;
  network: boolean;
  /** Per-mode decisions for mutating custom tools. Missing means "use defaults". */
  policy?: Record<CapabilityMode, CapabilityDecision>;
  /** Third-party packages installed automatically for this tool. */
  dependencies: string[];
  parameters: CustomToolParameter[];
}

/** A user-created group in the AI能力 sidebar. */
export interface ToolCategory {
  id: string;
  name: string;
  pinned: boolean;
}

export interface CategoryResult {
  ok: boolean;
  error?: string;
  categories?: ToolCategory[];
  definitions?: CustomToolDefinition[];
}

export interface ToolHealthError {
  phase: 'schema' | 'syntax' | 'test' | 'runtime';
  message: string;
  detail?: string;
}

/** Result of the syntax check and smoke test for one custom tool. */
export interface ToolHealth {
  status: 'ok' | 'broken' | 'untested';
  errors: ToolHealthError[];
  testedAt?: number;
  testArgs?: Record<string, unknown>;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export type ToolHealthMap = Record<string, ToolHealth>;

export interface ToolRetestResult {
  ok: boolean;
  error?: string;
  passed?: boolean;
  health?: ToolHealth;
  /** Packages the test installed automatically. */
  installed?: string[];
  definitions?: CustomToolDefinition[];
}

export interface CustomToolResult {
  ok: boolean;
  error?: string;
  definitions?: CustomToolDefinition[];
}

export interface AgentCapabilities {
  tools: AgentToolCapability[];
  categories: string[];
  modes: CapabilityMode[];
  totals: {
    tools: number;
    calls: number;
    errors: number;
    denied: number;
    interrupted: number;
    sessions: number;
  };
}

/* ---------------- agents ---------------- */

/**
 * `all` hands every capability category to the agent; `selected` uses the two
 * lists below. Built-ins are referenced by category name, custom tools by the
 * id of their user-created category (renaming the category keeps the binding).
 */
export type AgentCapabilityScope = 'all' | 'selected';

export interface AgentCapabilityBinding {
  mode: AgentCapabilityScope;
  builtin: string[];
  custom: string[];
}

/* ---------------- agent long-term memory ---------------- */

export interface AgentMemorySettings {
  /** Auto-extract memories after each finished task. */
  enabled: boolean;
  /** Confirm high-confidence, multi-source facts without review. */
  autoConfirm: boolean;
  /** Allow background web rechecks for due entries. */
  allowWebRecheck: boolean;
}

/**
 * Which slice of the shared, user-maintained knowledge base this Agent may
 * read. Categories may be groups; documents can be picked one by one, and a
 * document can also be taken out of an otherwise selected category.
 */
export interface AgentKnowledgeSelection {
  categoryIds: string[];
  documentIds: string[];
  excludeDocumentIds: string[];
}

export type AgentMemoryType = 'fact' | 'insight' | 'preference' | 'procedure' | 'note';
export type AgentMemoryStatus =
  | 'candidate'
  | 'confirmed'
  | 'rejected'
  | 'archived'
  | 'disputed';
export type AgentMemoryOrigin = 'learned' | 'manual' | 'imported';
export type AgentMemoryVolatility = 'static' | 'slow' | 'medium' | 'fast' | 'realtime';
export type AgentMemoryFreshness =
  | 'fresh'
  | 'due'
  | 'stale'
  | 'expired'
  | 'disputed'
  | 'archived';

export interface AgentMemoryFreshnessInfo {
  state: AgentMemoryFreshness;
  label: string;
  warning: string;
  daysSinceVerified?: number | null;
  daysUntilRecheck?: number | null;
  daysUntilExpiry?: number | null;
}

export interface AgentMemorySource {
  kind: 'web' | 'conversation' | 'manual';
  url?: string;
  title?: string;
  sessionId?: string;
  messageId?: string;
  at?: number;
}

export interface AgentMemoryTemporal {
  observedAt: number;
  publishedAt: number | null;
  validFrom: number;
  validUntil: number;
  volatility: AgentMemoryVolatility;
  ttlDays: number;
  recheckDays: number;
  ttlReason: string;
  lastVerifiedAt: number;
  nextCheckAt: number;
  checkCount: number;
  dateConfidence: 'high' | 'medium' | 'low';
  unverified: boolean;
}

export interface AgentMemoryHistoryItem {
  revision: number;
  title: string;
  content: string;
  tags: string[];
  sources: AgentMemorySource[];
  replacedAt: number;
  reason: string;
  verifiedBy: string;
}

export interface AgentMemoryProposal {
  title: string;
  content: string;
  tags: string[];
  sources: AgentMemorySource[];
  evidence: string[];
  confidence: number;
  temporal: AgentMemoryTemporal;
  reason: string;
  verdict: string;
  createdAt: number;
}

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  type: AgentMemoryType;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  status: AgentMemoryStatus;
  origin: AgentMemoryOrigin;
  locked: boolean;
  sources: AgentMemorySource[];
  evidence: string[];
  temporal: AgentMemoryTemporal;
  revision: number;
  history: AgentMemoryHistoryItem[];
  proposal: AgentMemoryProposal | null;
  supersedes: string[];
  conflictsWith: string[];
  hash: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
  /** Computed at read time by the main process. */
  freshness?: AgentMemoryFreshnessInfo;
}

export interface AgentMemoryStats {
  total: number;
  confirmed: number;
  candidate: number;
  rejected: number;
  disputed: number;
  /** Confirmed entries that are due, stale, or expired. */
  due: number;
}

export interface AgentMemoryEvent {
  at: number;
  agentId: string;
  type: string;
  title?: string;
  added?: number;
  updated?: number;
  decision?: string;
  kind?: string;
  reason?: string;
}

export interface AgentMemorySnapshot {
  ok: boolean;
  error?: string;
  agentId?: string;
  settings?: AgentMemorySettings;
  entries?: AgentMemoryEntry[];
  stats?: AgentMemoryStats;
  now?: number;
  events?: AgentMemoryEvent[];
  volatility?: Record<
    AgentMemoryVolatility,
    { ttlDays: number; recheckDays: number; label: string }
  >;
}

export interface AgentMemoryResult {
  ok: boolean;
  error?: string;
  entry?: AgentMemoryEntry;
  entries?: AgentMemoryEntry[];
  agents?: AgentDefinition[];
  memory?: AgentMemorySettings;
  kind?: string;
  reason?: string;
  applied?: boolean;
  proposal?: boolean;
}

export interface AgentMemoryInput {
  id?: string;
  type?: AgentMemoryType;
  title?: string;
  content?: string;
  tags?: string[];
  confidence?: number;
  status?: AgentMemoryStatus;
  locked?: boolean;
  sources?: AgentMemorySource[];
  evidence?: string[];
  temporal?: Partial<AgentMemoryTemporal>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  personality: string;
  inputSpec: string;
  outputSpec: string;
  /** The agent's own system prompt. */
  prompt: string;
  capabilities: AgentCapabilityBinding;
  /** The shared knowledge base slice this Agent may read. */
  knowledge: AgentKnowledgeSelection;
  /** Long-term learning switches; older saved files get the defaults. */
  memory: AgentMemorySettings;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSaveResult {
  ok: boolean;
  error?: string;
  agent?: AgentDefinition;
  agents?: AgentDefinition[];
}

/* ---------------- agent review ---------------- */

export type AgentReviewChangeKind =
  | 'capability-add'
  | 'capability-remove'
  | 'knowledge-add'
  | 'knowledge-remove'
  | 'definition';

/** One actionable suggestion. Applying it patches the Agent and saves as usual. */
export interface AgentReviewChange {
  /** Stable within one review run; used as the selection key. */
  id: string;
  kind: AgentReviewChangeKind;
  /** Capability list (`builtin` / `custom`) or definition text field. */
  field?: 'builtin' | 'custom' | 'role' | 'personality' | 'inputSpec' | 'outputSpec' | 'prompt';
  /** Knowledge changes only. */
  target?: 'category' | 'document';
  /** Builtin category name, custom category id, or knowledge category/document id. */
  ref: string;
  /** Human-readable name of the category or document. */
  categoryLabel: string;
  label: string;
  detail: string;
  /** Definition changes only: the complete replacement text. */
  value?: string;
}

export interface AgentReviewResult {
  agentId: string;
  name: string;
  verdict: 'ok' | 'adjust' | 'error';
  summary: string;
  error?: string;
  changes: AgentReviewChange[];
}

export interface AgentReviewCatalog {
  builtin: { name: string; tools: { name: string; description: string }[] }[];
  custom: { id: string; name: string; tools: { name: string; description: string }[] }[];
  knowledge: {
    categories: { id: string; name: string; kind: KbCategoryKind; documentCount: number }[];
    documents: { id: string; name: string; categoryId: string; categoryName: string }[];
  };
}

export interface AgentReviewResponse {
  ok: boolean;
  error?: string;
  results?: AgentReviewResult[];
}

export interface AgentDeleteResult {
  ok: boolean;
  error?: string;
  agents?: AgentDefinition[];
}

/* ---------------- 能力分类包 / Agent 包 ---------------- */

/** 导入时撞名会被改名、个别条目会被跳过，这些都通过 warnings 说清楚。 */
export interface PackageIoResult {
  ok: boolean;
  error?: string;
  canceled?: boolean;
  path?: string;
  warnings?: string[];
}

export interface CategoryPackageExportResult extends PackageIoResult {
  tools?: number;
}

export interface CategoryPackageImportResult extends CategoryResult {
  canceled?: boolean;
  category?: ToolCategory;
  health?: ToolHealthMap;
  imported?: number;
  warnings?: string[];
}

export interface AgentPackageExportResult extends PackageIoResult {
  categories?: number;
  memory?: number;
}

export interface AgentPackageImportResult extends AgentSaveResult {
  canceled?: boolean;
  /** 导入后的完整分类表，直接替换本地状态。 */
  categories?: ToolCategory[];
  /** 这次实际新增了几个分类（切进 Agent 详情前给用户一个交代）。 */
  importedCategories?: number;
  definitions?: CustomToolDefinition[];
  health?: ToolHealthMap;
  memory?: number;
  warnings?: string[];
}

/* ---------------- 工作总监 ---------------- */

/**
 * observe 主动提醒岔路口；suggest 对每个选项给出意见；run 自己拍板并留痕。
 * 三档都不决定"谁持有任务"——总监默认持有全部，用户走进去才归用户。
 */
export type DirectorMode = 'observe' | 'suggest' | 'run';

/**
 * 每个工作空间对总监的开放程度；未设置的按 off 处理（不监视）。
 * read = 可巡视、可透视；write = 还可以给这个空间的工人下指令。
 */
export type DirectorSpaceAccess = 'off' | 'read' | 'write';

/** 用户此刻正站在哪个任务里。过期后任务自动回到总监。 */
export interface DirectorPresence {
  sessionId: string;
  workspaceId: string;
  at: number;
}

export interface DirectorState {
  schema: number;
  enabled: boolean;
  mode: DirectorMode;
  /** 预留：预算闸门还没启用，界面也不暴露。 */
  budgetTokens: number;
  /** 最多同时执行多少个总监下发的任务。 */
  maxDispatch: number;
  /** 验收不通过时最多自动返工几轮；到上限就交回用户决定。 */
  reworkRounds: number;
  /** 总监自己用的模型（providerId::model）；空 = 跟随全局默认对话模型。 */
  chatModel: string;
  spaces: Record<string, DirectorSpaceAccess>;
  presence: DirectorPresence | null;
  updatedAt: number;
}

export interface DirectorPatch {
  enabled?: boolean;
  mode?: DirectorMode;
  budgetTokens?: number;
  maxDispatch?: number;
  reworkRounds?: number;
  chatModel?: string;
  spaces?: Record<string, DirectorSpaceAccess>;
}

/** 总监派工：一个员工的建单参数。 */
export interface DirectorEmployee {
  employeeId: string;
  /** 员工标识，例如「员工1」。 */
  name: string;
  task: string;
  criteria: string;
  agentId: string;
  web: WebMode;
  useWarehouse: boolean;
  kbCategoryIds: string[];
  model: string;
}

export interface DirectorSpawnPayload {
  dispatchId: string;
  title: string;
  workspaceId: string;
  shared: string;
  employees: DirectorEmployee[];
  at: number;
}

/** 总监页顶部：当前正在执行的每个任务的花费。 */
export interface DirectorActiveUsage {
  taskId: string;
  title: string;
  cost: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface DirectorSpawnResult {
  employeeId: string;
  ok: boolean;
  error?: string;
  taskId?: string;
  title?: string;
  space?: string;
  workspaceId?: string;
  workspacePath?: string;
}

export interface DirectorPresenceInput {
  /** null / 空字符串表示用户离开了所有任务。 */
  sessionId: string | null;
  workspaceId?: string;
}

export interface DirectorSaveResult {
  ok: boolean;
  error?: string;
  state?: DirectorState;
}

/* ---------------- 工作总监 · 服务 ---------------- */

export type DirectorInboxKind =
  | 'report'
  | 'alert'
  | 'confirm'
  | 'question'
  | 'advice'
  | 'audit';

export interface DirectorInboxAction {
  id: string;
  label: string;
  style?: 'plain' | 'primary' | 'danger';
}

/** 总监主动发来的一条消息；confirm 是需要用户拍板的那种。 */
/** 总监发给用户的文件：只存工作空间里的路径，不复制文件。 */
export interface DirectorDeliveredFile {
  workspaceId: string;
  /** 相对工作空间根目录的路径；根目录本身用 "."。 */
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  /** 发的是整个项目/工作空间根目录。 */
  project?: boolean;
}

export interface DirectorInboxItem {
  id: string;
  kind: DirectorInboxKind;
  /** 署名：缺省是工作总监；'audit' 是审计组直接发给用户的结论/建议。 */
  speaker?: 'audit';
  title: string;
  body: string;
  taskId: string;
  taskTitle: string;
  /** 紧急消息：卡住、没通过、需要马上看。 */
  urgent?: boolean;
  at: number;
  read: boolean;
  status: 'open' | 'resolved' | 'dismissed';
  /** 用户拍板的方式，用于把卡片显示成已确认/已放弃/已了解… */
  resolution: string;
  actions: DirectorInboxAction[];
  payload: Record<string, unknown> | null;
  files?: DirectorDeliveredFile[];
  /** 总监分配的任务交付：等用户读过才消标记。 */
  needsRead?: boolean;
  /** 必读建议：面板开着也不算读过，要用户表态。 */
  mustRead?: boolean;
}

export interface DirectorInboxView {
  items: DirectorInboxItem[];
  unread: number;
  confirms: number;
  /** 其中还没表态的必读条数。 */
  mustRead?: number;
  /** 最近一次派工收口的时间；总监的旧计划早于它就收掉。 */
  planDoneAt?: number;
  at?: number;
}

export interface DirectorInstruction {
  id: string;
  taskId: string;
  taskTitle: string;
  text: string;
  criteria: string;
  source: 'director' | 'user';
  attempts: number;
  state: 'queued' | 'delivered' | 'accepted' | 'rework' | 'escalated' | 'discarded' | 'held';
  createdAt: number;
  deliveredAt: number;
  finishedAt: number;
  failures: number;
  note: string;
}

export interface DirectorLedgerEntry {
  at: number;
  kind: string;
  /** task = 任务侧的状况，director = 总监的处置。 */
  side?: 'task' | 'director';
  label?: string;
  taskId: string;
  title: string;
  text: string;
}

/** 清空总监对话时留档的一条记录。 */
export interface DirectorHistoryEntry {
  id: string;
  at: number;
  /** 这段对话的第一条/最后一条消息时间。 */
  from?: number;
  to?: number;
  title: string;
  /** 名字是模型取的，还是从内容里拼出来的。 */
  titleSource?: 'model' | 'content';
  count: number;
  /** 存档里装的总监事务条数。 */
  transactionCount?: number;
}

export interface DirectorHistoryDetail extends DirectorHistoryEntry {
  messages: Message[];
  /** 这段对话期间总监的事务，和对话一起装在一个存档里。 */
  transactions?: DirectorLedgerEntry[];
  /** 总监原始会话行（含工具调用），用于更细的回看。 */
  session: Array<Record<string, unknown>>;
}

export interface DirectorSnapshot {
  state: DirectorState;
  inbox: DirectorInboxView;
  ledger: { items: DirectorLedgerEntry[] };
  instructions: DirectorInstruction[];
}

/** Renderer → main board entry. The main process does not read chats itself. */
export interface DirectorTaskRef {
  id: string;
  title: string;
  space: string;
  workspaceId: string;
  workspacePath?: string;
  busy?: boolean;
  status?: string;
  askLevel?: number;
  updatedAt?: number;
}

/** 总监对任务本身发起、由界面执行的操作。 */
export interface DirectorTaskAction {
  opId?: string;
  action: 'pin' | 'unpin' | 'rename' | 'export' | 'delete' | 'stop';
  taskIds: string[];
  title?: string;
}

export interface DirectorInspectData {
  task: {
    id: string;
    title: string;
    space: string;
    status: string;
    busy: boolean;
    updatedAt: number;
    access: DirectorSpaceAccess;
  };
  counts: { messages: number; assistant: number; tools: number; files: number };
  conversation: { role: 'user' | 'assistant'; content: string }[];
  tools: { id: string; name: string; args: string; result: string }[];
  files: string[];
  thinking: { content: string }[];
  text?: string;
}

/** 内容审计里的一类重复工作。数字全部来自本地运行记录。 */
export interface DirectorAuditItem {
  key: string;
  title: string;
  runs: number;
  tasks: number;
  totalMs: number;
  totalTokens: number;
  avgMs: number;
  avgTokens: number;
  /** 重复部分才计入浪费：总时长减去第一次。 */
  reclaimMs: number;
  reclaimTokens: number;
  repeat: number;
  lastAt: number;
  evidence: string[];
  /** 是否已达到“值得预制”的标准（总监的是否照旧由模型判断）。 */
  candidate: boolean;
  reason: string;
  adviceAt: number;
  adviceTitle: string;
  adviceBody: string;
  ignored: number;
  muted: boolean;
}

export interface DirectorAuditTotals {
  runs: number;
  patterns: number;
  repeated: number;
  totalMs: number;
  totalTokens: number;
  reclaimMs: number;
  reclaimTokens: number;
  /** 重复投入占全部投入的百分比（按时间）。 */
  share: number;
  advice: number;
  ignored: number;
  muted: number;
}

export interface DirectorAuditTask {
  taskId: string;
  title: string;
  space: string;
  instructions: number;
  accepted: number;
  unverified: number;
  failed: number;
  rework: number;
  held: number;
  runMs: number;
  cost: number;
  tokens: number;
  files: number;
  lastAt: number;
}

export interface DirectorAuditAgent {
  id: string;
  name: string;
  tasks: number;
  instructions: number;
  accepted: number;
  unverified: number;
  failed: number;
  rework: number;
  runMs: number;
  files: number;
  lastAt: number;
}

export interface DirectorAuditTool {
  name: string;
  calls: number;
  runs: number;
  tasks: number;
}

export interface DirectorAuditProject {
  id: string;
  title: string;
  status: string;
  employees: number;
  accepted: number;
  failed: number;
  unverified: number;
  held: number;
  estimateMs: number;
  elapsedMs: number;
  overMs: number;
  startedAt: number;
}

export interface DirectorAuditReport {
  title: string;
  at: number;
  windowDays: number;
  /** 正式报告正文（Markdown）。 */
  markdown: string;
}

export interface DirectorAudit {
  ok: boolean;
  error?: string;
  at?: number;
  windowDays?: number;
  items?: DirectorAuditItem[];
  /** 已达到预制标准、还没发过建议的类数。 */
  pending?: number;
  totals?: DirectorAuditTotals;
  summary?: string;
  /** 按任务、员工、能力、项目统计出的逐项结论。 */
  detail?: string;
  tasks?: DirectorAuditTask[];
  agents?: DirectorAuditAgent[];
  tools?: DirectorAuditTool[];
  projects?: DirectorAuditProject[];
  /** 审计的正式交付物。 */
  report?: DirectorAuditReport;
}

export interface DirectorResolveResult {
  ok: boolean;
  error?: string;
  openTask?: string;
  /** choose-model：总监已把原指令重新排上队。 */
  retried?: boolean;
  /** choose-model：用户自己跑的那轮没有指令可重排，把原话交回来重发。 */
  retryText?: string;
}

/* ---------------- knowledge base ---------------- */

export type KbStatus = 'pending' | 'parsing' | 'embedding' | 'ready' | 'error';

/** 审核状态：只有 confirmed 的资料会被正式使用。 */
export type KbReviewState = 'confirmed' | 'candidate' | 'rejected';

/** 文件分类 holds documents; 组合分类 only collects other 文件分类. */
export type KbCategoryKind = 'files' | 'group';

export interface KbCategory {
  id: string;
  name: string;
  kind: KbCategoryKind;
  /** Member category ids for 组合分类; empty for 文件分类. */
  includes: string[];
  createdAt: number;
}

export interface KbDocument {
  id: string;
  categoryId: string;
  name: string;
  ext: string;
  size: number;
  sha256: string;
  storedPath: string;
  status: KbStatus;
  /** Confirmed knowledge is usable; candidates wait for review. */
  reviewState: KbReviewState;
  /** Where the file came from (user upload, later: the URL an agent read). */
  source: string | null;
  chunkCount: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KbConfig {
  storageRoot: string;
  embedding: { baseUrl: string; model: string; apiKey: string };
  chunk: { target: number; overlap: number };
  retrieval: { topK: number; candidates: number; rerank: 'fast' | 'llm' };
  rerank: { baseUrl: string; model: string };
}

/** Deep partial — the main process merges each section over its defaults. */
export interface KbConfigPatch {
  embedding?: Partial<KbConfig['embedding']>;
  chunk?: Partial<KbConfig['chunk']>;
  retrieval?: Partial<KbConfig['retrieval']>;
  rerank?: Partial<KbConfig['rerank']>;
}

export interface KbSnapshot {
  categories: KbCategory[];
  documents: KbDocument[];
  stats: { documents: number; chunks: number; ready: number };
  config?: KbConfig;
}

export interface KbSearchHit {
  rank: number;
  chunkId: string;
  docId: string;
  docName: string;
  section: string | null;
  page: number | null;
  text: string;
  score: number;
  coverage?: number;
  rerankedBy?: string;
}

export interface KbSearchResponse {
  results: KbSearchHit[];
  note: string | null;
  took?: number;
  mode?: string;
}

/**
 * Conversation warehouse: images and files attached in chat, kept as plain
 * files. It has its own directory and is never parsed, chunked or embedded —
 * that pipeline belongs to the knowledge base only.
 */
export interface WarehouseItem {
  id: string;
  name: string;
  size: number;
  /** Lower-case extension without the dot; '' when the file has none. */
  ext: string;
  kind: 'image' | 'file';
  addedAt: number;
  /** Where it came from: chat attachment or manual import. */
  origin: 'chat' | 'import';
}

export interface WarehouseSnapshot {
  root: string;
  items: WarehouseItem[];
  count: number;
  totalBytes: number;
}

/** A conversation whose message references a warehouse file. */
export interface WarehouseUsage {
  /** 对话 page or a 工作空间 conversation. */
  kind: 'chat' | 'workspace';
  /** Chat id for both kinds; used to find the session when jumping. */
  sessionId: string;
  sessionTitle: string;
  /** Set for workspace conversations: which workspace owns the chat. */
  workspaceId?: string;
  workspaceName?: string;
  /** The message that carries the attachment; jumping scrolls to it. */
  messageId: string;
  /** Time of that message. */
  at: number;
  /** How many turns in this conversation reference the file. */
  count: number;
}

/* ---------------- workspaces (reported to the main process for usage) ---------------- */

export interface WorkspaceRef {
  id: string;
  name: string;
}

export interface WorkspaceChatRef {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
}

/** Snapshot the workspace page hands up so warehouse jumps can find its chats. */
export interface WorkspaceLibrary {
  workspaces: WorkspaceRef[];
  chats: WorkspaceChatRef[];
  messages: Message[];
}

/* ---------------- workspace visualization ---------------- */

/**
 * One chart the model proposed. The renderer owns the palette, layout and
 * interaction; the model only supplies the type and the numbers, so a bad
 * answer can never inject markup or colors.
 */
export type VizChartType =
  | 'line'
  | 'smooth-line'
  | 'scatter'
  | 'pie'
  | 'bar'
  | 'horizontal-bar'
  | 'grouped-bar'
  | 'progress'
  | 'table';

/** Dashboard footprint: md takes half a row, lg takes the full row. */
export type VizChartSize = 'sm' | 'md' | 'lg';

export interface VizDatum {
  label: string;
  value: number;
}

export interface VizXYDatum {
  x: number;
  y: number;
  label?: string;
}

export interface VizSeries {
  name: string;
  /** label/value for line & smooth-line, x/y for scatter. */
  points: Array<VizDatum | VizXYDatum>;
}

export interface VizChart {
  type: VizChartType;
  title: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  /** Optional unit shown next to values, e.g. 条 / 元 / %. */
  unit?: string;
  /** Layout hint for the dashboard grid. */
  size?: VizChartSize;
  /** Where the numbers came from: a table title, a message, or a file. */
  source?: string;
  /** line / smooth-line / scatter / grouped-bar. */
  series?: VizSeries[];
  /** bar / horizontal-bar / pie / progress. */
  items?: VizDatum[];
  /** table: the source table itself, rendered as a real table card. */
  columns?: string[];
  rows?: string[][];
  /**
   * Set when the chart was built from a sampled table: the file behind it can
   * be re-read in full, and the card offers that.
   */
  table?: { refs: VizTableRef[]; shown: number; total: number };
}

/** One headline number in the dashboard's KPI row. */
export interface VizStat {
  label: string;
  value: string;
  note?: string;
}

/** What the visualization model gets to see. Built in the renderer, capped again in main. */
export interface WorkspaceVizTask {
  title: string;
  updatedAt: number;
  messages: number;
  todosDone: number;
  todosTotal: number;
  agent?: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface WorkspaceVizMessage {
  task: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/**
 * A table pulled out of the transcript or a local file. Columns and rows are
 * plain strings; parsing them here (not in the model) keeps cell values exact.
 */
/** Where a table came from, so the full rows can be read again on demand. */
export interface VizTableRef {
  /** Workspace-relative path, e.g. `data/sales.csv`. */
  rel: string;
  kind?: 'csv' | 'xlsx' | 'sqlite' | 'json' | 'md';
  /** Excel sheet name. */
  sheet?: string;
  /** SQLite table name. */
  table?: string;
}

export interface WorkspaceVizTable {
  id: string;
  title: string;
  /** e.g. 「对话」「文件：data.csv」 */
  source: string;
  columns: string[];
  rows: string[][];
  refs?: VizTableRef[];
  /** Rows in the source file, before sampling. */
  total?: number;
}

export interface WorkspaceVizContext {
  workspace: { name: string; path: string; kind: string };
  generatedAt: number;
  totals: {
    tasks: number;
    messages: number;
    todosDone: number;
    todosTotal: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
  tasks: WorkspaceVizTask[];
  messages: WorkspaceVizMessage[];
  /** task = only the open task is in scope; workspace = everything. */
  focus?: { scope: 'task' | 'workspace'; task?: string };
  tables?: WorkspaceVizTable[];
}

export interface WorkspaceVisualizeRequest {
  provider: ChatTarget;
  /** Empty means "summarize the whole workspace". */
  topic: string;
  context: WorkspaceVizContext;
  /** Lets the dialog stop this exact run when it closes mid-stream. */
  requestId?: string;
}

export interface WorkspaceVisualizeResult {
  ok: boolean;
  error?: string;
  /** The run was stopped on purpose; not an error worth showing. */
  aborted?: boolean;
  title?: string;
  summary?: string;
  highlights?: string[];
  /** Headline numbers shown as KPI tiles above the charts. */
  stats?: VizStat[];
  charts?: VizChart[];
}

/* ---------------- workspace file tree ---------------- */

export interface WorkspaceTreeEntry {
  name: string;
  /** POSIX path relative to the workspace root. */
  path: string;
  isDir: boolean;
}

export interface WorkspaceTreeResult {
  ok: boolean;
  error?: string;
  /** Node error code (e.g. ENOENT when the folder vanished while watching). */
  code?: string;
  /** Absolute folder the tree is rooted at. */
  root?: string;
  /** Folder that was listed, relative to the root ('' for the root itself). */
  dir?: string;
  entries?: WorkspaceTreeEntry[];
  /** More entries existed than the main process is willing to list. */
  truncated?: boolean;
}

export interface WorkspaceFileResult {
  ok: boolean;
  error?: string;
  kind?: 'text' | 'image' | 'binary';
  name?: string;
  /** POSIX path relative to the workspace root. */
  path?: string;
  size?: number;
  mtime?: number;
  mime?: string;
  /** Data URL for images. */
  dataUrl?: string;
  content?: string;
  /** Text preview stopped at the size limit. */
  truncated?: boolean;
}

export interface WorkspaceEntryProperties {
  ok: boolean;
  error?: string;
  name?: string;
  /** POSIX path relative to the workspace root. */
  path?: string;
  absolutePath?: string;
  kind?: 'file' | 'folder';
  size?: number;
  mtime?: number;
  ctime?: number;
  birthtime?: number;
}

export interface WarehouseAddResult {
  ok: boolean;
  snapshot: WarehouseSnapshot;
  /** Items created by this call, in input order. */
  added: WarehouseItem[];
  /**
   * Existing items with byte-identical content (SHA-256). They were not stored
   * again; callers can attach them directly instead of adding a copy.
   */
  duplicates?: WarehouseItem[];
  errors?: string[];
}

/** Text pulled out of one warehouse file at send time. */
export interface WarehouseReadResult {
  id: string;
  name: string;
  ext: string;
  size: number;
  kind: 'image' | 'file';
  ok: boolean;
  /** Absolute path of the stored file, so tools can open it directly. */
  path?: string;
  text?: string;
  /** The extractor's output was longer than the transfer cap. */
  truncated?: boolean;
  /** Text came from OCR (image, or a scanned PDF) rather than a text layer. */
  ocr?: boolean;
  /** Fallback details worth showing, e.g. "only the first 30 pages". */
  note?: string;
  error?: string;
}

/**
 * The single app data root. Everything Ezness writes lives under it:
 * ezrag (knowledge base), ezstorge (warehouse), voice-models, and the JSON
 * files at the top level.
 */
export interface StorageLayout {
  settings: string;
  prompts: string;
  kbConfig: string;
  rag: string;
  warehouse: string;
  voiceModels: string;
}

export interface StorageStats {
  kbDocuments: number;
  kbChunks: number;
  warehouseFiles: number;
  warehouseBytes: number;
  voiceReady: boolean;
  ragBytes: number;
  warehouseDirBytes: number;
  voiceBytes: number;
  configBytes: number;
}

export interface StorageInfo {
  root: string;
  layout: StorageLayout;
  stats: StorageStats;
}

export interface StorageMigrateResult {
  ok: boolean;
  info?: StorageInfo;
  error?: string;
}

/* ---------------- language packs ---------------- */

export interface LocalePackInfo {
  /** File name inside <dataRoot>/locales. */
  file: string;
  code: string;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
  keyCount: number;
}

export interface LocalePackError {
  file: string;
  error: string;
}

export interface LocaleListResult {
  dir: string;
  packs: LocalePackInfo[];
  errors: LocalePackError[];
}

export interface LocalePackPayload {
  meta: {
    code: string;
    name: string;
    nativeName: string;
    dir: 'ltr' | 'rtl';
  };
  messages: Record<string, string>;
}

export interface KbEvent {
  type: 'ingest' | 'refresh';
  docId?: string;
  name?: string;
  stage?: KbStatus | 'skipped';
  message?: string;
  progress?: number;
  categories?: KbCategory[];
  documents?: KbDocument[];
  stats?: KbSnapshot['stats'];
}

declare global {
  /** Injected by Vite from package.json (`define` in vite.config.mts). */
  const __APP_VERSION__: string;

  interface Window {
    ezness?: {
      platform: string;
      /** True in an installed build, false for `electron .` during development. */
      isPackaged: boolean;
      /** Runtime versions, shown on the 关于我们 page for diagnostics. */
      versions: { electron: string; chrome: string; node: string };
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      /** Window-level fullscreen; resolves with the state the window ended in. */
      setFullscreen: (value: boolean) => Promise<boolean>;
      onWindowState: (callback: (maximized: boolean) => void) => () => void;
      fetchModels: (payload: {
        baseUrl: string;
        apiKey: string;
        apiType: ApiType;
      }) => Promise<FetchModelsResult>;
      loadSettings: () => Promise<StoredSettings | null>;
      saveSettings: (settings: StoredSettings) => Promise<boolean>;
      /** Apply proxy settings now; resolves with the resulting live status. */
      proxyApply: (settings: ProxySettings) => Promise<ProxyStatus>;
      proxyStatus: () => Promise<ProxyStatus>;
      proxyTest: (url?: string) => Promise<ProxyTestResult>;

      /** 对话 history: saved in <data root>/chats.json. */
      chatsLoad: () => Promise<{
        sessions?: unknown[];
        messages?: unknown[];
        activeId?: string | null;
      } | null>;
      chatsSave: (state: {
        sessions: Session[];
        messages: Message[];
        activeId: string;
      }) => Promise<boolean>;

      chatSend: (request: ChatRequest) => Promise<boolean>;
      chatAbort: (requestId: string) => Promise<boolean>;
      onChatEvent: (callback: (event: ChatStreamEvent) => void) => () => void;

      /** Token/cost ledger kept in <data root>/usage.json. */
      usageLoad: () => Promise<UsageSnapshot>;
      usageClear: () => Promise<UsageSnapshot>;
      /** Writes the CSV through a save dialog in the main process. */
      usageExport: (payload: {
        csv: string;
        filename: string;
      }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      onUsageEvent: (callback: (event: UsageEvent) => void) => () => void;

      agentStart: (request: {
        requestId: string;
        provider: ChatTarget;
        /** Needed for remote workspaces: main resolves the SSH connection. */
        workspaceId?: string;
        workspacePath: string;
        workspaceName?: string;
        /** Conversation store under <data root>/agent/sessions. */
        sessionId?: string;
        /** The new user turn; earlier turns come from the session file. */
        message?: string;
        /** Legacy: full display transcript, used only if `message` is absent. */
        messages?: ChatTurn[];
        mode: PermissionMode;
        /** How often to stop and ask; main falls back to the global setting. */
        askLevel?: AskLevel;
        /** Commands the user already approved in this workspace. */
        allowedCommands?: string[];
        webEnabled?: boolean;
        webEntries?: WebEntry[];
        /** Checklist shown for this task; the run ticks items off as tools finish. */
        todos?: TodoItem[];
        /** Knowledge-base / warehouse access activated for this task. */
        dataAccess?: WorkspaceDataAccess;
        /**
         * `tool-editor` binds the run to one tool category; `agent-editor` to
         * one Agent; `director` is the 工作总监 conversation.
         */
        workspaceKind?: 'folder' | 'tool-editor' | 'agent-editor' | 'director';
        categoryId?: string;
        /** Board the director reasons about; rebuilt by the renderer each turn. */
        directorTasks?: {
          id: string;
          title: string;
          space: string;
          busy?: boolean;
          status?: string;
          askLevel?: number;
          workspaceId?: string;
          /** Local folder root; the director sends file paths from here. */
          workspacePath?: string;
        }[];
        directorSpaces?: { id: string; name: string; access: DirectorSpaceAccess }[];
        /**
         * `agent-editor`: the Agent being edited. Folder tasks: the Agent the
         * user enabled in the composer (its prompt and capability scope apply).
         */
        agentId?: string;
        /** Display messages this run fills; a reloaded page reattaches through them. */
        messageId?: string;
        userMessageId?: string;
        userMessage?: string;
      }) => Promise<boolean>;
      agentAbort: (requestId: string) => Promise<boolean>;
      /** Runs still alive in the main process (plus recently finished ones). */
      agentActive: () => Promise<AgentRunSnapshot[]>;
      agentResolve: (request: {
        requestId: string;
        callId: string;
        decision: {
          allow?: boolean;
          remember?: boolean;
          note?: string;
          answer?: string;
          /** Credential values from the card; consumed by the local executor. */
          secrets?: Record<string, string>;
          /** Keep the credential in memory for the rest of this task. */
          rememberSecrets?: boolean;
        };
      }) => Promise<boolean>;
      agentDeleteSession: (sessionId: string) => Promise<boolean>;
      /**
       * Fold the task's agent history — the file the model actually reads on
       * the next turn. The renderer summary card alone does not shrink the
       * prompt, so task compression calls this as well.
       */
      agentCompact: (request: {
        sessionId: string;
        /** 工作设置 → 最大上下文, in tokens. */
        contextLimit?: number;
      }) => Promise<{
        ok: boolean;
        compacted?: boolean;
        before?: number;
        after?: number;
        error?: string;
      }>;
      /**
       * Live size of the task's agent history. Used when a manual compaction
       * happened after the last request, so the provider's last prompt count
       * no longer describes the file the model will read next.
       */
      agentContext: (sessionId: string) => Promise<{
        tokens: number;
        at: number;
        digested: boolean;
      } | null>;
      agentCapabilities: () => Promise<AgentCapabilities>;
      agentCustomTools: () => Promise<CustomToolDefinition[]>;
      agentRuntimes: () => Promise<AgentRuntimeInfo[]>;
      pythonEnvStatus: () => Promise<PythonEnvStatus>;
      pythonEnvEnsure: () => Promise<PythonEnvStatus>;
      pythonModules: () => Promise<PythonModule[]>;
      pythonInstallModule: (spec: string) => Promise<{ ok: boolean; spec: string; output: string }>;
      pythonSetIndex: (value: string) => Promise<{ indexUrl: string }>;
      agentCustomToolSave: (definition: Partial<CustomToolDefinition>) => Promise<CustomToolResult>;
      agentCustomToolDelete: (id: string) => Promise<CustomToolResult>;
      /** Re-reads tools/agents from disk; the window reloads afterwards. */
      reloadRuntime: () => Promise<{
        ok: boolean;
        tools?: number;
        categories?: number;
        agents?: number;
        error?: string;
      }>;
      agentToolHealth: () => Promise<ToolHealthMap>;
      agentToolRetest: (request: {
        id: string;
        args?: Record<string, unknown>;
      }) => Promise<ToolRetestResult>;
      agentCategories: () => Promise<ToolCategory[]>;
      agentCategorySave: (input: {
        id?: string;
        name?: string;
        pinned?: boolean;
      }) => Promise<CategoryResult>;
      agentCategoryDelete: (id: string) => Promise<CategoryResult>;
      agentCategoryExport: (id: string) => Promise<CategoryPackageExportResult>;
      agentCategoryImport: () => Promise<CategoryPackageImportResult>;
      onAgentEvent: (callback: (event: AgentStreamEvent) => void) => () => void;
      copyText: (text: string) => Promise<boolean>;
      exportSession: (payload: {
        title: string;
        markdown: string;
        /** 传了就写进这个目录（空串/不可用则落到数据根 exports/），不弹保存框。 */
        folder?: string;
      }) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;

      promptsLoad: () => Promise<PromptTemplate[] | null>;
      promptsSave: (templates: PromptTemplate[]) => Promise<boolean>;
      promptsExport: (payload: { template: PromptTemplate }) => Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        error?: string;
      }>;
      promptsImport: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        data?: unknown;
        path?: string;
        error?: string;
      }>;

      agentsList: () => Promise<AgentDefinition[]>;
      agentsSave: (definition: Partial<AgentDefinition>) => Promise<AgentSaveResult>;
      agentsReview: (request: {
        provider: ChatTarget;
        agents: AgentDefinition[];
        catalog: AgentReviewCatalog;
      }) => Promise<AgentReviewResponse>;
      agentsDelete: (id: string) => Promise<AgentDeleteResult>;
      agentsExport: (id: string) => Promise<AgentPackageExportResult>;
      agentsImport: () => Promise<AgentPackageImportResult>;

      directorGet: () => Promise<DirectorState>;
      directorSave: (patch: DirectorPatch) => Promise<DirectorSaveResult>;
      directorPresence: (input: DirectorPresenceInput) => Promise<DirectorSaveResult>;
      onDirectorEvent: (callback: (state: DirectorState) => void) => () => void;

      /** 工作总监 · 服务 */
      directorSync: (
        tasks: DirectorTaskRef[],
        spaces?: DirectorSpaceRef[],
      ) => Promise<{ ok: boolean }>;
      directorSnapshot: () => Promise<DirectorSnapshot>;
      directorInbox: () => Promise<DirectorInboxView>;
      directorMarkRead: (ids?: string[]) => Promise<{ ok: boolean } & DirectorInboxView>;
      /** 内容审计：本地统计，打开弹窗就出图。 */
      directorAudit: (options?: { announce?: boolean }) => Promise<DirectorAudit>;
      /** 审计里主动要一次建议：不受冷却和每日限额影响。 */
      directorReviewNow: () => Promise<{
        ok: boolean;
        error?: string;
        id?: string;
        title?: string;
        body?: string;
        key?: string;
        /** 这次实际看过的几类活（给失败时的提示用）。 */
        checked?: string[];
      }>;
      directorResolve: (payload: {
        id: string;
        action: string;
        value?: string;
      }) => Promise<DirectorResolveResult>;
      directorLedger: (limit?: number) => Promise<{ items: DirectorLedgerEntry[] }>;
      directorClear: (payload: {
        sessionId: string;
        messages: Message[];
      }) => Promise<{
        ok: boolean;
        id?: string;
        ids?: string[];
        keep?: string[] | null;
        error?: string;
      }>;
      directorHistory: () => Promise<{
        ok: boolean;
        items: DirectorHistoryEntry[];
        error?: string;
      }>;
      directorHistoryGet: (
        id: string,
      ) => Promise<{ ok: boolean; entry?: DirectorHistoryDetail; error?: string }>;
      directorHistoryDedupe: () => Promise<{
        ok: boolean;
        removed?: number;
        kept?: number;
        error?: string;
      }>;
      directorHistoryDelete: (ids: string[]) => Promise<{
        ok: boolean;
        removed?: number;
        /** 一起删掉的总监事务条数。 */
        transactions?: number;
        error?: string;
      }>;
      /** 后台整理完存档名字后推给界面，不用重新打开弹窗。 */
      onDirectorHistory: (
        callback: (payload: {
          updates: Array<{ id: string; title: string; titleSource?: 'model' | 'content' }>;
        }) => void,
      ) => () => void;
      directorInspect: (
        taskId: string,
        part?: 'overview' | 'conversation' | 'tools' | 'files' | 'thinking',
      ) => Promise<{ ok: boolean; error?: string; data?: DirectorInspectData }>;
      directorInstructionAck: (payload: {
        id: string;
        ok: boolean;
        error?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      /** 界面按派工单建好员工任务后回执，主进程据此排队并验收。 */
      directorSpawnAck: (payload: {
        dispatchId: string;
        items: DirectorSpawnResult[];
      }) => Promise<{ ok: boolean; created?: number; error?: string }>;
      directorRunBlocked: (payload: {
        taskId: string;
        reason: string;
      }) => Promise<{ ok: boolean; pending?: boolean; message?: string }>;
      directorUserMessage: (payload: { taskId: string; text: string }) => Promise<{ ok: boolean }>;
      directorTyping: (active: boolean) => Promise<{ ok: boolean }>;
      onDirectorInbox: (callback: (view: DirectorInboxView) => void) => () => void;
      onDirectorInstruction: (
        callback: (payload: { instruction: DirectorInstruction; task: DirectorTaskRef | null }) => void,
      ) => () => void;
      onDirectorSpawn: (
        callback: (payload: DirectorSpawnPayload) => void,
      ) => () => void;
      /** 总监要置顶/重命名/导出/删除任务，由界面执行。 */
      onDirectorTaskAction: (callback: (request: DirectorTaskAction) => void) => () => void;
      directorTaskAck: (payload: {
        opId?: string;
        ok: boolean;
        deleted?: string[];
        files?: Array<{ taskId: string; path: string; name: string }>;
        error?: string;
      }) => Promise<{ ok: boolean }>;
      agentsMemorySnapshot: (id: string) => Promise<AgentMemorySnapshot>;
      agentsMemorySave: (id: string, input: AgentMemoryInput) => Promise<AgentMemoryResult>;
      agentsMemoryDelete: (id: string, memoryId: string) => Promise<AgentMemoryResult>;
      agentsMemoryReview: (
        id: string,
        memoryId: string,
        decision: 'confirm' | 'reject' | 'archive' | 'restore' | 'dispute',
      ) => Promise<AgentMemoryResult>;
      agentsMemoryRecheck: (id: string, memoryId: string) => Promise<AgentMemoryResult>;
      agentsMemoryProposal: (
        id: string,
        memoryId: string,
        accept: boolean,
      ) => Promise<AgentMemoryResult>;
      agentsMemoryEvents: (id: string) => Promise<{
        ok: boolean;
        error?: string;
        events?: AgentMemoryEvent[];
      }>;
      agentsMemoryConfig: (
        id: string,
        patch: Partial<AgentMemorySettings>,
      ) => Promise<AgentMemoryResult>;
      onAgentMemoryEvent: (callback: (event: AgentMemoryEvent) => void) => () => void;

      getPathForFile: (file: File) => string;
      agentPickSecretFile: (request?: { title?: string }) => Promise<string>;
      kbSnapshot: () => Promise<KbSnapshot>;
      kbSetConfig: (patch: KbConfigPatch) => Promise<KbSnapshot>;
      kbPickFiles: () => Promise<string[]>;
      kbAddFiles: (
        filePaths: string[],
        categoryId?: string | null,
      ) => Promise<{ id: string; name: string }[]>;
      kbCreateCategory: (
        name: string,
        kind?: KbCategoryKind,
        includes?: string[],
      ) => Promise<KbSnapshot>;
      kbRenameCategory: (id: string, name: string) => Promise<KbSnapshot>;
      kbSetCategoryIncludes: (id: string, includes: string[]) => Promise<KbSnapshot>;
      kbDeleteCategory: (id: string) => Promise<KbSnapshot>;
      kbReorderCategories: (ids: string[]) => Promise<KbSnapshot>;
      kbMoveDocument: (docId: string, categoryId: string) => Promise<KbSnapshot>;
      kbDeleteDocument: (docId: string) => Promise<KbSnapshot>;
      kbExportDocument: (docId: string) => Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        error?: string;
      }>;
      kbSearch: (
        query: string,
        options?: { categoryId?: string | null; categoryIds?: string[] | null; topK?: number },
      ) => Promise<KbSearchResponse>;
      onKbEvent: (callback: (event: KbEvent) => void) => () => void;

      warehouseSnapshot: () => Promise<WarehouseSnapshot>;
      warehousePickFiles: () => Promise<string[]>;
      warehouseAddFiles: (
        filePaths: string[],
        origin?: 'chat' | 'import',
      ) => Promise<WarehouseAddResult>;
      warehouseAddBlobs: (
        entries: { name: string; data: ArrayBuffer }[],
        origin?: 'chat' | 'import',
      ) => Promise<WarehouseAddResult>;
      warehouseReadText: (
        ids: string[],
        options?: OcrReadOptions,
      ) => Promise<WarehouseReadResult[]>;
      warehouseDelete: (id: string) => Promise<WarehouseSnapshot>;
      warehouseDeleteMany: (ids: string[]) => Promise<WarehouseSnapshot>;
      warehouseOpen: (id: string) => Promise<{ ok: boolean; error?: string }>;
      warehouseReveal: (id: string) => Promise<{ ok: boolean; error?: string }>;
      warehouseOpenRoot: () => Promise<{ ok: boolean; error?: string }>;
      warehouseThumbnail: (id: string) => Promise<string | null>;
      onWarehouseEvent: (callback: (snapshot: WarehouseSnapshot) => void) => () => void;

      /** Workspace folder picker; null when the dialog was cancelled. */
      workspacePickFolder: () => Promise<string | null>;
      workspaceLoad: () => Promise<{
        workspaces?: unknown[];
        chats?: unknown[];
        messages?: unknown[];
        activeWorkspaceId?: string | null;
        activeChatId?: string | null;
      } | null>;
      workspaceSave: (state: {
        workspaces: unknown[];
        chats: unknown[];
        messages: unknown[];
        activeWorkspaceId: string | null;
        activeChatId: string | null;
      }) => Promise<boolean>;
      workspaceTree: (request: {
        workspaceId: string;
        dir?: string;
      }) => Promise<WorkspaceTreeResult>;
      workspaceReadFile: (request: {
        workspaceId: string;
        path: string;
      }) => Promise<WorkspaceFileResult>;
      workspaceOpenFile: (request: {
        workspaceId: string;
        path: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      workspaceReveal: (request: {
        workspaceId: string;
        path: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      workspaceCreateFolder: (request: {
        workspaceId: string;
        parent?: string;
        name: string;
      }) => Promise<{ ok: boolean; error?: string; path?: string }>;
      workspaceMove: (request: {
        workspaceId: string;
        from: string;
        toDir: string;
      }) => Promise<{ ok: boolean; error?: string; path?: string }>;
      workspaceRename: (request: {
        workspaceId: string;
        path: string;
        name: string;
      }) => Promise<{ ok: boolean; error?: string; path?: string }>;
      workspaceDelete: (request: {
        workspaceId: string;
        path: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      workspaceProperties: (request: {
        workspaceId: string;
        path: string;
      }) => Promise<WorkspaceEntryProperties>;
      /** Watch the root plus every folder the tree currently has open. */
      workspaceWatch: (request: {
        workspaceId: string;
        dirs: string[];
      }) => Promise<{ ok: boolean; error?: string; dirs?: string[] }>;
      workspaceUnwatch: (workspaceId: string) => Promise<boolean>;
      /** Model-backed summary + charts over this workspace's tasks and usage. */
      workspaceVisualize: (
        request: WorkspaceVisualizeRequest,
      ) => Promise<WorkspaceVisualizeResult>;
      /** Stop a visualization run that is still streaming. */
      workspaceVizCancel: (requestId: string) => void;
      /** Rows read from CSV/Excel/SQLite/JSON files inside the workspace folder. */
      workspaceVizTables: (request: {
        workspaceId: string;
      }) => Promise<{ ok: boolean; tables?: WorkspaceVizTable[]; error?: string }>;
      /** Every row behind a sampled table, re-read from its file. */
      workspaceVizTableRows: (request: {
        workspaceId: string;
        refs: VizTableRef[];
      }) => Promise<{
        ok: boolean;
        columns?: string[];
        rows?: string[][];
        total?: number;
        truncated?: boolean;
        error?: string;
      }>;
      /** Remote workspaces: credentials go to the main process only. */
      workspaceRemoteConnect: (request: {
        host: string;
        port: number;
        username: string;
        password?: string;
        privateKeyPath?: string;
        privateKeyPassphrase?: string;
        fingerprint?: string;
      }) => Promise<{
        ok: boolean;
        error?: string;
        sessionId?: string;
        home?: string;
        fingerprint?: string;
        host?: string;
        port?: number;
        username?: string;
      }>;
      workspaceRemoteList: (request: {
        sessionId: string;
        path?: string;
      }) => Promise<{
        ok: boolean;
        error?: string;
        path?: string;
        home?: string;
        parent?: string;
        label?: string;
        entries?: { name: string; path: string; hidden?: boolean }[];
      }>;
      workspaceRemoteOpen: (request: {
        sessionId: string;
        path: string;
        workspaceId: string;
      }) => Promise<{
        ok: boolean;
        error?: string;
        root?: string;
        name?: string;
        fingerprint?: string;
      }>;
      workspaceRemoteClose: (request: { sessionId: string }) => Promise<{ ok: boolean }>;
      workspacePickKeyFile: () => Promise<string>;
      onWorkspaceChanged: (
        callback: (event: { workspaceId: string; dirs: string[] }) => void,
      ) => () => void;

      storageInfo: () => Promise<StorageInfo>;
      storagePickRoot: () => Promise<string | null>;
      storageMigrateRoot: (targetPath: string) => Promise<StorageMigrateResult>;
      storageOpenRoot: () => Promise<{ ok: boolean; error?: string }>;

      /** Language packs under <dataRoot>/locales; custom packs override built-ins. */
      localesList: () => Promise<LocaleListResult>;
      localesRead: (file: string) => Promise<LocalePackPayload | null>;
      /** Creates locales/ with a README and an example pack, then opens it. */
      localesOpenFolder: (example?: Record<string, unknown>) => Promise<{
        ok: boolean;
        dir?: string;
        error?: string;
      }>;

      webSearch: (query: string, entries?: WebEntry[]) => Promise<WebSearchResponse>;
      /** 自动联网: let the model decide whether this turn needs a search. */
      webJudge: (request: WebJudgeRequest) => Promise<WebJudgeResult>;

      ocrStatus: () => Promise<OcrModelStatus>;

      voiceStatus: () => Promise<VoiceModelStatus>;
      voiceDownload: () => Promise<VoiceDownloadResult>;
      voiceCancelDownload: () => Promise<boolean>;
      voiceStart: () => Promise<{ ok: boolean; error?: string }>;
      voiceChunk: (buffer: ArrayBuffer) => Promise<boolean>;
      voiceStop: () => Promise<{ ok: boolean }>;
      voiceCancel: () => Promise<{ ok: boolean }>;
      onVoiceEvent: (callback: (event: VoiceEvent) => void) => () => void;
    };
  }
}
