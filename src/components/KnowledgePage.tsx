import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { formatDateTime } from '../lib/time';
import type {
  KbCategory,
  KbCategoryKind,
  KbDocument,
  KbSearchHit,
  KbSnapshot,
  KbStatus,
} from '../types';
import {
  DownloadIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  StackIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';
import { MaterialFileIcon } from './MaterialFileIcon';

const ALL = 'all';
const DEFAULT_CATEGORY_ID = 'default';

const STATUS_KEY: Record<KbStatus, string> = {
  pending: 'knowledge.status.pending',
  parsing: 'knowledge.status.parsing',
  embedding: 'knowledge.status.embedding',
  ready: 'knowledge.status.ready',
  error: 'knowledge.status.error',
};

function isBusy(doc: KbDocument): boolean {
  return doc.status === 'pending' || doc.status === 'parsing' || doc.status === 'embedding';
}

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

function extensionOf(doc: KbDocument): string {
  return (doc.ext || '').replace('.', '').toUpperCase() || 'FILE';
}

function documentsIn(category: KbCategory, documents: KbDocument[]): KbDocument[] {
  if (category.kind === 'group') {
    return documents.filter((doc) => category.includes.includes(doc.categoryId));
  }
  return documents.filter((doc) => doc.categoryId === category.id);
}

interface DocRowProps {
  doc: KbDocument;
  categories: KbCategory[];
  progress: Record<string, number>;
  stage?: KbStatus;
  onMove: (docId: string, categoryId: string) => void;
  onDownload: (doc: KbDocument) => void;
  onRemove: (doc: KbDocument) => void;
}

function DocumentRow({ doc, categories, progress, stage, onMove, onDownload, onRemove }: DocRowProps) {
  const { t } = useI18n();
  // The row's stored status only flips to ready at the end, so live ingest events
  // supply the current step (解析中 / 向量化).
  const label = t(STATUS_KEY[isBusy(doc) && stage ? stage : doc.status]);
  return (
    <div className="kb-doc">
      <span className="kb-doc__ext" title={extensionOf(doc)}>
        <MaterialFileIcon name={doc.name} size={20} />
      </span>

      <div className="kb-doc__main">
        <div className="kb-doc__name" title={doc.name}>
          {doc.name}
        </div>
        <div className="kb-doc__meta">
          {formatSize(doc.size)} ·{' '}
          {t('knowledge.addedAt', { date: formatDateTime(doc.createdAt) })} ·{' '}
          {t('knowledge.chunkCount', { count: doc.chunkCount })} · {label}
          {doc.status === 'error' && doc.error && <span className="kb-doc__error"> · {doc.error}</span>}
        </div>
        {isBusy(doc) && (
          <div className="kb-doc__bar">
            <span style={{ width: `${progress[doc.id] ?? 0}%` }} />
          </div>
        )}
      </div>

      <select
        className="select kb-doc__move"
        value={doc.categoryId}
        title={t('knowledge.moveToCategory')}
        onChange={(event) => onMove(doc.id, event.target.value)}
      >
        {/* 组合分类 can't hold files, so they are not move targets. */}
        {categories
          .filter((category) => category.kind !== 'group')
          .map((category) => (
            <option key={category.id} value={category.id}>
              {category.id === DEFAULT_CATEGORY_ID ? t('knowledge.category.default') : category.name}
            </option>
          ))}
      </select>

      <button className="iconbtn" title={t('knowledge.downloadOriginal')} onClick={() => onDownload(doc)}>
        <DownloadIcon size={15} />
      </button>

      <button className="iconbtn" title={t('knowledge.delete')} onClick={() => onRemove(doc)}>
        <TrashIcon size={15} />
      </button>
    </div>
  );
}

interface EditorState {
  mode: 'create' | 'edit';
  id?: string;
  name: string;
  kind: KbCategoryKind;
  includes: string[];
}

export function KnowledgePage() {
  const { t } = useI18n();
  const api = window.ezness;

  const [snapshot, setSnapshot] = useState<KbSnapshot | null>(null);
  const [activeCat, setActiveCat] = useState<string>(ALL);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KbSearchHit[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragCat, setDragCat] = useState<string | null>(null);
  const [dropCat, setDropCat] = useState<{ id: string; before: boolean } | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [stages, setStages] = useState<Record<string, KbStatus>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

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
    const next = await api?.kbSnapshot();
    if (next) setSnapshot(next);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = api?.onKbEvent((event) => {
      if (event.type === 'refresh') {
        setSnapshot({
          categories: event.categories ?? [],
          documents: event.documents ?? [],
          stats: event.stats ?? { documents: 0, chunks: 0, ready: 0 },
        });
        return;
      }

      if (event.docId) {
        const docId = event.docId;
        setProgress((prev) => ({ ...prev, [docId]: event.progress ?? 0 }));
        if (event.stage && event.stage !== 'skipped') {
          setStages((prev) => ({ ...prev, [docId]: event.stage as KbStatus }));
        }
      }
      if (event.stage === 'ready' || event.stage === 'error' || event.stage === 'skipped') {
        void refresh();
      }
    });
    return () => unsubscribe?.();
  }, [api, refresh]);

  const documents = snapshot?.documents ?? [];
  const categories = snapshot?.categories ?? [];
  const fileCategories = useMemo(
    () => categories.filter((category) => category.kind !== 'group'),
    [categories],
  );

  const activeCategory = activeCat === ALL ? null : categories.find((item) => item.id === activeCat) ?? null;
  const isGroup = activeCategory?.kind === 'group';

  const visible = useMemo(() => {
    if (activeCat === ALL) return documents;
    if (!activeCategory) return [];
    return documentsIn(activeCategory, documents);
  }, [activeCat, activeCategory, documents]);

  const activeName = activeCategory?.name ?? t('knowledge.all');

  // "全部" and 组合分类 have no folder of their own, so dropped files go to the default one.
  const targetCategory = isGroup || activeCat === ALL ? null : activeCat;

  const busyCount = visible.filter(isBusy).length;

  // Search shows the files behind the hits first, then the passages themselves.
  const matchedDocs = useMemo(() => {
    if (!results) return [];
    const seen = new Set<string>();
    const list: KbDocument[] = [];
    for (const hit of results) {
      if (seen.has(hit.docId)) continue;
      seen.add(hit.docId);
      const doc = documents.find((item) => item.id === hit.docId);
      if (doc) list.push(doc);
    }
    return list;
  }, [results, documents]);

  async function addFiles(paths: string[]) {
    if (paths.length === 0) return;
    if (isGroup) {
      flash(t('knowledge.toast.groupNoFiles'));
      return;
    }
    await api?.kbAddFiles(paths, targetCategory);
    void refresh();
  }

  async function upload() {
    const paths = await api?.kbPickFiles();
    await addFiles(paths ?? []);
  }

  async function reorderCategories(fromId: string, toId: string, before: boolean) {
    if (fromId === toId) return;
    const rest = categories.map((category) => category.id).filter((id) => id !== fromId);
    const targetIndex = rest.indexOf(toId);
    if (targetIndex < 0) return;
    rest.splice(before ? targetIndex : targetIndex + 1, 0, fromId);

    // Land the row where it was dropped first, then persist the order.
    const byId = new Map(categories.map((category) => [category.id, category]));
    setSnapshot((prev) =>
      prev ? { ...prev, categories: rest.map((id) => byId.get(id) as KbCategory) } : prev,
    );
    try {
      const next = await api?.kbReorderCategories(rest);
      if (next) setSnapshot(next);
    } catch {
      await refresh();
    }
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    // Category rows also drag inside this section; only files belong here.
    if (!event.dataTransfer.types.includes('Files')) return;
    const paths = [...event.dataTransfer.files]
      .map((file) => api?.getPathForFile(file))
      .filter((item): item is string => Boolean(item));
    await addFiles(paths);
  }

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setNote(null);
      return;
    }
    setSearching(true);
    const response = await api?.kbSearch(trimmed, {
      categoryId: activeCat === ALL ? null : activeCat,
    });
    setResults(response?.results ?? []);
    setNote(response?.note ?? null);
    setSearching(false);
  }

  function openCreate() {
    setEditor({ mode: 'create', name: '', kind: 'files', includes: [] });
  }

  function openEdit(category: KbCategory) {
    setEditor({
      mode: 'edit',
      id: category.id,
      name: category.name,
      kind: category.kind,
      includes: [...category.includes],
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      flash(t('knowledge.toast.nameRequired'));
      return;
    }

    try {
      let next: KbSnapshot | undefined;
      if (editor.mode === 'create') {
        next = await api?.kbCreateCategory(name, editor.kind, editor.includes);
      } else if (editor.id) {
        const current = categories.find((item) => item.id === editor.id);
        if (current && current.name !== name) {
          next = await api?.kbRenameCategory(editor.id, name);
        }
        if (editor.kind === 'group') {
          next = await api?.kbSetCategoryIncludes(editor.id, editor.includes);
        }
      }
      if (next) setSnapshot(next);
      else await refresh();
      setEditor(null);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeCategory(category: KbCategory) {
    const message =
      category.kind === 'group'
        ? t('knowledge.deleteGroupConfirm', { name: category.name })
        : t('knowledge.deleteCategoryConfirm', {
          name: category.id === DEFAULT_CATEGORY_ID ? t('knowledge.category.default') : category.name,
        });
    if (!window.confirm(message)) return;
    try {
      const next = await api?.kbDeleteCategory(category.id);
      if (next) setSnapshot(next);
      if (activeCat === category.id) setActiveCat(ALL);
      if (editor?.id === category.id) setEditor(null);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveDocument(docId: string, categoryId: string) {
    try {
      const next = await api?.kbMoveDocument(docId, categoryId);
      if (next) setSnapshot(next);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeDocument(doc: KbDocument) {
    if (!window.confirm(t('knowledge.deleteDocumentConfirm', { name: doc.name }))) return;
    const next = await api?.kbDeleteDocument(doc.id);
    if (next) setSnapshot(next);
  }

  async function downloadDocument(doc: KbDocument) {
    const result = await api?.kbExportDocument(doc.id);
    if (!result) return;
    if (result.ok && result.path) flash(t('knowledge.toast.savedTo', { path: result.path }));
    else if (result.error) flash(t('knowledge.toast.downloadFailed', { error: result.error }));
  }

  const canToggleInclude = (id: string) =>
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            includes: prev.includes.includes(id)
              ? prev.includes.filter((item) => item !== id)
              : [...prev.includes, id],
          }
        : prev,
    );

  return (
    <div className="kb">
      <aside className="kb__cats">
        <div className="kb__cats-head">
          <span>{t('knowledge.categories')}</span>
          <button className="iconbtn" title={t('knowledge.newCategory')} onClick={openCreate}>
            <PlusIcon size={14} />
          </button>
        </div>

        <div
          className={`kb-cat ${activeCat === ALL ? 'is-active' : ''}`}
          onClick={() => setActiveCat(ALL)}
          role="button"
          tabIndex={0}
        >
          <FolderIcon size={15} />
          <span className="kb-cat__name">{t('knowledge.all')}</span>
          <span className="kb-cat__count">{documents.length}</span>
        </div>

        {categories.map((category) => (
          <div
            key={category.id}
            className={[
              'kb-cat',
              activeCat === category.id ? 'is-active' : '',
              dragCat === category.id ? 'is-dragging' : '',
              dropCat?.id === category.id ? (dropCat.before ? 'is-drop-before' : 'is-drop-after') : '',
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onClick={() => setActiveCat(category.id)}
            onDragStart={(event) => {
              setDragCat(category.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', category.id);
            }}
            onDragOver={(event) => {
              if (!dragCat || dragCat === category.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const rect = event.currentTarget.getBoundingClientRect();
              setDropCat({ id: category.id, before: event.clientY < rect.top + rect.height / 2 });
            }}
            onDrop={(event) => {
              if (!dragCat || dragCat === category.id) return;
              event.preventDefault();
              const before = dropCat?.id === category.id ? dropCat.before : true;
              void reorderCategories(dragCat, category.id, before);
              setDragCat(null);
              setDropCat(null);
            }}
            onDragEnd={() => {
              setDragCat(null);
              setDropCat(null);
            }}
            title={category.kind === 'group' ? t('knowledge.groupHint') : undefined}
            role="button"
            tabIndex={0}
          >
            {category.kind === 'group' ? <StackIcon size={15} /> : <FolderIcon size={15} />}
            <span className="kb-cat__name">{category.id === DEFAULT_CATEGORY_ID ? t('knowledge.category.default') : category.name}</span>
            <span className="kb-cat__count">{documentsIn(category, documents).length}</span>
            <button
              className="kb-cat__act"
              title={t('knowledge.renameEdit')}
              onClick={(event) => {
                event.stopPropagation();
                openEdit(category);
              }}
            >
              <EditIcon size={12} />
            </button>
            {category.id !== DEFAULT_CATEGORY_ID && (
              <button
                className="kb-cat__act kb-cat__act--danger"
                title={t('knowledge.deleteCategory')}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeCategory(category);
                }}
              >
                <TrashIcon size={12} />
              </button>
            )}
          </div>
        ))}

        {editor && (
          <div className="kb-editor">
            <input
              className="input"
              autoFocus
              value={editor.name}
              placeholder={t('knowledge.categoryName')}
              onChange={(event) =>
                setEditor((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveEditor();
                if (event.key === 'Escape') setEditor(null);
              }}
            />

            {editor.mode === 'create' && (
              <div className="kb-editor__kinds">
                <button
                  className={`kb-editor__kind ${editor.kind === 'files' ? 'is-on' : ''}`}
                  onClick={() => setEditor((prev) => (prev ? { ...prev, kind: 'files' } : prev))}
                >
                  <FolderIcon size={13} /> {t('knowledge.kindFiles')}
                </button>
                <button
                  className={`kb-editor__kind ${editor.kind === 'group' ? 'is-on' : ''}`}
                  onClick={() => setEditor((prev) => (prev ? { ...prev, kind: 'group' } : prev))}
                >
                  <StackIcon size={13} /> {t('knowledge.kindGroup')}
                </button>
              </div>
            )}

            {editor.kind === 'group' && (
              <>
                <div className="kb-editor__hint">{t('knowledge.groupIncludeHint')}</div>
                <div className="kb-editor__list">
                  {fileCategories.length === 0 && (
                    <div className="kb-editor__hint">{t('knowledge.noFileCategories')}</div>
                  )}
                  {fileCategories.map((category) => (
                    <label key={category.id} className="kb-editor__check">
                      <input
                        type="checkbox"
                        checked={editor.includes.includes(category.id)}
                        onChange={() => canToggleInclude(category.id)}
                      />
                      <span>{category.id === DEFAULT_CATEGORY_ID ? t('knowledge.category.default') : category.name}</span>
                      <span className="kb-cat__count">
                        {documentsIn(category, documents).length}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="kb-editor__actions">
              <button className="btn btn--primary" onClick={() => void saveEditor()}>
                {t('knowledge.confirm')}
              </button>
              <button className="btn btn--ghost" onClick={() => setEditor(null)}>
                {t('knowledge.cancel')}
              </button>
            </div>
          </div>
        )}

        <div className="kb__cats-foot">
          {t('knowledge.footCounts', {
            chunks: snapshot?.stats.chunks ?? 0,
            documents: snapshot?.stats.documents ?? 0,
          })}
        </div>
      </aside>

      <section
        className="kb__main"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <header className="kb__head">
          <div className="kb__title">
            <span>{activeName}</span>
            {activeCategory?.kind === 'group' && (
              <span className="kb__tag">{t('knowledge.groupTag', { count: activeCategory.includes.length })}</span>
            )}
            <span className="kb__count">{t('knowledge.fileCount', { count: visible.length })}</span>
            {busyCount > 0 && (
              <span className="kb__busy">{t('knowledge.busyRemaining', { count: busyCount })}</span>
            )}
          </div>
          <div className="kb__actions">
            <div className="search kb__search">
              <SearchIcon size={15} />
              <input
                value={query}
                placeholder={t('knowledge.searchPlaceholder')}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch();
                }}
              />
            </div>
            <button
              className="btn btn--primary"
              onClick={upload}
              disabled={isGroup}
              title={isGroup ? t('knowledge.cannotAddToGroup') : undefined}
            >
              <UploadIcon size={14} />
              {t('knowledge.upload')}
            </button>
          </div>
        </header>

        <div className="kb__body">
          {results !== null ? (
            <div className="kb-results">
              <div className="kb-results__head">
                <span>
                  {searching
                    ? t('knowledge.searching')
                    : t('knowledge.searchSummary', {
                        files: matchedDocs.length,
                        chunks: results.length,
                      })}
                  {note && <span className="kb-results__note"> · {note}</span>}
                </span>
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setResults(null);
                    setNote(null);
                  }}
                >
                  {t('knowledge.backToFiles')}
                </button>
              </div>

              {matchedDocs.length > 0 && (
                <section className="kb-results__group">
                  <div className="kb-results__label">{t('knowledge.matchedFiles')}</div>
                  <div className="kb-docs">
                    {matchedDocs.map((doc) => (
                      <DocumentRow
                        key={doc.id}
                        doc={doc}
                        categories={categories}
                        progress={progress}
                        stage={stages[doc.id]}
                        onMove={(docId, categoryId) => void moveDocument(docId, categoryId)}
                        onDownload={(item) => void downloadDocument(item)}
                        onRemove={(item) => void removeDocument(item)}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="kb-results__group">
                <div className="kb-results__label">{t('knowledge.matchedChunks')}</div>
                {results.map((hit) => (
                  <article key={hit.chunkId} className="kb-hit">
                    <header>
                      <span className="kb-hit__doc">{hit.docName}</span>
                      {hit.section && <span className="kb-hit__tag">{hit.section}</span>}
                      {hit.page != null && <span className="kb-hit__tag">P{hit.page}</span>}
                      <span className="kb-hit__score">{hit.score}</span>
                    </header>
                    <p>{hit.text}</p>
                  </article>
                ))}
                {!searching && results.length === 0 && (
                  <div className="kb-empty">{t('knowledge.noMatches')}</div>
                )}
              </section>
            </div>
          ) : visible.length === 0 ? (
            <div className="kb-drop">
              <div className="kb-drop__icon">
                {isGroup ? <StackIcon size={24} /> : <UploadIcon size={24} />}
              </div>
              <h2>{isGroup ? t('knowledge.groupEmptyTitle') : t('knowledge.dropTitle')}</h2>
              <p>{isGroup ? t('knowledge.groupEmptyBody') : t('knowledge.dropBody')}</p>
              {!isGroup && (
                <>
                  <button className="btn btn--primary" onClick={upload}>
                    {t('knowledge.chooseFiles')}
                  </button>
                  <span className="kb-drop__hint">
                    {activeCat === ALL
                      ? t('knowledge.dropHintDefault')
                      : t('knowledge.dropHintCategory', { name: activeName })}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="kb-docs">
              {visible.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  categories={categories}
                  progress={progress}
                  stage={stages[doc.id]}
                  onMove={(docId, categoryId) => void moveDocument(docId, categoryId)}
                  onDownload={(item) => void downloadDocument(item)}
                  onRemove={(item) => void removeDocument(item)}
                />
              ))}
            </div>
          )}
        </div>

        {dragging && (
          <div className="kb__dropmask">
            <FileIcon size={22} />
            {isGroup ? t('knowledge.cannotAddToGroup') : t('knowledge.dropRelease')}
          </div>
        )}
      </section>

      {toast && <div className="kb__toast">{toast}</div>}
    </div>
  );
}
