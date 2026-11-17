/**
 * App data root.
 *
 * Everything Ezness writes lives under one user-chosen directory:
 *
 *   <root>/settings.json      model providers, defaults, web, voice
 *   <root>/prompts.json       prompt templates
 *   <root>/kb-config.json     knowledge-base tuning
 *   <root>/ezrag/             knowledge base (SQLite + original files)
 *   <root>/ezstorge/          conversation warehouse (manifest + originals)
 *   <root>/voice-models/      local VAD / ASR models
 *   <root>/locales/           external language packs
 *
 * The only thing kept in Electron's userData is `system-config.json`, which
 * remembers the root. Chromium's own cache folders also stay in userData —
 * they are runtime state managed by Electron, not app data.
 *
 * Moving the root is copy → verify → switch → delete old. The slow copy goes
 * into a staging folder inside the target volume, so an interrupted migration
 * never leaves half-written `ezrag`/`ezstorge` folders in place; the next run
 * can simply start over.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { KbStore } = require('./kb/store');

const BOOTSTRAP = 'system-config.json';
const PORTABLE_DIR = 'EznessData';
const RAG_DIR = 'ezrag';
const WAREHOUSE_DIR = 'ezstorge';
const VOICE_DIR = 'voice-models';
const RUNTIMES_DIR = 'runtimes';
/** Custom tools, Agent definitions and their knowledge bases, session logs. */
const AGENT_DIR = 'agent';
/** User-made language packs; they belong to the user and move with the data. */
const LOCALES_DIR = 'locales';
const AUX_FILES = [
  'settings.json',
  'prompts.json',
  'kb-config.json',
  // Spend ledger and the catalogue prices it snapshots; both travel with the
  // rest of the user's data when the root moves.
  'usage.json',
  'model-prices.json',
];
const STAGING = '.ezness-staging';
const RESERVED = [
  ...AUX_FILES,
  RAG_DIR,
  WAREHOUSE_DIR,
  VOICE_DIR,
  RUNTIMES_DIR,
  AGENT_DIR,
  LOCALES_DIR,
];

/**
 * Portable mode: the data root travels with the program.
 *
 * Two opt-in ways to say "use the folder beside me instead of this machine's
 * userData": an `EznessData` folder next to the app, or EZNESS_DATA_ROOT for a
 * launcher. Both are explicit, so an existing install that never asked for
 * portable mode keeps using its configured root.
 */
function findPortableRoot(appPath) {
  const override = String(process.env.EZNESS_DATA_ROOT ?? '').trim();
  if (override) return path.resolve(override);
  if (!appPath) return '';
  const candidate = path.join(appPath, PORTABLE_DIR);
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* no portable folder beside the app */
  }
  return '';
}

class AppStorage {
  constructor(userData) {
    this.userData = userData;
    this.root = userData;
    /** A bootstrap file existed, so `root` is the user's choice. */
    this.initialized = false;
    /** No bootstrap yet: the guessed root still has to be populated. */
    this.initialMigration = false;
  }

  bootstrapPath() {
    return path.join(this.userData, BOOTSTRAP);
  }

  pathsAt(root) {
    return {
      root,
      settings: path.join(root, 'settings.json'),
      prompts: path.join(root, 'prompts.json'),
      kbConfig: path.join(root, 'kb-config.json'),
      rag: path.join(root, RAG_DIR),
      warehouse: path.join(root, WAREHOUSE_DIR),
      voiceModels: path.join(root, VOICE_DIR),
      runtimes: path.join(root, RUNTIMES_DIR),
      agent: path.join(root, AGENT_DIR),
      locales: path.join(root, LOCALES_DIR),
    };
  }

  get paths() {
    return this.pathsAt(this.root);
  }

  async load() {
    let stored = null;
    try {
      stored = JSON.parse(await fsp.readFile(this.bootstrapPath(), 'utf8'));
    } catch {
      stored = null;
    }

    const saved = typeof stored?.root === 'string' ? stored.root.trim() : '';
    if (saved) {
      this.root = path.resolve(saved);
      this.initialized = true;
      this.initialMigration = false;
      return this;
    }

    this.root = await this.guessRoot();
    this.initialized = false;
    this.initialMigration = path.resolve(this.root) !== path.resolve(this.userData);
    return this;
  }

