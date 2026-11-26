/**
 * Read-only description of the local tool registry, plus usage counters
 * gathered from the session logs.
 *
 * The AI能力 page renders this so the user can see exactly which functions
 * the model may call, what each one needs, and how the permission policy
 * treats it in every mode. Nothing here executes a tool.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const { allTools } = require('./tools');
const { decide } = require('./policy');
const uiText = require('../ui-text');

const MODE_KEYS = ['read-only', 'plan', 'workspace-write', 'danger-full-access'];
const MODE_LABEL_KEYS = {
  'read-only': 'main.policy.modeReadOnly',
  plan: 'main.policy.modePlan',
  'workspace-write': 'main.policy.modeWorkspaceWrite',
  'danger-full-access': 'main.policy.modeDangerFullAccess',
};
const DECISION_LABEL_KEYS = {
  allow: 'main.tool.decisionAllow',
  ask: 'main.tool.decisionAsk',
  deny: 'main.tool.decisionDeny',
};

const CATEGORY = {
  list_files: '文件读取',
  read_file: '文件读取',
  read_many: '文件读取',
  glob_search: '文件读取',
  grep_search: '文件读取',
  write_file: '文件修改',
  edit_file: '文件修改',
  run_command: '命令执行',
  smoke_check: '命令执行',
  todo_write: '任务管理',
  web_search: '联网',
  web_search_many: '联网',
  web_fetch: '联网',
  ask_user: '人机交互',
};

const CATEGORY_ORDER = ['文件读取', '文件修改', '命令执行', '任务管理', '联网', '人机交互'];

/**
 * Where a built-in tool actually executes. Built-ins are view-only in the UI,
 * but the page should still say which process model runs them and which fixed
 * limits shape their behaviour — otherwise "查看配置" looks like a form with
 * its engine missing.
 */
const IMPLEMENTATION = {
  list_files: {
    file: 'electron/agent/tools.js',
    fn: 'listFiles',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.listDepth'),
      uiText.t('main.tool.limit.skipDirs'),
      uiText.t('main.tool.limit.listLines'),
    ],
  },
  read_file: {
    file: 'electron/agent/tools.js',
    fn: 'readFile',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.readSize'),
      uiText.t('main.tool.limit.readLines'),
      uiText.t('main.tool.limit.pathJail'),
      uiText.t('main.tool.limit.binaryRead'),
    ],
  },
  glob_search: {
    file: 'electron/agent/tools.js',
    fn: 'globSearch',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.globScan'),
      uiText.t('main.tool.limit.globMatches'),
      uiText.t('main.tool.limit.skipDeps'),
    ],
  },
  grep_search: {
    file: 'electron/agent/tools.js',
    fn: 'grepSearch',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.grepResults'),
      uiText.t('main.tool.limit.grepSize'),
      uiText.t('main.tool.limit.grepChars'),
    ],
  },
  write_file: {
    file: 'electron/agent/tools.js',
    fn: 'writeFile',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.writeSize'),
      uiText.t('main.tool.limit.autoParent'),
      uiText.t('main.tool.limit.pathJail'),
    ],
  },
  edit_file: {
    file: 'electron/agent/tools.js',
    fn: 'editFile',
    process: () => uiText.t('main.tool.impl.inProcess'),
    limits: () => [
      uiText.t('main.tool.limit.oldStringUnique'),
      uiText.t('main.tool.limit.pathJail'),
    ],
  },
  run_command: {
    file: 'electron/agent/tools.js',
    fn: 'runCommand',
    process: () => uiText.t('main.tool.impl.shell'),
    limits: () => [
      uiText.t('main.tool.limit.commandTimeout'),
      uiText.t('main.tool.limit.outputSize'),
      uiText.t('main.tool.limit.commandCwd'),
      uiText.t('main.tool.limit.destructiveGate'),
    ],
  },
  smoke_check: {
    file: 'electron/agent/tools.js',
    fn: 'smokeCheck',
    process: () => uiText.t('main.tool.impl.smoke'),
    limits: () => [
      uiText.t('main.tool.limit.smokeLocal'),
      uiText.t('main.tool.limit.smokeWaits'),
      uiText.t('main.tool.limit.smokeRequests'),
      uiText.t('main.tool.limit.smokeFeatures'),
    ],
  },
  todo_write: {
    file: 'electron/agent/tools.js',
    fn: 'todoWrite',
    process: () => uiText.t('main.tool.impl.todo'),
    limits: () => [uiText.t('main.tool.limit.todoCount'), uiText.t('main.tool.limit.todoChars')],
  },
  web_search: {
    file: 'electron/agent/tools.js',
    fn: 'webSearchTool',
    process: () => uiText.t('main.tool.impl.webSearch'),
    limits: () => [uiText.t('main.tool.limit.webOn'), uiText.t('main.tool.limit.webResults')],
  },
  web_fetch: {
    file: 'electron/agent/tools.js',
    fn: 'webFetchTool',
    process: () => uiText.t('main.tool.impl.webFetch'),
    limits: () => [
      uiText.t('main.tool.limit.fetchSize'),
      uiText.t('main.tool.limit.fetchChars'),
      uiText.t('main.tool.limit.fetchTimeout'),
      uiText.t('main.tool.limit.webOn'),
    ],
  },
  ask_user: {
    file: 'electron/agent/tools.js',
    fn: 'askUser',
    process: () => uiText.t('main.tool.impl.askUser'),
    limits: () => [uiText.t('main.tool.limit.askEveryMode'), uiText.t('main.tool.limit.askOptions')],
  },
};

