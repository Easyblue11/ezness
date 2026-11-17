'use strict';

/**
 * Read the data the agent actually produced, not the list of files it made.
 *
 * The visualization dialog used to look only at the transcript, so a task like
 * "generate a pile of statistics" was summarized as "52 workbooks, 9600 rows"
 * because that is what the chat said. This module walks the workspace folder
 * and pulls real rows out of CSV/TSV, Excel workbooks, SQLite databases, JSON
 * and Markdown tables, so the model charts the data inside them.
 *
 * Everything is bounded and read-only: files are sampled, tables are capped,
 * and a broken file never fails the whole collection.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILES = 14;
const MAX_TABLES = 10;
const MAX_ROWS_PER_TABLE = 60;
const MAX_ROWS_PER_FILE = 40;
const MAX_COLUMNS = 12;
const MAX_CELL = 80;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_EXCEL_BYTES = 24 * 1024 * 1024;
const MAX_SQLITE_BYTES = 512 * 1024 * 1024;
const MAX_SHEETS = 4;
const MAX_SQLITE_TABLES = 6;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 900;
/** Cap for the on-demand "show every row" view. */
const MAX_ALL_ROWS = 2000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '$recycle.bin',
  'system volume information',
]);

/** Data files first; Markdown/README last so prose cannot crowd out the data. */
const PRIORITY = new Map([
  ['.xlsx', 0],
  ['.xlsm', 0],
  ['.sqlite', 1],
  ['.sqlite3', 1],
  ['.db', 1],
  ['.csv', 2],
  ['.tsv', 2],
  ['.json', 3],
  ['.md', 4],
  ['.markdown', 4],
  ['.txt', 4],
]);

function clip(value, max) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function fitRow(cells, count) {
  const row = [];
  for (let index = 0; index < count; index += 1) row.push(clip(cells[index], MAX_CELL));
  return row;
}

/* ---------------- delimited text ---------------- */

function guessDelimiter(text, name) {
  if (/\.tsv$/i.test(name)) return '\t';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > 0) return '\t';
  if (semicolons > commas && semicolons > 0) return ';';
  return ',';
}

/**
 * Split CSV/TSV text into rows. Only the first `limit` data rows are kept,
 * but the scan runs to the end so `total` is the real row count — the card's
 * "sampled 60/200" badge depends on it.
 */
function parseDelimited(text, delimiter, limit = MAX_ROWS_PER_TABLE) {
  const rows = [];
  let total = 0;
  let row = [];
  let cell = '';
  let quoted = false;
  const pushRow = () => {
    row.push(cell);
    if (row.some((item) => item.trim() !== '')) {
      total += 1;
      if (rows.length < limit + 1) rows.push(row);
    }
    row = [];
    cell = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') pushRow();
    else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length > 0) pushRow();
  return { rows, total };
}

function fromMatrix(rows, title, source, totalRows = 0, ref = null, limit = MAX_ROWS_PER_TABLE) {
  const header = rows[0];
  if (!header || header.length < 2) return null;
  const columns = header.slice(0, MAX_COLUMNS).map((cell) => clip(cell, 40));
  if (columns.filter(Boolean).length < 2) return null;
  const body = rows
    .slice(1, limit + 1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => fitRow(row, columns.length));
  if (body.length === 0) return null;
  return {
    title: clip(title, 60),
    source,
    columns,
    rows: body,
    totalRows: totalRows > 0 ? totalRows : body.length,
    ...(ref ? { ref } : {}),
  };
}

/* ---------------- markdown ---------------- */

function splitMarkdownRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isSeparatorRow(line) {
  const text = line.trim();
  if (!text.includes('|') || !text.includes('-')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(text);
}

function fromMarkdown(text, title, source, ref = null, limit = MAX_ROWS_PER_FILE) {
  const lines = String(text ?? '').split(/\r?\n/);
  const tables = [];
  for (let index = 0; index < lines.length - 1 && tables.length < 3; index += 1) {
    const header = lines[index];
    if (!header.includes('|') || isSeparatorRow(header)) continue;
    if (!isSeparatorRow(lines[index + 1])) continue;
    const columns = splitMarkdownRow(header).slice(0, MAX_COLUMNS);
    if (columns.length < 2) continue;
    const body = [];
    let cursor = index + 2;
    for (; cursor < lines.length && body.length < limit; cursor += 1) {
      const line = lines[cursor];
      if (!line.includes('|') || !line.trim()) break;
      if (isSeparatorRow(line)) break;
      const cells = splitMarkdownRow(line);
      if (cells.length < 2) break;
      body.push(cells);
    }
    if (body.length === 0) continue;
    const table = fromMatrix([columns, ...body], title, source, body.length, ref, limit);
    if (table) tables.push(table);
    index = cursor - 1;
  }
  return tables;
}

/* ---------------- JSON ---------------- */

function fromJson(text, title, source, ref = null, limit = MAX_ROWS_PER_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const container = parsed;
  const list = Array.isArray(container)
    ? container
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.rows)
        ? container.rows
        : Array.isArray(container?.items)
          ? container.items
          : [];
  const records = list.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (records.length === 0) return [];

  const columns = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key);
    }
  }
  if (columns.length < 2) return [];
  const body = records.slice(0, limit).map((record) => columns.map((key) => record[key]));
  const table = fromMatrix([columns, ...body], title, source, records.length, ref, limit);
  return table ? [table] : [];
}

