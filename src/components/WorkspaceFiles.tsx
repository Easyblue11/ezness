import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { highlightFile, languageDisplayName } from '../lib/highlight';
import type {
  WorkspaceEntryProperties,
  WorkspaceFileResult,
  WorkspaceTreeEntry,
} from '../types';
import { useI18n } from '../i18n';
import type { Translate } from './AskLevelSlider';
import { ConfirmDialog } from './ConfirmDialog';
import { ChevronDownIcon, CloseIcon, FolderIcon, PlusIcon, RefreshIcon } from './Icons';
import { MaterialFileIcon } from './MaterialFileIcon';

interface Props {
  workspace: {
    id: string;
    name: string;
    kind?: 'folder' | 'tool-editor' | 'agent-editor' | 'director' | 'remote';
    remote?: { host: string; port: number; username: string; root: string };
  } | null;
}

interface PreviewState {
  path: string;
  name: string;
  loading: boolean;
  result?: WorkspaceFileResult;
}

interface MenuState {
  x: number;
  y: number;
  entry: WorkspaceTreeEntry | null;
}

interface PromptState {
  mode: 'create' | 'rename';
  parent: string;
  entry?: WorkspaceTreeEntry;
  value: string;
}

interface PropertiesState {
  path: string;
  name: string;
  loading: boolean;
  result?: WorkspaceEntryProperties;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number | undefined, locale: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(locale, { hour12: false });
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index > 0 ? relativePath.slice(0, index) : '';
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function fileType(name: string, t: Translate): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return t('workspace.files.type.file');
  return t('workspace.files.type.ext', { ext: name.slice(dot + 1).toUpperCase() });
}

/**
 * VSCode-like folder tree for the selected workspace. Folders open on first
 * click and close on the second; every folder is read on demand. Files and
 * folders can be created, renamed, moved by dragging and deleted (to the
 * system recycle bin) from the context menu.
 *
 * A remote workspace keeps the same tree, but over SFTP: there is no OS
 * folder to reveal, nothing goes to a recycle bin, and no filesystem watcher
 * can follow the host, so the open folders are re-read on a slow timer.
 */
