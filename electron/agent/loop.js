/**
 * The agent loop.
 *
 * One turn: send the conversation + tool specs to the model, stream text back,
 * run whatever tools it asked for, feed the results back, repeat. It stops when
 * the model answers without a tool call, the step budget runs out, or the user
 * aborts.
 *
 * The loop owns nothing renderer-specific: everything surfaces as events on
 * the `agent:event` channel, including permission requests, which block the
 * loop until the user answers in the UI.
 *
 * Conversation state lives in the session file, not in the renderer, so a
 * follow-up message picks up exactly where the last one ended — including which
 * files were already edited. Before each request the prompt is measured in
 * tokens against the window configured in 工作设置; older turns are folded into
 * a digest once the history, system prompt and tool schemas approach it.
 */

const { streamChat } = require('../chat');
const path = require('node:path');
const {
  specs,
  get,
  summarize,
  clip,
  normalizeTodos,
  mergeTodos,
  advanceTodos,
  LAZY_LOAD_TOOL,
  resolveLoad,
  isCustomTool,
  customToolGroup,
  customToolsFor,
  groupCustomTools,
  hasCustomTools,
} = require('./tools');
const { decide, commandKey, normalizeAskLevel, secretParameters } = require('./policy');
const { reviewCommand } = require('./reviewer');
const uiText = require('../ui-text');
const {
  buildSystemPrompt,
  buildToolEditorPrompt,
  buildAgentEditorPrompt,
  buildDirectorPrompt,
} = require('./prompt');

const MAX_STEPS = 24;
const UI_RESULT_LIMIT = 6000;
/**
 * Compaction is measured in tokens against 工作设置 → 最大上下文. The request
 * also carries the system prompt and the tool schemas, so those are reserved
 * before the history budget is calculated.
 */
const COMPACT_RATIO = 0.85;
const KEEP_RATIO = 0.3;
const MIN_COMPACT_TOKENS = 8000;
const DIGEST_LIMIT = 8000;
const DEFAULT_CONTEXT_LIMIT = 128000;
/** Fallbacks for callers of compact() that do not pass a budget. */
const DEFAULT_COMPACT_AT = 100000;
const DEFAULT_KEEP_TOKENS = 30000;

/**
 * Provider errors that mean "this prompt is larger than the model window".
 * Such a request is safe to retry after a forced compaction: the provider
 * rejects it before emitting any text.
 */
const CONTEXT_OVERFLOW_RE =
  /context[_ ](?:length|window)|maximum context|prompt is too long|too many tokens|input is too long|exceeds? the (?:maximum|model).*(?:context|tokens)|上下文.*(?:超|过长|长度)|超过.*(?:上下文|长度)/i;

/** How many independent reads/searches may overlap in one step. */
const PARALLEL_LIMIT = 4;

/**
 * Calls the model put in one step were written before seeing each other's
 * results, so the read-only ones are independent and may overlap. Anything
 * that changes the workspace, talks to the user, or runs arbitrary code stays
 * on the serial path — otherwise two writes could race or an edit could land
 * between another call's read and its use.
 */
const SERIAL_TOOLS = new Set([
  LAZY_LOAD_TOOL,
  'ask_user',
  'todo_write',
  'run_command',
  'write_file',
  'edit_file',
]);

function canRunConcurrently(tool) {
  if (!tool) return false;
  if (tool.interactive || tool.custom || tool.toolEditor || tool.agentEditor) return false;
  if (SERIAL_TOOLS.has(tool.name)) return false;
  return Boolean(tool.readOnly || tool.network || tool.dataAccess);
}

/**
 * File writes are independent when they touch different paths, so a step that
 * creates ten files does not have to wait ten times. Same-path calls are
 * chained (write then edit of the same file must stay in order), and commands
 * still run afterwards, once every write has landed.
 */
function isFileWrite(tool) {
  return Boolean(tool && !tool.custom && (tool.name === 'write_file' || tool.name === 'edit_file'));
}

function writeKey(root, call) {
  const target = String(call.args?.path ?? '');
  const resolved = path.resolve(root, target || '.');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Small fixed-size worker pool; failures are collected, never raced. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  const failures = [];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(runners);
  return failures;
}

function abortError() {
  const error = new Error(uiText.t('main.agent.interrupted'));
  error.name = 'AbortError';
  return error;
}

/**
 * Credentials entered in a confirmation card, kept in memory for the app
 * session. They are scoped by workspace + tool + target, so a password for one
 * server is never offered for another, and nothing is ever written to disk.
 */
const SECRET_TTL_MS = 2 * 60 * 60 * 1000;
const sharedSecretCache = new Map();

/** Drops every remembered credential (used by tests and a future UI action). */
function clearSecretCache() {
  sharedSecretCache.clear();
}

/**
 * Where a credential belongs: the workspace, the tool and the target it
 * connects to. Two calls against different hosts must not share a password.
 */
function secretScope(tool, args, root = '') {
  const target = ['host', 'hostname', 'username', 'user', 'port', 'url', 'database']
    .map((key) => (args?.[key] === undefined || args?.[key] === null ? '' : String(args[key])))
    .join('|');
  return `${root}::${tool?.name ?? ''}::${target}`;
}

