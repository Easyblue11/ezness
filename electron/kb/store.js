/**
 * SQLite persistence for the knowledge base.
 *
 * Uses node:sqlite, which ships with Electron's Node 24 — no native module to
 * rebuild, which is the whole reason the app has no build step for the backend.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_CATEGORY_ID = 'default';
const DEFAULT_CATEGORY_NAME = '默认分类';
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'files',
  includes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT,
  size INTEGER DEFAULT 0,
  sha256 TEXT UNIQUE,
  stored_path TEXT,
  status TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT,
  chunk_count INTEGER DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  section TEXT,
  page INTEGER,
  vector BLOB
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
`;

function parseIncludes(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

class KbStore {
  constructor(root) {
    this.root = root;
    this.db = null;
    this.filesDir = path.join(root, 'files');
  }

  open() {
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'kb.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.migrate();

    const seeded = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(DEFAULT_CATEGORY_ID);
    if (!seeded) {
      this.db
        .prepare('INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)')
        .run(DEFAULT_CATEGORY_ID, DEFAULT_CATEGORY_NAME, Date.now());
    }
    this.bumpVersion();
    return this;
  }

  /**
   * CREATE TABLE IF NOT EXISTS does nothing on an existing library, so columns
   * added after v1 are patched in here.
   */
  migrate() {
    const columns = this.db
      .prepare('PRAGMA table_info(categories)')
      .all()
      .map((column) => column.name);
    if (!columns.includes('kind')) {
      this.db.exec("ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'files'");
    }
    if (!columns.includes('includes')) {
      this.db.exec('ALTER TABLE categories ADD COLUMN includes TEXT');
    }
    if (!columns.includes('sort')) {
      this.db.exec('ALTER TABLE categories ADD COLUMN sort INTEGER NOT NULL DEFAULT 0');
      // Existing libraries keep their on-screen order (oldest first).
      const rows = this.db.prepare('SELECT id FROM categories ORDER BY created_at ASC, rowid ASC').all();
      const update = this.db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
      rows.forEach((row, index) => update.run(index, row.id));
    }

    const docColumns = this.db
      .prepare('PRAGMA table_info(documents)')
      .all()
      .map((column) => column.name);
    if (!docColumns.includes('review_state')) {
      // Every file already in a library was added by the user, so it counts as
      // confirmed. Only knowledge an agent writes itself starts as a candidate.
      this.db.exec("ALTER TABLE documents ADD COLUMN review_state TEXT NOT NULL DEFAULT 'confirmed'");
    }
    if (!docColumns.includes('source')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN source TEXT');
    }
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }

  /** Bumped on every write that changes the searchable corpus. */
  bumpVersion() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('version');
    const next = String(Number(row?.value ?? 0) + 1);
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('version', next);
    return next;
  }

  version() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('version');
    return row?.value ?? '0';
  }

  /** Fold the WAL back into kb.sqlite so the file can be copied on its own. */
  checkpoint() {
    try {
      this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* best effort — a non-truncated WAL still copies fine when sidecars go along */
    }
  }

  /**
   * Documents store absolute file paths. After the library folder moves, rewrite
   * them against the new root; ids stay the same so chunks are untouched.
   */
  rebaseStoredPaths(newRoot) {
    const rows = this.db.prepare('SELECT id, stored_path AS storedPath FROM documents').all();
    const update = this.db.prepare('UPDATE documents SET stored_path = ? WHERE id = ?');
    for (const row of rows) {
      if (!row.storedPath) continue;
      update.run(path.join(newRoot, 'files', path.basename(row.storedPath)), row.id);
    }
  }

  /* ---------------- categories ---------------- */

  listCategories() {
    return this.db
      .prepare(
        `SELECT id, name, kind, includes, sort, created_at AS createdAt
         FROM categories ORDER BY sort ASC, created_at ASC`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind === 'group' ? 'group' : 'files',
        includes: parseIncludes(row.includes),
        createdAt: row.createdAt,
      }));
  }

  createCategory(name, kind = 'files', includes = []) {
    const id = `cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const group = kind === 'group';
    const { next } = this.db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM categories').get();
    this.db
      .prepare('INSERT INTO categories (id, name, kind, includes, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, group ? 'group' : 'files', JSON.stringify(group ? includes : []), next, Date.now());
    return { id, name, kind: group ? 'group' : 'files', includes: group ? includes : [], createdAt: Date.now() };
  }

  /** Persist the sidebar order; ids left out keep their relative place at the end. */
  reorderCategories(ids) {
    const current = this.listCategories().map((category) => category.id);
    const ordered = ids.filter((id) => current.includes(id));
    for (const id of current) {
      if (!ordered.includes(id)) ordered.push(id);
    }

    const update = this.db.prepare('UPDATE categories SET sort = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      ordered.forEach((id, index) => update.run(index, id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  renameCategory(id, name) {
    if (id === DEFAULT_CATEGORY_ID) throw new Error('默认分类不能重命名');
    this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
  }

  /** `includes` only applies to 组合分类; 文件分类 ignore it. */
  setCategoryIncludes(id, includes) {
    if (id === DEFAULT_CATEGORY_ID) throw new Error('默认分类不能改成组合分类');
    this.db.prepare('UPDATE categories SET includes = ? WHERE id = ?').run(JSON.stringify(includes), id);
  }

  deleteCategory(id) {
    if (id === DEFAULT_CATEGORY_ID) throw new Error('默认分类不能删除');
    this.db.prepare('UPDATE documents SET category_id = ? WHERE category_id = ?').run(DEFAULT_CATEGORY_ID, id);
    this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);

    // 组合分类 pointing at it lose the member instead of holding a dead id.
    for (const group of this.listCategories()) {
      if (group.kind !== 'group' || !group.includes.includes(id)) continue;
      this.setCategoryIncludes(
        group.id,
        group.includes.filter((item) => item !== id),
      );
    }
  }

  /* ---------------- documents ---------------- */

  listDocuments() {
    return this.db
      .prepare(
        `SELECT id, category_id AS categoryId, name, ext, size, sha256, stored_path AS storedPath,
                status, review_state AS reviewState, source, chunk_count AS chunkCount, error,
                created_at AS createdAt, updated_at AS updatedAt
         FROM documents ORDER BY created_at DESC`,
      )
      .all();
  }

  getDocument(id) {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  }

  findByHash(sha256) {
    return this.db.prepare('SELECT id FROM documents WHERE sha256 = ?').get(sha256);
  }

  insertDocument(doc) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO documents
           (id, category_id, name, ext, size, sha256, stored_path, status,
            review_state, source, chunk_count, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(
        doc.id,
        doc.categoryId,
        doc.name,
        doc.ext,
        doc.size,
        doc.sha256,
        doc.storedPath,
        doc.status ?? 'pending',
        doc.reviewState === 'candidate' || doc.reviewState === 'rejected' ? doc.reviewState : 'confirmed',
        doc.source ? String(doc.source).slice(0, 500) : null,
        now,
        now,
      );
    this.bumpVersion();
    return doc.id;
  }

  updateDocument(id, patch) {
    const allowed = [
      'status',
      'chunk_count',
      'error',
      'category_id',
      'stored_path',
      'sha256',
      'size',
      'review_state',
      'source',
    ];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `${key} = ?`).join(', ');
    this.db
      .prepare(`UPDATE documents SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, value]) => value), Date.now(), id);
  }

  deleteDocument(id) {
    const doc = this.db.prepare('SELECT stored_path AS storedPath FROM documents WHERE id = ?').get(id);
    this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    this.bumpVersion();

    if (doc?.storedPath) {
      try {
        fs.unlinkSync(doc.storedPath);
      } catch {
        /* file already gone */
      }
    }
  }

  /* ---------------- chunks ---------------- */

  replaceChunks(docId, chunks) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
      const insert = this.db.prepare(
        'INSERT INTO chunks (id, doc_id, ord, text, section, page, vector) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      chunks.forEach((chunk, index) => {
        insert.run(
          `${docId}_${index}`,
          docId,
          index,
          chunk.text,
          chunk.section ?? null,
          chunk.page ?? null,
          chunk.vector ? new Uint8Array(chunk.vector.buffer, chunk.vector.byteOffset, chunk.vector.byteLength) : null,
        );
      });
      this.db
        .prepare('UPDATE documents SET chunk_count = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?')
        .run(chunks.length, 'ready', Date.now(), docId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.bumpVersion();
  }

  /** Ordered chunks of one document, used by the agent's kb_read tool. */
  chunksForDocument(docId, offset = 0, limit = 20) {
    return this.db
      .prepare(
        `SELECT id, doc_id AS docId, ord, text, section, page
         FROM chunks WHERE doc_id = ? ORDER BY ord ASC LIMIT ? OFFSET ?`,
      )
      .all(docId, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset)));
  }

  countChunks(docId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?').get(docId)?.n ?? 0;
  }

  /** Every chunk with its vector, used to build the in-memory index. */
  allChunks(options = {}) {
    const confirmed = options.confirmedOnly ? "WHERE d.review_state = 'confirmed'" : '';
    return this.db
      .prepare(
        `SELECT c.id, c.doc_id AS docId, c.ord, c.text, c.section, c.page, c.vector,
                d.name AS docName, d.category_id AS categoryId
         FROM chunks c JOIN documents d ON d.id = c.doc_id
         ${confirmed}
         ORDER BY d.created_at DESC, c.ord ASC`,
      )
      .all();
  }

  stats() {
    const docs = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get();
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get();
    const ready = this.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'ready'").get();
    return { documents: docs.n, chunks: chunks.n, ready: ready.n };
  }
}

module.exports = { KbStore, DEFAULT_CATEGORY_ID, DEFAULT_CATEGORY_NAME, SCHEMA_VERSION };
