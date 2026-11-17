/**
 * User-defined tools.
 *
 * A definition lives in `<data root>/agent/custom-tools.json` and is compiled
 * into a normal registry tool: the model sees the name, description and JSON
 * schema, and the runner executes either an inline script or a command.
 *
 * Two execution modes:
 *
 *   - `runtime` is node / python: the user writes the
 *     program in the add/edit dialog. It is stored under
 *     `<data root>/agent/tools/<id>/main.<ext>` and run with the matching
 *     interpreter. Parameters arrive as JSON in EZNESS_TOOL_ARGS and, in
 *     declaration order, as plain argv values.
 *   - `runtime` is `executable`: the user supplies a command template. It is
 *     split into argv and spawned without a shell, so values the model supplies
 *     are never interpreted as shell syntax (`&`, `|`, `>` …). `{param}`
 *     placeholders are substituted in place.
 *
 * Scripts and commands both run as child processes with a confined working
 * directory; nothing is evaluated inside the Electron process.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveInside } = require('./paths');
const deps = require('./deps');

const FILE_NAME = 'custom-tools.json';
const CATEGORY_FILE = 'tool-categories.json';
const HEALTH_FILE = 'tool-health.json';
const TOOLS_DIR = 'tools';
const MAX_TOOLS = 100;
const MAX_CATEGORIES = 50;
const MAX_CATEGORY_NAME = 24;
/** The built-in group is not a stored category, so its names cannot be reused. */
const RESERVED_CATEGORY_NAMES = new Set(['内置能力', '内置功能']);
const MAX_PARAMETERS = 20;
/**
 * A tool is one file, and the PPT engine (every layout plus the template
 * reader) has outgrown 64 KB. Anything above this is still refused, so a
 * runaway paste still fails instead of being silently dropped.
 */
const MAX_SCRIPT = 128 * 1024;
const MAX_OUTPUT = 48 * 1024;
const PARAM_TYPES = new Set(['string', 'number', 'boolean']);
const MODE_KEYS = ['read-only', 'plan', 'workspace-write', 'danger-full-access'];
const POLICY_DECISIONS = new Set(['allow', 'ask', 'deny']);
const MODE_LABELS = {
  'read-only': '只读',
  plan: '计划',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
};
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
/** Total length allowed by NAME_RE; exported so importers can build a suffix. */
const MAX_TOOL_NAME = 64;
const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const RUNTIME_CACHE_MS = 60 * 1000;

const RUNTIMES = {
  node: {
    label: 'Node.js',
    ext: '.js',
    hint: '使用 Ezness 自带的 Node.js，不需要另外安装。',
  },
  python: {
    label: 'Python 3',
    ext: '.py',
    hint: '使用系统安装的 Python 3（优先 py 启动器），或数据目录 runtimes/python 里的便携版。',
  },
  executable: {
    label: '自定义命令',
    ext: '',
    hint: '直接运行任意可执行文件，参数用 {参数名} 替换。',
  },
};

const RUNTIME_DIR = 'runtimes';

/**
 * Where a portable interpreter may sit inside the data root. Checked before
 * the system PATH, so a copy of the program can carry its own Python and keep
 * working on a machine where none is installed.
 *
 *   <data root>/runtimes/python/python.exe        (Windows embeddable)
 *   <data root>/runtimes/python/bin/python3       (macOS / Linux)
 */
const PORTABLE_FILES = {
  python: ['python/python.exe', 'python/bin/python3', 'python/bin/python'],
};

/** Absolute candidate paths for a portable runtime, whether they exist or not. */
function portableRuntimeCandidates(root, runtime) {
  if (!root) return [];
  const relative = PORTABLE_FILES[runtime];
  if (!relative) return [];
  return relative.map((file) => path.join(path.resolve(root), RUNTIME_DIR, ...file.split('/')));
}

function exists(file) {
  try {
    return fsSync.statSync(file).isFile();
  } catch {
    return false;
  }
}

function filePath(agentDir) {
  return path.join(agentDir, FILE_NAME);
}

