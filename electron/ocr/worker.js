/**
 * OCR worker. Runs in an Electron utility process on purpose: sherpa-onnx
 * (voice input) ships its own onnxruntime.dll, and once that DLL is loaded in
 * the main process, onnxruntime-node's binding refuses to load beside it. A
 * separate process also keeps multi-second PDF recognition off the UI thread.
 */

const engine = require('./engine');
const uiText = require('../ui-text');

async function handle(request) {
  const { id, type } = request;

  try {
    if (type === 'image') {
      const text = await engine.recognizeImage(request.filePath);
      process.parentPort.postMessage({ id, ok: true, text });
      return;
    }

    if (type === 'pdf') {
      const result = await engine.recognizePdf(request.filePath, request.options ?? {});
      process.parentPort.postMessage({
        id,
        ok: true,
        pages: result.pages,
        totalPages: result.totalPages,
        truncated: result.truncated,
      });
      return;
    }

    throw new Error(uiText.t('main.ocr.error.unknownRequest', { type }));
  } catch (error) {
    process.parentPort.postMessage({
      id,
      ok: false,
      error: error?.message || String(error),
    });
  }
}

// Inference sessions are shared between requests, so run them one at a time.
let queue = Promise.resolve();
process.parentPort.on('message', (event) => {
  queue = queue.then(() => handle(event.data ?? {})).catch(() => {});
});
