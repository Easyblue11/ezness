/**
 * Portable Python environment for user-defined tools.
 *
 * The interpreter lives inside the data root:
 *
 *   <root>/runtimes/python/            Windows embeddable Python
 *   <root>/runtimes/python-env.json    pip index + deployment metadata
 *
 * Because it sits under the data root it follows a storage-root migration, and
 * custom-tools already prefers `<root>/runtimes/python/python.exe` over any
 * Python installed on the machine. Nothing here touches the system Python.
 *
 * Deployment is: download the official embeddable zip → extract → enable site
 * packages → install pip from a wheel served by the configured index. Modules
 * are installed with that same interpreter, so they land in the environment
 * that the tool runner uses.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { appFetch } = require('./app-net');

const RUNTIMES_DIR = 'runtimes';
const ENV_DIR = 'python';
const CONFIG_FILE = 'python-env.json';
const DEFAULT_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PY_VERSION = '3.12.8';
const ZIP_NAME = `python-${PY_VERSION}-embed-amd64.zip`;
const ZIP_URLS = [
  `https://mirrors.huaweicloud.com/python/${PY_VERSION}/${ZIP_NAME}`,
  `https://www.python.org/ftp/python/${PY_VERSION}/${ZIP_NAME}`,
];
/** sha256 of the official 3.12.8 embeddable zip; mirrors serve the same bytes. */
const ZIP_SHA256 = '8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb';
const GET_PIP_URLS = [
  'https://bootstrap.pypa.io/get-pip.py',
  'https://mirrors.aliyun.com/pypi/get-pip.py',
];
const MAX_OUTPUT = 20000;
const MAX_INDEX_LENGTH = 500;

const INSTALL_SPEC_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\s*\[[A-Za-z0-9._,\s-]{0,200}\])?(\s*(===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40}(\s*,\s*(===|==|~=|!=|<=|>=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40}){0,2})?$/;

function runtimesDir(root) {
  return path.join(root, RUNTIMES_DIR);
}

function envDir(root) {
  return path.join(runtimesDir(root), ENV_DIR);
}

function configPath(root) {
  return path.join(runtimesDir(root), CONFIG_FILE);
}

function pythonExe(root) {
  const dir = envDir(root);
  const candidates =
    process.platform === 'win32'
      ? [path.join(dir, 'python.exe')]
      : [path.join(dir, 'bin', 'python3'), path.join(dir, 'bin', 'python')];
  for (const file of candidates) {
    try {
      if (fsSync.statSync(file).isFile()) return file;
    } catch {
      /* not deployed yet */
    }
  }
  return '';
}

function normalizeIndex(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return DEFAULT_INDEX;
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  return url.toString().replace(/\/+$/, '');
}

async function readConfig(root) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(root), 'utf8'));
    const indexUrl = normalizeIndex(raw?.indexUrl);
    return { indexUrl: indexUrl || DEFAULT_INDEX, pythonVersion: String(raw?.pythonVersion ?? '') };
  } catch {
    return { indexUrl: DEFAULT_INDEX, pythonVersion: '' };
  }
}

async function writeConfig(root, patch) {
  const current = await readConfig(root);
  const next = {
    indexUrl: patch.indexUrl !== undefined ? patch.indexUrl : current.indexUrl,
    pythonVersion: patch.pythonVersion !== undefined ? patch.pythonVersion : current.pythonVersion,
  };
  const file = configPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(temp, file);
  return next;
}

/** Environment for every child process this module starts. */
function childEnv(extra = {}) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    ...extra,
  };
}

function clip(text, limit = MAX_OUTPUT) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（输出已截断）`;
}

function exec(argv, { cwd, timeoutMs = 120000, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: `无法启动：${error?.message || String(error)}` });
      return;
    }

    let output = '';
    let settled = false;
    const append = (chunk) => {
      if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8');
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
      resolve({ ok: false, code: -1, output: `无法启动：${error?.message || String(error)}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, output: clip(output.trim()) });
    });
  });
}

async function download(url, file, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await appFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Ezness' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.part`;
    await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(temp));
    await fs.rename(temp, file);
  } catch (error) {
    const reason = controller.signal.aborted ? '下载超时' : error?.message || String(error);
    throw new Error(`下载失败：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function quoteArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function extractZip(zip, dest) {
  await fs.mkdir(dest, { recursive: true });
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fsSync.existsSync(tar)) {
      const result = await exec([tar, '-xf', zip, '-C', dest], { timeoutMs: 120000 });
      if (result.ok) return;
    }
    const result = await exec(
      [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${quoteArg(zip)} -DestinationPath ${quoteArg(dest)} -Force`,
      ],
      { timeoutMs: 180000 },
    );
    if (result.ok) return;
    throw new Error(`解压失败：${result.output || '系统没有可用的解压工具'}`);
  }

  const unzip = await exec(['unzip', '-q', zip, '-d', dest], { timeoutMs: 120000 });
  if (unzip.ok) return;
  const tar = await exec(['tar', '-xf', zip, '-C', dest], { timeoutMs: 120000 });
  if (tar.ok) return;
  throw new Error(`解压失败：${unzip.output || tar.output || '系统没有可用的解压工具'}`);
}

