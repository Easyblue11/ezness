/**
 * Token spend ledger.
 *
 * Every model request the main process runs — chat, context compression,
 * prompt generation, the workspace agent and its safety reviewer — appends one
 * record here. The file lives at `<data root>/usage.json`.
 *
 * Usage comes from the provider when it reports it (OpenAI `stream_options`
 * usage, Anthropic `message_start`/`message_delta`, Ollama eval counts) and is
 * estimated from characters otherwise; `reported` keeps the two apart so the
 * page can say so. Cost is snapshotted at request time, so a later price-list
 * change does not rewrite history.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pricing = require('./pricing');

const FILE = 'usage.json';
const MAX_RECORDS = 50000;

/**
 * Model catalogues quote USD per 1M tokens. The ledger stores CNY, converted
 * once when the request is recorded so later rate changes do not rewrite
 * history. Keep in sync with src/lib/usage.ts (DEFAULT_FX_RATE).
 */
const CNY_PER_USD = 7.2;

function startOfDay(at = Date.now()) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfMonth(at = Date.now()) {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function emptySummary() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
    requests: 0,
    unpricedRequests: 0,
  };
}

function summarize(records) {
  const summary = emptySummary();
  for (const record of records) {
    summary.inputTokens += record.inputTokens || 0;
    summary.outputTokens += record.outputTokens || 0;
    summary.cachedInputTokens += record.cachedInputTokens || 0;
    summary.requests += 1;
    if (record.priced && typeof record.cost === 'number') summary.cost += record.cost;
    else summary.unpricedRequests += 1;
  }
  return summary;
}

/**
 * Stream timing added by `streamChat`. Older records have none, so every field
 * is optional and zero values are omitted rather than stored as "instant".
 */
function timingFields(source) {
  const ms = (value) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const rate = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number * 10) / 10 : 0;
  };
  const fields = {
    durationMs: ms(source?.durationMs),
    firstTokenMs: ms(source?.firstTokenMs),
    generationMs: ms(source?.generationMs),
    tokensPerSecond: rate(source?.tokensPerSecond),
    peakTokensPerSecond: rate(source?.peakTokensPerSecond),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value > 0));
}

/**
 * A stored rate is only meaningful if it is physically reachable from the
 * output count. The recorder never divides by less than 250 ms, so no honest
 * record can exceed outputTokens × 4. Records written before that rule held
 * divided a single-chunk answer by the millisecond between its first and last
 * delta and could claim six figures (123 tokens in 1 ms = 123,000 tok/s).
 * Rebuild those from the request wall-clock instead of showing the nonsense.
 */
function repairTiming(timing, outputTokens) {
  if (outputTokens <= 0) return timing;
  const ceiling = outputTokens * 4;
  const broken =
    (timing.tokensPerSecond ?? 0) > ceiling || (timing.peakTokensPerSecond ?? 0) > ceiling;
  if (!broken) return timing;
  const durationMs = timing.durationMs || 0;
  if (durationMs <= 0) return {};
  const tokensPerSecond = Math.round((outputTokens / (durationMs / 1000)) * 10) / 10;
  return {
    ...(timing.firstTokenMs ? { firstTokenMs: timing.firstTokenMs } : {}),
    durationMs,
    generationMs: durationMs,
    ...(tokensPerSecond > 0 ? { tokensPerSecond, peakTokensPerSecond: tokensPerSecond } : {}),
  };
}

