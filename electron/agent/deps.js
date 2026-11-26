/**
 * Dependency installation for user-defined tools.
 *
 * A custom tool is often a thin wrapper around a third-party library, and the
 * person describing the tool usually cannot install that library themselves.
 * Instead of sending them to a terminal, the editor and the runner install the
 * declared packages automatically:
 *
 *   - Python goes into the portable environment at `<root>/runtimes/python`
 *     when it exists. Without it, packages are installed with the system
 *     interpreter into `<root>/runtimes/py-packages`, which is added to
 *     PYTHONPATH for the tool process — the machine's own site-packages are
 *     never modified.
 *   - Node packages go into `<data root>/agent/node_modules`, which every tool
 *     script and every test copy resolves by walking up from its own folder.
 *
 * Package specs come from generated code, so they are validated against a
 * strict name/version shape before they reach pip or npm. Nothing is evaluated
 * through a shell: argv are passed directly to the package manager.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');
const pythonEnv = require('../python-env');
const uiText = require('../ui-text');

const MAX_DEPS = 12;
const MAX_SPEC_LENGTH = 80;
const INSTALL_TIMEOUT_MS = 600000;
const OUTPUT_LIMIT = 12000;
const CACHE_MS = 5 * 60 * 1000;
const PY_PACKAGES_DIR = 'py-packages';

/** npm accepts `name`, `name@version`, `@scope/name` and `@scope/name@range`. */
const NODE_SPEC_RE =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:@[~^<>=*]?[A-Za-z0-9][A-Za-z0-9.\-+]{0,39})?$/;

/**
 * Import names that differ from the package name. Without this table a missing
 * `bs4` would send pip looking for a package that does not exist.
 */
const PY_ALIASES = {
  bs4: 'beautifulsoup4',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  yaml: 'PyYAML',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  OpenSSL: 'pyOpenSSL',
  jwt: 'PyJWT',
  fitz: 'PyMuPDF',
  docx: 'python-docx',
  pptx: 'python-pptx',
  serial: 'pyserial',
  win32com: 'pywin32',
  win32api: 'pywin32',
  win32con: 'pywin32',
  Crypto: 'pycryptodome',
  googleapiclient: 'google-api-python-client',
  imblearn: 'imbalanced-learn',
  mpl: 'matplotlib',
  magic: 'python-magic',
  usb: 'pyusb',
  serial_asyncio: 'pyserial-asyncio',
};

