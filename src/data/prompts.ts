import type {
  PromptSnapshot,
  PromptTemplate,
  PromptVariable,
  PromptVersion,
} from '../types';

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** The editable part of a template, detached from ids and version history. */
export function snapshotOf(template: PromptSnapshot): PromptSnapshot {
  return {
    name: template.name,
    nameEn: template.nameEn,
    description: template.description,
    descriptionEn: template.descriptionEn,
    wrap: template.wrap,
    tags: [...template.tags],
    body: template.body,
    bodyEn: template.bodyEn,
    variables: template.variables.map((variable) => ({ ...variable })),
  };
}

/**
 * Canonical string for change detection. Field order is fixed here, so a seed
 * literal, a history snapshot and a live template compare equal when they hold
 * the same values.
 */
export function snapshotKey(snapshot: PromptSnapshot): string {
  return JSON.stringify(snapshotOf(snapshot));
}

/** CJK characters count as one token each; everything else averages four per token. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  return Math.round(cjk + (text.length - cjk) / 4);
}

/**
 * Replace `{{name}}` with the variable's value. Unknown or empty variables stay
 * visible as markers, so the preview shows what still needs a value.
 */
export function renderPrompt(body: string, variables: PromptVariable[]): string {
  const values = new Map(
    variables
      .filter((variable) => variable.name.trim())
      .map((variable): [string, string] => [variable.name.trim(), variable.value]),
  );
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (marker, rawName: string) => {
    const value = values.get(rawName);
    return value ? value : marker;
  });
}

/* ---------------- import ---------------- */

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeVariables(raw: unknown): PromptVariable[] {
  if (!Array.isArray(raw)) return [];
  const variables: PromptVariable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string') continue;
    variables.push({
      name: record.name.trim(),
      value:
        typeof record.value === 'string'
          ? record.value
          : record.value == null
            ? ''
            : String(record.value),
    });
  }
  return variables;
}

function normalizeSnapshot(raw: unknown, fallbackName: string): PromptSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const body = text('body');
  const name = text('name').trim();
  if (!body && !name) return null;
  return {
    name: name || fallbackName,
    nameEn: text('nameEn'),
    description: text('description'),
    descriptionEn: text('descriptionEn'),
    wrap: record.wrap === true,
    tags: normalizeTags(record.tags),
    body,
    bodyEn: text('bodyEn'),
    variables: normalizeVariables(record.variables),
  };
}

function normalizeHistory(raw: unknown, fallbackName: string): PromptVersion[] {
  if (!Array.isArray(raw)) return [];
  const versions: PromptVersion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const snapshot = normalizeSnapshot(record.snapshot, fallbackName);
    if (!snapshot) continue;
    versions.push({
      // Fresh ids: an imported file must never collide with local history.
      id: uid(),
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
      snapshot,
    });
  }
  return versions;
}

/**
 * Accepts either an exported envelope (`{ format, version, template }`) or a
 * bare template object, and drops anything that doesn't look like one.
 */
export function normalizeTemplate(
  raw: unknown,
  fallbackName = 'Untitled template',
): PromptTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  let record = raw as Record<string, unknown>;
  const envelope = record.template;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    record = envelope as Record<string, unknown>;
  }

  const snapshot = normalizeSnapshot(record, fallbackName);
  if (!snapshot) return null;

  return {
    ...snapshot,
    id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : uid(),
    updatedAt:
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : Date.now(),
    history: normalizeHistory(record.history, fallbackName),
  };
}

export function createBlankTemplate(fallbackName = 'Untitled template'): PromptTemplate {
  return {
    id: uid(),
    name: fallbackName,
    nameEn: '',
    description: '',
    descriptionEn: '',
    wrap: false,
    tags: [],
    body: '',
    bodyEn: '',
    variables: [],
    updatedAt: Date.now(),
    history: [],
  };
}