  /**
   * First launch after this feature lands: reuse the drive that already holds
   * the knowledge base, so a big library does not get pulled onto C:. Only the
   * two legacy names are treated as knowledge-base folders — an arbitrary path
   * should not make its parent the app's data root.
   */
  async guessRoot() {
    try {
      const legacy = JSON.parse(
        await fsp.readFile(path.join(this.userData, 'kb-config.json'), 'utf8'),
      );
      const kbRoot = typeof legacy?.storageRoot === 'string' ? legacy.storageRoot : '';
      if (kbRoot) {
        const base = path.basename(path.resolve(kbRoot)).toLowerCase();
        if (base === 'ezness-kb' || base === 'kb') return path.dirname(path.resolve(kbRoot));
      }
    } catch {
      /* no legacy config */
    }
    return this.userData;
  }

  /**
   * Switch to a root that travels with the app. Treated as already
   * initialised: the portable folder is its own world, so the first run must
   * not pull settings out of this machine's userData.
   */
  usePortable(root) {
    this.root = path.resolve(root);
    this.initialized = true;
    this.initialMigration = false;
    return this;
  }

  async save() {
    await fsp.mkdir(this.userData, { recursive: true });
    const file = this.bootstrapPath();
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ root: this.root }, null, 2), 'utf8');
    await fsp.rename(temp, file);
  }

  reset(root) {
    this.root = root;
    this.initialMigration = false;
  }
}

/** Windows paths are case-insensitive; compare them the same way. */
function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function inside(child, parent) {
  if (samePath(child, parent)) return true;
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

async function directorySize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* vanished while walking */
        }
      }
    }
  }
  return total;
}

