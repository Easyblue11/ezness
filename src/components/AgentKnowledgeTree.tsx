import { useEffect, useRef, useState } from 'react';
import type {
  AgentKnowledgeSelection,
  KbCategory,
  KbDocument,
  KbSnapshot,
} from '../types';
import { useI18n } from '../i18n';

/**
 * The Agent's view of the shared knowledge base.
 *
 * Nothing is imported or stored per Agent here: the tree is a live read of the
 * user's 知识库, and ticking a node only records a selection. A category tick
 * takes every document under it; individual documents can then be unticked,
 * which is stored as an exclusion so later additions to that category still
 * come along.
 */

const REVIEW_LABEL_KEYS: Record<string, string> = {
  confirmed: 'agent.reviewState.confirmed',
  candidate: 'agent.reviewState.candidate',
  rejected: 'agent.reviewState.rejected',
};

function TriCheckbox({
  checked,
  mixed,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(mixed && !checked);
  }, [checked, mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="agent-kb-tree__check"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

interface Props {
  snapshot: KbSnapshot | null;
  loading: boolean;
  error: string;
  selection: AgentKnowledgeSelection;
  onChange: (next: AgentKnowledgeSelection) => void;
}

export function AgentKnowledgeTree({
  snapshot,
  loading,
  error,
  selection,
  onChange,
}: Props) {
  const { t } = useI18n();
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

  const categories = snapshot?.categories ?? [];
  const documents = snapshot?.documents ?? [];
  const byId = new Map(categories.map((category) => [category.id, category]));

  // A category that belongs to a group is rendered under that group, so only
  // categories no group includes are tree roots.
  const nestedIds = new Set(
    categories
      .filter((category) => category.kind === 'group')
      .flatMap((category) => category.includes ?? []),
  );
  const roots = categories.filter((category) => !nestedIds.has(category.id));

  // Stored ids may name a group (seeded or written by an older build). Expand
  // them so the child categories show as selected too.
  const selectedCategories = expandCategories(
    selection.categoryIds.filter((id) => byId.has(id)),
  );
  const selectedDocs = new Set(selection.documentIds);
  const excludedDocs = new Set(selection.excludeDocumentIds);

  function docsOf(categoryId: string): KbDocument[] {
    return documents.filter((doc) => doc.categoryId === categoryId);
  }

  /** Groups may nest; resolve to the concrete file categories below them. */
  function expandCategories(ids: string[]): Set<string> {
    const out = new Set<string>();
    const visit = (id: string, depth: number) => {
      if (depth > 8 || out.has(id)) return;
      const category = byId.get(id);
      if (!category) return;
      if (category.kind === 'group') {
        for (const member of category.includes ?? []) visit(member, depth + 1);
        return;
      }
      out.add(id);
    };
    for (const id of ids) visit(id, 0);
    return out;
  }

  function categoryChecked(categoryId: string): boolean {
    return selectedCategories.has(categoryId);
  }

  function categoryMixed(categoryId: string): boolean {
    if (!selectedCategories.has(categoryId)) {
      return docsOf(categoryId).some((doc) => selectedDocs.has(doc.id));
    }
    return docsOf(categoryId).some((doc) => excludedDocs.has(doc.id));
  }

  function docChecked(doc: KbDocument): boolean {
    return selectedCategories.has(doc.categoryId)
      ? !excludedDocs.has(doc.id)
      : selectedDocs.has(doc.id);
  }

  function docAllowed(doc: KbDocument): boolean {
    return doc.status === 'ready';
  }

  function emit(next: AgentKnowledgeSelection) {
    onChange({
      categoryIds: [...new Set(next.categoryIds)],
      documentIds: [...new Set(next.documentIds)],
      excludeDocumentIds: [...new Set(next.excludeDocumentIds)],
    });
  }

  function setCategory(categoryIds: string[], on: boolean) {
    const targets = expandCategories(categoryIds);
    const nextCategories = new Set(selection.categoryIds);
    const nextDocs = new Set(selection.documentIds);
    const nextExcluded = new Set(selection.excludeDocumentIds);
    for (const id of targets) {
      const docs = docsOf(id);
      if (on) {
        nextCategories.add(id);
        for (const doc of docs) {
          nextDocs.delete(doc.id);
          nextExcluded.delete(doc.id);
        }
      } else {
        nextCategories.delete(id);
        for (const doc of docs) {
          nextDocs.delete(doc.id);
          nextExcluded.delete(doc.id);
        }
        // A stored group selection would keep this category selected, so drop
        // any group that still expands to it.
        for (const stored of [...nextCategories]) {
          if (byId.get(stored)?.kind !== 'group') continue;
          if (expandCategories([stored]).has(id)) nextCategories.delete(stored);
        }
      }
    }
    emit({
      categoryIds: [...nextCategories],
      documentIds: [...nextDocs],
      excludeDocumentIds: [...nextExcluded],
    });
  }

  function toggleGroup(group: KbCategory) {
    // A half-selected group means "not all of it yet": clicking must fill it in,
    // not clear what is already selected.
    setCategory([group.id], !groupState(group).checked);
  }

  function toggleCategory(category: KbCategory) {
    setCategory([category.id], !categoryChecked(category.id));
  }

  function toggleDocument(doc: KbDocument) {
    if (!docAllowed(doc)) return;
    const on = docChecked(doc);
    const inCategory = selectedCategories.has(doc.categoryId);
    const nextDocs = new Set(selection.documentIds);
    const nextExcluded = new Set(selection.excludeDocumentIds);
    if (on) {
      if (inCategory) nextExcluded.add(doc.id);
      else nextDocs.delete(doc.id);
    } else if (inCategory) {
      nextExcluded.delete(doc.id);
    } else {
      nextDocs.add(doc.id);
    }
    emit({
      categoryIds: selection.categoryIds,
      documentIds: [...nextDocs],
      excludeDocumentIds: [...nextExcluded],
    });
  }

  function toggle(setter: typeof setOpenGroups, id: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function groupState(group: KbCategory): { checked: boolean; mixed: boolean } {
    const members = [...expandCategories([group.id])];
    if (members.length === 0) return { checked: false, mixed: false };
    const checked = members.every((id) => categoryChecked(id) && !categoryMixed(id));
    const mixed = !checked && members.some(
      (id) => categoryChecked(id) || categoryMixed(id),
    );
    return { checked, mixed };
  }

  /**
   * One tree node: a group renders its member categories, a file category
   * renders its documents. Indentation comes from `depth`, so a document always
   * sits one step below its category, however deep that category is nested.
   */
  function categoryNode(category: KbCategory, depth: number, ancestors: Set<string>) {
    const isGroup = category.kind === 'group';
    const open = isGroup ? openGroups.has(category.id) : openCategories.has(category.id);
    const members = isGroup
      ? (category.includes ?? [])
          .filter((id) => !ancestors.has(id))
          .map((id) => byId.get(id))
          .filter((item): item is KbCategory => Boolean(item))
      : [];
    const docs = isGroup ? [] : docsOf(category.id);
    const state = isGroup
      ? groupState(category)
      : { checked: categoryChecked(category.id), mixed: categoryMixed(category.id) };
    const paddingLeft = 10 + depth * 18;
    return (
      <li key={category.id} className="agent-kb-tree__node">
        <div
          className={`agent-kb-tree__row${isGroup ? ' is-group' : ''}${
            (isGroup ? members.length : docs.length) > 0 ? ' is-expandable' : ''
          }`}
          style={{ paddingLeft }}
          onClick={(event) => {
            // Clicking the row expands it, like a file tree. The caret and the
            // checkbox keep their own behaviour.
            const target = event.target as HTMLElement;
            if (
              target.closest('.agent-kb-tree__caret') ||
              target.closest('.agent-kb-tree__check')
            ) {
              return;
            }
            if ((isGroup ? members.length : docs.length) === 0) return;
            toggle(isGroup ? setOpenGroups : setOpenCategories, category.id);
          }}
        >
          <button
            type="button"
            className="agent-kb-tree__caret"
            aria-label={
              isGroup
                ? open
                  ? t('agent.tree.collapseGroup')
                  : t('agent.tree.expandGroup')
                : open
                  ? t('agent.tree.collapseDocs')
                  : t('agent.tree.expandDocs')
            }
            onClick={() => toggle(isGroup ? setOpenGroups : setOpenCategories, category.id)}
            disabled={isGroup ? members.length === 0 : docs.length === 0}
          >
            {(isGroup ? members.length : docs.length) === 0 ? '' : open ? '▾' : '▸'}
          </button>
          <TriCheckbox
            checked={state.checked}
            mixed={state.mixed}
            label={
              isGroup
                ? t('agent.tree.selectGroup', { name: category.name })
                : t('agent.tree.selectCategory', { name: category.name })
            }
            onChange={() => (isGroup ? toggleGroup(category) : toggleCategory(category))}
          />
          <span className="agent-kb-tree__name">{category.name}</span>
          <span className="agent-kb-tree__meta">
            {isGroup
              ? t('agent.tree.groupMeta', { count: members.length })
              : t('agent.tree.docsMeta', { count: docs.length })}
          </span>
        </div>
        {open && docs.length > 0 && (
          <ul className="agent-kb-tree__docs">
            {docs.map((doc) => (
              <li
                key={doc.id}
                className="agent-kb-tree__doc"
                style={{ paddingLeft: paddingLeft + 38 }}
              >
                <TriCheckbox
                  checked={docChecked(doc)}
                  disabled={!docAllowed(doc)}
                  label={t('agent.tree.selectDoc', { name: doc.name })}
                  onChange={() => toggleDocument(doc)}
                />
                <span
                  className={`agent-kb-tree__doc-name ${docAllowed(doc) ? '' : 'is-muted'}`}
                  title={doc.name}
                >
                  {doc.name}
                </span>
                <span className={`agent-kb-tree__review is-${doc.reviewState}`}>
                  {t(REVIEW_LABEL_KEYS[doc.reviewState] ?? doc.reviewState)}
                </span>
                {!docAllowed(doc) && (
                  <span className="agent-kb-tree__meta">{t('agent.tree.unavailable')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {open && isGroup && members.length > 0 && (
          <ul className="agent-kb-tree__list">
            {members.map((child) =>
              categoryNode(child, depth + 1, new Set([...ancestors, category.id])),
            )}
          </ul>
        )}
      </li>
    );
  }

  if (loading && !snapshot) {
    return <div className="agent-kb-tree__empty">{t('agent.tree.loading')}</div>;
  }
  if (error) {
    return <div className="agent-kb-tree__empty is-error">{error}</div>;
  }
  if (documents.length === 0) {
    return (
      <div className="agent-kb-tree__empty">{t('agent.tree.empty')}</div>
    );
  }

  const selectedCount = selectedCategories.size;
  const selectedDocCount = documents.filter((doc) => docChecked(doc)).length;

  return (
    <div className="agent-kb-tree">
      <div className="agent-kb-tree__bar">
        <div>{t('agent.tree.intro')}</div>
        <div className="agent-kb-tree__stats">
          {t('agent.tree.stats', {
            categories: selectedCount,
            docs: selectedDocCount,
          })}
        </div>
      </div>
      {selectedCount === 0 && selectedDocCount === 0 && (
        <div className="agent-kb-tree__hint">{t('agent.tree.noSelection')}</div>
      )}
      <ul className="agent-kb-tree__list">
        {roots.map((category) => categoryNode(category, 0, new Set()))}
      </ul>
    </div>
  );
}
