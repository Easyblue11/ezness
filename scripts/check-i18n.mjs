#!/usr/bin/env node
/**
 * Language pack consistency check.
 *
 *   1. zh-CN and en-US must expose the same keys.
 *   2. A key's `{placeholders}` must be identical in both packs.
 *   3. Every literal `t('key')` used in src/ must exist in zh-CN (the fallback).
 *
 * Run with `npm run check:i18n`. Dynamic keys are not checked; keep them out of
 * the UI or add their literal form to the pack.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['src/i18n/zh-CN.json', 'src/i18n/en-US.json'];
const BASE = 'src/i18n/zh-CN.json';

function load(file) {
  const raw = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const entries = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (key !== '_meta' && typeof value === 'string') entries.set(key, value);
  }
  return { meta: raw._meta ?? {}, entries };
}

function placeholders(text) {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (['.ts', '.tsx'].includes(extname(name))) files.push(full);
  }
  return files;
}

const packs = new Map(LOCALES.map((file) => [file, load(file)]));
const base = packs.get(BASE);
const problems = [];

for (const [file, pack] of packs) {
  if (file === BASE) continue;
  for (const key of base.entries.keys()) {
    if (!pack.entries.has(key)) problems.push(`${file}: missing key "${key}"`);
  }
  for (const key of pack.entries.keys()) {
    if (!base.entries.has(key)) problems.push(`${file}: extra key "${key}" (not in zh-CN)`);
  }
  for (const [key, text] of pack.entries) {
    const expected = placeholders(base.entries.get(key) ?? '');
    const actual = placeholders(text);
    if (expected.join(',') !== actual.join(',')) {
      problems.push(
        `${file}: "${key}" placeholders {${actual.join(', ')}} do not match zh-CN {${expected.join(', ')}}`,
      );
    }
  }
}

const used = new Set();
for (const file of walk(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const patterns = [
    /\bt\(\s*['"]([^'"]+)['"]/g,
    /\blabelKey:\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = match[1];
      if (/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(key)) used.add(key);
    }
  }
}

for (const key of [...used].sort()) {
  if (!base.entries.has(key)) {
    problems.push(`src/: "${key}" is used but missing from zh-CN`);
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `i18n OK: ${base.entries.size} keys per pack, ${used.size} literal keys used in src, ` +
    `${packs.size} built-in packs.`,
);
