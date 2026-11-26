/**
 * Permission policy.
 *
 * ClawCode models permissions as "the minimum level a tool needs" versus "the
 * level the session granted". This is the same idea with one addition that a
 * CLI cannot offer: an `ask` decision is handed to the UI, so the user sees the
 * exact file or command and answers in place instead of choosing a mode up
 * front and hoping.
 *
 *   read-only        reads only; edits and commands are refused
 *   workspace-write  reads + edits inside the workspace; everyday development
 *                    commands (build, test, search, git status) just run, and
 *                    only unknown, destructive or out-of-workspace commands ask
 *   danger-full-access  everything runs without asking (explicit opt-in)
 *
 * The ask level (0 自动 … 3 常规) decides how often the `ask` decisions are
 * shown. Level 0 does not simply run dangerous commands: it returns `review`,
 * and the loop hands the command to an independent model instead (see
 * reviewer.js); when that review says no, the user decides. Reading a file
 * outside the workspace is not "danger" — only commands that could change
 * something out there are.
 */

const path = require('node:path');
const uiText = require('../ui-text');

const MODES = new Set(['read-only', 'plan', 'workspace-write', 'danger-full-access']);

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|[a-z]:\\)/i,
  /\b(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?(?:\s|$)/i,
  /\b(del|erase)\s+(?:\/[a-z]\s+)*[a-z]:\\/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bshutdown\s+(-|\/)/i,
  /\breg\s+delete\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
  /\bcargo\s+publish\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

function isDestructive(command) {
  return DESTRUCTIVE.some((pattern) => pattern.test(command));
}

/**
 * Shell commands can walk out of the workspace even though file tools cannot.
 * Flag a command that mentions an absolute path outside the root, or starts
 * with `cd ..`, so the confirmation card can say so instead of playing it down.
 */
function looksEscaping(command, root) {
  if (!root) return false;
  const base = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase();
  const insideBase = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
    return resolved === base || resolved.startsWith(`${base}\\`) || resolved.startsWith(`${base}/`);
  };

  // A URL such as https://example.com looks like a drive path ("s:/...") to a
  // naive matcher, so strip URLs before looking for Windows absolute paths.
  const withoutUrls = command.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>|&;]+/gi, ' ');
  const absolute = withoutUrls.match(/[a-z]:[\\/][^\s"'|&;<>]*/gi) ?? [];
  if (absolute.some((token) => !insideBase(token))) return true;

  return /(^|[\s;&|])cd\s+(\.\.[\\/]?|\.\.[\\/])/i.test(command);
}

/**
 * Everyday development commands. In workspace-write mode these run without a
 * confirmation card: an agent that has to be approved before `npm test` or
 * `git diff` is unusable. The list is deliberately about *executables*; the
 * destructive / escaping checks below still run first and still ask.
 */
const SAFE_HEADS = new Set([
  // JavaScript / TypeScript
  'npm', 'pnpm', 'yarn', 'bun', 'node', 'npx', 'tsx', 'tsc', 'deno',
  'eslint', 'prettier', 'vitest', 'jest',
  // Python
  'python', 'python3', 'py', 'pytest', 'ruff', 'mypy', 'uv', 'pip', 'pip3',
  // Other toolchains
  'git', 'dotnet', 'cargo', 'go', 'mvn', 'gradle', 'javac', 'java',
  // Read-only shell utilities (and workspace-local mkdir/copy)
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'more', 'find', 'findstr',
  'grep', 'rg', 'wc', 'echo', 'pwd', 'mkdir', 'copy', 'cp', 'where',
  'which', 'sort', 'tree',
]);

/**
 * Package managers and git are only auto-approved for the subcommands below;
 * `npm publish` and `git push --force` are caught as destructive anyway, and
 * anything not listed (install scripts via exec, config changes) asks.
 */
const SAFE_SUBS = new Map([
  ['git', new Set([
    'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep',
    'blame', 'shortlog', 'describe', 'branch', 'remote', 'tag', 'add',
    'commit', 'fetch', 'pull', 'merge', 'init', 'clone',
  ])],
  ['npm', new Set([
    'test', 't', 'run', 'run-script', 'start', 'install', 'i', 'ci',
    'add', 'remove', 'uninstall', 'update', 'ls', 'list', 'view', 'info',
    'outdated', 'audit', 'pack', 'init', 'cache',
  ])],
  ['pnpm', new Set([
    'test', 'run', 'start', 'install', 'i', 'add', 'remove', 'update',
    'ls', 'list', 'why', 'outdated', 'audit', 'exec', 'dlx', 'init',
  ])],
  ['yarn', new Set([
    'test', 'run', 'start', 'install', 'add', 'remove', 'upgrade', 'why',
    'info', 'list', 'outdated', 'audit', 'init',
  ])],
  ['bun', new Set([
    'test', 'run', 'start', 'install', 'i', 'add', 'remove', 'update',
    'pm', 'x', 'init',
  ])],
  // pip only reads here; `pip install` changes the shared Python environment.
  ['pip', new Set(['list', 'show', 'freeze', 'check', 'cache'])],
  ['pip3', new Set(['list', 'show', 'freeze', 'check', 'cache'])],
  ['uv', new Set(['run', 'sync', 'lock', 'tree', 'venv'])],
  ['deno', new Set(['run', 'test', 'check', 'fmt', 'lint', 'task', 'bench'])],
  ['cargo', new Set(['build', 'check', 'test', 'run', 'clippy', 'fmt', 'metadata', 'tree', 'bench', 'doc'])],
  ['go', new Set(['build', 'test', 'run', 'vet', 'fmt', 'list', 'mod', 'env', 'version'])],
  ['dotnet', new Set(['build', 'test', 'run', 'restore', 'format', 'list', 'info', 'msbuild'])],
  ['java', new Set(['-version', '--version'])],
  ['mvn', new Set(['test', 'compile', 'package', 'verify', 'dependency', 'versions', 'help'])],
  ['gradle', new Set(['build', 'test', 'check', 'run', 'tasks', 'dependencies', 'assemble'])],
]);

const SAFE_FLAGS = new Set(['--version', '-v', '--help', '-h', '/?']);

/** Split on shell separators so `npm test && rm -rf /` is judged piecewise. */
function commandSegments(command) {
  return command
    .split(/&&|\|\||[;&|\n]/)
    .map((part) => part.trim().replace(/^\(+/, '').replace(/\)+$/, ''))
    .filter(Boolean);
}

function isSafeSegment(segment) {
  // `find` and `python -m pip` can destroy or install behind an otherwise
  // harmless executable name.
  if (/\bfind(?:\.exe)?\b[^\n]*\s-(?:delete|exec|execdir|ok|okdir)\b/i.test(segment)) return false;
  if (/\b(?:python|python3|py)(?:\.exe)?\b[^\n]*\s-m\s+(?:pip|ensurepip)\s+(?:install|uninstall|upgrade)/i.test(segment)) return false;

  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const head = tokens[0]
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (!SAFE_HEADS.has(head)) return false;

  const sub = (tokens[1] ?? '').replace(/^["']|["']$/g, '').toLowerCase();
  if (!sub || SAFE_FLAGS.has(sub)) return true;
  const allowed = SAFE_SUBS.get(head);
  return allowed ? allowed.has(sub) : true;
}

/** Every segment must be a recognised, non-destructive development command. */
function isSafeCommand(command) {
  const segments = commandSegments(command);
  return segments.length > 0 && segments.every(isSafeSegment);
}

/**
 * Commands that only print file contents or listings and cannot write when
 * given ordinary arguments. Used to tell a look outside the workspace
 * (`type C:\Windows\...\hosts`) apart from a write out there, which must not
 * interrupt 自动 mode. Redirection is rejected separately: `type x > y` writes.
 */
const READ_HEADS = new Set([
  'type', 'cat', 'dir', 'ls', 'head', 'tail', 'more', 'findstr', 'grep', 'rg',
  'wc', 'pwd', 'where', 'which', 'tree', 'echo', 'ver', 'hostname', 'whoami',
  'ipconfig', 'systeminfo', 'tasklist', 'netstat',
]);

function isReadOnlyCommand(command) {
  // `2>&1` merges streams and contains both `&` and `>`; drop it before the
  // command is split, or it looks like a write and a stray segment. Sending a
  // stream to the null device (`2>nul`, `>nul`, `>/dev/null`) is not a write.
  const normalized = command
    .replace(/\d?>&\d/g, ' ')
    .replace(/[12]?\s*>\s*(?:nul|\/dev\/null)\b/gi, ' ');
  const segments = commandSegments(normalized);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (segment.includes('>')) return false;
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const head = tokens[0]
      .replace(/^["']|["']$/g, '')
      .toLowerCase()
      .replace(/\.(exe|com)$/, '');
    return READ_HEADS.has(head);
  });
}

/** First word of a command, used as a coarse "same kind of command" key. */
function commandKey(command) {
  return `cmd:${command.trim().toLowerCase()}`;
}

const DEFAULT_ASK_LEVEL = 3;

/** 0 自动 / 1 严重 / 2 关键 / 3 常规; unusable values behave like the old default. */
function normalizeAskLevel(value) {
  const level = Math.trunc(Number(value));
  return level >= 0 && level <= 3 ? level : DEFAULT_ASK_LEVEL;
}

/**
 * Parameters the user must fill in the confirmation card. They are excluded
 * from the model's schema, so they can only arrive from the card.
 */
function secretParameters(tool) {
  const parameters = tool?.definition?.parameters;
  return Array.isArray(parameters) ? parameters.filter((item) => item?.secret) : [];
}

function decide({
  tool,
  args = {},
  mode,
  rules = new Set(),
  root = '',
  askLevel = DEFAULT_ASK_LEVEL,
  secretAvailable = false,
}) {
  const effective = MODES.has(mode) ? mode : 'workspace-write';
  const level = normalizeAskLevel(askLevel);

  if (tool.interactive) return { action: 'allow' };

  // 功能编辑 tools only exist in a category-locked workspace. The category is
  // enforced by the tool implementation, so the permission mode is irrelevant
  // here; deletion still asks the user.
  if (tool.toolEditor) {
    if (tool.ask && level >= 2) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.deleteTool'),
      };
    }
    return { action: 'allow' };
  }

  // Agent 编辑 tools only exist in an agent-locked workspace. They can only
  // touch that one definition and save it immediately, so the permission mode
  // and the ask level do not apply.
  if (tool.agentEditor) return { action: 'allow' };

  // Custom tools run an arbitrary command, so read-only and plan modes refuse
  // them even when they are marked as needing the network; the web switch is a
  // separate gate checked when the tool runs.
  if (tool.custom) {
    if (tool.readOnly) return { action: 'allow' };

    // A configured matrix (set in AI能力) wins; tools saved before this
    // existed fall through to the derived rules below.
    const configured = tool.policy?.[effective];
    if (configured === 'deny') {
      return { action: 'deny', reason: uiText.t('main.policy.customDenied') };
    }

    if (effective === 'read-only') {
      return {
        action: 'deny',
        reason: uiText.t('main.policy.readOnly'),
      };
    }
    if (effective === 'plan') {
      return {
        action: 'deny',
        reason: uiText.t('main.policy.plan'),
      };
    }

    // A credential can only come from the card, so this step must be shown
    // even where the tool is otherwise auto-allowed.
    const secrets = secretParameters(tool);
    if (secrets.length > 0 && !secretAvailable) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.secrets'),
      };
    }

    if (configured === 'allow') return { action: 'allow' };
    if (configured === 'ask' && level >= 2) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.customConfirm'),
      };
    }
    return { action: 'allow' };
  }

  // Reading the user's own knowledge base / warehouse always goes through the
  // permission card, even at 严重 (level 1) and even in danger-full-access.
  // Only 自动 (level 0) may read without interrupting. Listing names/sizes is
  // covered by the activation itself, so it does not ask.
  //
  // Any future write/add/delete is stricter still: it asks at every level, and
  // a delete needs a second confirmation.
  if (tool.dataAccess) {
    const source =
      tool.dataSource === 'warehouse'
        ? uiText.t('main.policy.sourceWarehouse')
        : uiText.t('main.policy.sourceKb');

    if (tool.dataAccess === 'meta') return { action: 'allow' };

    if (tool.dataAccess === 'read') {
      if (level === 0) return { action: 'allow' };
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.dataRead', { source }),
      };
    }

    if (tool.dataAccess === 'delete') {
      return {
        action: 'ask',
        danger: true,
        doubleConfirm: true,
        reason: uiText.t('main.policy.dataDelete', { source }),
      };
    }

    // write / add
    return {
      action: 'ask',
      danger: true,
      reason: uiText.t('main.policy.dataWrite', { source }),
    };
  }

  if (tool.readOnly) return { action: 'allow' };

  // Network access is already an explicit opt-in: the user turned the 联网
  // switch on for this chat. Asking again for every search is just noise.
  if (tool.network) return { action: 'allow' };

  // Mutating tools from here on.
  if (effective === 'read-only') {
    return {
      action: 'deny',
      reason: uiText.t('main.policy.readOnly'),
    };
  }

  // Plan mode: research and propose, do not touch anything.
  if (effective === 'plan') {
    return {
      action: 'deny',
      reason: uiText.t('main.policy.plan'),
    };
  }

  if (effective === 'danger-full-access') {
    return { action: 'allow' };
  }

  // workspace-write: file writes are confined by the path jail. At the default
  // level (3) every change is shown first; levels 1-2 treat them as routine.
  // Shell commands run without asking when they are ordinary development
  // commands; destructive or out-of-workspace *writes* ask at levels 1-3, and
  // unknown commands ask at levels 2-3 (once, and can be remembered). A plain
  // read outside the workspace runs at levels 0-1 and asks at 2-3.
  if (tool.name === 'write_file' || tool.name === 'edit_file') {
    if (level >= 3) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.fileWrite'),
      };
    }
    return { action: 'allow' };
  }

  if (tool.name === 'run_command' || tool.name === 'smoke_check') {
    const command = String(args.command ?? '').trim();
    const destructive = isDestructive(command);
    const escaping = looksEscaping(command, root);
    // Looking at a file outside the workspace is inspection, not a way out:
    // only commands that could change something out there count as danger.
    const escapingWrite = escaping && !isReadOnlyCommand(command);
    const danger = destructive || escapingWrite;

    if (danger && level >= 1) {
      return {
        action: 'ask',
        danger: true,
        reason: destructive
          ? uiText.t('main.policy.destructiveAsk')
          : uiText.t('main.policy.escapeAsk'),
      };
    }
    // Level 0 never leaves a destructive or escaping write unchecked: it is
    // handed to an independent review instead of a person.
    if (danger) {
      return {
        action: 'review',
        danger: true,
        reason: destructive
          ? uiText.t('main.policy.destructiveReview')
          : uiText.t('main.policy.escapeReview'),
      };
    }
    if (rules.has(commandKey(command))) return { action: 'allow' };
    // A read outside the workspace is allowed at 自动 / 严重; the more cautious
    // levels still show it once.
    if (escaping && level >= 2) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.readOutside'),
      };
    }
    if (isSafeCommand(command)) return { action: 'allow' };
    if (level >= 2) {
      return {
        action: 'ask',
        danger: false,
        reason: uiText.t('main.policy.unknownCommand'),
      };
    }
    return { action: 'allow' };
  }

  return { action: 'allow' };
}

module.exports = {
  decide,
  secretParameters,
  commandKey,
  isDestructive,
  isSafeCommand,
  normalizeAskLevel,
  MODES,
  DEFAULT_ASK_LEVEL,
};