function clip(text, limit = MAX_OUTPUT) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（输出已截断，共 ${value.length} 字符）`;
}

/**
 * Split a command template into argv, honouring single and double quotes.
 * Inside double quotes `\"` is an escaped quote; every other backslash is kept
 * so Windows paths survive.
 */
function splitCommand(text) {
  const tokens = [];
  let current = '';
  let quote = '';
  let has = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (ch === '\\' && text[index + 1] === quote) {
        current += quote;
        index += 1;
        continue;
      }
      if (ch === quote) {
        quote = '';
        continue;
      }
      current += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        tokens.push(current);
        current = '';
        has = false;
      }
      continue;
    }
    current += ch;
    has = true;
  }

  if (quote) throw new Error('命令里的引号没有闭合。');
  if (has) tokens.push(current);
  return tokens;
}

function placeholdersOf(tokens) {
  const names = new Set();
  for (const token of tokens) {
    for (const match of token.matchAll(PLACEHOLDER_RE)) names.add(match[1]);
  }
  return names;
}

/**
 * Model-facing schema. Secret parameters are deliberately omitted: the model
 * never sees their names, so it can neither supply nor guess a credential. The
 * confirmation card collects them from the user instead.
 */
/**
 * Validate a declared default against the parameter's type.
 *
 * A default is what the script would fall back to anyway; the point of
 * declaring it is that the model can leave the argument out instead of
 * inventing `0` / `false` for it. A required parameter cannot have one.
 */
function normalizeDefault(value, type, name, required, errors) {
  if (value === undefined || value === null || required) return undefined;
  if (type === 'number') {
    const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (!Number.isFinite(number)) {
      errors.push(`参数 ${name} 的默认值必须是数字。`);
      return undefined;
    }
    return number;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    errors.push(`参数 ${name} 的默认值必须是 true 或 false。`);
    return undefined;
  }
  return typeof value === 'object' ? undefined : String(value);
}

/**
 * Fill in the defaults of the arguments the model left out.
 *
 * This is the single place that decides what a missing optional argument
 * means. `undefined`, `null` and the empty string all count as "not given";
 * an explicit `0` or `false` is kept, because a caller may well mean it.
 */
function applyArgDefaults(definition, supplied) {
  const args = { ...(supplied ?? {}) };
  for (const parameter of definition?.parameters ?? []) {
    if (parameter.secret || parameter.default === undefined) continue;
    const value = args[parameter.name];
    if (value === undefined || value === null || value === '') {
      args[parameter.name] = parameter.default;
    }
  }
  return args;
}

