import { useCallback, useEffect, useState } from 'react';
import type { CloseAction, StorageInfo, WorkSettings } from '../../types';
import { useI18n } from '../../i18n';
import {
  BillingIcon,
  CloseIcon,
  FolderIcon,
  GlobeIcon,
  RefreshIcon,
  SettingsIcon,
} from '../Icons';
import { ContextSettings } from './ContextSettings';

interface Props {
  work: WorkSettings;
  onWorkChange: (work: WorkSettings) => void;
  rmbAnimation: boolean;
  onRmbAnimationChange: (on: boolean) => void;
  closeAction: CloseAction;
  onCloseActionChange: (action: CloseAction) => void;
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function SystemSection({
  work,
  onWorkChange,
  rmbAnimation,
  onRmbAnimationChange,
  closeAction,
  onCloseActionChange,
}: Props) {
  const { t, language, setLanguage, languages, errors, loading, refresh: refreshPacks, openFolder } =
    useI18n();
  const api = window.ezness;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await api?.storageInfo();
    if (next) setInfo(next);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openRoot() {
    const result = await api?.storageOpenRoot();
    if (result && !result.ok) setError(result.error ?? t('system.storage.openError'));
  }

  async function openLanguageFolder() {
    const result = await openFolder();
    if (!result.ok) setError(result.error ?? t('system.language.openError'));
  }

  async function changeRoot() {
    if (!api || migrating) return;
    setError(null);

    const target = await api.storagePickRoot();
    if (!target) return;
    if (info && target.toLowerCase() === info.root.toLowerCase()) return;

    if (!window.confirm(t('system.storage.migrateConfirm', { path: target }))) return;

    setMigrating(true);
    const result = await api.storageMigrateRoot(target);
    setMigrating(false);

    if (!result?.ok) {
      setError(result?.error ?? t('system.storage.migrateError'));
      return;
    }
    if (result.info) setInfo(result.info);
  }

  const stats = info?.stats;
  const total = stats
    ? stats.ragBytes + stats.warehouseDirBytes + stats.voiceBytes + stats.configBytes
    : 0;

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('system.title')}</h2>
          <p>{t('system.subtitle')}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refresh()} disabled={migrating}>
          <RefreshIcon size={14} />
          {t('system.refresh')}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <GlobeIcon size={15} />
          {t('system.language.title')}
          {/^zh/i.test(language) && (
            <span className="kb-card__title-en">{t('system.language.titleEn')}</span>
          )}
        </div>
        <p className="kb-card__desc">{t('system.language.desc')}</p>
        <div className="kb-card__row">
          <select
            className="select select--inline"
            aria-label={t('system.language.label')}
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {languages.map((option) => (
              <option key={option.code} value={option.code}>
                {option.nativeName}
                {option.name && option.name !== option.nativeName ? ` · ${option.name}` : ''}
                {option.custom ? ` · ${t('system.language.customTag')}` : ''}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void openLanguageFolder()}>
            {t('system.language.open')}
          </button>
          <button className="btn btn--ghost" disabled={loading} onClick={() => void refreshPacks()}>
            <RefreshIcon size={14} />
            {t('system.language.refresh')}
          </button>
        </div>
        <div className="field__hint">{t('system.language.hint')}</div>
        {errors.length > 0 && (
          <div className="notice notice--warn">
            {t('system.language.errors', {
              count: errors.length,
              files: errors.map((item) => item.file).join(', '),
            })}
          </div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <CloseIcon size={15} />
          {t('system.close.title')}
        </div>
        <p className="kb-card__desc">{t('system.close.desc')}</p>
        <div className="kb-card__row">
          <select
            className="select select--inline"
            aria-label={t('system.close.label')}
            value={closeAction}
            onChange={(event) => onCloseActionChange(event.target.value as CloseAction)}
          >
            <option value="">{t('system.close.ask')}</option>
            <option value="tray">{t('system.close.tray')}</option>
            <option value="quit">{t('system.close.quit')}</option>
          </select>
        </div>
        <div className="field__hint">{t('system.close.hint')}</div>
      </section>

      <ContextSettings work={work} onChange={onWorkChange} />

      <section className="kb-card">
        <div className="kb-card__title">
          <BillingIcon size={15} />
          {t('system.rmb.title')}
        </div>
        <p className="kb-card__desc">{t('system.rmb.desc')}</p>
        <div className="kb-card__row work-row">
          <button
            className={`switch ${rmbAnimation ? 'is-on' : ''}`}
            role="switch"
            aria-checked={rmbAnimation}
            aria-label={t('system.rmb.aria')}
            title={rmbAnimation ? t('system.rmb.onTitle') : t('system.rmb.offTitle')}
            onClick={() => onRmbAnimationChange(!rmbAnimation)}
          >
            <span />
          </button>
          <span className="kb-card__meta">
            {rmbAnimation ? t('system.rmb.on') : t('system.rmb.off')}
          </span>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <FolderIcon size={15} />
          {t('system.storage.title')}
        </div>
        <p className="kb-card__desc">{t('system.storage.desc')}</p>
        <div className="kb-card__row">
          <input className="input" readOnly value={info?.root ?? t('system.storage.reading')} />
          <button className="btn" disabled={migrating} onClick={() => void openRoot()}>
            {t('system.storage.open')}
          </button>
          <button className="btn btn--primary" disabled={migrating} onClick={() => void changeRoot()}>
            {migrating ? t('system.storage.migrating') : t('system.storage.change')}
          </button>
        </div>
        {error && <div className="notice notice--warn">{error}</div>}
        {stats && (
          <div className="kb-card__meta">
            {t('system.storage.totalInfo', {
              total: formatSize(total),
              rag: formatSize(stats.ragBytes),
              files: stats.kbDocuments,
              chunks: stats.kbChunks,
              warehouse: formatSize(stats.warehouseDirBytes),
              count: stats.warehouseFiles,
              voiceReady: t(
                stats.voiceReady ? 'system.storage.voiceReady' : 'system.storage.voiceMissing',
              ),
              voiceSize: formatSize(stats.voiceBytes),
            })}
          </div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <SettingsIcon size={15} />
          {t('system.tree.title')}
        </div>
        <p className="kb-card__desc">{t('system.tree.desc')}</p>
        <div className="storage-tree">
          <div className="storage-tree__row">
            <code>ezrag\</code>
            <span>{t('system.tree.rag')}</span>
          </div>
          <div className="storage-tree__row">
            <code>ezstorge\</code>
            <span>{t('system.tree.warehouse')}</span>
          </div>
          <div className="storage-tree__row">
            <code>voice-models\</code>
            <span>{t('system.tree.voice')}</span>
          </div>
          <div className="storage-tree__row">
            <code>runtimes\python\</code>
            <span>{t('system.tree.runtimes')}</span>
          </div>
          <div className="storage-tree__row">
            <code>locales\</code>
            <span>{t('system.tree.locales')}</span>
          </div>
          <div className="storage-tree__row">
            <code>settings.json</code>
            <span>{t('system.tree.settings')}</span>
          </div>
          <div className="storage-tree__row">
            <code>prompts.json</code>
            <span>{t('system.tree.prompts')}</span>
          </div>
          <div className="storage-tree__row">
            <code>kb-config.json</code>
            <span>{t('system.tree.kb')}</span>
          </div>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('system.cache.title')}</div>
        <p className="kb-card__desc">{t('system.cache.desc')}</p>
      </section>
    </div>
  );
}
