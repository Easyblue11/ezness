import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentDefinition,
  AgentMemoryEntry,
  AgentMemoryInput,
  AgentMemorySettings,
  AgentMemorySnapshot,
  AgentMemoryStatus,
  AgentMemoryType,
  AgentMemoryVolatility,
} from '../types';
import { useI18n } from '../i18n';
import { CheckIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Long-term memory of one Agent.
 *
 * The store is plain JSON on disk; this panel is the readable view of it.
 * Everything stays editable: add, edit, delete, confirm, reject, recheck now.
 * Freshness is computed by the main process from the entry's validity window,
 * so what the panel shows is exactly what retrieval will see.
 */

const VOLATILITY_FALLBACK: Record<
  AgentMemoryVolatility,
  { ttlDays: number; recheckDays: number }
> = {
  static: { ttlDays: 1825, recheckDays: 365 },
  slow: { ttlDays: 730, recheckDays: 180 },
  medium: { ttlDays: 180, recheckDays: 90 },
  fast: { ttlDays: 30, recheckDays: 14 },
  realtime: { ttlDays: 2, recheckDays: 1 },
};

const VOLATILITY_LABEL_KEY: Record<AgentMemoryVolatility, string> = {
  static: 'director.memory.volatility.static',
  slow: 'director.memory.volatility.slow',
  medium: 'director.memory.volatility.medium',
  fast: 'director.memory.volatility.fast',
  realtime: 'director.memory.volatility.realtime',
};

const TYPE_LABEL_KEY: Record<AgentMemoryType, string> = {
  fact: 'director.memory.type.fact',
  insight: 'director.memory.type.insight',
  preference: 'director.memory.type.preference',
  procedure: 'director.memory.type.procedure',
  note: 'director.memory.type.note',
};

const STATUS_LABEL_KEY: Record<AgentMemoryStatus, string> = {
  candidate: 'director.memory.status.candidate',
  confirmed: 'director.memory.status.confirmed',
  rejected: 'director.memory.status.rejected',
  archived: 'director.memory.status.archived',
  disputed: 'director.memory.status.disputed',
};

const ORIGIN_LABEL_KEY: Record<string, string> = {
  learned: 'director.memory.origin.learned',
  manual: 'director.memory.origin.manual',
  imported: 'director.memory.origin.imported',
};

type StatusFilter = 'all' | AgentMemoryStatus | 'attention';

const STATUS_FILTERS: { key: StatusFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'director.memory.filter.all' },
  { key: 'candidate', labelKey: 'director.memory.filter.candidate' },
  { key: 'confirmed', labelKey: 'director.memory.filter.confirmed' },
  { key: 'attention', labelKey: 'director.memory.filter.attention' },
  { key: 'rejected', labelKey: 'director.memory.filter.rejected' },
  { key: 'archived', labelKey: 'director.memory.filter.archived' },
  { key: 'disputed', labelKey: 'director.memory.filter.disputed' },
];

interface EditorState {
  id: string;
  type: AgentMemoryType;
  title: string;
  content: string;
  tags: string;
  confidence: number;
  volatility: AgentMemoryVolatility;
  ttlDays: number;
  ttlReason: string;
  locked: boolean;
}