function schemaOf(parameters) {
  const properties = {};
  const required = [];
  for (const parameter of parameters) {
    if (parameter.secret) continue;
    const definition = { type: parameter.type };
    if (parameter.description) definition.description = parameter.description;
    if (parameter.default !== undefined) definition.default = parameter.default;
    properties[parameter.name] = definition;
    if (parameter.required) required.push(parameter.name);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Validate and normalise one definition. `others` are the other custom tools,
 * used for name collisions; `builtinNames` comes from the static registry.
 */
function normalizeDefinition(input, { builtinNames = [], others = [] } = {}) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};

  const name = String(source.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    errors.push('名称只能包含字母、数字和下划线，且以字母或下划线开头，最长 64 个字符。');
  } else if (builtinNames.includes(name)) {
    errors.push(`名称 ${name} 和内置工具重名。`);
  } else if (others.some((tool) => tool.name === name)) {
    errors.push(`名称 ${name} 已经被另一个自定义工具使用。`);
  }

  const description = String(source.description ?? '').trim();
  if (!description) errors.push('说明不能为空：模型要靠它判断什么时候调用这个功能。');
  else if (description.length > 4000) errors.push('说明最长 4000 个字符。');

  const category = String(source.category ?? '').trim().slice(0, 24) || '自定义';

  const rawParameters = Array.isArray(source.parameters) ? source.parameters : [];
  if (rawParameters.length > MAX_PARAMETERS) {
    errors.push(`参数最多 ${MAX_PARAMETERS} 个。`);
  }
  const parameters = [];
  const usedParams = new Set();
  for (const item of rawParameters.slice(0, MAX_PARAMETERS)) {
    const paramName = String(item?.name ?? '').trim();
    if (!NAME_RE.test(paramName)) {
      errors.push(`参数名 ${paramName || '（空）'} 不合法，只能用字母、数字和下划线。`);
      continue;
    }
    if (usedParams.has(paramName)) {
      errors.push(`参数名 ${paramName} 重复。`);
      continue;
    }
    usedParams.add(paramName);
    const type = PARAM_TYPES.has(item?.type) ? item.type : 'string';
    // A secret is a string the user types into the confirmation card (or a
    // file they pick). It is never part of the schema the model receives.
    const secret = Boolean(item?.secret);
    const required = Boolean(item?.required);
    // A default belongs to the model-facing surface; a secret is typed by the
    // user, so it never carries one.
    const fallback = secret
      ? undefined
      : normalizeDefault(item?.default, type, paramName, required, errors);
    parameters.push({
      name: paramName,
      type,
      required,
      description: String(item?.description ?? '').trim().slice(0, 500),
      // Declared here, not only in the prose description, so the model can
      // omit the argument instead of guessing a zero value for it.
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(secret
        ? { secret: true, secretKind: item?.secretKind === 'file' ? 'file' : 'text' }
        : {}),
    });
  }

  // Old definitions only had `command`; treat them as custom commands.
  const rawRuntime = String(source.runtime ?? '').trim();
  const runtime = rawRuntime || (String(source.script ?? '').trim() ? 'node' : 'executable');
  if (!RUNTIMES[runtime]) {
    errors.push('执行方式不合法，请选择 Node.js、Python 或自定义命令。');
  }

  const command = String(source.command ?? '').trim();
  const script = String(source.script ?? '');

  if (runtime === 'executable') {
    if (!command) {
      errors.push('执行命令不能为空。');
    } else if (command.length > 4000) {
      errors.push('执行命令最长 4000 个字符。');
    } else {
      try {
        const tokens = splitCommand(command);
        if (tokens.length === 0) errors.push('执行命令不能为空。');
        const used = placeholdersOf(tokens);
        for (const placeholder of used) {
          if (!usedParams.has(placeholder)) {
            errors.push(`命令里的 {${placeholder}} 没有对应的参数。`);
          }
        }
        // argv is visible to every process on the machine, so a credential
        // must never be substituted into the command line.
        for (const parameter of parameters) {
          if (parameter.secret && used.has(parameter.name)) {
            errors.push(`保密参数 ${parameter.name} 不能写进命令模板；请改用脚本方式读取。`);
          }
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
  } else if (RUNTIMES[runtime]) {
    if (!script.trim()) {
      errors.push('脚本内容不能为空。');
    } else if (script.length > MAX_SCRIPT) {
      errors.push('脚本最长 64 KB。');
    } else if (script.includes('\u0000')) {
      errors.push('脚本不能包含空字符。');
    }
  }

  // Third-party packages the script imports. They are installed automatically;
  // the person describing the tool never has to run pip or npm by hand.
  const dependencyResult = deps.normalizeDependencies(runtime, source.dependencies);
  for (const error of dependencyResult.errors) errors.push(error);
  const dependencies = dependencyResult.specs;

  const cwd = String(source.cwd ?? '').trim();
  if (cwd && path.isAbsolute(cwd)) {
    errors.push('运行目录请填写相对工作空间的路径。');
  }

  const timeoutValue = Number(source.timeoutMs ?? 120000);
  if (!Number.isFinite(timeoutValue)) errors.push('超时时间必须是数字。');
  const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutValue) ? timeoutValue : 120000, 1000), 300000);

  // Custom tools may modify files, so they can carry an explicit matrix.
  // Missing policy keeps the older derived behaviour.
  let policy;
  if (source.policy !== undefined && source.policy !== null) {
    if (typeof source.policy !== 'object' || Array.isArray(source.policy)) {
      errors.push('权限策略格式不正确。');
    } else {
      policy = {};
      for (const mode of MODE_KEYS) {
        const value = source.policy[mode];
        if (POLICY_DECISIONS.has(value)) policy[mode] = value;
        else errors.push(`权限策略里的「${MODE_LABELS[mode]}」不合法。`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, definition: null };

  return {
    ok: true,
    errors: [],
    definition: {
      id: String(source.id ?? '').trim() || crypto.randomUUID(),
      name,
      description,
      category,
      runtime,
      script: runtime === 'executable' ? '' : script,
      command: runtime === 'executable' ? command : '',
      cwd,
      timeoutMs,
      readOnly: Boolean(source.readOnly),
      network: Boolean(source.network),
      dependencies,
      ...(policy ? { policy } : {}),
      parameters,
    },
  };
}

function substitute(tokens, args) {
  return tokens.map((token) =>
    token.replace(PLACEHOLDER_RE, (_match, name) =>
      args[name] === undefined || args[name] === null ? '' : String(args[name]),
    ),
  );
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function runProcess(argv, { cwd, timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`无法启动命令：${error?.message || String(error)}`));
      return;
    }

    let output = '';
    let settled = false;
    let stoppedBy = '';
    let stopTimer = null;

    const append = (chunk) => {
      if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const body = () => {
      const text = clip(output.trim());
      return text ? `\n${text}` : '';
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const onAbort = () => stop('用户中断');
    const stop = (reason) => {
      if (stoppedBy) return;
      stoppedBy = reason;
      killTree(child);
      stopTimer = setTimeout(() => {
        finish(new Error(`命令被${stoppedBy}终止。${body()}`));
      }, 1500);
    };

    const timer = setTimeout(() => {
      stop(`超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }, timeoutMs);

    if (signal?.aborted) {
      stop('用户中断');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      finish(new Error(`无法启动命令：${error?.message || String(error)}`));
    });
    child.on('close', (code) => {
      if (stoppedBy) {
        finish(new Error(`命令被${stoppedBy}终止。${body()}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`命令退出码 ${code}。${body()}`));
        return;
      }
      finish(null, output.trim() ? clip(output.trim()) : '（没有输出）');
    });
  });
}

