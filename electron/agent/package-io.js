/**
 * 能力分类包与 Agent 包。
 *
 * 一个能力分类就是一个完整的包：分类本身 + 分类下的全部自定义功能
 * （脚本随包走，不单独存）。一个 Agent 也是一个包：定义 + 能力范围 +
 * 它勾选的那些能力分类包 + 长期记忆。
 *
 * 刻意不打包的两样东西：
 *
 *   - 知识库。它是装机自己的共享资料，Agent 只存"能读哪些"的选择，押着别人的
 *     文档 id 走没有意义，所以包里不带、导入后清空。
 *   - 工具的权限策略矩阵。带过来的自动放行等于让一个外来文件替用户点"同意"，
 *     导入一律回到默认规则（写入类功能每次询问）。包本身也不带这段策略。
 *
 * 导入只新增，绝不覆盖：分类名、功能名、Agent 名撞了就加后缀，id 全部重新
 * 生成。同一个包连按两次导入，得到的是两份并列的东西，不会悄悄改掉已有的。
 */

const crypto = require('node:crypto');
const customTools = require('./custom-tools');
const agentsStore = require('./agents');
const memoryStore = require('./memory');
const uiText = require('../ui-text');

const CATEGORY_FORMAT = 'ezness.capability';
const AGENT_FORMAT = 'ezness.agent';
/** Bump when a field changes meaning; older readers refuse newer files. */
const PACKAGE_VERSION = 1;

/* ------------------------------------------------------------------
   Building
   ------------------------------------------------------------------ */

/** 导出时不带 id 和权限策略：这两样在导入端都会被重新决定。 */
function transportableTool(definition) {
  const rest = { ...definition };
  delete rest.id;
  delete rest.policy;
  return rest;
}

function capabilityPackage(category, definitions) {
  return {
    format: CATEGORY_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: Date.now(),
    // id 只用来在 Agent 包里把 agent.capabilities.custom 指回这一包；
    // 导入时仍然会换成新的 id。
    category: {
      id: category.id,
      name: category.name,
      pinned: Boolean(category.pinned),
    },
    tools: definitions
      .filter((definition) => definition.category === category.name)
      .map(transportableTool),
  };
}

function transportableAgent(agent) {
  const rest = { ...agent };
  // 知识库不进包，选择范围自然也不进。
  delete rest.knowledge;
  return rest;
}

function agentPackage({ agent, categories, definitions, entries }) {
  // 「全部能力」没有具体勾选项，就把全部分类都装进去，换台机器才用得上。
  const wanted =
    agent.capabilities.mode === 'all'
      ? categories
      : categories.filter((category) => agent.capabilities.custom.includes(category.id));

  return {
    format: AGENT_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: Date.now(),
    agent: transportableAgent(agent),
    capabilities: {
      mode: agent.capabilities.mode,
      builtin: [...agent.capabilities.builtin],
      categories: wanted.map((category) => capabilityPackage(category, definitions)),
    },
    memory: {
      entries: (Array.isArray(entries) ? entries : []).map((entry) => {
        const rest = { ...entry };
        delete rest.agentId;
        return rest;
      }),
    },
  };
}

/* ------------------------------------------------------------------
   Parsing
   ------------------------------------------------------------------ */

/** 接受已经 parse 过的对象，也接受文件里的原始字符串。 */
function parsePackage(raw, expectedFormat) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: uiText.t('main.package.badJson') };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: uiText.t('main.package.notPackage') };
  }
  if (data.format !== expectedFormat) {
    return {
      ok: false,
      error: uiText.t(
        expectedFormat === CATEGORY_FORMAT
          ? 'main.package.notCapabilityPackage'
          : 'main.package.notAgentPackage',
      ),
    };
  }
  const version = Number(data.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: uiText.t('main.package.noVersion') };
  }
  if (version > PACKAGE_VERSION) {
    return {
      ok: false,
      error: uiText.t('main.package.newerVersion', { version }),
    };
  }
  return { ok: true, data };
}

/* ------------------------------------------------------------------
   Naming
   ------------------------------------------------------------------ */

/**
 * 撞名就加序号：`PPT 2`、`make_slides_2`。base 会被截短，保证加上序号后
 * 仍然放得进 max；超出 1000 个同名没法区分时返回空串，由调用方报错。
 */
