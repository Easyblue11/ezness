import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  AgentCapabilities,
  AgentRuntimeInfo,
  AgentToolCapability,
  CapabilityDecision,
  CapabilityMode,
  CategoryResult,
  ChatTarget,
  CustomToolDefinition,
  CustomToolParameter,
  CustomToolParamType,
  CustomToolRuntime,
  ToolCategory,
  ToolHealth,
  ToolHealthMap,
} from '../types';
import { CodeEditor } from './CodeEditor';
import { ConfirmDialog } from './ConfirmDialog';
import {
  ChevronDownIcon,
  CloseIcon,
  DownloadIcon,
  EditIcon,
  InfoIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SparkleIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';

/** Virtual sidebar entry; built-in tools are not stored as a category. */
const BUILTIN_CATEGORY = '__builtin';

const MODE_LABEL: Record<CapabilityMode, string> = {
  'read-only': '只读',
  plan: '计划',
  'workspace-write': '工作区写入',
  'danger-full-access': '完全访问',
};

const DECISION_LABEL: Record<CapabilityDecision, string> = {
  allow: '自动',
  ask: '询问',
  deny: '禁止',
};

const MODE_KEYS: CapabilityMode[] = [
  'read-only',
  'plan',
  'workspace-write',
  'danger-full-access',
];

const ALLOW_ALL: Record<CapabilityMode, CapabilityDecision> = {
  'read-only': 'allow',
  plan: 'allow',
  'workspace-write': 'allow',
  'danger-full-access': 'allow',
};

/** Old mutating tools ran automatically outside read-only/plan mode. */
const LEGACY_MUTATING_POLICY: Record<CapabilityMode, CapabilityDecision> = {
  'read-only': 'deny',
  plan: 'deny',
  'workspace-write': 'allow',
  'danger-full-access': 'allow',
};

/** New mutating tools ask before touching the workspace by default. */
const DEFAULT_MUTATING_POLICY: Record<CapabilityMode, CapabilityDecision> = {
  'read-only': 'deny',
  plan: 'deny',
  'workspace-write': 'ask',
  'danger-full-access': 'allow',
};

function initialPolicy(definition: CustomToolDefinition | null) {
  if (!definition) return DEFAULT_MUTATING_POLICY;
  if (definition.readOnly) return ALLOW_ALL;
  return definition.policy ?? LEGACY_MUTATING_POLICY;
}

const EMPTY_STATS = { calls: 0, errors: 0, denied: 0, interrupted: 0 };

/** A broken definition is not in the compiled registry, but it still shows up. */
function capabilityFromDefinition(definition: CustomToolDefinition): AgentToolCapability {
  return {
    name: definition.name,
    description: definition.description,
    category: definition.category,
    custom: true,
    readOnly: definition.readOnly,
    network: definition.network,
    interactive: false,
    parameters: definition.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      description: parameter.description,
      values: null,
    })),
    policy: initialPolicy(definition),
    policyNote: '这个功能当前有故障，不会交给模型调用。修复并测试通过后会自动恢复。',
    command: definition.command,
    runtime: definition.runtime,
    cwd: definition.cwd,
    timeoutMs: definition.timeoutMs,
    implementation: null,
    stats: { ...EMPTY_STATS },
  };
}

const RUNTIME_LABEL: Record<CustomToolRuntime, string> = {
  node: 'Node.js',
  python: 'Python 3',
  executable: '自定义命令',
};

/** Where the interpreter comes from — matters when the app moves to another PC. */
const RUNTIME_SOURCE_LABEL: Record<string, string> = {
  builtin: 'Ezness 内置',
  portable: '便携运行时',
  system: '系统安装',
};

/** Starting programs for new tools. Users can replace them entirely. */
const SCRIPT_TEMPLATES: Record<CustomToolRuntime, string> = {
  node: [
    '// 参数从 EZNESS_TOOL_ARGS 读取（JSON），也按声明顺序出现在 process.argv.slice(2)。',
    'const args = JSON.parse(process.env.EZNESS_TOOL_ARGS || "{}");',
    '',
    'console.log(`你好，${args.query ?? ""}`);',
  ].join('\n'),
  python: [
    '# 参数从 EZNESS_TOOL_ARGS 读取（JSON），也按声明顺序出现在 sys.argv[1:]。',
    'import json, os',
    '',
    'args = json.loads(os.environ.get("EZNESS_TOOL_ARGS") or "{}")',
    'print("你好，" + str(args.get("query", "")))',
  ].join('\n'),
  executable: '',
};

const RUNTIME_FALLBACK: AgentRuntimeInfo[] = (
  Object.keys(RUNTIME_LABEL) as CustomToolRuntime[]
).map((id) => ({
  id,
  label: RUNTIME_LABEL[id],
  available: id === 'node' || id === 'executable',
  version: '',
  detail: '',
  hint: '',
  source: id === 'node' ? 'builtin' : '',
}));

/**
 * AI能力：本地预置、可被模型调用的工具一览。
 *
 * One fixed row per function; clicking a row opens its details. Built-in tools
 * come from the live registry in the main process, custom tools from
 * `<data root>/agent/custom-tools.json`, and the 添加功能 dialog lets the user
 * register new local commands that the model can call.
 */