/**
 * Where inline scripts live. The directory name is derived from the id and
 * stripped of anything that could escape `agent/tools`.
 */
function safeDirName(id) {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned;
  return crypto.createHash('sha1').update(String(id ?? '')).digest('hex').slice(0, 16);
}

function scriptPathFor(agentDir, definition) {
  const runtime = RUNTIMES[definition.runtime];
  return path.join(agentDir, TOOLS_DIR, safeDirName(definition.id), `main${runtime.ext}`);
}

async function ensureScriptFile(agentDir, definition) {
  if (!agentDir) throw new Error('没有找到自定义功能的存储目录。');
  const file = scriptPathFor(agentDir, definition);
  const payload = definition.script;

  await fs.mkdir(path.dirname(file), { recursive: true });
  let current = null;
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    /* first save */
  }
  if (current !== payload) {
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, payload, 'utf8');
    await fs.rename(temp, file);
  }
  return file;
}

async function removeToolFiles(agentDir, id) {
  try {
    await fs.rm(path.join(agentDir, TOOLS_DIR, safeDirName(id)), {
      recursive: true,
      force: true,
    });
  } catch {
    /* nothing to remove */
  }
}

/* ------------------------------------------------------------------ */
/* Runtime discovery                                                   */
/* ------------------------------------------------------------------ */

function runProbe(argv, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      });
    } catch {
      resolve({ ok: false, output: '' });
      return;
    }

    let output = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok, output: output.trim() });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(false);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (output.length < 4096) output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (output.length < 4096) output += chunk.toString('utf8');
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function whereCommand() {
  return process.platform === 'win32' ? 'where.exe' : 'which';
}

