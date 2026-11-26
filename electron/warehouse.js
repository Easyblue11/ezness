/**
 * Conversation warehouse.
 *
 * Plain file storage for images and documents the user drops into a chat (and
 * for files imported by hand from the 仓库 page). It is deliberately separate
 * from the knowledge base: no parse, no chunking, no embeddings, no index —
 * just bytes, a manifest and a directory the user can move around.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const uiText = require('./ui-text');

const MANIFEST = 'warehouse.json';
const FILES_DIR = 'files';
const THUMB_EDGE = 160;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);

function extOf(name) {
  return path.extname(String(name || '')).replace('.', '').toLowerCase();
}

function kindOf(ext) {
  return IMAGE_EXTS.has(ext) ? 'image' : 'file';
}

/** SHA-256 of a file, streamed so large files never sit in memory whole. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const ext = String(raw.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    id: raw.id,
    name:
      typeof raw.name === 'string' && raw.name
        ? raw.name
        : uiText.t('main.warehouse.unnamed', { suffix: ext ? `.${ext}` : '' }),
    size: Number.isFinite(raw.size) ? raw.size : 0,
    ext,
    kind: raw.kind === 'image' || kindOf(ext) === 'image' ? 'image' : 'file',
    addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : Date.now(),
    origin: raw.origin === 'chat' ? 'chat' : 'import',
    // Missing on manifests written before content dedupe; computed on demand.
    hash: typeof raw.hash === 'string' && HASH_PATTERN.test(raw.hash) ? raw.hash : '',
  };
}

/** Item shape sent to the renderer; the content hash stays internal. */
function publicItem(item) {
  const { hash, ...rest } = item;
  return rest;
}

class Warehouse {
  constructor(root) {
    this.root = root;
    this.items = [];
    this.loaded = false;
    this.thumbs = new Map();
    // Writes (add/delete) and manifest saves run one at a time: two concurrent
    // imports would otherwise both pass the duplicate check before either
    // records its item.
    this.writeQueue = Promise.resolve();
    this.hashDirty = false;
    this.loadPromise = null;
  }

  setRoot(root) {
    this.root = root;
    this.loaded = false;
    this.items = [];
    this.thumbs.clear();
    this.hashDirty = false;
    this.loadPromise = null;
  }

