import type {
  AgentDefinition,
  ChatTarget,
  Message,
  UsageRecord,
  WorkspaceVisualizeResult,
} from '../types';
import {
  buildWorkspaceVizContext,
  type VizChatLike,
  type VizWorkspaceLike,
} from './workspaceViz';
import { collectLocalTables } from './vizFiles';
import { attachTableRefs } from './vizTableRefs';

/**
 * A visualization run outlives the dialog that started it.
 *
 * Closing the tool must not throw the generation away: the request keeps
 * running in the main process, and reopening the dialog finds either the same
 * run still in flight or the dashboard it produced. Only an explicit 停止 (or
 * closing the whole window) cancels.
 */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Used when the caller has no i18n hook (e.g. a run resumed after reopening). */
const ENGLISH_FALLBACK: Record<string, string> = {
  'viz.run.unsupported': 'This version cannot generate visualizations. Update the app first.',
  'viz.run.failed': 'Generation failed. Try again.',
};

const defaultTranslate: Translate = (key) => ENGLISH_FALLBACK[key] ?? key;

export type VizRunStatus = 'running' | 'done' | 'error' | 'stopped';

export interface VizRunSnapshot {
  status: VizRunStatus;
  result: WorkspaceVisualizeResult | null;
  error: string;
}

export interface VizRunInput {
  /** Workspace + chat the run belongs to (see storeKey in the dialog). */
  key: string;
  workspaceId: string;
  workspace: VizWorkspaceLike;
  activeChatId: string;
  chats: VizChatLike[];
  messages: Message[];
  usage: UsageRecord[];
  agents: AgentDefinition[];
  scope: 'task' | 'workspace';
  topic: string;
  provider: ChatTarget;
  /** Called with the finished dashboard, even if the dialog is closed by then. */
  onResult: (result: WorkspaceVisualizeResult) => void;
  /** The i18n `t` function, so run errors follow the interface language. */
  translate?: Translate;
}

const runs = new Map<string, VizRunSnapshot>();
/** Bumped by 停止 / 清空 / a new run, so late answers are ignored. */
const generations = new Map<string, number>();
/** Id of the request the main process is streaming, per key. */
const requests = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function emit(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of [...set]) listener();
}

function commit(key: string, snapshot: VizRunSnapshot): void {
  runs.set(key, snapshot);
  emit(key);
}

export function vizRunSnapshot(key: string): VizRunSnapshot | null {
  return runs.get(key) ?? null;
}

export function subscribeVizRun(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function clearVizRun(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  runs.delete(key);
  requests.delete(key);
  emit(key);
}

/** Stop the run in flight, if any. Nothing it produces will be shown. */
export function stopVizRun(key: string): void {
  const current = runs.get(key);
  if (!current || current.status !== 'running') return;
  generations.set(key, (generations.get(key) ?? 0) + 1);
  const requestId = requests.get(key);
  requests.delete(key);
  if (requestId) window.ezness?.workspaceVizCancel?.(requestId);
  commit(key, { status: 'stopped', result: null, error: '' });
}

export function startVizRun(input: VizRunInput): void {
  // A double click lands before the button re-renders disabled; never let it
  // orphan the request that just started.
  if (runs.get(input.key)?.status === 'running') return;
  const translate = input.translate ?? defaultTranslate;
  const api = window.ezness;
  if (!api?.workspaceVisualize) {
    commit(input.key, {
      status: 'error',
      result: null,
      error: translate('viz.run.unsupported'),
    });
    return;
  }
  const generation = (generations.get(input.key) ?? 0) + 1;
  generations.set(input.key, generation);
  requests.delete(input.key);
  commit(input.key, { status: 'running', result: null, error: '' });
  void execute(input, generation);
}

async function execute(input: VizRunInput, generation: number): Promise<void> {
  const current = () => generations.get(input.key) === generation;
  try {
    // Tables the agent wrote to disk are read first so the model gets exact
    // rows instead of having to copy numbers out of prose.
    const extraTables = await collectLocalTables(input.workspaceId);
    if (!current()) return;

    const context = buildWorkspaceVizContext(
      input.workspace,
      input.chats,
      input.messages,
      input.usage,
      (id) => input.agents.find((agent) => agent.id === id)?.name,
      {
        focusChatId: input.scope === 'task' ? input.activeChatId : undefined,
        extraTables,
      },
    );

    const translate = input.translate ?? defaultTranslate;
    const api = window.ezness;
    if (!api?.workspaceVisualize) throw new Error(translate('viz.run.unsupported'));

    const requestId = `viz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    requests.set(input.key, requestId);
    const next = await api.workspaceVisualize({
      provider: input.provider,
      topic: input.topic,
      context,
      requestId,
    });
    if (requests.get(input.key) === requestId) requests.delete(input.key);
    if (!current()) return;

    if (next.aborted) {
      commit(input.key, { status: 'stopped', result: null, error: '' });
      return;
    }
    if (next.ok) {
      // Charts that came out of a sampled file keep a link to it, so the card
      // can offer the full table later.
      const enriched = attachTableRefs(next, extraTables);
      input.onResult(enriched);
      commit(input.key, { status: 'done', result: enriched, error: '' });
      return;
    }
    commit(input.key, {
      status: 'error',
      result: null,
      error: next.error || translate('viz.run.failed'),
    });
  } catch (reason) {
    if (!current()) return;
    commit(input.key, {
      status: 'error',
      result: null,
      error: reason instanceof Error ? reason.message : String(reason),
    });
  }
}
