'use strict';

/**
 * Work patterns: what the program keeps doing over and over.
 *
 * This module is deliberately model-free. It folds every finished run into a
 * small fingerprint (what was asked, which tools ran, what came out, what it
 * cost) and keeps a rolling 30-day picture. Only when a shape of work repeats
 * across tasks does the service spend one model call to decide whether it is a
 * generic capability worth presetting. Nothing here writes files, creates tools
 * or changes the workspace — it only produces evidence.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITS = {
  windowMs: 30 * DAY_MS,
  maxRuns: 40,
  maxPatterns: 60,
  /** 3 次相似的活才算“重复”。 */
  minRuns: 3,
  /** 至少跨两个任务/空间，单次任务里重复不算通用。 */
  minTasks: 2,
  /** 一轮里同一个动作被调用 5 次以上，也算一个信号。 */
  repeatInRun: 5,
  /** 同一类建议 7 天内不重复打扰。 */
  cooldownMs: 7 * DAY_MS,
  /** 证据没多出 2 次运行就不再打扰。 */
  evidenceStep: 2,
  /** 每天最多 2 张必读。 */
  daily: 2,
  /** 连续忽略 3 次就静默 30 天。 */
  ignores: 3,
  muteMs: 30 * DAY_MS,
};

/** Writing or executing something: the run actually produced work. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command', 'todo_write']);

function oneLine(value, limit = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function clip(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) : text;
}

/** CJK bigrams plus latin words — same idea as the director's similarity. */
function tokens(value) {
  const text = String(value ?? '').toLowerCase();
  const latin = text.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = text.match(/[一-鿿]/g) ?? [];
  const grams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) grams.push(cjk[i] + cjk[i + 1]);
  if (cjk.length === 1) grams.push(cjk[0]);
  return new Set([...latin, ...grams]);
}

function similarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function extOf(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase().slice(0, 8) : '';
}

/** One finished run, reduced to what repeats are made of. */
function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = clip(oneLine(raw.intent, 400), 400);
  const tools = (Array.isArray(raw.tools) ? raw.tools : [])
    .map((tool) => ({
      name: oneLine(tool?.name ?? tool, 40).replace(/[^\w.:-]/g, ''),
      count: Math.max(1, Math.min(500, Number(tool?.count) || 1)),
    }))
    .filter((tool) => tool.name)
    .slice(0, 12);
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map((file) => ({
      name: oneLine(file?.name ?? file, 160),
      kind: file?.kind === 'directory' ? 'directory' : 'file',
      ext: extOf(file?.name ?? file),
    }))
    .filter((file) => file.name)
    .slice(0, 20);
  const toolTotal = Number(raw.toolTotal) || tools.reduce((sum, tool) => sum + tool.count, 0);
  const writes =
    Number(raw.writes) ||
    tools.reduce((sum, tool) => sum + (WRITE_TOOLS.has(tool.name) ? tool.count : 0), 0);
  const inputTokens = Math.max(0, Number(raw.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(raw.outputTokens) || 0);
  const at = Number(raw.at) || Date.now();
  const taskId = String(raw.taskId ?? '').trim();
  if (!intent && tools.length === 0) return null;
  return {
    id: String(raw.id ?? '').trim() || `run_${at}_${taskId}`,
    at,
    taskId,
    taskTitle: oneLine(raw.taskTitle, 120),
    space: oneLine(raw.space ?? raw.workspaceId ?? '', 120),
    intent,
    tools,
    toolTotal,
    writes,
    files,
    ok: raw.ok !== false,
    durationMs: Math.max(0, Number(raw.durationMs) || 0),
    inputTokens,
    outputTokens,
    requests: Math.max(0, Number(raw.requests) || 0),
    cost: Math.max(0, Number(raw.cost) || 0),
  };
}

function topToolNames(run, limit = 3) {
  return [...(run?.tools ?? [])]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((tool) => tool.name);
}