/* ---------------- Excel ---------------- */

function excelCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return excelCell(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
    if ('text' in value) return String(value.text ?? '');
    if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '');
    return '';
  }
  return String(value);
}

async function fromExcel(file, name, source, ref = null, limit = MAX_ROWS_PER_FILE) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const tables = [];
  for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const matrix = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (matrix.length > limit) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      matrix.push(values.map(excelCell));
    });
    if (matrix.length < 2) continue;
    const label = workbook.worksheets.length > 1 ? `${name} · ${sheet.name}` : name;
    const table = fromMatrix(
      matrix,
      label,
      `${source}${sheet.rowCount > matrix.length ? `（抽样 ${matrix.length - 1}/${Math.max(0, sheet.rowCount - 1)} 行）` : ''}`,
      Math.max(0, sheet.rowCount - 1),
      ref ? { ...ref, sheet: sheet.name } : null,
      limit,
    );
    if (table) tables.push(table);
    if (tables.length >= 4) break;
  }
  return tables;
}

/* ---------------- SQLite ---------------- */

function sqliteValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return '<二进制>';
  return String(value);
}

function fromSqlite(file, name, source, ref = null, limit = MAX_ROWS_PER_FILE) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return [];
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const tables = [];
    for (const tableName of names.slice(0, MAX_SQLITE_TABLES)) {
      const quoted = tableName.replace(/"/g, '""');
      let total = 0;
      try {
        total = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).get()?.n ?? 0);
      } catch {
        continue;
      }
      let rows = [];
      try {
        rows = db.prepare(`SELECT * FROM "${quoted}" LIMIT ${limit}`).all();
      } catch {
        continue;
      }
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]).slice(0, MAX_COLUMNS);
      if (columns.length < 2) continue;
      const matrix = [columns, ...rows.map((row) => columns.map((key) => sqliteValue(row[key])))];
      const note = total > rows.length ? `（抽样 ${rows.length}/${total} 行）` : `（${total} 行）`;
      const table = fromMatrix(
        matrix,
        `${name} · ${tableName}`,
        `${source}${note}`,
        total,
        ref ? { ...ref, table: tableName } : null,
        limit,
      );
      if (table) tables.push(table);
      if (tables.length >= MAX_SQLITE_TABLES) break;
    }
    return tables;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/* ---------------- files ---------------- */

async function walk(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_ENTRIES) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen >= MAX_ENTRIES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.')) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!PRIORITY.has(ext)) continue;
      found.push({ file: full, rel: path.relative(root, full).split(path.sep).join('/'), ext });
    }
  }
  found.sort((a, b) => PRIORITY.get(a.ext) - PRIORITY.get(b.ext) || a.rel.localeCompare(b.rel));
  return found;
}

async function parseFile(entry) {
  const stat = await fs.stat(entry.file);
  const name = path.basename(entry.rel).replace(/\.[^.]+$/, '');
  const source = `文件：${entry.rel}`;
  const ref = { rel: entry.rel };

  if (entry.ext === '.xlsx' || entry.ext === '.xlsm') {
    if (stat.size > MAX_EXCEL_BYTES) return [];
    return fromExcel(entry.file, name, source, { ...ref, kind: 'xlsx' });
  }
  if (entry.ext === '.sqlite' || entry.ext === '.sqlite3' || entry.ext === '.db') {
    if (stat.size > MAX_SQLITE_BYTES) return [];
    return fromSqlite(
      entry.file,
      name,
      source.replace(/^文件：/, '数据库：'),
      { ...ref, kind: 'sqlite' },
    );
  }
  if (stat.size > MAX_TEXT_BYTES) return [];

  const text = (await fs.readFile(entry.file, 'utf8')).replace(/^﻿/, '');
  if (!text.trim()) return [];
  if (entry.ext === '.csv' || entry.ext === '.tsv') {
    const { rows, total } = parseDelimited(text, guessDelimiter(text, entry.rel), MAX_ROWS_PER_TABLE);
    const table = fromMatrix(
      rows,
      name,
      source,
      Math.max(0, total - 1),
      { ...ref, kind: 'csv' },
      MAX_ROWS_PER_TABLE,
    );
    return table ? [table] : [];
  }
  if (entry.ext === '.json') return fromJson(text, name, source, { ...ref, kind: 'json' });
  return fromMarkdown(text, name, source, { ...ref, kind: 'md' });
}

/**
 * Files that share the same header are the same dataset split across outputs
 * (52 workbooks → one sample), so they are merged instead of crowding out the
 * other tables.
 */
