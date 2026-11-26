import { useEffect, useRef, useState } from 'react';
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentReviewCatalog,
  AgentReviewChange,
  AgentReviewResult,
  ChatTarget,
  ToolCategory,
} from '../types';
import { buildReviewCatalog, mergeChanges } from './agentReview';
import { useI18n } from '../i18n';

/**
 * Review state for the Agent page.
 *
 * It lives above the dialog so closing the window does not cancel the review:
 * the request keeps running and the checklist is still there the next time the
 * user opens it. Nothing starts on its own — the user presses 开始审查.
 */

export type AgentReviewPhase = 'idle' | 'running' | 'ready' | 'error';

interface Options {
  target: ChatTarget | null;
  agents: AgentDefinition[];
  capabilities: AgentCapabilities | null;
  toolCategories: ToolCategory[];
  onAgentsChange: (agents: AgentDefinition[]) => void;
}

export interface AgentReviewState {
  phase: AgentReviewPhase;
  results: AgentReviewResult[];
  error: string;
  notice: string;
  applying: boolean;
  finishedAt: number | null;
  pending: AgentReviewChange[];
  selectedPending: AgentReviewChange[];
  isApplied: (id: string) => boolean;
  isSelected: (id: string) => boolean;
  start: () => Promise<void>;
  toggleSelected: (id: string) => void;
  selectAll: (checked: boolean) => void;
  apply: (ids: string[]) => Promise<void>;
}

export function useAgentReview({
  target,
  agents,
  capabilities,
  toolCategories,
  onAgentsChange,
}: Options): AgentReviewState {
  const api = window.ezness;
  const { t } = useI18n();
  const [phase, setPhase] = useState<AgentReviewPhase>('idle');
  const [results, setResults] = useState<AgentReviewResult[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [applied, setApplied] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState(false);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);

  const agentsRef = useRef(agents);
  const catalogRef = useRef<AgentReviewCatalog | null>(null);
  const applyingRef = useRef(false);
  const runningRef = useRef(false);
  /** Bumped on every start so a stale response can never overwrite a newer run. */
  const runRef = useRef(0);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  async function start() {
    if (runningRef.current || applyingRef.current) return;
    runningRef.current = true;
    const runId = ++runRef.current;
    setPhase('running');
    setError('');
    setNotice('');
    setResults([]);
    setSelected(new Set());
    setApplied(new Set());
    setFinishedAt(null);

    if (!api?.agentsReview) {
      runningRef.current = false;
      setPhase('error');
      setError(t('director.review.error.desktopOnly'));
      return;
    }
    if (!target) {
      runningRef.current = false;
      setPhase('error');
      setError(t('director.review.error.noModel'));
      return;
    }
    if (agents.length === 0) {
      runningRef.current = false;
      setPhase('error');
      setError(t('director.review.error.noAgents'));
      return;
    }

    try {
      const kb = await api.kbSnapshot?.().catch(() => null);
      if (runRef.current !== runId) return;
      const catalog = buildReviewCatalog(capabilities, toolCategories, kb ?? null);
      catalogRef.current = catalog;
      const response = await api.agentsReview({ provider: target, agents, catalog });
      if (runRef.current !== runId) return;
      if (!response?.ok || !response.results) {
        setPhase('error');
        setError(response?.error || t('director.review.error.failed'));
        return;
      }
      setResults(response.results);
      setPhase('ready');
      setFinishedAt(Date.now());
    } catch (err) {
      if (runRef.current !== runId) return;
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runRef.current === runId) runningRef.current = false;
    }
  }

  const pending = results.flatMap((result) =>
    result.changes.filter((change) => !applied.has(change.id)),
  );
  const selectedPending = pending.filter((change) => selected.has(change.id));

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(checked: boolean) {
    setSelected(checked ? new Set(pending.map((change) => change.id)) : new Set());
  }

  async function apply(ids: string[]) {
    if (!api || !catalogRef.current || applyingRef.current || runningRef.current || ids.length === 0) {
      return;
    }

    const byAgent = new Map<string, AgentReviewChange[]>();
    for (const result of results) {
      for (const change of result.changes) {
        if (!ids.includes(change.id) || applied.has(change.id)) continue;
        const list = byAgent.get(result.agentId) ?? [];
        list.push(change);
        byAgent.set(result.agentId, list);
      }
    }
    if (byAgent.size === 0) return;

    applyingRef.current = true;
    setApplying(true);
    setError('');
    setNotice('');
    let done = 0;

    try {
      for (const [agentId, changes] of byAgent) {
        const current = agentsRef.current.find((agent) => agent.id === agentId);
        if (!current) {
          setError(t('director.review.error.agentGone'));
          continue;
        }
        const next = mergeChanges(current, changes, catalogRef.current);
        const saved = await api.agentsSave(next);
        if (!saved?.ok) {
          setError(saved?.error || t('director.review.error.saveFailed'));
          continue;
        }
        agentsRef.current = saved.agents ?? agentsRef.current;
        onAgentsChange(agentsRef.current);
        setApplied((prev) => new Set([...prev, ...changes.map((change) => change.id)]));
        setSelected((prev) => {
          const nextSelected = new Set(prev);
          for (const change of changes) nextSelected.delete(change.id);
          return nextSelected;
        });
        done += changes.length;
      }
      if (done > 0) setNotice(t('director.review.notice.applied', { count: done }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  return {
    phase,
    results,
    error,
    notice,
    applying,
    finishedAt,
    pending,
    selectedPending,
    isApplied: (id) => applied.has(id),
    isSelected: (id) => selected.has(id),
    start,
    toggleSelected,
    selectAll,
    apply,
  };
}
