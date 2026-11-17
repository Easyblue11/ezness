/**
 * Section-aware chunking.
 *
 * Mirrors the idea behind dsh-kb-rag's chunker without its PDF-science
 * heuristics: follow headings, keep chunks near a target size, never let a
 * chunk run past `max`, and carry a little overlap when splitting long blocks.
 */

const HEADING_PATTERNS = [
  /^#{1,6}\s+\S/,
  /^第[一二三四五六七八九十百零〇\d]+[章节篇部讲]\s*[^\n]{0,40}$/,
  /^\d+(\.\d+){0,3}[、.\s]\s*[^\n]{1,40}$/,
  /^[一二三四五六七八九十]+、[^\n]{1,40}$/,
  /^(abstract|introduction|methods?|results?|discussion|conclusions?|references?|摘要|引言|方法|结果|讨论|结论|参考文献)\s*[:：]?$/i,
];

function isHeading(block) {
  if (block.length > 60) return false;
  if (!HEADING_PATTERNS.some((pattern) => pattern.test(block))) return false;
  // A heading has almost no sentence punctuation.
  return !/[。！？.!?]\s*$/.test(block) || /^#{1,6}\s/.test(block);
}

function splitLongBlock(block, max, overlap) {
  const sentences = block.split(/(?<=[。！？.!?；;])\s*/).filter(Boolean);
  const pieces = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > max && current) {
      pieces.push(current.trim());
      const tail = current.slice(-overlap);
      current = `${tail}${sentence}`;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());

  // A single sentence longer than max still has to be cut somewhere.
  return pieces.flatMap((piece) => {
    if (piece.length <= max) return [piece];
    const parts = [];
    for (let i = 0; i < piece.length; i += max - overlap) {
      parts.push(piece.slice(i, i + max));
    }
    return parts;
  });
}

function chunkPages(pages, options = {}) {
  const target = options.target ?? 600;
  const max = options.max ?? Math.max(target * 2, 1200);
  const overlap = options.overlap ?? 80;

  const chunks = [];
  let buffer = '';
  let bufferPage = null;
  let section = null;

  const flush = () => {
    const text = buffer.trim();
    if (text) chunks.push({ text, section, page: bufferPage });
    buffer = '';
    bufferPage = null;
  };

  for (const page of pages) {
    const blocks = String(page.text || '')
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .flatMap((block) => block.split(/\n(?=[^\s])/))
      .map((block) => block.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);

    for (const block of blocks) {
      if (isHeading(block)) {
        flush();
        section = block.replace(/^#{1,6}\s+/, '').slice(0, 80);
        continue;
      }

      if (block.length > max) {
        flush();
        for (const piece of splitLongBlock(block, max, overlap)) {
          chunks.push({ text: piece, section, page: page.page });
        }
        continue;
      }

      if (!buffer) {
        buffer = block;
        bufferPage = page.page;
      } else if (buffer.length + block.length + 1 <= max) {
        buffer += `\n${block}`;
      } else {
        flush();
        buffer = block;
        bufferPage = page.page;
      }

      if (buffer.length >= target) flush();
    }
  }

  flush();

  return chunks.filter((chunk) => chunk.text.length >= 20);
}

module.exports = { chunkPages, isHeading };