function mergeSameShape(parsed) {
  const groups = new Map();
  for (const table of parsed) {
    const key = table.columns.join('\u0001');
    const group = groups.get(key);
    if (group) {
      group.rows.push(...table.rows);
      group.files.push(table.source);
      group.totals += table.totalRows ?? table.rows.length;
      if (table.ref) group.refs.push(table.ref);
    } else {
      groups.set(key, {
        title: table.title,
        columns: table.columns,
        rows: [...table.rows],
        files: [table.source],
        totals: table.totalRows ?? table.rows.length,
        refs: table.ref ? [table.ref] : [],
      });
    }
  }
  const merged = [];
  for (const group of groups.values()) {
    const rows = group.rows.slice(0, MAX_ROWS_PER_TABLE);
    const sampled = group.totals > rows.length;
    // "抽样 60/120 行" tells the model how much of the file it is seeing, and
    // gives the card its "查看全部" label.
    const sampleNote = `（抽样 ${rows.length}/${group.totals} 行）`;
    const source =
      group.files.length > 1
        ? `${group.files[0]} 等 ${group.files.length} 个同结构文件${sampled ? sampleNote : ''}`
        : `${group.files[0]}${sampled && !group.files[0].includes('抽样') ? sampleNote : ''}`;
    merged.push({
      title: group.files.length > 1 ? `${group.title} 等 ${group.files.length} 个文件` : group.title,
      source,
      columns: group.columns,
      rows,
      refs: group.refs,
      total: group.totals,
    });
  }
  return merged;
}

/** Returns `[{ id, title, source, columns, rows }]`, bounded and read-only. */
async function collectWorkspaceTables(root) {
  const files = await walk(root);
  const parsed = [];
  let read = 0;
  for (const entry of files) {
    if (read >= MAX_FILES || parsed.length >= MAX_TABLES * 3) break;
    const tables = await parseFile(entry).catch(() => []);
    if (tables.length > 0) read += 1;
    parsed.push(...tables);
  }
  return mergeSameShape(parsed)
    .slice(0, MAX_TABLES)
    .map((table, index) => ({ id: `f${index + 1}`, ...table }));
}

/* ---------------- on demand: every row ---------------- */

async function readAllTables(full, rel, ext, limit) {
  const name = path.basename(rel).replace(/\.[^.]+$/, '');
  if (ext === '.xlsx' || ext === '.xlsm') {
    return fromExcel(full, name, `文件：${rel}`, null, limit);
  }
  if (ext === '.sqlite' || ext === '.sqlite3' || ext === '.db') {
    return fromSqlite(full, name, `数据库：${rel}`, null, limit);
  }
  const text = (await fs.readFile(full, 'utf8')).replace(/^﻿/, '');
  if (ext === '.csv' || ext === '.tsv') {
    const { rows, total } = parseDelimited(text, guessDelimiter(text, rel), limit);
    const table = fromMatrix(rows, name, `文件：${rel}`, Math.max(0, total - 1), null, limit);
    return table ? [table] : [];
  }
  if (ext === '.json') return fromJson(text, name, `文件：${rel}`, null, limit);
  return fromMarkdown(text, name, `文件：${rel}`, null, limit);
}

/**
 * Re-read the files behind a sampled table, without the sampling caps.
 *
 * `refs` are the descriptors the collector attached (relative path plus the
 * sheet / sqlite table it came from). Anything that resolves outside the
 * workspace root is refused, so a crafted ref cannot read other files.
 */
async function readTableRows(root, refs, limit = MAX_ALL_ROWS) {
  const rootPath = path.resolve(root);
  const columns = [];
  const rows = [];
  let total = 0;
  for (const ref of Array.isArray(refs) ? refs.slice(0, MAX_FILES) : []) {
    if (rows.length >= limit) break;
    const rel = String(ref?.rel ?? '');
    if (!rel) continue;
    const full = path.resolve(rootPath, rel);
    if (!full.startsWith(rootPath + path.sep)) continue;
    const ext = path.extname(full).toLowerCase();
    if (!PRIORITY.has(ext)) continue;
    let tables;
    try {
      const stat = await fs.stat(full);
      const cap = ext === '.xlsx' || ext === '.xlsm' ? MAX_EXCEL_BYTES : ext === '.db' || ext === '.sqlite' || ext === '.sqlite3' ? MAX_SQLITE_BYTES : MAX_TEXT_BYTES;
      if (stat.size > cap) continue;
      tables = await readAllTables(full, rel, ext, Math.max(1, limit - rows.length));
    } catch {
      continue;
    }
    const wanted = ref.sheet ?? ref.table;
    const table =
      (wanted ? tables.find((item) => item.title.endsWith(wanted)) : null) ?? tables[0];
    if (!table) continue;
    if (columns.length === 0) columns.push(...table.columns);
    total += table.totalRows ?? table.rows.length;
    for (const row of table.rows) {
      if (rows.length >= limit) break;
      rows.push(row);
    }
  }
  if (columns.length === 0) return null;
  return { columns, rows, total: Math.max(total, rows.length), truncated: rows.length >= limit };
}

module.exports = { collectWorkspaceTables, readTableRows };
