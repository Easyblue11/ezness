/**
 * Main-process front end for the OCR worker. Requests are serialised through
 * one utility process; if it dies, the next request starts a fresh one.
 */

const path = require('node:path');
const { utilityProcess } = require('electron');
const uiText = require('../ui-text');

const REQUEST_TIMEOUT = 300_000;

class OcrService {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
  }

  ensureChild() {
    if (this.child) return this.child;

    const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
      serviceName: 'Ezness OCR',
      stdio: 'inherit',
    });

    child.on('message', (message) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message);
      } else {
        pending.reject(new Error(message.error || uiText.t('main.ocr.error.failed')));
      }
    });

    child.on('exit', (code) => {
      const error = new Error(
        uiText.t('main.ocr.error.processExited', {
          code: code ?? uiText.t('main.ocr.error.unknownCode'),
        }),
      );
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      if (this.child === child) this.child = null;
    });

    this.child = child;
    return child;
  }

  request(payload) {
    const child = this.ensureChild();
    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(uiText.t('main.ocr.error.timeout')));
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        if (this.child === child) this.child = null;
      }, REQUEST_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      child.postMessage({ ...payload, id });
    });
  }

  async recognizeImage(filePath) {
    const result = await this.request({ type: 'image', filePath });
    return result.text ?? '';
  }

  async recognizePdf(filePath, options = {}) {
    const result = await this.request({ type: 'pdf', filePath, options });
    return {
      pages: result.pages ?? [],
      totalPages: result.totalPages ?? (result.pages?.length ?? 0),
      truncated: Boolean(result.truncated),
    };
  }

  dispose() {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(uiText.t('main.ocr.error.appQuitting')));
    }
    try {
      this.child?.kill();
    } catch {
      /* nothing to stop */
    }
    this.child = null;
  }
}

module.exports = { OcrService };
