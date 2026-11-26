import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { sessionTitle } from '../lib/sessionTitle';
import type { Message, Session } from '../types';
import { findSnippet, textByConversation } from '../lib/search';
import { ActivityDot, type ActivityStatus } from './ActivityDot';
import { ConfirmDialog } from './ConfirmDialog';
import { CheckIcon, MoreIcon, PinIcon, PlusIcon, SearchIcon } from './Icons';

const DAY = 86_400_000;
const GROUP_KEYS = [
  'sidebar.group.today',
  'sidebar.group.yesterday',
  'sidebar.group.thisWeek',
  'sidebar.group.earlier',
] as const;

/** Stable empty index for the no-search case. */
const NO_TEXTS: Map<string, string[]> = new Map();

function groupOf(timestamp: number): (typeof GROUP_KEYS)[number] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= startOfToday) return 'sidebar.group.today';
  if (timestamp >= startOfToday - DAY) return 'sidebar.group.yesterday';
  if (timestamp >= startOfToday - 7 * DAY) return 'sidebar.group.thisWeek';
  return 'sidebar.group.earlier';
}

function formatTime(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
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
  const { t, locale } = useI18n();
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
      if (sessionTitle(session.title, t).toLowerCase().includes(keyword)) continue;
      const snippet = findSnippet(messageTexts.get(session.id), keyword);
      if (snippet) map.set(session.id, snippet);
    }
    return map;
  }, [sessions, keyword, messageTexts, t]);
  const visible = keyword
    ? sessions.filter(
        (s) => sessionTitle(s.title, t).toLowerCase().includes(keyword) || snippets.has(s.id),
      )
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
    ...(pinned.length > 0 ? [{ label: t('sidebar.group.pinned'), items: pinned }] : []),
    ...GROUP_KEYS.map((key) => ({
      label: t(key),
      items: ordered.filter((s) => !s.pinned && groupOf(s.updatedAt) === key),
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
            placeholder={t('sidebar.searchPlaceholder')}
            spellCheck={false}
          />
        </div>
        {visible.length > 0 && (
          <button
            type="button"
            className={`sidebar__select ${selecting ? 'is-active' : ''}`}
            title={selecting ? t('sidebar.selectExit') : t('sidebar.selectEnter')}
            aria-pressed={selecting}
            onClick={() => {
              setMenu(null);
              setSelected(new Set());
              setSelecting((value) => !value);
            }}
          >
            {selecting ? t('sidebar.selectDone') : t('sidebar.select')}
          </button>
        )}
        <button className="newchat" title={t('sidebar.newChat')} onClick={onNew}>
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
                    <span className="session-item__title">{sessionTitle(session.title, t)}</span>
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
                      <span className="session-item__pin" title={t('sidebar.pinnedBadge')}>
                        <PinIcon size={12} />
                      </span>
                    )}
                    <span className="session-item__time">{formatTime(session.updatedAt, locale)}</span>
                    <button
                      className="session-item__more"
                      title={t('sidebar.more')}
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

        {grouped.length === 0 && (
          <div className="session-empty">{t('sidebar.noMatch')}</div>
        )}
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
            {t('sidebar.selectAll')}
          </label>
          <span className="ws__selectcount">{t('sidebar.selectedCount', { count: selected.size })}</span>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            disabled={selected.size === 0}
            onClick={() => setConfirming(true)}
          >
            {t('sidebar.delete')}
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={t('sidebar.batchDeleteTitle')}
          message={t('sidebar.batchDeleteMessage', { count: selected.size })}
          confirmLabel={t('sidebar.batchDeleteConfirm', { count: selected.size })}
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
        <span>{t('sidebar.active', { model: modelLabel || t('sidebar.noModel') })}</span>
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
                  {sessions.find((item) => item.id === menu.id)?.pinned
                    ? t('sidebar.unpin')
                    : t('sidebar.pin')}
                </span>
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  startRename(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">{t('sidebar.rename')}</span>
              </button>
              <button
                className="menu__item"
                onClick={() => {
                  onExport(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">{t('sidebar.export')}</span>
              </button>
              <button
                className="menu__item menu__item--danger"
                onClick={() => {
                  onDelete(menu.id);
                  setMenu(null);
                }}
              >
                <span className="menu__label">{t('sidebar.deleteSession')}</span>
              </button>
            </div>
          </>,
          document.body,
        )}
    </aside>
  );
}
