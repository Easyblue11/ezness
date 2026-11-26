/**
 * PP-OCRv5 mobile models ship with the app as a data-only npm dependency
 * (`pdfmarkdown-ppocrv5-models`), so there is nothing to download at runtime.
 * `status()` reads the three files from node_modules and reports whether OCR
 * can start; the settings page uses it to explain a broken install.
 */

const fs = require('node:fs');
const path = require('node:path');
const uiText = require('../ui-text');

const PACKAGE = 'pdfmarkdown-ppocrv5-models';

const FILES = [
  {
    key: 'det',
    labelKey: 'main.ocr.model.det',
    file: 'detection/PP-OCRv5_mobile_det_infer.ort',
    expected: 4_896_928,
    minSize: 4_000_000,
  },
  {
    key: 'rec',
    labelKey: 'main.ocr.model.rec',
    file: 'recognition/PP-OCRv5_mobile_rec_infer.onnx',
    expected: 16_559_278,
    minSize: 15_000_000,
  },
  {
    key: 'dict',
    labelKey: 'main.ocr.model.dict',
    file: 'recognition/ppocrv5_dict.txt',
    expected: 74_014,
    minSize: 70_000,
  },
];

let cachedDir;

function packageDir() {
  if (cachedDir !== undefined) return cachedDir;
  try {
    cachedDir = path.dirname(require.resolve(`${PACKAGE}/package.json`));
  } catch {
    cachedDir = null;
  }
  return cachedDir;
}

function filePath(entry) {
  const dir = packageDir();
  return dir ? path.join(dir, entry.file) : '';
}

/** Absolute paths to the three model files. Throws when the package is missing. */
function paths() {
  const dir = packageDir();
  if (!dir) {
    throw new Error(uiText.t('main.ocr.error.packageMissing'));
  }
  return {
    dir,
    det: path.join(dir, FILES[0].file),
    rec: path.join(dir, FILES[1].file),
    dict: path.join(dir, FILES[2].file),
  };
}

function status() {
  const dir = packageDir();
  const files = FILES.map((entry) => {
    const file = entry.file;
    const full = dir ? path.join(dir, file) : '';
    let size = 0;
    if (full) {
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
    }
    return {
      key: entry.key,
      label: uiText.t(entry.labelKey),
      file,
      path: full,
      size,
      expected: entry.expected,
      ready: size >= entry.minSize,
    };
  });

  return {
    name: 'PaddleOCR PP-OCRv5 mobile',
    dir: dir ?? '',
    ready: files.every((file) => file.ready),
    files,
  };
}

module.exports = { status, paths, FILES, PACKAGE };