function overlapOf(left, right) {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const name of a) if (b.has(name)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * How much two runs look like the same kind of work. Same tools + similar ask.
 * A run with no tools at all (pure chat) never matches one that used tools.
 */
function runSimilarity(a, b) {
  const sim = similarity(a?.intent, b?.intent);
  const left = topToolNames(a);
  const right = topToolNames(b);
  if (left.length === 0 || right.length === 0) return sim >= 0.75 ? sim : 0;
  const overlap = overlapOf(left, right);
  if (sim >= 0.7) return sim;
  return sim >= 0.45 && overlap >= 0.34 ? sim : 0;
}

function maxToolCount(run) {
  return (run?.tools ?? []).reduce((max, tool) => Math.max(max, tool.count), 0);
}

function statsOf(pattern) {
  const runs = pattern?.runs ?? [];
  const taskIds = new Set(runs.map((run) => run.taskId).filter(Boolean));
  const spaces = new Set(runs.map((run) => run.space).filter(Boolean));
  const totalMs = runs.reduce((sum, run) => sum + run.durationMs, 0);
  const totalTokens = runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0);
  const firstAt = runs.reduce((min, run) => (min ? Math.min(min, run.at) : run.at), 0);
  const lastAt = runs.reduce((max, run) => Math.max(max, run.at), 0);
  return {
    count: runs.length,
    tasks: taskIds.size,
    spaces: spaces.size,
    taskIds: [...taskIds],
    totalMs,
    totalTokens,
    avgMs: runs.length ? Math.round(totalMs / runs.length) : 0,
    avgTokens: runs.length ? Math.round(totalTokens / runs.length) : 0,
    writes: runs.filter((run) => run.writes > 0).length,
    fileRuns: runs.filter((run) => run.files.length > 0).length,
    repeat: runs.reduce((max, run) => Math.max(max, maxToolCount(run)), 0),
    firstAt,
    lastAt,
  };
}

function normalizePattern(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runs = (Array.isArray(raw.runs) ? raw.runs : [])
    .map(normalizeRun)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(-LIMITS.maxRuns);
  if (runs.length === 0) return null;
  const key = String(raw.key ?? '').trim() || `wp_${runs[0].id}`;
  return {
    key,
    runs,
    adviceAt: Number(raw.adviceAt) || 0,
    adviceRuns: Number(raw.adviceRuns) || 0,
    /** 上次建议的原文：审计界面要能回看总监当时说了什么。 */
    adviceTitle: oneLine(raw.adviceTitle, 120),
    adviceBody: clip(raw.adviceBody ?? '', 3000),
    judgedAt: Number(raw.judgedAt) || 0,
    judgedRuns: Number(raw.judgedRuns) || 0,
    ignore: Math.max(0, Number(raw.ignore) || 0),
    mutedUntil: Number(raw.mutedUntil) || 0,
    dismissed: Math.max(0, Number(raw.dismissed) || 0),
  };
}

/** Persisted state: patterns plus when we last bothered the user. */
function normalizeState(raw) {
  const patterns = (Array.isArray(raw?.patterns) ? raw.patterns : [])
    .map(normalizePattern)
    .filter(Boolean)
    .slice(-LIMITS.maxPatterns);
  const advice = (Array.isArray(raw?.advice) ? raw.advice : [])
    .map((at) => Number(at) || 0)
    .filter(Boolean)
    .sort((a, b) => a - b)
    .slice(-200);
  return { patterns, advice };
}

/**
 * Attach a run to the closest recent pattern, or start a new one.
 * Returns { patterns, pattern } — the caller persists patterns.
 */
function attachRun(patterns, run, now = Date.now()) {
  const list = Array.isArray(patterns) ? patterns : [];
  let best = null;
  let bestScore = 0;
  for (const pattern of list) {
    const stats = statsOf(pattern);
    if (now - stats.lastAt > LIMITS.windowMs) continue;
    // Compare against both ends of the cluster so a gradual drift in wording
    // still lands in the same bucket, but a new kind of work starts fresh.
    const latest = pattern.runs[pattern.runs.length - 1];
    const first = pattern.runs[0];
    const score = Math.max(runSimilarity(run, latest), runSimilarity(run, first) * 0.95);
    if (score > bestScore) {
      bestScore = score;
      best = pattern;
    }
  }
  if (!best || bestScore <= 0) {
    const created = {
      key: `wp_${run.id}`,
      runs: [run],
      adviceAt: 0,
      adviceRuns: 0,
      adviceTitle: '',
      adviceBody: '',
      judgedAt: 0,
      judgedRuns: 0,
      ignore: 0,
      mutedUntil: 0,
      dismissed: 0,
    };
    list.push(created);
    while (list.length > LIMITS.maxPatterns) list.shift();
    return { patterns: list, pattern: created, created: true };
  }
  best.runs.push(run);
  best.runs.sort((a, b) => a.at - b.at);
  best.runs = best.runs.slice(-LIMITS.maxRuns);
  return { patterns: list, pattern: best, created: false };
}