async function whichAll(name) {
  const result = await runProbe([whereCommand(), name], 2500);
  if (!result.ok) return [];
  return result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isStoreAlias(file) {
  return /[\\/]WindowsApps[\\/]/i.test(file);
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

async function probePortable(runtime, args) {
  for (const file of portableRuntimeCandidates(runtimeRoot, runtime)) {
    if (!exists(file)) continue;
    const probe = await runProbe([file, ...args]);
    if (probe.ok) {
      return {
        command: file,
        prefix: [],
        version: firstLine(probe.output),
        detail: file,
        source: 'portable',
      };
    }
  }
  return null;
}

async function detectPython() {
  const portable = await probePortable('python', ['--version']);
  if (portable) return portable;

  const pyFiles = (await whichAll('py')).filter((file) => !isStoreAlias(file));
  if (pyFiles.length > 0) {
    const probe = await runProbe(['py', '-3', '--version']);
    if (probe.ok) {
      return {
        command: 'py',
        prefix: ['-3'],
        version: firstLine(probe.output),
        detail: pyFiles[0],
        source: 'system',
      };
    }
  }

  for (const name of ['python3', 'python']) {
    const files = (await whichAll(name)).filter((file) => !isStoreAlias(file));
    if (files.length === 0) continue;
    const probe = await runProbe([name, '--version']);
    if (probe.ok) {
      return {
        command: name,
        prefix: [],
        version: firstLine(probe.output),
        detail: files[0],
        source: 'system',
      };
    }
  }

  return null;
}

let runtimeCache = { at: 0, rows: null };
/** Data root used to look for portable interpreters; set once at startup. */
let runtimeRoot = '';

/**
 * Point runtime discovery at a data root. Called by main after the storage
 * root is known; also used by tests. A different root invalidates the cache.
 */
function setRuntimeRoot(root) {
  const next = String(root ?? '').trim();
  if (next === runtimeRoot) return;
  runtimeRoot = next;
  runtimeCache = { at: 0, rows: null };
}

/**
 * What the add/edit dialog shows in the 语言 select. `meta` is the resolved
 * interpreter used by runCustom; it stays on this machine.
 */
async function detectRuntimes({ force = false } = {}) {
  if (!force && runtimeCache.rows && Date.now() - runtimeCache.at < RUNTIME_CACHE_MS) {
    return runtimeCache.rows;
  }

  const python = await detectPython();

  const rows = [
    {
      id: 'node',
      label: RUNTIMES.node.label,
      available: true,
      version: process.versions.node,
      detail: 'Ezness 内置',
      hint: RUNTIMES.node.hint,
      source: 'builtin',
      meta: { command: process.execPath, prefix: [] },
    },
    {
      id: 'python',
      label: RUNTIMES.python.label,
      available: Boolean(python),
      version: python?.version ?? '',
      detail: python?.detail ?? '',
      source: python?.source ?? '',
      hint: python
        ? RUNTIMES.python.hint
        : '没有找到 Python 3。安装 Python 并勾选“Add to PATH”，或把便携版放到 <数据目录>/runtimes/python/python.exe。',
      meta: python ? { command: python.command, prefix: python.prefix } : null,
    },
    {
      id: 'executable',
      label: RUNTIMES.executable.label,
      available: true,
      version: '',
      detail: '由你填写',
      hint: RUNTIMES.executable.hint,
      source: '',
      meta: null,
    },
  ];

  runtimeCache = { at: Date.now(), rows };
  return rows;
}

async function resolveRuntime(runtime) {
  const rows = await detectRuntimes();
  const row = rows.find((item) => item.id === runtime);
  if (!row || !row.available || !row.meta) {
    throw new Error(
      `${RUNTIMES[runtime]?.label ?? runtime} 不可用。${row?.hint ?? '请换一种执行方式。'}`,
    );
  }
  return { ...row.meta, source: row.source };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

function scriptInvocation(runtime, file, meta, args) {
  const values = args.map((value) => (value === undefined || value === null ? '' : String(value)));
  if (runtime === 'python') {
    return [meta.command, ...meta.prefix, '-u', file, ...values];
  }
  // node
  return [meta.command, ...meta.prefix, file, ...values];
}

async function runCustom(ctx, definition, args = {}, agentDir = '') {
  if (definition.network && ctx.webEnabled === false) {
    throw new Error('联网开关没有打开，不能调用这个功能。');
  }

  for (const parameter of definition.parameters) {
    // Secrets are collected from the user, never from the model; a missing one
    // is reported by the permission step, not here.
    if (!parameter.required || parameter.secret) continue;
    const value = args[parameter.name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`缺少必填参数 ${parameter.name}`);
    }
  }

  const cwd = definition.cwd ? await resolveInside(ctx.root, definition.cwd) : ctx.root;
  // One resolution step, shared with the smoke test: a declared default is
  // what the script would use anyway, so it must reach both the env payload
  // and the positional argv. Leaving the slot empty made scripts read `0`.
  const resolved = applyArgDefaults(definition, args);
  const env = {
    ...process.env,
    ...(definition.runtime === 'python' ? deps.pythonPathEnv(ctx.root) : {}),
    ELECTRON_RUN_AS_NODE: '',
    EZNESS_TOOL_NAME: definition.name,
    EZNESS_TOOL_RUNTIME: definition.runtime,
    EZNESS_TOOL_ARGS: JSON.stringify(resolved),
  };

  let argv;
  let meta = null;
  let runEnv = env;
  if (definition.runtime === 'executable') {
    const tokens = splitCommand(definition.command);
    // A secret on the command line is readable by every process on the
    // machine, and a substituted template would put it there.
    const placeholders = placeholdersOf(tokens);
    const leaked = definition.parameters.find(
      (parameter) => parameter.secret && placeholders.has(parameter.name),
    );
    if (leaked) {
      throw new Error(`参数 ${leaked.name} 是保密参数，不能写进自定义命令模板。`);
    }
    argv = substitute(tokens, resolved);
    if (argv.length === 0 || !argv[0]) throw new Error('执行命令为空。');
  } else {
    meta = await resolveRuntime(definition.runtime);
    const file = await ensureScriptFile(agentDir, definition);
    // Secrets travel in EZNESS_TOOL_ARGS only: argv is visible to other local
    // processes through the process list.
    argv = scriptInvocation(
      definition.runtime,
      file,
      meta,
      definition.parameters
        .filter((parameter) => !parameter.secret)
        .map((parameter) => resolved[parameter.name]),
    );

    if (definition.runtime === 'node') {
      // electron.exe acts as plain Node when this flag is set for the child.
      env.ELECTRON_RUN_AS_NODE = '1';
    } else if (definition.runtime === 'python') {
      env.PYTHONUTF8 = '1';
      env.PYTHONIOENCODING = 'utf-8';
      env.PYTHONUNBUFFERED = '1';
      // The bundled interpreter is its own world: do not import packages the
      // user happened to install into the machine's per-user site folder.
      if (meta.source === 'portable') env.PYTHONNOUSERSITE = '1';
    }

    if (definition.dependencies?.length > 0 && ctx.autoInstallDeps !== false) {
      const installed = await ensureDeclaredDependencies(ctx, definition, agentDir, meta);
      if (!installed.ok) {
        throw new Error(
          `依赖安装失败（${definition.dependencies.join('、')}）：${installed.error}`,
        );
      }
      if (definition.runtime === 'python' && installed.pythonPath) {
        runEnv = deps.withPythonPath(env, installed.pythonPath);
      }
    }
  }

  try {
    return await runProcess(argv, {
      cwd,
      timeoutMs: definition.timeoutMs,
      signal: ctx.signal,
      env: runEnv,
    });
  } catch (error) {
    // The script imported a package its definition did not mention. Install it
    // once and retry, so a tool that works in testing does not fail on a fresh
    // machine just because the manifest was incomplete.
    if (ctx.autoInstallDeps === false || definition.runtime === 'executable') throw error;
    const specs = deps.missingModules(definition.runtime, error?.message);
    if (specs.length === 0) throw error;
    const installed = await deps.ensureDependencies({
      root: ctx.root,
      agentDir,
      runtime: definition.runtime,
      specs,
      pythonMeta: meta,
    });
    if (!installed.ok) {
      throw new Error(`${error.message}\n\n自动安装依赖失败（${specs.join('、')}）：${installed.error}`);
    }
    const retryEnv =
      definition.runtime === 'python' && installed.pythonPath
        ? deps.withPythonPath(runEnv, installed.pythonPath)
        : runEnv;
    const output = await runProcess(argv, {
      cwd,
      timeoutMs: definition.timeoutMs,
      signal: ctx.signal,
      env: retryEnv,
    });
    return `已自动安装依赖：${installed.installed.join('、')}\n${output}`;
  }
}

/** Install declared packages once per definition/version set, then remember it. */
const readyDependencies = new Set();

async function ensureDeclaredDependencies(ctx, definition, agentDir, meta) {
  const key = `${definition.id}:${definition.dependencies.join(',')}`;
  if (readyDependencies.has(key)) return { ok: true, pythonPath: '' };
  const result = await deps.ensureDependencies({
    root: ctx.root,
    agentDir,
    runtime: definition.runtime,
    specs: definition.dependencies,
    pythonMeta: meta,
  });
  if (result.ok) readyDependencies.add(key);
  return result;
}

/**
 * Definitions that may enter the registry. A broken tool stays in the file and
 * in the UI, but the model must never see it: that is what keeps a syntax error
 * in one tool from taking the whole app down.
 */
function enabledForRegistry(definitions, health = {}) {
  return (definitions ?? []).filter(
    (definition) => health?.[definition.id]?.status !== 'broken',
  );
}

function compileDefinitions(definitions, agentDir = '') {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    category: definition.category,
    parameters: schemaOf(definition.parameters),
    readOnly: definition.readOnly,
    network: definition.network,
    policy: definition.policy,
    custom: true,
    definition,
    run: (ctx, args) => runCustom(ctx, definition, args ?? {}, agentDir),
  }));
}

