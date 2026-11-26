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
import { useI18n } from '../i18n';
import { categoryName } from '../lib/categoryName';
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

const MODE_LABEL_KEYS: Record<CapabilityMode, string> = {
  'read-only': 'ability.mode.readOnly',
  plan: 'ability.mode.plan',
  'workspace-write': 'ability.mode.workspaceWrite',
  'danger-full-access': 'ability.mode.fullAccess',
};

const DECISION_LABEL_KEYS: Record<CapabilityDecision, string> = {
  allow: 'ability.decision.allow',
  ask: 'ability.decision.ask',
  deny: 'ability.decision.deny',
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
function capabilityFromDefinition(
  definition: CustomToolDefinition,
  policyNote: string,
): AgentToolCapability {
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
    policyNote,
    command: definition.command,
    runtime: definition.runtime,
    cwd: definition.cwd,
    timeoutMs: definition.timeoutMs,
    implementation: null,
    stats: { ...EMPTY_STATS },
  };
}

const RUNTIME_LABEL_KEYS: Record<CustomToolRuntime, string> = {
  node: 'ability.runtime.node',
  python: 'ability.runtime.python',
  executable: 'ability.runtime.executable',
};

/** Where the interpreter comes from — matters when the app moves to another PC. */
const RUNTIME_SOURCE_LABEL_KEYS: Record<string, string> = {
  builtin: 'ability.runtimeSource.builtin',
  portable: 'ability.runtimeSource.portable',
  system: 'ability.runtimeSource.system',
};

/**
 * Starting programs for new tools. Users can replace them entirely, so the
 * comments and the greeting follow the interface language.
 */
function scriptTemplate(
  runtime: CustomToolRuntime,
  t: (key: string) => string,
): string {
  if (runtime === 'node') {
    return [
      t('ability.script.nodeComment'),
      'const args = JSON.parse(process.env.EZNESS_TOOL_ARGS || "{}");',
      '',
      t('ability.script.nodeHello'),
    ].join('\n');
  }
  if (runtime === 'python') {
    return [
      t('ability.script.pythonComment'),
      'import json, os',
      '',
      'args = json.loads(os.environ.get("EZNESS_TOOL_ARGS") or "{}")',
      t('ability.script.pythonHello'),
    ].join('\n');
  }
  return '';
}

