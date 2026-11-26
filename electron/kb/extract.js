/**
 * File -> text. Every extractor returns the same shape:
 *   { pages: [{ page: number|null, text: string }] }
 * so the chunker never needs to know which parser ran.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const uiText = require('../ui-text');

const PLAIN_TEXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml',
  '.ini', '.xml', '.html', '.htm', '.js', '.ts', '.jsx', '.tsx', '.py', '.java',
  '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.sql', '.sh', '.ps1', '.css',
]);

/**
 * OOXML presentation packages. .pptm (macros), .ppsx (slideshow) and .potx
 * (template) share the slide XML layout, so the same reader handles them.
 */
const PRESENTATION = new Set(['.pptx', '.pptm', '.ppsx', '.potx']);

const SUPPORTED = new Set([
  '.pdf', '.docx', '.xlsx', '.xlsm', ...PRESENTATION,
  ...PLAIN_TEXT,
]);

function isSupported(filePath) {
  return SUPPORTED.has(path.extname(filePath).toLowerCase());
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  // pdfjs 6 removed PDFDocumentProxy.destroy(); the loading task owns teardown.
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    const pages = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      let text = '';
      let lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y ?? lastY;
      }
      pages.push({ page: index, text });
      page.cleanup();
    }
    return { pages };
  } finally {
    await loadingTask.destroy();
  }
}

async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return { pages: [{ page: null, text: result.value }] };
}

async function extractXlsx(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parts = [];
  workbook.eachSheet((sheet) => {
    parts.push(`\n# ${sheet.name}\n`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.value;
        if (value == null) {
          cells.push('');
        } else if (typeof value === 'object') {
          cells.push(value.text ?? value.result ?? value.richText?.map((r) => r.text).join('') ?? '');
        } else {
          cells.push(String(value));
        }
      });
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) parts.push(line);
    });
  });

  return { pages: [{ page: null, text: parts.join('\n') }] };
}

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** One line per DrawingML paragraph; <a:br/> starts a new line inside one. */
function drawingLines(xml) {
  const source = xml.replace(/<a:fld[\s\S]*?<\/a:fld>/gi, ''); // slide numbers etc.
  const paragraphs = source.match(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gi) ?? [source];
  const lines = [];

  for (const paragraph of paragraphs) {
    const runs = [];
    let line = '';
    for (const match of paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br(?:\s[^>]*)?\/?>/gi)) {
      if (match[0].toLowerCase().startsWith('<a:br')) {
        runs.push(line);
        line = '';
      } else {
        line += decodeXmlEntities(match[1]);
      }
    }
    runs.push(line);
    for (const run of runs) {
      const text = run.replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

/** Table rows as tab-separated cells, so columns stay readable. */
function tableLines(xml) {
  const lines = [];
  for (const row of xml.matchAll(/<a:tr(?:\s[^>]*)?>[\s\S]*?<\/a:tr>/gi)) {
    const cells = [];
    for (const cell of row[0].matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/gi)) {
      const cellText = drawingLines(cell[0]).join(' / ');
      cells.push(cellText);
    }
    if (cells.some(Boolean)) lines.push(cells.join('\t'));
  }
  return lines;
}

/** Slide text with tables kept in document order instead of flattened runs. */
function slideLines(xml) {
  const lines = [];
  for (const part of xml.split(/(<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>)/gi)) {
    if (/^<a:tbl/i.test(part)) lines.push(...tableLines(part));
    else lines.push(...drawingLines(part));
  }
  return lines;
}

/** Resolve presentation order from presentation.xml + its relationships. */
async function slidePaths(zip) {
  const ordered = [];
  const pres = zip.file('ppt/presentation.xml');
  const rels = zip.file('ppt/_rels/presentation.xml.rels');

  if (pres && rels) {
    const targets = new Map();
    for (const match of (await rels.async('string')).matchAll(/<Relationship\b[^>]*>/gi)) {
      const tag = match[0];
      const id = /\bId="([^"]+)"/i.exec(tag)?.[1];
      const target = /\bTarget="([^"]+)"/i.exec(tag)?.[1];
      const type = /\bType="([^"]+)"/i.exec(tag)?.[1];
      if (id && target && type && type.endsWith('/slide')) {
        const resolved = target.startsWith('/')
          ? target.slice(1)
          : path.posix.join('ppt', target);
        targets.set(id, path.posix.normalize(resolved));
      }
    }

    for (const match of (await pres.async('string')).matchAll(/<p:sldId\b[^>]*>/gi)) {
      const rid = /\br:id="([^"]+)"/i.exec(match[0])?.[1];
      const target = rid && targets.get(rid);
      if (target && zip.file(target) && !ordered.includes(target)) ordered.push(target);
    }
  }

  if (ordered.length > 0) return ordered;

  // Broken/missing relationships: fall back to slide1.xml, slide2.xml, …
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)[1]) - Number(/(\d+)\.xml$/i.exec(b)[1]));
}

