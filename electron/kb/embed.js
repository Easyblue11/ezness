/**
 * Ollama embedding client.
 *
 * Talks to /api/embed (batch endpoint). Vectors are L2-normalised on arrival so
 * search can use a plain dot product.
 */

const { appFetch } = require('../app-net');

function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function baseUrlOf(config) {
  return String(config?.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
}

async function embedBatch(texts, config) {
  const endpoint = `${baseUrlOf(config)}/api/embed`;
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const body = JSON.stringify({
    model: config.model,
    input: texts.map((text) => text.slice(0, 8000)),
    truncate: true,
    // Embedding models are tiny; keeping one warm avoids a ~1.7s reload on
    // the first knowledge-base query after idling.
    keep_alive: '30m',
  });

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await appFetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`向量服务返回 ${response.status}${detail ? ` · ${detail.slice(0, 160)}` : ''}`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);
      const embeddings = data.embeddings || (data.embedding ? [data.embedding] : []);
      if (embeddings.length !== texts.length) {
        throw new Error(`向量数量不匹配：期望 ${texts.length}，实际 ${embeddings.length}`);
      }
      return embeddings.map((vector) => normalize(Float32Array.from(vector)));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function embedTexts(texts, config, options = {}) {
  if (!config?.model) throw new Error('还没有配置向量模型');
  const batchSize = options.batchSize ?? 16;
  const onProgress = options.onProgress;
  const vectors = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const result = await embedBatch(batch, config);
    vectors.push(...result);
    onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
  }

  return vectors;
}

async function embedQuery(text, config) {
  const [vector] = await embedTexts([text], config, { batchSize: 1 });
  return vector;
}

module.exports = { embedTexts, embedQuery, normalize };
