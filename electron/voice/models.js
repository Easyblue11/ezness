/**
 * Voice model files: Silero VAD + SenseVoiceSmall (INT8 ONNX).
 *
 * The models are not shipped with the app. They are downloaded into the
 * app's userData on first use, from a HuggingFace mirror that is reachable
 * without extra tooling. Sizes below are the upstream file sizes and double as
 * a cheap integrity check.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { appFetch } = require('../app-net');
const uiText = require('../ui-text');

const MIRROR = 'https://hf-mirror.com';
const SENSE_VOICE_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

const FILES = [
  {
    key: 'sileroVad',
    labelKey: 'main.voice.model.sileroVad',
    url: `${MIRROR}/deepghs/silero-vad-onnx/resolve/main/silero_vad.onnx`,
    target: 'silero_vad.onnx',
    size: 2327524,
  },
  {
    key: 'senseVoiceModel',
    labelKey: 'main.voice.model.senseVoice',
    url: `${MIRROR}/${SENSE_VOICE_REPO}/resolve/main/model.int8.onnx`,
    target: path.join('sensevoice', 'model.int8.onnx'),
    // Model files may grow slightly across uploads; anything this large is the
    // real model. The exact size is only used as a reference for progress.
    minSize: 100 * 1024 * 1024,
    size: 239233841,
  },
  {
    key: 'senseVoiceTokens',
    labelKey: 'main.voice.model.tokens',
    url: `${MIRROR}/${SENSE_VOICE_REPO}/resolve/main/tokens.txt`,
    target: path.join('sensevoice', 'tokens.txt'),
    minSize: 100 * 1024,
    size: 315894,
  },
];

function modelDir(root) {
  return path.join(root, 'voice-models');
}

function labelOf(entry) {
  return uiText.t(entry.labelKey);
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function fileReady(entry, dir) {
  const size = fileSize(path.join(dir, entry.target));
  if (size === 0) return false;
  if (entry.minSize) return size >= entry.minSize;
  return size === entry.size;
}

function status(root) {
  const dir = modelDir(root);
  const files = FILES.map((entry) => {
    const target = path.join(dir, entry.target);
    const size = fileSize(target);
    return {
      key: entry.key,
      label: labelOf(entry),
      path: target,
      size,
      expected: entry.size,
      ready: fileReady(entry, dir),
    };
  });
  return {
    dir,
    ready: files.every((file) => file.ready),
    files,
  };
}

async function downloadOne(entry, dir, options) {
  const { onProgress, signal, log } = options;
  const target = path.join(dir, entry.target);
  const temp = `${target}.part`;
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // A previous attempt may have left a complete-but-unrenamed file.
  if (fileReady(entry, dir)) return;

  const label = labelOf(entry);
  log?.(`[voice] 下载 ${label} → ${target}`);
  const response = await appFetch(entry.url, { signal, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(uiText.t('main.voice.error.downloadFailed', { label, status: response.status }));
  }

  const total = Number(response.headers.get('content-length')) || entry.size;
  const handle = await fsp.open(temp, 'w');
  let received = 0;
  let lastReport = 0;

  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 300) {
        lastReport = now;
        onProgress?.({ file: entry.key, label, received, total });
      }
    }
  } finally {
    await handle.close();
  }

  if (received === 0) throw new Error(uiText.t('main.voice.error.downloadEmpty', { label }));
  await fsp.rename(temp, target);
  onProgress?.({ file: entry.key, label, received, total, done: true });
}

/**
 * Download every missing model file. Returns the fresh status, or throws with
 * a readable message so the settings page can show it.
 */
async function downloadMissing(root, options = {}) {
  const dir = modelDir(root);
  await fsp.mkdir(dir, { recursive: true });

  for (const entry of FILES) {
    if (fileReady(entry, dir)) {
      options.onProgress?.({
        file: entry.key,
        label: labelOf(entry),
        received: entry.size,
        total: entry.size,
        done: true,
      });
      continue;
    }
    await downloadOne(entry, dir, options);
  }

  return status(root);
}

module.exports = { FILES, modelDir, status, downloadMissing };
