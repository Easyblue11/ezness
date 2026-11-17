/**
 * Local speech recognition.
 *
 * Silero VAD cuts the microphone stream into utterances, then SenseVoiceSmall
 * (INT8 ONNX) transcribes each utterance. Both run through sherpa-onnx in this
 * process; audio never leaves the machine.
 *
 * Decoding is async (`decodeAsync`) so a 10s utterance does not block the main
 * process event loop.
 */

const path = require('node:path');
const sherpa = require('sherpa-onnx-node');
const { modelDir, status } = require('./models');

const SAMPLE_RATE = 16000;
const MIN_SEGMENT_SECONDS = 0.2;

class VoiceEngine {
  /**
   * @param {{root: string, emit: (event: object) => void}} options
   */
  constructor({ root, emit }) {
    this.root = root;
    this.emit = emit;
    this.recognizer = null;
    this.loading = null;
    this.session = null;
    this.queue = Promise.resolve();
  }

  status() {
    return status(this.root);
  }

  async ensureRecognizer() {
    if (this.recognizer) return this.recognizer;
    if (this.loading) return this.loading;

    const info = status(this.root);
    if (!info.ready) {
      throw new Error('语音模型还没有下载，请到「设置 → 语音配置」下载后再试。');
    }

    this.emit({ type: 'loading', message: '正在加载语音模型…' });
    const dir = modelDir(this.root);

    this.loading = (async () => {
      const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: path.join(dir, 'sensevoice', 'model.int8.onnx'),
            language: 'auto',
            useInverseTextNormalization: 1,
          },
          tokens: path.join(dir, 'sensevoice', 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      });
      this.recognizer = recognizer;
      return recognizer;
    })().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  createVad() {
    const dir = modelDir(this.root);
    return new sherpa.Vad(
      {
        sileroVad: {
          model: path.join(dir, 'silero_vad.onnx'),
          threshold: 0.5,
          minSilenceDuration: 0.6,
          minSpeechDuration: 0.25,
          maxSpeechDuration: 30,
          windowSize: 512,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      120,
    );
  }

  /** Drop the current session without waiting for queued transcripts. */
  discard() {
    if (this.session) {
      this.session.canceled = true;
      this.session = null;
    }
  }

  async start() {
    await this.ensureRecognizer();
    this.discard();

    const session = {
      vad: this.createVad(),
      speech: false,
      canceled: false,
    };
    this.session = session;
    this.emit({ type: 'started' });
    return { ok: true };
  }

  /** @param {ArrayBuffer} buffer little-endian Int16 PCM at 16 kHz */
  push(buffer) {
    const session = this.session;
    if (!session) return false;

    const int16 = new Int16Array(buffer);
    const samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) samples[i] = int16[i] / 32768;

    try {
      session.vad.acceptWaveform(samples);

      const detected = session.vad.isDetected();
      if (detected !== session.speech) {
        session.speech = detected;
        this.emit({ type: detected ? 'speech-start' : 'speech-end' });
      }

      this.drain(session);
    } catch (error) {
      this.emit({ type: 'error', error: `音频处理失败：${error?.message || error}` });
    }
    return true;
  }

  drain(session) {
    const vad = session.vad;
    while (!vad.isEmpty()) {
      // false = regular JS buffer. The external-buffer path is rejected when
      // the addon runs inside Electron's main process.
      const segment = vad.front(false);
      const samples = Float32Array.from(segment.samples);
      vad.pop();
      if (samples.length >= SAMPLE_RATE * MIN_SEGMENT_SECONDS) this.decode(session, samples);
    }
  }

  decode(session, samples) {
    this.queue = this.queue.then(async () => {
      if (session.canceled || !this.recognizer) return;
      try {
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        const result = await this.recognizer.decodeAsync(stream);
        const text = String(result?.text ?? '').trim();
        if (text && !session.canceled) {
          this.emit({ type: 'final', text, seconds: samples.length / SAMPLE_RATE });
        }
      } catch (error) {
        if (!session.canceled) {
          this.emit({ type: 'error', error: `识别失败：${error?.message || error}` });
        }
      }
    });
    return this.queue;
  }

  async stop() {
    const session = this.session;
    if (!session) return { ok: true };
    this.session = null;

    try {
      session.vad.flush();
    } catch {
      /* nothing buffered */
    }
    try {
      this.drain(session);
    } catch (error) {
      this.emit({ type: 'error', error: `音频处理失败：${error?.message || error}` });
    }
    await this.queue;
    this.emit({ type: 'stopped' });
    return { ok: true };
  }

  cancel() {
    this.discard();
    this.emit({ type: 'stopped' });
    return { ok: true };
  }
}

module.exports = { VoiceEngine, SAMPLE_RATE };
