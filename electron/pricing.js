/**
 * Model pricing for the usage ledger.
 *
 * Costs are USD per 1M tokens — the unit every provider catalogue uses. Three
 * sources, most specific first:
 *
 *   1. a catalogue the app fetched itself (`<root>/model-prices.json`), which
 *      keeps OpenRouter/OpenCode style `cost.text` metadata current;
 *   2. the OpenCode snapshot shipped in `opencode-prices.json` (Zen + Go);
 *   3. a small built-in table for the common first-party models.
 *
 * A model with no known price still gets recorded — it just carries
 * `priced: false` and the page marks its cost as unknown instead of pretending
 * it was free.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const SNAPSHOT = require('./opencode-prices.json');

const CACHE_FILE = 'model-prices.json';

/**
 * First-party prices, USD per 1M tokens. Matched by longest prefix so dated
 * snapshots (`gpt-5.4-mini-2026-01-01`) still resolve.
 */
const GENERIC = {
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25 },
  'gpt-5.3': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175 },
  'gpt-5.1': { input: 1.07, output: 8.5, cacheRead: 0.107 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-5': { input: 1.07, output: 8.5, cacheRead: 0.107 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  o1: { input: 15, output: 60, cacheRead: 7.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'qwen3-max': { input: 1.2, output: 6, cacheRead: 0.24 },
  'qwen-plus': { input: 0.4, output: 1.2, cacheRead: 0.08 },
  'glm-4.6': { input: 0.6, output: 2.2, cacheRead: 0.11 },
  'kimi-k2': { input: 0.6, output: 2.5, cacheRead: 0.15 },
  'grok-4': { input: 3, output: 15, cacheRead: 0.75 },
  'mistral-large': { input: 2, output: 6 },
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
};

/** The catalogue file the app keeps; refreshed by `models:fetch`. */
let catalogs = {};
let rootDir = null;
let saveTimer = null;

function normalizedBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function modelKey(model) {
  return String(model || '').trim().toLowerCase();
}

async function load(root) {
  rootDir = root;
  try {
    const raw = await fsp.readFile(path.join(root, CACHE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    catalogs = parsed && typeof parsed.catalogs === 'object' && parsed.catalogs ? parsed.catalogs : {};
  } catch {
    catalogs = {};
  }
}

function attach(root) {
  rootDir = root;
}

function scheduleSave() {
  if (!rootDir || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const file = path.join(rootDir, CACHE_FILE);
    const temp = `${file}.tmp`;
    fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(temp, JSON.stringify({ catalogs }, null, 2), 'utf8'))
      .then(() => fsp.rename(temp, file))
      .catch((error) => console.error('[pricing] could not save catalogue prices:', error?.message || error));
  }, 800);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** Read `cost.text` metadata from a `/models` answer. Null when it has none. */
function extractCatalog(payload) {
  const list = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(list)) return null;

  const table = {};
  let found = false;
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id : '';
    const cost = item?.cost?.text;
    if (!id || !cost) continue;
    const input = Number(cost.input?.price);
    const output = Number(cost.output?.price);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    found = true;
    const entry = { input, output };
    const cacheRead = Number(cost.input?.cache?.read);
    const cacheWrite = Number(cost.input?.cache?.write);
    if (Number.isFinite(cacheRead) && cacheRead > 0) entry.cacheRead = cacheRead;
    if (Number.isFinite(cacheWrite) && cacheWrite > 0) entry.cacheWrite = cacheWrite;
    if (Array.isArray(item?.cost?.multipliers) && item.cost.multipliers.length > 0) {
      entry.multipliers = item.cost.multipliers;
    }
    table[id] = entry;
    table[id.toLowerCase()] = entry;
  }
  return found ? table : null;
}

/** Remember the prices of a catalogue the main process just fetched. */
function rememberCatalog(baseUrl, payload) {
  const base = normalizedBase(baseUrl);
  const table = extractCatalog(payload);
  if (!base || !table) return false;
  catalogs[base] = table;
  scheduleSave();
  return true;
}

function fromCatalog(baseUrl, model) {
  const table = catalogs[normalizedBase(baseUrl)];
  if (!table) return null;
  return table[model] ?? table[modelKey(model)] ?? null;
}

