import { useEffect, useState } from 'react';
import type { WorkSettings } from '../../types';
import { useI18n } from '../../i18n';
import { AskLevelSlider } from '../AskLevelSlider';
import { DownloadIcon, WorkspaceIcon } from '../Icons';

interface Props {
  work: WorkSettings;
  onChange: (work: WorkSettings) => void;
}

export function WorkSection({ work, onChange }: Props) {
  const { t } = useI18n();
  // Keep the raw text while typing so clearing the box does not snap to 1.
  const [draft, setDraft] = useState(String(work.maxSteps));

  useEffect(() => {
    setDraft(String(work.maxSteps));
  }, [work.maxSteps]);

  const unlimited = work.maxSteps === -1;

  function commit(raw: string) {
    const value = Math.trunc(Number(raw));
    if (raw.trim() === '' || !Number.isFinite(value)) return;
    onChange({ ...work, maxSteps: value === -1 ? -1 : Math.max(1, value) });
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.work.title')}</h2>
          <p>{t('settings.work.desc')}</p>
        </div>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          {t('settings.work.steps.title')}
        </div>
        <p className="kb-card__desc">{t('settings.work.steps.desc')}</p>
        <div className="kb-card__row work-row">
          <input
            className="input"
            style={{ maxWidth: 160 }}
            type="number"
            min={-1}
            step={1}
            value={draft}
            aria-label={t('settings.work.steps.aria')}
            onChange={(event) => {
              setDraft(event.target.value);
              commit(event.target.value);
            }}
            onBlur={() => setDraft(String(work.maxSteps))}
          />
          <span className="kb-card__meta">
            {unlimited
              ? t('settings.work.steps.unlimited')
              : t('settings.work.steps.max', { count: work.maxSteps })}
          </span>
        </div>
        <div className="field__hint">{t('settings.work.steps.hint')}</div>
      </section>

      <section className="kb-card work-ask">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          {t('settings.work.ask.title')}
        </div>
        <p className="kb-card__desc">{t('settings.work.ask.desc')}</p>
        <AskLevelSlider
          value={work.askLevel}
          onChange={(askLevel) => onChange({ ...work, askLevel })}
        />
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          {t('settings.work.temp.title')}
        </div>
        <p className="kb-card__desc">
          {t('settings.work.temp.descBefore')} <code>.ezness</code>{' '}
          {t('settings.work.temp.descAfter')}
        </p>
        <div className="kb-card__row work-row">
          <button
            className={`switch ${work.autoDeleteTemp ? 'is-on' : ''}`}
            role="switch"
            aria-checked={work.autoDeleteTemp}
            aria-label={t('settings.work.temp.aria')}
            title={
              work.autoDeleteTemp ? t('settings.work.temp.onTitle') : t('settings.work.temp.offTitle')
            }
            onClick={() => onChange({ ...work, autoDeleteTemp: !work.autoDeleteTemp })}
          >
            <span />
          </button>
          <span className="kb-card__meta">
            {work.autoDeleteTemp
              ? t('settings.work.temp.on')
              : t('settings.work.temp.off')}
          </span>
        </div>
        <div className="field__hint">
          {t('settings.work.temp.hintBefore')} <code>.ezness</code>
          {t('settings.work.temp.hintAfter')}
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <DownloadIcon size={15} />
          {t('settings.work.deps.title')}
        </div>
        <p className="kb-card__desc">{t('settings.work.deps.desc')}</p>
        <div className="kb-card__row work-row">
          <button
            className={`switch ${work.autoInstallDeps ? 'is-on' : ''}`}
            role="switch"
            aria-checked={work.autoInstallDeps}
            aria-label={t('settings.work.deps.aria')}
            title={
              work.autoInstallDeps ? t('settings.work.deps.onTitle') : t('settings.work.deps.offTitle')
            }
            onClick={() => onChange({ ...work, autoInstallDeps: !work.autoInstallDeps })}
          >
            <span />
          </button>
          <span className="kb-card__meta">
            {work.autoInstallDeps ? t('settings.work.deps.on') : t('settings.work.deps.off')}
          </span>
        </div>
        <div className="field__hint">{t('settings.work.deps.hint')}</div>
      </section>
    </div>
  );
}
