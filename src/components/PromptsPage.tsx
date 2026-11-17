import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatStreamEvent,
  ChatTarget,
  PromptSnapshot,
  PromptTemplate,
  PromptVariable,
} from '../types';
import {
  createBlankTemplate,
  estimateTokens,
  normalizeTemplate,
  renderPrompt,
  snapshotKey,
  snapshotOf,
  uid,
} from '../data/prompts';
import { ConfirmDialog } from './ConfirmDialog';
import {
  CheckIcon,
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';

const HISTORY_LIMIT = 60;
const SAVE_IDLE = 400;
const GENERATE_TIMEOUT = 90_000;

type GenerationKind = 'nameEn' | 'descriptionEn' | 'bodyEn';

/**
 * Dedicated translation models (e.g. Hunyuan-MT) are trained on this exact
 * "Translate the following segment …, without additional explanation." shape.
 * A system prompt explaining the task makes them answer the text instead of
 * translating it, so the instruction travels in the user message.
 */
const TRANSLATION_PROMPTS: Record<GenerationKind, string> = {
  nameEn:
    'Translate the following name into English, without additional explanation. Answer with the English name only: 2-5 words, no quotes.',
  descriptionEn:
    'Translate the following description into English, without additional explanation. Answer with one concise English sentence.',
  bodyEn: 'Translate the following segment into English, without additional explanation.',
};

/** Placeholder names in `text`, e.g. `{{chunks}}` → `chunks`. */
function placeholderNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim()),
  );
}

/** Models sometimes wrap replies in fences or quotes even when told not to. */
function tidyTranslation(raw: string, kind: GenerationKind): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  // Some translation models echo the request and wrap the answer in a tag.
  const tagged = /<(?:target|translation)>([\s\S]*?)<\/(?:target|translation)>/i.exec(text);
  if (tagged) text = tagged[1].trim();
  if (kind === 'nameEn') {
    text = (text.split('\n')[0] ?? '').trim();
    text = text
      .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
      .replace(/[.。]+$/, '')
      .trim();
  }
  return text;
}

/** Streaming one-shot request on the translation model; resolves with the text. */
function translateToEnglish(
  target: ChatTarget,
  kind: GenerationKind,
  source: string,
  requestId: string,
): Promise<string> {
  const api = window.ezness;
  if (!api) return Promise.reject(new Error('窗口接口不可用'));

  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer = 0;

    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error);
      else resolve(value ?? '');
    };

    timer = window.setTimeout(() => {
      void api.chatAbort?.(requestId);
      finish(new Error('生成超时'));
    }, GENERATE_TIMEOUT);

    unsubscribe = api.onChatEvent?.((event: ChatStreamEvent) => {
      if (event.requestId !== requestId) return;
      if (event.type === 'delta') {
        text += event.text ?? '';
        return;
      }
      if (event.type === 'thinking') return;
      if (event.type === 'done') finish(null, text);
      else if (event.type === 'aborted') finish(new Error('生成已中断'));
      else finish(new Error(event.error || '未知错误'));
    });

    api
      .chatSend({
        requestId,
        provider: target,
        feature: 'prompt',
        messages: [
          {
            role: 'user',
            content: `${TRANSLATION_PROMPTS[kind]}\n\n<source>\n${source}\n</source>`,
          },
        ],
      })
      .then((ok) => {
        if (!ok) finish(new Error('请求没有发出'));
      })
      .catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface Props {
  /** Resolved 设置 → 默认模型 → 翻译; null when nothing is configured. */
  translationTarget: ChatTarget | null;
}