/**
 * Embeddable Python ships without site.main(), so `Lib/site-packages` would be
 * ignored. Turn site on and add the folder that pip installs into.
 */
async function patchPth(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const pth = entries.find((name) => /^python\d+\._pth$/i.test(name));
  if (!pth) return;
  const file = path.join(dir, pth);
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
  const wanted = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (/^#\s*import\s+site$/i.test(text)) continue;
    if (/^Lib[\\/]site-packages$/i.test(text)) continue;
    if (/^import\s+site$/i.test(text)) continue;
    wanted.push(line);
  }
  wanted.push('Lib\\site-packages', '', 'import site', '');
  await fs.writeFile(file, wanted.join('\r\n'), 'utf8');
}

async function pipVersion(exe) {
  const result = await exec([exe, '-m', 'pip', '--version'], { timeoutMs: 30000 });
  if (!result.ok) return '';
  return result.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

async function pythonVersion(exe) {
  const result = await exec([exe, '-V'], { timeoutMs: 30000 });
  if (!result.ok) return '';
  return result.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

async function simpleIndexFiles(indexUrl, project) {
  const url = `${normalizeIndex(indexUrl) || DEFAULT_INDEX}/${project}/`;
  const response = await appFetch(url, {
    headers: {
      Accept: 'application/vnd.pypi.simple.v1+json, application/json;q=0.9, text/html;q=0.5',
      'User-Agent': 'Ezness',
    },
  });
  if (!response.ok) throw new Error(`索引 ${project} 返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (/json/i.test(type)) {
    const data = await response.json();
    return (Array.isArray(data?.files) ? data.files : [])
      .filter((item) => item?.filename && item?.url)
      .map((item) => ({ filename: String(item.filename), url: new URL(String(item.url), url).toString() }));
  }
  const html = await response.text();
  const files = [];
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1].split('#')[0];
    const filename = decodeURIComponent(href.split('/').pop() || '');
    if (!filename) continue;
    files.push({ filename, url: new URL(href, url).toString() });
  }
  return files;
}

/**
 * pip itself is a universal wheel with no dependencies, so the index that will
 * serve modules can also bootstrap the package manager. Avoids depending on
 * bootstrap.pypa.io being reachable.
 */
async function bootstrapPipFromIndex(exe, dir, indexUrl) {
  const files = await simpleIndexFiles(indexUrl, 'pip');
  const wheels = files
    .filter((file) => /^pip-\d+(?:\.\d+)*[-.]?(?:py3|py2\.py3)-none-any\.whl$/i.test(file.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  if (wheels.length === 0) throw new Error('索引里没有找到 pip 的 wheel');

  const target = path.join(dir, 'Lib', 'site-packages');
  await fs.mkdir(target, { recursive: true });
  const temp = path.join(runtimesDir(path.dirname(path.dirname(dir))), '.pip-bootstrap.whl');
  await download(wheels[wheels.length - 1].url, temp);
  try {
    await extractZip(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }

  const version = await pipVersion(exe);
  if (!version) throw new Error('从索引安装 pip 后仍然无法运行 pip');
  return version;
}

async function bootstrapPipFromScript(exe, dir) {
  const temp = path.join(runtimesDir(path.dirname(path.dirname(dir))), '.get-pip.py');
  let last = '';
  for (const url of GET_PIP_URLS) {
    try {
      await download(url, temp);
      last = '';
      break;
    } catch (error) {
      last = error.message;
    }
  }
  if (last) throw new Error(last);
  try {
    const result = await exec(
      [exe, temp, '--no-warn-script-location', '--disable-pip-version-check'],
      { cwd: dir, timeoutMs: 300000 },
    );
    if (!result.ok) throw new Error(result.output || 'get-pip.py 执行失败');
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  const version = await pipVersion(exe);
  if (!version) throw new Error('get-pip.py 之后仍然无法运行 pip');
  return version;
}

async function status(root) {
  const config = await readConfig(root);
  const exe = pythonExe(root);
  let version = '';
  let pip = '';
  if (exe) {
    version = await pythonVersion(exe);
    pip = await pipVersion(exe);
  }
  return {
    dir: envDir(root),
    runtimesDir: runtimesDir(root),
    installed: Boolean(exe),
    exe: exe || '',
    version,
    targetVersion: PY_VERSION,
    pip: Boolean(pip),
    pipVersion: pip,
    indexUrl: config.indexUrl,
    defaultIndex: DEFAULT_INDEX,
    configFile: configPath(root),
  };
}

/**
 * Make sure an interpreter + pip exist. Safe to call repeatedly: an existing
 * environment is only inspected, never overwritten.
 */
async function ensure(root, hooks = {}) {
  const progress = (step, text) => {
    try {
      hooks.onProgress?.({ step, text });
    } catch {
      /* progress is cosmetic */
    }
  };
  const config = await readConfig(root);
  const dir = envDir(root);
  await fs.mkdir(dir, { recursive: true });

  let exe = pythonExe(root);
  if (!exe) {
    progress('download', '正在下载 Python 安装包…');
    const zip = path.join(runtimesDir(root), '.python-embed.zip');
    let lastError = '';
    for (const url of ZIP_URLS) {
      try {
        await download(url, zip, 300000);
        const digest = await sha256(zip);
        if (ZIP_SHA256 && digest !== ZIP_SHA256) {
          throw new Error(`安装包校验失败（sha256 ${digest.slice(0, 12)}…）`);
        }
        lastError = '';
        break;
      } catch (error) {
        lastError = `${url}：${error.message}`;
        await fs.rm(zip, { force: true }).catch(() => undefined);
      }
    }
    if (lastError) throw new Error(`Python 下载失败。${lastError}`);

    progress('extract', '正在解压 Python…');
    try {
      await extractZip(zip, dir);
      await patchPth(dir);
    } finally {
      await fs.rm(zip, { force: true }).catch(() => undefined);
    }
    exe = pythonExe(root);
    if (!exe) throw new Error('解压后没有找到 python.exe');
  }

  let pip = await pipVersion(exe);
  if (!pip) {
    progress('pip', '正在准备 pip…');
    try {
      pip = await bootstrapPipFromIndex(exe, dir, config.indexUrl);
    } catch (first) {
      progress('pip', '镜像里没有合适的 pip，改用官方引导脚本…');
      try {
        pip = await bootstrapPipFromScript(exe, dir);
      } catch (second) {
        throw new Error(`pip 安装失败：${first.message}；${second.message}`);
      }
    }
  }

  await writeConfig(root, { pythonVersion: PY_VERSION });
  progress('done', 'Python 环境已就绪');
  return { ...(await status(root)), pipVersion: pip };
}

async function listModules(root) {
  const exe = pythonExe(root);
  if (!exe) throw new Error('还没有部署独立的 Python 环境，请先点「检查并补全环境」。');
  const result = await exec(
    [exe, '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
    { timeoutMs: 60000 },
  );
  if (!result.ok) throw new Error(result.output || '读取模块列表失败');
  let parsed;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    throw new Error(`模块列表格式无法解析：${result.output.slice(0, 200)}`);
  }
  return (Array.isArray(parsed) ? parsed : [])
    .map((item) => ({
      name: String(item?.name ?? ''),
      version: String(item?.version ?? ''),
    }))
    .filter((item) => item.name)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

async function installModule(root, spec) {
  const exe = pythonExe(root);
  if (!exe) throw new Error('还没有部署独立的 Python 环境，请先点「检查并补全环境」。');
  if (!(await pipVersion(exe))) {
    throw new Error('这个环境里没有 pip，请先点「检查并补全环境」。');
  }

  const name = String(spec ?? '').trim();
  if (!name) throw new Error('请输入要安装的模块名。');
  if (name.length > 200 || !INSTALL_SPEC_RE.test(name)) {
    throw new Error('模块名不合法。可以写 requests，也可以写 pandas==2.2.3，不要带命令参数。');
  }

  const { indexUrl } = await readConfig(root);
  const result = await exec(
    [
      exe,
      '-m',
      'pip',
      'install',
      '--index-url',
      indexUrl,
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      name,
    ],
    { timeoutMs: 600000 },
  );
  if (!result.ok) throw new Error(result.output || '安装失败');
  return { ok: true, spec: name, output: result.output };
}

async function setIndexUrl(root, value) {
  const indexUrl = normalizeIndex(value);
  if (!indexUrl) throw new Error('安装源必须是 http:// 或 https:// 开头的完整地址。');
  if (indexUrl.length > MAX_INDEX_LENGTH) throw new Error('安装源地址太长。');
  await writeConfig(root, { indexUrl });
  return { indexUrl };
}

module.exports = {
  DEFAULT_INDEX,
  PY_VERSION,
  INSTALL_SPEC_RE,
  envDir,
  pythonExe,
  status,
  ensure,
  listModules,
  installModule,
  setIndexUrl,
  readConfig,
};
