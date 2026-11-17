import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '../lib/time';
import { warehouseRefToken } from '../lib/warehouseRef';
import type { WarehouseItem, WarehouseSnapshot, WarehouseUsage } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import {
  CloseIcon,
  EyeIcon,
  FolderIcon,
  JumpIcon,
  QuoteIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
  WarehouseIcon,
} from './Icons';
import { MaterialFileIcon } from './MaterialFileIcon';

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

interface RowProps {
  item: WarehouseItem;
  thumbnail?: string | null;
  usages: WarehouseUsage[];
  selected: boolean;
  onToggle: (id: string) => void;
  onJump: (item: WarehouseItem, button: HTMLButtonElement) => void;
  onReference: (item: WarehouseItem) => void;
  onOpen: (item: WarehouseItem) => void;
  onReveal: (item: WarehouseItem) => void;
  onDelete: (item: WarehouseItem) => void;
}

function usagePlace(entry: WarehouseUsage): string {
  return entry.kind === 'workspace'
    ? `工作空间「${entry.workspaceName ?? '工作空间'}」`
    : '对话';
}

function sourceLabel(item: WarehouseItem, usages: WarehouseUsage[]): string {
  if (usages.length === 1) {
    const only = usages[0];
    return only.kind === 'workspace'
      ? `来自${usagePlace(only)}`
      : `来自对话「${only.sessionTitle}」`;
  }
  if (usages.length > 1) {
    const count = usages.reduce((sum, entry) => sum + entry.count, 0);
    return `被引用 ${count} 次`;
  }
  return item.origin === 'chat' ? '来自对话' : '手动导入';
}

function WarehouseRow({
  item,
  thumbnail,
  usages,
  selected,
  onToggle,
  onJump,
  onReference,
  onOpen,
  onReveal,
  onDelete,
}: RowProps) {
  const only = usages.length === 1 ? usages[0] : null;
  const jumpTitle =
    usages.length === 0
      ? '这个文件还没有出现在任何对话中'
      : only
        ? only.kind === 'workspace'
          ? `跳转到工作空间「${only.workspaceName ?? '工作空间'}」的任务「${only.sessionTitle}」`
          : `跳转到对话「${only.sessionTitle}」`
        : `在 ${usages.length} 个对话中引用，点击选择`;

  return (
    <div
      className={`wh-row ${selected ? 'is-selected' : ''}`}
      data-warehouse-id={item.id}
    >
      <input
        type="checkbox"
        className="wh-row__check"
        checked={selected}
        aria-label={`选择 ${item.name}`}
        onChange={() => onToggle(item.id)}
      />
      <span
        className={`wh-row__thumb ${thumbnail ? 'has-image' : ''}`}
        title={(item.ext || 'FILE').toUpperCase()}
      >
        {thumbnail ? (
          <img src={thumbnail} alt="" />
        ) : (
          <MaterialFileIcon name={item.name} size={26} />
        )}
      </span>

      <div className="wh-row__main">
        <div className="wh-row__name" title={item.name}>
          {item.name}
        </div>
        <div className="wh-row__meta">
          {formatSize(item.size)} · {formatDateTime(item.addedAt)} · {sourceLabel(item, usages)}
        </div>
      </div>

      <button
        className="iconbtn"
        title="复制引用，到对话框粘贴即可使用"
        onClick={() => onReference(item)}
      >
        <QuoteIcon size={15} />
      </button>
      <button
        className="iconbtn"
        title={jumpTitle}
        disabled={usages.length === 0}
        onClick={(event) => onJump(item, event.currentTarget)}
      >
        <JumpIcon size={15} />
      </button>
      <button className="iconbtn" title="用默认程序打开" onClick={() => onOpen(item)}>
        <EyeIcon size={15} />
      </button>
      <button className="iconbtn" title="在文件夹中显示" onClick={() => onReveal(item)}>
        <FolderIcon size={15} />
      </button>
      <button className="iconbtn" title="从仓库删除" onClick={() => onDelete(item)}>
        <TrashIcon size={15} />
      </button>
    </div>
  );
}

