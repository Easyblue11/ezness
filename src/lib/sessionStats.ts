import type { UsageRecord } from '../types';

/**
 * Everything the per-conversation stats panel shows, folded from the usage
 * ledger for one session. Records written before stream timing existed still
 * contribute token and cost totals; they simply have no speed.
 */
export interface SessionStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cost: number;
  unpricedRequests: number;
  /** Output tokens ÷ measured generation time; null until a timed request exists. */
  avgTokensPerSecond: number | null;
  /** Fastest one-second window seen in any request. */
  peakTokensPerSecond: number | null;
  /** Mean wait for the first streamed token. */
  avgFirstTokenMs: number | null;
  /** Sum of request wall-clock times. */
  totalDurationMs: number;
  lastAt: number | null;
  models: string[];
  /** Requests whose token counts came from the character estimate. */
  estimatedRequests: number;
}

export function sessionStats(records: UsageRecord[]): SessionStats {
  const models = new Set<string>();
  let generationMs = 0;
  let generationTokens = 0;
  let peak = 0;
  let ttftMs = 0;
  let ttftCount = 0;

  const stats: SessionStats = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    unpricedRequests: 0,
    avgTokensPerSecond: null,
    peakTokensPerSecond: null,
    avgFirstTokenMs: null,
    totalDurationMs: 0,
    lastAt: null,
    models: [],
    estimatedRequests: 0,
  };

  for (const record of records) {
    const output = record.outputTokens || 0;
    stats.requests += 1;
    stats.inputTokens += record.inputTokens || 0;
    stats.outputTokens += output;
    stats.cachedInputTokens += record.cachedInputTokens || 0;
    stats.reasoningTokens += record.reasoningTokens || 0;
    if (record.priced && typeof record.cost === 'number') stats.cost += record.cost;
    else stats.unpricedRequests += 1;
    if (!record.reported) stats.estimatedRequests += 1;
    if (record.model) models.add(record.model);
    if (typeof record.durationMs === 'number' && record.durationMs > 0) {
      stats.totalDurationMs += record.durationMs;
    }
    if (typeof record.at === 'number' && record.at > 0) {
      stats.lastAt = Math.max(stats.lastAt ?? 0, record.at);
    }

    // Prefer the measured generation window; fall back to the stored rate when
    // only that survived (it always travels with its output count).
    let windowMs = 0;
    if (typeof record.generationMs === 'number' && record.generationMs > 0) {
      windowMs = record.generationMs;
    } else if (
      typeof record.tokensPerSecond === 'number' &&
      record.tokensPerSecond > 0 &&
      output > 0
    ) {
      windowMs = (output / record.tokensPerSecond) * 1000;
    }
    if (windowMs > 0 && output > 0) {
      generationMs += windowMs;
      generationTokens += output;
    }

    if (typeof record.peakTokensPerSecond === 'number' && record.peakTokensPerSecond > peak) {
      peak = record.peakTokensPerSecond;
    }
    if (typeof record.firstTokenMs === 'number' && record.firstTokenMs > 0) {
      ttftMs += record.firstTokenMs;
      ttftCount += 1;
    }
  }

  if (generationMs > 0) {
    stats.avgTokensPerSecond = generationTokens / (generationMs / 1000);
  }
  if (peak > 0) stats.peakTokensPerSecond = peak;
  if (ttftCount > 0) stats.avgFirstTokenMs = ttftMs / ttftCount;
  stats.models = [...models];
  return stats;
}