export function WorkspaceFiles({ workspace }: Props) {
  const { t, locale } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const workspaceId = workspace?.id ?? '';
  const isRemote = workspace?.kind === 'remote';
  const [entries, setEntries] = useState<Record<string, WorkspaceTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState<Record<string, boolean>>({});
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [openError, setOpenError] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptError, setPromptError] = useState('');
  const [properties, setProperties] = useState<PropertiesState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceTreeEntry | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const previewText =
    preview?.result?.ok && preview.result.kind === 'text' ? (preview.result.content ?? '') : '';
  const previewHighlight = useMemo(
    () => (previewText ? highlightFile(previewText, preview?.name ?? '') : null),
    [previewText, preview?.name],
  );

  /** Bumped whenever the whole tree is reset; stale responses are dropped. */
  const generation = useRef(0);
  /** Per-folder request counter: a slow older read must not overwrite a newer one. */
  const dirRequests = useRef(new Map<string, number>());

  // The watch subscription is installed once; these refs let it call the
  // current render's loader and see the current open folders/preview.
  const workspaceIdRef = useRef(workspaceId);
  const expandedRef = useRef(expanded);
  const previewRef = useRef(preview);
  const loadDirRef = useRef<(dir: string) => Promise<void>>(async () => undefined);
  const previewTimer = useRef(0);

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    expandedRef.current = expanded;
    previewRef.current = preview;
  }, [workspaceId, expanded, preview]);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!workspaceId) return;
      const api = window.ezness;
      if (!api?.workspaceTree) {
        setError(tRef.current('workspace.files.error.desktopTree'));
        return;
      }
      const gen = generation.current;
      const seq = (dirRequests.current.get(dir) ?? 0) + 1;
      dirRequests.current.set(dir, seq);
      setLoading((prev) => new Set(prev).add(dir));
      try {
        const result = await api.workspaceTree({ workspaceId, dir });
        if (gen !== generation.current || dirRequests.current.get(dir) !== seq) return;
        if (!result?.ok) {
          // A watched folder can vanish (renamed/deleted outside the app).
          // Collapse it instead of leaving a permanent error in the panel;
          // the parent's own watch event refreshes the list it lived in.
          if (dir && (result?.code === 'ENOENT' || result?.code === 'ENOTDIR')) {
            invalidate(dir);
            return;
          }
          setError(result?.error || tRef.current('workspace.files.error.readDir'));
          return;
        }
        setRoot(result.root ?? '');
        setError('');
        setEntries((prev) => ({ ...prev, [dir]: result.entries ?? [] }));
        setTruncated((prev) => ({ ...prev, [dir]: Boolean(result.truncated) }));
      } catch (err) {
        if (gen !== generation.current || dirRequests.current.get(dir) !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === generation.current && dirRequests.current.get(dir) === seq) {
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    loadDirRef.current = loadDir;
  }, [loadDir]);

  useEffect(() => {
    generation.current += 1;
    dirRequests.current.clear();
    setEntries({});
    setExpanded(new Set());
    setLoading(new Set());
    setTruncated({});
    setRoot('');
    setError('');
    setActionError('');
    setPreview(null);
    setOpenError('');
    setMenu(null);
    setPrompt(null);
    setPromptError('');
    setProperties(null);
    setDeleteTarget(null);
    setDraggingPath(null);
    setDropTarget(null);
    if (workspaceId) void loadDir('');
  }, [workspaceId, loadDir]);

  // Re-read the open preview shortly after its parent folder reports a write.
  // Writes often arrive in bursts (an agent streaming a file), so coalesce.
  function refreshPreview(path: string) {
    if (previewTimer.current) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = 0;
      const current = previewRef.current;
      if (!current || current.path !== path) return;
      void (async () => {
        try {
          const result = await window.ezness?.workspaceReadFile?.({
            workspaceId: workspaceIdRef.current,
            path,
          });
          if (!result) return;
          setPreview((prev) => (prev && prev.path === path ? { ...prev, result } : prev));
        } catch {
          /* keep the last good content */
        }
      })();
    }, 250);
  }

  // Keep the main process watching exactly the folders this tree has open:
  // the root plus every expanded folder.
  useEffect(() => {
    const api = window.ezness;
    if (!workspaceId || !api?.workspaceWatch) return;
    // No debounce: a folder expanded now should be watched before the next
    // write can land in it. The main process dedupes the watcher list.
    void api.workspaceWatch({ workspaceId, dirs: ['', ...expanded] });
  }, [workspaceId, expanded]);

  useEffect(() => {
    const api = window.ezness;
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current);
      void api?.workspaceUnwatch?.(workspaceId);
    };
  }, [workspaceId]);

  // Disk changes — the user editing in Explorer or the agent's tools writing —
  // arrive batched per folder and refresh just that folder.
  useEffect(() => {
    const unsubscribe = window.ezness?.onWorkspaceChanged?.((event) => {
      if (!event || event.workspaceId !== workspaceIdRef.current) return;
      const dirs = Array.isArray(event.dirs) ? event.dirs : [];
      for (const dir of dirs) {
        if (dir !== '' && !expandedRef.current.has(dir)) continue;
        void loadDirRef.current(dir);
      }
      const current = previewRef.current;
      if (current && dirs.includes(parentOf(current.path))) refreshPreview(current.path);
    });
    return () => unsubscribe?.();
  }, []);

  // A remote host has no watcher, so poll the folders that are open. This is
  // what keeps the tree (and an open preview) current when the agent writes
  // files on the other machine. Hidden windows skip the round trip.
  useEffect(() => {
    if (!workspaceId || !isRemote) return;
    let timer = 0;
    const tick = () => {
      if (!document.hidden) {
        for (const dir of ['', ...expandedRef.current]) void loadDirRef.current(dir);
        const current = previewRef.current;
        if (current) refreshPreview(current.path);
      }
      timer = window.setTimeout(tick, 7000);
    };
    timer = window.setTimeout(tick, 7000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, isRemote]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  function refresh() {
    if (!workspaceId) return;
    generation.current += 1;
    dirRequests.current.clear();
    setEntries({});
    setExpanded(new Set());
    setLoading(new Set());
    setTruncated({});
    setError('');
    setActionError('');
    void loadDir('');
  }

  function toggleDir(path: string) {
    if (expanded.has(path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((prev) => new Set(prev).add(path));
    if (!entries[path] && !loading.has(path)) void loadDir(path);
  }

  async function openFile(entry: WorkspaceTreeEntry) {
    const api = window.ezness;
    if (!api?.workspaceReadFile) {
      setError(t('workspace.files.error.desktopPreview'));
      return;
    }
    setOpenError('');
    setPreview({ path: entry.path, name: entry.name, loading: true });
    try {
      const result = await api.workspaceReadFile({ workspaceId, path: entry.path });
      setPreview({ path: entry.path, name: entry.name, loading: false, result });
    } catch (err) {
      setPreview({
        path: entry.path,
        name: entry.name,
        loading: false,
        result: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /** 右键菜单：不打开预览，直接用系统默认程序打开当前文件。 */
  async function openPathExternal(target: string) {
    setMenu(null);
    setActionError('');
    try {
      const result = await window.ezness?.workspaceOpenFile?.({ workspaceId, path: target });
      if (result && !result.ok) {
        setActionError(result.error || t('workspace.files.error.openExternal'));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openExternal() {
    if (!preview) return;
    setOpenError('');
    try {
      const result = await window.ezness?.workspaceOpenFile?.({
        workspaceId,
        path: preview.path,
      });
      if (result && !result.ok) {
        setOpenError(result.error || t('workspace.files.error.openExternal'));
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }

  function openMenu(event: ReactMouseEvent, entry: WorkspaceTreeEntry | null) {
    event.preventDefault();
    event.stopPropagation();
    const width = 200;
    const height = entry ? 300 : 130;
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      entry,
    });
  }

  async function reveal(path: string) {
    setMenu(null);
    setActionError('');
    try {
      const result = await window.ezness?.workspaceReveal?.({ workspaceId, path });
      if (result && !result.ok) {
        setActionError(result.error || t('workspace.files.error.reveal'));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  function startCreate(parent: string) {
    setMenu(null);
    setPromptError('');
    setPrompt({ mode: 'create', parent, value: '' });
  }

  function startRename(entry: WorkspaceTreeEntry) {
    setMenu(null);
    setPromptError('');
    setPrompt({ mode: 'rename', parent: parentOf(entry.path), entry, value: entry.name });
  }

  function invalidate(path: string) {
    setEntries((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (isSameOrInside(key, path)) delete next[key];
      }
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const key of prev) {
        if (isSameOrInside(key, path)) next.delete(key);
      }
      return next;
    });
    setTruncated((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (isSameOrInside(key, path)) delete next[key];
      }
      return next;
    });
  }

  async function submitPrompt() {
    if (!prompt || busy) return;
    const name = prompt.value.trim();
    if (!name) {
      setPromptError(t('workspace.files.error.emptyName'));
      return;
    }
    if (/[\\/]/.test(name)) {
      setPromptError(t('workspace.files.error.slash'));
      return;
    }

    const api = window.ezness;
    if (!api?.workspaceCreateFolder || !api.workspaceRename) {
      setPromptError(t('workspace.files.error.desktopOps'));
      return;
    }

    const entryPath = prompt.entry?.path;
    const parent = prompt.parent;
    setBusy(true);
    setPromptError('');
    try {
      const result =
        prompt.mode === 'create'
          ? await api.workspaceCreateFolder({ workspaceId, parent, name })
          : await api.workspaceRename({ workspaceId, path: entryPath ?? '', name });
      if (!result?.ok) {
        setPromptError(result?.error || t('workspace.files.error.failed'));
        return;
      }
      setPrompt(null);
      if (entryPath) {
        if (preview && isSameOrInside(preview.path, entryPath)) setPreview(null);
        invalidate(entryPath);
      }
      if (parent) setExpanded((prev) => new Set(prev).add(parent));
      await loadDir(parent);
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || busy) return;
    const api = window.ezness;
    if (!api?.workspaceDelete) {
      setActionError(t('workspace.files.error.desktopOps'));
      return;
    }
    setBusy(true);
    setActionError('');
    try {
      const result = await api.workspaceDelete({ workspaceId, path: target.path });
      setDeleteTarget(null);
      if (!result?.ok) {
        setActionError(result?.error || t('workspace.files.error.delete'));
        return;
      }
      if (preview && isSameOrInside(preview.path, target.path)) setPreview(null);
      invalidate(target.path);
      await loadDir(parentOf(target.path));
    } catch (err) {
      setDeleteTarget(null);
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openProperties(entry: WorkspaceTreeEntry | null) {
    setMenu(null);
    const path = entry?.path ?? '';
    const name = entry?.name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? workspace?.name ?? '';
    setProperties({ path, name, loading: true });
    try {
      const result = await window.ezness?.workspaceProperties?.({ workspaceId, path });
      setProperties({
        path,
        name,
        loading: false,
        result: result ?? { ok: false, error: t('workspace.files.error.desktopProps') },
      });
    } catch (err) {
      setProperties({
        path,
        name,
        loading: false,
        result: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  function canDrop(from: string, toDir: string): boolean {
    if (!from) return false;
    if (toDir === from) return false;
    if (toDir.startsWith(`${from}/`)) return false;
    return toDir !== parentOf(from);
  }

  async function moveInto(from: string, toDir: string) {
    if (!from || !canDrop(from, toDir)) return;
    const api = window.ezness;
    if (!api?.workspaceMove) {
      setActionError(t('workspace.files.error.desktopOps'));
      return;
    }
    setActionError('');
    const result = await api.workspaceMove({ workspaceId, from, toDir });
    if (!result?.ok) {
      setActionError(result?.error || t('workspace.files.error.move'));
      return;
    }
    if (preview && isSameOrInside(preview.path, from)) setPreview(null);
    invalidate(from);
    const sourceParent = parentOf(from);
    if (toDir) setExpanded((prev) => new Set(prev).add(toDir));
    await loadDir(sourceParent);
    if (toDir !== sourceParent) await loadDir(toDir);
  }

  function renderDir(dir: string, depth: number): ReactNode {
    const list = entries[dir];
    if (!list) {
      return loading.has(dir) ? (
        <div className="filetree__hint" style={{ paddingLeft: 12 + depth * 14 }}>
          {t('workspace.files.loading')}
        </div>
      ) : null;
    }
    if (list.length === 0 && depth > 0) {
      return (
        <div className="filetree__hint" style={{ paddingLeft: 12 + depth * 14 }}>
          {t('workspace.files.emptyFolder')}
        </div>
      );
    }
    return (
      <>
        {list.map((entry) => {
          const open = entry.isDir && expanded.has(entry.path);
          const childLoading = entry.isDir && loading.has(entry.path) && !entries[entry.path];
          return (
            <div key={entry.path} className="filetree__group">
              <button
                type="button"
                className={`filetree__row ${open ? 'is-open' : ''} ${
                  draggingPath === entry.path ? 'is-dragging' : ''
                } ${dropTarget === entry.path ? 'is-drop-target' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={entry.path}
                aria-expanded={entry.isDir ? open : undefined}
                draggable
                onDragStart={(event) => {
                  event.stopPropagation();
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', entry.path);
                  setDraggingPath(entry.path);
                  setMenu(null);
                }}
                onDragEnd={() => {
                  setDraggingPath(null);
                  setDropTarget(null);
                }}
                onDragOver={(event) => {
                  // Keep the container from treating an invalid row as a
                  // "drop on the root" target.
                  event.stopPropagation();
                  const dropDir = entry.isDir ? entry.path : parentOf(entry.path);
                  if (!draggingPath || !canDrop(draggingPath, dropDir)) {
                    event.dataTransfer.dropEffect = 'none';
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDropTarget(entry.path);
                }}
                onDragLeave={() => {
                  if (dropTarget === entry.path) setDropTarget(null);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const from = draggingPath || event.dataTransfer.getData('text/plain');
                  const dropDir = entry.isDir ? entry.path : parentOf(entry.path);
                  setDraggingPath(null);
                  setDropTarget(null);
                  void moveInto(from, dropDir);
                }}
                onContextMenu={(event) => openMenu(event, entry)}
                onClick={() => {
                  if (entry.isDir) toggleDir(entry.path);
                  else void openFile(entry);
                }}
              >
                {entry.isDir ? (
                  <ChevronDownIcon size={12} className="filetree__chevron" />
                ) : (
                  <span className="filetree__chevron filetree__chevron--blank" />
                )}
                <MaterialFileIcon
                  name={entry.name}
                  isDir={entry.isDir}
                  open={open}
                  size={16}
                />
                <span className="filetree__name">{entry.name}</span>
                {childLoading && <span className="filetree__spin">…</span>}
              </button>
              {open && renderDir(entry.path, depth + 1)}
            </div>
          );
        })}
        {truncated[dir] && (
          <div className="filetree__hint" style={{ paddingLeft: 12 + depth * 14 }}>
            {t('workspace.files.truncated')}
          </div>
        )}
      </>
    );
  }

  const workspaceLabel = workspace
    ? workspace.kind === 'tool-editor'
      ? t('workspace.files.label.toolEditor')
      : workspace.kind === 'agent-editor'
        ? t('workspace.files.label.agentEditor')
        : isRemote
          ? root || workspace.remote?.root || workspace.name
          : root || workspace.name
    : t('workspace.files.label.none');
  const rootTitle =
    isRemote && workspace?.remote
      ? `${workspace.remote.username}@${workspace.remote.host}:${root || workspace.remote.root}`
      : root || workspace?.name || '';
  const menuEntry = menu?.entry ?? null;
  const propertyResult = properties?.result;

  return (
    <>
      <div className="ws__head">
        <span className="ws__heading">{t('workspace.files.heading')}</span>
        <div className="ws__head-actions">
          <button
            className="ws__icon-btn"
            title={t('workspace.files.newFolder')}
            aria-label={t('workspace.files.newFolder')}
            disabled={!workspaceId}
            onClick={() => startCreate('')}
          >
            <PlusIcon size={14} />
          </button>
          <button
            className="ws__icon-btn"
            title={t('workspace.files.refresh')}
            aria-label={t('workspace.files.refreshTree')}
            disabled={!workspaceId}
            onClick={refresh}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>
      <div className="ws__tools ws__tools--root">
        <div
          className="filetree__root"
          title={rootTitle}
          onContextMenu={(event) => openMenu(event, null)}
        >
          <FolderIcon size={13} />
          <span>{workspaceLabel}</span>
          {isRemote && <span className="filetree__badge">SSH</span>}
        </div>
      </div>

      <div
        className={`filetree ${dropTarget === '' ? 'is-drop-target' : ''}`}
        role="tree"
        aria-label={t('workspace.files.treeAria')}
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return;
          openMenu(event, null);
        }}
        onDragOver={(event) => {
          if (!draggingPath) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget('');
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget && dropTarget === '') setDropTarget(null);
        }}
        onDrop={(event) => {
          if (!draggingPath) return;
          event.preventDefault();
          const from = draggingPath;
          setDraggingPath(null);
          setDropTarget(null);
          void moveInto(from, '');
        }}
      >
        {!workspace && (
          <div className="ws-hint">{t('workspace.files.emptyHint')}</div>
        )}
        {workspace && error && <div className="filetree__error">{error}</div>}
        {workspace && actionError && <div className="filetree__error">{actionError}</div>}
        {workspace && loading.has('') && !entries[''] && (
          <div className="ws-hint">{t('workspace.files.loading')}</div>
        )}
        {workspace && entries[''] && entries[''].length === 0 && (
          <div className="ws-hint">{t('workspace.files.rootEmpty')}</div>
        )}
        {workspace && entries[''] && entries[''].length > 0 && renderDir('', 0)}
      </div>

      {menu &&
        createPortal(
          <>
            <div
              className="menu-backdrop"
              onMouseDown={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="session-menu file-menu"
              style={{ top: menu.y, left: menu.x }}
              role="menu"
            >
              {menuEntry ? (
                <>
                  <button
                    className="menu__item"
                    onClick={() => {
                      setMenu(null);
                      if (menuEntry.isDir) toggleDir(menuEntry.path);
                      else void openFile(menuEntry);
                    }}
                  >
                    {menuEntry.isDir
                      ? t('workspace.files.menu.open')
                      : t('workspace.files.menu.preview')}
                  </button>
                  {!menuEntry.isDir && !isRemote && (
                    <button
                      className="menu__item"
                      onClick={() => void openPathExternal(menuEntry.path)}
                    >
                      {t('workspace.files.menu.openExternal')}
                    </button>
                  )}
                  {!isRemote && (
                    <button
                      className="menu__item"
                      onClick={() => void reveal(menuEntry.path)}
                    >
                      {menuEntry.isDir
                        ? t('workspace.files.menu.openFolderHere')
                        : t('workspace.files.menu.openContaining')}
                    </button>
                  )}
                  {menuEntry.isDir && (
                    <button
                      className="menu__item"
                      onClick={() => startCreate(menuEntry.path)}
                    >
                      {t('workspace.files.newFolder')}
                    </button>
                  )}
                  <button className="menu__item" onClick={() => startRename(menuEntry)}>
                    {t('workspace.files.menu.rename')}
                  </button>
                  <div className="file-menu__sep" />
                  <button
                    className="menu__item menu__item--danger"
                    onClick={() => {
                      setMenu(null);
                      setDeleteTarget(menuEntry);
                    }}
                  >
                    {t('workspace.files.menu.delete')}
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => void openProperties(menuEntry)}
                  >
                    {t('workspace.files.menu.properties')}
                  </button>
                </>
              ) : (
                <>
                  <button className="menu__item" onClick={() => startCreate('')}>
                    {t('workspace.files.newFolder')}
                  </button>
                  {!isRemote && (
                    <button className="menu__item" onClick={() => void reveal('')}>
                      {t('workspace.files.menu.openFolderHere')}
                    </button>
                  )}
                  <button
                    className="menu__item"
                    onClick={() => {
                      setMenu(null);
                      refresh();
                    }}
                  >
                    {t('workspace.files.menu.refresh')}
                  </button>
                  <button className="menu__item" onClick={() => void openProperties(null)}>
                    {t('workspace.files.menu.properties')}
                  </button>
                </>
              )}
            </div>
          </>,
          document.body,
        )}

      {prompt &&
        createPortal(
          <div
            className="modal"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setPrompt(null);
                setPromptError('');
              }
            }}
          >
            <div className="modal__panel file-dialog" role="dialog" aria-modal="true">
              <h2 className="modal__title">
                {prompt.mode === 'create'
                  ? t('workspace.files.dialog.createTitle')
                  : t('workspace.files.dialog.renameTitle')}
              </h2>
              <p className="modal__message">
                {prompt.mode === 'create'
                  ? prompt.parent
                    ? t('workspace.files.dialog.createParent', { parent: prompt.parent })
                    : t('workspace.files.dialog.createRoot', {
                        root: t('workspace.files.dialog.rootName'),
                      })
                  : t('workspace.files.dialog.renameMessage', {
                      name: prompt.entry?.name ?? '',
                    })}
              </p>
              <input
                className="input file-dialog__input"
                autoFocus
                value={prompt.value}
                placeholder={t('workspace.files.dialog.placeholder')}
                spellCheck={false}
                onChange={(event) => {
                  setPrompt({ ...prompt, value: event.target.value });
                  setPromptError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitPrompt();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setPrompt(null);
                    setPromptError('');
                  }
                }}
              />
              {promptError && (
                <div className="notice notice--warn file-dialog__error">{promptError}</div>
              )}
              <div className="modal__actions">
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setPrompt(null);
                    setPromptError('');
                  }}
                >
                  {t('workspace.files.dialog.cancel')}
                </button>
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void submitPrompt()}
                >
                  {busy
                    ? t('workspace.files.dialog.processing')
                    : prompt.mode === 'create'
                      ? t('workspace.files.dialog.create')
                      : t('workspace.files.dialog.save')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {properties &&
        createPortal(
          <div
            className="modal"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setProperties(null);
            }}
          >
            <div className="modal__panel file-props" role="dialog" aria-modal="true">
              <h2 className="modal__title">{t('workspace.files.props.title')}</h2>
              {properties.loading && (
                <p className="modal__message">{t('workspace.files.props.loading')}</p>
              )}
              {!properties.loading && propertyResult && !propertyResult.ok && (
                <div className="notice notice--warn file-dialog__error">
                  {propertyResult.error || t('workspace.files.props.failed')}
                </div>
              )}
              {!properties.loading && propertyResult?.ok && (
                <dl className="file-props__list">
                  <div>
                    <dt>{t('workspace.files.props.name')}</dt>
                    <dd>{propertyResult.name}</dd>
                  </div>
                  <div>
                    <dt>{t('workspace.files.props.type')}</dt>
                    <dd>
                      {propertyResult.kind === 'folder'
                        ? t('workspace.files.props.folder')
                        : fileType(propertyResult.name ?? '', t)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('workspace.files.props.location')}</dt>
                    <dd className="file-props__path" title={propertyResult.absolutePath}>
                      {propertyResult.absolutePath}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('workspace.files.props.relative')}</dt>
                    <dd>{propertyResult.path || t('workspace.files.props.rootDir')}</dd>
                  </div>
                  {propertyResult.kind === 'file' && (
                    <div>
                      <dt>{t('workspace.files.props.size')}</dt>
                      <dd>{formatBytes(propertyResult.size ?? 0)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('workspace.files.props.modified')}</dt>
                    <dd>{formatTime(propertyResult.mtime, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('workspace.files.props.created')}</dt>
                    <dd>
                      {formatTime(propertyResult.birthtime ?? propertyResult.ctime, locale)}
                    </dd>
                  </div>
                </dl>
              )}
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={() => setProperties(null)}>
                  {t('workspace.files.props.close')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {deleteTarget && (
        <ConfirmDialog
          title={t('workspace.files.delete.title')}
          message={
            isRemote
              ? t('workspace.files.delete.remote', { name: deleteTarget.name })
              : t('workspace.files.delete.local', { name: deleteTarget.name })
          }
          confirmLabel={t('workspace.files.delete.confirm')}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {preview &&
        createPortal(
          <div
            className="modal"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPreview(null);
            }}
          >
            <div
              className="modal__panel file-preview"
              role="dialog"
              aria-modal="true"
              aria-label={t('workspace.files.preview.aria')}
            >
              <div className="file-preview__head">
                <div className="file-preview__title">
                  <span className="file-preview__name" title={preview.path}>
                    {preview.name}
                  </span>
                  <span className="file-preview__meta">
                    {preview.result?.size !== undefined
                      ? formatBytes(preview.result.size)
                      : ''}
                    {preview.result?.truncated
                      ? ` · ${t('workspace.files.preview.truncated')}`
                      : ''}
                    {previewHighlight
                      ? ` · ${languageDisplayName(previewHighlight.language)}`
                      : ''}
                  </span>
                </div>
                <button
                  className="file-preview__close"
                  title={t('workspace.files.preview.closeTitle')}
                  aria-label={t('workspace.files.preview.closeAria')}
                  onClick={() => setPreview(null)}
                >
                  <CloseIcon size={15} />
                </button>
              </div>

              <div className="file-preview__body">
                {preview.loading && (
                  <div className="file-preview__empty">{t('workspace.files.preview.loading')}</div>
                )}
                {!preview.loading && preview.result && !preview.result.ok && (
                  <div className="file-preview__error">{preview.result.error}</div>
                )}
                {!preview.loading &&
                  preview.result?.ok &&
                  preview.result.kind === 'image' && (
                    <img
                      className="file-preview__image"
                      src={preview.result.dataUrl}
                      alt={preview.name}
                    />
                  )}
                {!preview.loading &&
                  preview.result?.ok &&
                  preview.result.kind === 'text' &&
                  (previewHighlight ? (
                    <pre className="file-preview__text hljs">
                      <code dangerouslySetInnerHTML={{ __html: previewHighlight.html }} />
                    </pre>
                  ) : (
                    <pre className="file-preview__text">{preview.result.content}</pre>
                  ))}
                {!preview.loading &&
                  preview.result?.ok &&
                  preview.result.kind === 'binary' && (
                    <div className="file-preview__empty">
                      {isRemote
                        ? t('workspace.files.preview.binaryRemote')
                        : t('workspace.files.preview.binaryLocal')}
                    </div>
                  )}
              </div>

              <div className="file-preview__foot">
                <span className="file-preview__path" title={preview.path}>
                  {preview.path}
                </span>
                <div className="file-preview__actions">
                  {openError && <span className="file-preview__error-text">{openError}</span>}
                  <button className="btn btn--ghost" onClick={() => setPreview(null)}>
                    {t('workspace.files.preview.close')}
                  </button>
                  {!isRemote && (
                    <button className="btn btn--primary" onClick={() => void openExternal()}>
                      {t('workspace.files.preview.openExternal')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