/** Drop runs older than the window; empty patterns go away entirely. */
function prune(patterns, now = Date.now()) {
  const list = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const runs = pattern.runs.filter((run) => now - run.at <= LIMITS.windowMs);
    if (runs.length === 0) continue;
    pattern.runs = runs;
    list.push(pattern);
  }
  return list.slice(-LIMITS.maxPatterns);
}

/**
 * Is this pattern worth a model call? Local, deterministic, cheap.
 * Returns null or a reason string.
 */
function candidateReason(pattern, now = Date.now()) {
  const stats = statsOf(pattern);
  if (stats.count === 0) return null;
  if (now - stats.lastAt > LIMITS.windowMs) return null;
  const spread = Math.max(stats.tasks, stats.spaces);
  if (spread < LIMITS.minTasks) return null;
  const repeated = stats.repeat >= LIMITS.repeatInRun;
  const worked = stats.writes > 0 || stats.fileRuns > 0 || repeated;
  if (!worked) return null;
  if (stats.count < LIMITS.minRuns && !(repeated && stats.count >= 2)) return null;
  return repeated ? 'action-repeat' : 'cross-task';
}

function countRecent(advice, now, windowMs = DAY_MS) {
  return (Array.isArray(advice) ? advice : []).filter((at) => now - at < windowMs).length;
}

/**
 * May we speak now? Keeps the must-read channel rare enough to stay must-read.
 */
