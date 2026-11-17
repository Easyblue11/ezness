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
  { ttlDays: number; recheckDays: number; label: string }
> = {
  static: { ttlDays: 1825, recheckDays: 365, label: '稳定' },
  slow: { ttlDays: 730, recheckDays: 180, label: '慢变' },
  medium: { ttlDays: 180, recheckDays: 90, label: '中变' },
  fast: { ttlDays: 30, recheckDays: 14, label: '快变' },
  realtime: { ttlDays: 2, recheckDays: 1, label: '实时' },
};

const TYPE_LABEL: Record<AgentMemoryType, string> = {
  fact: '事实',
  insight: '经验',
  preference: '偏好',
  procedure: '方法',
  note: '笔记',
};

const STATUS_LABEL: Record<AgentMemoryStatus, string> = {
  candidate: '待审核',
  confirmed: '已确认',
  rejected: '已驳回',
  archived: '已归档',
  disputed: '有争议',
};

const ORIGIN_LABEL: Record<string, string> = {
  learned: 'AI 学到',
  manual: '手动添加',
  imported: '导入',
};

type StatusFilter = 'all' | AgentMemoryStatus | 'attention';

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'candidate', label: '待审核' },
  { key: 'confirmed', label: '已确认' },
  { key: 'attention', label: '需复核' },
  { key: 'rejected', label: '已驳回' },
  { key: 'archived', label: '已归档' },
  { key: 'disputed', label: '有争议' },
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

function dateOf(value: number | undefined | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN');
}

function dateTimeOf(value: number | undefined | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
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

function editorOf(entry: AgentMemoryEntry): EditorState {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    tags: entry.tags.join('、'),
    confidence: entry.confidence,
    volatility: entry.temporal.volatility,
    ttlDays: entry.temporal.ttlDays,
    ttlReason: entry.temporal.ttlReason,
    locked: entry.locked,
  };
}