async function loadDefinitions(agentDir, builtinNames = []) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath(agentDir), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tools) ? parsed.tools : [];
  const definitions = [];
  for (const item of list) {
    const { ok, definition } = normalizeDefinition(item, {
      builtinNames,
      others: definitions,
    });
    if (ok) definitions.push(definition);
    if (definitions.length >= MAX_TOOLS) break;
  }
  return definitions;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

function categoriesPath(agentDir) {
  return path.join(agentDir, CATEGORY_FILE);
}

/**
 * Category names double as the `category` value on tools, so they are kept to
 * a short, filesystem-safe label and compare case-insensitively.
 */
function normalizeCategoryName(raw) {
  const name = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_CATEGORY_NAME);
  if (!name) return { ok: false, error: '分类名称不能为空。' };
  if (RESERVED_CATEGORY_NAMES.has(name)) {
    return { ok: false, error: `「${name}」是内置能力分类，不能再建同名分类。` };
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    return { ok: false, error: '分类名称不能包含 \\ / : * ? " < > |。' };
  }
  return { ok: true, name };
}

function normalizeCategoryRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const parsed = normalizeCategoryName(item.name);
  if (!parsed.ok) return null;
  const id = String(item.id ?? '').trim().slice(0, 64) || crypto.randomUUID();
  return { id, name: parsed.name, pinned: Boolean(item.pinned) };
}

