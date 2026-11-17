import type {
  AgentCapabilities,
  AgentDefinition,
  AgentReviewCatalog,
  AgentReviewChange,
  KbSnapshot,
  ToolCategory,
} from '../types';

/**
 * Helpers shared by the 审查 panel: build the catalog the model is allowed to
 * suggest from, and turn an accepted suggestion into a patched Agent.
 *
 * Applying is deliberately pure — the panel then saves through the normal
 * `agentsSave` path, so a suggestion can never write something a manual edit
 * could not.
 */

function clip(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

export function buildReviewCatalog(
  capabilities: AgentCapabilities | null,
  toolCategories: ToolCategory[],
  kb: KbSnapshot | null,
): AgentReviewCatalog {
  const tools = capabilities?.tools ?? [];
  const builtinNames = [...new Set(tools.filter((tool) => !tool.custom).map((tool) => tool.category))];
  const order = capabilities?.categories ?? [];
  const orderedBuiltin = [
    ...order.filter((name) => builtinNames.includes(name)),
    ...builtinNames.filter((name) => !order.includes(name)),
  ];

  const documents = kb?.documents ?? [];
  const categories = kb?.categories ?? [];

  /** A group category counts the files of the categories it includes. */
  function documentCount(categoryId: string, seen = new Set<string>()): number {
    if (seen.has(categoryId)) return 0;
    seen.add(categoryId);
    const category = categories.find((item) => item.id === categoryId);
    const direct = documents.filter((document) => document.categoryId === categoryId).length;
    const nested = (category?.includes ?? []).reduce(
      (sum, id) => sum + documentCount(id, seen),
      0,
    );
    return direct + nested;
  }

  return {
    builtin: orderedBuiltin.map((name) => ({
      name,
      tools: tools
        .filter((tool) => !tool.custom && tool.category === name)
        .map((tool) => ({ name: tool.name, description: clip(tool.description, 200) })),
    })),
    custom: toolCategories.map((category) => ({
      id: category.id,
      name: category.name,
      tools: tools
        .filter((tool) => tool.custom && tool.category === category.name)
        .map((tool) => ({ name: tool.name, description: clip(tool.description, 200) })),
    })),
    knowledge: {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        kind: category.kind,
        documentCount: documentCount(category.id),
      })),
      // A prompt cannot carry an unbounded library; 300 names is plenty for
      // judging which categories are relevant, and categories carry the rest.
      documents: documents.slice(0, 300).map((document) => ({
        id: document.id,
        name: document.name,
        categoryId: document.categoryId,
        categoryName: categories.find((category) => category.id === document.categoryId)?.name ?? '',
      })),
    },
  };
}

/**
 * Patch one Agent with one accepted suggestion. Changes compose, so applying a
 * batch is the same operation repeated over the current definition.
 */
export function mergeChange(
  agent: AgentDefinition,
  change: AgentReviewChange,
  catalog: AgentReviewCatalog,
): AgentDefinition {
  const capabilities = {
    mode: agent.capabilities?.mode ?? 'all',
    builtin: [...(agent.capabilities?.builtin ?? [])],
    custom: [...(agent.capabilities?.custom ?? [])],
  };
  const knowledge = {
    categoryIds: [...(agent.knowledge?.categoryIds ?? [])],
    documentIds: [...(agent.knowledge?.documentIds ?? [])],
    excludeDocumentIds: [...(agent.knowledge?.excludeDocumentIds ?? [])],
  };

  if (change.kind === 'capability-add' || change.kind === 'capability-remove') {
    const field = change.field === 'custom' ? 'custom' : 'builtin';
    if (capabilities.mode === 'all') {
      // Everything is already included; the only meaningful move is narrowing
      // the scope, which turns the binding into an explicit selection.
      if (change.kind === 'capability-remove') {
        capabilities.mode = 'selected';
        capabilities.builtin = catalog.builtin
          .map((item) => item.name)
          .filter((name) => !(field === 'builtin' && name === change.ref));
        capabilities.custom = catalog.custom
          .map((item) => item.id)
          .filter((id) => !(field === 'custom' && id === change.ref));
      }
    } else {
      const list = field === 'builtin' ? capabilities.builtin : capabilities.custom;
      if (change.kind === 'capability-add') list.push(change.ref);
      else {
        const at = list.indexOf(change.ref);
        if (at !== -1) list.splice(at, 1);
      }
    }
  } else if (change.kind === 'knowledge-add' || change.kind === 'knowledge-remove') {
    if (change.target === 'document') {
      const document = catalog.knowledge.documents.find((item) => item.id === change.ref);
      if (document) {
        const inCategory = knowledge.categoryIds.includes(document.categoryId);
        if (change.kind === 'knowledge-add') {
          if (inCategory) {
            knowledge.excludeDocumentIds = knowledge.excludeDocumentIds.filter(
              (id) => id !== document.id,
            );
          } else {
            knowledge.documentIds.push(document.id);
          }
          knowledge.documentIds = dedupe(knowledge.documentIds);
        } else if (inCategory) {
          knowledge.excludeDocumentIds = dedupe([...knowledge.excludeDocumentIds, document.id]);
        } else {
          knowledge.documentIds = knowledge.documentIds.filter((id) => id !== document.id);
        }
      }
    } else if (change.kind === 'knowledge-add') {
      knowledge.categoryIds = dedupe([...knowledge.categoryIds, change.ref]);
    } else {
      knowledge.categoryIds = knowledge.categoryIds.filter((id) => id !== change.ref);
    }
  } else if (change.kind === 'definition' && change.field && change.value !== undefined) {
    return { ...agent, [change.field]: change.value };
  }

  return {
    ...agent,
    capabilities,
    knowledge,
  };
}

export function mergeChanges(
  agent: AgentDefinition,
  changes: AgentReviewChange[],
  catalog: AgentReviewCatalog,
): AgentDefinition {
  return changes.reduce((current, change) => mergeChange(current, change, catalog), agent);
}