function sanitize(value) {
  if (!value || typeof value !== 'object') return null;
  const at = Number(value.at);
  if (!Number.isFinite(at)) return null;
  const inputTokens = Math.max(0, Math.round(Number(value.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.round(Number(value.outputTokens) || 0));
  if (inputTokens === 0 && outputTokens === 0) return null;
  const timing = repairTiming(timingFields(value), outputTokens);
  const rawCost = Number(value.cost);
  const priced = value.priced === true && Number.isFinite(rawCost);
  // Files written before the CNY switch hold USD; convert them on read.
  const alreadyCny = value.currency === 'CNY';
  const storedRate = Number(value.fxRate);
  const fxRate = alreadyCny && Number.isFinite(storedRate) && storedRate > 0 ? storedRate : CNY_PER_USD;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : randomUUID(),
    at,
    feature: typeof value.feature === 'string' ? value.feature : 'other',
    providerId: String(value.providerId ?? ''),
    providerName: String(value.providerName ?? value.providerId ?? '未知供应商'),
    model: String(value.model ?? '未知模型'),
    cost: priced ? (alreadyCny ? rawCost : rawCost * CNY_PER_USD) : null,
    currency: 'CNY',
    fxRate,
    priced,
    priceSource: ['catalog', 'builtin'].includes(value.priceSource) ? value.priceSource : 'none',
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.max(0, Math.round(Number(value.cachedInputTokens) || 0)),
    reasoningTokens: Math.max(0, Math.round(Number(value.reasoningTokens) || 0)),
    reported: value.reported === true,
    ...timing,
    ...(typeof value.sessionId === 'string' && value.sessionId ? { sessionId: value.sessionId } : {}),
    ...(typeof value.workspaceName === 'string' && value.workspaceName
      ? { workspaceName: value.workspaceName }
      : {}),
  };
}

class UsageStore {
  /**
   * @param {() => string} rootProvider current data root (it moves on migration)
   * @param {(event: object) => void} emit pushes live updates to the renderer
   */
  constructor(rootProvider, emit) {
    this.rootProvider = rootProvider;
    this.emit = emit || (() => {});
    this.records = [];
    this.loaded = false;
    this.saveTimer = null;
    this.writeChain = Promise.resolve();
  }

  file() {
    return path.join(this.rootProvider(), FILE);
  }

  async load() {
    await pricing.load(this.rootProvider());
    let legacyCurrency = false;
    try {
      const raw = await fsp.readFile(this.file(), 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.records) ? parsed.records : [];
      legacyCurrency = list.some((record) => record && record.currency !== 'CNY');
      this.records = list.map(sanitize).filter(Boolean);
      if (this.records.length > MAX_RECORDS) {
        this.records = this.records.slice(this.records.length - MAX_RECORDS);
      }
    } catch {
      this.records = [];
    }
    this.loaded = true;
    // Persist converted records so the file and the UI agree after a restart.
    if (legacyCurrency && this.records.length > 0) this.scheduleSave();
    return this.snapshot();
  }

  /** The data root moved: read the ledger at its new home. */
  async reattach() {
    pricing.attach(this.rootProvider());
    await this.load();
    this.emit({ type: 'reload', snapshot: this.snapshot() });
    return this.snapshot();
  }

  today() {
    const from = startOfDay();
    return summarize(this.records.filter((record) => record.at >= from));
  }

  snapshot() {
    return { records: [...this.records], today: this.today(), fxRate: CNY_PER_USD };
  }

  summarySince(at) {
    return summarize(this.records.filter((record) => record.at >= at));
  }

  /**
   * Append one request. Returns the record, or null for an empty/aborted call
   * that produced no tokens.
   */
  record({ feature = 'chat', provider, usage, at = Date.now(), sessionId, workspaceName }) {
    if (!usage) return null;
    const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens) || 0));
    if (inputTokens === 0 && outputTokens === 0) return null;

    const target = {
      baseUrl: provider?.baseUrl,
      model: provider?.model,
      providerId: provider?.providerId || provider?.id,
    };
    const price = pricing.priceFor(target, at);
    const tokens = {
      inputTokens,
      outputTokens,
      cachedInputTokens: Math.max(0, Math.round(Number(usage.cachedInputTokens) || 0)),
      cacheWriteTokens: Math.max(0, Math.round(Number(usage.cacheWriteTokens) || 0)),
    };
    const costUsd = price ? pricing.costOf(tokens, price, at) : null;
    const cost = Number.isFinite(costUsd) ? costUsd * CNY_PER_USD : null;

    const record = {
      id: randomUUID(),
      at,
      feature,
      providerId: String(provider?.providerId || provider?.id || ''),
      providerName: String(provider?.providerName || provider?.name || provider?.providerId || '自定义'),
      model: String(provider?.model || '未知模型'),
      cost,
      currency: 'CNY',
      fxRate: CNY_PER_USD,
      priced: Number.isFinite(cost),
      priceSource: price?.source ?? 'none',
      inputTokens,
      outputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      reasoningTokens: Math.max(0, Math.round(Number(usage.reasoningTokens) || 0)),
      reported: usage.reported === true,
      ...timingFields(usage),
      ...(sessionId ? { sessionId } : {}),
      ...(workspaceName ? { workspaceName } : {}),
    };

    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(this.records.length - MAX_RECORDS);
    }
    this.scheduleSave();
    this.emit({ type: 'record', record, today: this.today() });
    return record;
  }

  clear() {
    this.records = [];
    this.scheduleSave(0);
    const snapshot = this.snapshot();
    this.emit({ type: 'reload', snapshot });
    return snapshot;
  }

  scheduleSave(delay = 600) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, delay);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  flush() {
    const file = this.file();
    const payload = JSON.stringify({ version: 1, records: this.records });
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await fsp.writeFile(temp, payload, 'utf8');
        await fsp.rename(temp, file);
      })
      .catch((error) => console.error('[usage] save failed:', error?.message || error));
    return this.writeChain;
  }

  /** Last-chance write on quit; the debounce may still be pending. */
  flushSync() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, records: this.records }), 'utf8');
      fs.renameSync(temp, file);
    } catch (error) {
      console.error('[usage] final save failed:', error?.message || error);
    }
  }
}

module.exports = { UsageStore, summarize, startOfDay, startOfMonth, CNY_PER_USD, FILE };