const FLOW_STEP_KEYS = [
  'ability.flow.model',
  'ability.flow.policy',
  'ability.flow.local',
  'ability.flow.result',
] as const;

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
  const { t } = useI18n();
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
    if (!api?.agentCapabilities) throw new Error(t('ability.error.desktopOnly'));
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
    const fallback = currentCategory?.name ?? orderedCategories[0]?.name ?? t('ability.tool.defaultCategory');
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
        setError(result.error || t('ability.test.failed'));
        return;
      }
      await refresh();
      if (result.passed) {
        const output = result.health?.stdout?.trim() ?? '';
        const installed = result.installed?.length
          ? t('ability.test.installed', {
              list: result.installed.join(t('ability.separator')),
            })
          : '';
        setTestNotice({
          kind: 'ok',
          text: `${t('ability.test.passed', { name: definition.name })}${installed}${
            output
              ? t('ability.test.output', { output: output.slice(0, 200) })
              : ''
          }`,
        });
      } else {
        const message = result.health?.errors?.[0]?.message ?? t('ability.test.notPassed');
        // The stored message already starts with the "did not pass" wording for
        // smoke-test failures; avoid repeating it.
        setTestNotice({
          kind: 'bad',
          text: message.startsWith(t('ability.test.notPassed'))
            ? t('ability.test.failedWithName', { name: definition.name, message })
            : t('ability.test.notPassedWithName', { name: definition.name, message }),
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
        setError(result.error || t('ability.error.deleteFailed'));
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
        setError(result.error || t('ability.error.operationFailed'));
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
      setPkgNotice({ kind: 'bad', text: t('ability.export.desktopOnly') });
      return;
    }
    setPkgNotice(null);
    try {
      const result = await api.agentCategoryExport(category.id);
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || t('ability.export.failed') });
        return;
      }
      const warnings = result.warnings ?? [];
      const summary = t('ability.export.success', {
        name: category.name,
        count: result.tools ?? 0,
      });
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
      setPkgNotice({ kind: 'bad', text: t('ability.import.desktopOnly') });
      return;
    }
    setPkgNotice(null);
    try {
      const result = await api.agentCategoryImport();
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || t('ability.import.failed') });
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
      const summary = t('ability.import.success', {
        name: result.category?.name ?? t('ability.category.unnamed'),
        count: result.imported ?? 0,
      });
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
        setError(result.error || t('ability.error.deleteCategoryFailed'));
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
          capabilityByName.get(definition.name) ??
          capabilityFromDefinition(definition, t('ability.tool.brokenPolicyNote')),
      );
  }, [data, builtinTools, currentCategory, selected, definitions, capabilityByName, t]);

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
          {t('ability.page.title')}
          <span>{t('ability.page.subtitle')}</span>
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
              placeholder={t('ability.search.placeholder')}
              aria-label={t('ability.search.placeholder')}
              spellCheck={false}
            />
            {search && (
              <button
                type="button"
                className="cap-search__clear"
                aria-label={t('ability.search.clear')}
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
            {t('ability.action.refresh')}
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void handleCategoryImport()}
            title={t('ability.import.title')}
          >
            <UploadIcon size={13} />
            {t('ability.import.label')}
          </button>
          <button
            className="btn btn--ghost"
            onClick={openAiTool}
            disabled={!aiTarget || !currentCategory || !onOpenToolEditor}
            title={
              !aiTarget
                ? t('ability.aiTool.noModel')
                : !currentCategory
                  ? t('ability.aiTool.builtinLocked')
                  : t('ability.aiTool.open', { name: currentCategory.name })
            }
          >
            <SparkleIcon size={13} />
            {t('ability.action.aiAdd')}
          </button>
          <button className="btn btn--primary" onClick={openNewTool}>
            <PlusIcon size={14} />
            {t('ability.action.manualAdd')}
          </button>
        </div>
      </header>

      <div className="sensory__body sensory__body--split">
        <aside className="cat-rail" aria-label={t('ability.categories.aria')}>
          <button
            type="button"
            className={`cat-item cat-item--builtin ${selected === BUILTIN_CATEGORY ? 'is-active' : ''}`}
            onClick={() => selectCategory(BUILTIN_CATEGORY)}
          >
            <SparkleIcon size={14} className="cat-item__icon" />
            <span className="cat-item__name" title={t('ability.categories.builtin')}>
              {t('ability.categories.builtin')}
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
            {t('ability.categories.add')}
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
                    <span className="cat-item__name" title={categoryName(category.name, t)}>
                      {categoryName(category.name, t)}
                    </span>
                    {broken > 0 && (
                      <span
                        className="cat-item__broken"
                        title={t('ability.categories.broken', { count: broken })}
                      >
                        !{broken}
                      </span>
                    )}
                    <span className="cat-item__count">{count}</span>
                  </button>
                  <span className="cat-item__actions">
                    <button
                      type="button"
                      aria-label={
                        category.pinned ? t('ability.categories.unpin') : t('ability.categories.pin')
                      }
                      title={
                        category.pinned ? t('ability.categories.unpin') : t('ability.categories.pin')
                      }
                      className={category.pinned ? 'is-pinned' : ''}
                      onClick={() => void togglePin(category)}
                    >
                      <PinIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('ability.categories.rename')}
                      title={t('ability.categories.rename')}
                      onClick={() => setCategoryDialog({ category })}
                    >
                      <EditIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('ability.categories.exportAria')}
                      title={t('ability.categories.exportTitle')}
                      onClick={() => void handleCategoryExport(category)}
                    >
                      <DownloadIcon size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('ability.categories.delete')}
                      title={t('ability.categories.delete')}
                      onClick={() => setPendingCategoryDelete(category)}
                    >
                      <TrashIcon size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
            {orderedCategories.length === 0 && (
              <p className="cat-rail__empty">{t('ability.categories.empty')}</p>
            )}
          </div>
        </aside>

        <div className="sensory__main">
          <section className="sensory__intro">
            <p>{t('ability.intro')}</p>
            <div className="cap-flow">
              {FLOW_STEP_KEYS.map((stepKey, index) => (
                <span key={stepKey} className="cap-flow__piece">
                  {index > 0 && <span className="cap-flow__arrow">→</span>}
                  <span className="cap-flow__step">{t(stepKey)}</span>
                </span>
              ))}
            </div>
          </section>

          {loading && <p className="sensory__empty">{t('ability.loading')}</p>}
          {!loading && error && !data && <p className="sensory__empty">{error}</p>}

          {data && (
            <>
              <p className="sensory__meta" title={t('ability.stats.title')}>
                <span>
                  {t('ability.stats.callsBefore')}
                  <b>{categoryStats.calls}</b>
                  {t('ability.stats.callsAfter')}
                </span>
                {categoryStats.errors > 0 && (
                  <span className="is-error">
                    {t('ability.stats.errorsBefore')}
                    <b>{categoryStats.errors}</b>
                  </span>
                )}
                {categoryStats.denied > 0 && (
                  <span>
                    {t('ability.stats.deniedBefore')}
                    <b>{categoryStats.denied}</b>
                  </span>
                )}
                {categoryStats.interrupted > 0 && (
                  <span>
                    {t('ability.stats.interruptedBefore')}
                    <b>{categoryStats.interrupted}</b>
                  </span>
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
                    {currentCategory?.name ?? t('ability.categories.builtin')}
                  </span>
                  <span className="cap-section__count">{visibleTools.length}</span>
                  {brokenInCategory > 0 && (
                    <span className="cap-section__broken">
                      {t('ability.section.broken', { count: brokenInCategory })}
                    </span>
                  )}
                  <span className="cap-section__hint">
                    {currentCategory
                      ? t('ability.section.customHint')
                      : t('ability.section.builtinHint')}
                  </span>
                  {searching && (
                    <span className="cap-section__hint">
                      {t('ability.section.searching', { query: search.trim() })}
                    </span>
                  )}
                </div>

                {visibleTools.length > 0 ? (
                  <div className="cap-list">{visibleTools.map(renderToolRow)}</div>
                ) : searching ? (
                  <p className="cap-section__empty">
                    {t('ability.section.noMatch', { query: search.trim() })}
                  </p>
                ) : currentCategory ? (
                  <p className="cap-section__empty">
                    {t('ability.section.categoryEmpty', { name: currentCategory.name })}
                  </p>
                ) : (
                  <p className="cap-section__empty">{t('ability.section.builtinEmpty')}</p>
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
          title={t('ability.deleteTool.title')}
          message={t('ability.deleteTool.message', { name: pendingDelete.name })}
          confirmLabel={t('ability.action.delete')}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingCategoryDelete && (
        <ConfirmDialog
          title={t('ability.deleteCategory.title')}
          message={
            (toolsByCategory.get(pendingCategoryDelete.name) ?? 0) > 0
              ? t('ability.deleteCategory.withTools', {
                  name: pendingCategoryDelete.name,
                  count: toolsByCategory.get(pendingCategoryDelete.name) ?? 0,
                })
              : t('ability.deleteCategory.message', {
                  name: pendingCategoryDelete.name,
                })
          }
          confirmLabel={t('ability.action.delete')}
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
  const { t, locale } = useI18n();
  const broken = health?.status === 'broken';

  return (
    <div className={`cap-row ${expanded ? 'is-open' : ''} ${broken ? 'is-broken' : ''}`}>
      <button className="cap-row__head" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDownIcon size={14} className="cap-row__chevron" />
        <code className="cap-row__name">{tool.name}</code>
        <span className="cap-row__cat">{categoryName(tool.category, t)}</span>
        {definition && (
          <span className="cap-row__runtime">
            {t(RUNTIME_LABEL_KEYS[definition.runtime])}
          </span>
        )}
        <span className="cap-row__badges">
          {tool.readOnly && (
            <span className="cap-badge cap-badge--read">{t('ability.badge.readOnly')}</span>
          )}
          {!tool.readOnly && !tool.network && !tool.interactive && (
            <span className="cap-badge cap-badge--write">{t('ability.badge.mutating')}</span>
          )}
          {tool.network && (
            <span className="cap-badge cap-badge--net">{t('ability.badge.network')}</span>
          )}
          {tool.interactive && (
            <span className="cap-badge cap-badge--ask">{t('ability.badge.interactive')}</span>
          )}
          {tool.custom && (
            <span className="cap-badge cap-badge--custom">{t('ability.badge.custom')}</span>
          )}
          {broken && (
            <span className="cap-badge cap-badge--broken">{t('ability.badge.broken')}</span>
          )}
        </span>
        <span className="cap-row__spacer" />
        {tool.parameters.length > 0 && (
          <span className="cap-row__param-count">
            {t('ability.row.params', { count: tool.parameters.length })}
          </span>
        )}
        <span className={`cap-row__calls ${tool.stats.calls === 0 ? 'is-empty' : ''}`}>
          {tool.stats.calls === 0
            ? t('ability.row.unused')
            : t('ability.row.calls', { count: tool.stats.calls })}
        </span>
      </button>

      {broken && (
        <p className="cap-row__error-line">
          {health?.errors?.[0]?.message ?? t('ability.test.notPassed')}
        </p>
      )}

      {expanded && (
        <div className="cap-row__body">
          {broken && (
            <div className="cap-row__health">
              <div className="cap-row__health-title">{t('ability.health.title')}</div>
              {(health?.errors?.length ?? 0) > 0 ? (
                <ul>
                  {health?.errors?.map((error, index) => (
                    <li key={`${error.phase}-${index}`}>
                      <span className="cap-row__health-phase">
                        {error.phase === 'syntax'
                          ? t('ability.health.phase.syntax')
                          : error.phase === 'schema'
                            ? t('ability.health.phase.schema')
                            : error.phase === 'runtime'
                              ? t('ability.health.phase.runtime')
                              : t('ability.health.phase.failed')}
                      </span>
                      <span>{error.message}</span>
                      {error.detail && error.detail !== error.message && (
                        <pre>{error.detail}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('ability.health.noErrors')}</p>
              )}
              {health?.testedAt && (
                <p className="cap-row__health-meta">
                  {t('ability.health.testedAt', {
                    time: new Date(health.testedAt).toLocaleString(locale),
                  })}
                  {health.exitCode !== undefined && health.exitCode !== null
                    ? ` · ${t('ability.health.exitCode', { code: health.exitCode })}`
                    : ''}
                </p>
              )}
            </div>
          )}

          {!broken && health?.status === 'ok' && health.testedAt && (
            <div className="cap-row__health cap-row__health--ok">
              <div className="cap-row__health-title">{t('ability.health.lastPassed')}</div>
              <p className="cap-row__health-meta">
                {new Date(health.testedAt).toLocaleString(locale)}
                {health.exitCode !== undefined && health.exitCode !== null
                  ? ` · ${t('ability.health.exitCode', { code: health.exitCode })}`
                  : ''}
              </p>
              {health.stdout?.trim() && <pre>{health.stdout.trim().slice(0, 400)}</pre>}
            </div>
          )}

          {!broken && (!health || health.status === 'untested') && (
            <p className="cap-row__health-meta">{t('ability.health.untested')}</p>
          )}

          <div className="cap-row__block">
            <div className="cap-row__block-title">{t('ability.section.interface')}</div>
            <p className="cap-row__desc">{tool.description}</p>

            {tool.parameters.length > 0 && (
              <div>
                <div className="cap-row__label">{t('ability.field.params')}</div>
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
            <div className="cap-row__block-title">{t('ability.section.execution')}</div>
            {definition ? (
              <div className="cap-row__command">
                <code>
                  {definition.runtime === 'executable'
                    ? definition.command
                    : t('ability.row.scriptOf', {
                        runtime: t(RUNTIME_LABEL_KEYS[definition.runtime]),
                      })}
                </code>
                <span className="cap-row__command-meta">
                  {definition.runtime === 'executable'
                    ? t('ability.command.executableMeta')
                    : t('ability.command.scriptMeta')}
                  {definition.cwd
                    ? ` · ${t('ability.command.cwd', { path: definition.cwd })}`
                    : ''}
                  {definition.dependencies?.length
                    ? ` · ${t('ability.command.deps', {
                        list: definition.dependencies.join(t('ability.separator')),
                      })}`
                    : ''}
                  {` · ${t('ability.command.timeout', {
                    seconds: Math.round(definition.timeoutMs / 1000),
                  })}`}
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
              <p className="cap-row__note">{t('ability.row.builtinExec')}</p>
            )}
          </div>

          <div className="cap-row__block">
            <div className="cap-row__block-title">{t('ability.section.policy')}</div>
            <div className="cap-row__policy">
              {(['read-only', 'plan', 'workspace-write', 'danger-full-access'] as CapabilityMode[]).map(
                (mode) => {
                  const decision = tool.policy[mode];
                  return (
                    <span key={mode} className={`cap-pill cap-pill--${decision}`}>
                      <span>{t(MODE_LABEL_KEYS[mode])}</span>
                      <b>{t(DECISION_LABEL_KEYS[decision])}</b>
                    </span>
                  );
                },
              )}
            </div>
            <p className="cap-row__note">{tool.policyNote}</p>
          </div>

          <div className="cap-row__foot">
            <span className="cap-row__stats">
              {tool.stats.calls === 0
                ? t('ability.row.noCalls')
                : t('ability.row.callsCount', { count: tool.stats.calls })}
              {tool.stats.errors > 0 && (
                <>
                  {' · '}
                  <b>{t('ability.row.errors', { count: tool.stats.errors })}</b>
                </>
              )}
              {tool.stats.denied > 0 &&
                ` · ${t('ability.row.denied', { count: tool.stats.denied })}`}
              {tool.stats.interrupted > 0 &&
                ` · ${t('ability.row.interrupted', { count: tool.stats.interrupted })}`}
            </span>
            <div className="cap-row__actions">
              {definition ? (
                <>
                  <button className="btn btn--ghost" onClick={onRetest} disabled={busy}>
                    <RefreshIcon size={13} className={testing ? 'is-spinning' : undefined} />
                    {testing
                      ? t('ability.test.testing')
                      : broken
                        ? t('ability.test.retest')
                        : t('ability.test.test')}
                  </button>
                  <button className="btn btn--ghost" onClick={onEdit}>
                    <EditIcon size={13} />
                    {t('ability.action.edit')}
                  </button>
                  <button className="btn btn--ghost" onClick={onDelete}>
                    <TrashIcon size={13} />
                    {t('ability.action.delete')}
                  </button>
                </>
              ) : (
                <button className="btn btn--ghost" onClick={onViewConfig}>
                  <InfoIcon size={13} />
                  {t('ability.action.viewConfig')}
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
  const { t } = useI18n();
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
        aria-label={t('ability.config.aria', { name: tool.name })}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">{t('ability.action.viewConfig')}</h2>
          <p className="cap-dialog__sub">{t('ability.config.subtitle')}</p>
        </header>

        <div className="cap-dialog__body">
          <div className="field-grid">
            <label className="field">
              <span className="field__label">{t('ability.field.name')}</span>
              <input className="input" value={tool.name} readOnly spellCheck={false} />
            </label>
            <label className="field">
              <span className="field__label">{t('ability.field.category')}</span>
              <input className="input" value={tool.category} readOnly />
            </label>
          </div>

          <label className="field">
            <span className="field__label">{t('ability.field.description')}</span>
            <textarea
              className="input cap-dialog__textarea"
              value={tool.description}
              readOnly
              rows={3}
            />
          </label>

          <div className="field">
            <span className="field__label">
              {t('ability.field.params')}
              <span className="field__hint">{t('ability.field.paramsHint')}</span>
            </span>
            {tool.parameters.length === 0 ? (
              <p className="cap-config__empty">{t('ability.config.noParams')}</p>
            ) : (
              <div className="cap-param-list">
                <div className="cap-param-head">
                  <span>{t('ability.field.name')}</span>
                  <span>{t('ability.field.type')}</span>
                  <span>{t('ability.field.required')}</span>
                  <span>{t('ability.field.description')}</span>
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
                      {t('ability.field.required')}
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
              {t('ability.field.readOnly')}
            </label>
            <label className="cap-check">
              <input type="checkbox" checked={tool.network} disabled readOnly />
              {t('ability.field.network')}
            </label>
            {tool.interactive && (
              <label className="cap-check">
                <input type="checkbox" checked disabled readOnly />
                {t('ability.field.interactive')}
              </label>
            )}
          </div>

          <div className="field">
            <span className="field__label">{t('ability.section.policy')}</span>
            <div className="cap-row__policy">
              {(['read-only', 'plan', 'workspace-write', 'danger-full-access'] as CapabilityMode[]).map(
                (mode) => {
                  const decision = tool.policy[mode];
                  return (
                    <span key={mode} className={`cap-pill cap-pill--${decision}`}>
                      <span>{t(MODE_LABEL_KEYS[mode])}</span>
                      <b>{t(DECISION_LABEL_KEYS[decision])}</b>
                    </span>
                  );
                },
              )}
            </div>
            <p className="cap-row__note">{tool.policyNote}</p>
          </div>

          <div className="field">
            <span className="field__label">{t('ability.section.execution')}</span>
            {tool.implementation ? (
              <div className="cap-config__impl">
                <div className="cap-config__impl-row">
                  <span>{t('ability.config.implFile')}</span>
                  <code>{tool.implementation.file}</code>
                </div>
                <div className="cap-config__impl-row">
                  <span>{t('ability.config.implFn')}</span>
                  <code>{tool.implementation.fn}()</code>
                </div>
                <div className="cap-config__impl-row">
                  <span>{t('ability.config.implProcess')}</span>
                  <span>{tool.implementation.process}</span>
                </div>
                <div className="cap-config__impl-row">
                  <span>{t('ability.config.limits')}</span>
                  <ul>
                    {tool.implementation.limits.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="cap-config__text">{t('ability.config.builtinImpl')}</p>
            )}
            <p className="cap-config__text">{t('ability.config.notes')}</p>
          </div>
        </div>

        <footer className="cap-dialog__actions">
          <button ref={closeRef} type="button" className="btn btn--primary" onClick={onClose}>
            {t('ability.action.close')}
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
  const { t } = useI18n();
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
      setError(t('ability.category.nameRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const api = window.ezness;
      if (!api?.agentCategorySave) throw new Error(t('ability.error.saveUnavailable'));
      const result = await api.agentCategorySave(
        category ? { id: category.id, name: value } : { name: value },
      );
      if (!result.ok) {
        setError(result.error || t('ability.error.saveFailed'));
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
        aria-label={category ? t('ability.categories.rename') : t('ability.categories.add')}
        onSubmit={handleSubmit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">
            {category ? t('ability.categories.rename') : t('ability.categories.add')}
          </h2>
          <p className="cap-dialog__sub">
            {category ? t('ability.category.renameSub') : t('ability.category.addSub')}
          </p>
        </header>

        <div className="cap-dialog__body">
          <label className="field">
            <span className="field__label">{t('ability.field.categoryName')}</span>
            <input
              ref={inputRef}
              className="input cat-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('ability.category.namePlaceholder')}
              maxLength={24}
              spellCheck={false}
            />
          </label>
          {error && <p className="cap-dialog__error">{error}</p>}
        </div>

        <footer className="cap-dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('ability.action.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving
              ? t('ability.action.saving')
              : category
                ? t('ability.action.save')
                : t('ability.action.create')}
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
  const { t } = useI18n();
  const seed = definition ?? null;
  const editing = Boolean(definition);
  const [name, setName] = useState(seed?.name ?? '');
  const [category, setCategory] = useState(
    seed?.category ?? defaultCategory ?? t('ability.tool.defaultCategory'),
  );
  const [description, setDescription] = useState(seed?.description ?? '');
  const [runtime, setRuntime] = useState<CustomToolRuntime>(seed?.runtime ?? 'node');
  const [script, setScript] = useState(
    seed ? seed.script : scriptTemplate('node', t),
  );
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
  const runtimeRows = useMemo(
    () =>
      runtimes.length > 0
        ? runtimes
        : (Object.keys(RUNTIME_LABEL_KEYS) as CustomToolRuntime[]).map((id) => ({
            id,
            label: t(RUNTIME_LABEL_KEYS[id]),
            available: id === 'node' || id === 'executable',
            version: '',
            detail: '',
            hint: '',
            source: id === 'node' ? 'builtin' : '',
          })),
    [runtimes, t],
  );

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
    // An untouched starter program is swapped for the other language's starter;
    // anything the user wrote is left alone.
    if (!script.trim() || script === scriptTemplate(runtime, t)) {
      setScript(scriptTemplate(next, t));
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
      if (!api?.agentCustomToolSave) throw new Error(t('ability.error.saveUnavailable'));
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
        setError(result.error || t('ability.error.saveFailed'));
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
        aria-label={editing ? t('ability.tool.editTitle') : t('ability.tool.addTitle')}
        onSubmit={handleSubmit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">
            {editing ? t('ability.tool.editTitle') : t('ability.tool.addTitle')}
          </h2>
          <p className="cap-dialog__sub">{t('ability.tool.subtitle')}</p>
        </header>

        <div className="cap-dialog__body">
          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">{t('ability.section.interface')}</div>

            <div className="field-grid">
              <label className="field">
                <span className="field__label">{t('ability.field.name')}</span>
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
                <span className="field__label">{t('ability.field.category')}</span>
                <input
                  className="input cap-category-input"
                  list="tool-category-options"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  placeholder={t('ability.tool.defaultCategory')}
                  maxLength={24}
                />
                <datalist id="tool-category-options">
                  {categories.map((item) => (
                    <option key={item.id} value={item.name} />
                  ))}
                </datalist>
              </label>
            </div>

            <p className="field__hint">{t('ability.tool.nameHint')}</p>

            <label className="field">
              <span className="field__label">
                {t('ability.field.description')}
                <span className="field__hint">{t('ability.tool.descriptionHint')}</span>
              </span>
              <textarea
                className="input cap-dialog__textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('ability.tool.descriptionPlaceholder')}
                rows={3}
              />
            </label>

            <div className="field">
              <span className="field__label">
                {t('ability.field.params')}
                <span className="field__hint">
                  {runtime === 'executable'
                    ? t('ability.tool.executableParamsHint')
                    : t('ability.tool.scriptParamsHint')}
                </span>
              </span>
              {parameters.length > 0 && (
                <div className="cap-param-list">
                  <div className="cap-param-head">
                    <span>{t('ability.field.name')}</span>
                    <span>{t('ability.field.type')}</span>
                    <span>{t('ability.field.required')}</span>
                    <span>{t('ability.field.description')}</span>
                    <span />
                  </div>
                  {parameters.map((parameter, index) => (
                    <div className="cap-param-row" key={index}>
                      <input
                        className="input"
                        value={parameter.name}
                        onChange={(event) => patchParameter(index, { name: event.target.value })}
                        placeholder={t('ability.field.paramName')}
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
                        <option value="secret-text">{t('ability.option.secretText')}</option>
                        <option value="secret-file">{t('ability.option.secretFile')}</option>
                      </select>
                      <label className="cap-check">
                        <input
                          type="checkbox"
                          checked={parameter.required}
                          onChange={(event) =>
                            patchParameter(index, { required: event.target.checked })
                          }
                        />
                        {t('ability.field.required')}
                      </label>
                      <input
                        className="input"
                        value={parameter.description}
                        onChange={(event) =>
                          patchParameter(index, { description: event.target.value })
                        }
                        placeholder={
                          parameter.secret
                            ? t('ability.field.secretDesc')
                            : t('ability.field.paramDesc')
                        }
                      />
                      <button
                        type="button"
                        className="cap-param-row__del"
                        title={t('ability.field.removeParam')}
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
                {t('ability.action.addParam')}
              </button>
            </div>
          </div>

          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">{t('ability.section.execution')}</div>

            <label className="field">
              <span className="field__label">
                {t('ability.field.runtime')}
                <span className="field__hint">{t('ability.field.runtimeHint')}</span>
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
                    {item.source === 'portable' ? t('ability.runtime.portableSuffix') : ''}
                    {!item.available ? t('ability.runtime.missingSuffix') : ''}
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
                        t(RUNTIME_SOURCE_LABEL_KEYS[runtimeInfo.source]),
                        runtimeInfo.version,
                        runtimeInfo.detail,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
              </p>
            )}

            {runtime !== 'node' && runtime !== 'executable' && (
              <p className="field__hint">
                {t('ability.runtime.portableHint', { runtime })}
              </p>
            )}

            {runtime !== 'executable' && (
              <label className="field">
                <span className="field__label">
                  {t('ability.field.dependencies')}
                  <span className="field__hint">{t('ability.field.depsHint')}</span>
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
                    {t('ability.field.command')}
                    <span className="field__hint">
                      {t('ability.field.commandSample')} python "D:\tools\my_tool.py" --query {'{query}'}
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
                <p className="field__hint">{t('ability.field.commandHint')}</p>
              </>
            ) : (
              <>
                <label className="field">
                  <span className="field__label">
                    {t('ability.field.script')}
                    <span className="field__hint">{t('ability.field.scriptHint')}</span>
                  </span>
                  <CodeEditor
                    value={script}
                    onChange={setScript}
                    language={runtime === 'python' ? 'python' : 'javascript'}
                    rows={12}
                    ariaLabel={t('ability.field.script')}
                  />
                </label>
                <p className="field__hint">{t('ability.field.scriptNote')}</p>
              </>
            )}

            <div className="field-grid">
              <label className="field">
                <span className="field__label">
                  {t('ability.field.cwd')}
                  <span className="field__hint">{t('ability.field.cwdHint')}</span>
                </span>
                <input
                  className="input"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  placeholder={t('ability.field.cwdPlaceholder')}
                />
              </label>
              <label className="field">
                <span className="field__label">{t('ability.field.timeout')}</span>
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
            <div className="cap-dialog__section-title">{t('ability.section.policy')}</div>

            <div className="cap-dialog__checks">
              <label className="cap-check">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(event) => changeReadOnly(event.target.checked)}
                />
                {t('ability.field.readOnlyHint')}
              </label>
              <label className="cap-check">
                <input
                  type="checkbox"
                  checked={network}
                  onChange={(event) => setNetwork(event.target.checked)}
                />
                {t('ability.field.networkHint')}
              </label>
            </div>

            {!readOnly && (
              <div className="cap-policy-grid">
                {MODE_KEYS.map((mode) => (
                  <label className="cap-policy-row" key={mode}>
                    <span className="cap-policy-row__mode">{t(MODE_LABEL_KEYS[mode])}</span>
                    <select
                      className="select cap-policy-select"
                      aria-label={t('ability.policy.aria', {
                        mode: t(MODE_LABEL_KEYS[mode]),
                      })}
                      value={policy[mode]}
                      onChange={(event) =>
                        setPolicy((prev) => ({
                          ...prev,
                          [mode]: event.target.value as CapabilityDecision,
                        }))
                      }
                    >
                      <option value="allow">{t('ability.decision.autoRun')}</option>
                      <option value="ask">{t('ability.decision.ask')}</option>
                      <option value="deny">{t('ability.decision.deny')}</option>
                    </select>
                  </label>
                ))}
              </div>
            )}

            <p className="cap-row__note">
              {readOnly ? t('ability.policy.readOnlyNote') : t('ability.policy.mutatingNote')}
              {network && ` ${t('ability.policy.networkNote')}`}
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
            {t('ability.action.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? t('ability.action.saving') : t('ability.action.save')}
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
  const { t } = useI18n();
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
        setError(t('ability.test.requiredParam', { name: parameter.name }));
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
        aria-label={t('ability.test.argsTitle')}
        onSubmit={submit}
      >
        <header className="cap-dialog__head">
          <h2 className="modal__title">
            {t('ability.test.title', { name: definition.name })}
          </h2>
          <p className="cap-dialog__sub">{t('ability.test.subtitle')}</p>
        </header>

        <div className="cap-dialog__body">
          <div className="cap-dialog__section">
            <div className="cap-dialog__section-title">{t('ability.test.argsTitle')}</div>
            <div className="field-grid">
              {parameters.map((parameter) => (
                <label className="field" key={parameter.name}>
                  <span className="field__label">
                    {parameter.name}
                    <span className="field__hint">
                      {parameter.required
                        ? t('ability.field.required')
                        : t('ability.field.optional')}
                      {' · '}
                      {parameter.type}
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
            {t('ability.action.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {t('ability.test.start')}
          </button>
        </footer>
      </form>
    </div>
  );
}