/** Keep first occurrence of each name, at most MAX_CATEGORIES. */
function dedupeCategories(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const record = normalizeCategoryRecord(item);
    if (!record) continue;
    const key = record.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/**
 * Read `<data root>/agent/tool-categories.json`. Tools saved before categories
 * existed only carry a `category` string, so any such names are imported as
 * ordinary categories and written back.
 */
async function loadCategories(agentDir, definitions = []) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(categoriesPath(agentDir), 'utf8'));
  } catch {
    parsed = [];
  }
  const stored = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.categories)
      ? parsed.categories
      : [];
  const categories = dedupeCategories(stored);
  const seen = new Set(categories.map((item) => item.name.toLowerCase()));
  let changed = categories.length !== stored.length;

  for (const definition of definitions) {
    const parsedName = normalizeCategoryName(definition.category);
    if (!parsedName.ok) continue;
    const key = parsedName.name.toLowerCase();
    if (seen.has(key) || categories.length >= MAX_CATEGORIES) continue;
    seen.add(key);
    categories.push({ id: crypto.randomUUID(), name: parsedName.name, pinned: false });
    changed = true;
  }

  if (changed) await saveCategories(agentDir, categories).catch(() => undefined);
  return categories;
}

async function saveCategories(agentDir, categories) {
  await fs.mkdir(agentDir, { recursive: true });
  const file = categoriesPath(agentDir);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(categories, null, 2), 'utf8');
  await fs.rename(temp, file);
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

