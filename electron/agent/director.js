/**
 * 工作总监 · 本地状态
 *
 * The director never stores a copy of any conversation. What it keeps is what
 * it takes to be restartable and predictable:
 *
 *   enabled / mode / budgetTokens   the mandate the user granted
 *   spaces                          per-workspace opt-in: off / read / write
 *   presence                        the task the user is standing in right now
 *
 * Ownership rule: while the director is on, it owns every task by default. The
 * user taking a task is not a handoff to be clicked — it is presence: opening a
 * task means the human is steering it, leaving means it goes back to the
 * director. Presence expires, so a crashed or closed app does not leave a task
 * pinned to a human who is no longer there.
 *
 * Space rule: nothing is monitored until the user picks it. `off` is the
 * default and means invisible — no patrol, no inspection, no instructions.
 */

const path = require('node:path');
const fs = require('node:fs/promises');

const FILE = 'state.json';
const MODES = ['observe', 'suggest', 'run'];
const ACCESS = ['off', 'read', 'write'];
/** No heartbeat for this long and the task goes back to the director. */
const PRESENCE_TTL = 10 * 60 * 1000;
const DEFAULT_BUDGET = 120000;
const MAX_BUDGET = 50000000;
/** 同时执行的下发任务上限；总监派工时要看这个数字。 */
const DEFAULT_MAX_DISPATCH = 4;
const MAX_DISPATCH_LIMIT = 12;
/** 验收不通过时最多自动返工几轮；总监设置里可改。 */
const DEFAULT_REWORK_ROUNDS = 2;
const MAX_REWORK_ROUNDS = 5;
/** 一次分配最多拆成几个员工；比并发上限宽，排队执行。 */
const MAX_EMPLOYEES_PER_DISPATCH = 8;

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function id(value) {
  const key = text(value, 128);
  return key || '';
}

function defaults() {
  return {
    schema: 4,
    enabled: false,
    mode: 'suggest',
    /** Reserved: the budget gate is not built and is not shown in the UI. */
    budgetTokens: DEFAULT_BUDGET,
    /** 最多同时执行多少个总监下发的任务；标题右侧的配置改它。 */
    maxDispatch: DEFAULT_MAX_DISPATCH,
    /** 验收不通过时最多自动返工几轮；到上限就交回用户决定。 */
    reworkRounds: DEFAULT_REWORK_ROUNDS,
    /** 总监自己用的模型（providerId::model）；空 = 跟随全局默认对话模型。 */
    chatModel: '',
    spaces: {},
    presence: null,
    updatedAt: 0,
  };
}

function normalizePresence(value) {
  if (!value || typeof value !== 'object') return null;
  const sessionId = id(value.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    workspaceId: id(value.workspaceId),
    at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
  };
}

/** Coerce anything on disk into a state the rest of the app can trust. */
function normalize(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = defaults();
  out.enabled = Boolean(raw.enabled);
  out.mode = MODES.includes(raw.mode) ? raw.mode : 'suggest';

  const budget = Number(raw.budgetTokens);
  if (Number.isFinite(budget) && budget >= 0) {
    out.budgetTokens = Math.min(Math.round(budget), MAX_BUDGET);
  }

  const maxDispatch = Number(raw.maxDispatch);
  if (Number.isFinite(maxDispatch) && maxDispatch >= 1) {
    out.maxDispatch = Math.min(Math.round(maxDispatch), MAX_DISPATCH_LIMIT);
  }

  const reworkRounds = Number(raw.reworkRounds);
  if (Number.isFinite(reworkRounds) && reworkRounds >= 0) {
    out.reworkRounds = Math.min(Math.round(reworkRounds), MAX_REWORK_ROUNDS);
  }

  out.chatModel = text(raw.chatModel, 200);

  if (raw.spaces && typeof raw.spaces === 'object') {
    for (const [key, value] of Object.entries(raw.spaces)) {
      const spaceId = id(key);
      if (!spaceId) continue;
      // Older builds stored 'hidden' for "do not look"; the default is now
      // "off", so both map to the same thing.
      const access = value === 'hidden' ? 'off' : value;
      if (!ACCESS.includes(access)) continue;
      out.spaces[spaceId] = access;
    }
  }

  out.presence = normalizePresence(raw.presence);

  out.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0;
  return out;
}

function filePath(dir) {
  return path.join(dir, FILE);
}

