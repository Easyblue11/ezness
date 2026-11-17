/**
 * PP-OCRv5 mobile models ship with the app as a data-only npm dependency
 * (`pdfmarkdown-ppocrv5-models`), so there is nothing to download at runtime.
 * `status()` reads the three files from node_modules and reports whether OCR
 * can start; the settings page uses it to explain a broken install.
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'pdfmarkdown-ppocrv5-models';

const FILES = [
  {
    key: 'det',
    label: '文字检测模型',
    file: 'detection/PP-OCRv5_mobile_det_infer.ort',
    expected: 4_896_928,
    minSize: 4_000_000,
  },
  {
    key: 'rec',
    label: '文字识别模型',
    file: 'recognition/PP-OCRv5_mobile_rec_infer.onnx',
    expected: 16_559_278,
    minSize: 15_000_000,
  },
  {
    key: 'dict',
    label: '字符字典',
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
    throw new Error('没有找到 PP-OCRv5 模型包（pdfmarkdown-ppocrv5-models），请重新安装依赖');
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
      label: entry.label,
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