function canAdvise(pattern, { now = Date.now(), advice = [] } = {}) {
  if (!pattern) return { ok: false, reason: 'missing' };
  if (pattern.mutedUntil > now) return { ok: false, reason: 'muted' };
  if (pattern.ignore >= LIMITS.ignores) return { ok: false, reason: 'ignored' };
  if (countRecent(advice, now) >= LIMITS.daily) return { ok: false, reason: 'daily' };
  const grown = pattern.runs.length - (pattern.adviceRuns || 0);
  if (pattern.adviceAt > 0 && now - pattern.adviceAt < LIMITS.cooldownMs && grown < LIMITS.evidenceStep) {
    return { ok: false, reason: 'cooldown' };
  }
  // A model that already said “not generic” is not asked every single run.
  if (pattern.judgedAt > 0 && pattern.runs.length - (pattern.judgedRuns || 0) < LIMITS.evidenceStep) {
    return { ok: false, reason: 'judged' };
  }
  return { ok: true, reason: '' };
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatClock(ts) {
  const date = new Date(Number(ts) || 0);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分钟`;
}

function formatTokens(count) {
  const value = Math.max(0, Number(count) || 0);
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

/** The evidence lines shown on the card and handed to the model. */
function evidenceLines(pattern, limit = 6) {
  const runs = [...(pattern?.runs ?? [])].sort((a, b) => b.at - a.at).slice(0, limit);
  return runs.map((run) => {
    const parts = [formatClock(run.at)];
    if (run.taskTitle) parts.push(`「${run.taskTitle}」`);
    parts.push(formatDuration(run.durationMs));
    const tokens = run.inputTokens + run.outputTokens;
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    if (run.files.length > 0) parts.push(`产出 ${run.files.length} 个文件`);
    if (run.writes > 0) parts.push(`${run.writes} 次写操作`);
    const top = run.tools[0];
    if (top) parts.push(`${top.name}×${top.count}`);
    return `· ${parts.join(' ')}`;
  });
}

/** Deterministic headline when the model is silent (used in tests/fallbacks). */
function describe(pattern) {
  const stats = statsOf(pattern);
  return `${stats.count} 次相似的工作，跨 ${Math.max(stats.tasks, stats.spaces)} 个任务，共 ${formatDuration(
    stats.totalMs,
  )}、${formatTokens(stats.totalTokens)} tok`;
}

function toolSummary(pattern) {
  const counts = new Map();
  for (const run of pattern?.runs ?? []) {
    for (const tool of run.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + tool.count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
}

function fileSummary(pattern) {
  const counts = new Map();
  for (const run of pattern?.runs ?? []) {
    for (const file of run.files) {
      const key = file.kind === 'directory' ? '项目文件夹' : file.ext || '无扩展名';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `${key}×${count}`)
    .join('、');
}

/** 一类重复工作的短名：取最近一次的原话，没有原话就用动作组合。 */
function titleOf(pattern) {
  const runs = [...(pattern?.runs ?? [])].sort((a, b) => b.at - a.at);
  const intent = runs.map((run) => oneLine(run.intent, 120)).find(Boolean);
  if (intent) return clip(intent, 30);
  const tools = toolSummary(pattern);
  return tools ? `用 ${tools}` : '未命名的工作';
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * The audit report: what repeated, how much it cost, and what could be
 * reclaimed. Deterministic — the numbers are the evidence, the model only ever
 * adds advice on top. `reclaim` counts the repeats, not the first run: doing a
 * job once is not waste.
 */
function auditOf(patterns, now = Date.now()) {
  const list = Array.isArray(patterns) ? patterns : [];
  const items = [];
  let runs = 0;
  let allMs = 0;
  let allTokens = 0;
  let advice = 0;
  let ignored = 0;
  let muted = 0;

  for (const pattern of list) {
    const stats = statsOf(pattern);
    if (stats.count === 0) continue;
    runs += stats.count;
    allMs += stats.totalMs;
    allTokens += stats.totalTokens;
    if (pattern.adviceAt > 0) advice += 1;
    ignored += Math.max(0, Number(pattern.ignore) || 0);
    if (pattern.mutedUntil > now) muted += 1;
    if (stats.count < 2) continue;
    const repeats = stats.count - 1;
    const reason = candidateReason(pattern, now);
    items.push({
      key: pattern.key,
      title: titleOf(pattern),
      runs: stats.count,
      tasks: Math.max(stats.tasks, stats.spaces),
      totalMs: stats.totalMs,
      totalTokens: stats.totalTokens,
      avgMs: stats.avgMs,
      avgTokens: stats.avgTokens,
      reclaimMs: stats.avgMs * repeats,
      reclaimTokens: stats.avgTokens * repeats,
      repeat: stats.repeat,
      lastAt: stats.lastAt,
      evidence: evidenceLines(pattern, 4),
      candidate: Boolean(reason),
      reason: reason || '',
      adviceAt: Number(pattern.adviceAt) || 0,
      adviceTitle: oneLine(pattern.adviceTitle, 120),
      adviceBody: String(pattern.adviceBody ?? '').slice(0, 3000),
      ignored: Math.max(0, Number(pattern.ignore) || 0),
      muted: pattern.mutedUntil > now,
    });
  }

  items.sort(
    (a, b) => b.reclaimMs - a.reclaimMs || b.reclaimTokens - a.reclaimTokens || b.runs - a.runs,
  );
  const reclaimMs = items.reduce((sum, item) => sum + item.reclaimMs, 0);
  const reclaimTokens = items.reduce((sum, item) => sum + item.reclaimTokens, 0);
  const pending = items.filter((item) => item.candidate && !item.adviceAt).length;

  let summary;
  if (items.length === 0) {
    summary = runs === 0
      ? '近 30 天还没有记下带动作的工作：跑几次带工具的任务，审计才有东西可看。'
      : `近 30 天记下 ${runs} 次有产出的工作，都只做过一次，暂时没有重复投入。`;
  } else {
    const top = items[0];
    summary =
      `近 30 天记下 ${runs} 次有产出的工作，其中 ${items.length} 类重复出现。` +
      `重复投入了 ${formatDuration(reclaimMs)}、${formatTokens(reclaimTokens)} tok，` +
      `占全部投入的 ${percent(reclaimMs, allMs)}%（按时间算）。` +
      `最该预制的是「${top.title}」：出现 ${top.runs} 次、跨 ${top.tasks} 个任务，` +
      `预计能回收 ${formatDuration(top.reclaimMs)}。`;
    if (pending > 0) summary += `\n\n有 ${pending} 类已经达到可以预制标准，还没给你发过建议。`;
    if (muted > 0) summary += `\n\n${muted} 类你说过先不用，暂时不再提。`;
    if (advice > 0) summary += `\n\n已经给过 ${advice} 条建议，下滑能看到当时的结论。`;
  }

  return {
    at: now,
    windowDays: Math.round(LIMITS.windowMs / DAY_MS),
    items,
    pending,
    totals: {
      runs,
      patterns: list.length,
      repeated: items.length,
      totalMs: allMs,
      totalTokens: allTokens,
      reclaimMs,
      reclaimTokens,
      share: percent(reclaimMs, allMs),
      advice,
      ignored,
      muted,
    },
    summary,
  };
}

module.exports = {
  LIMITS,
  WRITE_TOOLS,
  normalizeRun,
  normalizePattern,
  normalizeState,
  attachRun,
  prune,
  statsOf,
  candidateReason,
  canAdvise,
  countRecent,
  evidenceLines,
  describe,
  auditOf,
  titleOf,
  toolSummary,
  fileSummary,
  runSimilarity,
  similarity,
  formatDuration,
  formatTokens,
  formatClock,
  topToolNames,
};