export function SensoryPage({
  aiTarget,
  active = true,
  onOpenToolEditor,
}: {
  aiTarget: ChatTarget | null;
  /** The view is visible again: pick up functions added in 功能编辑. */
  active?: boolean;
  onOpenToolEditor?: (category: { id: string; name: string }) => void;
}) {
  const [data, setData] = useState<AgentCapabilities | null>(null);
  const [definitions, setDefinitions] = useState<CustomToolDefinition[]>([]);
  const [categories, setCategories] = useState<ToolCategory[]>([]);
  const [health, setHealth] = useState<ToolHealthMap>({});
  const [selected, setSelected] = useState(BUILTIN_CATEGORY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  /** Tool id whose syntax/smoke test is running right now. */
  const [testingId, setTestingId] = useState('');
  /** Outcome of the last test click, shown above the list until replaced. */
  const [testNotice, setTestNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  /** Outcome of the last 分类包 export/import; 撞名提醒也走这里。 */
  const [pkgNotice, setPkgNotice] = useState<{
    kind: 'ok' | 'warn' | 'bad';
    text: string;
  } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{
    definition: CustomToolDefinition | null;
    defaultCategory?: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CustomToolDefinition | null>(null);
  /** Tool whose test arguments are being collected before running 测试. */
  const [testTarget, setTestTarget] = useState<CustomToolDefinition | null>(null);
  const [pendingCategoryDelete, setPendingCategoryDelete] = useState<ToolCategory | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ category: ToolCategory | null } | null>(
    null,
  );
  const [viewConfig, setViewConfig] = useState<AgentToolCapability | null>(null);
  const [search, setSearch] = useState('');
  /** Name of a row saved just now; scrolled into view once the list re-renders. */
  const focusName = useRef('');

  const load = useCallback(async () => {
    const api = window.ezness;
    if (!api?.agentCapabilities) throw new Error('工具能力只在桌面端可用。');
    const [capabilities, custom, categoryRows, healthRows] = await Promise.all([
      api.agentCapabilities(),
      api.agentCustomTools?.() ?? Promise.resolve<CustomToolDefinition[]>([]),
      api.agentCategories?.() ?? Promise.resolve<ToolCategory[]>([]),
      api.agentToolHealth?.() ?? Promise.resolve<ToolHealthMap>({}),
    ]);
    return {
      capabilities,
      custom: Array.isArray(custom) ? custom : [],
      categories: Array.isArray(categoryRows) ? categoryRows : [],
      health: healthRows && typeof healthRows === 'object' ? healthRows : {},
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await load();
        if (cancelled) return;
        setData(next.capabilities);
        setDefinitions(next.custom);
        setCategories(next.categories);
        setHealth(next.health);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    const next = await load();
    setData(next.capabilities);
    setDefinitions(next.custom);
    setCategories(next.categories);
    setHealth(next.health);
    setError('');
  }, [load]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  // Coming back from 功能编辑 must show what the agent just added or broke.
  const wasActive = useRef(active);
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (!returned) return;
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [active, refresh]);

  useEffect(() => {
    const name = focusName.current;
    if (!name || !data) return;
    const row = [...document.querySelectorAll('.cap-row')].find(
      (node) => node.querySelector('.cap-row__name')?.textContent === name,
    );
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    focusName.current = '';

    // Smooth scrolling is animation-driven; a throttled or occluded window can
    // drop the animation entirely. If the row is still off-screen after a
    // beat, jump there instead of leaving it hidden.
    const timer = window.setTimeout(() => {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        row.scrollIntoView({ block: 'nearest' });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [data]);

  const customByName = useMemo(
    () => new Map(definitions.map((definition) => [definition.name, definition])),
    [definitions],
  );

  const closeEditor = useCallback(() => setEditor(null), []);
  const closeConfig = useCallback(() => setViewConfig(null), []);

  /** Pinned categories sit first, directly under 内置能力. */
  const orderedCategories = useMemo(() => {
    const pinned = categories.filter((category) => category.pinned);
    const rest = categories.filter((category) => !category.pinned);
    return [...pinned, ...rest];
  }, [categories]);

  const currentCategory = useMemo(
    () =>
      selected === BUILTIN_CATEGORY
        ? null
        : categories.find((category) => category.id === selected) ?? null,
    [selected, categories],
  );

  const builtinTools = useMemo(
    () => (data?.tools ?? []).filter((tool) => !tool.custom),
    [data],
  );

  const toolsByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const definition of definitions) {
      counts.set(definition.category, (counts.get(definition.category) ?? 0) + 1);
    }
    return counts;
  }, [definitions]);

  /** Categories with at least one broken tool get a red marker in the rail. */
  const brokenByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const definition of definitions) {
      if (health[definition.id]?.status !== 'broken') continue;
      counts.set(definition.category, (counts.get(definition.category) ?? 0) + 1);
    }
    return counts;
  }, [definitions, health]);

  const brokenInCategory = currentCategory
    ? brokenByCategory.get(currentCategory.name) ?? 0
    : 0;

  const capabilityByName = useMemo(
    () => new Map((data?.tools ?? []).map((tool) => [tool.name, tool])),
    [data],
  );

  // A category deleted elsewhere must not leave the rail on a missing id.
  useEffect(() => {
    if (selected !== BUILTIN_CATEGORY && !categories.some((category) => category.id === selected)) {
      setSelected(BUILTIN_CATEGORY);
    }
  }, [categories, selected]);

  function selectCategory(id: string) {
    setSelected(id);
    setSearch('');
  }

  function openNewTool() {
    const fallback = currentCategory?.name ?? orderedCategories[0]?.name ?? '自定义';
    setEditor({ definition: null, defaultCategory: fallback });
  }

  function openAiTool() {
    if (!aiTarget || !currentCategory || !onOpenToolEditor) return;
    onOpenToolEditor({ id: currentCategory.id, name: currentCategory.name });
  }

  async function handleRetest(
    definition: CustomToolDefinition,
    args?: Record<string, unknown>,
  ) {
    const api = window.ezness;
    if (!api?.agentToolRetest || testingId) return;
    setTestingId(definition.id);
    setError('');
    setTestNotice(null);
    try {
      const result = await api.agentToolRetest({
        id: definition.id,
        ...(args ? { args } : {}),
      });
      if (!result.ok) {
        setError(result.error || '测试失败');
        return;
      }
      await refresh();
      if (result.passed) {
        const output = result.health?.stdout?.trim() ?? '';
        const installed = result.installed?.length
          ? `已自动安装依赖：${result.installed.join('、')}。`
          : '';
        setTestNotice({
          kind: 'ok',
          text: `${definition.name} 测试通过，功能已启用。${installed}${
            output ? `输出：${output.slice(0, 200)}` : ''
          }`,
        });
      } else {
        const message = result.health?.errors?.[0]?.message ?? '测试未通过';
        // The stored message already starts with 「测试未通过…」 for smoke-test
        // failures; avoid repeating it.
        setTestNotice({
          kind: 'bad',
          text: message.startsWith('测试')
            ? `${definition.name}：${message}`
            : `${definition.name} 测试未通过：${message}`,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId('');
    }
  }

  /** Tools with parameters ask for test values first; a blank run would only
   * prove that the script rejects empty input. */
  function beginRetest(definition: CustomToolDefinition) {
    if (testingId) return;
    if ((definition.parameters ?? []).length > 0) {
      setTestTarget(definition);
      return;
    }
    void handleRetest(definition);
  }

  function toggle(name: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleSaved(name: string) {
    setEditor(null);
    setSearch('');
    setOpen((prev) => new Set(prev).add(name));
    focusName.current = name;
    try {
      const next = await load();
      setData(next.capabilities);
      setDefinitions(next.custom);
      setCategories(next.categories);
      setHealth(next.health);
      const definition = next.custom.find((item) => item.name === name);
      const savedCategory = definition
        ? next.categories.find((item) => item.name === definition.category)
        : null;
      if (savedCategory) setSelected(savedCategory.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete() {
    const target = pendingDelete;
    const api = window.ezness;
    setPendingDelete(null);
    if (!target || !api?.agentCustomToolDelete) return;
    try {
      const result = await api.agentCustomToolDelete(target.id);
      if (!result.ok) {
        setError(result.error || '删除失败');
        return;
      }
      setDefinitions(result.definitions ?? []);
      setOpen((prev) => {
        const next = new Set(prev);
        next.delete(target.name);
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function togglePin(category: ToolCategory) {
    const api = window.ezness;
    if (!api?.agentCategorySave) return;
    try {
      const result = await api.agentCategorySave({ id: category.id, pinned: !category.pinned });
      if (!result.ok) {
        setError(result.error || '操作失败');
        return;
      }
      setCategories(result.categories ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCategoryExport(category: ToolCategory) {
    const api = window.ezness;
    if (!api?.agentCategoryExport) {
      setPkgNotice({ kind: 'bad', text: '下载只在桌面端可用。' });
      return;
    }
    setPkgNotice(null);
    try {
      const result = await api.agentCategoryExport(category.id);
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || '导出失败' });
        return;
      }
      const warnings = result.warnings ?? [];
      const summary = `已导出「${category.name}」：${result.tools ?? 0} 个功能。`;
      setPkgNotice({
        kind: warnings.length > 0 ? 'warn' : 'ok',
        text: warnings.length > 0 ? `${summary}\n${warnings.join('\n')}` : summary,
      });
    } catch (err) {
      setPkgNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCategoryImport() {
    const api = window.ezness;
    if (!api?.agentCategoryImport) {
      setPkgNotice({ kind: 'bad', text: '导入只在桌面端可用。' });
      return;
    }
    setPkgNotice(null);
    try {
      const result = await api.agentCategoryImport();
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || '导入失败' });
        return;
      }
      if (result.definitions) setDefinitions(result.definitions);
      if (result.categories) setCategories(result.categories);
      if (result.health) setHealth(result.health);
      if (result.category) {
        setSelected(result.category.id);
        setSearch('');
      }
      const warnings = result.warnings ?? [];
      const summary = `已导入「${result.category?.name ?? '分类'}」：${result.imported ?? 0} 个功能。`;
      setPkgNotice({
        kind: warnings.length > 0 ? 'warn' : 'ok',
        text: warnings.length > 0 ? `${summary}\n${warnings.join('\n')}` : summary,
      });
    } catch (err) {
      setPkgNotice({ kind: 'bad', text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleCategoryDelete() {
    const target = pendingCategoryDelete;
    const api = window.ezness;
    setPendingCategoryDelete(null);
    if (!target || !api?.agentCategoryDelete) return;
    try {
      const result = await api.agentCategoryDelete(target.id);
      if (!result.ok) {
        setError(result.error || '删除分类失败');
        return;
      }
      setCategories(result.categories ?? []);
      setDefinitions(result.definitions ?? []);
      if (selected === target.id) setSelected(BUILTIN_CATEGORY);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCategorySaved(result: { categories?: ToolCategory[]; definitions?: CustomToolDefinition[] }) {
    setCategoryDialog(null);
    if (result.categories) setCategories(result.categories);
    if (result.definitions) setDefinitions(result.definitions);
    setError('');
    try {
      // Capabilities carry the category shown on each row; reload them so a
      // rename is reflected immediately instead of after a manual refresh.
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const searching = search.trim().length > 0;

  /**
   * Tools of the selected category, before the search box narrows them down.
   * Broken tools are missing from the compiled registry, so they are rebuilt
   * from the saved definitions with zeroed counters and rendered in red.
   */
  const categoryTools = useMemo(() => {
    if (!data) return [];
    if (selected === BUILTIN_CATEGORY) return builtinTools;
    if (!currentCategory) return [];
    return definitions
      .filter((definition) => definition.category === currentCategory.name)
      .map(
        (definition) =>
          capabilityByName.get(definition.name) ?? capabilityFromDefinition(definition),
      );
  }, [data, builtinTools, currentCategory, selected, definitions, capabilityByName]);

  /** Usage counters follow the category so each user category is independent. */
  const categoryStats = useMemo(
    () =>
      categoryTools.reduce(
        (totals, tool) => ({
          calls: totals.calls + tool.stats.calls,
          errors: totals.errors + tool.stats.errors,
          denied: totals.denied + tool.stats.denied,
          interrupted: totals.interrupted + tool.stats.interrupted,
        }),
        { calls: 0, errors: 0, denied: 0, interrupted: 0 },
      ),
    [categoryTools],
  );

  /** Search only filters the selected category, matching the old page behavior. */
  const visibleTools = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return categoryTools;
    return categoryTools.filter((tool) =>
      [tool.name, tool.description, tool.category, ...tool.parameters.map((item) => item.name)]
        .join('\n')
        .toLowerCase()
        .includes(query),
    );
  }, [categoryTools, search]);

  const renderToolRow = (tool: AgentToolCapability) => {
    const definition = customByName.get(tool.name);
    return (
      <ToolRow
        key={tool.name}
        tool={tool}
        definition={definition}
        health={definition ? health[definition.id] : undefined}
        testing={definition ? testingId === definition.id : false}
        busy={Boolean(testingId)}
        expanded={open.has(tool.name)}
        onToggle={() => toggle(tool.name)}
        onEdit={() => {
          if (definition) setEditor({ definition });
        }}
        onDelete={() => {
          if (definition) setPendingDelete(definition);
        }}
        onRetest={() => {
          if (definition) beginRetest(definition);
        }}
        onViewConfig={() => setViewConfig(tool)}
      />
    );
  };

  return (
    <div className="sensory">
      <header className="sensory__head">
        <div className="sensory__title">
          AI能力
          <span>本地预置 · 模型可调用</span>
        </div>
        <div className="sensory__actions">
          <div className="cap-search">
            <SearchIcon size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setSearch('');
              }}
              placeholder="搜索功能"
              aria-label="搜索功能"
              spellCheck={false}
            />
            {search && (
              <button
                type="button"
                className="cap-search__clear"
                aria-label="清空搜索"
                onClick={() => setSearch('')}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
          <button
            className={`sensory__refresh btn btn--ghost ${refreshing ? 'is-spinning' : ''}`}
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing}
          >
            <RefreshIcon size={13} />
            刷新
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void handleCategoryImport()}
            title="导入一个能力分类包：分类和它下面的功能会一起加进来，撞名自动改名"
          >
            <UploadIcon size={13} />
            导入分类
          </button>
          <button
            className="btn btn--ghost"
            onClick={openAiTool}
            disabled={!aiTarget || !currentCategory || !onOpenToolEditor}
            title={
              !aiTarget
                ? '先在设置里选择一个聊天模型'
                : !currentCategory
                  ? '内置能力不能由 AI 修改，请先选择一个自建分类'
                  : `打开「功能编辑-${currentCategory.name}」工作空间，用对话新增或修复功能`
            }
          >
            <SparkleIcon size={13} />
            AI添加
          </button>
          <button className="btn btn--primary" onClick={openNewTool}>
            <PlusIcon size={14} />
            手动添加
          </button>
        </div>
      </header>

      <div className="sensory__body sensory__body--split">
        <aside className="cat-rail" aria-label="功能分类">
          <button
            type="button"
            className={`cat-item cat-item--builtin ${selected === BUILTIN_CATEGORY ? 'is-active' : ''}`}
            onClick={() => selectCategory(BUILTIN_CATEGORY)}
          >
            <SparkleIcon size={14} className="cat-item__icon" />
            <span className="cat-item__name" title="内置能力">
              内置能力
            </span>
            <span className="cat-item__count">{builtinTools.length}</span>
          </button>

          <div className="cat-rail__divider" role="separator" />

          <button
            type="button"
            className="cat-add"
            onClick={() => setCategoryDialog({ category: null })}
          >
            <PlusIcon size={13} />
            新增分类
          </button>

          <div className="cat-rail__list">
            {orderedCategories.map((category) => {
              const count = toolsByCategory.get(category.name) ?? 0;
              const broken = brokenByCategory.get(category.name) ?? 0;
              return (
                <div
                  key={category.id}
                  className={`cat-item cat-item--user ${selected === category.id ? 'is-active' : ''} ${
                    broken > 0 ? 'is-broken' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="cat-item__main"
                    onClick={() => selectCategory(category.id)}
                  >
                    {category.pinned && <PinIcon size={11} className="cat-item__pin" />}
                    <span className="cat-item__name" title={category.name}>
                      {category.name}
                    </span>
                    {broken > 0 && (
                      <span className="cat-item__broken" title={`${broken} 个功能有故障`}>
                        !{broken}
                      </span>
                    )}
                    <span className="cat-item__count">{count}</span>
                  </button>
                  <span className="cat-item__actions">
                    <button
                      type="button"
                      aria-label={category.pinned ? '取消置顶' : '置顶分类'}
                      title={category.pinned ? '取消置顶' : '置顶分类'}
                      className={category.pinned ? 'is-pinned' : ''}
                      onClick={() => void togglePin(category)}
                    >
                      <PinIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="重命名分类"
                      title="重命名分类"
                      onClick={() => setCategoryDialog({ category })}
                    >
                      <EditIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="导出分类"
                      title="导出这个分类（含全部功能脚本）"
                      onClick={() => void handleCategoryExport(category)}
                    >
                      <DownloadIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label="删除分类"
                      title="删除分类"
                      onClick={() => setPendingCategoryDelete(category)}
                    >
                      <TrashIcon size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
            {orderedCategories.length === 0 && <p className="cat-rail__empty">还没有分类</p>}
          </div>
        </aside>

        <div className="sensory__main">
          <section className="sensory__intro">
            <p>
              这些是通过工具协议交给模型的全部函数。点击任意一行展开详情；
              内置能力随应用发布，只能查看；自定义功能可以用 JavaScript、Python
              或任意本地命令实现，保存后从后续任务开始交给模型调用。
            </p>
            <div className="cap-flow">
              {['模型发起调用', '权限策略判定', '本地执行', '结果回传模型'].map((step, index) => (
                <span key={step} className="cap-flow__piece">
                  {index > 0 && <span className="cap-flow__arrow">→</span>}
                  <span className="cap-flow__step">{step}</span>
                </span>
              ))}
            </div>
          </section>

          {loading && <p className="sensory__empty">正在读取工具能力…</p>}
          {!loading && error && !data && <p className="sensory__empty">{error}</p>}

          {data && (
            <>
              <p className="sensory__meta" title="只统计当前分类下的功能">
                <span>本分类调用 <b>{categoryStats.calls}</b> 次</span>
                {categoryStats.errors > 0 && (
                  <span className="is-error">失败 <b>{categoryStats.errors}</b></span>
                )}
                {categoryStats.denied > 0 && <span>拒绝 <b>{categoryStats.denied}</b></span>}
                {categoryStats.interrupted > 0 && (
                  <span>中断 <b>{categoryStats.interrupted}</b></span>
                )}
              </p>

              {error && <p className="sensory__note-error">{error}</p>}
              {pkgNotice && (
                <p
                  className={
                    pkgNotice.kind === 'ok'
                      ? 'sensory__note-ok'
                      : pkgNotice.kind === 'warn'
                        ? 'sensory__note-warn'
                        : 'sensory__note-error'
                  }
                >
                  {pkgNotice.text}
                </p>
              )}
              {testNotice && (
                <p
                  className={
                    testNotice.kind === 'ok' ? 'sensory__note-ok' : 'sensory__note-error'
                  }
                >
                  {testNotice.text}
                </p>
              )}

              <section className="cap-section">
                <div className="cap-section__head">
                  <span className="cap-section__title">
                    {currentCategory?.name ?? '内置能力'}
                  </span>
                  <span className="cap-section__count">{visibleTools.length}</span>
                  {brokenInCategory > 0 && (
                    <span className="cap-section__broken">
                      故障 {brokenInCategory}
                    </span>
                  )}
                  <span className="cap-section__hint">
                    {currentCategory ? '你添加的本地脚本或命令' : 'Ezness 预置，随版本更新'}
                  </span>
                  {searching && (
                    <span className="cap-section__hint">搜索「{search.trim()}」</span>
                  )}
                </div>

                {visibleTools.length > 0 ? (
                  <div className="cap-list">{visibleTools.map(renderToolRow)}</div>
                ) : searching ? (
                  <p className="cap-section__empty">
                    这个分类里没有匹配「{search.trim()}」的功能。
                  </p>
                ) : currentCategory ? (
                  <p className="cap-section__empty">
                    「{currentCategory.name}」还没有功能。点右上角「手动添加」创建，或点「AI添加」
                    在功能编辑工作空间里用对话生成。
                  </p>
                ) : (
                  <p className="cap-section__empty">没有内置能力。</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {testTarget && (
        <TestArgsDialog
          definition={testTarget}
          initialArgs={health[testTarget.id]?.testArgs ?? {}}
          onCancel={() => setTestTarget(null)}
          onSubmit={(args) => {
            const target = testTarget;
            setTestTarget(null);
            void handleRetest(target, args);
          }}
        />
      )}

      {editor && (
        <CustomToolDialog
          definition={editor.definition}
          defaultCategory={editor.defaultCategory}
          categories={categories}
          onClose={closeEditor}
          onSaved={(name) => void handleSaved(name)}
        />
      )}

      {categoryDialog && (
        <CategoryDialog
          category={categoryDialog.category}
          onClose={() => setCategoryDialog(null)}
          onSaved={(result) => void handleCategorySaved(result)}
        />
      )}

      {viewConfig && <ToolConfigDialog tool={viewConfig} onClose={closeConfig} />}

      {pendingDelete && (
        <ConfirmDialog
          title="删除功能"
          message={`删除「${pendingDelete.name}」？模型之后将不能再调用它。`}
          confirmLabel="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingCategoryDelete && (
        <ConfirmDialog
          title="删除分类"
          message={
            (toolsByCategory.get(pendingCategoryDelete.name) ?? 0) > 0
              ? `删除分类「${pendingCategoryDelete.name}」？分类里的 ${
                  toolsByCategory.get(pendingCategoryDelete.name) ?? 0
                } 个功能也会一起删除，模型之后将不能再调用它们。`
              : `删除分类「${pendingCategoryDelete.name}」？`
          }
          confirmLabel="删除"
          danger
          onConfirm={() => void handleCategoryDelete()}
          onCancel={() => setPendingCategoryDelete(null)}
        />
      )}
    </div>
  );
}

interface ToolRowProps {
  tool: AgentToolCapability;
  definition?: CustomToolDefinition;
  health?: ToolHealth;
  testing: boolean;
  /** Any test is running — every 测试 button is locked until it ends. */
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRetest: () => void;
  onViewConfig: () => void;
}

function ToolRow({
  tool,
  definition,
  health,
  testing,
  busy,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onRetest,
  onViewConfig,
}: ToolRowProps) {
  const broken = health?.status === 'broken';

  return (
    <div className={`cap-row ${expanded ? 'is-open' : ''} ${broken ? 'is-broken' : ''}`}>
      <button className="cap-row__head" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDownIcon size={14} className="cap-row__chevron" />
        <code className="cap-row__name">{tool.name}</code>
        <span className="cap-row__cat">{tool.category}</span>
        {definition && (
          <span className="cap-row__runtime">{RUNTIME_LABEL[definition.runtime]}</span>
        )}
        <span className="cap-row__badges">
          {tool.readOnly && <span className="cap-badge cap-badge--read">只读</span>}
          {!tool.readOnly && !tool.network && !tool.interactive && (
            <span className="cap-badge cap-badge--write">变更</span>
          )}
          {tool.network && <span className="cap-badge cap-badge--net">联网</span>}
          {tool.interactive && <span className="cap-badge cap-badge--ask">交互</span>}
          {tool.custom && <span className="cap-badge cap-badge--custom">自定义</span>}
          {broken && <span className="cap-badge cap-badge--broken">故障</span>}
        </span>
        <span className="cap-row__spacer" />
        {tool.parameters.length > 0 && (
          <span className="cap-row__param-count">{tool.parameters.length} 个参数</span>
        )}
        <span className={`cap-row__calls ${tool.stats.calls === 0 ? 'is-empty' : ''}`}>
          {tool.stats.calls === 0 ? '未使用' : `${tool.stats.calls} 次`}
        </span>
      </button>

      {broken && (
        <p className="cap-row__error-line">{health?.errors?.[0]?.message ?? '测试未通过'}</p>
      )}

      {expanded && (
        <div className="cap-row__body">
          {broken && (
            <div className="cap-row__health">
              <div className="cap-row__health-title">故障详情</div>
              {(health?.errors?.length ?? 0) > 0 ? (
                <ul>
                  {health?.errors?.map((error, index) => (
                    <li key={`${error.phase}-${index}`}>
                      <span className="cap-row__health-phase">
                        {error.phase === 'syntax'
                          ? '语法错误'
                          : error.phase === 'schema'
                            ? '结构错误'
                            : error.phase === 'runtime'
                              ? '运行错误'
                              : '测试失败'}
                      </span>
                      <span>{error.message}</span>
                      {error.detail && error.detail !== error.message && (
                        <pre>{error.detail}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>没有记录到具体错误。</p>
              )}
              {health?.testedAt && (
                <p className="cap-row__health-meta">
                  测试时间：{new Date(health.testedAt).toLocaleString()}
                  {health.exitCode !== undefined && health.exitCode !== null
                    ? ` · 退出码 ${health.exitCode}`
                    : ''}
                </p>
              )}
            </div>
          )}

          {!broken && health?.status === 'ok' && health.testedAt && (
            <div className="cap-row__health cap-row__health--ok">
              <div className="cap-row__health-title">上次测试通过</div>
              <p className="cap-row__health-meta">
                {new Date(health.testedAt).toLocaleString()}
                {health.exitCode !== undefined && health.exitCode !== null
                  ? ` · 退出码 ${health.exitCode}`
                  : ''}
              </p>
              {health.stdout?.trim() && <pre>{health.stdout.trim().slice(0, 400)}</pre>}
            </div>
          )}

          {!broken && (!health || health.status === 'untested') && (
            <p className="cap-row__health-meta">
              保存时没有运行测试。点「测试」可以现在验证一次。
            </p>
          )}

          <div className="cap-row__block">
            <div className="cap-row__block-title">接口规范</div>
            <p className="cap-row__desc">{tool.description}</p>

            {tool.parameters.length > 0 && (
              <div>
                <div className="cap-row__label">参数</div>
                <ul className="cap-row__params">
                  {tool.parameters.map((parameter) => (
                    <li key={parameter.name}>
                      <code>{parameter.name}</code>
                      <span className="cap-row__type">
                        {parameter.type}
                        {parameter.required && <em>*</em>}
                      </span>
                      {parameter.values && (
                        <span className="cap-row__enum">{parameter.values.join(' / ')}</span>
                      )}
                      {parameter.description && (
                        <span className="cap-row__param-desc">{parameter.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="cap-row__block">
            <div className="cap-row__block-title">执行配置</div>
            {definition ? (
              <div className="cap-row__command">
                <code>
                  {definition.runtime === 'executable'
                    ? definition.command
                    : `${RUNTIME_LABEL[definition.runtime]} 脚本`}
                </code>
                <span className="cap-row__command-meta">
                  {definition.runtime === 'executable'
                    ? '参数替换命令里的 {参数名}，不经过 shell'
                    : '参数经 EZNESS_TOOL_ARGS（JSON）或按声明顺序作为命令行参数传入'}
                  {definition.cwd ? ` · 运行目录 ${definition.cwd}` : ''}
                  {definition.dependencies?.length
                    ? ` · 依赖 ${definition.dependencies.join('、')}`
                    : ''}
                  {` · 超时 ${Math.round(definition.timeoutMs / 1000)} 秒`}
                </span>
              </div>
            ) : tool.implementation ? (
              <div className="cap-row__command">
                <code>
                  {tool.implementation.file} · {tool.implementation.fn}()
                </code>
                <span className="cap-row__command-meta">{tool.implementation.process}</span>
                {tool.implementation.limits.length > 0 && (
                  <ul className="cap-row__limits">
                    {tool.implementation.limits.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="cap-row__note">由 Ezness 主进程直接执行。</p>
            )}
          </div>

          <div className="cap-row__block">
            <div className="cap-row__block-title">权限策略</div>
            <div className="cap-row__policy">
              {(['read-only', 'plan', 'workspace-write', 'danger-full-access'] as CapabilityMode[]).map(
                (mode) => {
                  const decision = tool.policy[mode];
                  return (
                    <span key={mode} className={`cap-pill cap-pill--${decision}`}>
                      <span>{MODE_LABEL[mode]}</span>
                      <b>{DECISION_LABEL[decision]}</b>
                    </span>
                  );
                },
              )}
            </div>
            <p className="cap-row__note">{tool.policyNote}</p>
          </div>

          <div className="cap-row__foot">
            <span className="cap-row__stats">
              {tool.stats.calls === 0 ? '还没有调用记录' : `调用 ${tool.stats.calls} 次`}
              {tool.stats.errors > 0 && (
                <>
                  {' · '}
                  <b>失败 {tool.stats.errors}</b>
                </>
              )}
              {tool.stats.denied > 0 && ` · 拒绝 ${tool.stats.denied}`}
              {tool.stats.interrupted > 0 && ` · 中断 ${tool.stats.interrupted}`}
            </span>
            <div className="cap-row__actions">
              {definition ? (
                <>
                  <button className="btn btn--ghost" onClick={onRetest} disabled={busy}>
                    <RefreshIcon size={13} className={testing ? 'is-spinning' : undefined} />
                    {testing ? '测试中…' : broken ? '重新测试' : '测试'}
                  </button>
                  <button className="btn btn--ghost" onClick={onEdit}>
                    <EditIcon size={13} />
                    编辑
                  </button>
                  <button className="btn btn--ghost" onClick={onDelete}>
                    <TrashIcon size={13} />
                    删除
                  </button>
                </>
              ) : (
                <button className="btn btn--ghost" onClick={onViewConfig}>
                  <InfoIcon size={13} />
                  查看配置
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Read-only configuration sheet for a built-in tool. It mirrors the add/edit
 * dialog so the two feel the same, but every field is read-only and there is
 * no save button: built-in implementations ship with the app.
 */
function ToolConfigDialog({ tool, onClose }: { tool: AgentToolCapability; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal__panel cap-dialog cap-config"
        role="dialog"
        aria-modal="true"
        aria-label={`${tool.name} 配置`}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">查看配置</h2>
          <p className="cap-dialog__sub">内置能力由 Ezness 提供，这里只能查看，不能修改。</p>
        </header>

        <div className="cap-dialog__body">
          <div className="field-grid">
            <label className="field">
              <span className="field__label">名称</span>
              <input className="input" value={tool.name} readOnly spellCheck={false} />
            </label>
            <label className="field">
              <span className="field__label">分类</span>
              <input className="input" value={tool.category} readOnly />
            </label>
          </div>

          <label className="field">
            <span className="field__label">说明</span>
            <textarea
              className="input cap-dialog__textarea"
              value={tool.description}
              readOnly
              rows={3}
            />
          </label>

          <div className="field">
            <span className="field__label">
              参数
              <span className="field__hint">模型调用时可以传的参数</span>
            </span>
            {tool.parameters.length === 0 ? (
              <p className="cap-config__empty">这个功能不需要参数。</p>
            ) : (
              <div className="cap-param-list">
                <div className="cap-param-head">
                  <span>名称</span>
                  <span>类型</span>
                  <span>必填</span>
                  <span>说明</span>
                  <span />
                </div>
                {tool.parameters.map((parameter) => (
                  <div className="cap-param-row" key={parameter.name}>
                    <input className="input" value={parameter.name} readOnly spellCheck={false} />
                    <input
                      className="input"
                      value={
                        parameter.values
                          ? `${parameter.type} · ${parameter.values.join(' / ')}`
                          : parameter.type
                      }
                      readOnly
                    />
                    <label className="cap-check">
                      <input type="checkbox" checked={parameter.required} disabled readOnly />
                      必填
                    </label>
                    <input className="input" value={parameter.description} readOnly />
                    <span />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cap-dialog__checks">
            <label className="cap-check">
              <input type="checkbox" checked={tool.readOnly} disabled readOnly />
              只读功能
            </label>
            <label className="cap-check">
              <input type="checkbox" checked={tool.network} disabled readOnly />
              需要联网
            </label>
            {tool.interactive && (
              <label className="cap-check">
                <input type="checkbox" checked disabled readOnly />
                交互功能（会向你提问）
              </label>
            )}
          </div>

          <div className="field">
            <span className="field__label">权限策略</span>
            <div className="cap-row__policy">
              {(['read-only', 'plan', 'workspace-write', 'danger-full-access'] as CapabilityMode[]).map(
                (mode) => {
                  const decision = tool.policy[mode];
                  return (
                    <span key={mode} className={`cap-pill cap-pill--${decision}`}>
                      <span>{MODE_LABEL[mode]}</span>
                      <b>{DECISION_LABEL[decision]}</b>
                    </span>
                  );
                },
              )}
            </div>
            <p className="cap-row__note">{tool.policyNote}</p>
          </div>

          <div className="field">
            <span className="field__label">执行配置</span>
            {tool.implementation ? (
              <div className="cap-config__impl">
                <div className="cap-config__impl-row">
                  <span>实现位置</span>
                  <code>{tool.implementation.file}</code>
                </div>
                <div className="cap-config__impl-row">
                  <span>执行函数</span>
                  <code>{tool.implementation.fn}()</code>
                </div>
                <div className="cap-config__impl-row">
                  <span>进程模型</span>
                  <span>{tool.implementation.process}</span>
                </div>
                <div className="cap-config__impl-row">
                  <span>固定参数</span>
                  <ul>
                    {tool.implementation.limits.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="cap-config__text">内置实现：由 Ezness 主进程直接执行。</p>
            )}
            <p className="cap-config__text">
              这些是模型调用时实际执行的进程和固定参数。内置能力随应用发布，不能在界面里修改。
            </p>
          </div>
        </div>

        <footer className="cap-dialog__actions">
          <button ref={closeRef} type="button" className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

const EMPTY_PARAMETER: CustomToolParameter = {
  name: '',
  type: 'string',
  required: false,
  description: '',
};

interface DialogProps {
  definition: CustomToolDefinition | null;
  defaultCategory?: string;
  categories: ToolCategory[];
  onClose: () => void;
  onSaved: (name: string) => void;
}

function CategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: ToolCategory | null;
  onClose: () => void;
  onSaved: (result: CategoryResult) => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const value = name.trim();
    if (!value) {
      setError('分类名称不能为空。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const api = window.ezness;
      if (!api?.agentCategorySave) throw new Error('保存接口不可用。');
      const result = await api.agentCategorySave(
        category ? { id: category.id, name: value } : { name: value },
      );
      if (!result.ok) {
        setError(result.error || '保存失败');
        return;
      }
      onSaved(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal__panel cap-dialog cap-category-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={category ? '重命名分类' : '新增分类'}
        onSubmit={handleSubmit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">{category ? '重命名分类' : '新增分类'}</h2>
          <p className="cap-dialog__sub">
            {category
              ? '改名后，分类里的功能会一起更新。'
              : '分类只用来整理功能，新建后可以在左侧置顶、重命名或删除。'}
          </p>
        </header>

        <div className="cap-dialog__body">
          <label className="field">
            <span className="field__label">分类名称</span>
            <input
              ref={inputRef}
              className="input cat-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：数据处理"
              maxLength={24}
              spellCheck={false}
            />
          </label>
          {error && <p className="cap-dialog__error">{error}</p>}
        </div>

        <footer className="cap-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? '保存中…' : category ? '保存' : '创建'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function CustomToolDialog({
  definition,
  defaultCategory,
  categories,
  onClose,
  onSaved,
}: DialogProps) {
  const seed = definition ?? null;
  const editing = Boolean(definition);
  const [name, setName] = useState(seed?.name ?? '');
  const [category, setCategory] = useState(
    seed?.category ?? defaultCategory ?? '自定义',
  );
  const [description, setDescription] = useState(seed?.description ?? '');
  const [runtime, setRuntime] = useState<CustomToolRuntime>(seed?.runtime ?? 'node');
  const [script, setScript] = useState(seed ? seed.script : SCRIPT_TEMPLATES.node);
  const [command, setCommand] = useState(seed?.command ?? '');
  const [runtimes, setRuntimes] = useState<AgentRuntimeInfo[]>([]);
  const [cwd, setCwd] = useState(seed?.cwd ?? '');
  const [timeoutMs, setTimeoutMs] = useState(String(seed?.timeoutMs ?? 120000));
  const [readOnly, setReadOnly] = useState(seed?.readOnly ?? false);
  const [policy, setPolicy] = useState<Record<CapabilityMode, CapabilityDecision>>(() =>
    initialPolicy(seed),
  );
  const [network, setNetwork] = useState(seed?.network ?? false);
  const [depsDraft, setDepsDraft] = useState((seed?.dependencies ?? []).join(', '));
  const [parameters, setParameters] = useState<CustomToolParameter[]>(
    seed?.parameters ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const runtimeInfo = runtimes.find((item) => item.id === runtime);
  const runtimeRows = runtimes.length > 0 ? runtimes : RUNTIME_FALLBACK;

  useEffect(() => {
    let alive = true;
    window.ezness
      ?.agentRuntimes?.()
      .then((rows) => {
        if (alive) setRuntimes(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        /* keep the static list; execution reports the real error */
      });
    return () => {
      alive = false;
    };
  }, []);

  function changeRuntime(next: CustomToolRuntime) {
    if (next === runtime) return;
    if (!script.trim() || script === SCRIPT_TEMPLATES[runtime]) {
      setScript(SCRIPT_TEMPLATES[next]);
    }
    setRuntime(next);
  }

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function changeReadOnly(next: boolean) {
    setReadOnly(next);
    if (next) {
      setPolicy({ ...ALLOW_ALL });
      return;
    }
    // Turning read-only off restores a sensible mutating matrix instead of
    // keeping the implicit "allow everything" the checkbox had forced.
    setPolicy((prev) =>
      MODE_KEYS.every((mode) => prev[mode] === 'allow')
        ? { ...DEFAULT_MUTATING_POLICY }
        : prev,
    );
  }

  function patchParameter(index: number, patch: Partial<CustomToolParameter>) {
    setParameters((prev) => prev.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      const api = window.ezness;
      if (!api?.agentCustomToolSave) throw new Error('保存接口不可用。');
      const result = await api.agentCustomToolSave({
        id: definition?.id ?? '',
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        runtime,
        script: runtime === 'executable' ? '' : script,
        command: runtime === 'executable' ? command.trim() : '',
        cwd: cwd.trim(),
        timeoutMs: Number(timeoutMs) || 120000,
        readOnly,
        network,
        dependencies:
          runtime === 'executable'
            ? []
            : depsDraft
                // `pandas>=2,<3` is one package; `requests, pandas` is two.
                .split(/[,，;；]\s*(?![<>=!~])/)
                .map((item) => item.trim())
                .filter(Boolean),
        ...(readOnly ? {} : { policy }),
        parameters: parameters.map((parameter) => ({
          name: parameter.name.trim(),
          type: parameter.type,
          required: parameter.required,
          description: parameter.description.trim(),
          // Authored by the agent or by hand in the JSON; the form keeps it
          // rather than dropping it on an unrelated edit.
          ...(parameter.default === undefined ? {} : { default: parameter.default }),
        })),
      });
      if (!result.ok) {
        setError(result.error || '保存失败');
        return;
      }
      onSaved(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal__panel cap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? '编辑功能' : '添加功能'}
        onSubmit={handleSubmit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">{editing ? '编辑功能' : '添加功能'}</h2>
          <p className="cap-dialog__sub">
            保存后模型就能在后续任务里调用它。可以选一种语言直接写脚本，也可以运行任意本地命令；
            脚本和命令都在独立进程里执行。
          </p>
        </header>

        <div className="cap-dialog__body">
          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">接口规范</div>

            <div className="field-grid">
              <label className="field">
                <span className="field__label">名称</span>
                <input
                  ref={firstRef}
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="my_tool"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span className="field__label">分类</span>
                <input
                  className="input cap-category-input"
                  list="tool-category-options"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  placeholder="自定义"
                  maxLength={24}
                />
                <datalist id="tool-category-options">
                  {categories.map((item) => (
                    <option key={item.id} value={item.name} />
                  ))}
                </datalist>
              </label>
            </div>

            <p className="field__hint">
              名称只能包含字母、数字和下划线，模型看到的就是这个名字。分类可以选已有的，也可以输入新名字，保存时会自动新建。
            </p>

            <label className="field">
              <span className="field__label">
                说明
                <span className="field__hint">模型据此判断什么时候调用</span>
              </span>
              <textarea
                className="input cap-dialog__textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="这个功能做什么、什么时候该用、返回什么。"
                rows={3}
              />
            </label>

            <div className="field">
              <span className="field__label">
                参数
                <span className="field__hint">
                  {runtime === 'executable'
                    ? '会替换命令里的 {参数名}'
                    : '按声明顺序作为命令行参数，也可从 EZNESS_TOOL_ARGS 读取'}
                </span>
              </span>
              {parameters.length > 0 && (
                <div className="cap-param-list">
                  <div className="cap-param-head">
                    <span>名称</span>
                    <span>类型</span>
                    <span>必填</span>
                    <span>说明</span>
                    <span />
                  </div>
                  {parameters.map((parameter, index) => (
                    <div className="cap-param-row" key={index}>
                      <input
                        className="input"
                        value={parameter.name}
                        onChange={(event) => patchParameter(index, { name: event.target.value })}
                        placeholder="参数名"
                        spellCheck={false}
                      />
                      <select
                        className="select"
                        value={
                          parameter.secret
                            ? parameter.secretKind === 'file'
                              ? 'secret-file'
                              : 'secret-text'
                            : parameter.type
                        }
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === 'secret-text' || value === 'secret-file') {
                            // The model never sees a secret parameter: it is
                            // collected from the user in the confirmation card.
                            patchParameter(index, {
                              type: 'string',
                              secret: true,
                              secretKind: value === 'secret-file' ? 'file' : 'text',
                            });
                            return;
                          }
                          patchParameter(index, {
                            type: value as CustomToolParamType,
                            secret: false,
                            secretKind: undefined,
                          });
                        }}
                      >
                        <option value="string">string</option>
                        <option value="number">number</option>
                        <option value="boolean">boolean</option>
                        <option value="secret-text">保密文本</option>
                        <option value="secret-file">保密文件</option>
                      </select>
                      <label className="cap-check">
                        <input
                          type="checkbox"
                          checked={parameter.required}
                          onChange={(event) =>
                            patchParameter(index, { required: event.target.checked })
                          }
                        />
                        必填
                      </label>
                      <input
                        className="input"
                        value={parameter.description}
                        onChange={(event) =>
                          patchParameter(index, { description: event.target.value })
                        }
                        placeholder={parameter.secret ? '说明（给用户看，填写在确认卡片里）' : '说明（给模型看）'}
                      />
                      <button
                        type="button"
                        className="cap-param-row__del"
                        title="删除参数"
                        onClick={() =>
                          setParameters((prev) => prev.filter((_item, at) => at !== index))
                        }
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn btn--ghost cap-param-add"
                onClick={() => setParameters((prev) => [...prev, { ...EMPTY_PARAMETER }])}
              >
                <PlusIcon size={13} />
                添加参数
              </button>
            </div>
          </div>

          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">执行配置</div>

            <label className="field">
              <span className="field__label">
                语言 / 运行时
                <span className="field__hint">脚本在独立子进程里运行，不会加载进 Ezness</span>
              </span>
              <select
                className="select"
                value={runtime}
                onChange={(event) => changeRuntime(event.target.value as CustomToolRuntime)}
              >
                {runtimeRows.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {item.version ? ` · ${item.version}` : ''}
                    {item.source === 'portable' ? '（便携）' : ''}
                    {!item.available ? '（未检测到）' : ''}
                  </option>
                ))}
              </select>
            </label>

            {runtimeInfo && (
              <p className={runtimeInfo.available ? 'field__hint' : 'cap-dialog__warn'}>
                {!runtimeInfo.available
                  ? runtimeInfo.hint
                  : runtime === 'executable'
                    ? runtimeInfo.hint
                    : [
                        RUNTIME_SOURCE_LABEL[runtimeInfo.source],
                        runtimeInfo.version,
                        runtimeInfo.detail,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
              </p>
            )}

            {runtime !== 'node' && runtime !== 'executable' && (
              <p className="field__hint">
                换电脑也能用：把便携版解释器放进数据目录的 runtimes/{runtime}/ 文件夹，Ezness
                会优先使用它。
              </p>
            )}

            {runtime !== 'executable' && (
              <label className="field">
                <span className="field__label">
                  依赖包
                  <span className="field__hint">保存测试时自动安装，不需要手动 pip / npm</span>
                </span>
                <input
                  className="input"
                  value={depsDraft}
                  onChange={(event) => setDepsDraft(event.target.value)}
                  placeholder={
                    runtime === 'python' ? 'requests, pandas==2.2.3' : 'axios, lodash'
                  }
                  spellCheck={false}
                />
              </label>
            )}

            {runtime === 'executable' ? (
              <>
                <label className="field">
                  <span className="field__label">
                    执行命令
                    <span className="field__hint">
                      例如 python "D:\tools\my_tool.py" --query {'{query}'}
                    </span>
                  </span>
                  <textarea
                    className="input cap-dialog__textarea"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder='python "D:\tools\my_tool.py" --query {query}'
                    rows={3}
                    spellCheck={false}
                  />
                </label>
                <p className="field__hint">
                  按空格拆成参数，不经过 shell，因此不支持管道和重定向；用 {'{参数名}'} 引用调用参数。
                </p>
              </>
            ) : (
              <>
                <label className="field">
                  <span className="field__label">
                    脚本内容
                    <span className="field__hint">stdout 会作为结果返回给模型</span>
                  </span>
                  <CodeEditor
                    value={script}
                    onChange={setScript}
                    language={runtime === 'python' ? 'python' : 'javascript'}
                    rows={12}
                    ariaLabel="脚本内容"
                  />
                </label>
                <p className="field__hint">
                  参数通过环境变量 EZNESS_TOOL_ARGS（JSON）传入，也按声明顺序作为命令行参数；
                  退出码 0 表示成功，stderr 会和 stdout 一起返回。
                </p>
              </>
            )}

            <div className="field-grid">
              <label className="field">
                <span className="field__label">
                  运行目录
                  <span className="field__hint">相对工作空间</span>
                </span>
                <input
                  className="input"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder=". （根目录）"
                />
              </label>
              <label className="field">
                <span className="field__label">超时（毫秒）</span>
                <input
                  className="input"
                  type="number"
                  min={1000}
                  max={300000}
                  step={1000}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">权限策略</div>

            <div className="cap-dialog__checks">
              <label className="cap-check">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(event) => changeReadOnly(event.target.checked)}
                />
                只读功能（不修改任何内容）
              </label>
              <label className="cap-check">
                <input
                  type="checkbox"
                  checked={network}
                  onChange={(event) => setNetwork(event.target.checked)}
                />
                需要联网（受「联网」开关控制）
              </label>
            </div>

            {!readOnly && (
              <div className="cap-policy-grid">
                {MODE_KEYS.map((mode) => (
                  <label className="cap-policy-row" key={mode}>
                    <span className="cap-policy-row__mode">{MODE_LABEL[mode]}</span>
                    <select
                      className="select cap-policy-select"
                      aria-label={`${MODE_LABEL[mode]}权限`}
                      value={policy[mode]}
                      onChange={(event) =>
                        setPolicy((prev) => ({
                          ...prev,
                          [mode]: event.target.value as CapabilityDecision,
                        }))
                      }
                    >
                      <option value="allow">自动执行</option>
                      <option value="ask">询问</option>
                      <option value="deny">禁止</option>
                    </select>
                  </label>
                ))}
              </div>
            )}

            <p className="cap-row__note">
              {readOnly
                ? '只读功能：四种权限模式下都自动执行。'
                : '变更功能：每个权限模式可以分别选择自动执行、询问或禁止。'}
              {network && ' 调用前需要打开本次对话的「联网」开关。'}
            </p>
          </div>

          {error && (
            <p className="cap-dialog__error" ref={errorRef}>
              {error}
            </p>
          )}
        </div>

        <footer className="cap-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * Collects the values the smoke test should run with. Only local: these never
 * reach the model, and the values are remembered in tool-health.json so the
 * next 测试 click can reuse them.
 */
function TestArgsDialog({
  definition,
  initialArgs,
  onCancel,
  onSubmit,
}: {
  definition: CustomToolDefinition;
  initialArgs: Record<string, unknown>;
  onCancel: () => void;
  onSubmit: (args: Record<string, unknown>) => void;
}) {
  const parameters = definition.parameters ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const parameter of parameters) {
      const initial = initialArgs[parameter.name];
      next[parameter.name] = initial === undefined || initial === null ? '' : String(initial);
    }
    return next;
  });
  const [error, setError] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const args: Record<string, unknown> = {};
    for (const parameter of parameters) {
      const raw = (values[parameter.name] ?? '').trim();
      if (parameter.type !== 'boolean' && parameter.required && raw === '') {
        setError(`请填写参数「${parameter.name}」。`);
        return;
      }
      if (parameter.type === 'number') {
        const number = Number(raw);
        args[parameter.name] = raw === '' || Number.isNaN(number) ? 0 : number;
      } else if (parameter.type === 'boolean') {
        args[parameter.name] = raw === 'true';
      } else {
        args[parameter.name] = raw;
      }
    }
    onSubmit(args);
  }

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="modal__panel cap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="测试参数"
        onSubmit={submit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">测试「{definition.name}」</h2>
          <p className="cap-dialog__sub">
            先填一组参数，本地真的运行一次脚本；这些参数不会发给模型。
            测试通过后功能才会启用，失败会标红并暂停使用。
          </p>
        </header>

        <div className="cap-dialog__body">
          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">测试参数</div>
            <div className="field-grid">
              {parameters.map((parameter) => (
                <label className="field" key={parameter.name}>
                  <span className="field__label">
                    {parameter.name}
                    <span className="field__hint">
                      {parameter.required ? '必填' : '可选'} · {parameter.type}
                    </span>
                  </span>
                  {parameter.type === 'boolean' ? (
                    <select
                      className="select"
                      value={values[parameter.name] === 'true' ? 'true' : 'false'}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [parameter.name]: event.target.value }))
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={parameter.type === 'number' ? 'number' : 'text'}
                      value={values[parameter.name] ?? ''}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [parameter.name]: event.target.value }))
                      }
                      spellCheck={false}
                    />
                  )}
                  {parameter.description && (
                    <span className="field__hint">{parameter.description}</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        </div>

        {error && <p className="cap-dialog__warn">{error}</p>}

        <footer className="cap-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn--primary">
            开始测试
          </button>
        </footer>
      </form>
    </div>
  );
}