/** Materialise the display-only implementation strings in the current language. */
function implementationOf(name) {
  const entry = IMPLEMENTATION[name];
  if (!entry) return null;
  return {
    file: entry.file,
    fn: entry.fn,
    process: entry.process(),
    limits: entry.limits(),
  };
}

/** Same shape as the schema, flattened for display. */
function parametersOf(schema) {
  const properties = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, definition]) => {
    const type =
      definition?.type === 'array'
        ? `array${definition.items?.type ? `<${definition.items.type}>` : ''}`
        : String(definition?.type ?? 'any');
    return {
      name,
      type,
      required: required.has(name),
      description: String(definition?.description ?? ''),
      values: Array.isArray(definition?.enum) ? definition.enum.map(String) : null,
    };
  });
}

/**
 * Ask the real policy for each mode, with empty args. That keeps the page in
 * step with decide() instead of duplicating its rules. run_command resolves to
 * "ask" here because an empty command is not on the safe list; the page's note
 * explains that recognised commands run automatically.
 */
function policyMatrix(tool) {
  const row = {};
  for (const mode of MODE_KEYS) {
    row[mode] = decide({ tool, args: {}, mode, root: '' }).action;
  }
  return row;
}

function policyNote(tool) {
  if (tool.interactive) return uiText.t('main.tool.note.always');
  if (tool.custom) {
    if (!tool.readOnly && tool.policy) {
      const parts = MODE_KEYS.map(
        (mode) =>
          `${uiText.t(MODE_LABEL_KEYS[mode])} ${
            DECISION_LABEL_KEYS[tool.policy[mode]]
              ? uiText.t(DECISION_LABEL_KEYS[tool.policy[mode]])
              : uiText.t('main.tool.decisionAllow')
          }`,
      );
      return uiText.t('main.tool.note.customPolicy', {
        parts: parts.join(' · '),
        network: tool.network ? uiText.t('main.tool.note.networkRequired') : '',
      });
    }
    if (tool.network) {
      return tool.readOnly
        ? uiText.t('main.tool.note.customNetworkReadOnly')
        : uiText.t('main.tool.note.customNetwork');
    }
    return tool.readOnly
      ? uiText.t('main.tool.note.customReadOnly')
      : uiText.t('main.tool.note.customWrite');
  }
  if (tool.network) return uiText.t('main.tool.note.network');
  if (tool.readOnly) return uiText.t('main.tool.note.readOnly');
  if (tool.name === 'run_command') {
    return uiText.t('main.tool.note.runCommand');
  }
  if (tool.name === 'write_file' || tool.name === 'edit_file') {
    return uiText.t('main.tool.note.fileWrite');
  }
  return tool.readOnly === false
    ? uiText.t('main.tool.note.mutating')
    : uiText.t('main.tool.note.auto');
}

function emptyStats() {
  return { calls: 0, errors: 0, denied: 0, interrupted: 0, lastUsed: 0 };
}