function cachedSecretsFor(key) {
  const entry = sharedSecretCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sharedSecretCache.delete(key);
    return null;
  }
  return entry.values;
}

function rememberSecrets(key, values) {
  if (!key || Object.keys(values).length === 0) return;
  sharedSecretCache.set(key, { values, expiresAt: Date.now() + SECRET_TTL_MS });
}

/** Only the values the user actually typed, in declaration order. */
function pickSecrets(values, parameters) {
  const picked = {};
  for (const parameter of parameters) {
    const value = values?.[parameter.name];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text === '') continue;
    picked[parameter.name] = text;
  }
  return picked;
}

/**
 * Secrets must not come back through tool output or an error message: a remote
 * shell echoes commands, and some programs print their arguments.
 */
function redactSecrets(text, values) {
  let out = String(text ?? '');
  for (const value of Object.values(values ?? {})) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out = out.split(value).join('••••••');
  }
  return out;
}

/** run_command reports a non-zero exit as a normal result, not a thrown error. */
function callSucceeded(name, status, result) {
  if (status !== 'done') return false;
  const text = String(result ?? '').trim();
  if (name === 'run_command') return text.startsWith('退出码 0');
  // A search that found nothing is a completed call but not a completed plan
  // item ("查到资料"), so it must not tick the box.
  if (name === 'web_search') return !text.startsWith('没有搜到');
  return true;
}

/**
 * Rough token count with the same rule the renderer uses: one token per CJK
 * character, four characters per token otherwise. It is a yardstick, not a
 * tokenizer, but it keeps the ring, the compaction log and the reply readable
 * in one unit.
 */
function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const cjk = value.match(/[㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  return Math.round(cjk + (value.length - cjk) / 4);
}

function sizeOf(messages) {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content) + 4;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      total += estimateTokens(JSON.stringify(message.toolCalls));
    }
  }
  return total;
}

function isContextOverflow(error) {
  if (!error) return false;
  return CONTEXT_OVERFLOW_RE.test(`${error.message ?? ''} ${error.code ?? ''}`);
}

/**
 * A run stopped mid-tool (abort, crash) leaves an assistant message whose
 * tool calls have no results. Every provider rejects that on the next turn, so
 * fill the gaps before resuming.
 */
function repair(messages) {
  const out = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    out.push(message);
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || message.toolCalls.length === 0) {
      continue;
    }
    const results = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === 'tool') {
      results.push(messages[cursor]);
      cursor += 1;
    }
    const answered = new Set(results.map((item) => item.toolCallId));
    for (const call of message.toolCalls) {
      if (answered.has(call.id)) continue;
      out.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: '（这一步被中断，没有执行结果。）',
      });
    }
    out.push(...results);
    index = cursor - 1;
  }
  return out;
}

const DIGEST_HEADER = '[更早的对话已压缩为摘要，下面是此前做过的事]';

/** True for the summary message compact() puts at the front of a session. */
function isDigest(message) {
  return (
    message?.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(DIGEST_HEADER)
  );
}

/**
 * Build the new leading summary. An existing digest is carried forward
 * verbatim and only genuinely new turns are appended — otherwise every
 * further compaction would digest the previous digest, nesting the header and
 * throwing away everything it had recorded.
 */
function mergeDigest(previous, older) {
  const body = digest(older);
  // `split` on the header rather than replaceAll: an older digest may contain
  // nested copies from before this guard existed, and they read as noise.
  const prior = previous
    ? previous.content.slice(DIGEST_HEADER.length).split(DIGEST_HEADER).join('').trim()
    : '';
  const merged = prior ? `${DIGEST_HEADER}\n${prior}\n${body}` : `${DIGEST_HEADER}\n${body}`;
  if (merged.length <= DIGEST_LIMIT) return merged;
  // Keep the newest lines: they describe the work closest to the live tail.
  const tail = merged.slice(merged.length - (DIGEST_LIMIT - DIGEST_HEADER.length - 24));
  return `${DIGEST_HEADER}\n…（更早的摘要已省略）\n${tail}`;
}

/** Human-readable digest of turns that are about to leave the live context. */
function digest(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push(`用户要求：${clip(String(message.content ?? '').replace(/\s+/g, ' ').trim(), 300)}`);
      continue;
    }
    if (message.role === 'assistant') {
      if (String(message.content ?? '').trim()) {
        lines.push(`助手：${clip(String(message.content).replace(/\s+/g, ' ').trim(), 300)}`);
      }
      for (const call of message.toolCalls ?? []) {
        const args = call.args ?? {};
        const brief = call.name === 'run_command'
          ? String(args.command ?? '')
          : call.name === 'web_search'
            ? String(args.query ?? '')
            : call.name === 'web_search_many'
              ? (Array.isArray(args.queries) ? args.queries.join('、') : '')
              : call.name === 'web_fetch'
                ? String(args.url ?? '')
                : call.name === 'read_many'
                  ? (Array.isArray(args.paths) ? args.paths.join('、') : '')
                  : String(args.path ?? args.pattern ?? '');
        lines.push(`- 调用 ${call.name}(${clip(brief, 160)})`);
      }
      continue;
    }
    if (message.role === 'tool') {
      const text = String(message.content ?? '').trim();
      if (/^(已写入|已修改)/.test(text) || message.name === 'run_command') {
        lines.push(`  ↳ ${clip(text.replace(/\s+/g, ' '), 200)}`);
      }
    }
  }
  return clip(lines.join('\n'), DIGEST_LIMIT);
}

