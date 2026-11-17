/**
 * Hybrid retrieval: BM25 (CJK bigrams) + vector cosine, fused with RRF,
 * then a reranking pass.
 *
 * The fusion and the rerank stage are deliberately separate: swap the reranker
 * without touching the index, the way dsh-kb-rag separates quick and deep modes.
 */

const { tokenize } = require('./tokenize');

const K1 = 1.5;
const B = 0.75;
const RRF_K = 60;

class KbIndex {
  constructor(rows) {
    this.rebuild(rows);
  }

  rebuild(rows) {
    this.rows = rows;
    this.lens = new Array(rows.length);
    this.postings = new Map();

    rows.forEach((row, index) => {
      const tokens = tokenize(row.text);
      this.lens[index] = tokens.length;

      const counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

      for (const [token, count] of counts) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = [];
          this.postings.set(token, posting);
        }
        posting.push([index, count]);
      }
    });

    this.avgdl = this.lens.reduce((sum, len) => sum + len, 0) / (rows.length || 1);

    // Pack every chunk vector into one contiguous buffer: faster to scan and
    // far less memory than an array of Float32Arrays.
    this.dim = 0;
    for (const row of rows) {
      if (row.vector && row.vector.byteLength > 0) {
        this.dim = row.vector.byteLength / 4;
        break;
      }
    }

    this.matrix = this.dim ? new Float32Array(rows.length * this.dim) : null;
    if (this.matrix) {
      rows.forEach((row, index) => {
        if (!row.vector || row.vector.byteLength !== this.dim * 4) return;
        const source = new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / 4,
        );
        this.matrix.set(source, index * this.dim);
      });
    }
  }

  get size() {
    return this.rows.length;
  }

  bm25(query) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const scores = new Map();
    const total = this.rows.length;

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const idf = Math.log(1 + (total - posting.length + 0.5) / (posting.length + 0.5));
      for (const [index, tf] of posting) {
        const dl = this.lens[index] || 1;
        const score = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / (this.avgdl || 1))));
        scores.set(index, (scores.get(index) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .map(([index, score]) => ({ index, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
  }

  vectorSearch(queryVector, limit = 100) {
    if (!this.matrix || !queryVector) return [];
    const dim = this.dim;
    const results = [];

    for (let row = 0; row < this.rows.length; row += 1) {
      const offset = row * dim;
      let dot = 0;
      for (let d = 0; d < dim; d += 1) dot += this.matrix[offset + d] * queryVector[d];
      if (dot > 0) results.push({ index: row, score: dot });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

function fuseRankings(lists, limit) {
  const scores = new Map();

  for (const list of lists) {
    list.forEach((item, rank) => {
      const entry = scores.get(item.index) ?? { index: item.index, rrf: 0 };
      entry.rrf += 1 / (RRF_K + rank + 1);
      scores.set(item.index, entry);
    });
  }

  return [...scores.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}

/** Heuristic reranker: rewards term coverage and exact phrase hits. */
function heuristicRerank(query, candidates) {
  const queryTokens = new Set(tokenize(query));
  const phrase = query.trim().toLowerCase();
  const maxBm25 = Math.max(...candidates.map((item) => item.bm25 ?? 0), 1e-6);

  return candidates
    .map((item) => {
      const text = item.text ?? '';
      const lower = text.toLowerCase();
      const tokens = new Set(tokenize(text));

      let covered = 0;
      for (const token of queryTokens) if (tokens.has(token)) covered += 1;
      const coverage = queryTokens.size ? covered / queryTokens.size : 0;

      const containsPhrase = phrase.length > 1 && lower.includes(phrase) ? 1 : 0;
      const bm25Norm = (item.bm25 ?? 0) / maxBm25;
      const vectorNorm = Math.max(0, Math.min(1, item.vector ?? 0));
      const lengthPenalty = text.length < 40 ? 0.6 : 1;

      const score =
        (0.34 * vectorNorm + 0.28 * bm25Norm + 0.26 * coverage + 0.12 * containsPhrase) * lengthPenalty;

      return { ...item, coverage, rerankScore: score };
    })
    .sort((a, b) => b.rerankScore - a.rerankScore);
}

async function hybridSearch(index, options) {
  const {
    query,
    queryVector = null,
    topK = 6,
    candidates = 40,
    categoryId = null,
    categoryIds = null,
    docIds = null,
    excludeDocIds = null,
    rerank = null,
  } = options;

  const bm25Hits = index.bm25(query);
  const vectorHits = queryVector ? index.vectorSearch(queryVector) : [];

  const bm25Map = new Map(bm25Hits.map((hit) => [hit.index, hit.score]));
  const vectorMap = new Map(vectorHits.map((hit) => [hit.index, hit.score]));

  // Document-level scope is a filter, not a ranking hint. Pull a wider pool so
  // a selected document is not lost before the filter runs. Empty lists mean
  // "no document-level rule", not "match nothing".
  const allowedDocs = Array.isArray(docIds) && docIds.length > 0 ? new Set(docIds) : null;
  const excludedDocs =
    Array.isArray(excludeDocIds) && excludeDocIds.length > 0 ? new Set(excludeDocIds) : null;
  const docFilter = Boolean(allowedDocs || excludedDocs);
  const pool = docFilter ? Math.max(candidates, 400) : candidates;
  let fused = fuseRankings([bm25Hits, vectorHits], pool);

  // Category filter applies after fusion so it never skews the ranking. An empty
  // `categoryIds` (组合分类 with no members) filters everything out.
  const allowed = Array.isArray(categoryIds)
    ? new Set(categoryIds)
    : categoryId
      ? new Set([categoryId])
      : null;
  if (allowed || allowedDocs || excludedDocs) {
    fused = fused
      .filter((item) => {
        const row = index.rows[item.index];
        if (!row) return false;
        if (excludedDocs?.has(row.docId)) return false;
        if (!allowed && !allowedDocs) return true;
        // A document may be picked individually even when its category is not.
        return Boolean(
          allowed?.has(row.categoryId) || allowedDocs?.has(row.docId),
        );
      })
      .slice(0, candidates);
  }

  let ranked = fused.map((item) => {
    const row = index.rows[item.index];
    return {
      chunkId: row.id,
      docId: row.docId,
      docName: row.docName,
      section: row.section,
      page: row.page,
      text: row.text,
      bm25: bm25Map.get(item.index) ?? 0,
      vector: vectorMap.get(item.index) ?? 0,
      rrf: item.rrf,
    };
  });

  ranked = heuristicRerank(query, ranked);
  if (rerank) ranked = await rerank(query, ranked);

  return ranked.slice(0, topK).map((item, index) => ({
    rank: index + 1,
    ...item,
    score: Number((item.rerankScore ?? item.rrf).toFixed(4)),
  }));
}

module.exports = { KbIndex, hybridSearch, heuristicRerank, tokenize };