  queueWrite(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  filesDir(root = this.root) {
    return path.join(root, FILES_DIR);
  }

  manifestPath(root = this.root) {
    return path.join(root, MANIFEST);
  }

  filePath(item) {
    const suffix = item.ext ? `.${item.ext}` : '';
    return path.join(this.filesDir(), `${item.id}${suffix}`);
  }

  /**
   * Read the manifest once per root. Entries whose bytes disappeared are
   * dropped instead of being listed as broken rows.
   */
  async load() {
    // Dedupe runs during the first load, so concurrent IPC calls (snapshot +
    // import on startup) must await the same pass instead of reading a
    // half-deduped manifest.
    if (this.loadPromise) return this.loadPromise;
    if (this.loaded) return;
    this.loadPromise = this.doLoad().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  async doLoad() {
    await fsp.mkdir(this.filesDir(), { recursive: true });

    let stored = null;
    try {
      stored = JSON.parse(await fsp.readFile(this.manifestPath(), 'utf8'));
    } catch {
      stored = null;
    }

    const raw = Array.isArray(stored?.items) ? stored.items : [];
    const items = raw.map(normalizeItem).filter(Boolean);
    const alive = items.filter((item) => fs.existsSync(this.filePath(item)));
    this.items = alive;
    this.loaded = true;

    // Fold duplicates written before content hashing existed: same size is
    // the cheap prefilter, SHA-256 confirms identical bytes.
    const deduped = await this.dedupeExisting();
    if (deduped || alive.length !== items.length) {
      this.hashDirty = false;
      await this.save();
    }
  }

  /**
   * Remove items whose bytes are identical to an earlier item. Returns true
   * when something was deleted (or a hash was computed and should be stored).
   */
  async dedupeExisting() {
    const bySize = new Map();
    for (const item of this.items) {
      if (!(item.size > 0)) continue;
      const bucket = bySize.get(item.size);
      if (bucket) bucket.push(item);
      else bySize.set(item.size, [item]);
    }

    let touched = false;
    for (const bucket of bySize.values()) {
      if (bucket.length < 2) continue;
      const seen = new Map();
      for (const item of bucket) {
        if (!item.hash) {
          const hash = await this.ensureHash(item);
          if (hash) touched = true;
        }
        if (!item.hash) continue;

        const first = seen.get(item.hash);
        if (!first) {
          seen.set(item.hash, item);
          continue;
        }

        await fsp.rm(this.filePath(item), { force: true }).catch(() => undefined);
        this.thumbs.delete(item.id);
        this.items = this.items.filter((entry) => entry.id !== item.id);
        touched = true;
      }
    }
    return touched;
  }

  /** Compute and cache an item's content hash on first use. */
  async ensureHash(item) {
    if (item.hash) return item.hash;
    try {
      const hash = await hashFile(this.filePath(item));
      if (HASH_PATTERN.test(hash)) {
        item.hash = hash;
        this.hashDirty = true;
      }
    } catch {
      /* unreadable file: leave it out of dedupe rather than fail the import */
    }
    return item.hash;
  }

  /** First existing item with the same bytes, or null. */
  async findByContent(size, hash) {
    for (const item of this.items) {
      if (item.size !== size) continue;
      if ((await this.ensureHash(item)) === hash) return item;
    }
    return null;
  }

  async save() {
    const file = this.manifestPath();
    const temp = `${file}.tmp`;
    const payload = JSON.stringify({ version: 1, items: this.items }, null, 2);
    await fsp.writeFile(temp, payload, 'utf8');
    await fsp.rename(temp, file);
  }

  snapshot() {
    const items = this.items
      .map(publicItem)
      .sort((a, b) => b.addedAt - a.addedAt);
    return {
      root: this.root,
      items,
      count: items.length,
      totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    };
  }

  /**
   * Copy files from disk. Files whose bytes already sit in the warehouse are
   * reported in `duplicates` instead of being stored a second time — the
   * comparison is SHA-256, so a different name with the same content still
   * dedupes, and the same name with different content stays two items.
   */
  async addFiles(filePaths, origin) {
    return this.queueWrite(async () => {
      await this.load();
      const source = origin === 'chat' ? 'chat' : 'import';
      const errors = [];
      const added = [];
      const duplicates = [];

      for (const raw of filePaths ?? []) {
        const full = String(raw || '');
        try {
          const stat = await fsp.stat(full);
          if (!stat.isFile()) throw new Error(uiText.t('main.warehouse.notAFile'));

          const hash = await hashFile(full);
          const existing = await this.findByContent(stat.size, hash);
          if (existing) {
            duplicates.push(publicItem(existing));
            continue;
          }

          const name = path.basename(full);
          const item = this.makeItem(name, stat.size, source, hash);

          await fsp.copyFile(full, this.filePath(item));
          this.items.push(item);
          added.push(publicItem(item));
        } catch (error) {
          errors.push(`${path.basename(full) || full}: ${error?.message || String(error)}`);
        }
      }

      if (added.length > 0 || this.hashDirty) {
        this.hashDirty = false;
        await this.save();
      }
      return { ok: errors.length === 0, snapshot: this.snapshot(), added, duplicates, errors };
    });
  }

  /**
   * Store bytes the renderer already holds. Clipboard screenshots and pasted
   * files that `webUtils.getPathForFile` cannot resolve to a disk path arrive
   * this way; `data` is an ArrayBuffer transferred over IPC.
   */
  async addBlobs(entries, origin) {
    return this.queueWrite(async () => {
      await this.load();
      const source = origin === 'chat' ? 'chat' : 'import';
      const errors = [];
      const added = [];
      const duplicates = [];

      for (const entry of entries ?? []) {
        const rawName = path.basename(String(entry?.name || '').trim());
        try {
          const data = Buffer.from(entry?.data ?? []);
          const hash = hashBuffer(data);
          const existing = await this.findByContent(data.length, hash);
          if (existing) {
            duplicates.push(publicItem(existing));
            continue;
          }

          const name = rawName || uiText.t('main.warehouse.unnamed', { suffix: '' });
          const item = this.makeItem(name, data.length, source, hash);

          await fsp.writeFile(this.filePath(item), data);
          this.items.push(item);
          added.push(publicItem(item));
        } catch (error) {
          errors.push(
            `${rawName || uiText.t('main.warehouse.clipboardFile')}: ${
              error?.message || String(error)
            }`,
          );
        }
      }

      if (added.length > 0 || this.hashDirty) {
        this.hashDirty = false;
        await this.save();
      }
      return { ok: errors.length === 0, snapshot: this.snapshot(), added, duplicates, errors };
    });
  }

  makeItem(name, size, origin, hash = '') {
    const ext = extOf(name);
    return {
      id: randomUUID(),
      name,
      size,
      ext,
      kind: kindOf(ext),
      addedAt: Date.now(),
      origin,
      hash,
    };
  }

  /** Absolute path of one stored file, or null when the id is unknown. */
  async itemPath(id) {
    await this.load();
    const item = this.items.find((entry) => entry.id === id);
    return item ? { item, path: this.filePath(item) } : null;
  }

  /** Remove several files in one pass, so batch deletes save once. */
  async deleteMany(ids) {
    return this.queueWrite(async () => {
      await this.load();
      const wanted = new Set((ids ?? []).filter((id) => typeof id === 'string'));
      if (wanted.size === 0) return this.snapshot();

      const doomed = this.items.filter((entry) => wanted.has(entry.id));
      if (doomed.length === 0) return this.snapshot();

      for (const item of doomed) {
        await fsp.rm(this.filePath(item), { force: true }).catch(() => undefined);
        this.thumbs.delete(item.id);
      }
      this.items = this.items.filter((entry) => !wanted.has(entry.id));
      await this.save();
      return this.snapshot();
    });
  }

  async delete(id) {
    return this.deleteMany([id]);
  }

  /**
   * Small data-URL preview for image items. `nativeImage` handles PNG/JPEG/
   * WebP/BMP; anything it cannot decode returns null and the row shows a badge.
   */
  async thumbnail(id) {
    await this.load();
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.kind !== 'image') return null;
    if (this.thumbs.has(id)) return this.thumbs.get(id);

    const { nativeImage } = require('electron');
    let url = null;
    try {
      const image = nativeImage.createFromPath(this.filePath(item));
      if (!image.isEmpty()) {
        const size = image.getSize();
        const edge = Math.max(size.width || 1, size.height || 1);
        const scale = Math.min(1, THUMB_EDGE / edge);
        const thumb =
          scale < 1
            ? image.resize({
                width: Math.max(1, Math.round(size.width * scale)),
                height: Math.max(1, Math.round(size.height * scale)),
                quality: 'good',
              })
            : image;
        url = thumb.toDataURL();
      }
    } catch {
      url = null;
    }

    this.thumbs.set(id, url);
    return url;
  }

  /**
   * Move the whole warehouse to another directory. The destination must not
   * exist yet (or be empty): a half-merged folder is worse than a refusal, and
   * it keeps the rollback from deleting unrelated files.
   */
  async migrate(rawTarget) {
    await this.load();
    if (!rawTarget) throw new Error(uiText.t('main.warehouse.noTarget'));

    const current = path.resolve(this.root);
    const target = path.resolve(String(rawTarget));

    if (target === current) return this.snapshot();
    if (target.startsWith(current + path.sep) || current.startsWith(target + path.sep)) {
      throw new Error(uiText.t('main.warehouse.insideWarehouse'));
    }

    try {
      const entries = await fsp.readdir(target);
      if (entries.length > 0) throw new Error(uiText.t('main.warehouse.targetNotEmpty'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      await fsp.mkdir(target, { recursive: true });
      const sourceFiles = this.filesDir();
      if (fs.existsSync(sourceFiles)) {
        await fsp.cp(sourceFiles, this.filesDir(target), { recursive: true });
      }
      await fsp.writeFile(
        this.manifestPath(target),
        JSON.stringify({ version: 1, items: this.items }, null, 2),
        'utf8',
      );
    } catch (error) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(
        uiText.t('main.warehouse.migrateFailed', { error: error?.message || String(error) }),
      );
    }

    const missing = this.items.filter(
      (item) => !fs.existsSync(path.join(this.filesDir(target), path.basename(this.filePath(item)))),
    );
    if (missing.length > 0) {
      await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(uiText.t('main.warehouse.verifyFailed', { count: missing.length }));
    }

    // Switch first, then clean the old copy; if deletion fails the data is
    // still safe in the new directory. Reloading reads the copied manifest so
    // this instance lists the same files from the new root.
    this.setRoot(target);
    await this.load();

    for (const name of [FILES_DIR, MANIFEST, `${MANIFEST}.tmp`]) {
      await fsp.rm(path.join(current, name), { recursive: true, force: true }).catch(() => undefined);
    }

    return this.snapshot();
  }
}

module.exports = { Warehouse };