export function AgentMemoryPanel({ agentId, settings, onSettings }: Props) {
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
        setError(next.error || '读取记忆失败');
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
        setError(result.error || '操作失败');
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
      setError('标题和内容不能同时为空。');
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
          setNotice(editor.id ? '已保存修改' : '已新增记忆');
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
        setError(result.error || '保存设置失败');
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
        <h2>先保存 Agent</h2>
        <p>保存后，它会在多次对话中逐渐积累自己的长期记忆。</p>
      </div>
    );
  }

  return (
    <div className="agent-memory">
      <div className="agent-memory__bar">
        <div className="agent-memory__stats">
          <span>
            共 <b>{stats?.total ?? 0}</b> 条
          </span>
          <span>
            已确认 <b>{stats?.confirmed ?? 0}</b>
          </span>
          <span className={stats?.candidate ? 'is-warn' : ''}>
            待审核 <b>{stats?.candidate ?? 0}</b>
          </span>
          <span className={stats?.due ? 'is-warn' : ''}>
            需复核 <b>{stats?.due ?? 0}</b>
          </span>
          {Boolean(stats?.disputed) && <span className="is-danger">有争议 {stats?.disputed}</span>}
        </div>
        <div className="agent-memory__actions">
          <button className="btn btn--ghost" onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon size={14} />
            {loading ? '读取中…' : '刷新'}
          </button>
          <button className="btn btn--primary" onClick={() => setEditor(emptyEditor())}>
            <PlusIcon size={14} />
            新增记忆
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
          <span>对话后自动学习</span>
        </label>
        <label className="agent-switch">
          <input
            type="checkbox"
            checked={settings.autoConfirm}
            disabled={busy === 'settings' || !settings.enabled}
            onChange={(event) => void toggleSettings({ autoConfirm: event.target.checked })}
          />
          <span>自动确认学到的记忆（免逐条审核）</span>
        </label>
        <label className="agent-switch">
          <input
            type="checkbox"
            checked={settings.allowWebRecheck}
            disabled={busy === 'settings'}
            onChange={(event) => void toggleSettings({ allowWebRecheck: event.target.checked })}
          />
          <span>到期后自动联网复核</span>
        </label>
      </div>

      <p className="agent-hint">
        只有「已确认」且未过期的记忆会进入回答。学到的内容默认自动确认并立即生效，你可以在下面随时修改、驳回或删除；
        关闭开关后，新记忆会先停在待审核。需要复核时它会重新搜索并更新，内容发生变化时保留旧版本，方便你对照。
      </p>

      <div className="agent-memory__filters">
        <div className="agent-memory__tabs">
          {STATUS_FILTERS.map((item) => (
            <button
              key={item.key}
              className={`agent-memory__tab ${filter === item.key ? 'is-on' : ''}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <select
          className="agent-doc__select"
          value={typeFilter}
          aria-label="记忆类型"
          onChange={(event) => setTypeFilter(event.target.value as 'all' | AgentMemoryType)}
        >
          <option value="all">全部类型</option>
          {Object.entries(TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="input agent-memory__search"
          value={query}
          placeholder="搜索标题、内容或标签"
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
            <h3>{editor.id ? '编辑记忆' : '新增记忆'}</h3>
            <div className="agent-memory__editor-actions">
              <button className="btn btn--ghost" onClick={() => setEditor(null)} disabled={busy === 'save'}>
                取消
              </button>
              <button className="btn btn--primary" onClick={() => void saveEditor()} disabled={busy === 'save'}>
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
            </div>
          </div>

          <div className="agent-form__row">
            <label className="field">
              <span className="field__label">类型</span>
              <select
                className="input"
                value={editor.type}
                onChange={(event) =>
                  setEditor({ ...editor, type: event.target.value as AgentMemoryType })
                }
              >
                {Object.entries(TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">置信度</span>
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
            <span className="field__label">标题</span>
            <input
              className="input"
              value={editor.title}
              maxLength={160}
              placeholder="一句话说明这条记忆"
              onChange={(event) => setEditor({ ...editor, title: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">内容</span>
            <textarea
              className="input agent-form__textarea"
              rows={4}
              value={editor.content}
              maxLength={8000}
              placeholder="可直接阅读的事实、经验或方法。"
              onChange={(event) => setEditor({ ...editor, content: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">
              标签
              <span className="field__hint">用顿号或逗号分隔</span>
            </span>
            <input
              className="input"
              value={editor.tags}
              placeholder="例如：Electron、构建、版本"
              onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
            />
          </label>

          <div className="agent-form__row">
            <label className="field">
              <span className="field__label">可改变程度</span>
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
                    {VOLATILITY_FALLBACK[key].label} · 复核 {volatilityMap[key]?.recheckDays ?? 0} 天
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">有效期（天）</span>
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
              时效判断依据
              <span className="field__hint">为什么这个内容能保持这么久</span>
            </span>
            <input
              className="input"
              value={editor.ttlReason}
              maxLength={400}
              placeholder="例如：协议规范，短期不会改动。"
              onChange={(event) => setEditor({ ...editor, ttlReason: event.target.value })}
            />
          </label>

          <label className="agent-switch">
            <input
              type="checkbox"
              checked={editor.locked}
              onChange={(event) => setEditor({ ...editor, locked: event.target.checked })}
            />
            <span>锁定：自动复核发现变化时，先向我确认再改</span>
          </label>
        </section>
      )}

      {loading && !snapshot ? (
        <p className="agent-hint">正在读取长期记忆…</p>
      ) : visible.length === 0 ? (
        <div className="agent-empty agent-empty--inline">
          <h2>{entries.length === 0 ? '还没有长期记忆' : '没有符合筛选条件的记忆'}</h2>
          <p>
            {entries.length === 0
              ? '完成几次对话后，它会把相对可靠、以后仍有用的内容整理到这里，先作为待审核条目。'
              : '换一个筛选条件，或清空搜索关键词。'}
          </p>
          <button className="btn btn--primary" onClick={() => setEditor(emptyEditor())}>
            <PlusIcon size={14} />
            手动添加一条
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
                    {STATUS_LABEL[entry.status]}
                  </span>
                  <span className="agent-memory__title">{entry.title}</span>
                  <span className="agent-memory__meta">
                    <span>{TYPE_LABEL[entry.type]}</span>
                    <span>{ORIGIN_LABEL[entry.origin] ?? entry.origin}</span>
                    {fresh && (
                      <span className={`agent-memory__fresh ${freshTone(fresh.state)}`}>
                        {fresh.label}
                      </span>
                    )}
                    <span>{dateOf(entry.updatedAt)}</span>
                  </span>
                </button>

                {open && (
                  <div className="agent-memory__detail">
                    <p className="agent-memory__content">{entry.content}</p>

                    {entry.proposal && (
                      <div className="agent-memory__proposal">
                        <h4>复核发现内容有变化</h4>
                        <p className="agent-memory__proposal-title">{entry.proposal.title}</p>
                        <p className="agent-memory__content">{entry.proposal.content}</p>
                        {entry.proposal.reason && (
                          <p className="agent-hint">原因：{entry.proposal.reason}</p>
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
                            采用新内容
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
                            保持原样
                          </button>
                        </div>
                      </div>
                    )}

                    <dl className="agent-memory__facts">
                      <div>
                        <dt>观察时间</dt>
                        <dd>{dateTimeOf(entry.temporal.observedAt)}</dd>
                      </div>
                      <div>
                        <dt>上次核验</dt>
                        <dd>{dateTimeOf(entry.temporal.lastVerifiedAt)}</dd>
                      </div>
                      <div>
                        <dt>有效期至</dt>
                        <dd>{dateOf(entry.temporal.validUntil)}</dd>
                      </div>
                      <div>
                        <dt>下次复核</dt>
                        <dd>{dateOf(entry.temporal.nextCheckAt)}</dd>
                      </div>
                      <div>
                        <dt>可改变程度</dt>
                        <dd>
                          {volatilityMap[entry.temporal.volatility]?.label ??
                            entry.temporal.volatility}{' '}
                          · {entry.temporal.ttlDays} 天
                        </dd>
                      </div>
                      <div>
                        <dt>置信度</dt>
                        <dd>{entry.confidence.toFixed(2)}</dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd>第 {entry.revision} 版</dd>
                      </div>
                      <div>
                        <dt>被引用</dt>
                        <dd>{entry.useCount} 次</dd>
                      </div>
                    </dl>

                    {entry.temporal.ttlReason && (
                      <p className="agent-hint">时效依据：{entry.temporal.ttlReason}</p>
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
                        <h4>来源</h4>
                        <ul>
                          {entry.sources.map((source, index) => (
                            <li key={`${source.kind}-${index}`}>
                              {source.kind === 'web' ? (
                                <a href={source.url} target="_blank" rel="noreferrer">
                                  {source.title || source.url}
                                </a>
                              ) : source.kind === 'conversation' ? (
                                '来自对话记录'
                              ) : (
                                '手动添加'
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {entry.evidence.length > 0 && (
                      <div className="agent-memory__sources">
                        <h4>依据摘录</h4>
                        <ul>
                          {entry.evidence.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {entry.history.length > 0 && (
                      <details className="agent-memory__history">
                        <summary>历史版本（{entry.history.length}）</summary>
                        {[...entry.history].reverse().map((item, index) => (
                          <div key={`${item.revision}-${index}`} className="agent-memory__history-item">
                            <span>
                              第 {item.revision} 版 · {dateTimeOf(item.replacedAt)}
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
                          确认采用
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
                          驳回
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
                          归档
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
                          恢复使用
                        </button>
                      )}
                      <button
                        className="btn btn--ghost"
                        disabled={busy === entry.id}
                        title="联网核对这条记忆现在是否仍然正确"
                        onClick={() =>
                          void (async () => {
                            setBusy(entry.id);
                            setError('');
                            setNotice('');
                            try {
                              const result = await api!.agentsMemoryRecheck(agentId, entry.id);
                              if (!result.ok) setError(result.error || '复核失败');
                              else {
                                const kindLabel =
                                  result.kind === 'unchanged'
                                    ? '仍然正确，已刷新核验时间'
                                    : result.kind === 'changed'
                                      ? result.proposal
                                        ? '发现变化，已生成待确认的更新'
                                        : '发现变化，已写入新版本'
                                      : result.kind === 'disputed'
                                        ? '来源互相矛盾，已标记为有争议'
                                        : '没有找到可靠来源，已标记为未核实';
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
                        {busy === entry.id ? '复核中…' : '立即复核'}
                      </button>
                      <button
                        className="btn btn--ghost"
                        disabled={busy === entry.id}
                        onClick={() => {
                          setEditor(editorOf(entry));
                          setNotice('');
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn--danger"
                        disabled={busy === entry.id}
                        onClick={() => setConfirmDelete(entry)}
                      >
                        <TrashIcon size={14} />
                        删除
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
          title="删除这条记忆？"
          message={`「${confirmDelete.title}」会从长期记忆中移除，以后不会再用到。历史版本也会一起删除。`}
          confirmLabel="删除"
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