/**
 * Built-in categories in display order, each with the built-in tool names it
 * covers. Used by the Agent editor prompt/tools so a category can be described
 * precisely without loading the whole capability snapshot.
 */
function builtinCategorySummary() {
  const groups = new Map(CATEGORY_ORDER.map((name) => [name, []]));
  for (const tool of allTools()) {
    if (tool.custom) continue;
    const name = String(tool.category ?? CATEGORY[tool.name] ?? '');
    if (groups.has(name)) groups.get(name).push(tool.name);
  }
  return [...groups].map(([name, tools]) => ({ name, tools }));
}

/**
 * Count tool calls from `<sessions>/*.jsonl`. A call is an entry in an
 * assistant row's `toolCalls`; its result is the following tool row with the
 * same `toolCallId`, and the result prefix tells success from failure.
 */
async function collectStats(dir) {
  const byName = new Map();
  const totals = { calls: 0, errors: 0, denied: 0, interrupted: 0, sessions: 0 };

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { byName, totals };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
    totals.sessions += 1;

    let text;
    let mtime = 0;
    try {
      const file = path.join(dir, entry.name);
      const [body, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      text = body;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }

    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        /* a torn last line from a crash — skip */
      }
    }

    const results = new Map();
    for (const row of rows) {
      if (row.role === 'tool' && row.toolCallId) results.set(row.toolCallId, row);
    }

    for (const row of rows) {
      if (row.role !== 'assistant' || !Array.isArray(row.toolCalls)) continue;
      for (const call of row.toolCalls) {
        const name = String(call?.name ?? '');
        if (!name) continue;
        const stats = byName.get(name) ?? emptyStats();
        stats.calls += 1;
        stats.lastUsed = Math.max(stats.lastUsed, mtime);

        const result = results.get(call.id);
        const content = String(result?.content ?? '').trim();
        if (content.startsWith('工具执行失败：')) stats.errors += 1;
        else if (content.startsWith('操作被拒绝：') || content.startsWith('用户拒绝了这次操作。')) {
          stats.denied += 1;
        } else if (content.startsWith('（这一步被中断')) stats.interrupted += 1;

        byName.set(name, stats);
      }
    }
  }

  for (const stats of byName.values()) {
    totals.calls += stats.calls;
    totals.errors += stats.errors;
    totals.denied += stats.denied;
    totals.interrupted += stats.interrupted;
  }

  return { byName, totals };
}

async function describeCapabilities(sessionDir) {
  const { byName, totals } = await collectStats(sessionDir);

  const tools = allTools().map((tool) => {
    const stats = byName.get(tool.name) ?? emptyStats();
    return {
      name: tool.name,
      description: String(tool.description ?? ''),
      category: String(tool.category ?? CATEGORY[tool.name] ?? '自定义'),
      custom: Boolean(tool.custom),
      readOnly: Boolean(tool.readOnly),
      network: Boolean(tool.network),
      interactive: Boolean(tool.interactive),
      parameters: parametersOf(tool.parameters),
      policy: policyMatrix(tool),
      policyNote: policyNote(tool),
      command: tool.custom ? String(tool.definition?.command ?? '') : '',
      runtime: tool.custom ? String(tool.definition?.runtime ?? 'executable') : '',
      cwd: tool.custom ? String(tool.definition?.cwd ?? '') : '',
      timeoutMs: tool.custom ? Number(tool.definition?.timeoutMs ?? 0) : 0,
      implementation: tool.custom ? null : implementationOf(tool.name),
      stats: {
        calls: stats.calls,
        errors: stats.errors,
        denied: stats.denied,
        interrupted: stats.interrupted,
      },
    };
  });

  // Built-in groups keep their order; custom categories follow in first-seen
  // order after the built-in ones.
  const preferred = CATEGORY_ORDER.filter((name) => tools.some((tool) => tool.category === name));
  const extras = [...new Set(tools.map((tool) => tool.category))].filter(
    (name) => !CATEGORY_ORDER.includes(name),
  );

  return {
    tools,
    categories: [...preferred, ...extras],
    modes: MODE_KEYS,
    totals: { tools: tools.length, ...totals },
  };
}

module.exports = { describeCapabilities, builtinCategorySummary, CATEGORY_ORDER };