/**
 * Fold old turns into one digest message. The split always lands on a user
 * message, or on an assistant message that starts a tool-call round, so a call
 * and its results never get separated. `at` and `keep` are token budgets;
 * `force` compacts even when the log is still under `at`, which is what the
 * overflow recovery uses.
 */
function compact(messages, options = {}) {
  const before = sizeOf(messages);
  const at = Number(options.at) > 0 ? Number(options.at) : DEFAULT_COMPACT_AT;
  const keep = Number(options.keep) > 0 ? Number(options.keep) : DEFAULT_KEEP_TOKENS;
  const force = options.force === true;
  if (before <= at && !force) return { messages, compacted: false, before, after: before };

  const candidates = [];
  messages.forEach((message, index) => {
    // Never make the digest the only message: keep at least the tail.
    if (index === 0) return;
    if (message.role === 'user') candidates.push(index);
    else if (
      message.role === 'assistant' &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0
    ) {
      candidates.push(index);
    }
  });

  let split = -1;
  for (const index of candidates) {
    if (sizeOf(messages.slice(index)) <= keep * 1.2) {
      split = index;
      break;
    }
  }
  // Nothing fits the keep budget (one long tool round, usually). A forced
  // compaction still folds everything before the last safe boundary.
  if (split <= 0 && force && candidates.length > 0) {
    split = candidates[candidates.length - 1];
  }
  if (split <= 0) return { messages, compacted: false, before, after: before };

  const previous = isDigest(messages[0]) ? messages[0] : null;
  // Everything before `split`, minus the existing digest: only new turns are
  // summarised, so repeated manual compactions cannot fold a summary into
  // itself.
  const older = messages.slice(previous ? 1 : 0, split);
  if (older.length === 0) {
    // The tail already fits the keep budget; there is nothing new to fold.
    return { messages, compacted: false, before, after: before };
  }
  const recent = messages.slice(split);
  const summary = mergeDigest(previous, older);
  const next = [{ role: 'user', content: summary }, ...recent];
  return { messages: next, compacted: true, before, after: sizeOf(next) };
}

class AgentRun {
  constructor({
    requestId,
    provider,
    workspacePath,
    workspaceName,
    message,
    session,
    history,
    mode,
    send,
    allowedCommands,
    webEnabled,
    webEntries,
    maxSteps,
    askLevel,
    autoDeleteTemp,
    autoInstallDeps,
    contextLimit,
    toolScope,
    toolContext,
    initialTodos,
    onUsage,
    workspaceFs = null,
  }) {
    this.requestId = requestId;
    this.provider = provider;
    /** Main process ledger hook; called once per model request. */
    this.onUsage = typeof onUsage === 'function' ? onUsage : null;
    this.root = workspacePath;
    /** Local folder or remote SSH adapter; tools use this instead of node fs. */
    this.ws = workspaceFs ?? null;
    this.workspaceName = workspaceName;
    this.message = String(message ?? '');
    this.session = session ?? null;
    this.historyFallback = Array.isArray(history) ? history : [];
    this.mode = mode;
    this.send = send;
    this.webEnabled = Boolean(webEnabled);
    this.webEntries = Array.isArray(webEntries) ? webEntries : [];
    /**
     * When the user enabled 自动删除 AI 临时输出文件, `.ezness` disappears after
     * the run — the prompt must not promise the user that those files remain.
     */
    this.autoDeleteTemp = Boolean(autoDeleteTemp);
    // Custom tools install missing pip/npm packages on demand unless the user
    // turned 自动安装依赖 off in 工作设置.
    this.autoInstallDeps = autoInstallDeps !== false;
    // The window the user configured for this model. Compaction keeps the whole
    // request (system prompt + tool schemas + history) below this figure.
    const window = Math.trunc(Number(contextLimit));
    this.contextLimit =
      Number.isFinite(window) && window >= 1000 ? window : DEFAULT_CONTEXT_LIMIT;
    /**
     * Provider prompt tokens divided by our own estimate. JSON tool results
     * and punctuation are denser than the renderer's four-characters-per-token
     * rule, so on a large window the estimate can sit a quarter below what the
     * provider actually charges; compaction would then never fire while the
     * ring already looks full. Calibrated after every request.
     */
    this.tokenScale = null;
    // Settings may say -1 (unlimited). Anything unusable keeps the old default.
    const steps = Math.trunc(Number(maxSteps));
    this.maxSteps =
      Number.isFinite(steps) && steps !== 0 ? (steps === -1 ? -1 : Math.max(1, steps)) : MAX_STEPS;
    this.askLevel = normalizeAskLevel(askLevel);
    this.toolScope = toolScope ?? null;
    this.toolContext = toolContext ?? null;
    /** Custom tool names whose schemas are already in this run's tool list. */
    this.loadedTools = new Set();
    /**
     * Authoritative checklist for this task. The renderer persists it with the
     * conversation and sends it back with the next turn, so auto-ticked items
     * (which never appear as a todo_write call in the transcript) survive a
     * restart and every status shown in the UI is the one the loop will use.
     */
    this.todos = Array.isArray(initialTodos) ? mergeTodos([], normalizeTodos({ todos: initialTodos })) : [];
    this.controller = new AbortController();
    this.pending = new Map();
    /** Commands this run may execute again without asking. */
    this.rules = new Set(
      (Array.isArray(allowedCommands) ? allowedCommands : [])
        .map((command) => String(command ?? '').trim())
        .filter(Boolean)
        .map((command) => commandKey(command)),
    );
  }