export function PromptsPage({ translationTarget }: Props) {
  const api = window.ezness;

  // 模板库只来自数据目录里的 prompts.json：没有就是空的，不带任何出厂模板。
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeId, setActiveId] = useState('');
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState('全部');
  const [tagDraft, setTagDraft] = useState({ id: '', text: '' });
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [generating, setGenerating] = useState<GenerationKind | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PromptTemplate | null>(null);
  // Content each template had when it was last saved as a version. A template
  // missing here is clean (baseline is its current content).
  const [savedBases, setSavedBases] = useState<Record<string, string>>({});

  const editorRef = useRef<HTMLElement | null>(null);
  /** 加载时数据目录里是否已经有模板库（决定首次运行要不要落盘）。 */
  const loadedExisting = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  // The in-flight English generation, if any — aborted when the page unmounts.
  const generation = useRef<{ requestId: string } | null>(null);

  const active = useMemo(
    () => templates.find((template) => template.id === activeId) ?? null,
    [templates, activeId],
  );
  const activeKey = useMemo(() => (active ? snapshotKey(active) : ''), [active]);
  const savedBase = active ? savedBases[active.id] : undefined;
  const dirty = !!active && savedBase !== undefined && activeKey !== savedBase;

  const rendered = useMemo(
    () => (active ? renderPrompt(active.body || active.bodyEn, active.variables) : ''),
    [active],
  );
  const renderedTokens = estimateTokens(rendered);

  // Filter pills come from the tags actually in use — delete the last template
  // carrying a tag and its pill goes away with it.
  const tagOptions = useMemo(() => {
    const seen: string[] = [];
    for (const template of templates) {
      for (const tag of template.tags) {
        if (!seen.includes(tag)) seen.push(tag);
      }
    }
    return ['全部', ...seen];
  }, [templates]);

  useEffect(() => {
    if (filterTag !== '全部' && !tagOptions.includes(filterTag)) setFilterTag('全部');
  }, [filterTag, tagOptions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (filterTag !== '全部' && !template.tags.includes(filterTag)) return false;
      if (!needle) return true;
      return [template.name, template.nameEn, ...template.tags].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [templates, query, filterTag]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(saveTimer.current);
      const running = generation.current;
      if (running) void window.ezness?.chatAbort?.(running.requestId);
    },
    [],
  );

  // Load the library from the data root. The main process answers with the
  // saved prompts.json only; `null` means there is none yet, so the page
  // stays empty and nothing is written until the user creates a template.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const load = api?.promptsLoad;
      const stored = load ? await load().catch(() => null) : null;
      if (cancelled) return;
      // 有没有真正读到一份库。首次运行什么都没有时不要写空文件，
      // 免得数据目录里凭空多出一个空的 prompts.json。
      loadedExisting.current = Array.isArray(stored);
      if (Array.isArray(stored)) {
        const loaded = stored
          .map((entry) => normalizeTemplate(entry))
          .filter((template): template is PromptTemplate => template !== null);
        setSavedBases({});
        setTemplates(loaded);
        setActiveId((current) =>
          loaded.some((template) => template.id === current) ? current : loaded[0]?.id ?? '',
        );
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the library shortly after the last edit.
  useEffect(() => {
    const save = api?.promptsSave;
    if (!ready || !save) return;
    // 从没读到过库、手上也没有模板：这是首次运行，别留下一个空 prompts.json。
    if (!loadedExisting.current && templates.length === 0) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void save(templates).catch(() => undefined);
    }, SAVE_IDLE);
    return () => window.clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, ready]);

  // First look at a template counts as its baseline: nothing to save yet.
  useEffect(() => {
    if (!active) return;
    setSavedBases((current) =>
      current[active.id] !== undefined ? current : { ...current, [active.id]: activeKey },
    );
  }, [active, activeKey]);

  // A new template starts at the name field, not wherever the last one was left.
  useEffect(() => {
    if (editorRef.current) editorRef.current.scrollTop = 0;
  }, [activeId]);

  const pushVersion = useCallback((templateId: string, key: string) => {
    const snapshot = JSON.parse(key) as PromptSnapshot;
    setTemplates((current) =>
      current.map((template) =>
        template.id === templateId
          ? {
              ...template,
              history: [{ id: uid(), at: Date.now(), snapshot }, ...template.history].slice(
                0,
                HISTORY_LIMIT,
              ),
            }
          : template,
      ),
    );
  }, []);

  /** Snapshot the current content as a new version. Only 保存 does this. */
  function saveVersion() {
    if (!active || !dirty) return;
    pushVersion(active.id, activeKey);
    setSavedBases((current) => ({ ...current, [active.id]: activeKey }));
    showToast('已保存为新版本');
  }

  function deleteVersion(versionId: string) {
    if (!active) return;
    const templateId = active.id;
    setTemplates((current) =>
      current.map((template) =>
        template.id === templateId
          ? {
              ...template,
              history: template.history.filter((entry) => entry.id !== versionId),
            }
          : template,
      ),
    );
    showToast('已删除该版本');
  }

  const patchActive = useCallback(
    (patch: Partial<PromptSnapshot>) => {
      if (!activeId) return;
      setTemplates((current) =>
        current.map((template) =>
          template.id === activeId
            ? { ...template, ...patch, updatedAt: Date.now() }
            : template,
        ),
      );
    },
    [activeId],
  );

  function selectTemplate(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setTagDraft({ id: '', text: '' });
  }

  function createTemplate() {
    const template = createBlankTemplate();
    setTemplates((current) => [template, ...current]);
    setActiveId(template.id);
    setTagDraft({ id: '', text: '' });
    setFilterTag('全部');
    setQuery('');
    showToast('已创建空白模板');
  }

  function confirmDelete() {
    const template = pendingDelete;
    if (!template) return;
    setPendingDelete(null);
    const rest = templates.filter((entry) => entry.id !== template.id);
    setTemplates(rest);
    if (template.id === activeId) setActiveId(rest[0]?.id ?? '');
    setTagDraft({ id: '', text: '' });
    showToast('已删除模板');
  }

  function updateTags(text: string) {
    setTagDraft({ id: activeId, text });
    patchActive({
      tags: text
        // The field asks for English commas; a pasted Chinese comma still works.
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  }

  function updateVariable(index: number, patch: Partial<PromptVariable>) {
    if (!active) return;
    patchActive({
      variables: active.variables.map((variable, position) =>
        position === index ? { ...variable, ...patch } : variable,
      ),
    });
  }

  function removeVariable(index: number) {
    if (!active) return;
    patchActive({
      variables: active.variables.filter((_, position) => position !== index),
    });
  }

  function addVariable() {
    if (!active) return;
    patchActive({ variables: [...active.variables, { name: '', value: '' }] });
  }

  function restoreVersion(versionId: string) {
    if (!active) return;
    const version = active.history.find((entry) => entry.id === versionId);
    if (!version) return;

    const snapshot = snapshotOf(version.snapshot);
    // The restored content is already a version — nothing new to save yet.
    setSavedBases((current) => ({ ...current, [active.id]: snapshotKey(snapshot) }));
    setTagDraft({ id: '', text: '' });
    setTemplates((current) =>
      current.map((template) =>
        template.id === active.id ? { ...template, ...snapshot, updatedAt: Date.now() } : template,
      ),
    );
    showToast('已恢复到该历史版本');
  }

  async function generateEnglish(kind: GenerationKind) {
    if (!active || !translationTarget || generating) return;
    const templateId = active.id;
    const source =
      kind === 'nameEn' ? active.name : kind === 'descriptionEn' ? active.description : active.body;
    if (!source.trim()) {
      showToast('先填写中文内容');
      return;
    }

    const requestId = uid();
    generation.current = { requestId };
    setGenerating(kind);
    try {
      const raw = await translateToEnglish(translationTarget, kind, source, requestId);
      const text = tidyTranslation(raw, kind);
      if (!text) throw new Error('模型没有返回内容');
      if (kind === 'bodyEn') {
        const got = placeholderNames(text);
        const missing = [...placeholderNames(source)].filter((name) => !got.has(name));
        if (missing.length > 0) {
          throw new Error(`生成的英文缺少变量标记 ${missing.map((name) => `{{${name}}}`).join('、')}，请重试`);
        }
      }
      const patch: Partial<PromptSnapshot> =
        kind === 'nameEn'
          ? { nameEn: text }
          : kind === 'descriptionEn'
            ? { descriptionEn: text }
            : { bodyEn: text };
      // Write into the template that was active when the request started.
      setTemplates((current) =>
        current.map((template) =>
          template.id === templateId ? { ...template, ...patch, updatedAt: Date.now() } : template,
        ),
      );
      showToast('已生成英文');
    } catch (error) {
      showToast(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      generation.current = null;
      setGenerating(null);
    }
  }

  function generateButton(kind: GenerationKind) {
    if (!active) return null;
    const source =
      kind === 'nameEn' ? active.name : kind === 'descriptionEn' ? active.description : active.body;
    const busy = generating === kind;
    const disabled = !translationTarget || !source.trim() || generating !== null;
    return (
      <button
        className={`prompts__gen ${busy ? 'is-busy' : ''}`}
        disabled={disabled}
        title={
          !translationTarget
            ? '先在「设置 → 默认模型」里配置翻译模型'
            : !source.trim()
              ? '先填写中文内容'
              : '用翻译模型生成英文（会覆盖现有内容）'
        }
        onClick={() => void generateEnglish(kind)}
      >
        <SparkleIcon size={12} />
        {busy ? '生成中…' : '生成英文'}
      </button>
    );
  }

  async function exportActive() {
    if (!active) return;
    if (!api?.promptsExport) {
      showToast('当前环境不支持导出');
      return;
    }
    const result = await api.promptsExport({ template: active });
    if (result.ok) showToast(`已导出到 ${result.path ?? '文件'}`);
    else if (!result.canceled) showToast(`导出失败：${result.error ?? '未知错误'}`);
  }

  async function importTemplate() {
    if (!api?.promptsImport) {
      showToast('当前环境不支持导入');
      return;
    }
    const result = await api.promptsImport();
    if (!result.ok) {
      if (!result.canceled) showToast(`导入失败：${result.error ?? '未知错误'}`);
      return;
    }

    const template = normalizeTemplate(result.data);
    if (!template) {
      showToast('文件里没有可导入的模板');
      return;
    }
    // A file exported from this machine carries its original id; importing it
    // back should add a copy rather than silently shadow the existing template.
    if (templates.some((entry) => entry.id === template.id)) {
      template.id = uid();
      template.name = `${template.name}（导入）`;
    }

    setTemplates((current) => [template, ...current]);
    setActiveId(template.id);
    setTagDraft({ id: '', text: '' });
    setFilterTag('全部');
    setQuery('');
    showToast(`已导入「${template.name || '未命名模板'}」`);
  }

  const tagsText = active
    ? tagDraft.id === active.id
      ? tagDraft.text
      : active.tags.join(', ')
    : '';

  return (
    <div className="prompts">
      <aside className="prompts__list">
        <header className="prompts__list-head">
          <h1>
            提示词 <span>Prompt Templates</span>
          </h1>
          <p>在这里维护模板库；在对话输入框左下角选择模板后，该会话的每次请求都按模板执行。</p>

          <button className="btn btn--primary prompts__new" onClick={createTemplate}>
            <PlusIcon size={13} /> 新建模板
          </button>

          <div className="prompts__search">
            <SearchIcon size={14} />
            <input
              className="input"
              value={query}
              placeholder="搜索名称 / 标签"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="prompts__tags">
            {tagOptions.map((tag) => (
              <button
                key={tag}
                className={`prompts__tag ${filterTag === tag ? 'is-on' : ''}`}
                onClick={() => setFilterTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </header>

        <div className="prompts__rows">
          {visible.map((template) => (
            <div
              key={template.id}
              className={`prompt-row ${template.id === activeId ? 'is-active' : ''}`}
              role="button"
              tabIndex={0}
              title={template.description}
              onClick={() => selectTemplate(template.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectTemplate(template.id);
                }
              }}
            >
              <div className="prompt-row__top">
                <span className="prompt-row__name">{template.name || '未命名模板'}</span>
                <span className={`prompt-row__kind ${template.wrap ? 'is-wrap' : ''}`}>
                  {template.wrap ? '包装' : '系统'}
                </span>
              </div>
              <div className="prompt-row__meta">
                <span className="prompt-row__en">{template.nameEn || '—'}</span>
                {template.tags.length > 0 && (
                  <span className="prompt-row__tags">{template.tags.join('、')}</span>
                )}
              </div>
              <button
                className="prompt-row__del"
                title="删除模板"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(template);
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
          {visible.length === 0 && <p className="prompts__empty">没有匹配的模板</p>}
        </div>

        <div className="prompts__list-foot">{visible.length} 个模板</div>
      </aside>

      {active ? (
        <section className="prompts__editor" ref={editorRef}>
          <div className="prompts__form">
            <div className="field-grid">
              <label className="field">
                <span className="field__label">名称 Name</span>
                <input
                  className="input"
                  value={active.name}
                  placeholder="模板名称"
                  onChange={(event) => patchActive({ name: event.target.value })}
                />
              </label>
              <div className="field">
                <span className="field__label">
                  <span>英文名 Name (EN)</span>
                  {generateButton('nameEn')}
                </span>
                <input
                  className="input"
                  value={active.nameEn}
                  placeholder="Meeting Notes"
                  onChange={(event) => patchActive({ nameEn: event.target.value })}
                />
              </div>
            </div>

            <div className="field-grid">
              <label className="field">
                <span className="field__label">描述 Description</span>
                <input
                  className="input"
                  value={active.description}
                  placeholder="一句话说明这个模板做什么"
                  onChange={(event) => patchActive({ description: event.target.value })}
                />
              </label>
              <div className="field">
                <span className="field__label">
                  <span>英文描述 Description (EN)</span>
                  {generateButton('descriptionEn')}
                </span>
                <input
                  className="input"
                  value={active.descriptionEn}
                  placeholder="One line about what this template does"
                  onChange={(event) => patchActive({ descriptionEn: event.target.value })}
                />
              </div>
            </div>

            <div className="field-grid">
              <div className="field">
                <span className="field__label">生效方式 Mode</span>
                <div className="input-row">
                  <select
                    className="select prompts__mode"
                    value={active.wrap ? 'wrap' : 'system'}
                    onChange={(event) => patchActive({ wrap: event.target.value === 'wrap' })}
                  >
                    <option value="system">系统指令 system</option>
                    <option value="wrap">包装消息 wrap</option>
                  </select>
                  <label className="prompts__check">
                    <input
                      type="checkbox"
                      checked={active.wrap}
                      onChange={(event) => patchActive({ wrap: event.target.checked })}
                    />
                    <span>包装消息 wrap</span>
                  </label>
                </div>
              </div>
              <label className="field">
                <span className="field__label">
                  标签 Tags <span className="field__hint">英文逗号分隔</span>
                </span>
                <input
                  className="input"
                  value={tagsText}
                  placeholder="写作, 协作"
                  onChange={(event) => updateTags(event.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span className="field__label">
                正文 Body
                <span className="field__hint">
                  {rendered.length} 字符～{renderedTokens} tokens
                </span>
              </span>
              <textarea
                className="input prompts__body"
                value={active.body}
                placeholder="在这里写提示词，用 {{变量名}} 引用变量"
                spellCheck={false}
                onChange={(event) => patchActive({ body: event.target.value })}
              />
            </label>

            <div className="field">
              <span className="field__label">
                <span>英文正文（可选）Body (EN, optional)</span>
                <span className="prompts__label-right">
                  <span className="field__hint">留空则回落到中文正文</span>
                  {generateButton('bodyEn')}
                </span>
              </span>
              <textarea
                className="input prompts__body prompts__body--en"
                value={active.bodyEn}
                placeholder="English version of the prompt body (optional)."
                spellCheck={false}
                onChange={(event) => patchActive({ bodyEn: event.target.value })}
              />
            </div>

            <div className="field">
              <span className="field__label">
                变量 Variables
                <span className="field__hint">{'写入 {{name}} 时按此处取值'}</span>
              </span>
              <div className="prompts__vars">
                {active.variables.map((variable, index) => (
                  <div className="prompts__var" key={index}>
                    <input
                      className="input"
                      value={variable.name}
                      placeholder="变量名"
                      spellCheck={false}
                      onChange={(event) => updateVariable(index, { name: event.target.value })}
                    />
                    <input
                      className="input"
                      value={variable.value}
                      placeholder="默认值"
                      spellCheck={false}
                      onChange={(event) => updateVariable(index, { value: event.target.value })}
                    />
                    <button
                      className="prompts__var-del"
                      title="删除变量"
                      onClick={() => removeVariable(index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="btn btn--ghost prompts__var-add" onClick={addVariable}>
                  <PlusIcon size={13} /> 添加变量
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="prompts__editor prompts__editor--empty">
          <p>还没有模板。</p>
          <button className="btn btn--primary" onClick={createTemplate}>
            <PlusIcon size={13} /> 新建模板
          </button>
        </section>
      )}

      <aside className="prompts__side">
        <div className="prompts__actions">
          <button
            className="btn btn--primary"
            onClick={saveVersion}
            disabled={!dirty}
            title={dirty ? '把当前内容保存为一个新版本' : '没有未保存的修改'}
          >
            <CheckIcon size={13} /> 保存
          </button>
          <button className="btn btn--ghost" onClick={() => void exportActive()} disabled={!active}>
            <DownloadIcon size={13} /> 导出
          </button>
          <button className="btn btn--ghost" onClick={() => void importTemplate()}>
            <UploadIcon size={13} /> 导入
          </button>
        </div>

        {active ? (
          <>
            <section className="prompts__card">
              <h3 className="prompts__card-title">
                注入预览 <span>PREVIEW</span>
              </h3>
              <pre className="prompts__preview">{rendered || '（正文为空）'}</pre>
            </section>

            <section className="prompts__card">
              <h3 className="prompts__card-title">
                详情 <span>DETAILS</span>
              </h3>
              <dl className="prompts__details">
                <div>
                  <dt>模式 Mode</dt>
                  <dd>{active.wrap ? '包装消息 wrap' : '系统指令 system'}</dd>
                </div>
                <div className="prompts__mode-note">
                  <p>
                    {active.wrap
                      ? '模板和你的输入拼成一条 user 消息发出，每条消息单独生效；适合「把下面内容加工成…」这类一次性任务。'
                      : '模板作为独立的 system 消息发出，对话每一轮都带着它；你的输入保持原样。适合角色、规则和输出格式。'}
                  </p>
                </div>
                <div>
                  <dt>估算 Tokens</dt>
                  <dd>{renderedTokens}</dd>
                </div>
                <div title="模板还没有接入对话请求">
                  <dt>使用会话 Sessions</dt>
                  <dd>0</dd>
                </div>
                <div>
                  <dt>更新 Updated</dt>
                  <dd>{formatTime(active.updatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="prompts__card">
              <h3 className="prompts__card-title">
                版本 <span>HISTORY</span>
              </h3>
              {active.history.length === 0 ? (
                <p className="prompts__hint">修改内容后点右上角「保存」，会把当前内容记为一个版本。</p>
              ) : (
                <ul className="prompts__history">
                  {active.history.map((version) => (
                    <li key={version.id}>
                      <span>{formatTime(version.at)}</span>
                      <span className="prompts__ver-actions">
                        <button
                          className="prompts__restore"
                          onClick={() => restoreVersion(version.id)}
                        >
                          恢复
                        </button>
                        <button
                          className="prompts__ver-del"
                          title="删除该版本"
                          onClick={() => deleteVersion(version.id)}
                        >
                          <TrashIcon size={11} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : (
          <p className="prompts__hint">左侧选择或新建一个模板。</p>
        )}
      </aside>

      {toast && <div className="prompts__toast">{toast}</div>}

      {pendingDelete && (
        <ConfirmDialog
          title="删除模板"
          message={`确定删除「${pendingDelete.name || '未命名模板'}」？模板和它的版本历史都会被移除，无法恢复。`}
          confirmLabel="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
