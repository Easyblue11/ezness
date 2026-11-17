import type { WorkspaceVizTable } from '../types';

/**
 * Deterministic table extraction for the visualization tool.
 *
 * The model is good at *choosing* a chart but bad at copying numbers out of
 * prose, so tables are parsed here first and handed over as structured rows.
 * Everything is bounded: a runaway transcript cannot produce an endless table.
 */

const MAX_TABLES = 8;
const MAX_ROWS = 40;
const MAX_COLUMNS = 12;
const MAX_CELL = 80;
const MAX_TITLE = 60;

function clipCell(value: unknown): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_CELL) return text;
  return `${text.slice(0, MAX_CELL)}…`;
}

function clipTitle(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= MAX_TITLE ? text : `${text.slice(0, MAX_TITLE)}…`;
}

function splitMarkdownRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isSeparatorRow(line: string): boolean {
  const text = line.trim();
  if (!text.includes('|') || !text.includes('-')) return false;
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(text);
}

function fitColumns(cells: string[], count: number): string[] {
  const row: string[] = [];
  for (let index = 0; index < count; index += 1) row.push(clipCell(cells[index]));
  return row;
}

/** Nearest short line above a table often names it ("表 1 各国疫情数据"). */
function captionBefore(lines: string[], index: number): string {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 3); cursor -= 1) {
    const text = lines[cursor].trim();
    if (!text) continue;
    if (text.includes('|')) return '';
    if (text.length <= 40 && /(：|:|表\s*\d|数据|统计)/.test(text)) return clipTitle(text);
    return '';
  }
  return '';
}

export function extractMarkdownTables(text: string, source: string): WorkspaceVizTable[] {
  const lines = String(text ?? '').split(/\r?\n/);
  const tables: WorkspaceVizTable[] = [];
  for (let index = 0; index < lines.length - 1 && tables.length < MAX_TABLES; index += 1) {
    const header = lines[index];
    if (!header.includes('|') || isSeparatorRow(header)) continue;
    if (!isSeparatorRow(lines[index + 1])) continue;
    const columns = splitMarkdownRow(header).map(clipCell).slice(0, MAX_COLUMNS);
    if (columns.length < 2 || columns.every((column) => !column)) continue;

    const rows: string[][] = [];
    let cursor = index + 2;
    for (; cursor < lines.length && rows.length < MAX_ROWS; cursor += 1) {
      const line = lines[cursor];
      if (!line.includes('|') || !line.trim()) break;
      if (isSeparatorRow(line)) break;
      const cells = splitMarkdownRow(line);
      if (cells.length < 2) break;
      rows.push(fitColumns(cells, columns.length));
    }
    if (rows.length === 0) continue;

    tables.push({
      id: '',
      title: captionBefore(lines, index) || `表格 ${tables.length + 1}`,
      source,
      columns,
      rows,
    });
    index = cursor - 1;
  }
  return tables;
}

function guessDelimiter(text: string, name: string): string {
  if (/\.tsv$/i.test(name)) return '\t';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > 0) return '\t';
  if (semicolons > commas && semicolons > 0) return ';';
  return ',';
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const pushRow = () => {
    row.push(cell);
    if (row.some((item) => item.trim() !== '')) rows.push(row);
    row = [];
    cell = '';
  };
  for (let index = 0; index < text.length && rows.length <= MAX_ROWS + 1; index += 1) {
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
  return rows;
}

function fromRows(rows: string[][], title: string, source: string): WorkspaceVizTable | null {
  const header = rows[0];
  if (!header || header.length < 2) return null;
  const columns = header.slice(0, MAX_COLUMNS).map(clipCell);
  const body = rows
    .slice(1, MAX_ROWS + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => fitColumns(row, columns.length));
  if (body.length === 0) return null;
  return { id: '', title: clipTitle(title), source, columns, rows: body };
}

/** JSON: an array of records (or {data|rows|items: [...]}) becomes a table. */
function fromJsonRecords(text: string, title: string, source: string): WorkspaceVizTable[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const container = parsed as Record<string, unknown> | unknown[];
  const list = Array.isArray(container)
    ? container
    : Array.isArray((container as Record<string, unknown>)?.data)
      ? ((container as Record<string, unknown>).data as unknown[])
      : Array.isArray((container as Record<string, unknown>)?.rows)
        ? ((container as Record<string, unknown>).rows as unknown[])
        : Array.isArray((container as Record<string, unknown>)?.items)
          ? ((container as Record<string, unknown>).items as unknown[])
          : [];
  const records = list.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
  );
  if (records.length === 0) return [];

  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key);
    }
  }
  if (columns.length < 2) return [];
  const rows = records.slice(0, MAX_ROWS).map((record) =>
    columns.map((key) => {
      const value = record[key];
      return clipCell(value === null || value === undefined ? '' : value);
    }),
  );
  return [{ id: '', title: clipTitle(title), source, columns: columns.map(clipCell), rows }];
}

/** Parse a file read back through `workspaceReadFile`, by extension. */
export function parseTableFile(content: string, name: string): WorkspaceVizTable[] {
  const text = String(content ?? '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const source = `文件：${name}`;
  const base = name.replace(/\.[^.]+$/, '');

  if (/\.json$/i.test(name)) {
    const tables = fromJsonRecords(text, base, source);
    if (tables.length > 0) return tables;
  }
  if (/\.(csv|tsv)$/i.test(name)) {
    const table = fromRows(parseDelimited(text, guessDelimiter(text, name)), base, source);
    return table ? [table] : [];
  }
  if (/\.(md|markdown|txt)$/i.test(name)) return extractMarkdownTables(text, source);
  return [];
}

/** Stable signature so the same table mentioned twice is only sent once. */
function signature(table: WorkspaceVizTable): string {
  return `${table.columns.join('\u0001')}\u0002${table.rows[0]?.join('\u0001') ?? ''}`;
}

export function mergeTables(...groups: WorkspaceVizTable[][]): WorkspaceVizTable[] {
  const merged: WorkspaceVizTable[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const table of group) {
      const key = signature(table);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...table, id: `t${merged.length + 1}` });
      if (merged.length >= MAX_TABLES) return merged;
    }
  }
  return merged;
}
