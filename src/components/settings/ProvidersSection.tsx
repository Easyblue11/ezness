import { useState } from 'react';
import { OLLAMA_DOWNLOAD_URL, PROVIDER_PRESETS, presetForProvider } from '../../data/providers';
import type { ApiType, ProviderConfig, ProviderPreset } from '../../types';
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PlugIcon,
  RefreshIcon,
  TrashIcon,
} from '../Icons';

type Status = { state: 'idle' | 'loading' | 'ok' | 'error'; text?: string };

const API_TYPE_LABEL: Record<ApiType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic Messages',
  ollama: 'Ollama 原生',
};

interface Props {
  providers: Record<string, ProviderConfig>;
  onChange: (id: string, patch: Partial<ProviderConfig>) => void;
  onRemove: (id: string) => void;
}

export function ProvidersSection({ providers, onChange, onRemove }: Props) {
  const [activeId, setActiveId] = useState('');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [showKey, setShowKey] = useState(false);
  const [draftModel, setDraftModel] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  // 右边临时切成厂家目录，选完一个再回到配置表单。
  const [picking, setPicking] = useState(false);

  // 出厂不带任何接入：左边只有用户自己加的那些，一条都没有时右边显示空态。
  const entries = Object.values(providers);
  const config: ProviderConfig | null =
    (activeId ? providers[activeId] : undefined) ?? entries[0] ?? null;
  const keyOptional = config?.apiType === 'ollama';
  const configPreset = config ? presetForProvider(config) : undefined;

  function selectProvider(id: string) {
    setActiveId(id);
    setStatus({ state: 'idle' });
    setShowKey(false);
    setDraftModel('');
    setPicking(false);
  }

  function addProvider() {
    let index = 2;
    while (providers[`custom-${index}`]) index += 1;
    const id = `custom-${index}`;
    onChange(id, {
      name: `自定义接入 ${index}`,
      apiType: 'openai',
      baseUrl: '',
      apiKey: '',
      models: [],
    });
    selectProvider(id);
  }

  /** 按目录建一条：地址和接口类型照抄，密钥和模型留给用户。 */
  function addPreset(preset: ProviderPreset) {
    if (preset.editable) {
      addProvider();
      return;
    }
    // 同一家已经加过就直接打开它，免得列表里出现两条一样的。
    const existing = entries.find((item) => presetForProvider(item)?.id === preset.id);
    if (existing) {
      selectProvider(existing.id);
      return;
    }

    const taken = new Set(entries.map((item) => item.name));
    let name = preset.name;
    for (let index = 2; taken.has(name); index += 1) name = `${preset.name} ${index}`;

    let id = preset.id;
    for (let index = 2; providers[id]; index += 1) id = `${preset.id}-${index}`;

    onChange(id, {
      name,
      apiType: preset.apiType,
      baseUrl: preset.baseUrl,
      apiKey: '',
      models: [],
    });
    selectProvider(id);
  }

  function removeProvider() {
    if (!config) return;
    if (!window.confirm(`删除「${config.name}」？这个接入的地址、密钥和模型都会一起移除。`)) return;
    onRemove(config.id);
    selectProvider('');
  }

  async function handleFetchModels() {
    if (!config) return;
    if (!config.baseUrl.trim()) {
      setStatus({ state: 'error', text: '请先填写 API 地址' });
      return;
    }
    if (!window.ezness) {
      setStatus({ state: 'error', text: '获取模型只在桌面端可用' });
      return;
    }

    setStatus({ state: 'loading', text: '正在请求模型列表…' });
    const result = await window.ezness.fetchModels({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiType: config.apiType,
    });

    if (result.ok && result.models) {
      onChange(config.id, { models: result.models });
      setStatus({
        state: 'ok',
        text: result.models.length ? `已获取 ${result.models.length} 个模型` : '连接成功，但接口没有返回模型',
      });
    } else {
      setStatus({ state: 'error', text: result.error ?? '获取失败' });
    }
  }

  function addModel() {
    if (!config) return;
    const name = draftModel.trim();
    if (!name) return;
    if (!config.models.includes(name)) {
      onChange(config.id, { models: [...config.models, name] });
    }
    setDraftModel('');
  }

  function removeModel(model: string) {
    if (!config) return;
    onChange(config.id, { models: config.models.filter((item) => item !== model) });
  }

  async function copyDownloadLink() {
    try {
      if (window.ezness?.copyText) await window.ezness.copyText(OLLAMA_DOWNLOAD_URL);
      else await navigator.clipboard.writeText(OLLAMA_DOWNLOAD_URL);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1400);
    } catch {
      /* clipboard unavailable — leave the button silent */
    }
  }

  return (
    <div className="providers">
      <aside className="providers__list">
        {entries.map((item) => (
          <button
            key={item.id}
            className={`provider-item ${item.id === config?.id ? 'is-active' : ''}`}
            onClick={() => selectProvider(item.id)}
          >
            <span className="provider-badge">{presetForProvider(item)?.initials ?? (item.apiType === 'ollama' ? 'OL' : '＋')}</span>
            <span className="provider-item__name">{item.name}</span>
            {item.models.length > 0 && <span className="provider-item__dot" />}
          </button>
        ))}
        <button
          type="button"
          className={`provider-item provider-item--add ${picking ? 'is-active' : ''}`}
          onClick={() => {
            setStatus({ state: 'idle' });
            setPicking(true);
          }}
          title="新增一个模型接入"
        >
          <span className="provider-badge">＋</span>
          <span className="provider-item__name">新增接入</span>
        </button>
      </aside>

      {picking && (
        <section className="config">
          <header className="config__head">
            <div>
              <div className="config__title">选择厂家</div>
              <div className="config__desc">
                地址和接口类型已经按厂家填好，你只要补上密钥、再获取模型。都不合适就选「自定义接入」。
              </div>
            </div>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPicking(false)}>
              取消
            </button>
          </header>
          <div className="preset-grid">
            {PROVIDER_PRESETS.map((preset) => {
              const added = preset.baseUrl
                ? entries.some((item) => presetForProvider(item)?.id === preset.id)
                : false;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`preset-card ${preset.editable ? 'preset-card--custom' : ''}`}
                  onClick={() => addPreset(preset)}
                >
                  <span className="provider-badge">{preset.initials}</span>
                  <span className="preset-card__body">
                    <span className="preset-card__name">
                      {preset.name}
                      {added && <span className="preset-card__tag">已添加</span>}
                    </span>
                    <span className="preset-card__url">{preset.baseUrl || '自己填地址'}</span>
                    <span className="preset-card__desc">{preset.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!picking && !config && (
        <section className="config">
          <header className="config__head">
            <div>
              <div className="config__title">还没有模型接入</div>
              <div className="config__desc">
                点左边的「新增接入」，从厂家列表里挑一个——地址已经填好，补上密钥和模型就能用；
                也可以选「自定义接入」，地址、密钥全自己填。这里不预置任何密钥或模型。
              </div>
            </div>
          </header>
          <div className="config__download">
            <span>
              想在本机跑模型？先装 Ollama：
              <a className="config__download-link" href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                {OLLAMA_DOWNLOAD_URL}
              </a>
            </span>
            <button
              type="button"
              className={`iconbtn iconbtn--bordered ${linkCopied ? 'is-copied' : ''}`}
              title={linkCopied ? '已复制' : '复制下载链接'}
              aria-label="复制 Ollama 下载链接"
              onClick={copyDownloadLink}
            >
              {linkCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
          </div>
        </section>
      )}

      {!picking && config && (
      <section className="config">
        <header className="config__head">
          <div>
            <div className="config__title">{config.name}</div>
            <div className="config__desc">
              {configPreset?.description ??
                (config.apiType === 'ollama' ? '本机运行的模型，不用密钥' : '自定义接入，自己填地址、密钥和模型')}
            </div>
          </div>
          <div className="config__head-actions">
            {config.models.length > 0 && (
              <span className="pill">
                <CheckIcon size={12} /> {config.models.length} 个模型
              </span>
            )}
            <button
              type="button"
              className="iconbtn"
              title="删除这个接入"
              aria-label="删除这个接入"
              onClick={removeProvider}
            >
              <TrashIcon size={15} />
            </button>
          </div>
        </header>

        {config.apiType === 'ollama' && (
          <div className="config__download">
            <span>
              还没装 Ollama？先装上它，模型都在本机跑：
              <a className="config__download-link" href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                {OLLAMA_DOWNLOAD_URL}
              </a>
            </span>
            <button
              type="button"
              className={`iconbtn iconbtn--bordered ${linkCopied ? 'is-copied' : ''}`}
              title={linkCopied ? '已复制' : '复制下载链接'}
              aria-label="复制 Ollama 下载链接"
              onClick={copyDownloadLink}
            >
              {linkCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
          </div>
        )}

        <div className="field-grid">
          <label className="field">
            <span className="field__label">名称</span>
            <input
              className="input"
              value={config.name}
              placeholder="给这个接入起个名字"
              onChange={(event) => onChange(config.id, { name: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">接口类型</span>
            <select
              className="select"
              value={config.apiType}
              onChange={(event) => onChange(config.id, { apiType: event.target.value as ApiType })}
            >
              {(Object.keys(API_TYPE_LABEL) as ApiType[]).map((type) => (
                <option key={type} value={type}>
                  {API_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field__label">API 地址</span>
          <input
            className="input"
            value={config.baseUrl}
            spellCheck={false}
            placeholder={keyOptional ? 'http://localhost:11434' : 'https://api.example.com/v1'}
            onChange={(event) => onChange(config.id, { baseUrl: event.target.value })}
          />
        </label>

        <label className="field">
          <span className="field__label">
            密钥
            {keyOptional && <span className="field__hint">可选 · 本地模型通常不需要</span>}
          </span>
          <div className="input-row">
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              value={config.apiKey}
              spellCheck={false}
              placeholder={keyOptional ? '留空即可' : 'sk-...'}
              onChange={(event) => onChange(config.id, { apiKey: event.target.value })}
            />
            <button className="iconbtn iconbtn--bordered" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey((v) => !v)}>
              {showKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>
        </label>

        <div className="field">
          <span className="field__label">
            模型
            <span className="field__hint">可以自动获取，也可以手动添加</span>
          </span>

          <div className="chips">
            {config.models.length === 0 && <span className="chips__empty">还没有模型</span>}
            {config.models.map((model) => (
              <span key={model} className="model-chip">
                {model}
                <button title="移除" onClick={() => removeModel(model)}>
                  <TrashIcon size={12} />
                </button>
              </span>
            ))}
          </div>

          <div className="input-row" style={{ marginTop: 10 }}>
            <input
              className="input"
              value={draftModel}
              spellCheck={false}
              placeholder="手动输入模型名，回车添加"
              onChange={(event) => setDraftModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
            <button className="btn" onClick={addModel} disabled={!draftModel.trim()}>
              添加
            </button>
          </div>
        </div>

        <footer className="config__foot">
          <div className="config__actions">
            <button className="btn btn--primary" onClick={handleFetchModels} disabled={status.state === 'loading'}>
              <RefreshIcon size={14} />
              {status.state === 'loading' ? '获取中…' : '获取模型'}
            </button>
            <button className="btn btn--ghost" onClick={() => setStatus({ state: 'idle' })}>
              清除状态
            </button>
          </div>

          {status.state !== 'idle' && (
            <span
              className={`status ${status.state === 'error' ? 'status--error' : ''} ${
                status.state === 'ok' ? 'status--ok' : ''
              }`}
            >
              {status.state === 'loading' && <PlugIcon size={13} />}
              {status.text}
            </span>
          )}
        </footer>
      </section>
      )}
    </div>
  );
}
