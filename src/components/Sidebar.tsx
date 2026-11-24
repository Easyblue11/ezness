import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message, Session } from '../types';
import { findSnippet, textByConversation } from '../lib/search';
import { ActivityDot, type ActivityStatus } from './ActivityDot';
import { ConfirmDialog } from './ConfirmDialog';
import { CheckIcon, MoreIcon, PinIcon, PlusIcon, SearchIcon } from './Icons';

const DAY = 86_400_000;
const GROUP_ORDER = ['今天', '昨天', '本周', '更早'] as const;

/** Stable empty index for the no-search case. */
const NO_TEXTS: Map<string, string[]> = new Map();

function groupOf(timestamp: number): (typeof GROUP_ORDER)[number] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return '今天';
  if (timestamp >= startOfToday - DAY) return '昨天';
  if (timestamp >= startOfToday - 7 * DAY) return '本周';
  return '更早';
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

interface Props {
  sessions: Session[];
  /** Transcripts of every 对话 session, searched alongside the titles. */
  messages: Message[];
  activeId: string;
  query: string;
  modelLabel: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** Batch delete; the sidebar asks for confirmation before calling this. */
  onDeleteMany: (ids: string[]) => void;
  onExport: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  /** 每个会话的状态圆点；不在表里表示空闲。 */
  activity?: Map<string, ActivityStatus>;
}

interface MenuState {
  id: string;
  top: number;
  right: number;
}

