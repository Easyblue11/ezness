/**
 * Optional deep rerank: ask a local model to order the candidate passages.
 *
 * The neural cross-encoder dsh-kb-rag uses (bge-reranker-base) is a ~1.1 GB
 * download and its cache on this machine is incomplete, so the default deep
 * reranker is the local chat model instead — no extra download, and it already
 * understands Chinese.
 */

const { appFetch } = require('../app-net');

function parseOrder(raw) {
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const order = parsed.order ?? parsed.ranking ?? parsed.result;
    if (!Array.isArray(order)) return null;
    return order.map(Number).filter((value) => Number.isInteger(value));
  } catch {
    return null;
  }
}

async function llmRerank(query, candidates, config) {
  if (candidates.length <= 1) return candidates;

  const base = String(config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const model = config.model;
  if (!model) return candidates;

  const shortlist = candidates.slice(0, 24);
  const passages = shortlist
    .map((item, index) => `[${index}] ${String(item.text).replace(/\s+/g, ' ').slice(0, 420)}`)
    .join('\n');

  const prompt =
    '你是检索结果重排器。请判断每个段落与查询的相关程度，并按从最相关到最不相关排序。\n' +
    '只输出 JSON，格式为 {"order":[索引,...]}，只包含你确定相关的段落索引。\n\n' +
    `查询：${query}\n\n段落：\n${passages}`;

  try {
    const response = await appFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) return candidates;

    const data = await response.json();
    const order = parseOrder(data?.message?.content ?? data?.response ?? '');
    if (!order || order.length === 0) return candidates;

    const seen = new Set();
    const ranked = [];
    for (const index of order) {
      if (index < 0 || index >= shortlist.length || seen.has(index)) continue;
      seen.add(index);
      ranked.push({ ...shortlist[index], rerankedBy: 'llm' });
    }
    // Anything the model did not mention keeps its heuristic position.
    shortlist.forEach((item, index) => {
      if (!seen.has(index)) ranked.push(item);
    });
    candidates.slice(shortlist.length).forEach((item) => ranked.push(item));

    return ranked;
  } catch {
    return candidates;
  }
}

module.exports = { llmRerank };
