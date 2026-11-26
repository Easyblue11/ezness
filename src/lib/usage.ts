/**
 * Usage ledger helpers: formatting, rollups and the day buckets the billing
 * page charts. Pure functions, so the rail tooltip and the full page always
 * agree on the numbers.
 */

import type { UsageFeature, UsageRecord, UsageSummary } from '../types';

/** Ledger costs are already CNY; this rate is only the caption fallback. */
export const DEFAULT_FX_RATE = 7.2;

export const EMPTY_SUMMARY: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cost: 0,
  requests: 0,
  unpricedRequests: 0,
};

/**
 * i18n keys for each ledger feature. Resolve them with `t()` at the render
 * site; this module is shared by components that already hold the translator.
 */
export const FEATURE_LABELS: Record<UsageFeature | string, string> = {
  chat: 'app.usage.feature.chat',
  compression: 'app.usage.feature.compression',
  prompt: 'app.usage.feature.prompt',
  workspace: 'app.usage.feature.workspace',
  review: 'app.usage.feature.review',
  sensory: 'app.usage.feature.sensory',
  'agent-review': 'app.usage.feature.agentReview',
  'workspace-viz': 'app.usage.feature.workspaceViz',
  other: 'app.usage.feature.other',
};

export function summarize(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = { ...EMPTY_SUMMARY };
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

export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfMonth(at: number): number {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 1,234 / 12.3K / 1.24M — compact but never rounds a non-zero count to 0. */
export function formatTokens(value: number): string {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const short = tokens / 1000;
    return `${short < 10 ? short.toFixed(2).replace(/\.?0+$/, '') : short.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const short = tokens / 1_000_000;
  return `${short < 10 ? short.toFixed(2).replace(/\.?0+$/, '') : short.toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '¥0.00';
  // Sub-cent amounts keep enough digits to stay non-zero; cheap models are
  // routinely below the four decimals that would otherwise print as ¥0.0000.
  if (Math.abs(value) < 0.0001) return `¥${value.toFixed(6)}`;
  if (Math.abs(value) < 0.01) return `¥${value.toFixed(4)}`;
  if (Math.abs(value) < 1) return `¥${value.toFixed(3)}`;
  return `¥${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCostExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `¥${value.toFixed(6)}`;
}

export function formatDateTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function dayLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

export interface DayPoint {
  key: string;
  at: number;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  requests: number;
  unpriced: number;
}

/** One bucket per calendar day, oldest first, including empty days. */
export function dailySeries(records: UsageRecord[], days: number, now = Date.now()): DayPoint[] {
  const points: DayPoint[] = [];
  const byKey = new Map<string, DayPoint>();
  const today = startOfDay(now);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const point: DayPoint = {
      key: dayKey(date.getTime()),
      at: date.getTime(),
      label: dayLabel(date.getTime()),
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      requests: 0,
      unpriced: 0,
    };
    points.push(point);
    byKey.set(point.key, point);
  }

  const from = points[0]?.at ?? today;
  for (const record of records) {
    if (record.at < from) continue;
    const point = byKey.get(dayKey(record.at));
    if (!point) continue;
    point.inputTokens += record.inputTokens || 0;
    point.outputTokens += record.outputTokens || 0;
    point.requests += 1;
    if (record.priced && typeof record.cost === 'number') point.cost += record.cost;
    else point.unpriced += 1;
  }
  return points;
}

export interface UsageGroup {
  key: string;
  label: string;
  summary: UsageSummary;
}

export function groupRecords(
  records: UsageRecord[],
  keyOf: (record: UsageRecord) => string,
  labelOf: (record: UsageRecord) => string,
): UsageGroup[] {
  const groups = new Map<string, { label: string; records: UsageRecord[] }>();
  for (const record of records) {
    const key = keyOf(record) || 'unknown';
    const current = groups.get(key);
    if (current) current.records.push(record);
    else groups.set(key, { label: labelOf(record) || key, records: [record] });
  }
  return [...groups.entries()]
    .map(([key, value]) => ({ key, label: value.label, summary: summarize(value.records) }))
    .sort(
      (a, b) =>
        b.summary.inputTokens + b.summary.outputTokens - (a.summary.inputTokens + a.summary.outputTokens),
    );
}