interface Props {
  agentId: string;
  settings: AgentMemorySettings;
  onSettings: (settings: AgentMemorySettings, agents: AgentDefinition[]) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateOf(value: number | undefined | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(locale);
}

function dateTimeOf(value: number | undefined | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function freshTone(state: string | undefined): string {
  if (state === 'fresh') return 'is-fresh';
  if (state === 'due') return 'is-due';
  if (state === 'stale') return 'is-stale';
  if (state === 'expired') return 'is-expired';
  if (state === 'disputed') return 'is-disputed';
  return 'is-archived';
}

function emptyEditor(volatility: AgentMemoryVolatility = 'medium'): EditorState {
  return {
    id: '',
    type: 'fact',
    title: '',
    content: '',
    tags: '',
    confidence: 0.8,
    volatility,
    ttlDays: VOLATILITY_FALLBACK[volatility].ttlDays,
    ttlReason: '',
    locked: false,
  };
}

function editorOf(entry: AgentMemoryEntry, separator: string): EditorState {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    tags: entry.tags.join(separator),
    confidence: entry.confidence,
    volatility: entry.temporal.volatility,
    ttlDays: entry.temporal.ttlDays,
    ttlReason: entry.temporal.ttlReason,
    locked: entry.locked,
  };
}

export function AgentMemoryPanel({ agentId, settings, onSettings }: Props) {
  const { t, locale } = useI18n();
  const api = window.ezness;
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | AgentMemoryType>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [expanded, setExpanded] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<AgentMemoryEntry | null>(null);
  const timer = useRef(0);

  const refresh = useCallback(async () => {
    if (!api || !agentId) return;
    setLoading(true);
    setError('');
    try {
      const next = await api.agentsMemorySnapshot(agentId);
      if (!next.ok) {
        setError(next.error || t('director.memory.error.read'));
        return;
      }
      setSnapshot(next);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [api, agentId]);

  useEffect(() => {
    setSnapshot(null);
    setEditor(null);
    setExpanded('');
    if (agentId) void refresh();
  }, [agentId, refresh]);

  useEffect(() => {
    if (!api || !agentId) return;
    const off = api.onAgentMemoryEvent((event) => {
      if (event.agentId !== agentId) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void refresh(), 300);
    });
    return () => {
      window.clearTimeout(timer.current);
      off();
    };
  }, [api, agentId, refresh]);

  const entries = snapshot?.entries ?? [];
  const stats = snapshot?.stats;
  const volatilityMap = snapshot?.volatility ?? VOLATILITY_FALLBACK;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => {
        if (typeFilter !== 'all' && entry.type !== typeFilter) return false;
        if (filter === 'attention') {
          const state = entry.freshness?.state;
          if (!['due', 'stale', 'expired'].includes(state ?? '')) return false;
        } else if (filter !== 'all' && entry.status !== filter) {
          return false;
        }
        if (!needle) return true;
        return `${entry.title} ${entry.content} ${entry.tags.join(' ')}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => {
        // What needs attention first, then newest.
        const rank = (entry: AgentMemoryEntry) => {
          if (entry.proposal) return -2;
          if (entry.status === 'candidate') return -1;
          if (['due', 'stale', 'expired'].includes(entry.freshness?.state ?? '')) return 0;
          return 1;
        };
        return rank(left) - rank(right) || right.updatedAt - left.updatedAt;
      });
  }, [entries, filter, query, typeFilter]);

  async function run(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    if (!api) return;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error || t('director.memory.error.failed'));
        return;
      }
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }

  async function saveEditor() {
    if (!api || !editor) return;
    if (!editor.title.trim() && !editor.content.trim()) {
      setError(t('director.memory.error.empty'));
      return;
    }
    const input: AgentMemoryInput = {
      ...(editor.id ? { id: editor.id } : {}),
      type: editor.type,
      title: editor.title,
      content: editor.content,
      tags: editor.tags
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      confidence: editor.confidence,
      locked: editor.locked,
      temporal: {
        volatility: editor.volatility,
        ttlDays: editor.ttlDays,
        ttlReason: editor.ttlReason,
      },
      ...(editor.id ? {} : { status: 'confirmed' as const }),
    };
    await run(
      'save',
      async () => {
        const result = await api.agentsMemorySave(agentId, input);
        if (result.ok) {
          setEditor(null);
          setNotice(
            editor.id ? t('director.memory.notice.saved') : t('director.memory.notice.added'),
          );
        }
        return result;
      },
    );
  }

  async function toggleSettings(patch: Partial<AgentMemorySettings>) {
    if (!api) return;
    setBusy('settings');
    setError('');
    try {
      const result = await api.agentsMemoryConfig(agentId, patch);
      if (!result.ok || !result.memory || !result.agents) {
        setError(result.error || t('director.memory.error.saveSettings'));
        return;
      }
      onSettings(result.memory, result.agents);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }

  if (!agentId) {
    return (
      <div className="agent-empty agent-empty--inline">
        <h2>{t('director.memory.noAgent.title')}</h2>
        <p>{t('director.memory.noAgent.desc')}</p>
      </div>
    );
  }

  return (
    <div className="agent-memory">
      <div className="agent-memory__bar">
        <div className="agent-memory__stats">
          <span>
            {t('director.memory.stat.totalBefore')}
            <b>{stats?.total ?? 0}</b>
            {t('director.memory.stat.totalAfter')}
          </span>
          <span>
            {t('director.memory.stat.confirmedBefore')}
            <b>{stats?.confirmed ?? 0}</b>
            {t('director.memory.stat.confirmedAfter')}
          </span>
          <span className={stats?.candidate ? 'is-warn' : ''}>
            {t('director.memory.stat.candidateBefore')}
            <b>{stats?.candidate ?? 0}</b>
            {t('director.memory.stat.candidateAfter')}
          </span>
          <span className={stats?.due ? 'is-warn' : ''}>
            {t('director.memory.stat.dueBefore')}
            <b>{stats?.due ?? 0}</b>
            {t('director.memory.stat.dueAfter')}
          </span>
          {Boolean(stats?.disputed) && (
            <span className="is-danger">
              {t('director.memory.stat.disputed', { count: stats?.disputed ?? 0 })}
            </span>
          )}
        </div>
        <div className="agent-memory__actions">
          <button className="btn btn--ghost" onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon size={14} />
            {loading ? t('director.memory.refresh.loading') : t('director.memory.refresh')}
          </button>
          <button className="btn btn--primary" onClick={() => setEditor(emptyEditor())}>
            <PlusIcon size={14} />
            {t('director.memory.add')}
          </button>
        </div>
      </div>

      <div className="agent-memory__switches">
        <label className="agent-switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy === 'settings'}
            onChange={(event) => void toggleSettings({ enabled: event.target.checked })}
          />
          <span>{t('director.memory.autoLearn')}</span>
        </label>
        <label className="agent-switch">
          <input
            type="checkbox"
            checked={settings.autoConfirm}
            disabled={busy === 'settings' || !settings.enabled}
            onChange={(event) => void toggleSettings({ autoConfirm: event.target.checked })}
          />
          <span>{t('director.memory.autoConfirm')}</span>
        </label>
        <label className="agent-switch">
          <input
            type="checkbox"
            checked={settings.allowWebRecheck}
            disabled={busy === 'settings'}
            onChange={(event) => void toggleSettings({ allowWebRecheck: event.target.checked })}
          />
          <span>{t('director.memory.webRecheck')}</span>
        </label>
      </div>

      <p className="agent-hint">{t('director.memory.intro')}</p>

      <div className="agent-memory__filters">
        <div className="agent-memory__tabs">
          {STATUS_FILTERS.map((item) => (
            <button
              key={item.key}
              className={`agent-memory__tab ${filter === item.key ? 'is-on' : ''}`}
              onClick={() => setFilter(item.key)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
        <select
          className="agent-doc__select"
          value={typeFilter}
          aria-label={t('director.memory.typeAria')}
          onChange={(event) => setTypeFilter(event.target.value as 'all' | AgentMemoryType)}
        >
          <option value="all">{t('director.memory.allTypes')}</option>
          {Object.entries(TYPE_LABEL_KEY).map(([value, labelKey]) => (
            <option key={value} value={value}>
              {t(labelKey)}
            </option>
          ))}
        </select>
        <input
          className="input agent-memory__search"
          value={query}
          placeholder={t('director.memory.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error && <p className="agent-error">{error}</p>}
      {notice && (
        <p className="agent-ok">
          <CheckIcon size={13} />
          {notice}
        </p>
      )}

      {editor && (
        <section className="agent-memory__editor">
          <div className="agent-memory__editor-head">
            <h3>{editor.id ? t('director.memory.editor.editTitle') : t('director.memory.add')}</h3>
            <div className="agent-memory__editor-actions">
              <button className="btn btn--ghost" onClick={() => setEditor(null)} disabled={busy === 'save'}>
                {t('director.common.cancel')}
              </button>
              <button className="btn btn--primary" onClick={() => void saveEditor()} disabled={busy === 'save'}>
                {busy === 'save' ? t('director.common.saving') : t('director.common.save')}
              </button>
            </div>
          </div>

          <div className="agent-form__row">
            <label className="field">
              <span className="field__label">{t('director.memory.field.type')}</span>
              <select
                className="input"
                value={editor.type}
                onChange={(event) =>
                  setEditor({ ...editor, type: event.target.value as AgentMemoryType })
                }
              >
                {Object.entries(TYPE_LABEL_KEY).map(([value, labelKey]) => (
                  <option key={value} value={value}>
                    {t(labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{t('director.memory.field.confidence')}</span>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={editor.confidence}
                onChange={(event) =>
                  setEditor({ ...editor, confidence: Number(event.target.value) })
                }
              />
            </label>
          </div>

          <label className="field">
            <span className="field__label">{t('director.memory.field.title')}</span>
            <input
              className="input"
              value={editor.title}
              maxLength={160}
              placeholder={t('director.memory.field.titlePlaceholder')}
              onChange={(event) => setEditor({ ...editor, title: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('director.memory.field.content')}</span>
            <textarea
              className="input agent-form__textarea"
              rows={4}
              value={editor.content}
              maxLength={8000}
              placeholder={t('director.memory.field.contentPlaceholder')}
              onChange={(event) => setEditor({ ...editor, content: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">
              {t('director.memory.field.tags')}
              <span className="field__hint">{t('director.memory.field.tagsHint')}</span>
            </span>
            <input
              className="input"
              value={editor.tags}
              placeholder={t('director.memory.field.tagsPlaceholder')}
              onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
            />
          </label>

          <div className="agent-form__row">
            <label className="field">
              <span className="field__label">{t('director.memory.field.volatility')}</span>
              <select
                className="input"
                value={editor.volatility}
                onChange={(event) => {
                  const volatility = event.target.value as AgentMemoryVolatility;
                  setEditor({
                    ...editor,
                    volatility,
                    ttlDays: volatilityMap[volatility]?.ttlDays ?? editor.ttlDays,
                  });
                }}
              >
                {(Object.keys(VOLATILITY_FALLBACK) as AgentMemoryVolatility[]).map((key) => (
                  <option key={key} value={key}>
                    {t('director.memory.volatilityOption', {
                      label: t(VOLATILITY_LABEL_KEY[key]),
                      days: volatilityMap[key]?.recheckDays ?? 0,
                    })}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{t('director.memory.field.ttlDays')}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={3650}
                value={editor.ttlDays}
                onChange={(event) =>
                  setEditor({ ...editor, ttlDays: Number(event.target.value) })
                }
              />
            </label>
          </div>

          <label className="field">
            <span className="field__label">
              {t('director.memory.field.ttlReason')}
              <span className="field__hint">{t('director.memory.field.ttlReasonHint')}</span>
            </span>
            <input
              className="input"
              value={editor.ttlReason}
              maxLength={400}
              placeholder={t('director.memory.field.ttlReasonPlaceholder')}
              onChange={(event) => setEditor({ ...editor, ttlReason: event.target.value })}
            />
          </label>

          <label className="agent-switch">
            <input
              type="checkbox"
              checked={editor.locked}
              onChange={(event) => setEditor({ ...editor, locked: event.target.checked })}
            />
            <span>{t('director.memory.lockHint')}</span>
          </label>
        </section>
      )}

      {loading && !snapshot ? (
        <p className="agent-hint">{t('director.memory.loading')}</p>
      ) : visible.length === 0 ? (
        <div className="agent-empty agent-empty--inline">
          <h2>
            {entries.length === 0
              ? t('director.memory.empty.title')
              : t('director.memory.empty.filteredTitle')}
          </h2>
          <p>
            {entries.length === 0
              ? t('director.memory.empty.desc')
              : t('director.memory.empty.filteredDesc')}
          </p>
          <button className="btn btn--primary" onClick={() => setEditor(emptyEditor())}>
            <PlusIcon size={14} />
            {t('director.memory.empty.add')}
          </button>
        </div>
      ) : (
        <div className="agent-memory__list">
          {visible.map((entry) => {
            const open = expanded === entry.id;
            const fresh = entry.freshness;
            return (
              <article key={entry.id} className={`agent-memory__item ${open ? 'is-open' : ''}`}>
                <button
                  className="agent-memory__summary"
                  onClick={() => setExpanded(open ? '' : entry.id)}
                >
                  <span className={`agent-memory__badge is-${entry.status}`}>
                    {t(STATUS_LABEL_KEY[entry.status])}
                  </span>
                  <span className="agent-memory__title">{entry.title}</span>
                  <span className="agent-memory__meta">
                    <span>{t(TYPE_LABEL_KEY[entry.type])}</span>
                    <span>
                      {ORIGIN_LABEL_KEY[entry.origin]
                        ? t(ORIGIN_LABEL_KEY[entry.origin])
                        : entry.origin}
                    </span>
                    {fresh && (
                      <span className={`agent-memory__fresh ${freshTone(fresh.state)}`}>
                        {fresh.label}
                      </span>
                    )}
                    <span>{dateOf(entry.updatedAt, locale)}</span>
                  </span>
                </button>

                {open && (
                  <div className="agent-memory__detail">
                    <p className="agent-memory__content">{entry.content}</p>

                    {entry.proposal && (
                      <div className="agent-memory__proposal">
                        <h4>{t('director.memory.proposal.title')}</h4>
                        <p className="agent-memory__proposal-title">{entry.proposal.title}</p>
                        <p className="agent-memory__content">{entry.proposal.content}</p>
                        {entry.proposal.reason && (
                          <p className="agent-hint">
                            {t('director.memory.proposal.reason', {
                              reason: entry.proposal.reason,
                            })}
                          </p>
                        )}
                        <div className="agent-memory__row-actions">
                          <button
                            className="btn btn--primary"
                            disabled={busy === entry.id}
                            onClick={() =>
                              void run('proposal', () =>
                                api!.agentsMemoryProposal(agentId, entry.id, true),
                              )
                            }
                          >
                            {t('director.memory.proposal.accept')}
                          </button>
                          <button
                            className="btn btn--ghost"
                            disabled={busy === entry.id}
                            onClick={() =>
                              void run('proposal', () =>
                                api!.agentsMemoryProposal(agentId, entry.id, false),
                              )
                            }
                          >
                            {t('director.memory.proposal.keep')}
                          </button>
                        </div>
                      </div>
                    )}

                    <dl className="agent-memory__facts">
                      <div>
                        <dt>{t('director.memory.fact.observedAt')}</dt>
                        <dd>{dateTimeOf(entry.temporal.observedAt, locale)}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.fact.lastVerifiedAt')}</dt>
                        <dd>{dateTimeOf(entry.temporal.lastVerifiedAt, locale)}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.fact.validUntil')}</dt>
                        <dd>{dateOf(entry.temporal.validUntil, locale)}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.fact.nextCheckAt')}</dt>
                        <dd>{dateOf(entry.temporal.nextCheckAt, locale)}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.field.volatility')}</dt>
                        <dd>
                          {t('director.memory.fact.volatilityValue', {
                            label: t(VOLATILITY_LABEL_KEY[entry.temporal.volatility]),
                            days: entry.temporal.ttlDays,
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.field.confidence')}</dt>
                        <dd>{entry.confidence.toFixed(2)}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.fact.version')}</dt>
                        <dd>{t('director.memory.fact.revision', { count: entry.revision })}</dd>
                      </div>
                      <div>
                        <dt>{t('director.memory.fact.useCount')}</dt>
                        <dd>{t('director.memory.fact.usedTimes', { count: entry.useCount })}</dd>
                      </div>
                    </dl>

                    {entry.temporal.ttlReason && (
                      <p className="agent-hint">
                        {t('director.memory.ttlReasonNote', { reason: entry.temporal.ttlReason })}
                      </p>
                    )}
                    {fresh?.warning && <p className="agent-memory__warning">{fresh.warning}</p>}

                    {entry.tags.length > 0 && (
                      <div className="agent-memory__tags">
                        {entry.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}

                    {entry.sources.length > 0 && (
                      <div className="agent-memory__sources">
                        <h4>{t('director.memory.sources')}</h4>
                        <ul>
                          {entry.sources.map((source, index) => (
                            <li key={`${source.kind}-${index}`}>
                              {source.kind === 'web' ? (
                                <a href={source.url} target="_blank" rel="noreferrer">
                                  {source.title || source.url}
                                </a>
                              ) : source.kind === 'conversation' ? (
                                t('director.memory.source.conversation')
                              ) : (
                                t('director.memory.source.manual')
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {entry.evidence.length > 0 && (
                      <div className="agent-memory__sources">
                        <h4>{t('director.memory.evidence')}</h4>
                        <ul>
                          {entry.evidence.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {entry.history.length > 0 && (
                      <details className="agent-memory__history">
                        <summary>
                          {t('director.memory.history', { count: entry.history.length })}
                        </summary>
                        {[...entry.history].reverse().map((item, index) => (
                          <div key={`${item.revision}-${index}`} className="agent-memory__history-item">
                            <span>
                              {t('director.memory.historyItem', {
                                revision: item.revision,
                                date: dateTimeOf(item.replacedAt, locale),
                              })}
                            </span>
                            <b>{item.title}</b>
                            <p>{item.content}</p>
                            {item.reason && <em>{item.reason}</em>}
                          </div>
                        ))}
                      </details>
                    )}

                    <div className="agent-memory__row-actions">
                      {entry.status !== 'confirmed' && (
                        <button
                          className="btn btn--ghost"
                          disabled={busy === entry.id}
                          onClick={() =>
                            void run(entry.id, () =>
                              api!.agentsMemoryReview(agentId, entry.id, 'confirm'),
                            )
                          }
                        >
                          {t('director.memory.action.confirm')}
                        </button>
                      )}
                      {entry.status !== 'rejected' && (
                        <button
                          className="btn btn--ghost"
                          disabled={busy === entry.id}
                          onClick={() =>
                            void run(entry.id, () =>
                              api!.agentsMemoryReview(agentId, entry.id, 'reject'),
                            )
                          }
                        >
                          {t('director.memory.action.reject')}
                        </button>
                      )}
                      {entry.status === 'confirmed' && (
                        <button
                          className="btn btn--ghost"
                          disabled={busy === entry.id}
                          onClick={() =>
                            void run(entry.id, () =>
                              api!.agentsMemoryReview(agentId, entry.id, 'archive'),
                            )
                          }
                        >
                          {t('director.memory.action.archive')}
                        </button>
                      )}
                      {(entry.status === 'archived' || entry.status === 'rejected') && (
                        <button
                          className="btn btn--ghost"
                          disabled={busy === entry.id}
                          onClick={() =>
                            void run(entry.id, () =>
                              api!.agentsMemoryReview(agentId, entry.id, 'restore'),
                            )
                          }
                        >
                          {t('director.memory.action.restore')}
                        </button>
                      )}
                      <button
                        className="btn btn--ghost"
                        disabled={busy === entry.id}
                        title={t('director.memory.action.recheckTitle')}
                        onClick={() =>
                          void (async () => {
                            setBusy(entry.id);
                            setError('');
                            setNotice('');
                            try {
                              const result = await api!.agentsMemoryRecheck(agentId, entry.id);
                              if (!result.ok)
                                setError(result.error || t('director.memory.error.recheck'));
                              else {
                                const kindLabel =
                                  result.kind === 'unchanged'
                                    ? t('director.memory.recheck.unchanged')
                                    : result.kind === 'changed'
                                      ? result.proposal
                                        ? t('director.memory.recheck.changedProposal')
                                        : t('director.memory.recheck.changedApplied')
                                      : result.kind === 'disputed'
                                        ? t('director.memory.recheck.disputed')
                                        : t('director.memory.recheck.unverified');
                                setNotice(kindLabel);
                                await refresh();
                              }
                            } catch (caught) {
                              setError(messageOf(caught));
                            } finally {
                              setBusy('');
                            }
                          })()
                        }
                      >
                        {busy === entry.id
                          ? t('director.memory.action.rechecking')
                          : t('director.memory.action.recheck')}
                      </button>
                      <button
                        className="btn btn--ghost"
                        disabled={busy === entry.id}
                        onClick={() => {
                          setEditor(
                            editorOf(entry, t('director.memory.tagsSeparator')),
                          );
                          setNotice('');
                        }}
                      >
                        {t('director.memory.action.edit')}
                      </button>
                      <button
                        className="btn btn--danger"
                        disabled={busy === entry.id}
                        onClick={() => setConfirmDelete(entry)}
                      >
                        <TrashIcon size={14} />
                        {t('director.memory.action.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('director.memory.delete.title')}
          message={t('director.memory.delete.message', { title: confirmDelete.title })}
          confirmLabel={t('director.memory.action.delete')}
          danger
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void run(target.id, () => api!.agentsMemoryDelete(agentId, target.id));
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