function uniqueName(base, taken, max, suffixOf) {
  const key = (value) => value.toLowerCase();
  if (!taken.has(key(base))) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = suffixOf(index);
    const head = base.slice(0, Math.max(1, max - suffix.length));
    const candidate = `${head}${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
  return '';
}

function uniqueCategoryName(base, taken) {
  return uniqueName(base, taken, customTools.MAX_CATEGORY_NAME, (index) => ` ${index}`);
}

function uniqueToolName(base, taken) {
  return uniqueName(base, taken, customTools.MAX_TOOL_NAME, (index) => `_${index}`);
}

function uniqueAgentName(base, taken) {
  return uniqueName(base, taken, agentsStore.MAX_NAME, (index) => ` ${index}`);
}

/* ------------------------------------------------------------------
   Applying a capability package
   ------------------------------------------------------------------ */

/**
 * 把一个分类包并进现有数据，返回新的分类表和功能表，不写盘。
 *
 * @param {object} pkg    parsePackage 之后的 data
 * @param {{categories: object[], definitions: object[], builtinNames: string[]}} state
 */
function applyCategoryPackage(pkg, state) {
  const source = pkg?.category && typeof pkg.category === 'object' ? pkg.category : {};
  const parsed = customTools.normalizeCategoryName(source.name);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (state.categories.length >= customTools.MAX_CATEGORIES) {
    return {
      ok: false,
      error: uiText.t('main.package.categoryLimit', { count: customTools.MAX_CATEGORIES }),
    };
  }

  const warnings = [];
  const takenNames = new Set(state.categories.map((category) => category.name.toLowerCase()));
  const name = uniqueCategoryName(parsed.name, takenNames);
  if (!name) return { ok: false, error: uiText.t('main.package.duplicateCategories') };
  if (name !== parsed.name) {
    warnings.push(uiText.t('main.package.categoryRenamed', { from: parsed.name, to: name }));
  }

  const category = { id: crypto.randomUUID(), name, pinned: false };
  const categories = [...state.categories, category];
  const definitions = [...state.definitions];
  const takenTools = new Set([
    ...state.builtinNames,
    ...definitions.map((definition) => definition.name),
  ]);

  const rawTools = Array.isArray(pkg.tools) ? pkg.tools : [];
  let imported = 0;
  let droppedPolicy = 0;

  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object') {
      warnings.push(uiText.t('main.package.badToolEntry'));
      continue;
    }
    if (definitions.length >= customTools.MAX_TOOLS) {
      warnings.push(uiText.t('main.package.toolLimit', { count: customTools.MAX_TOOLS }));
      break;
    }

    const label = String(raw.name ?? '').trim() || uiText.t('main.package.unnamedTool');
    const toolName = uniqueToolName(label, takenTools);
    if (!toolName) {
      warnings.push(uiText.t('main.package.duplicateToolName', { name: label }));
      continue;
    }

    // id 交给 normalizeDefinition 重新生成：即便对方用的是同一台机器，
    // 也不会顶掉已有的功能。
    const result = customTools.normalizeDefinition(
      { ...raw, id: '', name: toolName, category: name },
      { builtinNames: state.builtinNames, others: definitions },
    );
    if (!result.ok) {
      warnings.push(
        uiText.t('main.package.toolSkipped', {
          name: label,
          error: result.errors.join(uiText.getLanguage() === 'en' ? '; ' : '；'),
        }),
      );
      continue;
    }

    // 外来的包可能自带放行矩阵；一个文件不该替用户点「同意」，一律丢掉。
    if (result.definition.policy) {
      droppedPolicy += 1;
      delete result.definition.policy;
    }
    if (toolName !== label) {
      warnings.push(uiText.t('main.package.toolRenamed', { from: label, to: toolName }));
    }
    definitions.push(result.definition);
    takenTools.add(result.definition.name);
    imported += 1;
  }

  if (droppedPolicy > 0) {
    warnings.push(uiText.t('main.package.droppedPolicy', { count: droppedPolicy }));
  }

  return {
    ok: true,
    category,
    categories,
    definitions,
    imported,
    warnings,
  };
}

/* ------------------------------------------------------------------
   Applying an Agent package
   ------------------------------------------------------------------ */

/**
 * 导入一个 Agent 包：先把它带的能力分类逐个并进来，再把 Agent 的能力范围
 * 指向新分类，最后把长期记忆挂到新 Agent 名下。
 *
 * state.builtinCategories 用来过滤内置分类名（换版本后不认识的会被丢掉）。
 */
function applyAgentPackage(pkg, state) {
  if (state.agents.length >= agentsStore.MAX_AGENTS) {
    return {
      ok: false,
      error: uiText.t('main.package.agentLimit', { count: agentsStore.MAX_AGENTS }),
    };
  }

  const warnings = [];
  let categories = state.categories;
  let definitions = state.definitions;
  /** 包里的分类 id → 本机新分类的 id。 */
  const remap = new Map();

  const packs = Array.isArray(pkg.capabilities?.categories) ? pkg.capabilities.categories : [];
  for (const pack of packs) {
    const label = String(pack?.category?.name ?? '').trim() || uiText.t('main.package.unnamedCategory');
    const applied = applyCategoryPackage(pack, {
      categories,
      definitions,
      builtinNames: state.builtinNames,
    });
    if (!applied.ok) {
      warnings.push(uiText.t('main.package.categorySkipped', { name: label, error: applied.error }));
      continue;
    }
    const sourceId = String(pack?.category?.id ?? '');
    if (sourceId) remap.set(sourceId, applied.category.id);
    categories = applied.categories;
    definitions = applied.definitions;
    warnings.push(...applied.warnings);
  }

  const source = pkg.agent && typeof pkg.agent === 'object' ? pkg.agent : {};
  const requested = String(source.name ?? '').trim() || uiText.t('main.package.importedAgent');
  const takenAgents = new Set(state.agents.map((agent) => agent.name.toLowerCase()));
  const name = uniqueAgentName(requested, takenAgents);
  if (!name) return { ok: false, error: uiText.t('main.package.duplicateAgentName') };
  if (name !== requested) {
    warnings.push(uiText.t('main.package.agentRenamed', { from: requested, to: name }));
  }

  const wantedCustom = Array.isArray(source.capabilities?.custom)
    ? source.capabilities.custom.map(String)
    : [];
  const mappedCustom = [];
  for (const id of wantedCustom) {
    const next = remap.get(id);
    if (next && !mappedCustom.includes(next)) mappedCustom.push(next);
  }
  const lostCategories = wantedCustom.filter((id) => !remap.has(id)).length;

  const result = agentsStore.normalizeAgent(
    {
      ...source,
      // 不沿用 id：重复导入只会多出一个 Agent，不会改掉同 id 的那个。
      id: '',
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // 知识库不进包；别的机器上的文档 id 在本机根本不存在，留着只会误导。
      knowledge: { categoryIds: [], documentIds: [], excludeDocumentIds: [] },
      capabilities: {
        mode: source.capabilities?.mode === 'selected' ? 'selected' : 'all',
        builtin: source.capabilities?.builtin,
        custom: mappedCustom,
      },
    },
    { others: state.agents, builtinCategories: state.builtinCategories },
  );
  if (!result.ok) return { ok: false, error: result.errors.join('\n') };

  if (lostCategories > 0) {
    warnings.push(uiText.t('main.package.lostCategories', { count: lostCategories }));
  }
  warnings.push(uiText.t('main.package.kbScope'));

  const agent = result.agent;
  const entries = [];
  const seen = new Set();
  const rawEntries = Array.isArray(pkg.memory?.entries) ? pkg.memory.entries : [];
  for (const raw of rawEntries) {
    if (entries.length >= memoryStore.MAX_ENTRIES) {
      warnings.push(uiText.t('main.package.memoryLimit', { count: memoryStore.MAX_ENTRIES }));
      break;
    }
    const parsed = memoryStore.normalizeEntry(
      // 记忆挂到新 Agent 名下；来源标成「导入」，在记忆面板里一眼能看出来。
      { ...(raw && typeof raw === 'object' ? raw : {}), agentId: agent.id, origin: 'imported' },
      { agentId: agent.id },
    );
    if (!parsed.ok) continue;
    if (seen.has(parsed.entry.id)) continue;
    seen.add(parsed.entry.id);
    entries.push(parsed.entry);
  }

  return {
    ok: true,
    agent,
    agents: [...state.agents, agent],
    categories,
    definitions,
    memoryEntries: entries,
    warnings,
  };
}

module.exports = {
  CATEGORY_FORMAT,
  AGENT_FORMAT,
  PACKAGE_VERSION,
  capabilityPackage,
  agentPackage,
  parsePackage,
  applyCategoryPackage,
  applyAgentPackage,
};
