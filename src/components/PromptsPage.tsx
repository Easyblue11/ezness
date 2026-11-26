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
import { useI18n } from '../i18n';
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

/** Internal id for the "all tags" pill; its label comes from i18n. */
const ALL_TAG = '__all__';

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
  translate: (key: string) => string,
): Promise<string> {
  const api = window.ezness;
  if (!api) return Promise.reject(new Error(translate('prompts.error.windowUnavailable')));

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
      finish(new Error(translate('prompts.error.timeout')));
    }, GENERATE_TIMEOUT);

    unsubscribe = api.onChatEvent?.((event: ChatStreamEvent) => {
      if (event.requestId !== requestId) return;
      if (event.type === 'delta') {
        text += event.text ?? '';
        return;
      }
      if (event.type === 'thinking') return;
      if (event.type === 'done') finish(null, text);
      else if (event.type === 'aborted') finish(new Error(translate('prompts.error.aborted')));
      else finish(new Error(event.error || translate('prompts.error.unknown')));
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
        if (!ok) finish(new Error(translate('prompts.error.notSent')));
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
  const { t } = useI18n();
  const api = window.ezness;

  // 模板库只来自数据目录里的 prompts.json：没有就是空的，不带任何出厂模板。
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeId, setActiveId] = useState('');
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState(ALL_TAG);
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
    return [ALL_TAG, ...seen];
  }, [templates]);

  useEffect(() => {
    if (filterTag !== ALL_TAG && !tagOptions.includes(filterTag)) setFilterTag(ALL_TAG);
  }, [filterTag, tagOptions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (filterTag !== ALL_TAG && !template.tags.includes(filterTag)) return false;
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
          .map((entry) => normalizeTemplate(entry, t('prompts.untitled')))
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
    showToast(t('prompts.toast.saved'));
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
    showToast(t('prompts.toast.versionDeleted'));
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
    const template = createBlankTemplate(t('prompts.untitled'));
    setTemplates((current) => [template, ...current]);
    setActiveId(template.id);
    setTagDraft({ id: '', text: '' });
    setFilterTag(ALL_TAG);
    setQuery('');
    showToast(t('prompts.toast.created'));
  }

  function confirmDelete() {
    const template = pendingDelete;
    if (!template) return;
    setPendingDelete(null);
    const rest = templates.filter((entry) => entry.id !== template.id);
    setTemplates(rest);
    if (template.id === activeId) setActiveId(rest[0]?.id ?? '');
    setTagDraft({ id: '', text: '' });
    showToast(t('prompts.toast.templateDeleted'));
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
    showToast(t('prompts.toast.restored'));
  }

  async function generateEnglish(kind: GenerationKind) {
    if (!active || !translationTarget || generating) return;
    const templateId = active.id;
    const source =
      kind === 'nameEn' ? active.name : kind === 'descriptionEn' ? active.description : active.body;
    if (!source.trim()) {
      showToast(t('prompts.toast.needChinese'));
      return;
    }

    const requestId = uid();
    generation.current = { requestId };
    setGenerating(kind);
    try {
      const raw = await translateToEnglish(translationTarget, kind, source, requestId, t);
      const text = tidyTranslation(raw, kind);
      if (!text) throw new Error(t('prompts.error.emptyModel'));
      if (kind === 'bodyEn') {
        const got = placeholderNames(text);
        const missing = [...placeholderNames(source)].filter((name) => !got.has(name));
        if (missing.length > 0) {
          throw new Error(
            t('prompts.error.missingVars', {
              vars: missing.map((name) => `{{${name}}}`).join(', '),
            }),
          );
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
      showToast(t('prompts.toast.generated'));
    } catch (error) {
      showToast(
        t('prompts.toast.generatedError', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
            ? t('prompts.gen.noModel')
            : !source.trim()
              ? t('prompts.gen.needSource')
              : t('prompts.gen.hint')
        }
        onClick={() => void generateEnglish(kind)}
      >
        <SparkleIcon size={12} />
        {busy ? t('prompts.gen.busy') : t('prompts.gen.label')}
      </button>
    );
  }

  async function exportActive() {
    if (!active) return;
    if (!api?.promptsExport) {
      showToast(t('prompts.toast.exportUnsupported'));
      return;
    }
    const result = await api.promptsExport({ template: active });
    if (result.ok) {
      showToast(
        t('prompts.toast.exported', { path: result.path ?? t('prompts.fileFallback') }),
      );
    } else if (!result.canceled) {
      showToast(
        t('prompts.toast.exportFailed', { error: result.error ?? t('prompts.error.unknown') }),
      );
    }
  }

  async function importTemplate() {
    if (!api?.promptsImport) {
      showToast(t('prompts.toast.importUnsupported'));
      return;
    }
    const result = await api.promptsImport();
    if (!result.ok) {
      if (!result.canceled) {
        showToast(
          t('prompts.toast.importFailed', { error: result.error ?? t('prompts.error.unknown') }),
        );
      }
      return;
    }

    const template = normalizeTemplate(result.data, t('prompts.untitled'));
    if (!template) {
      showToast(t('prompts.toast.importEmpty'));
      return;
    }
    // A file exported from this machine carries its original id; importing it
    // back should add a copy rather than silently shadow the existing template.
    if (templates.some((entry) => entry.id === template.id)) {
      template.id = uid();
      template.name = t('prompts.importedName', { name: template.name });
    }

    setTemplates((current) => [template, ...current]);
    setActiveId(template.id);
    setTagDraft({ id: '', text: '' });
    setFilterTag(ALL_TAG);
    setQuery('');
    showToast(t('prompts.toast.imported', { name: template.name || t('prompts.untitled') }));
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
            {t('prompts.title')} <span>Prompt Templates</span>
          </h1>
          <p>{t('prompts.subtitle')}</p>

          <button className="btn btn--primary prompts__new" onClick={createTemplate}>
            <PlusIcon size={13} /> {t('prompts.new')}
          </button>

          <div className="prompts__search">
            <SearchIcon size={14} />
            <input
              className="input"
              value={query}
              placeholder={t('prompts.searchPlaceholder')}
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
                {tag === ALL_TAG ? t('prompts.allTag') : tag}
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
                <span className="prompt-row__name">
                  {template.name || t('prompts.untitled')}
                </span>
                <span className={`prompt-row__kind ${template.wrap ? 'is-wrap' : ''}`}>
                  {template.wrap ? t('prompts.kind.wrap') : t('prompts.kind.system')}
                </span>
              </div>
              <div className="prompt-row__meta">
                <span className="prompt-row__en">{template.nameEn || '—'}</span>
                {template.tags.length > 0 && (
                  <span className="prompt-row__tags">
                    {template.tags.join(t('prompts.tagSeparator'))}
                  </span>
                )}
              </div>
              <button
                className="prompt-row__del"
                title={t('prompts.delete')}
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingDelete(template);
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
          {visible.length === 0 && (
            <p className="prompts__empty">{t('prompts.empty')}</p>
          )}
        </div>

        <div className="prompts__list-foot">
          {t('prompts.count', { count: visible.length })}
        </div>
      </aside>

      {active ? (
        <section className="prompts__editor" ref={editorRef}>
          <div className="prompts__form">
            <div className="field-grid">
              <label className="field">
                <span className="field__label">{t('prompts.nameLabel')}</span>
                <input
                  className="input"
                  value={active.name}
                  placeholder={t('prompts.namePlaceholder')}
                  onChange={(event) => patchActive({ name: event.target.value })}
                />
              </label>
              <div className="field">
                <span className="field__label">
                  <span>{t('prompts.nameEnLabel')}</span>
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
                <span className="field__label">{t('prompts.descLabel')}</span>
                <input
                  className="input"
                  value={active.description}
                  placeholder={t('prompts.descPlaceholder')}
                  onChange={(event) => patchActive({ description: event.target.value })}
                />
              </label>
              <div className="field">
                <span className="field__label">
                  <span>{t('prompts.descEnLabel')}</span>
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
                <span className="field__label">{t('prompts.modeLabel')}</span>
                <div className="input-row">
                  <select
                    className="select prompts__mode"
                    value={active.wrap ? 'wrap' : 'system'}
                    onChange={(event) => patchActive({ wrap: event.target.value === 'wrap' })}
                  >
                    <option value="system">{t('prompts.mode.systemOption')}</option>
                    <option value="wrap">{t('prompts.mode.wrapOption')}</option>
                  </select>
                  <label className="prompts__check">
                    <input
                      type="checkbox"
                      checked={active.wrap}
                      onChange={(event) => patchActive({ wrap: event.target.checked })}
                    />
                    <span>{t('prompts.mode.wrapCheck')}</span>
                  </label>
                </div>
              </div>
              <label className="field">
                <span className="field__label">
                  {t('prompts.tagsLabel')}{' '}
                  <span className="field__hint">{t('prompts.tagsHint')}</span>
                </span>
                <input
                  className="input"
                  value={tagsText}
                  placeholder={t('prompts.tagsPlaceholder')}
                  onChange={(event) => updateTags(event.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span className="field__label">
                {t('prompts.bodyLabel')}
                <span className="field__hint">
                  {t('prompts.bodyMeta', {
                    chars: rendered.length,
                    tokens: renderedTokens,
                  })}
                </span>
              </span>
              <textarea
                className="input prompts__body"
                value={active.body}
                placeholder={t('prompts.bodyPlaceholder')}
                spellCheck={false}
                onChange={(event) => patchActive({ body: event.target.value })}
              />
            </label>

            <div className="field">
              <span className="field__label">
                <span>{t('prompts.bodyEnLabel')}</span>
                <span className="prompts__label-right">
                  <span className="field__hint">{t('prompts.bodyEnHint')}</span>
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
                {t('prompts.varsLabel')}
                <span className="field__hint">{t('prompts.varsHint')}</span>
              </span>
              <div className="prompts__vars">
                {active.variables.map((variable, index) => (
                  <div className="prompts__var" key={index}>
                    <input
                      className="input"
                      value={variable.name}
                      placeholder={t('prompts.varNamePlaceholder')}
                      spellCheck={false}
                      onChange={(event) => updateVariable(index, { name: event.target.value })}
                    />
                    <input
                      className="input"
                      value={variable.value}
                      placeholder={t('prompts.varValuePlaceholder')}
                      spellCheck={false}
                      onChange={(event) => updateVariable(index, { value: event.target.value })}
                    />
                    <button
                      className="prompts__var-del"
                      title={t('prompts.removeVar')}
                      onClick={() => removeVariable(index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="btn btn--ghost prompts__var-add" onClick={addVariable}>
                  <PlusIcon size={13} /> {t('prompts.addVar')}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="prompts__editor prompts__editor--empty">
          <p>{t('prompts.editorEmpty')}</p>
          <button className="btn btn--primary" onClick={createTemplate}>
            <PlusIcon size={13} /> {t('prompts.new')}
          </button>
        </section>
      )}

      <aside className="prompts__side">
        <div className="prompts__actions">
          <button
            className="btn btn--primary"
            onClick={saveVersion}
            disabled={!dirty}
            title={dirty ? t('prompts.saveTitle') : t('prompts.saveClean')}
          >
            <CheckIcon size={13} /> {t('prompts.save')}
          </button>
          <button className="btn btn--ghost" onClick={() => void exportActive()} disabled={!active}>
            <DownloadIcon size={13} /> {t('prompts.export')}
          </button>
          <button className="btn btn--ghost" onClick={() => void importTemplate()}>
            <UploadIcon size={13} /> {t('prompts.import')}
          </button>
        </div>

        {active ? (
          <>
            <section className="prompts__card">
              <h3 className="prompts__card-title">
                {t('prompts.previewTitle')} <span>PREVIEW</span>
              </h3>
              <pre className="prompts__preview">
                {rendered || t('prompts.previewEmpty')}
              </pre>
            </section>

            <section className="prompts__card">
              <h3 className="prompts__card-title">
                {t('prompts.detailsTitle')} <span>DETAILS</span>
              </h3>
              <dl className="prompts__details">
                <div>
                  <dt>{t('prompts.detailsMode')}</dt>
                  <dd>
                    {active.wrap
                      ? t('prompts.detailsModeValue.wrap')
                      : t('prompts.detailsModeValue.system')}
                  </dd>
                </div>
                <div className="prompts__mode-note">
                  <p>
                    {active.wrap
                      ? t('prompts.modeNote.wrap')
                      : t('prompts.modeNote.system')}
                  </p>
                </div>
                <div>
                  <dt>{t('prompts.detailsTokens')}</dt>
                  <dd>{renderedTokens}</dd>
                </div>
                <div title={t('prompts.sessionsHint')}>
                  <dt>{t('prompts.detailsSessions')}</dt>
                  <dd>0</dd>
                </div>
                <div>
                  <dt>{t('prompts.detailsUpdated')}</dt>
                  <dd>{formatTime(active.updatedAt)}</dd>
                </div>
              </dl>
            </section>

            <section className="prompts__card">
              <h3 className="prompts__card-title">
                {t('prompts.historyTitle')} <span>HISTORY</span>
              </h3>
              {active.history.length === 0 ? (
                <p className="prompts__hint">{t('prompts.historyEmpty')}</p>
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
                          {t('prompts.restore')}
                        </button>
                        <button
                          className="prompts__ver-del"
                          title={t('prompts.deleteVersion')}
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
          <p className="prompts__hint">{t('prompts.sideHint')}</p>
        )}
      </aside>

      {toast && <div className="prompts__toast">{toast}</div>}

      {pendingDelete && (
        <ConfirmDialog
          title={t('prompts.confirm.deleteTitle')}
          message={t('prompts.confirm.deleteMessage', {
            name: pendingDelete.name || t('prompts.untitled'),
          })}
          confirmLabel={t('prompts.confirm.deleteLabel')}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