export function Sidebar({
  sessions,
  messages,
  activeId,
  query,
  modelLabel,
  onQuery,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onDeleteMany,
  onExport,
  onPin,
  activity,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** Multi-select: rows toggle instead of opening, a bar appears above the footer. */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);

  // A session matches on its title or on anything said in it; content hits get
  // a snippet so the row says why it is there.
  // The index costs a pass over every message, and `messages` changes on every
  // streamed token. Only build it while a search is actually running.
  const keyword = query.trim().toLowerCase();
  const messageTexts = useMemo(
    () => (keyword ? textByConversation(messages) : NO_TEXTS),
    [messages, keyword],
  );
  const snippets = useMemo(() => {
    const map = new Map<string, string>();
    if (!keyword) return map;
    for (const session of sessions) {
      if (session.title.toLowerCase().includes(keyword)) continue;
      const snippet = findSnippet(messageTexts.get(session.id), keyword);
      if (snippet) map.set(session.id, snippet);
    }
    return map;
  }, [sessions, keyword, messageTexts]);
  const visible = keyword
    ? sessions.filter((s) => s.title.toLowerCase().includes(keyword) || snippets.has(s.id))
    : sessions;

  // Pinned sessions get their own group on top. Inside each group the most
  // recently active session comes first, so an answer just given is at the top
  // of its day group instead of staying wherever it was created.
  const ordered = [...visible].sort(
    (a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      b.updatedAt - a.updatedAt,
  );
  const pinned = ordered.filter((s) => s.pinned);
  const grouped: { label: string; items: Session[] }[] = [
    ...(pinned.length > 0 ? [{ label: '置顶', items: pinned }] : []),
    ...GROUP_ORDER.map((label) => ({
      label: label as string,
      items: ordered.filter((s) => !s.pinned && groupOf(s.updatedAt) === label),
    })).filter((group) => group.items.length > 0),
  ];

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);

  // A session deleted elsewhere must not stay selected here.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(sessions.map((session) => session.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);


  function openMenu(event: React.MouseEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const wouldOverflow = rect.bottom + 172 > window.innerHeight;
    setMenu({
      id,
      top: wouldOverflow ? Math.max(8, rect.top - 168) : rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startRename(id: string) {
    const session = sessions.find((item) => item.id === id);
    setDraft(session?.title ?? '');
    setRenamingId(id);
  }

  function commitRename(id: string) {
    if (renamingId !== id) return;
    const value = draft.trim();
    if (value) onRename(id, value);
    setRenamingId(null);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="search">
          <SearchIcon size={15} />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索会话或内容"
            spellCheck={false}
          />
        </div>
        {visible.length > 0 && (
          <button
            type="button"
            className={`sidebar__select ${selecting ? 'is-active' : ''}`}
            title={selecting ? '退出多选' : '多选会话'}
            aria-pressed={selecting}
            onClick={() => {
              setMenu(null);
              setSelected(new Set());
              setSelecting((value) => !value);
            }}
          >
            {selecting ? '完成' : '多选'}
          </button>
        )}
        <button className="newchat" title="新建对话" onClick={onNew}>
          <PlusIcon size={17} />
        </button>
      </div>

      <div className="session-list">
        {grouped.map((group) => (
          <section key={group.label} className="session-group">
            <div className="session-group__label">{group.label}</div>
            {group.items.map((session) => (
              <div
                key={session.id}
                className={[
                  'session-item',
                  session.id === activeId ? 'is-active' : '',
                  selected.has(session.id) ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => (selecting ? toggleSelect(session.id) : onSelect(session.id))}
                role={selecting ? 'checkbox' : 'button'}
                aria-checked={selecting ? selected.has(session.id) : undefined}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (selecting) toggleSelect(session.id);
                    else onSelect(session.id);
                  }
                }}
              >
                <ActivityDot status={activity?.get(session.id) ?? null} />
                {renamingId === session.id ? (
                  <input
                    className="session-item__rename"
                    value={draft}
                    autoFocus
                    spellCheck={false}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setDraft(event.target.value)}
                    onFocus={(event) => event.target.select()}
                    onBlur={() => commitRename(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename(session.id);
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <span className="session-item__text">
                    <span className="session-item__title">{session.title}</span>
                    {snippets.has(session.id) && (
                      <span className="session-item__snippet">{snippets.get(session.id)}</span>
                    )}
                  </span>
                )}

                {selecting ? (
                  <span
                    className={`select-box ${selected.has(session.id) ? 'is-checked' : ''}`}
                    aria-hidden="true"
                  >
                    {selected.has(session.id) && <CheckIcon size={12} />}
                  </span>
                ) : (
                  <>
                    {session.pinned && (
                      <span className="session-item__pin" title="已置顶">
                        <PinIcon size={12} />
                      </span>
                    )}
                    <span className="session-item__time">{formatTime(session.updatedAt)}</span>
                    <button
                      className="session-item__more"
                      title="更多"
                      onClick={(event) => openMenu(event, session.id)}
                    >
                      <MoreIcon size={15} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        ))}

        {grouped.length === 0 && <div className="session-empty">没有匹配的会话</div>}
      </div>

      {selecting && (
        <div className="sidebar__selectbar">
          <label className="ws__selectall">
            <input
              type="checkbox"
              checked={
                visible.length > 0 && visible.every((session) => selected.has(session.id))
              }
              onChange={(event) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const session of visible) {
                    if (event.target.checked) next.add(session.id);
                    else next.delete(session.id);
                  }
                  return next;
                });
              }}
            />
            全选
          </label>
          <span className="ws__selectcount">已选 {selected.size} 项</span>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={selected.size === 0}
            onClick={() => setConfirming(true)}
          >
            删除
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="批量删除会话"
          message={`删除选中的 ${selected.size} 个会话？此操作不可撤销。`}
          confirmLabel={`删除 ${selected.size} 项`}
          danger
          onConfirm={() => {
            const ids = [...selected];
            setConfirming(false);
            setSelected(new Set());
            setSelecting(false);
            onDeleteMany(ids);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      <footer className="sidebar__foot">
        <span className="dot" />
        <span>当前激活 · {modelLabel || '未连接模型'}</span>
      </footer>

      {menu &&
        createPortal(
          <>
            <div className="menu-backdrop" onMouseDown={() => setMenu(null)} />
            <div className="session-menu" style={{ top: menu.top, right: menu.right }}>
              <button
                className="menu__item"
                onClick={() => {
                  const session = sessions.find((item) => item.id === menu.id);
                  onPin(menu.id, !session?.pinned);
                  setMenu(null);
                }}
              >
                <span className="menu__label">
                  {sessions.find((item) => item.id === menu.id)?.pinned ? '取消置顶' : '置顶会话'}
                </span>
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  startRename(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">重命名</span>
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  onExport(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">导出为 Markdown</span>
              </button>
              <button
                className="menu__item menu__item--danger"
                onClick={() => {
                  onDelete(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">删除会话</span>
              </button>
            </div>
          </>,
          document.body,
        )}
    </aside>
  );
}
