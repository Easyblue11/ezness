/**
 * Sidecar vector index for Agent long-term memory.
 *
 * The memory store itself stays human-readable JSON. Vectors live next to it
 * in <agentId>.vectors.json, quantized to int8: a 1024-dimension entry costs
 * ~1.4 KB instead of ~7 KB, and a small store stays small on disk. Each record
 * carries a hash of title+content, so only new or edited entries are embedded
 * again — the rest of the index is reused.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
// Long memories are summarized anyway; embedding beyond this only adds cost.
const MAX_EMBED_CHARS = 2000;

function vectorsPath(agentDir, agentId) {
  if (!agentDir || !agentId) return null;
  return path.join(agentDir, 'memories', `${agentId}.vectors.json`);
}

function entryHash(entry) {
  return crypto
    .createHash('sha256')
    .update(`${entry?.title ?? ''}\n${entry?.content ?? ''}`)
    .digest('hex')
    .slice(0, 20);
}

function emptyIndex(model = '') {
  return { version: VERSION, model, dim: 0, entries: {} };
}

async function loadIndex(agentDir, agentId) {
  const file = vectorsPath(agentDir, agentId);
  if (!file) return emptyIndex();
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw?.version !== VERSION || !raw.entries || typeof raw.entries !== 'object') {
      return emptyIndex();
    }
    return raw;
  } catch {
    // Missing or torn file: rebuild from the memory store on the next search.
    return emptyIndex();
  }
}

async function saveIndex(agentDir, agentId, index) {
  const file = vectorsPath(agentDir, agentId);
  if (!file) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(
    temp,
    JSON.stringify({ ...index, updatedAt: Date.now() }),
    'utf8',
  );
  await fs.rename(temp, file);
  return true;
}

function encodeVector(vector) {
  const source = vector instanceof Float32Array ? vector : Float32Array.from(vector ?? []);
  let max = 0;
  for (let i = 0; i < source.length; i += 1) max = Math.max(max, Math.abs(source[i]));
  if (!source.length || max === 0) return { scale: 0, dim: source.length, data: '' };
  const scale = max / 127;
  const bytes = new Int8Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round(source[i] / scale)));
  }
  return {
    scale,
    dim: source.length,
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  };
}

function decodeVector(record) {
  if (!record?.data || !record.scale) return null;
  const buffer = Buffer.from(record.data, 'base64');
  if (!buffer.byteLength) return null;
  const bytes = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const vector = new Float32Array(bytes.length);
  let norm = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    vector[i] = bytes[i] * record.scale;
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/**
 * Bring the index in line with `entries` (already filtered to searchable
 * ones). Throws when the embedding service fails, so the caller can fall back
 * to keyword search instead of serving a half-built index.
 */
async function ensureVectors(index, entries, { model, embed, batchSize = 8 } = {}) {
  if (!model) throw new Error('还没有配置向量模型');
  if (typeof embed !== 'function') throw new Error('embed 未注入');

  const usable = Array.isArray(entries) ? entries : [];
  let changed = false;

  if (index.model !== model) {
    index.model = model;
    index.entries = {};
    index.dim = 0;
    changed = true;
  }

  const liveIds = new Set(usable.map((entry) => entry.id));
  for (const id of Object.keys(index.entries)) {
    if (!liveIds.has(id)) {
      delete index.entries[id];
      changed = true;
    }
  }

  const missing = usable.filter((entry) => index.entries[entry.id]?.hash !== entryHash(entry));
  let embedded = 0;
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const texts = batch.map((entry) =>
      `${entry.title ?? ''}\n${entry.content ?? ''}`.slice(0, MAX_EMBED_CHARS),
    );
    const vectors = await embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error('向量数量与记忆条数不一致');
    }
    vectors.forEach((vector, offset) => {
      const entry = batch[offset];
      const encoded = encodeVector(vector);
      index.entries[entry.id] = { hash: entryHash(entry), ...encoded };
      if (encoded.dim) index.dim = encoded.dim;
    });
    embedded += batch.length;
    changed = true;
  }

  return { embedded, changed };
}

function vectorMap(index) {
  const map = new Map();
  for (const [id, record] of Object.entries(index?.entries ?? {})) {
    const vector = decodeVector(record);
    if (vector) map.set(id, vector);
  }
  return map;
}

module.exports = {
  VERSION,
  vectorsPath,
  entryHash,
  emptyIndex,
  loadIndex,
  saveIndex,
  encodeVector,
  decodeVector,
  ensureVectors,
  vectorMap,
};
