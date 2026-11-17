import type { AskLevel, WorkSettings } from '../types';

/**
 * Defaults: the step limit that shipped before it was configurable, cleaning
 * off, and a 128K-token window — the common size for current conversation
 * models. A 1M default made the ring read ~1% for prompts that were actually
 * near the model's real limit.
 */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

/** Rounds left untouched at the end of a conversation when compressing. */
export const DEFAULT_KEEP_TURNS = 3;

export const DEFAULT_WORK: WorkSettings = {
  maxSteps: 24,
  autoDeleteTemp: false,
  autoInstallDeps: true,
  askLevel: 3,
  contextLimit: DEFAULT_CONTEXT_LIMIT,
  compressionKeepTurns: DEFAULT_KEEP_TURNS,
};

/** Levels are the four stops of the slider; anything else keeps the default. */
export function normalizeAskLevel(value: unknown): AskLevel {
  const level = Math.trunc(Number(value));
  return level >= 0 && level <= 3 ? (level as AskLevel) : 3;
}

/**
 * A window smaller than 1k tokens is not a real model window; treat anything
 * unusable as "keep the default" instead of showing a ring stuck at 100%.
 */
export function normalizeContextLimit(value: unknown): number {
  const limit = Math.trunc(Number(value));
  return Number.isFinite(limit) && limit >= 1000 ? limit : DEFAULT_CONTEXT_LIMIT;
}

/** 1–10 rounds; anything else keeps the default. */
export function normalizeKeepTurns(value: unknown): number {
  const turns = Math.trunc(Number(value));
  return Number.isFinite(turns) && turns >= 1 && turns <= 10 ? turns : DEFAULT_KEEP_TURNS;
}

/** -1 = unlimited; otherwise at least one step. Unusable values fall back. */
export function normalizeWork(saved?: Partial<WorkSettings> | null): WorkSettings {
  const raw = Number(saved?.maxSteps);
  const steps = Number.isFinite(raw) && raw !== 0 ? Math.trunc(raw) : DEFAULT_WORK.maxSteps;
  return {
    maxSteps: steps === -1 ? -1 : Math.max(1, steps),
    autoDeleteTemp: saved?.autoDeleteTemp === true,
    // Missing means on: dependencies are installed for you by default.
    autoInstallDeps: saved?.autoInstallDeps !== false,
    askLevel: normalizeAskLevel(saved?.askLevel),
    contextLimit: normalizeContextLimit(saved?.contextLimit),
    compressionKeepTurns: normalizeKeepTurns(saved?.compressionKeepTurns),
  };
}
