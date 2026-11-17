/**
 * Microphone capture for voice input.
 *
 * Everything downstream (Silero VAD, SenseVoice) expects 16 kHz mono PCM, so
 * the AudioContext is created at 16 kHz and Chromium resamples the device
 * stream. Chunks are batched to ~100 ms, which keeps IPC and VAD calls cheap.
 */

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

const WORKLET_SOURCE = `
class EznessCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CHUNK_SAMPLES});
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let read = 0;
    while (read < input.length) {
      const take = Math.min(this.buffer.length - this.offset, input.length - read);
      this.buffer.set(input.subarray(read, read + take), this.offset);
      this.offset += take;
      read += take;
      if (this.offset === this.buffer.length) {
        const ready = this.buffer;
        this.port.postMessage(ready, [ready.buffer]);
        this.buffer = new Float32Array(${CHUNK_SAMPLES});
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('ezness-capture', EznessCapture);
`;

export interface VoiceCaptureHandle {
  stop: () => Promise<void>;
}

async function openStream(deviceId: string): Promise<{ stream: MediaStream; usedDefault: boolean }> {
  const base: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (deviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: deviceId } },
      });
      return { stream, usedDefault: false };
    } catch (error) {
      // The saved device may be unplugged; fall back to the system default.
      if ((error as DOMException)?.name !== 'OverconstrainedError') throw error;
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: base });
  return { stream, usedDefault: Boolean(deviceId) };
}

function toChunks(samples: Float32Array, onChunk: (chunk: Float32Array) => void) {
  for (let start = 0; start < samples.length; start += CHUNK_SAMPLES) {
    onChunk(samples.slice(start, Math.min(start + CHUNK_SAMPLES, samples.length)));
  }
}

export interface VoiceCaptureOptions {
  deviceId: string;
  onChunk: (samples: Float32Array) => void;
}

export async function startVoiceCapture({
  deviceId,
  onChunk,
}: VoiceCaptureOptions): Promise<VoiceCaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风采集');
  }

  const { stream } = await openStream(deviceId);
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);

  // Mic → zero-gain sink keeps the graph running without echoing to speakers.
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);

  let node: AudioWorkletNode | ScriptProcessorNode | null = null;
  let onProcess: ((event: AudioProcessingEvent) => void) | null = null;
  let objectUrl = '';

  try {
    objectUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(objectUrl);
    const worklet = new AudioWorkletNode(context, 'ezness-capture');
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data);
    source.connect(worklet);
    worklet.connect(sink);
    node = worklet;
  } catch {
    // Older Chromium builds without AudioWorklet: ScriptProcessor still works.
    const processor = context.createScriptProcessor(4096, 1, 1);
    onProcess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      toChunks(new Float32Array(input), onChunk);
    };
    processor.onaudioprocess = onProcess;
    source.connect(processor);
    processor.connect(sink);
    node = processor;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  if (context.state === 'suspended') await context.resume();

  if (context.sampleRate !== SAMPLE_RATE) {
    await context.close().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(`音频设备不支持 16 kHz 采集（实际 ${context.sampleRate} Hz）`);
  }

  return {
    async stop() {
      if (node instanceof AudioWorkletNode) node.port.onmessage = null;
      if (node instanceof ScriptProcessorNode) node.onaudioprocess = null;
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        node?.disconnect();
      } catch {
        /* already disconnected */
      }
      sink.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
    },
  };
}

/** Convert Float32 [-1, 1] to little-endian Int16 PCM. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}
