import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentMemorySettings,
  ChatTarget,
  KbSnapshot,
  ToolCategory,
} from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { AgentMemoryPanel } from './AgentMemoryPanel';
import { AgentKnowledgeTree } from './AgentKnowledgeTree';
import { AgentReviewPanel } from './AgentReviewPanel';
import { useAgentReview } from '../lib/useAgentReview';
import {
  AgentIcon,
  CheckIcon,
  DownloadIcon,
  PlusIcon,
  ScanIcon,
  SparkleIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';

/**
 * Agent page.
 *
 * List → in-page detail. A definition carries its own prompt, role,
 * personality, input/output conventions, capability scope, and which slice of
 * the user's shared knowledge base it may read. The knowledge base itself is
 * maintained once in the 知识库 page; an Agent only stores a selection.
 */

type Tab = 'profile' | 'capabilities' | 'knowledge' | 'memory';

const NEW = '__new';

const EMPTY_DRAFT: AgentDefinition = {
  id: '',
  name: '',
  role: '',
  personality: '',
  inputSpec: '',
  outputSpec: '',
  prompt: '',
  capabilities: { mode: 'all', builtin: [], custom: [] },
  knowledge: { categoryIds: [], documentIds: [], excludeDocumentIds: [] },
  memory: { enabled: true, autoConfirm: true, allowWebRecheck: true },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same fields, timestamps ignored — used to know whether leaving loses edits. */
function comparable(agent: AgentDefinition): string {
  return JSON.stringify({
    name: agent.name,
    role: agent.role,
    personality: agent.personality,
    inputSpec: agent.inputSpec,
    outputSpec: agent.outputSpec,
    prompt: agent.prompt,
    capabilities: agent.capabilities,
    knowledge: agent.knowledge,
    memory: agent.memory,
    enabled: agent.enabled,
  });
}

function hasContent(agent: AgentDefinition): boolean {
  return Boolean(
    agent.name.trim() ||
      agent.role.trim() ||
      agent.personality.trim() ||
      agent.inputSpec.trim() ||
      agent.outputSpec.trim() ||
      agent.prompt.trim(),
  );
}

function cloneAgent(agent: AgentDefinition): AgentDefinition {
  return {
    ...agent,
    capabilities: {
      mode: agent.capabilities.mode,
      builtin: [...agent.capabilities.builtin],
      custom: [...agent.capabilities.custom],
    },
    knowledge: {
      categoryIds: [...(agent.knowledge?.categoryIds ?? [])],
      documentIds: [...(agent.knowledge?.documentIds ?? [])],
      excludeDocumentIds: [...(agent.knowledge?.excludeDocumentIds ?? [])],
    },
    memory: {
      enabled: agent.memory?.enabled ?? true,
      autoConfirm: agent.memory?.autoConfirm ?? true,
      allowWebRecheck: agent.memory?.allowWebRecheck ?? true,
    },
  };
}

interface ConfirmState {
  kind: 'delete' | 'discard';
}

interface Props {
  /** The view stays mounted; this flips when the user visits it. */
  active?: boolean;
  /**
   * Open the AI editing workspace for an agent. Called with the saved agent so
   * the workspace title and its prompt use the same name.
   */
  onOpenAgentEditor?: (agent: { id: string; name: string }) => void;
  /** The default chat model used by 审查; null disables it with an explanation. */
  reviewTarget?: ChatTarget | null;
}

export function AgentPage({ active = true, onOpenAgentEditor, reviewTarget = null }: Props) {
  const api = window.ezness;

  const [agents, setAgents] = useState<AgentDefinition[] | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [toolCategories, setToolCategories] = useState<ToolCategory[]>([]);
  const [loadError, setLoadError] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentDefinition | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [saving, setSaving] = useState(false);
  const [aiCreating, setAiCreating] = useState(false);
  const [notice, setNotice] = useState('');
  /** 列表页的导入/导出结果；和详情页的 notice 分开，切进详情不会带走。 */
  const [pkgNotice, setPkgNotice] = useState<{
    kind: 'ok' | 'warn' | 'bad';
    text: string;
  } | null>(null);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Lives here, not in the dialog: closing the dialog must not cancel a review.
  const review = useAgentReview({
    target: reviewTarget,
    agents: agents ?? [],
    capabilities,
    toolCategories,
    onAgentsChange: (next) => setAgents(next),
  });

  const [kb, setKb] = useState<KbSnapshot | null>(null);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbError, setKbError] = useState('');

  useEffect(() => {
    if (!api) {
      setLoadError('桌面接口不可用，请从 Ezness 应用里打开这个页面。');
      return;
    }
    let alive = true;
    Promise.all([api.agentsList(), api.agentCapabilities(), api.agentCategories()])
      .then(([list, caps, categories]) => {
        if (!alive) return;
        setAgents(list);
        setCapabilities(caps);
        setToolCategories(categories);
      })
      .catch((error) => {
        if (!alive) return;
        setLoadError(messageOf(error));
        setAgents([]);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // This view stays mounted while another one is showing, so the capability
  // lists must be re-read on every visit — custom categories may have been
  // added on the AI能力 page since the page first loaded.
  useEffect(() => {
    if (!api || !active) return;
    let alive = true;
    Promise.all([api.agentsList(), api.agentCapabilities(), api.agentCategories()])
      .then(([list, caps, categories]) => {
        if (!alive) return;
        // The AI editor writes straight to agents.json, so the list must be
        // re-read on every visit too.
        setAgents(list);
        setCapabilities(caps);
        setToolCategories(categories);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, active]);

  /* ---------------- detail helpers ---------------- */

  const openAgent = useCallback(
    (agent: AgentDefinition) => {
      setSelectedId(agent.id);
      setDraft(cloneAgent(agent));
      setTab('profile');
      setNotice('');
      setSaveError('');
      setKb(null);
      setKbError('');
    },
    [],
  );

  function startNew() {
    setSelectedId(NEW);
    setDraft(cloneAgent(EMPTY_DRAFT));
    setTab('profile');
    setNotice('');
    setSaveError('');
    setKb(null);
    setKbError('');
  }

  const original = useMemo(
    () => (agents ?? []).find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const dirty = useMemo(() => {
    if (!draft) return false;
    if (!original) return hasContent(draft);
    return comparable(draft) !== comparable(original);
  }, [draft, original]);

  function closeDetail() {
    setSelectedId(null);
    setDraft(null);
    setConfirm(null);
    setNotice('');
    setSaveError('');
    setKb(null);
    setKbError('');
    setTab('profile');
  }

  function requestClose() {
    if (dirty) {
      setConfirm({ kind: 'discard' });
      return;
    }
    closeDetail();
  }

  function patchDraft(patch: Partial<AgentDefinition>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNotice('');
    setSaveError('');
  }

  function patchCapabilities(patch: Partial<AgentDefinition['capabilities']>) {
    setDraft((current) =>
      current
        ? { ...current, capabilities: { ...current.capabilities, ...patch } }
        : current,
    );
    setNotice('');
    setSaveError('');
  }

  /**
   * Memory switches save immediately (they affect background work), so the
   * list is refreshed from the authoritative result instead of marking the
   * whole form dirty.
   */
  function applyMemorySettings(settings: AgentMemorySettings, nextAgents: AgentDefinition[]) {
    setAgents(nextAgents);
    setDraft((current) => (current ? { ...current, memory: settings } : current));
    setNotice('已保存记忆设置');
    setSaveError('');
  }

  async function save() {
    if (!api || !draft) return;
    if (!draft.name.trim()) {
      setSaveError('先给 Agent 起个名字。');
      return;
    }
    setSaving(true);
    setSaveError('');
    setNotice('');
    try {
      const result = await api.agentsSave(draft);
      if (!result.ok || !result.agent) {
        setSaveError(result.error || '保存失败');
        return;
      }
      setAgents(result.agents ?? agents);
      setDraft(cloneAgent(result.agent));
      setSelectedId(result.agent.id);
      setNotice('已保存');
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  /* ---------------- 包：导入 / 导出 ---------------- */

  async function exportAgent(agent: AgentDefinition) {
    if (!api?.agentsExport) {
      setPkgNotice({ kind: 'bad', text: '导出只在桌面端可用。' });
      return;
    }
    setPkgNotice(null);
    try {
      const result = await api.agentsExport(agent.id);
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || '导出失败' });
        return;
      }
      const warnings = result.warnings ?? [];
      const summary = `已导出「${agent.name}」：${result.categories ?? 0} 个能力分类、${result.memory ?? 0} 条长期记忆。`;
      setPkgNotice({
        kind: warnings.length > 0 ? 'warn' : 'ok',
        text: warnings.length > 0 ? `${summary}\n${warnings.join('\n')}` : summary,
      });
    } catch (error) {
      setPkgNotice({ kind: 'bad', text: messageOf(error) });
    }
  }

  async function importAgentPackage() {
    if (!api?.agentsImport) {
      setPkgNotice({ kind: 'bad', text: '导入只在桌面端可用。' });
      return;
    }
    setPkgNotice(null);
    setPkgBusy(true);
    try {
      const result = await api.agentsImport();
      if (result.canceled) return;
      if (!result.ok) {
        setPkgNotice({ kind: 'bad', text: result.error || '导入失败' });
        return;
      }
      if (result.agents) setAgents(result.agents);
      if (result.categories) setToolCategories(result.categories);
      const warnings = result.warnings ?? [];
      const summary = `已导入 Agent「${result.agent?.name ?? ''}」，带了 ${
        result.importedCategories ?? 0
      } 个能力分类、${result.memory ?? 0} 条长期记忆。`;
      setPkgNotice({
        kind: warnings.length > 0 ? 'warn' : 'ok',
        text: warnings.length > 0 ? `${summary}\n${warnings.join('\n')}` : summary,
      });
    } catch (error) {
      setPkgNotice({ kind: 'bad', text: messageOf(error) });
    } finally {
      setPkgBusy(false);
    }
  }

  /** A unique temporary name for a freshly created AI draft. */
  function draftName(): string {
    const taken = new Set((agents ?? []).map((agent) => agent.name.toLowerCase()));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const name = `新 Agent ${Math.random().toString(36).slice(2, 6)}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
    return `新 Agent ${Date.now().toString(36).slice(-4)}`;
  }

  /**
   * Create a disabled draft immediately, then open its AI editing workspace.
   * Creating first means the workspace has a real agent id to bind to, and the
   * user can leave at any point without losing what was already written.
   */
  async function createWithAI() {
    if (!api || !onOpenAgentEditor) return;
    setAiCreating(true);
    setSaveError('');
    try {
      const result = await api.agentsSave({
        ...cloneAgent(EMPTY_DRAFT),
        name: draftName(),
        enabled: false,
      });
      if (!result.ok || !result.agent) {
        setSaveError(result.error || '创建失败');
        return;
      }
      setAgents(result.agents ?? agents);
      closeDetail();
      onOpenAgentEditor({ id: result.agent.id, name: result.agent.name });
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setAiCreating(false);
    }
  }

  /**
   * Open the AI editor for the agent in the detail view. Unsaved edits are
   * written first: the editor changes agents.json directly, so it must start
   * from what the form shows, not from an older version on disk.
   */
  async function editWithAI() {
    if (!api || !draft || !draft.id || !onOpenAgentEditor) return;
    if (!draft.name.trim()) {
      setSaveError('先给 Agent 起个名字。');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      let saved = draft;
      if (dirty) {
        const result = await api.agentsSave(draft);
        if (!result.ok || !result.agent) {
          setSaveError(result.error || '保存失败');
          return;
        }
        setAgents(result.agents ?? agents);
        saved = result.agent;
      }
      closeDetail();
      onOpenAgentEditor({ id: saved.id, name: saved.name });
    } catch (error) {
      setSaveError(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(agent: AgentDefinition) {
    if (!api) return;
    try {
      const result = await api.agentsSave({ ...agent, enabled: !agent.enabled });
      if (result.ok) setAgents(result.agents ?? agents);
    } catch {
      /* the list keeps its previous state; reopening the page retries */
    }
  }

  async function deleteAgent() {
    if (!api || !selectedId || selectedId === NEW) return;
    setConfirm(null);
    try {
      const result = await api.agentsDelete(selectedId);
      if (!result.ok) {
        setSaveError(result.error || '删除失败');
        return;
      }
      setAgents(result.agents ?? []);
      closeDetail();
    } catch (error) {
      setSaveError(messageOf(error));
    }
  }

  /* ---------------- knowledge base ---------------- */

  // The tree is a live read of the shared knowledge base, not a per-Agent copy.
  // Opening an Agent clears the cached snapshot, so read it again whenever the
  // knowledge tab is opened instead of only once on mount.
  useEffect(() => {
    if (!api || tab !== 'knowledge') return;
    let alive = true;
    setKbLoading(true);
    setKbError('');
    api
      .kbSnapshot()
      .then((snapshot) => {
        if (alive) setKb(snapshot);
      })
      .catch((error) => {
        if (alive) setKbError(messageOf(error));
      })
      .finally(() => {
        if (alive) setKbLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, tab]);

  useEffect(() => {
    if (!api) return;
    let timer = 0;
    const off = api.onKbEvent((event) => {
      if (event.type === 'refresh' && event.documents) {
        setKb({
          categories: event.categories ?? [],
          documents: event.documents,
          stats: event.stats ?? { documents: 0, chunks: 0, ready: 0 },
        });
        return;
      }
      // Ingest progress is frequent; one snapshot read covers a burst.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        api
          .kbSnapshot()
          .then(setKb)
          .catch(() => undefined);
      }, 400);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [api]);

  /* ---------------- derived ---------------- */

  // capabilities.categories mixes built-in groups and custom-tool categories;
  // keep only groups backed by a built-in tool so the two lists stay disjoint.
  const builtinCategories = useMemo(() => {
    if (!capabilities) return [];
    const builtin = new Set(
      capabilities.tools.filter((tool) => !tool.custom).map((tool) => tool.category),
    );
    return capabilities.categories.filter((name) => builtin.has(name));
  }, [capabilities]);
  // Built-in functions grouped by category, so each row can show how many
  // functions the checkbox actually covers (13 built-ins across 6 groups).
  const builtinToolMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tool of capabilities?.tools ?? []) {
      if (tool.custom) continue;
      const list = map.get(tool.category) ?? [];
      list.push(tool.name);
      map.set(tool.category, list);
    }
    return map;
  }, [capabilities]);
  const builtinToolCount = useMemo(
    () => [...builtinToolMap.values()].reduce((sum, list) => sum + list.length, 0),
    [builtinToolMap],
  );
  const selectedCount = draft
    ? draft.capabilities.builtin.length + draft.capabilities.custom.length
    : 0;
  const totalCategories = builtinCategories.length + toolCategories.length;
  function scopeLabel(agent: AgentDefinition): string {
    if (agent.capabilities.mode === 'all') return '全部能力';
    const count = agent.capabilities.builtin.length + agent.capabilities.custom.length;
    return `${count} 个能力分类`;
  }
  function knowledgeLabel(agent: AgentDefinition): string {
    const categories = agent.knowledge?.categoryIds.length ?? 0;
    const docs = agent.knowledge?.documentIds.length ?? 0;
    if (categories === 0 && docs === 0) return '未选知识库';
    if (categories > 0 && docs > 0) return `知识库 ${categories} 类 · ${docs} 篇`;
    return categories > 0 ? `知识库 ${categories} 个分类` : `知识库 ${docs} 篇文档`;
  }

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <div className="agent">
        <header className="agent__head">
          <div className="agent__title">
            Agent <span>独立提示词 · 能力范围 · 共享知识库</span>
          </div>
        </header>
        <div className="agent__body">
          <div className="agent-empty">
            <AgentIcon size={30} />
            <h2>加载失败</h2>
            <p>{loadError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (draft) {
    return (
      <div className="agent">
        <header className="agent__head">
          <div className="agent__title">
            <button className="agent__back" onClick={requestClose} title="返回列表">
              ←
            </button>
            {draft.id ? draft.name || '未命名 Agent' : '新建 Agent'}
            <span>{draft.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div className="agent__actions">
            {draft.id && onOpenAgentEditor && (
              <button
                className="btn btn--ghost"
                onClick={() => void editWithAI()}
                disabled={saving}
                title="在对话里让 AI 修改这个 Agent"
              >
                <SparkleIcon size={14} />
                AI 编辑
              </button>
            )}
            <button
              className="btn btn--primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </header>

        <div className="agent-detail">
          <nav className="agent-tabs" aria-label="Agent 设置">
            <button
              className={`agent-tab ${tab === 'profile' ? 'is-on' : ''}`}
              onClick={() => setTab('profile')}
            >
              定义
            </button>
            <button
              className={`agent-tab ${tab === 'capabilities' ? 'is-on' : ''}`}
              onClick={() => setTab('capabilities')}
            >
              能力范围
            </button>
            <button
              className={`agent-tab ${tab === 'knowledge' ? 'is-on' : ''}`}
              onClick={() => setTab('knowledge')}
            >
              知识库
            </button>
            <button
              className={`agent-tab ${tab === 'memory' ? 'is-on' : ''}`}
              onClick={() => setTab('memory')}
            >
              长期记忆
            </button>
          </nav>

          <div className="agent-detail__body">
            {tab === 'profile' && (
              <div className="agent-form">
                <div className="agent-form__row">
                  <label className="field">
                    <span className="field__label">名字</span>
                    <input
                      className="input"
                      value={draft.name}
                      maxLength={32}
                      placeholder="例如：资料研究员"
                      onChange={(event) => patchDraft({ name: event.target.value })}
                    />
                  </label>
                  <label className="agent-switch">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => patchDraft({ enabled: event.target.checked })}
                    />
                    <span>启用这个 Agent</span>
                  </label>
                </div>

                <label className="field">
                  <span className="field__label">
                    角色定义
                    <span className="field__hint">它是什么、负责什么</span>
                  </span>
                  <textarea
                    className="input agent-form__textarea"
                    rows={4}
                    value={draft.role}
                    maxLength={2000}
                    placeholder="例如：你是一名严谨的资料研究员，负责收集、核对并整理某个主题的材料。"
                    onChange={(event) => patchDraft({ role: event.target.value })}
                  />
                </label>

                <label className="field">
                  <span className="field__label">
                    性格偏好
                    <span className="field__hint">说话方式与做事习惯</span>
                  </span>
                  <textarea
                    className="input agent-form__textarea"
                    rows={3}
                    value={draft.personality}
                    maxLength={2000}
                    placeholder="例如：直接、谨慎，先给结论再列依据；不确定的地方明确说不确定。"
                    onChange={(event) => patchDraft({ personality: event.target.value })}
                  />
                </label>

                <div className="agent-form__grid">
                  <label className="field">
                    <span className="field__label">
                      输入约定
                      <span className="field__hint">用户会给它什么</span>
                    </span>
                    <textarea
                      className="input agent-form__textarea"
                      rows={4}
                      value={draft.inputSpec}
                      maxLength={2000}
                      placeholder="例如：一段研究主题，或需要核对的资料来源。"
                      onChange={(event) => patchDraft({ inputSpec: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">
                      输出约定
                      <span className="field__hint">它交付什么格式</span>
                    </span>
                    <textarea
                      className="input agent-form__textarea"
                      rows={4}
                      value={draft.outputSpec}
                      maxLength={2000}
                      placeholder="例如：先给一段结论，再列来源与不确定项；资料按主题分组。"
                      onChange={(event) => patchDraft({ outputSpec: event.target.value })}
                    />
                  </label>
                </div>

                <label className="field">
                  <span className="field__label">
                    专属提示词
                    <span className="field__hint">它会作为这个 Agent 的系统提示词</span>
                  </span>
                  <textarea
                    className="input agent-form__textarea agent-form__prompt"
                    rows={10}
                    value={draft.prompt}
                    maxLength={20000}
                    placeholder="写下你希望它始终遵守的要求。这些内容只对这个 Agent 生效。"
                    onChange={(event) => patchDraft({ prompt: event.target.value })}
                  />
                </label>
              </div>
            )}

            {tab === 'capabilities' && (
              <div className="agent-form">
                <div className="agent-seg" role="group" aria-label="能力范围">
                  <button
                    className={`agent-seg__item ${draft.capabilities.mode === 'all' ? 'is-on' : ''}`}
                    onClick={() => patchCapabilities({ mode: 'all' })}
                  >
                    全部能力
                  </button>
                  <button
                    className={`agent-seg__item ${draft.capabilities.mode === 'selected' ? 'is-on' : ''}`}
                    onClick={() => {
                      // Switching to a narrow scope with nothing picked would
                      // leave the agent unable to do anything.
                      const empty =
                        draft.capabilities.builtin.length + draft.capabilities.custom.length === 0;
                      patchCapabilities({
                        mode: 'selected',
                        ...(empty ? { builtin: [...builtinCategories] } : {}),
                      });
                    }}
                  >
                    指定分类
                  </button>
                </div>

                <p className="agent-hint">
                  {draft.capabilities.mode === 'all'
                    ? `这个 Agent 可以使用全部 ${totalCategories} 个能力分类（其中内置 ${builtinToolCount} 个功能），包括以后新增的分类。`
                    : `只勾选需要的分类；当前已选 ${selectedCount} / ${totalCategories} 个。勾选一个分类即包含它下面的全部功能。`}
                </p>

                <section className="agent-cap-group">
                  <h3>
                    内置能力
                    <span className="agent-cap-group__meta">
                      {builtinCategories.length} 个分类 · {builtinToolCount} 个功能
                    </span>
                  </h3>
                  <div className="agent-checks">
                    {builtinCategories.map((name) => {
                      const checked =
                        draft.capabilities.mode === 'all' ||
                        draft.capabilities.builtin.includes(name);
                      const tools = builtinToolMap.get(name) ?? [];
                      return (
                        <label
                          key={name}
                          className="agent-check"
                          title={tools.length > 0 ? tools.join('、') : name}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={draft.capabilities.mode === 'all'}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...draft.capabilities.builtin, name]
                                : draft.capabilities.builtin.filter((item) => item !== name);
                              patchCapabilities({ builtin: next });
                            }}
                          />
                          <span>{name}</span>
                          <em className="agent-check__count">{tools.length}</em>
                        </label>
                      );
                    })}
                    {builtinCategories.length === 0 && (
                      <p className="agent-hint">还没有读取到内置能力分类。</p>
                    )}
                  </div>
                </section>

                <section className="agent-cap-group">
                  <h3>
                    自定义功能分类
                    <span className="agent-cap-group__meta">{toolCategories.length} 个分类</span>
                  </h3>
                  {toolCategories.length === 0 ? (
                    <p className="agent-hint">
                      还没有自定义功能分类。可以先去「AI能力」里创建分类和功能。
                    </p>
                  ) : (
                    <div className="agent-checks">
                      {toolCategories.map((category) => {
                        const checked =
                          draft.capabilities.mode === 'all' ||
                          draft.capabilities.custom.includes(category.id);
                        return (
                          <label key={category.id} className="agent-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={draft.capabilities.mode === 'all'}
                              onChange={(event) => {
                                const next = event.target.checked
                                  ? [...draft.capabilities.custom, category.id]
                                  : draft.capabilities.custom.filter(
                                      (item) => item !== category.id,
                                    );
                                patchCapabilities({ custom: next });
                              }}
                            />
                            <span>{category.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === 'knowledge' && (
              <AgentKnowledgeTree
                snapshot={kb}
                loading={kbLoading}
                error={kbError}
                selection={draft.knowledge}
                onChange={(knowledge) => patchDraft({ knowledge })}
              />
            )}

            {tab === 'memory' && (
              <AgentMemoryPanel
                key={draft.id || 'new-agent'}
                agentId={draft.id}
                settings={draft.memory}
                onSettings={applyMemorySettings}
              />
            )}
          </div>

          <footer className="agent-detail__foot">
            <div>
              {draft.id && (
                <button
                  className="btn btn--danger"
                  onClick={() => setConfirm({ kind: 'delete' })}
                  disabled={saving}
                >
                  <TrashIcon size={14} />
                  删除 Agent
                </button>
              )}
            </div>
            <div className="agent-detail__status">
              {saveError && <span className="agent-error">{saveError}</span>}
              {!saveError && notice && (
                <span className="agent-ok">
                  <CheckIcon size={13} />
                  {notice}
                </span>
              )}
              <button className="btn btn--primary" onClick={save} disabled={saving || !dirty}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </footer>
        </div>

        {confirm?.kind === 'delete' && (
          <ConfirmDialog
            title="删除这个 Agent？"
            message={`「${draft.name || '未命名 Agent'}」的定义和长期记忆会被删除，且不能恢复。知识库是共享的，资料不会受影响。`}
            confirmLabel="删除"
            danger
            onConfirm={deleteAgent}
            onCancel={() => setConfirm(null)}
          />
        )}
        {confirm?.kind === 'discard' && (
          <ConfirmDialog
            title="放弃未保存的修改？"
            message="返回列表后，这次改动不会保留。"
            confirmLabel="放弃修改"
            danger
            onConfirm={closeDetail}
            onCancel={() => setConfirm(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="agent">
      <header className="agent__head">
        <div className="agent__title">
          Agent
          <span>
            {agents === null ? '正在读取…' : `${agents.length} 个 · 独立提示词与可见资料`}
          </span>
        </div>
        <div className="agent__actions">
          <button
            className="btn btn--ghost"
            onClick={() => setReviewOpen(true)}
            disabled={!agents || agents.length === 0}
            title="检查每个 Agent 的能力范围和知识库是否与它的定义匹配"
          >
            <ScanIcon size={14} />
            {review.phase === 'running' ? '审查中…' : 'Agent审查'}
            {review.phase === 'ready' && review.pending.length > 0 && (
              <span className="agent-review__badge">{review.pending.length}</span>
            )}
          </button>
          {onOpenAgentEditor && (
            <button
              className="btn btn--ghost"
              onClick={() => void createWithAI()}
              disabled={aiCreating}
              title="创建一个草稿 Agent，并在对话里让 AI 帮你设计"
            >
              <SparkleIcon size={14} />
              {aiCreating ? '创建中…' : 'AI 新增'}
            </button>
          )}
          <button
            className="btn btn--ghost"
            onClick={() => void importAgentPackage()}
            disabled={pkgBusy}
            title="导入 Agent 包：定义、能力范围、勾选的能力分类和长期记忆会一起进来"
          >
            <UploadIcon size={14} />
            {pkgBusy ? '导入中…' : '导入'}
          </button>
          <button className="btn btn--primary" onClick={startNew}>
            <PlusIcon size={14} />
            新建 Agent
          </button>
        </div>
      </header>

      <div className="agent__body">
        {pkgNotice && (
          <p
            className={`agent-note ${
              pkgNotice.kind === 'ok'
                ? 'is-ok'
                : pkgNotice.kind === 'warn'
                  ? 'is-warn'
                  : 'is-bad'
            }`}
          >
            {pkgNotice.text}
          </p>
        )}
        {agents === null ? (
          <p className="agent-hint">正在读取 Agent…</p>
        ) : agents.length === 0 ? (
          <div className="agent-empty">
            <AgentIcon size={32} />
            <h2>还没有 Agent</h2>
            <p>
              每个 Agent 有独立的提示词和能力范围，并可以从共享知识库里勾选它能读的资料。先创建一个。
            </p>
            <button className="btn btn--primary" onClick={startNew}>
              <PlusIcon size={14} />
              新建第一个 Agent
            </button>
          </div>
        ) : (
          <div className="agent-grid">
            {agents.map((agent) => (
              <article
                key={agent.id}
                className={`agent-card ${agent.enabled ? '' : 'is-off'}`}
                onClick={() => openAgent(agent)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openAgent(agent);
                  }
                }}
              >
                <div className="agent-card__top">
                  <span className="agent-card__avatar" aria-hidden="true">
                    {agent.name.trim().slice(0, 1) || 'A'}
                  </span>
                  <div className="agent-card__id">
                    <h2>{agent.name || '未命名 Agent'}</h2>
                    <span className={`agent-card__state ${agent.enabled ? 'is-on' : ''}`}>
                      {agent.enabled ? '已启用' : '已停用'}
                    </span>
                  </div>
                  <button
                    className="agent-card__export"
                    onClick={(event) => {
                      event.stopPropagation();
                      void exportAgent(agent);
                    }}
                    title="导出这个 Agent"
                    aria-label={`导出 ${agent.name}`}
                  >
                    <DownloadIcon size={13} />
                  </button>
                  <button
                    className="agent-card__toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleEnabled(agent);
                    }}
                    title={agent.enabled ? '停用' : '启用'}
                  >
                    {agent.enabled ? '停用' : '启用'}
                  </button>
                </div>

                <p className="agent-card__role">
                  {agent.role.trim() || '还没有填写角色定义。'}
                </p>

                {agent.personality.trim() && (
                  <p className="agent-card__personality">性格：{agent.personality}</p>
                )}

                <div className="agent-card__foot">
                  <span className="agent-card__tag">{scopeLabel(agent)}</span>
                  <span className="agent-card__tag">{knowledgeLabel(agent)}</span>
                  <span className="agent-card__time">
                    {agent.updatedAt
                      ? new Date(agent.updatedAt).toLocaleDateString('zh-CN')
                      : ''}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {reviewOpen && (
        <AgentReviewPanel
          review={review}
          agentCount={agents?.length ?? 0}
          modelReady={Boolean(reviewTarget)}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}
