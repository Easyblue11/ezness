/**
 * Tokenizer shared by BM25 and the reranker.
 *
 * Chinese has no spaces, so CJK runs are cut into overlapping bigrams — the
 * same trick dsh-kb-rag's BM25 uses. Latin and digits stay whole words.
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const LATIN = /[a-z0-9]+(?:[._-][a-z0-9]+)*/g;

function tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = [];

  const latin = lower.match(LATIN);
  if (latin) tokens.push(...latin);

  const cjkRuns = lower.match(CJK);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run);
        continue;
      }
      for (let i = 0; i < run.length - 1; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

module.exports = { tokenize };
