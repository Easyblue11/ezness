import { useCallback, useEffect, useState } from 'react';
import type { PythonEnvStatus, PythonModule } from '../../types';
import { useI18n } from '../../i18n';
import { CheckIcon, DownloadIcon, RefreshIcon, StackIcon } from '../Icons';

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export function PythonSection() {
  const { t } = useI18n();
  const api = window.ezness;
  const [status, setStatus] = useState<PythonEnvStatus | null>(null);
  const [modules, setModules] = useState<PythonModule[]>([]);
  const [modulesError, setModulesError] = useState('');
  const [indexDraft, setIndexDraft] = useState('');
  const [installDraft, setInstallDraft] = useState('');
  const [busy, setBusy] = useState<'' | 'ensure' | 'modules' | 'install' | 'index'>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const refreshStatus = useCallback(async () => {
    const next = await api?.pythonEnvStatus();
    if (!next) return null;
    setStatus(next);
    setIndexDraft((current) => current || next.indexUrl);
    return next;
  }, [api]);

  const loadModules = useCallback(async () => {
    setModulesError('');
    try {
      const list = await api?.pythonModules();
      if (Array.isArray(list)) setModules(list);
      return true;
    } catch (error) {
      setModules([]);
      setModulesError(errorText(error));
      return false;
    }
  }, [api]);

  useEffect(() => {
    void (async () => {
      const next = await refreshStatus();
      if (next?.installed) await loadModules();
    })();
  }, [refreshStatus, loadModules]);

  async function ensureEnv() {
    if (!api || busy) return;
    setBusy('ensure');
    setMessage({ kind: 'ok', text: t('settings.python.checking') });
    try {
      const next = await api.pythonEnvEnsure();
      setStatus(next);
      setIndexDraft(next.indexUrl);
      setMessage({
        kind: 'ok',
        text: next.pipVersion
          ? t('settings.python.envReadyPip', {
              version: next.version || 'Python',
              pip: next.pipVersion,
            })
          : t('settings.python.envReady', { version: next.version || 'Python' }),
      });
      await loadModules();
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function saveIndex() {
    if (!api || busy) return;
    setBusy('index');
    setMessage(null);
    try {
      const result = await api.pythonSetIndex(indexDraft);
      setIndexDraft(result.indexUrl);
      setStatus((prev) => (prev ? { ...prev, indexUrl: result.indexUrl } : prev));
      setMessage({ kind: 'ok', text: t('settings.python.index.saved') });
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function installModule() {
    if (!api || busy) return;
    const spec = installDraft.trim();
    if (!spec) return;
    setBusy('install');
    setMessage({ kind: 'ok', text: t('settings.python.install.running', { name: spec }) });
    try {
      const result = await api.pythonInstallModule(spec);
      setInstallDraft('');
      setMessage({
        kind: 'ok',
        text: t('settings.python.install.done', { name: result.spec }),
      });
      await loadModules();
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function refreshModules() {
    if (!api || busy) return;
    setBusy('modules');
    setMessage(null);
    try {
      await loadModules();
      await refreshStatus();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.python.title')}</h2>
          <p>{t('settings.python.desc')}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refreshModules()} disabled={Boolean(busy)}>
          <RefreshIcon size={14} />
          {t('system.refresh')}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <StackIcon size={15} />
          {t('settings.python.env.title')}
        </div>
        <p className="kb-card__desc">
          {t('settings.python.env.desc', { version: status?.targetVersion ?? '' })}
        </p>
        <div className="kb-card__row">
          <input
            className="input"
            readOnly
            value={status?.dir ?? t('settings.python.reading')}
          />
          <button className="btn btn--primary" onClick={() => void ensureEnv()} disabled={Boolean(busy)}>
            <DownloadIcon size={14} />
            {busy === 'ensure'
              ? t('settings.python.deploying')
              : t('settings.python.ensure')}
          </button>
        </div>
        {status && (
          <div className="kb-card__meta">
            {status.installed ? (
              t('settings.python.status.ready', {
                version: status.version || t('settings.python.versionUnknown'),
                pip: status.pip
                  ? status.pipVersion || t('settings.python.pipInstalled')
                  : t('settings.python.pipMissing'),
                count: modules.length,
              })
            ) : (
              t('settings.python.status.notDeployed', {
                version: status.targetVersion,
              })
            )}
          </div>
        )}
        {status?.installed && status.pip === false && (
          <div className="notice notice--warn">{t('settings.python.pipWarning')}</div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.python.index.title')}</div>
        <p className="kb-card__desc">{t('settings.python.index.desc')}</p>
        <div className="kb-card__row">
          <input
            className="input py-index-input"
            value={indexDraft}
            onChange={(event) => setIndexDraft(event.target.value)}
            placeholder={status?.defaultIndex ?? ''}
            spellCheck={false}
          />
          <button className="btn" onClick={() => void saveIndex()} disabled={Boolean(busy)}>
            {t('settings.python.save')}
          </button>
        </div>
        <div className="kb-card__meta">
          {t('settings.python.currentIndex')}{' '}
          <code>{status?.indexUrl ?? t('settings.python.reading')}</code>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.python.modules.title')}</div>
        <p className="kb-card__desc">
          {t('settings.python.modules.desc')} <code>requests</code>
          {t('settings.python.modules.descOr')}
          <code>pandas==2.2.3</code>.
        </p>
        <div className="kb-card__row">
          <input
            className="input py-install-input"
            value={installDraft}
            onChange={(event) => setInstallDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void installModule();
            }}
            placeholder={t('settings.python.install.placeholder')}
            spellCheck={false}
            disabled={busy === 'install'}
          />
          <button
            className="btn btn--primary"
            onClick={() => void installModule()}
            disabled={Boolean(busy) || !installDraft.trim()}
          >
            {busy === 'install'
              ? t('settings.python.install.busy')
              : t('settings.python.install.button')}
          </button>
          <button className="btn btn--ghost" onClick={() => void refreshModules()} disabled={Boolean(busy)}>
            {t('settings.python.refreshList')}
          </button>
        </div>

        {modulesError && <div className="notice notice--warn">{modulesError}</div>}

        {modules.length > 0 ? (
          <div className="py-modules">
            {modules.map((item) => (
              <div className="py-module" key={item.name}>
                <span className="py-module__name">{item.name}</span>
                <span className="py-module__version">{item.version}</span>
              </div>
            ))}
          </div>
        ) : (
          !modulesError && (
            <div className="kb-card__meta">
              {status?.installed
                ? t('settings.python.modules.emptyInstalled')
                : t('settings.python.modules.emptyNotDeployed')}
            </div>
          )
        )}
      </section>

      {message && (
        <div className={message.kind === 'warn' ? 'notice notice--warn' : 'notice'}>
          <CheckIcon size={14} /> {message.text}
        </div>
      )}
    </div>
  );
}
