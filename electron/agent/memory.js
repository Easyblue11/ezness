/**
 * Long-term memory for one Agent.
 *
 * A memory is a small, human-readable card — title, a few sentences, tags,
 * sources, confidence and a validity window — not a raw document chunk. The
 * canonical store is pretty-printed JSON under
 * `<data root>/agent/memories/<agentId>.json`, so the user can open it and read
 * every fact the Agent has learned. An audit log beside it records every
 * add / edit / confirm / delete / recheck.
 *
 * Time is part of the data model. Each entry carries how fast its subject
 * changes, when it was last verified, when it should be checked again, and when
 * it is expected to expire. Retrieval only returns confirmed memories, and a
 * due or expired entry is returned with an explicit warning (or hidden) so a
 * stale fact never quietly becomes the current answer.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const STORE_VERSION = 1;
const DIR_NAME = 'memories';
const EVENTS_DIR = 'memory-events';
const MAX_ENTRIES = 2000;
const MAX_TITLE = 160;
const MAX_CONTENT = 8000;
const MAX_TAGS = 12;
const MAX_SOURCES = 8;
const MAX_EVIDENCE = 6;
const MAX_HISTORY = 20;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DAY = 24 * 60 * 60 * 1000;

const TYPES = new Set(['fact', 'insight', 'preference', 'procedure', 'note']);
const STATUSES = new Set(['candidate', 'confirmed', 'rejected', 'archived', 'disputed']);
const ORIGINS = new Set(['learned', 'manual', 'imported']);
const VOLATILITIES = new Set(['static', 'slow', 'medium', 'fast', 'realtime']);
const DATE_CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * How long a subject usually stays true, and how often to check it. `ttlDays`
 * is the estimated validity window; `recheckDays` is the earlier maintenance
 * reminder. A static fact is still checked yearly, but it is not expected to
 * change; a price is checked every two weeks.
 */
const VOLATILITY = {
  static: { ttlDays: 1825, recheckDays: 365, label: '稳定' },
  slow: { ttlDays: 730, recheckDays: 180, label: '慢变' },
  medium: { ttlDays: 180, recheckDays: 90, label: '中变' },
  fast: { ttlDays: 30, recheckDays: 14, label: '快变' },
  realtime: { ttlDays: 2, recheckDays: 1, label: '实时' },
};

/** Test hook: a fixed clock avoids waiting months to exercise expiry. */
function nowMs() {
  const override = Number(process.env.EZNESS_FAKE_NOW);
  return Number.isFinite(override) && override > 0 ? override : Date.now();
}

function safeId(value) {
  const id = String(value ?? '');
  return ID_RE.test(id) ? id : '';
}

function memoriesDir(agentDir) {
  return path.join(agentDir, DIR_NAME);
}

function storePath(agentDir, agentId) {
  const id = safeId(agentId);
  return id ? path.join(memoriesDir(agentDir), `${id}.json`) : '';
}

function eventsPath(agentDir, agentId) {
  const id = safeId(agentId);
  return id ? path.join(agentDir, EVENTS_DIR, `${id}.jsonl`) : '';
}