function clip(text, limit = OUTPUT_LIMIT) {
  const value = String(text ?? '').trim();
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n${uiText.t('main.deps.clip.truncated')}`;
}

function pyPackagesDir(root) {
  return path.join(path.resolve(root), 'runtimes', PY_PACKAGES_DIR);
}

function isDir(dir) {
  try {
    return fsSync.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extra PYTHONPATH for tools that run on the system interpreter. Empty when
 * the portable environment exists, because its site-packages is already on the
 * path.
 */
function pythonPathEnv(root) {
  if (!root) return {};
  if (pythonEnv.pythonExe(root)) return {};
  const dir = pyPackagesDir(root);
  if (!isDir(dir)) return {};
  const current = process.env.PYTHONPATH;
  return { PYTHONPATH: current ? `${dir}${path.delimiter}${current}` : dir };
}

/** Merge a python path returned by an install into an env object. */
function withPythonPath(env, dir) {
  if (!dir) return env;
  const current = env?.PYTHONPATH;
  return { ...env, PYTHONPATH: current ? `${dir}${path.delimiter}${current}` : dir };
}

/**
 * Validate a user/model supplied dependency list. A plain string is split on
 * commas and semicolons, so the dialog can accept `requests, pandas==2.2.3`
 * without extra parsing.
 */
function normalizeDependencies(runtime, raw) {
  if (runtime !== 'node' && runtime !== 'python') return { specs: [], errors: [] };
  const errors = [];
  let list = [];
  if (typeof raw === 'string') {
    // A comma may separate two packages or join two version bounds
    // (`pandas>=2,<3`). Only treat it as a separator when no comparator follows.
    list = raw.split(/[,，;；]\s*(?![<>=!~])/);
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  const specs = [];
  const seen = new Set();
  for (const item of list.slice(0, MAX_DEPS * 2)) {
    const spec = String(item ?? '').trim();
    if (!spec) continue;
    if (spec.length > MAX_SPEC_LENGTH) {
      errors.push(uiText.t('main.deps.error.specTooLong', { spec: `${spec.slice(0, 30)}…` }));
      continue;
    }
    const valid =
      runtime === 'python'
        ? pythonEnv.INSTALL_SPEC_RE.test(spec)
        : NODE_SPEC_RE.test(spec) && !spec.startsWith('.') && !spec.includes(path.sep);
    if (!valid) {
      errors.push(
        runtime === 'python'
          ? uiText.t('main.deps.error.invalidPythonSpec', { spec })
          : uiText.t('main.deps.error.invalidNodeSpec', { spec }),
      );
      continue;
    }
    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
    if (specs.length >= MAX_DEPS) break;
  }
  if (specs.length >= MAX_DEPS && list.length > MAX_DEPS) {
    errors.push(uiText.t('main.deps.error.tooMany', { max: MAX_DEPS }));
  }
  return { specs, errors };
}

/**
 * Packages named by a failed run. Only top-level module names are returned, so
 * `requests.exceptions` becomes `requests` and `@scope/pkg/sub` becomes
 * `@scope/pkg`.
 */
function missingModules(runtime, text) {
  const source = String(text ?? '');
  const found = [];
  const push = (name) => {
    const spec = String(name ?? '').trim();
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return;
    if (runtime === 'python') {
      if (!pythonEnv.INSTALL_SPEC_RE.test(spec)) return;
      found.push(spec);
    } else {
      if (!NODE_SPEC_RE.test(spec)) return;
      found.push(spec);
    }
  };

  if (runtime === 'python') {
    for (const match of source.matchAll(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/g)) {
      const name = match[1].split('.')[0];
      push(PY_ALIASES[name] ?? name);
    }
  } else {
    for (const match of source.matchAll(/Cannot find (?:package|module) ['"]([^'"]+)['"]/g)) {
      const raw = match[1];
      if (raw.startsWith('@')) {
        const parts = raw.split('/');
        if (parts.length >= 2) push(`${parts[0]}/${parts[1]}`);
      } else {
        push(raw.split('/')[0]);
      }
    }
  }

  return [...new Set(found)].slice(0, MAX_DEPS);
}

/* ------------------------------------------------------------------ */
/* Process plumbing                                                    */
/* ------------------------------------------------------------------ */

function childEnv(extra = {}) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...extra,
  };
}

function run(argv, { cwd, env, timeoutMs = INSTALL_TIMEOUT_MS, shell = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? childEnv(),
        windowsHide: true,
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        code: -1,
        output: uiText.t('main.deps.error.spawn', { error: error?.message || String(error) }),
      });
      return;
    }

    let output = '';
    let settled = false;
    const append = (chunk) => {
      if (output.length < OUTPUT_LIMIT * 3) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        output: uiText.t('main.deps.error.spawn', { error: error?.message || String(error) }),
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, output: clip(output) });
    });
  });
}

function whereCommand() {
  return process.platform === 'win32' ? 'where.exe' : 'which';
}

async function findNpm() {
  const result = await run([whereCommand(), 'npm'], { timeoutMs: 4000 });
  if (!result.ok) return '';
  return (
    result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((file) => !/[\\/]WindowsApps[\\/]/i.test(file)) ?? ''
  );
}

/** Prefer node + npm-cli.js: no shell, so package specs are never re-parsed. */
async function npmInvocation() {
  const npm = await findNpm();
  if (!npm) return null;
  const dir = path.dirname(npm);
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fsSync.existsSync(cli)) {
    const node = path.join(dir, 'node.exe');
    const exe = fsSync.existsSync(node) ? node : process.execPath;
    const env = { ...childEnv(), ELECTRON_RUN_AS_NODE: exe === process.execPath ? '1' : '' };
    return { direct: true, argv: [exe, cli], env, cwd: dir };
  }
  return { direct: false, npm: `"${npm}"`, env: childEnv() };
}

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

const cache = new Map();

function cacheKey(kind, base, specs) {
  return `${kind}|${path.resolve(base)}|${[...specs].sort().join(',')}`;
}

async function installPython(root, specs, pythonMeta) {
  const indexUrl = (await pythonEnv.readConfig(root)).indexUrl;
  const exe = pythonEnv.pythonExe(root);

  if (exe) {
    const probe = await run([exe, '-m', 'pip', '--version'], {
      timeoutMs: 30000,
      env: childEnv({ PYTHONNOUSERSITE: '1' }),
    });
    if (!probe.ok) {
      return {
        ok: false,
        output: '',
        error: uiText.t('main.deps.error.envNoPip'),
      };
    }
    const result = await run([
      exe,
      '-m',
      'pip',
      'install',
      '--index-url',
      indexUrl,
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      ...specs,
    ], { env: childEnv({ PYTHONNOUSERSITE: '1' }) });
    return result.ok
      ? { ok: true, output: result.output, pythonPath: '' }
      : {
          ok: false,
          output: result.output,
          error: result.output || uiText.t('main.deps.error.pipFailed'),
        };
  }

  if (!pythonMeta?.command) {
    return {
      ok: false,
      output: '',
      error: uiText.t('main.deps.error.noPython'),
    };
  }

  const target = pyPackagesDir(root);
  await fs.mkdir(target, { recursive: true });
  const result = await run([
    pythonMeta.command,
    ...(pythonMeta.prefix ?? []),
    '-m',
    'pip',
    'install',
    '--target',
    target,
    '--index-url',
    indexUrl,
    '--disable-pip-version-check',
    '--no-input',
    '--no-warn-script-location',
    ...specs,
  ], { env: childEnv() });

  if (!result.ok) {
    const hint = /No module named pip/i.test(result.output)
      ? uiText.t('main.deps.error.pythonNoPip')
      : result.output || uiText.t('main.deps.error.pipFailed');
    return { ok: false, output: result.output, error: hint };
  }
  return { ok: true, output: result.output, pythonPath: target };
}

async function installNode(agentDir, specs) {
  const invocation = await npmInvocation();
  if (!invocation) {
    return {
      ok: false,
      output: '',
      error: uiText.t('main.deps.error.noNpm'),
    };
  }

  const args = [
    'install',
    '--prefix',
    agentDir,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...specs,
  ];

  // Without npm-cli.js beside npm.cmd the shell has to parse the line. Every
  // spec was validated above and cannot contain quotes or separators.
  const argv = invocation.direct
    ? [...invocation.argv, ...args]
    : [`${invocation.npm} ${args.join(' ')}`];

  const result = await run(argv, {
    cwd: invocation.cwd,
    env: invocation.env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    shell: !invocation.direct,
  });
  return result.ok
    ? { ok: true, output: result.output, pythonPath: '' }
    : {
        ok: false,
        output: result.output,
        error: result.output || uiText.t('main.deps.error.npmFailed'),
      };
}

/**
 * Install a set of validated specs. Repeated calls with the same list are
 * served from a short cache, and concurrent calls share one install.
 */
async function ensureDependencies({ root, agentDir, runtime, specs, pythonMeta }) {
  const list = (specs ?? []).filter(Boolean);
  if (list.length === 0) return { ok: true, installed: [], output: '', pythonPath: '' };
  if (runtime !== 'node' && runtime !== 'python') {
    return {
      ok: false,
      installed: [],
      output: '',
      error: uiText.t('main.deps.error.unsupportedRuntime'),
    };
  }
  const base = runtime === 'python' ? root : agentDir;
  if (!base) {
    return {
      ok: false,
      installed: [],
      output: '',
      error: uiText.t('main.deps.error.noDataRoot'),
    };
  }

  const key = cacheKey(runtime, base, list);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const task = (async () => {
    try {
      const result =
        runtime === 'python'
          ? await installPython(root, list, pythonMeta)
          : await installNode(agentDir, list);
      return {
        ok: result.ok,
        installed: result.ok ? list : [],
        output: result.output ?? '',
        pythonPath: result.pythonPath ?? '',
        ...(result.ok
          ? {}
          : { error: result.error || uiText.t('main.deps.error.installFailed') }),
      };
    } catch (error) {
      return {
        ok: false,
        installed: [],
        output: '',
        pythonPath: '',
        error: error?.message || String(error),
      };
    }
  })();

  // Share the in-flight promise so two parallel tools do not race the registry.
  cache.set(key, { at: Date.now(), value: task });
  const value = await task;
  if (!value.ok) cache.delete(key);
  return value;
}

module.exports = {
  MAX_DEPS,
  normalizeDependencies,
  missingModules,
  ensureDependencies,
  pythonPathEnv,
  withPythonPath,
  pyPackagesDir,
  NODE_SPEC_RE,
  PY_ALIASES,
};
