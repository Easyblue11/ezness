import { useState } from 'react';
import { OLLAMA_DOWNLOAD_URL, PROVIDER_PRESETS, presetForProvider } from '../../data/providers';
import { useI18n } from '../../i18n';
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

const API_TYPE_KEY: Record<ApiType, string> = {
  openai: 'settings.providers.api.openai',
  anthropic: 'settings.providers.api.anthropic',
  ollama: 'settings.providers.api.ollama',
};

interface Props {
  providers: Record<string, ProviderConfig>;
  onChange: (id: string, patch: Partial<ProviderConfig>) => void;
  onRemove: (id: string) => void;
}

export function ProvidersSection({ providers, onChange, onRemove }: Props) {
  const { t } = useI18n();
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
      name: t('settings.providers.customName', { index }),
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
    const presetName =
      preset.id === 'custom' ? t('settings.providers.customPresetName') : preset.name;
    let name = presetName;
    for (let index = 2; taken.has(name); index += 1) name = `${presetName} ${index}`;

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
    if (!window.confirm(t('settings.providers.removeConfirm', { name: config.name }))) return;
    onRemove(config.id);
    selectProvider('');
  }

  async function handleFetchModels() {
    if (!config) return;
    if (!config.baseUrl.trim()) {
      setStatus({ state: 'error', text: t('settings.providers.error.baseUrl') });
      return;
    }
    if (!window.ezness) {
      setStatus({ state: 'error', text: t('settings.providers.error.desktopOnly') });
      return;
    }

    setStatus({ state: 'loading', text: t('settings.providers.status.loading') });
    const result = await window.ezness.fetchModels({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiType: config.apiType,
    });

    if (result.ok && result.models) {
      onChange(config.id, { models: result.models });
      setStatus({
        state: 'ok',
        text: result.models.length
          ? t('settings.providers.status.count', { count: result.models.length })
          : t('settings.providers.status.empty'),
      });
    } else {
      setStatus({ state: 'error', text: result.error ?? t('settings.providers.error.fetch') });
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
          title={t('settings.providers.add.title')}
        >
          <span className="provider-badge">＋</span>
          <span className="provider-item__name">{t('settings.providers.add.label')}</span>
        </button>
      </aside>

      {picking && (
        <section className="config">
          <header className="config__head">
            <div>
              <div className="config__title">{t('settings.providers.pick.title')}</div>
              <div className="config__desc">{t('settings.providers.pick.desc')}</div>
            </div>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPicking(false)}>
              {t('settings.providers.cancel')}
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
                      {preset.id === 'custom'
                        ? t('settings.providers.customPresetName')
                        : preset.name}
                      {added && (
                        <span className="preset-card__tag">{t('settings.providers.added')}</span>
                      )}
                    </span>
                    <span className="preset-card__url">
                      {preset.baseUrl || t('settings.providers.customUrl')}
                    </span>
                    <span className="preset-card__desc">{t(preset.description)}</span>
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
              <div className="config__title">{t('settings.providers.empty.title')}</div>
              <div className="config__desc">{t('settings.providers.empty.desc')}</div>
            </div>
          </header>
          <div className="config__download">
            <span>
              {t('settings.providers.ollama.intro')}
              <a className="config__download-link" href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                {OLLAMA_DOWNLOAD_URL}
              </a>
            </span>
            <button
              type="button"
              className={`iconbtn iconbtn--bordered ${linkCopied ? 'is-copied' : ''}`}
              title={
                linkCopied ? t('settings.providers.copied') : t('settings.providers.copyLink')
              }
              aria-label={t('settings.providers.copyAria')}
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
              {configPreset?.description
                ? t(configPreset.description)
                : config.apiType === 'ollama'
                  ? t('settings.providers.fallback.ollama')
                  : t('settings.providers.fallback.custom')}
            </div>
          </div>
          <div className="config__head-actions">
            {config.models.length > 0 && (
              <span className="pill">
                <CheckIcon size={12} />{' '}
                {t('settings.providers.modelCount', { count: config.models.length })}
              </span>
            )}
            <button
              type="button"
              className="iconbtn"
              title={t('settings.providers.remove.title')}
              aria-label={t('settings.providers.remove.title')}
              onClick={removeProvider}
            >
              <TrashIcon size={15} />
            </button>
          </div>
        </header>

        {config.apiType === 'ollama' && (
          <div className="config__download">
            <span>
              {t('settings.providers.ollama.configIntro')}
              <a className="config__download-link" href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                {OLLAMA_DOWNLOAD_URL}
              </a>
            </span>
            <button
              type="button"
              className={`iconbtn iconbtn--bordered ${linkCopied ? 'is-copied' : ''}`}
              title={
                linkCopied ? t('settings.providers.copied') : t('settings.providers.copyLink')
              }
              aria-label={t('settings.providers.copyAria')}
              onClick={copyDownloadLink}
            >
              {linkCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            </button>
          </div>
        )}

        <div className="field-grid">
          <label className="field">
            <span className="field__label">{t('settings.providers.field.name')}</span>
            <input
              className="input"
              value={config.name}
              placeholder={t('settings.providers.field.namePlaceholder')}
              onChange={(event) => onChange(config.id, { name: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('settings.providers.field.apiType')}</span>
            <select
              className="select"
              value={config.apiType}
              onChange={(event) => onChange(config.id, { apiType: event.target.value as ApiType })}
            >
              {(Object.keys(API_TYPE_KEY) as ApiType[]).map((type) => (
                <option key={type} value={type}>
                  {t(API_TYPE_KEY[type])}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field__label">{t('settings.providers.field.baseUrl')}</span>
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
            {t('settings.providers.field.key')}
            {keyOptional && (
              <span className="field__hint">{t('settings.providers.field.keyOptional')}</span>
            )}
          </span>
          <div className="input-row">
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              value={config.apiKey}
              spellCheck={false}
              placeholder={
                keyOptional
                  ? t('settings.providers.field.keyPlaceholderOptional')
                  : 'sk-...'
              }
              onChange={(event) => onChange(config.id, { apiKey: event.target.value })}
            />
            <button
              className="iconbtn iconbtn--bordered"
              title={showKey ? t('settings.providers.hide') : t('settings.providers.show')}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </div>
        </label>

        <div className="field">
          <span className="field__label">
            {t('settings.providers.field.models')}
            <span className="field__hint">{t('settings.providers.field.modelsHint')}</span>
          </span>

          <div className="chips">
            {config.models.length === 0 && (
              <span className="chips__empty">{t('settings.providers.models.empty')}</span>
            )}
            {config.models.map((model) => (
              <span key={model} className="model-chip">
                {model}
                <button
                  title={t('settings.providers.models.remove')}
                  onClick={() => removeModel(model)}
                >
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
              placeholder={t('settings.providers.models.addPlaceholder')}
              onChange={(event) => setDraftModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addModel();
                }
              }}
            />
            <button className="btn" onClick={addModel} disabled={!draftModel.trim()}>
              {t('settings.providers.add')}
            </button>
          </div>
        </div>

        <footer className="config__foot">
          <div className="config__actions">
            <button className="btn btn--primary" onClick={handleFetchModels} disabled={status.state === 'loading'}>
              <RefreshIcon size={14} />
              {status.state === 'loading'
                ? t('settings.providers.fetch.loading')
                : t('settings.providers.fetch.button')}
            </button>
            <button className="btn btn--ghost" onClick={() => setStatus({ state: 'idle' })}>
              {t('settings.providers.clearStatus')}
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