function text(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

function uniqueStrings(value, limit, maxChars = 120) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue;
    const key = text(item, maxChars);
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function numberIn(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeSource(input, now) {
  if (!input || typeof input !== 'object') return null;
  const kind = ['web', 'conversation', 'manual'].includes(input.kind) ? input.kind : 'web';
  const url = text(input.url, 2000);
  const title = text(input.title, 300);
  const sessionId = text(input.sessionId, 128);
  const messageId = text(input.messageId, 128);
  if (kind === 'web' && !url) return null;
  if (kind === 'conversation' && !sessionId && !messageId) return null;
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : now;
  return {
    kind,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    at,
  };
}

function normalizeSources(value, now) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const source = normalizeSource(item, now);
    if (!source) continue;
    const key = `${source.kind}:${source.url || source.sessionId || ''}:${source.title || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function defaultTtl(volatility) {
  return VOLATILITY[volatility] ?? VOLATILITY.medium;
}

function normalizeTemporal(input, now, previous = null) {
  const raw = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const merged = { ...prior, ...raw };
  const volatility = VOLATILITIES.has(merged.volatility) ? merged.volatility : 'medium';
  const preset = defaultTtl(volatility);
  // Changing the volatility class should adopt its usual windows unless the
  // caller explicitly supplied new numbers in this same edit.
  const changedClass = prior.volatility && prior.volatility !== volatility;
  const observedAt = Number.isFinite(Number(merged.observedAt))
    ? Number(merged.observedAt)
    : now;
  const validFrom = Number.isFinite(Number(merged.validFrom))
    ? Number(merged.validFrom)
    : observedAt;
  const ttlDays = numberIn(
    raw.ttlDays ?? (changedClass ? undefined : merged.ttlDays),
    1,
    3650,
    preset.ttlDays,
  );
  const lastVerifiedAt = Number.isFinite(Number(merged.lastVerifiedAt))
    ? Number(merged.lastVerifiedAt)
    : now;
  const checkCount = Math.max(0, Math.trunc(Number(merged.checkCount)) || 0);
  const recheckDays = numberIn(
    raw.recheckDays ?? (changedClass ? undefined : merged.recheckDays),
    1,
    730,
    preset.recheckDays,
  );
  const validUntil = Number.isFinite(Number(merged.validUntil))
    ? Number(merged.validUntil)
    : validFrom + ttlDays * DAY;
  const nextCheckAt = Number.isFinite(Number(merged.nextCheckAt))
    ? Number(merged.nextCheckAt)
    : lastVerifiedAt + recheckDays * DAY;

  return {
    observedAt,
    publishedAt: Number.isFinite(Number(merged.publishedAt)) ? Number(merged.publishedAt) : null,
    validFrom,
    validUntil,
    volatility,
    ttlDays,
    recheckDays,
    ttlReason: text(merged.ttlReason, 400),
    lastVerifiedAt,
    nextCheckAt,
    checkCount,
    dateConfidence: DATE_CONFIDENCE.has(merged.dateConfidence)
      ? merged.dateConfidence
      : 'medium',
    unverified: Boolean(merged.unverified),
  };
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    revision: Math.max(1, Math.trunc(Number(item.revision)) || 1),
    title: text(item.title, MAX_TITLE),
    content: text(item.content, MAX_CONTENT),
    tags: uniqueStrings(item.tags, MAX_TAGS, 40),
    sources: normalizeSources(item.sources, Number(item.replacedAt) || Date.now()),
    replacedAt: Number(item.replacedAt) || Date.now(),
    reason: text(item.reason, 400),
    verifiedBy: text(item.verifiedBy, 40) || 'manual',
  };
}

function normalizeProposal(input, now) {
  if (!input || typeof input !== 'object') return null;
  return {
    title: text(input.title, MAX_TITLE),
    content: text(input.content, MAX_CONTENT),
    tags: uniqueStrings(input.tags, MAX_TAGS, 40),
    sources: normalizeSources(input.sources, now),
    evidence: uniqueStrings(input.evidence, MAX_EVIDENCE, 500),
    confidence: numberIn(input.confidence, 0, 1, 0.6),
    temporal: normalizeTemporal(input.temporal, now),
    reason: text(input.reason, 400),
    verdict: ['changed', 'unchanged', 'unverifiable', 'disputed'].includes(input.verdict)
      ? input.verdict
      : 'changed',
    createdAt: Number(input.createdAt) || now,
  };
}

function fingerprintOf(title, content) {
  return `${String(title ?? '')}\n${String(content ?? '')}`
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 2000);
}

function hashOf(title, content) {
  return crypto.createHash('sha256').update(fingerprintOf(title, content)).digest('hex');
}

function bigrams(value) {
  const text = String(value ?? '').toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    set.add(text.slice(index, index + 2));
  }
  if (set.size === 0 && text) set.add(text);
  return set;
}

function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Validate and normalize one entry. Returns `{ ok, entry }` or
 * `{ ok: false, error }` so a hand-edited JSON file cannot poison the store.
 */
function normalizeEntry(input, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : nowMs();
  const agentId = safeId(options.agentId ?? input?.agentId);
  if (!agentId) return { ok: false, error: 'Agent 不存在。' };
  if (!input || typeof input !== 'object') return { ok: false, error: '记忆内容格式不对。' };

  const previous = options.previous && typeof options.previous === 'object' ? options.previous : null;
  const title = text(input.title, MAX_TITLE);
  const content = text(input.content, MAX_CONTENT);
  if (!title && !content) return { ok: false, error: '记忆的标题和内容不能同时为空。' };

  const type = TYPES.has(input.type) ? input.type : 'fact';
  const origin = ORIGINS.has(input.origin)
    ? input.origin
    : previous?.origin ?? 'manual';
  const status = STATUSES.has(input.status)
    ? input.status
    : previous?.status ?? (origin === 'manual' ? 'confirmed' : 'candidate');
  const confidence = numberIn(
    input.confidence,
    0,
    1,
    previous?.confidence ?? (origin === 'manual' ? 0.9 : 0.6),
  );
  const revision = Math.max(
    1,
    Math.trunc(Number(input.revision ?? previous?.revision)) || 1,
  );
  const createdAt = Number(input.createdAt ?? previous?.createdAt) || now;
  const updatedAt = now;

  const id = text(input.id ?? previous?.id, 64) || `mem_${crypto.randomUUID()}`;
  if (!ID_RE.test(id)) return { ok: false, error: '记忆 id 不合法。' };

  return {
    ok: true,
    entry: {
      id,
      agentId,
      type,
      title: title || content.slice(0, 80),
      content,
      tags: uniqueStrings(input.tags, MAX_TAGS, 40),
      confidence,
      status,
      origin,
      locked: Boolean(input.locked ?? previous?.locked),
      sources: normalizeSources(input.sources ?? previous?.sources, now),
      evidence: uniqueStrings(input.evidence ?? previous?.evidence, MAX_EVIDENCE, 500),
      temporal: normalizeTemporal(input.temporal, now, previous?.temporal),
      revision,
      history: Array.isArray(input.history ?? previous?.history)
        ? (input.history ?? previous?.history)
            .map(normalizeHistoryItem)
            .filter(Boolean)
            .slice(-MAX_HISTORY)
        : [],
      proposal: input.proposal === null
        ? null
        : normalizeProposal(input.proposal, now) ?? normalizeProposal(previous?.proposal, now),
      supersedes: uniqueStrings(input.supersedes ?? previous?.supersedes, 20, 64),
      conflictsWith: uniqueStrings(input.conflictsWith ?? previous?.conflictsWith, 20, 64),
      hash: hashOf(title, content),
      createdAt,
      updatedAt,
      lastUsedAt: Number(input.lastUsedAt ?? previous?.lastUsedAt) || 0,
      useCount: Math.max(0, Math.trunc(Number(input.useCount ?? previous?.useCount)) || 0),
    },
  };
}

function emptyStore(agentId) {
  return { version: STORE_VERSION, agentId: safeId(agentId), updatedAt: 0, entries: [] };
}

async function loadStore(agentDir, agentId) {
  const file = storePath(agentDir, agentId);
  if (!file) return emptyStore(agentId);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return emptyStore(agentId);
  }
  const raw = Array.isArray(parsed) ? parsed : parsed?.entries;
  const entries = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const result = normalizeEntry(item, { agentId, now: nowMs() });
    if (result.ok) entries.push(result.entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return {
    version: STORE_VERSION,
    agentId: safeId(agentId),
    updatedAt: Number(parsed?.updatedAt) || 0,
    entries,
  };
}

async function saveStore(agentDir, agentId, store) {
  const file = storePath(agentDir, agentId);
  if (!file) throw new Error('Agent 的存储目录不可用');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = {
    version: STORE_VERSION,
    agentId: safeId(agentId),
    updatedAt: nowMs(),
    entries: Array.isArray(store?.entries) ? store.entries.slice(0, MAX_ENTRIES) : [],
  };
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(body, null, 2), 'utf8');
  await fs.rename(temp, file);
  return body;
}

async function appendEvent(agentDir, agentId, event) {
  const file = eventsPath(agentDir, agentId);
  if (!file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      `${JSON.stringify({ at: nowMs(), agentId: safeId(agentId), ...event })}\n`,
      'utf8',
    );
  } catch {
    /* the audit log must never break the memory operation */
  }
}

async function readEvents(agentDir, agentId, limit = 60) {
  const file = eventsPath(agentDir, agentId);
  if (!file) return [];
  let body;
  try {
    body = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn last line */
    }
  }
  return rows.slice(-Math.max(1, Math.min(limit, 300)));
}

function daysBetween(from, to) {
  return Math.round(((to - from) / DAY) * 10) / 10;
}

/**
 * Computed at read time, never stored: the same entry can be fresh today and
 * due tomorrow. `expired` and `disputed` are hard states — retrieval hides
 * them until the user resolves or rechecks the entry.
 */
function freshnessOf(entry, now = nowMs()) {
  const temporal = entry?.temporal ?? {};
  if (entry?.status === 'rejected') {
    return { state: 'archived', label: '已驳回', warning: '这条记忆已被驳回，不参与回答。' };
  }
  if (entry?.status === 'archived') {
    return { state: 'archived', label: '已归档', warning: '这条记忆已归档，不参与回答。' };
  }
  if (entry?.status === 'disputed') {
    return {
      state: 'disputed',
      label: '有争议',
      warning: '来源之间存在冲突，这条记忆在解决前不参与回答。',
    };
  }
  if (temporal.validUntil && now >= temporal.validUntil) {
    return {
      state: 'expired',
      label: '已过期',
      warning: '这条记忆已超过预计有效期，不能当作当前事实；涉及当前状态时必须重新核实。',
      daysSinceVerified: temporal.lastVerifiedAt ? daysBetween(temporal.lastVerifiedAt, now) : null,
    };
  }
  if (temporal.unverified) {
    return {
      state: 'stale',
      label: '未核实',
      warning: '最近一次核验没有找到可靠来源，这条记忆可能已经过时。',
      daysSinceVerified: temporal.lastVerifiedAt ? daysBetween(temporal.lastVerifiedAt, now) : null,
    };
  }
  if (temporal.nextCheckAt && now >= temporal.nextCheckAt) {
    return {
      state: 'due',
      label: '待复核',
      warning: '到了复核时间，涉及版本、价格、政策或当前状态时请先联网核实。',
      daysSinceVerified: temporal.lastVerifiedAt ? daysBetween(temporal.lastVerifiedAt, now) : null,
    };
  }
  return {
    state: 'fresh',
    label: '新鲜',
    warning: '',
    daysSinceVerified: temporal.lastVerifiedAt ? daysBetween(temporal.lastVerifiedAt, now) : null,
    daysUntilRecheck: temporal.nextCheckAt ? daysBetween(now, temporal.nextCheckAt) : null,
    daysUntilExpiry: temporal.validUntil ? daysBetween(now, temporal.validUntil) : null,
  };
}

function tokenize(value) {
  const text = String(value ?? '').toLowerCase().trim();
  const out = new Set();
  for (const item of text.split(/[\s,，。；;、/|]+/)) {
    if (item.length >= 2) out.add(item);
  }
  // Chinese queries often have no spaces; bigrams catch partial matches.
  const compact = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (compact.length >= 2) {
    for (let index = 0; index < compact.length - 1; index += 1) {
      out.add(compact.slice(index, index + 2));
    }
  }
  return [...out].slice(0, 24);
}

function scoreEntry(entry, tokens, now) {
  if (tokens.length === 0) return 1;
  const title = String(entry.title ?? '').toLowerCase();
  const content = String(entry.content ?? '').toLowerCase();
  const tags = (entry.tags ?? []).join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 4;
    if (tags.includes(token)) score += 3;
    if (content.includes(token)) score += 1;
  }
  if (score === 0) return 0;
  const freshness = freshnessOf(entry, now);
  if (freshness.state === 'fresh') score += 0.5;
  if (freshness.state === 'due') score -= 0.2;
  return score;
}

/**
 * Search confirmed memories. Expired entries are counted but not returned:
 * the model is told to verify the subject live instead of quoting a stale
 * fact. Due/stale entries are returned with an explicit warning.
 */
function searchEntries(store, query, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : nowMs();
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 8));
  const tokens = tokenize(query);
  const scored = [];
  let expired = 0;
  for (const entry of Array.isArray(store?.entries) ? store.entries : []) {
    if (entry.status !== 'confirmed') continue;
    const freshness = freshnessOf(entry, now);
    if (freshness.state === 'expired') {
      if (scoreEntry(entry, tokens, now) > 0) expired += 1;
      continue;
    }
    if (freshness.state === 'disputed' || freshness.state === 'archived') continue;
    const score = scoreEntry(entry, tokens, now);
    if (score <= 0) continue;
    scored.push({ entry, score, freshness });
  }
  scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  return {
    hits: scored.slice(0, limit).map((item) => ({ ...item.entry, freshness: item.freshness })),
    expired,
    query: String(query ?? ''),
    now,
  };
}

function dotProduct(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

/**
 * Keyword search fused with embeddings.
 *
 * Keyword alone misses paraphrases ("网安法对运营者有什么要求" vs a memory
 * titled "网络运营者普遍义务"); vectors alone pull up loosely related entries
 * in a same-domain store. So both contribute: cosine carries semantics, the
 * normalized keyword score carries exact names and article numbers. A memory
 * with no vector (embedding service unavailable) still ranks by keywords.
 */
function searchEntriesHybrid(store, query, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : nowMs();
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 8));
  const tokens = tokenize(query);
  const queryVector = options.queryVector ?? null;
  const vectors = options.vectors instanceof Map ? options.vectors : null;
  // Calibrated on the production store: unrelated queries peak around 0.20,
  // relevant ones start near 0.40.
  const semanticFloor = Number.isFinite(Number(options.semanticFloor))
    ? Number(options.semanticFloor)
    : 0.33;

  const rows = [];
  let expired = 0;
  for (const entry of Array.isArray(store?.entries) ? store.entries : []) {
    if (entry.status !== 'confirmed') continue;
    const freshness = freshnessOf(entry, now);
    if (freshness.state === 'expired') {
      if (scoreEntry(entry, tokens, now) > 0) expired += 1;
      continue;
    }
    if (freshness.state === 'disputed' || freshness.state === 'archived') continue;

    const keyword = scoreEntry(entry, tokens, now);
    const vector = vectors?.get(entry.id);
    const cosine = queryVector && vector ? dotProduct(queryVector, vector) : null;
    const semanticHit = cosine !== null && cosine >= semanticFloor;
    if (keyword <= 0 && !semanticHit) continue;
    rows.push({ entry, keyword, cosine, freshness });
  }

  const maxKeyword = rows.reduce((max, row) => Math.max(max, row.keyword), 0) || 1;
  for (const row of rows) {
    const keywordPart = row.keyword / maxKeyword;
    const semanticPart = row.cosine === null ? 0 : Math.max(0, row.cosine);
    row.score = 0.65 * semanticPart + 0.35 * keywordPart;
    if (row.freshness.state === 'fresh') row.score += 0.03;
    if (row.freshness.state === 'due' || row.freshness.state === 'stale') row.score -= 0.02;
  }
  rows.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);

  return {
    hits: rows
      .slice(0, limit)
      .map((item) => ({ ...item.entry, freshness: item.freshness })),
    expired,
    query: String(query ?? ''),
    now,
    mode: queryVector ? 'hybrid' : 'keyword',
    candidates: rows.length,
  };
}

function cardOf(entry, now = nowMs()) {
  const freshness = entry.freshness ?? freshnessOf(entry, now);
  return {
    id: entry.id,
    title: entry.title,
    content: String(entry.content ?? '').slice(0, 1200),
    type: entry.type,
    tags: entry.tags ?? [],
    confidence: entry.confidence,
    status: entry.status,
    updatedAt: entry.updatedAt,
    lastVerifiedAt: entry.temporal?.lastVerifiedAt ?? 0,
    temporal: {
      volatility: entry.temporal?.volatility ?? 'medium',
      ttlDays: entry.temporal?.ttlDays ?? 0,
      ttlReason: entry.temporal?.ttlReason ?? '',
      nextCheckAt: entry.temporal?.nextCheckAt ?? 0,
      validUntil: entry.temporal?.validUntil ?? 0,
    },
    freshness,
    sources: (entry.sources ?? []).slice(0, 5),
  };
}

function snapshotOf(store, now = nowMs()) {
  const entries = (Array.isArray(store?.entries) ? store.entries : []).map((entry) => ({
    ...entry,
    freshness: freshnessOf(entry, now),
  }));
  const stats = {
    total: entries.length,
    confirmed: entries.filter((entry) => entry.status === 'confirmed').length,
    candidate: entries.filter((entry) => entry.status === 'candidate').length,
    rejected: entries.filter((entry) => entry.status === 'rejected').length,
    disputed: entries.filter((entry) => entry.status === 'disputed').length,
    due: entries.filter(
      (entry) =>
        entry.status === 'confirmed' &&
        ['due', 'stale', 'expired'].includes(entry.freshness.state),
    ).length,
  };
  return { entries, stats, now };
}

/** Find a near-duplicate so repeated conversations do not pile up copies. */
function findDuplicate(entries, candidate) {
  const hash = candidate.hash;
  const candidateBody = `${candidate.title} ${candidate.content}`;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.hash === hash) return entry;
    const score = similarity(`${entry.title} ${entry.content}`, candidateBody);
    if (score >= 0.88) return entry;
    // A long body dilutes the bigram score, so a reused title (the extractor
    // is told to keep the existing title for the same fact) is checked alone.
    if (similarity(entry.title, candidate.title) >= 0.8) return entry;
  }
  return null;
}

function mergeDuplicate(target, candidate, now = nowMs()) {
  const sources = normalizeSources(
    [...(target.sources ?? []), ...(candidate.sources ?? [])],
    now,
  );
  const evidence = uniqueStrings(
    [...(target.evidence ?? []), ...(candidate.evidence ?? [])],
    MAX_EVIDENCE,
    500,
  );
  const tags = uniqueStrings([...(target.tags ?? []), ...(candidate.tags ?? [])], MAX_TAGS, 40);
  target.sources = sources;
  target.evidence = evidence;
  target.tags = tags;
  target.confidence = Math.max(target.confidence ?? 0, candidate.confidence ?? 0);
  target.updatedAt = now;
  // Re-learning a fact that had expired is fresh evidence of it; renew the
  // window instead of keeping a confirmed memory permanently stale.
  const freshness = freshnessOf(target, now);
  if (freshness.state === 'expired' || freshness.state === 'stale') {
    const preset = defaultTtl(target.temporal?.volatility);
    target.temporal.observedAt = now;
    target.temporal.validFrom = now;
    target.temporal.validUntil = now + (target.temporal.ttlDays || preset.ttlDays) * DAY;
    target.temporal.lastVerifiedAt = now;
    target.temporal.nextCheckAt = now + (target.temporal.recheckDays || preset.recheckDays) * DAY;
    target.temporal.unverified = false;
    target.temporal.checkCount = (target.temporal.checkCount ?? 0) + 1;
  }
  return target;
}

function snapshotEntry(target, options = {}) {
  return {
    revision: target.revision,
    title: target.title,
    content: target.content,
    tags: [...(target.tags ?? [])],
    sources: [...(target.sources ?? [])],
    replacedAt: Number(options.now) || nowMs(),
    reason: text(options.reason, 400),
    verifiedBy: text(options.verifiedBy, 40) || 'auto',
  };
}

/**
 * Apply a verification verdict. Returned `applied: false` means the entry is
 * manual or locked: the change is stored as a proposal and waits for the user.
 */
function applyVerdict(store, memoryId, verdict, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : nowMs();
  const entry = (store?.entries ?? []).find((item) => item.id === memoryId);
  if (!entry) return { ok: false, error: '记忆不存在。' };
  const kind = verdict?.kind;
  if (!['unchanged', 'changed', 'unverifiable', 'disputed'].includes(kind)) {
    return { ok: false, error: '未知的复核结果。' };
  }

  const mustAsk =
    kind === 'changed' &&
    !options.force &&
    (entry.locked || entry.origin === 'manual');
  if (mustAsk) {
    entry.proposal = normalizeProposal(
      {
        title: verdict.title || entry.title,
        content: verdict.content || entry.content,
        tags: verdict.tags ?? entry.tags,
        sources: verdict.sources ?? entry.sources,
        evidence: verdict.evidence ?? entry.evidence,
        confidence: verdict.confidence ?? entry.confidence,
        temporal: verdict.temporal,
        reason: verdict.reason || '复核发现内容有变化',
        verdict: 'changed',
        createdAt: now,
      },
      now,
    );
    entry.updatedAt = now;
    return { ok: true, applied: false, proposal: true, entry };
  }

  if (kind === 'unchanged') {
    entry.temporal.lastVerifiedAt = now;
    entry.temporal.checkCount = (entry.temporal.checkCount ?? 0) + 1;
    const backoff = Math.min(2 ** Math.min(entry.temporal.checkCount - 1, 2), 4);
    entry.temporal.nextCheckAt =
      now + (entry.temporal.recheckDays || defaultTtl(entry.temporal.volatility).recheckDays) * DAY * backoff;
    entry.temporal.unverified = false;
    entry.confidence = numberIn((entry.confidence ?? 0.6) + 0.02, 0, 1, 0.6);
    entry.updatedAt = now;
    entry.proposal = null;
    return { ok: true, applied: true, outcome: 'unchanged', entry };
  }

  if (kind === 'unverifiable') {
    entry.temporal.unverified = true;
    entry.temporal.lastVerifiedAt = now;
    entry.temporal.checkCount = (entry.temporal.checkCount ?? 0) + 1;
    entry.temporal.nextCheckAt = now + 7 * DAY;
    entry.confidence = numberIn((entry.confidence ?? 0.6) - 0.05, 0, 1, 0.55);
    entry.updatedAt = now;
    return { ok: true, applied: true, outcome: 'unverifiable', entry };
  }

  if (kind === 'disputed') {
    entry.status = 'disputed';
    entry.temporal.lastVerifiedAt = now;
    entry.temporal.nextCheckAt = now + 7 * DAY;
    entry.updatedAt = now;
    return { ok: true, applied: true, outcome: 'disputed', entry };
  }

  // changed
  const snapshot = snapshotEntry(entry);
  snapshot.reason = text(verdict.reason, 400) || '复核发现内容已变化';
  snapshot.verifiedBy = options.verifiedBy || 'auto';
  entry.history = [...(entry.history ?? []), snapshot].slice(-MAX_HISTORY);
  entry.revision = (entry.revision ?? 1) + 1;
  entry.title = text(verdict.title || entry.title, MAX_TITLE);
  entry.content = text(verdict.content || entry.content, MAX_CONTENT);
  entry.tags = uniqueStrings(verdict.tags ?? entry.tags, MAX_TAGS, 40);
  entry.sources = normalizeSources(verdict.sources ?? entry.sources, now);
  entry.evidence = uniqueStrings(verdict.evidence ?? entry.evidence, MAX_EVIDENCE, 500);
  entry.confidence = numberIn(
    verdict.confidence ?? entry.confidence ?? 0.7,
    0,
    1,
    0.7,
  );
  entry.temporal = normalizeTemporal(
    (() => {
      const next = {
        ...entry.temporal,
        ...(verdict.temporal ?? {}),
        observedAt: verdict.observedAt ?? now,
        validFrom: now,
        validUntil: undefined,
        lastVerifiedAt: now,
        nextCheckAt: undefined,
        checkCount: (entry.temporal.checkCount ?? 0) + 1,
        unverified: false,
      };
      // `next` carries the old ttl/recheck days as explicit values; drop them
      // when the verdict switches volatility so the new preset takes effect.
      const changedClass =
        verdict.temporal?.volatility &&
        verdict.temporal.volatility !== entry.temporal.volatility;
      if (changedClass && verdict.temporal?.ttlDays === undefined) delete next.ttlDays;
      if (changedClass && verdict.temporal?.recheckDays === undefined) delete next.recheckDays;
      return next;
    })(),
    now,
    entry.temporal,
  );
  entry.temporal.validFrom = now;
  entry.temporal.validUntil = now + entry.temporal.ttlDays * DAY;
  entry.temporal.nextCheckAt =
    now + (entry.temporal.recheckDays || defaultTtl(entry.temporal.volatility).recheckDays) * DAY;
  if (entry.status === 'disputed') entry.status = 'candidate';
  entry.proposal = null;
  entry.updatedAt = now;
  entry.hash = hashOf(entry.title, entry.content);
  return { ok: true, applied: true, outcome: 'changed', entry };
}

function applyProposal(store, memoryId, accept, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : nowMs();
  const entry = (store?.entries ?? []).find((item) => item.id === memoryId);
  if (!entry) return { ok: false, error: '记忆不存在。' };
  if (!entry.proposal) return { ok: false, error: '这条记忆没有待处理的更新。' };
  if (!accept) {
    entry.proposal = null;
    entry.updatedAt = now;
    return { ok: true, applied: false, dismissed: true, entry };
  }
  const proposal = entry.proposal;
  return applyVerdict(
    store,
    memoryId,
    {
      kind: 'changed',
      title: proposal.title,
      content: proposal.content,
      tags: proposal.tags,
      sources: proposal.sources,
      evidence: proposal.evidence,
      confidence: proposal.confidence,
      temporal: proposal.temporal,
      reason: proposal.reason,
    },
    { now, force: true, verifiedBy: 'user' },
  );
}

module.exports = {
  DAY,
  MAX_ENTRIES,
  TYPES,
  STATUSES,
  ORIGINS,
  VOLATILITIES,
  VOLATILITY,
  nowMs,
  memoriesDir,
  storePath,
  eventsPath,
  normalizeEntry,
  normalizeTemporal,
  emptyStore,
  loadStore,
  saveStore,
  appendEvent,
  readEvents,
  freshnessOf,
  searchEntries,
  searchEntriesHybrid,
  cardOf,
  snapshotOf,
  findDuplicate,
  mergeDuplicate,
  applyVerdict,
  applyProposal,
  snapshotEntry,
  similarity,
  fingerprintOf,
};
