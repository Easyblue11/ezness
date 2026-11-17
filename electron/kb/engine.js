/**
 * Knowledge base engine.
 *
 * Owns the store, the in-memory hybrid index and the ingest queue. Everything
 * that mutates the corpus invalidates the index; it is rebuilt lazily on the
 * next search so ingest never blocks on index construction.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { KbStore, DEFAULT_CATEGORY_ID } = require('./store');
const { extract, isSupported, SUPPORTED } = require('./extract');
const { chunkPages } = require('./chunk');
const { embedTexts, embedQuery } = require('./embed');
const { KbIndex, hybridSearch } = require('./retrieve');
const { llmRerank } = require('./rerank-llm');

const DEFAULT_CONFIG = {
  storageRoot: '',
  embedding: { baseUrl: 'http://localhost:11434', model: '', apiKey: '' },
  chunk: { target: 600, overlap: 80 },
  retrieval: { topK: 6, candidates: 40, rerank: 'fast' },
  rerank: { baseUrl: 'http://localhost:11434', model: 'qwen3:4b' },
};

function mergeConfig(base, patch) {
  if (!patch) return structuredClone(base);
  return {
    ...base,
    ...patch,
    embedding: { ...base.embedding, ...(patch.embedding ?? {}) },
    chunk: { ...base.chunk, ...(patch.chunk ?? {}) },
    retrieval: { ...base.retrieval, ...(patch.retrieval ?? {}) },
    rerank: { ...base.rerank, ...(patch.rerank ?? {}) },
  };
}

class KbEngine {
  constructor() {
    this.config = structuredClone(DEFAULT_CONFIG);
    this.store = null;
    this.index = null;
    this.indexVersion = null;
    this.queue = [];
    this.working = false;
    /** Agent libraries retrieve only confirmed knowledge; the user's own does not filter. */
    this.confirmedOnly = false;
    this.emit = () => {};
  }

  setEmitter(fn) {
    this.emit = fn;
  }

  get open() {
    return Boolean(this.store);
  }

  configure(patch) {
    const next = mergeConfig(this.config, patch);
    const rootChanged = next.storageRoot && next.storageRoot !== this.config.storageRoot;
    this.config = next;
    if (typeof patch?.confirmedOnly === 'boolean' && patch.confirmedOnly !== this.confirmedOnly) {
      this.confirmedOnly = patch.confirmedOnly;
      this.index = null;
      this.indexVersion = null;
    }

    if (next.storageRoot && (!this.store || rootChanged)) {
      this.store?.close();
      this.store = new KbStore(next.storageRoot).open();
      this.recoverStaleRows();
      this.index = null;
      this.indexVersion = null;
    }
    return this.config;
  }

  /**
   * Rows are written the moment files are dropped, so quitting mid-import leaves
   * placeholders behind. Clear them on open rather than showing files that will
   * never make progress.
   */
  recoverStaleRows() {
    if (!this.store) return;
    for (const doc of this.store.listDocuments()) {
      if (!['pending', 'parsing', 'embedding'].includes(doc.status)) continue;
      if (!doc.sha256 || !doc.storedPath) {
        this.store.deleteDocument(doc.id);
      } else {
        this.store.updateDocument(doc.id, { status: 'error', error: '上次导入被中断，删掉重新添加即可' });
      }
    }
  }

  /**
   * Move the whole library to a new root: copy the database and stored files,
   * verify the counts, reopen there, then drop the old copy. Refuses while
   * ingest is running or when the target already holds a library.
   */
  async migrate(rawTarget) {
    if (!rawTarget) throw new Error('没有选择新的存储位置');

    const store = this.requireStore();
    const current = path.resolve(this.config.storageRoot);
    const target = path.resolve(String(rawTarget));

    if (this.working || this.queue.length > 0) throw new Error('正在导入文件，请等导入完成后再迁移');
    if (target === current) return this.snapshot();
    if (target.startsWith(current + path.sep) || current.startsWith(target + path.sep)) {
      throw new Error('不能在知识库目录内部互相迁移，请选择其他位置');
    }
    if (fs.existsSync(path.join(target, 'kb.sqlite'))) {
      throw new Error('目标文件夹里已经有一个知识库，请换一个位置');
    }

    const before = store.stats();
    store.checkpoint();
    store.close();
    this.store = null;

    try {
      fs.mkdirSync(target, { recursive: true });
      const sourceFiles = path.join(current, 'files');
      if (fs.existsSync(sourceFiles)) {
        await fsp.cp(sourceFiles, path.join(target, 'files'), { recursive: true });
      }
      await fsp.copyFile(path.join(current, 'kb.sqlite'), path.join(target, 'kb.sqlite'));
    } catch (error) {
      this.store = new KbStore(current).open();
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error(`迁移失败：${error.message}`);
    }

    const moved = new KbStore(target).open();
    moved.rebaseStoredPaths(target);
    const after = moved.stats();

    if (after.documents !== before.documents || after.chunks !== before.chunks) {
      moved.close();
      this.store = new KbStore(current).open();
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      throw new Error('迁移后数据不一致，已恢复原库');
    }

    this.store = moved;
    this.config = { ...this.config, storageRoot: target };
    this.index = null;
    this.indexVersion = null;

    // The old copy is redundant now. Leave the folder itself alone.
    for (const name of ['files', 'kb.sqlite', 'kb.sqlite-wal', 'kb.sqlite-shm']) {
      await fsp.rm(path.join(current, name), { recursive: true, force: true }).catch(() => {});
    }

    return this.snapshot();
  }

  requireStore() {
    if (!this.store) throw new Error('知识库还没有初始化');
    return this.store;
  }

  snapshot() {
    if (!this.store) {
      return { categories: [], documents: [], stats: { documents: 0, chunks: 0, ready: 0 } };
    }
    return {
      categories: this.store.listCategories(),
      documents: this.store.listDocuments(),
      stats: this.store.stats(),
    };
  }

  /* ---------------- categories ---------------- */

  createCategory(name, kind = 'files', includes = []) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('分类名不能为空');
    const store = this.requireStore();
    const members = kind === 'group' ? this.validateIncludes(store, '', includes) : [];
    store.createCategory(trimmed, kind, members);
    return this.snapshot();
  }

  renameCategory(id, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('分类名不能为空');
    this.requireStore().renameCategory(id, trimmed);
    return this.snapshot();
  }

  /** Membership of a 组合分类: only existing 文件分类, never itself. */
  validateIncludes(store, selfId, includes) {
    const wanted = new Set((Array.isArray(includes) ? includes : []).map(String));
    return store
      .listCategories()
      .filter((category) => category.kind !== 'group' && category.id !== selfId && wanted.has(category.id))
      .map((category) => category.id);
  }

  setCategoryIncludes(id, includes) {
    const store = this.requireStore();
    const category = store.listCategories().find((item) => item.id === id);
    if (!category) throw new Error('分类不存在');
    if (category.kind !== 'group') throw new Error('只有组合分类可以包含其他分类');
    store.setCategoryIncludes(id, this.validateIncludes(store, id, includes));
    return this.snapshot();
  }

  reorderCategories(ids) {
    this.requireStore().reorderCategories(Array.isArray(ids) ? ids.map(String) : []);
    return this.snapshot();
  }

  deleteCategory(id) {
    this.requireStore().deleteCategory(id);
    return this.snapshot();
  }

  moveDocument(docId, categoryId) {
    const store = this.requireStore();
    const target = store.listCategories().find((item) => item.id === categoryId);
    if (!target || target.kind === 'group') throw new Error('组合分类不能存放文件，请选择其他分类');
    store.updateDocument(docId, { category_id: categoryId });
    return this.snapshot();
  }

  deleteDocument(docId) {
    this.requireStore().deleteDocument(docId);
    this.index = null;
    return this.snapshot();
  }

  /** 审核：confirmed 可用于检索，candidate 待核对，rejected 留档但不使用。 */
  reviewDocument(docId, state) {
    const store = this.requireStore();
    if (!['confirmed', 'candidate', 'rejected'].includes(state)) {
      throw new Error('未知的审核状态');
    }
    if (!store.getDocument(docId)) throw new Error('文件不存在');
    store.updateDocument(docId, { review_state: state });
    this.index = null;
    return this.snapshot();
  }

  /* ---------------- ingest ---------------- */

  enqueue(paths, categoryId = DEFAULT_CATEGORY_ID, options = {}) {
    // Only file into a category that still exists and takes files; deletes can
    // race an upload, and 组合分类 never hold files.
    const requested = String(categoryId || DEFAULT_CATEGORY_ID);
    const target = this.store?.listCategories().some(
      (category) => category.id === requested && category.kind !== 'group',
    )
      ? requested
      : DEFAULT_CATEGORY_ID;
    const reviewState = options?.reviewState === 'candidate' ? 'candidate' : 'confirmed';
    const source = String(options?.source ?? '').slice(0, 500);

    const accepted = [];
    for (const filePath of paths) {
      if (!isSupported(filePath)) {
        this.emit({ type: 'ingest', stage: 'skipped', name: path.basename(filePath), message: '不支持的文件类型' });
        continue;
      }
      const name = path.basename(filePath);
      const id = crypto.randomUUID();
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        /* unreadable — the job reports it when its turn comes */
      }

      // Give every file a row right away, so dropping thirty files shows thirty
      // rows at once; hashing, parsing and embedding still run one job at a time.
      try {
        this.store?.insertDocument({
          id,
          categoryId: target,
          name,
          ext: path.extname(filePath).toLowerCase(),
          size,
          sha256: null,
          storedPath: null,
          status: 'pending',
          reviewState,
          source,
        });
      } catch (error) {
        this.emit({ type: 'ingest', stage: 'skipped', name, message: error?.message || '无法加入知识库' });
        continue;
      }

      this.queue.push({ id, filePath, name, categoryId: target });
      accepted.push({ id, name });
    }

    if (accepted.length > 0) this.emit({ type: 'refresh', ...this.snapshot() });
    this.pump();
    return accepted;
  }

  async pump() {
    if (this.working) return;
    this.working = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        await this.ingestOne(job);
      }
    } finally {
      this.working = false;
      this.emit({ type: 'refresh', ...this.snapshot() });
    }
  }

  async ingestOne({ id, filePath, name }) {
    const store = this.requireStore();
    const ext = path.extname(filePath).toLowerCase();

    try {
      const buffer = await fsp.readFile(filePath);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      // The hash is only known now, so duplicate detection happens here rather
      // than at drop time.
      const existing = store.findByHash(sha256);
      if (existing && existing.id !== id) {
        // Same bytes already queued or imported: drop our placeholder row so the
        // list shows the file once, not twice.
        store.deleteDocument(id);
        this.emit({ type: 'ingest', docId: existing.id, name, stage: 'skipped', message: '这个文件已经在库里了' });
        this.emit({ type: 'refresh', ...this.snapshot() });
        return;
      }

      const storedPath = path.join(store.filesDir, `${sha256}${ext}`);
      if (!fs.existsSync(storedPath)) await fsp.writeFile(storedPath, buffer);

      // Fill in what enqueue could not know yet (hash, exact size, stored copy).
      store.updateDocument(id, { sha256, size: buffer.length, stored_path: storedPath, status: 'parsing' });

      // Push the row's new state to the UI before the slow part starts.
      this.emit({ type: 'refresh', ...this.snapshot() });
      this.emit({ type: 'ingest', docId: id, name, stage: 'parsing', message: '正在解析文本' });

      const { pages } = await extract(filePath);
      const chunks = chunkPages(pages, this.config.chunk);

      if (chunks.length === 0) throw new Error('没有解析出可用文本（可能是扫描件）');

      this.emit({
        type: 'ingest',
        docId: id,
        name,
        stage: 'embedding',
        message: `切分出 ${chunks.length} 段，正在向量化`,
        progress: 0,
      });

      if (!this.config.embedding.model) throw new Error('还没有配置向量模型，请到设置里选择 Embedding 模型');

      const vectors = await embedTexts(
        chunks.map((chunk) => chunk.text),
        this.config.embedding,
        {
          onProgress: (done, total) =>
            this.emit({
              type: 'ingest',
              docId: id,
              name,
              stage: 'embedding',
              message: `向量化 ${done}/${total}`,
              progress: Math.round((done / total) * 100),
            }),
        },
      );

      store.replaceChunks(
        id,
        chunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })),
      );

      this.index = null;
      this.emit({ type: 'ingest', docId: id, name, stage: 'ready', message: `${chunks.length} 段已入库`, progress: 100 });
    } catch (error) {
      const message = error?.message || String(error);
      if (this.store?.getDocument(id)) {
        this.store.updateDocument(id, { status: 'error', error: message });
      }
      this.emit({ type: 'ingest', docId: id, name, stage: 'error', message });
    }
  }

  /* ---------------- search ---------------- */

  ensureIndex() {
    const store = this.requireStore();
    const version = store.version();
    if (this.index && this.indexVersion === version) return this.index;

    const rows = store.allChunks({ confirmedOnly: this.confirmedOnly });
    this.index = new KbIndex(rows);
    this.indexVersion = version;
    return this.index;
  }

  async search(query, options = {}) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { results: [], note: '查询为空' };

    const index = this.ensureIndex();
    if (index.size === 0) return { results: [], note: '知识库还是空的' };

    let queryVector = null;
    let note = null;

    if (this.config.embedding.model) {
      try {
        queryVector = await embedQuery(trimmed, this.config.embedding);
      } catch (error) {
        note = `向量检索不可用，已退回关键词检索：${error.message}`;
      }
    } else {
      note = '未配置向量模型，当前只做关键词检索';
    }

    const rerankMode = options.rerank ?? this.config.retrieval.rerank;
    const rerankFn =
      rerankMode === 'llm'
        ? (q, candidates) => llmRerank(q, candidates, this.config.rerank)
        : null;

    // A 组合分类 scopes the search to its member 文件分类.
    let categoryIds = Array.isArray(options.categoryIds) ? options.categoryIds : null;
    if (!categoryIds && options.categoryId && this.store) {
      const category = this.store.listCategories().find((item) => item.id === options.categoryId);
      categoryIds = category?.kind === 'group' ? category.includes : null;
    }

    const started = Date.now();
    const results = await hybridSearch(index, {
      query: trimmed,
      queryVector,
      topK: options.topK ?? this.config.retrieval.topK,
      candidates: options.candidates ?? this.config.retrieval.candidates,
      categoryId: categoryIds ? null : options.categoryId ?? null,
      categoryIds,
      docIds: Array.isArray(options.docIds) ? options.docIds : null,
      excludeDocIds: Array.isArray(options.excludeDocIds) ? options.excludeDocIds : null,
      rerank: rerankFn,
    });

    return {
      results,
      note,
      took: Date.now() - started,
      mode: queryVector ? `hybrid+${rerankFn ? 'llm-rerank' : 'rerank'}` : 'bm25',
    };
  }
}

module.exports = { KbEngine, DEFAULT_CONFIG, SUPPORTED };
