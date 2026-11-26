/**
 * Local OCR built on PaddleOCR's PP-OCRv5 mobile models.
 *
 * Detection + recognition run in this process through onnxruntime-node; image
 * bytes are decoded with sharp, PDF pages are rasterised with pdfjs + napi-rs
 * canvas. Nothing leaves the machine.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const models = require('./models');
const uiText = require('../ui-text');

const DICT_LENGTH = 18_384;
const MIN_SCORE = 0.2;

let servicePromise = null;

/**
 * The redistributed dictionary has a stray blank line after the first entry
 * (and a trailing newline that looks like one). Dropping blanks and restoring
 * the trailing space yields the 18,384 entries the model's 18,385 CTC classes
 * expect: class 0 is blank, class i maps to dict[i - 1].
 */
function normalizeDictionary(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const entries = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line !== '');

  if (entries.length === DICT_LENGTH - 1) entries.push(' ');
  if (entries.length !== DICT_LENGTH) {
    throw new Error(
      uiText.t('main.ocr.error.dictLength', { actual: entries.length, expected: DICT_LENGTH }),
    );
  }
  return entries;
}

async function createService() {
  const paths = models.paths();
  const ort = require('onnxruntime-node');
  const { PaddleOcrService } = require('paddleocr');

  const detection = fsSync.readFileSync(paths.det);
  const recognition = fsSync.readFileSync(paths.rec);
  const dictionary = normalizeDictionary(fsSync.readFileSync(paths.dict, 'utf8'));

  return PaddleOcrService.createInstance({
    ort,
    modelPreset: 'PP-OCRv5_mobile',
    detection: { modelBuffer: detection },
    recognition: { modelBuffer: recognition, charactersDictionary: dictionary },
  });
}

function loadService() {
  if (!servicePromise) {
    servicePromise = createService().catch((error) => {
      console.error('[Ezness] OCR 模型加载失败：', {
        arch: process.arch,
        platform: process.platform,
        node: process.versions.node,
        electron: process.versions.electron,
        napi: process.versions.napi,
        execPath: process.execPath,
        runAsNode: process.env.ELECTRON_RUN_AS_NODE,
      }, error);
      servicePromise = null;
      throw error;
    });
  }
  return servicePromise;
}

function isReady() {
  return models.status().ready;
}

function isCjk(ch) {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function joinParts(parts) {
  let line = '';
  for (const part of parts) {
    if (!part) continue;
    if (line) {
      const before = line[line.length - 1];
      const after = part[0];
      if (!isCjk(before) && !isCjk(after)) line += ' ';
    }
    line += part;
  }
  return line;
}

/**
 * Put the flat detection boxes back into reading order. Boxes whose vertical
 * centres are close enough share a line; within a line they go left to right.
 */
function assembleText(results) {
  const items = (results ?? [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .filter((item) => (item.score ?? 1) >= MIN_SCORE)
    .map((item) => {
      const box = item.box ?? {};
      const height = box.height ?? 0;
      return {
        text: item.text.trim(),
        x: box.x ?? 0,
        cy: (box.y ?? 0) + height / 2,
        height,
      };
    })
    .sort((a, b) => a.cy - b.cy || a.x - b.x);

  const lines = [];
  for (const item of items) {
    const last = lines[lines.length - 1];
    const tolerance = Math.max(8, Math.min(item.height || 16, last?.height || 16) * 0.6);
    if (last && Math.abs(item.cy - last.cy) <= tolerance) {
      last.items.push(item);
      last.cy = last.items.reduce((sum, entry) => sum + entry.cy, 0) / last.items.length;
      last.height = Math.max(last.height, item.height);
    } else {
      lines.push({ cy: item.cy, height: item.height, items: [item] });
    }
  }

  return lines
    .map((line) =>
      joinParts(
        line.items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text),
      ),
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function recognizeRgb(service, image) {
  const results = await service.recognize({
    width: image.width,
    height: image.height,
    data: image.data,
  });
  return assembleText(results);
}

async function recognizeImage(filePath) {
  if (!isReady()) throw new Error(uiText.t('main.ocr.error.modelIncomplete'));
  const sharp = require('sharp');

  const { data, info } = await sharp(filePath, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) throw new Error(uiText.t('main.ocr.error.invalidImage'));
  const service = await loadService();
  return recognizeRgb(service, { data, width: info.width, height: info.height });
}

async function renderPage(doc, pageNumber) {
  const { createCanvas } = require('@napi-rs/canvas');
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    // Two passes are enough for print-sized pages; cap the long side so a
    // poster-sized scan does not allocate hundreds of megabytes.
    const scale = Math.min(2.5, 1800 / Math.max(base.width, base.height, 1));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport, canvas }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    };
  } finally {
    page.cleanup();
  }
}

/**
 * Rasterise up to `maxPages` pages and OCR each one. Returns page-tagged text
 * plus the real page count so the caller can say when it stopped early.
 * `maxPages === -1` (the default) means every page.
 */
async function recognizePdf(filePath, options = {}) {
  if (!isReady()) throw new Error(uiText.t('main.ocr.error.modelIncomplete'));
  const requested = Math.round(Number(options.maxPages));
  const maxPages =
    !Number.isFinite(requested) || requested <= 0 ? Infinity : Math.min(200, requested);

  // pdfjs decides between Node and browser mode from process.type. Electron's
  // utility process reports "utility" and would therefore demand a Worker URL;
  // this worker is Node-only, so present it as the browser (main) process.
  if (process.versions.electron && process.type === 'utility') {
    try {
      // `process.type` is a configurable but non-writable getter, so assign
      // through defineProperty rather than `process.type = ...`.
      Object.defineProperty(process, 'type', {
        value: 'browser',
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* fall through: pdfjs will report its worker error if this fails */
    }
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    const totalPages = doc.numPages;
    const pagesToRead = Math.min(maxPages, totalPages);
    const service = await loadService();
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      const image = await renderPage(doc, pageNumber);
      pages.push({ page: pageNumber, text: await recognizeRgb(service, image) });
    }

    return { pages, totalPages, truncated: totalPages > pagesToRead };
  } finally {
    await loadingTask.destroy();
  }
}

module.exports = { isReady, recognizeImage, recognizePdf, normalizeDictionary, assembleText };
