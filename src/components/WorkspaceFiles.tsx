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

function formatTime(value?: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index > 0 ? relativePath.slice(0, index) : '';
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function fileType(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '文件';
  return `${name.slice(dot + 1).toUpperCase()} 文件`;
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
        setError('文件树只在桌面端可用。');
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
          setError(result?.error || '读取目录失败。');
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
      setError('文件预览只在桌面端可用。');
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
      if (result && !result.ok) setActionError(result.error || '系统程序没能打开这个文件。');
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
      if (result && !result.ok) setOpenError(result.error || '系统程序没能打开这个文件。');
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
      if (result && !result.ok) setActionError(result.error || '打不开这个位置。');
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
      setPromptError('名称不能为空。');
      return;
    }
    if (/[\\/]/.test(name)) {
      setPromptError('名称里不能包含斜杠。');
      return;
    }

    const api = window.ezness;
    if (!api?.workspaceCreateFolder || !api.workspaceRename) {
      setPromptError('文件操作只在桌面端可用。');
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
        setPromptError(result?.error || '操作失败。');
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
      setActionError('文件操作只在桌面端可用。');
      return;
    }
    setBusy(true);
    setActionError('');
    try {
      const result = await api.workspaceDelete({ workspaceId, path: target.path });
      setDeleteTarget(null);
      if (!result?.ok) {
        setActionError(result?.error || '删除失败。');
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
        result: result ?? { ok: false, error: '文件属性只在桌面端可用。' },
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
      setActionError('文件操作只在桌面端可用。');
      return;
    }
    setActionError('');
    const result = await api.workspaceMove({ workspaceId, from, toDir });
    if (!result?.ok) {
      setActionError(result?.error || '移动失败。');
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
          读取中…
        </div>
      ) : null;
    }
    if (list.length === 0 && depth > 0) {
      return (
        <div className="filetree__hint" style={{ paddingLeft: 12 + depth * 14 }}>
          空文件夹
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
            条目太多，只显示前 500 项。
          </div>
        )}
      </>
    );
  }

  const workspaceLabel = workspace
    ? workspace.kind === 'tool-editor'
      ? '功能编辑临时目录'
      : workspace.kind === 'agent-editor'
        ? 'Agent 编辑临时目录'
        : isRemote
          ? root || workspace.remote?.root || workspace.name
          : root || workspace.name
    : '未选择工作空间';
  const rootTitle =
    isRemote && workspace?.remote
      ? `${workspace.remote.username}@${workspace.remote.host}:${root || workspace.remote.root}`
      : root || workspace?.name || '';
  const menuEntry = menu?.entry ?? null;
  const propertyResult = properties?.result;

  return (
    <>
      <div className="ws__head">
        <span className="ws__heading">文件</span>
        <div className="ws__head-actions">
          <button
            className="ws__icon-btn"
            title="新建文件夹"
            aria-label="新建文件夹"
            disabled={!workspaceId}
            onClick={() => startCreate('')}
          >
            <PlusIcon size={14} />
          </button>
          <button
            className="ws__icon-btn"
            title="刷新"
            aria-label="刷新文件树"
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
        aria-label="工作空间文件"
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
        {!workspace && <div className="ws-hint">先在「工作空间」里选择一个工作空间。</div>}
        {workspace && error && <div className="filetree__error">{error}</div>}
        {workspace && actionError && <div className="filetree__error">{actionError}</div>}
        {workspace && loading.has('') && !entries[''] && (
          <div className="ws-hint">读取中…</div>
        )}
        {workspace && entries[''] && entries[''].length === 0 && (
          <div className="ws-hint">这个文件夹是空的。右键可以新建文件夹。</div>
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
                    {menuEntry.isDir ? '打开' : '在应用里预览'}
                  </button>
                  {!menuEntry.isDir && !isRemote && (
                    <button
                      className="menu__item"
                      onClick={() => void openPathExternal(menuEntry.path)}
                    >
                      用系统程序打开当前文件
                    </button>
                  )}
                  {!isRemote && (
                    <button
                      className="menu__item"
                      onClick={() => void reveal(menuEntry.path)}
                    >
                      {menuEntry.isDir ? '打开当前文件夹' : '打开所在文件夹'}
                    </button>
                  )}
                  {menuEntry.isDir && (
                    <button
                      className="menu__item"
                      onClick={() => startCreate(menuEntry.path)}
                    >
                      新建文件夹
                    </button>
                  )}
                  <button className="menu__item" onClick={() => startRename(menuEntry)}>
                    重命名
                  </button>
                  <div className="file-menu__sep" />
                  <button
                    className="menu__item menu__item--danger"
                    onClick={() => {
                      setMenu(null);
                      setDeleteTarget(menuEntry);
                    }}
                  >
                    删除
                  </button>
                  <button
                    className="menu__item"
                    onClick={() => void openProperties(menuEntry)}
                  >
                    查看属性
                  </button>
                </>
              ) : (
                <>
                  <button className="menu__item" onClick={() => startCreate('')}>
                    新建文件夹
                  </button>
                  {!isRemote && (
                    <button className="menu__item" onClick={() => void reveal('')}>
                      打开当前文件夹
                    </button>
                  )}
                  <button
                    className="menu__item"
                    onClick={() => {
                      setMenu(null);
                      refresh();
                    }}
                  >
                    刷新
                  </button>
                  <button className="menu__item" onClick={() => void openProperties(null)}>
                    查看属性
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
                {prompt.mode === 'create' ? '新建文件夹' : '重命名'}
              </h2>
              <p className="modal__message">
                {prompt.mode === 'create'
                  ? `在${prompt.parent ? `“${prompt.parent}”` : '工作空间根目录'}里新建文件夹。`
                  : `修改“${prompt.entry?.name ?? ''}”的名称。`}
              </p>
              <input
                className="input file-dialog__input"
                autoFocus
                value={prompt.value}
                placeholder="输入名称"
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
                  取消
                </button>
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void submitPrompt()}
                >
                  {busy ? '处理中…' : prompt.mode === 'create' ? '创建' : '保存'}
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
              <h2 className="modal__title">属性</h2>
              {properties.loading && <p className="modal__message">读取中…</p>}
              {!properties.loading && propertyResult && !propertyResult.ok && (
                <div className="notice notice--warn file-dialog__error">
                  {propertyResult.error || '读取属性失败。'}
                </div>
              )}
              {!properties.loading && propertyResult?.ok && (
                <dl className="file-props__list">
                  <div>
                    <dt>名称</dt>
                    <dd>{propertyResult.name}</dd>
                  </div>
                  <div>
                    <dt>类型</dt>
                    <dd>
                      {propertyResult.kind === 'folder'
                        ? '文件夹'
                        : fileType(propertyResult.name ?? '')}
                    </dd>
                  </div>
                  <div>
                    <dt>位置</dt>
                    <dd className="file-props__path" title={propertyResult.absolutePath}>
                      {propertyResult.absolutePath}
                    </dd>
                  </div>
                  <div>
                    <dt>相对路径</dt>
                    <dd>{propertyResult.path || '（根目录）'}</dd>
                  </div>
                  {propertyResult.kind === 'file' && (
                    <div>
                      <dt>大小</dt>
                      <dd>{formatBytes(propertyResult.size ?? 0)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>修改时间</dt>
                    <dd>{formatTime(propertyResult.mtime)}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatTime(propertyResult.birthtime ?? propertyResult.ctime)}</dd>
                  </div>
                </dl>
              )}
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={() => setProperties(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除这个项目？"
          message={
            isRemote
              ? `“${deleteTarget.name}”会从远程主机上直接删除，不经过回收站，也无法从这个应用里恢复。`
              : `“${deleteTarget.name}”会被移到系统回收站，之后仍可以从回收站恢复。`
          }
          confirmLabel="删除"
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
              aria-label="文件预览"
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
                    {preview.result?.truncated ? ' · 已截断' : ''}
                    {previewHighlight
                      ? ` · ${languageDisplayName(previewHighlight.language)}`
                      : ''}
                  </span>
                </div>
                <button
                  className="file-preview__close"
                  title="关闭"
                  aria-label="关闭预览"
                  onClick={() => setPreview(null)}
                >
                  <CloseIcon size={15} />
                </button>
              </div>

              <div className="file-preview__body">
                {preview.loading && <div className="file-preview__empty">读取中…</div>}
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
                        ? '这是一个二进制文件，无法在应用内预览。'
                        : '这是一个二进制文件，无法在应用内预览。可以用系统程序打开。'}
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
                    关闭
                  </button>
                  {!isRemote && (
                    <button className="btn btn--primary" onClick={() => void openExternal()}>
                      用系统程序打开
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