function isOpenCode(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'opencode.ai' || url.hostname.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

function openCodeSnapshot(baseUrl) {
  // Go lives under /zen/go; everything else on opencode.ai is the Zen catalogue.
  return /\/zen\/go(?:\/|$)/i.test(String(baseUrl)) ? SNAPSHOT.go : SNAPSHOT.zen;
}

function fromSnapshot(baseUrl, model) {
  const table = openCodeSnapshot(baseUrl);
  return table[model] ?? table[modelKey(model)] ?? null;
}

function fromGeneric(model) {
  const key = modelKey(model);
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  const candidates = [key, bare];
  let best = null;
  let bestLength = 0;
  for (const tableKey of Object.keys(GENERIC)) {
    for (const candidate of candidates) {
      if (!candidate.startsWith(tableKey)) continue;
      if (tableKey.length <= bestLength) continue;
      best = GENERIC[tableKey];
      bestLength = tableKey.length;
    }
  }
  return best;
}

const DAY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function utcHour(at) {
  const date = new Date(at);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

function clock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

/** Evaluate the small date/time condition dialect used by OpenCode catalogues. */
function matchesWhen(when, at) {
  if (!when || typeof when !== 'object') return true;
  const date = new Date(at);

  if (when.utc_days?.in) {
    const days = when.utc_days.in.map((day) => String(day).toLowerCase());
    if (!days.includes(DAY_INDEX[date.getUTCDay()])) return false;
  }
  if (when.utc_hours) {
    const hour = utcHour(at);
    const gte = when.utc_hours.gte !== undefined ? clock(when.utc_hours.gte) : null;
    const lt = when.utc_hours.lt !== undefined ? clock(when.utc_hours.lt) : null;
    if (gte !== null && hour < gte) return false;
    if (lt !== null && hour >= lt) return false;
  }
  if (when.date) {
    const stamp = date.getTime();
    const gte = when.date.gte ? Date.parse(`${when.date.gte}T00:00:00Z`) : null;
    const lt = when.date.lt ? Date.parse(`${when.date.lt}T00:00:00Z`) : null;
    if (gte !== null && !Number.isNaN(gte) && stamp < gte) return false;
    if (lt !== null && !Number.isNaN(lt) && stamp >= lt) return false;
  }
  if (Array.isArray(when.all) && !when.all.every((part) => matchesWhen(part, at))) return false;
  if (Array.isArray(when.any) && !when.any.some((part) => matchesWhen(part, at))) return false;
  return true;
}

function multiplierFor(price, at) {
  if (!Array.isArray(price?.multipliers)) return 1;
  let factor = 1;
  for (const rule of price.multipliers) {
    if (matchesWhen(rule?.when, at)) factor *= Number(rule?.factor) || 1;
  }
  return factor;
}

/**
 * Resolve a price for one provider/model pair.
 * Returns null when the model cannot be priced.
 */
function priceFor(target, at = Date.now()) {
  const baseUrl = normalizedBase(target?.baseUrl);
  const model = String(target?.model || '');

  let price = fromCatalog(baseUrl, model);
  let source = 'catalog';
  if (!price && isOpenCode(baseUrl)) {
    price = fromSnapshot(baseUrl, model);
    source = 'builtin';
  }
  if (!price) {
    price = fromGeneric(model);
    source = 'builtin';
  }
  // Free variants are genuinely zero-priced; do not leave them "unknown".
  if (!price && /(?:^|[/:_-])free$/i.test(model)) {
    price = { input: 0, output: 0 };
    source = 'builtin';
  }
  if (!price) return null;

  return {
    input: Number(price.input) || 0,
    output: Number(price.output) || 0,
    cacheRead: Number(price.cacheRead) || 0,
    cacheWrite: Number(price.cacheWrite) || 0,
    factor: multiplierFor(price, at),
    source,
  };
}

/**
 * Cost in USD. `inputTokens` is the whole prompt (cached + written + fresh);
 * cache tokens are carved out so they get their own rate.
 */
function costOf(tokens, price, at = Date.now()) {
  if (!price) return null;
  const input = Math.max(0, Number(tokens.inputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(tokens.cachedInputTokens) || 0));
  const written = Math.min(input - cached, Math.max(0, Number(tokens.cacheWriteTokens) || 0));
  const fresh = Math.max(0, input - cached - written);
  const output = Math.max(0, Number(tokens.outputTokens) || 0);
  const writePrice = price.cacheWrite || price.input;

  const cost =
    (fresh * price.input + cached * price.cacheRead + written * writePrice + output * price.output) /
    1e6;
  return cost * (price.factor || 1);
}

module.exports = {
  load,
  attach,
  rememberCatalog,
  extractCatalog,
  priceFor,
  costOf,
  multiplierFor,
  matchesWhen,
  CACHE_FILE,
};
