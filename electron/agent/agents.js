/**
 * Agent definitions.
 *
 * One JSON file beside the custom tools: `<data root>/agent/agents.json`.
 * Each entry describes a reusable agent — name, role, personality, input and
 * output conventions, its own prompt, which capability categories it may use,
 * and which part of the user's knowledge base it may read. The knowledge base
 * is shared and user-maintained; an agent only stores a selection, never a
 * copy.
 *
 * Definitions are plain data. They are validated again on every load and save:
 * a hand-edited file cannot smuggle in an id that escapes the agent folder or
 * a capability the app does not have.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { normalizeSelection } = require('./knowledge-scope');

const FILE_NAME = 'agents.json';
const MAX_AGENTS = 50;
const MAX_NAME = 32;
const MAX_TEXT = {
  role: 2000,
  personality: 2000,
  inputSpec: 2000,
  outputSpec: 2000,
  prompt: 20000,
};
const MAX_BINDINGS = 100;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_MEMORY = {
  enabled: true,
  // Learned memories take effect without a per-entry review. The user can
  // still edit, reject or delete any of them in the memory panel.
  autoConfirm: true,
  allowWebRecheck: true,
};

/** Per-Agent learning switches; all optional so old files keep working. */
function normalizeMemory(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    enabled: raw.enabled === undefined ? DEFAULT_MEMORY.enabled : Boolean(raw.enabled),
    autoConfirm:
      raw.autoConfirm === undefined ? DEFAULT_MEMORY.autoConfirm : Boolean(raw.autoConfirm),
    allowWebRecheck:
      raw.allowWebRecheck === undefined
        ? DEFAULT_MEMORY.allowWebRecheck
        : Boolean(raw.allowWebRecheck),
  };
}

function filePath(agentDir) {
  return path.join(agentDir, FILE_NAME);
}

function newId() {
  return `agt_${crypto.randomUUID()}`;
}

function text(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

function uniqueStrings(value, limit) {
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

/**
 * Validate one definition.
 *
 * `builtinCategories` is the catalog the app actually ships; anything else in
 * a hand-edited file is dropped. Custom categories are stored by id and kept
 * even when the category is missing right now — the tool may just be loading.
 */
function normalizeAgent(input, options = {}) {
  const others = Array.isArray(options.others) ? options.others : [];
  const builtinCategories = new Set(
    (Array.isArray(options.builtinCategories) ? options.builtinCategories : []).map(String),
  );

  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['内容格式不对。'] };
  }

  const name = text(input.name, MAX_NAME);
  if (!name) return { ok: false, errors: ['名字不能为空。'] };
  if (others.some((item) => String(item.name ?? '').toLowerCase() === name.toLowerCase())) {
    return { ok: false, errors: [`已经有叫「${name}」的 Agent 了。`] };
  }

  const requestedId = String(input.id ?? '').trim();
  if (requestedId && !ID_RE.test(requestedId)) {
    return { ok: false, errors: ['Agent 的 id 不合法。'] };
  }
  const id = requestedId || newId();

  const mode = input.capabilities?.mode === 'selected' ? 'selected' : 'all';
  const builtin = uniqueStrings(input.capabilities?.builtin, MAX_BINDINGS).filter((item) =>
    builtinCategories.has(item),
  );
  const custom = uniqueStrings(input.capabilities?.custom, MAX_BINDINGS).filter((item) =>
    ID_RE.test(item),
  );

  return {
    ok: true,
    agent: {
      id,
      name,
      role: text(input.role, MAX_TEXT.role),
      personality: text(input.personality, MAX_TEXT.personality),
      inputSpec: text(input.inputSpec, MAX_TEXT.inputSpec),
      outputSpec: text(input.outputSpec, MAX_TEXT.outputSpec),
      prompt: text(input.prompt, MAX_TEXT.prompt),
      capabilities: { mode, builtin, custom },
      knowledge: normalizeSelection(input.knowledge),
      memory: normalizeMemory(input.memory),
      enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
      updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    },
  };
}

/** Read `<data root>/agent/agents.json`. Malformed entries are skipped. */
async function loadAgents(agentDir, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath(agentDir), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : [];
  const agents = [];
  for (const item of list) {
    const result = normalizeAgent(item, { ...options, others: agents });
    if (!result.ok) continue;
    agents.push(result.agent);
    if (agents.length >= MAX_AGENTS) break;
  }
  return agents;
}

async function saveAgents(agentDir, agents) {
  await fs.mkdir(agentDir, { recursive: true });
  const file = filePath(agentDir);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(agents ?? [], null, 2), 'utf8');
  await fs.rename(temp, file);
}

module.exports = {
  MAX_AGENTS,
  MAX_NAME,
  MAX_TEXT,
  DEFAULT_MEMORY,
  normalizeMemory,
  FILE_NAME,
  newId,
  normalizeAgent,
  loadAgents,
  saveAgents,
};