async function load(dir) {
  let state;
  try {
    state = normalize(JSON.parse(await fs.readFile(filePath(dir), 'utf8')));
  } catch {
    return defaults();
  }
  // A task left open when the app died must not stay human-owned forever.
  if (state.presence && Date.now() - state.presence.at > PRESENCE_TTL) state.presence = null;
  return state;
}

async function save(dir, state) {
  await fs.mkdir(dir, { recursive: true });
  const file = filePath(dir);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(normalize(state), null, 2), 'utf8');
  await fs.rename(temp, file);
}

/**
 * Settings the user changes in the director panel. Turning the director off
 * moves ownership back to the human simply because `ownerOf` says so — there is
 * no per-task copy of the mandate to unwind.
 */
function update(current, patch = {}) {
  const state = normalize(current);
  const at = Date.now();

  if (patch.enabled !== undefined) state.enabled = Boolean(patch.enabled);
  if (patch.mode !== undefined && MODES.includes(patch.mode)) state.mode = patch.mode;

  if (patch.budgetTokens !== undefined) {
    const budget = Number(patch.budgetTokens);
    if (Number.isFinite(budget) && budget >= 0) {
      state.budgetTokens = Math.min(Math.round(budget), MAX_BUDGET);
    }
  }

  if (patch.maxDispatch !== undefined) {
    const maxDispatch = Number(patch.maxDispatch);
    if (Number.isFinite(maxDispatch) && maxDispatch >= 1) {
      state.maxDispatch = Math.min(Math.round(maxDispatch), MAX_DISPATCH_LIMIT);
    }
  }

  if (patch.reworkRounds !== undefined) {
    const reworkRounds = Number(patch.reworkRounds);
    if (Number.isFinite(reworkRounds) && reworkRounds >= 0) {
      state.reworkRounds = Math.min(Math.round(reworkRounds), MAX_REWORK_ROUNDS);
    }
  }

  if (patch.chatModel !== undefined) state.chatModel = text(patch.chatModel, 200);

  if (patch.spaces && typeof patch.spaces === 'object') {
    for (const [key, value] of Object.entries(patch.spaces)) {
      const spaceId = id(key);
      if (!spaceId) continue;
      const access = value === 'hidden' ? 'off' : value;
      if (!ACCESS.includes(access)) continue;
      state.spaces[spaceId] = access;
    }
  }

  state.updatedAt = at;
  return state;
}

/**
 * Where the user is standing. `changed` is false for a heartbeat — the caller
 * refreshes the in-memory timestamp but skips the disk write.
 */
function setPresence(current, input = {}) {
  const state = normalize(current);
  const at = Date.now();
  const sessionId = id(input.sessionId);
  const previous = state.presence;

  if (!sessionId) {
    if (!previous) return { state, changed: false };
    state.presence = null;
    state.updatedAt = at;
    return { state, changed: true };
  }

  const workspaceId = id(input.workspaceId) || previous?.workspaceId || '';
  if (previous && previous.sessionId === sessionId && previous.workspaceId === workspaceId) {
    state.presence = { sessionId, workspaceId, at };
    return { state, changed: false };
  }

  state.presence = { sessionId, workspaceId, at };
  state.updatedAt = at;
  return { state, changed: true };
}

/**
 * Who steers this task right now. The director owns everything by default; a
 * fresh presence entry for this task gives it to the human.
 */
function ownerOf(current, sessionId, now = Date.now()) {
  const state = normalize(current);
  if (!state.enabled) return 'human';
  const session = id(sessionId);
  const presence = state.presence;
  if (presence && presence.sessionId === session && now - presence.at < PRESENCE_TTL) {
    return 'human';
  }
  return 'director';
}

/** Space access. Nothing is monitored unless the user opted in. */
function accessFor(state, workspaceId) {
  const value = state.spaces[id(workspaceId)];
  return ACCESS.includes(value) ? value : 'off';
}

module.exports = {
  FILE,
  MODES,
  ACCESS,
  PRESENCE_TTL,
  DEFAULT_BUDGET,
  DEFAULT_MAX_DISPATCH,
  MAX_DISPATCH_LIMIT,
  MAX_EMPLOYEES_PER_DISPATCH,
  defaults,
  normalize,
  load,
  save,
  update,
  setPresence,
  ownerOf,
  accessFor,
};