const HEALTH_STATUSES = new Set(['ok', 'broken', 'untested']);
const HEALTH_PHASES = new Set(['schema', 'syntax', 'test', 'runtime']);

function healthPath(agentDir) {
  return path.join(agentDir, HEALTH_FILE);
}

/**
 * Read `<data root>/agent/tool-health.json`. The file only carries results the
 * app wrote itself, so anything malformed is dropped rather than trusted. A
 * missing file means every tool is treated as healthy (older data).
 */
async function loadHealth(agentDir) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(healthPath(agentDir), 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const status = HEALTH_STATUSES.has(value.status) ? value.status : 'ok';
    const errors = Array.isArray(value.errors)
      ? value.errors
          .filter((item) => item && typeof item === 'object')
          .slice(0, 8)
          .map((item) => ({
            phase: HEALTH_PHASES.has(item.phase) ? item.phase : 'test',
            message: String(item.message ?? '').slice(0, 4000),
            ...(item.detail ? { detail: String(item.detail).slice(0, 8000) } : {}),
          }))
      : [];
    out[id] = {
      status,
      errors,
      ...(Number.isFinite(value.testedAt) ? { testedAt: value.testedAt } : {}),
      ...(value.testArgs && typeof value.testArgs === 'object' ? { testArgs: value.testArgs } : {}),
      ...(value.exitCode === null || Number.isFinite(value.exitCode)
        ? { exitCode: value.exitCode }
        : {}),
      ...(value.stdout ? { stdout: String(value.stdout).slice(0, 8000) } : {}),
      ...(value.stderr ? { stderr: String(value.stderr).slice(0, 8000) } : {}),
    };
  }
  return out;
}

async function saveHealth(agentDir, health) {
  await fs.mkdir(agentDir, { recursive: true });
  const file = healthPath(agentDir);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(health ?? {}, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function saveDefinitions(agentDir, definitions) {
  await fs.mkdir(agentDir, { recursive: true });

  // Write every inline script first: if one fails, the JSON is left untouched.
  for (const definition of definitions) {
    if (definition.runtime !== 'executable') {
      await ensureScriptFile(agentDir, definition);
    }
  }

  const file = filePath(agentDir);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(definitions, null, 2), 'utf8');
  await fs.rename(temp, file);
}

module.exports = {
  MAX_TOOLS,
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  MAX_TOOL_NAME,
  MAX_SCRIPT,
  RUNTIMES,
  loadDefinitions,
  saveDefinitions,
  loadHealth,
  saveHealth,
  normalizeCategoryName,
  loadCategories,
  saveCategories,
  normalizeDefinition,
  applyArgDefaults,
  enabledForRegistry,
  compileDefinitions,
  splitCommand,
  detectRuntimes,
  resolveRuntime,
  runCustom,
  setRuntimeRoot,
  portableRuntimeCandidates,
  removeToolFiles,
  scriptPathFor,
  ensureScriptFile,
};