interface Props {
  /** Per-file conversations, derived from the in-memory message list. */
  usage: Record<string, WarehouseUsage[]>;
  onJump: (usage: WarehouseUsage) => void;
  /** File to scroll to and flash after a chat attachment asked for it. */
  focus?: { id: string; nonce: number } | null;
}

export function WarehousePage({ usage, onJump, focus }: Props) {
  const api = window.ezness;
  const bodyRef = useRef<HTMLElement>(null);
  const focusDone = useRef(0);

  const [snapshot, setSnapshot] = useState<WarehouseSnapshot | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  // Selection lives apart from the filter, so searching for another file keeps
  // everything ticked so far.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<WarehouseItem[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [jumpMenu, setJumpMenu] = useState<{
    itemId: string;
    top: number;
    right: number;
  } | null>(null);
  const [jumpQuery, setJumpQuery] = useState('');
  const toastTimer = useRef<number | null>(null);

  // A fixed menu would drift away from its row when the list scrolls.
  useEffect(() => {
    if (!jumpMenu) return;
    const close = () => setJumpMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [jumpMenu]);

  async function referenceItem(item: WarehouseItem) {
    const ok = await api?.copyText(warehouseRefToken(item.id));
    flash(
      ok === false
        ? '复制失败，请检查剪贴板权限'
        : `已复制「${item.name}」的引用，到对话框里粘贴即可使用`,
    );
  }

  function handleJump(item: WarehouseItem, button: HTMLButtonElement) {
    const usages = usage[item.id] ?? [];
    if (usages.length === 0) return;
    if (usages.length === 1) {
      setJumpMenu(null);
      setJumpQuery('');
      onJump(usages[0]);
      return;
    }
    const rect = button.getBoundingClientRect();
    setJumpQuery('');
    setJumpMenu({
      itemId: item.id,
      top: rect.bottom + 6,
      right: Math.max(12, window.innerWidth - rect.right),
    });
  }

  function flash(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const next = await api?.warehouseSnapshot();
    if (next) setSnapshot(next);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Imports from chat, deletes and storage migrations all land here, even when
  // the page is hidden behind another view.
  useEffect(() => {
    const unsubscribe = api?.onWarehouseEvent((next) => setSnapshot(next));
    return () => unsubscribe?.();
  }, [api]);

  // Image previews are generated in the main process and cached there too;
  // the renderer keeps them for the lifetime of this view.
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) => item.name.toLowerCase().includes(query) || item.ext.toLowerCase().includes(query),
    );
  }, [items, filter]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );

  const jumpEntries = useMemo(
    () => (jumpMenu ? usage[jumpMenu.itemId] ?? [] : []),
    [jumpMenu, usage],
  );
  const jumpMatches = useMemo(() => {
    const query = jumpQuery.trim().toLowerCase();
    if (!query) return jumpEntries;
    return jumpEntries.filter((entry) =>
      `${entry.sessionTitle} ${entry.workspaceName ?? ''} ${usagePlace(entry)}`
        .toLowerCase()
        .includes(query),
    );
  }, [jumpEntries, jumpQuery]);

  // Files can disappear through a single delete or another window; drop their
  // ticks so the batch count never counts ghosts.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(items.map((item) => item.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // A chat attachment asked for this file: clear the search so the row cannot
  // be filtered out, then center and flash it once the list has painted.
  useEffect(() => {
    if (!focus || focusDone.current === focus.nonce) return;
    if (filter !== '') {
      setFilter('');
      return;
    }
    if (!snapshot) return;
    if (!items.some((item) => item.id === focus.id)) {
      focusDone.current = focus.nonce;
      flash('引文文件不存在，可能已从仓库删除');
      return;
    }
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-warehouse-id="${focus.id}"]`,
    );
    if (!row) return;
    focusDone.current = focus.nonce;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('wh-row--target');
    window.setTimeout(() => row.classList.remove('wh-row--target'), 2200);
  }, [focus, filter, snapshot, items]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    for (const item of items) {
      if (item.kind !== 'image' || item.id in thumbnails) continue;
      void api.warehouseThumbnail(item.id).then((url) => {
        if (!cancelled) setThumbnails((prev) => ({ ...prev, [item.id]: url }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [api, items, thumbnails]);

  async function addFiles(paths: string[], origin: 'import' | 'chat') {
    if (paths.length === 0 || !api) return;
    setImporting(true);
    const result = await api.warehouseAddFiles(paths, origin);
    setImporting(false);
    if (result?.snapshot) setSnapshot(result.snapshot);
    if (result?.errors && result.errors.length > 0) {
      flash(`导入失败：${result.errors[0]}`);
      return;
    }

    const added = result?.added.length ?? 0;
    const duplicates = result?.duplicates?.length ?? 0;
    if (added > 0 && duplicates > 0) {
      flash(`已导入 ${added} 个文件，${duplicates} 个内容相同已跳过`);
    } else if (added > 0) {
      flash(`已导入 ${added} 个文件`);
    } else if (duplicates > 0) {
      flash('文件已在仓库里，没有重复保存');
    }
  }

  async function importFiles() {
    const paths = await api?.warehousePickFiles();
    await addFiles(paths ?? [], 'import');
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (!event.dataTransfer.types.includes('Files')) return;
    const paths = [...event.dataTransfer.files]
      .map((file) => api?.getPathForFile(file))
      .filter((item): item is string => Boolean(item));
    await addFiles(paths, 'import');
  }

  async function openItem(item: WarehouseItem) {
    const result = await api?.warehouseOpen(item.id);
    if (result && !result.ok) flash(result.error ?? '打不开这个文件');
  }

  async function revealItem(item: WarehouseItem) {
    const result = await api?.warehouseReveal(item.id);
    if (result && !result.ok) flash(result.error ?? '找不到这个文件');
  }

  async function confirmDelete() {
    if (deleting || !deleteTargets || deleteTargets.length === 0) return;
    const ids = deleteTargets.map((item) => item.id);
    setDeleting(true);
    const next = await api?.warehouseDeleteMany(ids);
    setDeleting(false);
    if (next) setSnapshot(next);
    setThumbnails((prev) => {
      const rest = { ...prev };
      for (const id of ids) delete rest[id];
      return rest;
    });
    setSelected((prev) => {
      const rest = new Set(prev);
      for (const id of ids) rest.delete(id);
      return rest;
    });
    setDeleteTargets(null);
    flash(ids.length > 1 ? `已从仓库删除 ${ids.length} 个文件` : '已从仓库删除');
  }

  async function openRoot() {
    await api?.warehouseOpenRoot();
  }

  return (
    <div className="wh">
      <header className="wh__head">
        <div className="wh__title">
          <span>仓库</span>
          <span className="wh__count">
            {snapshot
              ? `${
                  filter.trim() ? `${visibleItems.length} / ${snapshot.count}` : snapshot.count
                } 个文件 · ${formatSize(snapshot.totalBytes)}`
              : '正在读取…'}
          </span>
        </div>
        <div className="wh__actions">
          <div className="search wh__search">
            <SearchIcon size={14} />
            <input
              value={filter}
              placeholder="搜索文件名"
              aria-label="搜索仓库文件"
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter !== '' && (
              <button
                className="wh__search-clear"
                title="清除搜索"
                aria-label="清除搜索"
                onClick={() => setFilter('')}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <button className="btn btn--ghost" title="刷新列表" onClick={() => void refresh()}>
            <RefreshIcon size={14} />
            刷新
          </button>
          <button className="btn btn--ghost" onClick={() => void openRoot()}>
            <FolderIcon size={14} />
            打开目录
          </button>
          <button
            className="btn btn--danger"
            disabled={selected.size === 0 || deleting}
            title={selected.size === 0 ? '先勾选要删除的文件' : `删除已选的 ${selected.size} 个文件`}
            onClick={() => setDeleteTargets(selectedItems)}
          >
            <TrashIcon size={14} />
            {selected.size > 0 ? `删除所选 ${selected.size}` : '批量删除'}
          </button>
          <button className="btn btn--primary" onClick={() => void importFiles()} disabled={importing}>
            <UploadIcon size={14} />
            {importing ? '导入中…' : '导入文件'}
          </button>
        </div>
      </header>

      <section
        className="wh__body"
        ref={bodyRef}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {items.length === 0 ? (
          <div className="wh-empty">
            <div className="wh-empty__icon">
              <WarehouseIcon size={24} />
            </div>
            <h2>仓库还是空的</h2>
            <p>
              对话里粘贴的图片和文件会收进这里，也可以直接把文件拖进来。仓库只负责存放原文件，不解析、不切分、不做向量检索，和知识库完全独立。
            </p>
            <button className="btn btn--primary" onClick={() => void importFiles()}>
              导入文件
            </button>
            {snapshot?.root && (
              <span className="wh-empty__hint" title={snapshot.root}>
                存储位置：{snapshot.root}
              </span>
            )}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="kb-empty">没有匹配「{filter.trim()}」的文件</div>
        ) : (
          <div className="wh-list">
            {visibleItems.map((item) => (
              <WarehouseRow
                key={item.id}
                item={item}
                thumbnail={thumbnails[item.id]}
                usages={usage[item.id] ?? []}
                selected={selected.has(item.id)}
                onToggle={toggleSelected}
                onJump={handleJump}
                onReference={(entry) => void referenceItem(entry)}
                onOpen={(entry) => void openItem(entry)}
                onReveal={(entry) => void revealItem(entry)}
                onDelete={(entry) => setDeleteTargets([entry])}
              />
            ))}
          </div>
        )}

        {dragging && (
          <div className="wh__dropmask">
            <UploadIcon size={22} />
            松开即可放进仓库
          </div>
        )}
      </section>

      {jumpMenu && (
        <>
          <div className="wh-jump__backdrop" onClick={() => setJumpMenu(null)} />
          <div
            className="wh-jump__menu"
            style={{ top: jumpMenu.top, right: jumpMenu.right }}
            role="menu"
          >
            <div className="wh-jump__title">
              选择要跳转的对话
              <span className="wh-jump__count">{jumpEntries.length} 处引用</span>
            </div>
            <div className="wh-jump__search">
              <SearchIcon size={13} />
              <input
                autoFocus
                value={jumpQuery}
                placeholder="搜索对话或工作空间"
                aria-label="搜索引用"
                onChange={(event) => setJumpQuery(event.target.value)}
              />
              {jumpQuery !== '' && (
                <button
                  className="wh-jump__clear"
                  title="清除搜索"
                  aria-label="清除搜索"
                  onClick={() => setJumpQuery('')}
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </div>
            {jumpMatches.length === 0 ? (
              <div className="wh-jump__empty">没有匹配「{jumpQuery.trim()}」的引用</div>
            ) : (
              jumpMatches.map((entry) => (
                <button
                  key={`${entry.kind}:${entry.sessionId}`}
                  className="wh-jump__item"
                  role="menuitem"
                  onClick={() => {
                    setJumpMenu(null);
                    setJumpQuery('');
                    onJump(entry);
                  }}
                >
                  <span className="wh-jump__name" title={entry.sessionTitle}>
                    {entry.sessionTitle}
                  </span>
                  <span className="wh-jump__meta">
                    <span
                      className={`wh-jump__scope ${entry.kind === 'workspace' ? 'is-workspace' : ''}`}
                    >
                      {entry.kind === 'workspace'
                        ? `工作空间 · ${entry.workspaceName ?? '工作空间'}`
                        : '对话'}
                    </span>
                    <span className="wh-jump__time">{formatDateTime(entry.at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}

      {toast && <div className="wh__toast">{toast}</div>}

      {deleteTargets && (
        <ConfirmDialog
          title="从仓库删除"
          message={
            deleteTargets.length === 1
              ? `删除「${deleteTargets[0].name}」？文件会从仓库目录里移除，此操作不可撤销。`
              : `删除选中的 ${deleteTargets.length} 个文件？文件会从仓库目录里移除，此操作不可撤销。`
          }
          confirmLabel={deleting ? '删除中…' : '删除'}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setDeleteTargets(null);
          }}
        />
      )}
    </div>
  );
}