/** Relationships of one slide part (notes, charts, diagrams, images, …). */
async function slideRelations(zip, slide) {
  const rels = zip.file(
    path.posix.join(path.posix.dirname(slide), '_rels', `${path.posix.basename(slide)}.rels`),
  );
  if (!rels) return [];

  const entries = [];
  for (const match of (await rels.async('string')).matchAll(/<Relationship\b[^>]*>/gi)) {
    const type = /\bType="([^"]+)"/i.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/i.exec(match[0])?.[1];
    if (!type || !target) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : path.posix.join(path.posix.dirname(slide), target);
    const normalized = path.posix.normalize(resolved);
    if (zip.file(normalized)) entries.push({ type, path: normalized });
  }
  return entries;
}

/** Values cached inside a chart part; falls back to nothing when absent. */
function chartCache(container, tag) {
  const block = new RegExp(`<c:${tag}(?:\\s[^>]*)?>[\\s\\S]*?</c:${tag}>`, 'i').exec(container);
  if (!block) return [];
  return [...block[0].matchAll(/<c:v(?:\s[^>]*)?>([\s\S]*?)<\/c:v>/gi)].map((match) =>
    decodeXmlEntities(match[1]).trim(),
  );
}

/**
 * Charts keep their data as cached XML, so read it directly: title, series
 * names, categories and values. Rendered chart pictures (no chart part) are
 * deliberately left alone.
 */
function chartLines(xml) {
  const lines = [];

  const titles = new Set();
  for (const match of xml.matchAll(/<c:title(?:\s[^>]*)?>[\s\S]*?<\/c:title>/gi)) {
    const text = drawingLines(match[0]).join(' ');
    if (text) titles.add(text);
  }
  if (titles.size > 0) lines.push(`【图表】${[...titles].join(' · ')}`);

  for (const match of xml.matchAll(/<c:ser(?:\s[^>]*)?>[\s\S]*?<\/c:ser>/gi)) {
    const series = match[0];
    const name = chartCache(series, 'tx')[0] ?? '';
    const categories = chartCache(series, 'cat');
    const values = chartCache(series, 'val');
    const pairs = [];
    for (let index = 0; index < Math.max(categories.length, values.length); index += 1) {
      const category = categories[index] ?? '';
      const value = values[index] ?? '';
      if (category || value) pairs.push(category ? `${category}：${value}` : value);
    }
    if (pairs.length === 0) continue;
    lines.push(`${name ? `${name}：` : ''}${pairs.join('，')}`);
  }

  return lines;
}

/** SmartArt keeps its text in a separate diagram data part. */
function diagramLines(xml) {
  return drawingLines(xml);
}

async function extractPresentation(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const slides = await slidePaths(zip);
  if (slides.length === 0) throw new Error(uiText.t('main.kb.error.noSlides'));

  const pages = [];
  for (const [index, slide] of slides.entries()) {
    const lines = slideLines(await zip.file(slide).async('string'));
    const relations = await slideRelations(zip, slide);

    const seen = new Set();
    for (const relation of relations) {
      if (seen.has(relation.path)) continue;
      seen.add(relation.path);

      if (relation.type.endsWith('/chart')) {
        const chart = chartLines(await zip.file(relation.path).async('string'));
        if (chart.length > 0) lines.push(...chart);
      } else if (relation.type.endsWith('/diagramData')) {
        const diagram = diagramLines(await zip.file(relation.path).async('string'));
        if (diagram.length > 0) lines.push('【图示】', ...diagram);
      }
    }

    const notes = relations.find((relation) => relation.type.endsWith('/notesSlide'));
    if (notes) {
      const noteLines = drawingLines(await zip.file(notes.path).async('string'));
      if (noteLines.length > 0) lines.push('【备注】', ...noteLines);
    }

    pages.push({ page: index + 1, text: lines.join('\n') });
  }

  return { pages };
}

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') return extractPdf(filePath);
  if (ext === '.docx') return extractDocx(filePath);
  if (ext === '.xlsx' || ext === '.xlsm') return extractXlsx(filePath);
  if (PRESENTATION.has(ext)) return extractPresentation(filePath);

  if (ext === '.xls') {
    throw new Error(uiText.t('main.kb.error.legacyXls'));
  }
  if (ext === '.doc') {
    throw new Error(uiText.t('main.kb.error.legacyDoc'));
  }
  if (ext === '.ppt' || ext === '.pps' || ext === '.pot') {
    throw new Error(uiText.t('main.kb.error.legacyPpt'));
  }

  if (PLAIN_TEXT.has(ext)) {
    const raw = await fs.readFile(filePath, 'utf8');
    const text = ext === '.html' || ext === '.htm' || ext === '.xml' ? stripHtml(raw) : raw;
    return { pages: [{ page: null, text }] };
  }

  throw new Error(
    uiText.t('main.kb.error.unsupportedType', { ext: ext || uiText.t('main.kb.unknownExtension') }),
  );
}

module.exports = { extract, isSupported, SUPPORTED };
