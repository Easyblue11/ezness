/**
 * Per-Agent knowledge scope.
 *
 * The knowledge base itself belongs to the user and is maintained in one
 * place. An Agent only stores which categories and documents it may see:
 *
 *   categoryIds        whole categories (组合分类 included)
 *   documentIds        documents picked one by one
 *   excludeDocumentIds documents taken out of a selected category
 *
 * This module turns that selection into the runtime data-access shape used by
 * the tool layer, and merges it with categories the user activated in the
 * composer for one task. It is pure data work so it can be tested without
 * Electron.
 */

const MAX_SELECTION = 500;

function uniqueStrings(value, limit = MAX_SELECTION) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

/** Validate a stored selection; malformed entries are dropped, never thrown. */
function normalizeSelection(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    categoryIds: uniqueStrings(raw.categoryIds),
    documentIds: uniqueStrings(raw.documentIds),
    excludeDocumentIds: uniqueStrings(raw.excludeDocumentIds),
  };
}

function categoryIndex(categories) {
  return new Map(
    (Array.isArray(categories) ? categories : [])
      .filter((category) => category && typeof category.id === 'string')
      .map((category) => [category.id, category]),
  );
}

/** Expand picked categories (groups included) to concrete file categories. */
function expandCategoryIds(ids, byId) {
  const allowed = new Set();
  const visit = (id, depth) => {
    if (depth > 8 || allowed.has(id)) return;
    const category = byId.get(id);
    if (!category) return;
    if (category.kind === 'group') {
      for (const member of category.includes ?? []) visit(String(member), depth + 1);
      return;
    }
    allowed.add(id);
  };
  for (const id of Array.isArray(ids) ? ids : []) visit(String(id), 0);
  return [...allowed];
}

/**
 * Build the data-access fragment for one Agent.
 *
 * Returns null when the selection no longer points at anything real — the user
 * may have deleted the categories or documents since the Agent was saved.
 */
function agentDataAccess(selection, categories, documents) {
  const normalized = normalizeSelection(selection);
  const byId = categoryIndex(categories);
  const docIds = new Set(
    (Array.isArray(documents) ? documents : [])
      .filter((doc) => doc && typeof doc.id === 'string')
      .map((doc) => doc.id),
  );

  const pickedCategories = normalized.categoryIds.filter((id) => byId.has(id));
  const categoryIds = expandCategoryIds(pickedCategories, byId);
  const documentIds = normalized.documentIds.filter((id) => docIds.has(id));
  const excludeDocumentIds = normalized.excludeDocumentIds.filter((id) => docIds.has(id));

  if (categoryIds.length === 0 && documentIds.length === 0) return null;

  return {
    kbCategoryIds: categoryIds,
    kbCategoryNames: uniqueStrings(pickedCategories.map((id) => byId.get(id)?.name)),
    kbDocumentIds: documentIds,
    kbExcludeDocumentIds: excludeDocumentIds,
    // Marks where the scope came from. The prompt treats an Agent's own
    // library as its domain material (search it first), unlike a one-off
    // activation in the composer, which stays strictly on-demand.
    kbAgent: true,
    warehouse: false,
  };
}

/** Union of the chat's activation and the Agent's saved scope. */
function mergeDataAccess(chatAccess, agentAccess) {
  if (!agentAccess) return chatAccess ?? null;
  if (!chatAccess) return agentAccess;
  return {
    kbCategoryIds: uniqueStrings([
      ...(chatAccess.kbCategoryIds ?? []),
      ...(agentAccess.kbCategoryIds ?? []),
    ]),
    kbCategoryNames: uniqueStrings([
      ...(chatAccess.kbCategoryNames ?? []),
      ...(agentAccess.kbCategoryNames ?? []),
    ]),
    // Exclusions always win: the Agent's saved scope is the least-privilege
    // boundary even when the chat activates the same category.
    kbDocumentIds: uniqueStrings([
      ...(chatAccess.kbDocumentIds ?? []),
      ...(agentAccess.kbDocumentIds ?? []),
    ]),
    kbExcludeDocumentIds: uniqueStrings([
      ...(chatAccess.kbExcludeDocumentIds ?? []),
      ...(agentAccess.kbExcludeDocumentIds ?? []),
    ]),
    // An Agent binding makes the library domain material for this run, even
    // when the user also activated categories for the chat.
    kbAgent: Boolean(chatAccess.kbAgent || agentAccess.kbAgent),
    warehouse: Boolean(chatAccess.warehouse),
  };
}

module.exports = {
  MAX_SELECTION,
  normalizeSelection,
  expandCategoryIds,
  agentDataAccess,
  mergeDataAccess,
};