  abort() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const [callId, entry] of this.pending) {
      this.pending.delete(callId);
      entry.reject(abortError());
    }
    // Unwinding a tool may take a moment (a killed process has to release its
    // pipes), so confirm the stop to the UI immediately. The terminal event
    // main sends later is ignored by the renderer once it has cleared the run.
    this.send({ type: 'aborted' });
  }

  /** Answer a permission or question request from the renderer. */
  resolve(callId, decision) {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.resolve(decision ?? { allow: false });
    return true;
  }

  wait(callId) {
    if (this.controller.signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      this.controller.signal.addEventListener(
        'abort',
        () => {
          if (this.pending.delete(callId)) reject(abortError());
        },
        { once: true },
      );
    });
  }

  /** Persist the conversation (system prompt excluded). Never fails the run. */
  async persist(history) {
    // Keep run.history in step with what was persisted: post-run learning reads
    // it, and the tool results of this turn only exist here.
    this.history = history;
    if (!this.session) return;
    try {
      await this.session.save(history);
    } catch {
      /* a full disk or a locked file must not end the task */
    }
  }

  /**
   * Rebuild the lazy-load set from the transcript. A resumed task should not
   * pay the load round again; a load call from an earlier turn still counts.
   */
  restoreLoadedTools(history) {
    const loaded = new Set();
    if (this.toolScope?.kind === 'tool-editor' || this.toolScope?.kind === 'agent-editor') {
      return loaded;
    }
    for (const message of history) {
      if (message?.role !== 'assistant') continue;
      for (const call of message.toolCalls ?? []) {
        if (isCustomTool(call.name, this.toolScope)) {
          loaded.add(call.name);
        } else if (call.name === LAZY_LOAD_TOOL) {
          for (const name of resolveLoad(call.args?.names, this.toolScope).tools) loaded.add(name);
        }
      }
    }
    return loaded;
  }

  /**
   * Fallback for callers that do not pass the renderer's checklist (older
   * renderers, tests): the last todo_write in the transcript is close enough.
   */
  restoreTodos(history) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      if (message?.role !== 'assistant') continue;
      const calls = message.toolCalls ?? [];
      for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
        if (calls[callIndex].name === 'todo_write') {
          return mergeTodos([], normalizeTodos(calls[callIndex].args ?? {}));
        }
      }
    }
    return [];
  }

  /**
   * Tokens the request carries outside the conversation itself. Tool schemas
   * change after a load_custom_tools call, so this is recomputed every step.
   */
  contextBudget(system) {
    const overhead =
      estimateTokens(system) + estimateTokens(JSON.stringify(specs(this.toolScope, this.loadedTools)));
    const usable = Math.max(
      MIN_COMPACT_TOKENS,
      Math.round(this.contextLimit * COMPACT_RATIO - overhead),
    );
    return {
      at: usable,
      keep: Math.max(1000, Math.round(usable * KEEP_RATIO)),
      limit: this.contextLimit,
      overhead,
    };
  }

  /**
   * Compare the provider's prompt count with our text estimate and keep a
   * smoothed ratio. One unusual count (cached token accounting, a gateway
   * quirk) must not swing the budget, hence the 60/40 blend and the clamp.
   */
  calibrateUsage(usage, messages, system, tools) {
    if (!usage?.reported || !(usage.inputTokens > 0)) return;
    const estimated =
      estimateTokens(system) +
      estimateTokens(JSON.stringify(tools)) +
      sizeOf(messages.slice(1));
    if (estimated <= 0) return;
    const ratio = usage.inputTokens / estimated;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const clamped = Math.min(4, Math.max(0.5, ratio));
    this.tokenScale =
      this.tokenScale === null ? clamped : this.tokenScale * 0.6 + clamped * 0.4;
  }

  /**
   * Fold older turns when the next request would cross the budget. Called
   * before every model request, so a single long tool-heavy turn is capped too
   * — not only the start of a new user turn.
   */
  async compactNow(messages, system) {
    const budget = this.contextBudget(system);
    // compact() measures with sizeOf(); scale its budgets into that same unit
    // so "85% of the window" means what the provider reports, not what the
    // rough estimate wishes it were.
    const scale = this.tokenScale ?? 1;
    const folded = compact(messages.slice(1), {
      at: Math.round(budget.at / scale),
      keep: Math.max(1000, Math.round(budget.keep / scale)),
    });
    if (!folded.compacted) return messages;
    this.send({
      type: 'compact',
      before: folded.before,
      after: folded.after,
      limit: budget.limit,
    });
    this.history = folded.messages;
    await this.persist(folded.messages);
    return [{ role: 'system', content: system }, ...folded.messages];
  }

  /**
   * The provider rejected the prompt as too long (usually because the saved
   * window is larger than this model really supports). Compact hard and retry
   * once instead of failing the whole task.
   */
  async recoverOverflow(messages, system) {
    const history = messages.slice(1);
    const size = sizeOf(history);
    const folded = compact(history, {
      at: Math.round(size / 2),
      keep: Math.max(2000, Math.round(size / 5)),
      force: true,
    });
    if (!folded.compacted) return null;
    this.send({
      type: 'compact',
      before: folded.before,
      after: folded.after,
      limit: this.contextLimit,
      reason: 'overflow',
    });
    this.history = folded.messages;
    await this.persist(folded.messages);
    return [{ role: 'system', content: system }, ...folded.messages];
  }

  async run() {
    const system = this.toolScope?.kind === 'tool-editor'
      ? buildToolEditorPrompt(this.toolContext ?? {})
      : this.toolScope?.kind === 'agent-editor'
        ? buildAgentEditorPrompt(this.toolContext ?? {})
        : this.toolScope?.kind === 'director'
          ? buildDirectorPrompt(this.toolContext?.director ?? {})
          : await buildSystemPrompt({
          root: this.root,
          ws: this.ws,
          mode: this.mode,
          workspaceName: this.workspaceName,
          lazyCustomTools: hasCustomTools(this.toolScope),
          autoDeleteTemp: this.autoDeleteTemp,
          dataAccess: this.toolScope?.kind === 'workspace' ? this.toolScope.dataAccess ?? null : null,
          agent: this.toolScope?.kind === 'workspace' ? this.toolScope.agent ?? null : null,
        });

    let history = this.session ? await this.session.load() : [...this.historyFallback];
    // `thinking` is stored for the director's inspector, not replayed to the
    // provider: some gateways reject unknown message fields.
    history = history.map((message) => {
      if (!message || message.thinking === undefined) return message;
      const { thinking: _thinking, ...rest } = message;
      return rest;
    });
    history = repair(
      history.filter((message) => message && typeof message.role === 'string' && message.role !== 'system'),
    );

    if (this.message) history.push({ role: 'user', content: this.message });
    this.history = history;
    this.loadedTools = this.restoreLoadedTools(history);
    if (this.todos.length === 0) this.todos = this.restoreTodos(history);
    await this.persist(history);

    let messages = [{ role: 'system', content: system }, ...history];

    const stepLimit = this.maxSteps === -1 ? Number.POSITIVE_INFINITY : this.maxSteps;
    for (let step = 0; step < stepLimit; step += 1) {
      if (this.controller.signal.aborted) throw abortError();

      // Checked before every request, not just once per user turn: a single
      // tool-heavy turn can grow the prompt far more than a few new messages.
      messages = await this.compactNow(messages, system);

      // Recomputed every step: a load_custom_tools call in the previous step
      // changes which custom schemas go out with this request.
      const tools = specs(this.toolScope, this.loadedTools);

      let result;
      let emitted = false;
      let retriedOverflow = false;
      for (;;) {
        try {
          result = await streamChat(this.provider, messages, {
            signal: this.controller.signal,
            tools,
            onDelta: (chunk) => {
              emitted = true;
              this.send({ type: 'delta', text: chunk });
            },
            onThinking: (chunk) => {
              emitted = true;
              this.send({ type: 'thinking', text: chunk });
            },
            // Tool arguments have no text/reasoning deltas, so without this a
            // long write_file is a silent minutes-long gap. Progress only —
            // the call itself still arrives through executeBatch.
            onToolProgress: ({ name, chars, tokens }) => {
              this.send({ type: 'phase', phase: 'tool_call', name, chars, tokens });
            },
          });
          break;
        } catch (error) {
          if (error?.usage) this.onUsage?.({ feature: 'workspace', usage: error.usage });
          // Only safe while nothing was streamed yet: a provider rejects an
          // oversized prompt before the first token.
          if (!retriedOverflow && !emitted && isContextOverflow(error)) {
            const recovered = await this.recoverOverflow(messages, system);
            if (recovered) {
              retriedOverflow = true;
              messages = recovered;
              continue;
            }
          }
          throw error;
        }
      }
      const { text, toolCalls, finishReason } = result;
      this.calibrateUsage(result.usage, messages, system, tools);
      this.onUsage?.({ feature: 'workspace', usage: result.usage });

      if (text.trim() || toolCalls.length > 0) {
        const thinking = String(result.thinking ?? '').trim();
        messages.push({
          role: 'assistant',
          content: text,
          toolCalls,
          ...(thinking ? { thinking } : {}),
        });
        await this.persist(messages.slice(1));
      }

      if (toolCalls.length === 0) {
        // An empty answer ends the turn with nothing to show: the task would
        // look like it stopped for no reason, mid-checklist. Fail loudly.
        if (!text.trim()) {
          throw new Error(
            uiText.t('main.agent.emptyReply', {
              detail: finishReason
                ? uiText.t('main.agent.emptyReplyDetail', { reason: finishReason })
                : '',
            }),
          );
        }
        return;
      }

      await this.executeBatch(toolCalls, messages);
      if (this.controller.signal.aborted) throw abortError();
    }

    this.send({
      type: 'delta',
      text: uiText.t('main.agent.stepLimit', { max: this.maxSteps }),
    });
  }

  /**
   * Pull custom tool schemas into the next request. Entries may be tool names
   * or whole category names. Unknown entries come back with the catalogue so
   * the model can correct itself in one step instead of guessing.
   */
  loadCustomTools(call, messages) {
    const startedAt = Date.now();
    const { tools, unknown } = resolveLoad(call.args?.names, this.toolScope);
    for (const name of tools) this.loadedTools.add(name);

    let result;
    if (tools.length > 0) {
      result = `已加载：${tools.join('、')}。下一轮可以直接调用。`;
      if (unknown.length > 0) result += `\n未找到：${unknown.join('、')}。`;
    } else {
      const groups = groupCustomTools(customToolsFor(this.toolScope))
        .map((group) => `${group.name}（${group.tools.join('、')}）`)
        .join('；');
      result =
        `没有找到：${unknown.join('、') || '（未提供 names）'}。` +
        `可用工具包：${groups || '暂无自定义工具'}。请从这些名字里重新选择。`;
    }

    this.send({
      type: 'tool',
      status: tools.length > 0 ? 'done' : 'error',
      call,
      summary: summarize(LAZY_LOAD_TOOL, call.args ?? {}),
      result,
      startedAt,
      endedAt: Date.now(),
    });
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
  }

  /**
   * Run all tool calls of one model step.
   *
   * Calls keep the order the model wrote them in: only a run of consecutive
   * independent calls (reads/searches, or writes to file paths) is allowed to
   * overlap. A command or a dependent step acts as a barrier, so a model that
   * writes "build, then read the log" in one step still gets the new log.
   * Parallel calls keep a private message list and are merged back in their
   * original order, so one fast search cannot reorder the transcript.
   */
  async executeBatch(calls, messages) {
    let index = 0;
    while (index < calls.length) {
      const tool = get(calls[index].name, this.toolScope, this.loadedTools);
      const accepts = canRunConcurrently(tool)
        ? (next) => canRunConcurrently(next)
        : isFileWrite(tool)
          ? (next) => isFileWrite(next)
          : null;

      if (!accepts) {
        if (this.controller.signal.aborted) throw abortError();
        await this.execute(calls[index], messages);
        if (this.controller.signal.aborted) throw abortError();
        await this.persist(messages.slice(1));
        index += 1;
        continue;
      }

      const wave = [];
      while (index < calls.length) {
        const next = get(calls[index].name, this.toolScope, this.loadedTools);
        if (!accepts(next)) break;
        wave.push(calls[index]);
        index += 1;
      }
      await this.runWave(wave, messages);
    }
  }

  /**
   * One overlapping run: independent reads, or writes to distinct paths.
   * Same-path writes are chained in call order; a lane that fails does not
   * cancel the lanes beside it.
   */
  async runWave(calls, messages) {
    if (calls.length === 0) return;
    if (calls.length === 1) {
      await this.execute(calls[0], messages);
      if (this.controller.signal.aborted) throw abortError();
      await this.persist(messages.slice(1));
      return;
    }

    const buffers = calls.map(() => []);
    const locks = new Map();
    const failures = await runPool(calls, PARALLEL_LIMIT, async (call, index) => {
      const tool = get(call.name, this.toolScope, this.loadedTools);
      if (!isFileWrite(tool)) {
        await this.execute(call, buffers[index]);
        return;
      }
      const key = writeKey(this.root, call);
      const previous = locks.get(key) ?? Promise.resolve();
      const current = previous.then(() => this.execute(call, buffers[index]));
      locks.set(
        key,
        current.catch(() => {}),
      );
      await current;
    });
    if (this.controller.signal.aborted) throw abortError();
    if (failures.length > 0) throw failures[0];
    for (const buffer of buffers) messages.push(...buffer);
    // After a stop, a second run may already own the session file; do not
    // write over it. The dangling tool call is repaired on the next load.
    await this.persist(messages.slice(1));
  }

  async execute(call, messages) {
    const args = call.args ?? {};

    if (
      call.name === LAZY_LOAD_TOOL &&
      this.toolScope?.kind !== 'tool-editor' &&
      this.toolScope?.kind !== 'agent-editor'
    ) {
      this.loadCustomTools(call, messages);
      return;
    }

    const tool = get(call.name, this.toolScope, this.loadedTools);

    if (!tool) {
      // The model called a custom tool it has not pulled in yet. Load it now
      // and ask for the call again — more reliable than hoping it remembers to
      // call load_custom_tools first.
      if (
        this.toolScope?.kind !== 'tool-editor' &&
        this.toolScope?.kind !== 'agent-editor' &&
        isCustomTool(call.name, this.toolScope)
      ) {
        this.loadedTools.add(call.name);
        const startedAt = Date.now();
        const result =
          `工具 ${call.name}（包：${customToolGroup(call.name)}）此前未加载，已自动加载。` +
          `下一轮请重新调用 ${call.name}。`;
        this.send({
          type: 'tool',
          status: 'done',
          call,
          summary: uiText.t('main.agent.loadSummary', { name: call.name }),
          result,
          startedAt,
          endedAt: Date.now(),
        });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        return;
      }

      const result = `未知工具：${call.name}。可用工具：${specs(this.toolScope, this.loadedTools)
        .map((item) => item.name)
        .join('、')}`;
      this.send({ type: 'tool', status: 'error', call, result });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
      return;
    }

    this.send({
      type: 'tool',
      status: 'running',
      call,
      summary: summarize(tool.name, args),
      startedAt: Date.now(),
    });

    if (tool.interactive) {
      await this.askUser(call, messages);
      return;
    }

    // Secrets never reach the model: they are read from the confirmation card
    // and merged into the execution args only. A credential the user already
    // entered for this task and this target is reused without asking again.
    const secrets = secretParameters(tool);
    const secretKey = secretScope(tool, args, this.root);
    const cachedSecrets = secrets.length > 0 ? cachedSecretsFor(secretKey) : null;
    let enteredSecrets = {};

    const decision = decide({
      tool,
      args,
      mode: this.mode,
      rules: this.rules,
      root: this.root,
      askLevel: this.askLevel,
      secretAvailable: Boolean(cachedSecrets),
    });

    if (decision.action === 'deny') {
      const result = `操作被拒绝：${decision.reason}`;
      this.send({ type: 'tool', status: 'denied', call, result, startedAt: Date.now() });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
      return;
    }

    if (decision.action === 'ask') {
      this.send({
        type: 'permission',
        call,
        summary: summarize(tool.name, args),
        reason: decision.reason,
        danger: Boolean(decision.danger),
        secrets: secrets.map((parameter) => ({
          name: parameter.name,
          kind: parameter.secretKind === 'file' ? 'file' : 'text',
          required: Boolean(parameter.required),
          description: parameter.description || '',
        })),
      });
      let answer;
      try {
        answer = await this.wait(call.id);
      } catch (error) {
        this.send({
          type: 'tool',
          status: 'denied',
          call,
          result: uiText.t('main.agent.interrupted'),
          startedAt: Date.now(),
        });
        throw error;
      }

      if (!answer?.allow) {
        const note = String(answer?.note ?? '').trim();
        const result = `用户拒绝了这次操作。${note ? `\n用户的说明：${note}` : ''}\n不要重复同样的调用，换一种方式或直接询问用户。`;
        this.send({ type: 'tool', status: 'denied', call, result, startedAt: Date.now() });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        return;
      }
      enteredSecrets = pickSecrets(answer?.secrets, secrets);
      if (answer?.rememberSecrets !== false) {
        // Memory-only, scoped to this workspace and target, expiring after two
        // hours: the same server is not asked twice, nothing touches disk.
        rememberSecrets(secretKey, enteredSecrets);
      }
      if (answer.remember && !decision.danger && tool.name === 'run_command') {
        this.rules.add(commandKey(String(args.command ?? '')));
      }
    }

    // Deletion is irreversible, so the user has to say yes twice. The first
    // card explains what will be deleted; this one asks for the final go-ahead.
    if (decision.doubleConfirm) {
      this.send({
        type: 'permission',
        call,
        summary: summarize(tool.name, args),
        reason: uiText.t('main.agent.confirmDeleteSecond'),
        danger: true,
        doubleConfirm: true,
      });
      let answer;
      try {
        answer = await this.wait(call.id);
      } catch (error) {
        this.send({
          type: 'tool',
          status: 'denied',
          call,
          result: uiText.t('main.agent.interrupted'),
          startedAt: Date.now(),
        });
        throw error;
      }
      if (!answer?.allow) {
        const note = String(answer?.note ?? '').trim();
        const result = `用户在第二次确认时取消了删除。${note ? `\n用户的说明：${note}` : ''}`;
        this.send({ type: 'tool', status: 'denied', call, result, startedAt: Date.now() });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        return;
      }
    }

    if (decision.action === 'review') {
      const command = String(args.command ?? '');
      const verdict = await this.reviewDangerous(command);
      if (!verdict.safe) {
        // 自动 mode has no standing approval for this, but it does not get to
        // end the task by itself: the reviewer's verdict goes to the user.
        this.send({
          type: 'permission',
          call,
          summary: summarize(tool.name, args),
          reason: uiText.t('main.agent.reviewRisk'),
          danger: true,
          reviewReason: verdict.reason,
        });
        let answer;
        try {
          answer = await this.wait(call.id);
        } catch (error) {
          this.send({
          type: 'tool',
          status: 'denied',
          call,
          result: uiText.t('main.agent.interrupted'),
          startedAt: Date.now(),
        });
          throw error;
        }

        if (!answer?.allow) {
          const note = String(answer?.note ?? '').trim();
          const result = `用户拒绝执行这条命令（独立 AI 评估：${verdict.reason}）。${note ? `\n用户的说明：${note}` : ''}\n不要重复同样的调用，换一种方式或直接询问用户。`;
          this.send({ type: 'tool', status: 'denied', call, result, startedAt: Date.now() });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
          return;
        }
      }
    }

    const runSecrets = { ...(cachedSecrets ?? {}), ...enteredSecrets };
    const missingSecret = secrets.find(
      (parameter) => parameter.required && !runSecrets[parameter.name],
    );

    const startedAt = Date.now();
    let result;
    let status = 'done';
    try {
      if (missingSecret) {
        throw new Error(uiText.t('main.agent.missingSecret', { name: missingSecret.name }));
      }
      const raw = await tool.run(
        {
          root: this.root,
          ws: this.ws,
          signal: this.controller.signal,
          webEnabled: this.webEnabled,
          webEntries: this.webEntries,
          autoInstallDeps: this.autoInstallDeps,
          toolScope: this.toolScope,
          toolContext: this.toolContext,
        },
        // A copy: call.args stays clean so the credential never lands in the
        // transcript, the session file or a replayed history.
        secrets.length > 0 ? { ...args, ...runSecrets } : args,
      );
      // 功能编辑 tools report a failed test as a normal result: the call ran,
      // but the step must still look failed so the user sees it in the list.
      if (raw && typeof raw === 'object' && typeof raw.content === 'string') {
        result = raw.content;
        if (raw.ok === false) status = 'error';
      } else {
        result = raw;
      }
    } catch (error) {
      status = 'error';
      result = `工具执行失败：${error?.message || String(error)}`;
    }
    // Whatever the remote side printed, a secret must not come back through
    // the tool result and into the model's context.
    if (secrets.length > 0) result = redactSecrets(result, runSecrets);

    const endedAt = Date.now();

    // Tick the plan off the moment the work actually finished, instead of
    // waiting for the model to re-submit the checklist a step later. The note
    // goes into the tool result so the model's next request sees the new state
    // without paying for an extra todo_write turn.
    if (tool.name !== 'todo_write') {
      const advanced = advanceTodos(this.todos, call, callSucceeded(tool.name, status, result));
      if (advanced.completed.length > 0) {
        this.todos = advanced.todos;
        const active = this.todos.find((todo) => todo.status === 'in_progress');
        result = `${String(result)}\n\n[待办自动更新] 已完成：${advanced.completed.join('、')}；${
          active ? `当前进行中：${active.content}` : '清单已全部完成'
        }。`;
        this.send({ type: 'todo', call, todos: this.todos });
      }
    }

    if (status === 'done' && tool.name === 'todo_write') {
      // A fresh plan must not undo automatic progress or leave no active item.
      this.todos = mergeTodos(this.todos, normalizeTodos(args));
      this.send({ type: 'todo', call, todos: this.todos });
    }
    this.send({
      type: 'tool',
      status,
      call,
      result: String(result).slice(0, UI_RESULT_LIMIT),
      startedAt,
      endedAt,
    });
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: String(result) });
  }

  /**
   * Level 0 has no person to ask, so a fresh model call with no task context
   * judges the command. It shows up as its own step so the user can see the
   * verdict and the reason afterwards; a "not safe" verdict then goes to the
   * user as a confirmation card instead of ending the task.
   */
  async reviewDangerous(command) {
    const reviewCall = {
      id: `review:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`,
      name: 'ai_review',
      args: { command },
    };
    const startedAt = Date.now();
    this.send({
      type: 'tool',
      status: 'running',
      call: reviewCall,
      summary: uiText.t('main.agent.reviewRunning'),
      startedAt,
    });

    let verdict;
    try {
      verdict = await reviewCommand({
        provider: this.provider,
        command,
        root: this.root,
        cwd: this.root,
        mode: this.mode,
        task: this.message,
        signal: this.controller.signal,
      });
      if (verdict.usage) this.onUsage?.({ feature: 'review', usage: verdict.usage });
    } catch (error) {
      if (error?.usage) this.onUsage?.({ feature: 'review', usage: error.usage });
      if (this.controller.signal.aborted) throw abortError();
      // A provider outage must not turn into a silent approval.
      verdict = {
        safe: false,
        reason: uiText.t('main.agent.reviewIncomplete', {
          error: error?.message || String(error),
        }),
      };
    }

    this.send({
      type: 'tool',
      status: 'done',
      call: reviewCall,
      summary: uiText.t(
        verdict.safe ? 'main.agent.reviewSafeSummary' : 'main.agent.reviewUnsafeSummary',
      ),
      result: uiText.t('main.agent.reviewResult', {
        verdict: verdict.safe
          ? uiText.t('main.agent.reviewVerdictSafe')
          : uiText.t('main.agent.reviewVerdictUnsafe'),
        reason: verdict.reason,
      }),
      startedAt,
      endedAt: Date.now(),
    });
    return verdict;
  }

  async askUser(call, messages) {
    const args = call.args ?? {};
    this.send({
      type: 'question',
      call,
      question: String(args.question ?? uiText.t('main.agent.askDefault')),
      options: Array.isArray(args.options) ? args.options.map(String).slice(0, 6) : [],
    });

    let answer;
    try {
      answer = await this.wait(call.id);
    } catch (error) {
      throw error;
    }

    const text = String(answer?.answer ?? '').trim();
    const result = text ? `用户回答：${text}` : '用户没有回答，请自行判断后继续。';
    this.send({
      type: 'tool',
      status: 'done',
      call,
      result,
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
  }
}

module.exports = {
  AgentRun,
  clearSecretCache,
  MAX_STEPS,
  PARALLEL_LIMIT,
  canRunConcurrently,
  runPool,
  compact,
  digest,
  isDigest,
  sizeOf,
  repair,
  callSucceeded,
};