async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function freeBytes(target) {
  let dir = path.resolve(target);
  for (;;) {
    try {
      const stats = await fsp.statfs(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function formatBytes(bytes) {
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

async function removeDirIfEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length === 0) await fsp.rmdir(dir);
  } catch {
    /* not empty or already gone */
  }
}

/**
 * Copy the SQLite library into `to` without switching the engine. The store is
 * closed for the copy, then reopened on the old root so the app keeps working
 * if the migration is rolled back.
 */
async function copyKbTo(kb, from, to) {
  const store = kb.store;
  if (!store) {
    await fsp.mkdir(to, { recursive: true });
    return;
  }

  const before = store.stats();
  store.checkpoint();
  store.close();
  kb.store = null;

  try {
    await fsp.mkdir(to, { recursive: true });
    const filesDir = path.join(from, 'files');
    if (fs.existsSync(filesDir)) {
      await fsp.cp(filesDir, path.join(to, 'files'), { recursive: true });
    }
    await fsp.copyFile(path.join(from, 'kb.sqlite'), path.join(to, 'kb.sqlite'));

    const copy = new KbStore(to).open();
    const after = copy.stats();
    copy.close();
    if (after.documents !== before.documents || after.chunks !== before.chunks) {
      throw new Error(
        `数据核对不一致（${after.documents} 个文件 / ${after.chunks} 段 ≠ ${before.documents} / ${before.chunks}）`,
      );
    }
  } catch (error) {
    try {
      kb.store = new KbStore(from).open();
      kb.index = null;
      kb.indexVersion = null;
    } catch {
      /* the old store could not be reopened; the caller reports the error */
    }
    throw new Error(`知识库复制失败：${error?.message || String(error)}`);
  }

  kb.store = new KbStore(from).open();
  kb.index = null;
  kb.indexVersion = null;
}

/** Copy warehouse bytes + manifest into `to`, keeping the live instance on its
 * current root until the migration is committed. */
async function copyWarehouseTo(warehouse, from, to) {
  await warehouse.load();
  const items = warehouse.items.map((item) => ({ ...item }));

  await fsp.mkdir(to, { recursive: true });
  const filesDir = path.join(from, 'files');
  if (fs.existsSync(filesDir)) {
    await fsp.cp(filesDir, path.join(to, 'files'), { recursive: true });
  }
  await fsp.writeFile(
    path.join(to, 'warehouse.json'),
    JSON.stringify({ version: 1, items }, null, 2),
    'utf8',
  );

  for (const item of items) {
    const suffix = item.ext ? `.${item.ext}` : '';
    if (!fs.existsSync(path.join(to, 'files', `${item.id}${suffix}`))) {
      throw new Error(`仓库文件「${item.name}」没有复制过去`);
    }
  }
}

/**
 * Move all app data to `target`. `sourceRoot` is where settings/prompts/voice
 * currently live; on first launch that is still Electron's userData. The
 * knowledge base and warehouse may live elsewhere and are read from the engines.
 */
async function migrateDataRoot({ storage, kb, warehouse, voice, persistKb }, rawTarget, options = {}) {
  if (!rawTarget) throw new Error('没有选择新的存储位置');
  if (!path.isAbsolute(String(rawTarget))) {
    throw new Error('请选择一个完整的文件夹路径');
  }

  const target = path.resolve(String(rawTarget));
  const source = path.resolve(options.sourceRoot || storage.root);
  const targetPaths = storage.pathsAt(target);
  const sourcePaths = storage.pathsAt(source);

  if (kb.working || kb.queue.length > 0) throw new Error('正在导入文件，请等导入完成后再迁移');
  await warehouse.load();

  const oldKbRoot = path.resolve(kb.config.storageRoot || sourcePaths.rag);
  const oldWhRoot = path.resolve(warehouse.root || sourcePaths.warehouse);

  const sameRoot = samePath(target, source);
  if (!sameRoot && (inside(target, source) || inside(source, target))) {
    throw new Error('存储位置不能设成当前目录的上层或下层，请选择其他文件夹');
  }
  for (const root of [oldKbRoot, oldWhRoot]) {
    if (inside(target, root)) {
      throw new Error('不能把存储位置设成知识库或仓库目录本身，请选择其他文件夹');
    }
  }

  if (!sameRoot) {
    for (const name of RESERVED) {
      if (fs.existsSync(path.join(target, name))) {
        throw new Error('这个文件夹里已经有一套 Ezness 数据，请换一个空文件夹');
      }
    }
  } else {
    if (fs.existsSync(targetPaths.rag) && !samePath(targetPaths.rag, oldKbRoot)) {
      throw new Error('目标文件夹里已经有一个 ezrag，请换一个位置');
    }
    if (fs.existsSync(targetPaths.warehouse) && !samePath(targetPaths.warehouse, oldWhRoot)) {
      throw new Error('目标文件夹里已经有一个 ezstorge，请换一个位置');
    }
  }

  // Free-space preflight. Peak usage is the full copy; the old copy is deleted
  // only after everything is verified and switched.
  let need = 0;
  if (!samePath(oldKbRoot, targetPaths.rag)) need += await directorySize(oldKbRoot);
  if (!samePath(oldWhRoot, targetPaths.warehouse)) need += await directorySize(oldWhRoot);
  if (!samePath(sourcePaths.voiceModels, targetPaths.voiceModels)) {
    need += await directorySize(sourcePaths.voiceModels);
  }
  if (!samePath(sourcePaths.runtimes, targetPaths.runtimes)) {
    need += await directorySize(sourcePaths.runtimes);
  }
  if (!samePath(sourcePaths.agent, targetPaths.agent)) {
    need += await directorySize(sourcePaths.agent);
  }
  if (!samePath(sourcePaths.locales, targetPaths.locales)) {
    need += await directorySize(sourcePaths.locales);
  }
  for (const name of AUX_FILES) {
    const from = path.join(source, name);
    if (!samePath(from, path.join(target, name))) need += await fileSize(from);
  }
  const free = await freeBytes(target);
  if (free !== null && free < need + 32 * 1024 * 1024) {
    throw new Error(`目标位置空间不足：需要约 ${formatBytes(need)}，可用 ${formatBytes(free)}`);
  }

  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建目标文件夹：${error?.message || String(error)}`);
  }

  const staging = path.join(target, STAGING);
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);

  const created = [];
  let switched = false;

  try {
    await fsp.mkdir(staging, { recursive: true });

    for (const name of AUX_FILES) {
      const from = path.join(source, name);
      if (samePath(from, path.join(target, name))) continue;
      if (!fs.existsSync(from)) continue;
      await fsp.copyFile(from, path.join(staging, name));
    }

    if (
      !samePath(sourcePaths.voiceModels, targetPaths.voiceModels) &&
      fs.existsSync(sourcePaths.voiceModels)
    ) {
      await fsp.cp(sourcePaths.voiceModels, path.join(staging, VOICE_DIR), { recursive: true });
    }

    // Portable interpreters and their pip config travel with the data root.
    if (!samePath(sourcePaths.runtimes, targetPaths.runtimes) && fs.existsSync(sourcePaths.runtimes)) {
      await fsp.cp(sourcePaths.runtimes, path.join(staging, RUNTIMES_DIR), { recursive: true });
    }

    // Custom tools, Agent definitions and their knowledge bases. Session logs
    // are small and carry the model's usage counters, so they travel too.
    if (!samePath(sourcePaths.agent, targetPaths.agent) && fs.existsSync(sourcePaths.agent)) {
      await fsp.cp(sourcePaths.agent, path.join(staging, AGENT_DIR), { recursive: true });
    }

    // Language packs are user content: a hand-written translation must survive
    // a storage move like any other data.
    if (!samePath(sourcePaths.locales, targetPaths.locales) && fs.existsSync(sourcePaths.locales)) {
      await fsp.cp(sourcePaths.locales, path.join(staging, LOCALES_DIR), { recursive: true });
    }

    if (!samePath(oldWhRoot, targetPaths.warehouse)) {
      await copyWarehouseTo(warehouse, oldWhRoot, path.join(staging, WAREHOUSE_DIR));
    }

    if (!samePath(oldKbRoot, targetPaths.rag)) {
      await copyKbTo(kb, oldKbRoot, path.join(staging, RAG_DIR));
    }

    // Everything is copied and verified; publish it in one quick pass.
    for (const name of [
      ...AUX_FILES,
      VOICE_DIR,
      WAREHOUSE_DIR,
      RAG_DIR,
      RUNTIMES_DIR,
      AGENT_DIR,
      LOCALES_DIR,
    ]) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, name);
      await fsp.rename(from, to);
      created.push(to);
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);

    // The copied database still records paths under the staging folder.
    if (!samePath(oldKbRoot, targetPaths.rag)) {
      const moved = new KbStore(targetPaths.rag).open();
      moved.rebaseStoredPaths(targetPaths.rag);
      moved.close();
    }

    kb.configure({ storageRoot: targetPaths.rag });
    warehouse.setRoot(targetPaths.warehouse);
    await warehouse.load();
    if (voice) {
      try {
        voice.cancel();
      } catch {
        /* no active session */
      }
      voice.root = target;
    }
    storage.root = target;
    storage.initialMigration = false;
    await storage.save();
    switched = true;

    await persistKb();

    // Old copies are redundant now. Cleanup is best-effort: a leftover folder
    // is harmless and must not turn a successful migration into an error.
    await cleanupOld({ source, oldKbRoot, oldWhRoot, targetPaths, sourcePaths });
    return { ok: true };
  } catch (error) {
    if (!switched) {
      for (const entry of created.reverse()) {
        await fsp.rm(entry, { recursive: true, force: true }).catch(() => undefined);
      }
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      try {
        kb.configure({ storageRoot: oldKbRoot });
      } catch {
        /* already back on the old store */
      }
      try {
        warehouse.setRoot(oldWhRoot);
        await warehouse.load();
      } catch {
        /* keep whatever the engine had */
      }
      if (voice) voice.root = source;
    }
    throw error;
  }
}

async function cleanupOld({ source, oldKbRoot, oldWhRoot, targetPaths, sourcePaths }) {
  if (!samePath(oldKbRoot, targetPaths.rag)) {
    for (const name of ['files', 'kb.sqlite', 'kb.sqlite-wal', 'kb.sqlite-shm']) {
      await fsp.rm(path.join(oldKbRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
    await removeDirIfEmpty(oldKbRoot);
  }

  if (!samePath(oldWhRoot, targetPaths.warehouse)) {
    for (const name of ['files', 'warehouse.json', 'warehouse.json.tmp']) {
      await fsp.rm(path.join(oldWhRoot, name), { recursive: true, force: true }).catch(() => undefined);
    }
    await removeDirIfEmpty(oldWhRoot);
  }

  if (!samePath(source, targetPaths.root)) {
    for (const name of [...AUX_FILES, 'warehouse-config.json']) {
      await fsp.rm(path.join(source, name), { force: true }).catch(() => undefined);
    }
    if (!samePath(sourcePaths.voiceModels, targetPaths.voiceModels)) {
      await fsp.rm(sourcePaths.voiceModels, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!samePath(sourcePaths.runtimes, targetPaths.runtimes)) {
      await fsp.rm(sourcePaths.runtimes, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!samePath(sourcePaths.agent, targetPaths.agent)) {
      await fsp.rm(sourcePaths.agent, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!samePath(sourcePaths.locales, targetPaths.locales)) {
      await fsp.rm(sourcePaths.locales, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

module.exports = {
  AppStorage,
  migrateDataRoot,
  directorySize,
  fileSize,
  formatBytes,
  samePath,
  findPortableRoot,
  PORTABLE_DIR,
  RAG_DIR,
  WAREHOUSE_DIR,
  LOCALES_DIR,
};
