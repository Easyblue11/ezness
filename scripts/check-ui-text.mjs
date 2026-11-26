#!/usr/bin/env node
/**
 * Hardcoded-Chinese scan for the renderer.
 *
 * The English UI can only be complete when no Chinese literal is left in
 * `src/`. This lists every file that still has one, so a translation pass can
 * be measured instead of eyeballed.
 *
 *   node scripts/check-ui-text.mjs           report and exit 0
 *   node scripts/check-ui-text.mjs --fail    exit 1 if anything is left
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const CJK = /[㐀-鿿豈-﫿]/;
const LITERAL = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'i18n') walk(full, files);
    } else if (['.ts', '.tsx'].includes(extname(name))) {
      files.push(full);
    }
  }
  return files;
}

/** Comment-only lines are documentation, not UI text. */
function isComment(line) {
  const text = line.trim();
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
}

const rows = [];
let total = 0;

for (const file of walk(SRC)) {
  let hits = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (isComment(line)) continue;
    if (!CJK.test(line)) continue;
    const literals = line.match(LITERAL) ?? [];
    const jsxText = /<[A-Za-z][^>]*>\s*[^<>{}\n]*[㐀-鿿]/.test(line);
    const bare = /^\s*[㐀-鿿][^<>{}]*$/.test(line);
    if (literals.some((literal) => CJK.test(literal)) || jsxText || bare) hits += 1;
  }
  if (hits > 0) {
    rows.push([hits, relative(ROOT, file).replace(/\\/g, '/')]);
    total += hits;
  }
}

rows.sort((a, b) => b[0] - a[0]);
for (const [hits, file] of rows) console.log(`${String(hits).padStart(4)}  ${file}`);
console.log(`\n${total} hardcoded Chinese line(s) in ${rows.length} file(s).`);

if (process.argv.includes('--fail') && total > 0) process.exit(1);
