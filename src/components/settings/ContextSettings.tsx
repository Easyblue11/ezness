import { useEffect, useState } from 'react';
import type { WorkSettings } from '../../types';
import { normalizeContextLimit, normalizeKeepTurns } from '../../data/work';
import { useI18n } from '../../i18n';
import { formatTokens } from '../ContextRing';
import { SettingsIcon, StackIcon } from '../Icons';

/** Common window sizes, one click away instead of typing seven digits. */
const CONTEXT_PRESETS = [32_000, 128_000, 200_000, 1_000_000];

interface Props {
  work: WorkSettings;
  onChange: (work: WorkSettings) => void;
}

/**
 * Global context window and compression policy. These live under 系统设置
 * because they apply to 对话 and 工作空间 alike, unlike the per-task limits in
 * 工作设置.
 */
export function ContextSettings({ work, onChange }: Props) {
  const { t } = useI18n();
  // Keep the raw text while typing so clearing the box does not snap to 1.
  const [contextDraft, setContextDraft] = useState(String(work.contextLimit));
  const [keepDraft, setKeepDraft] = useState(String(work.compressionKeepTurns));

  useEffect(() => {
    setContextDraft(String(work.contextLimit));
  }, [work.contextLimit]);

  useEffect(() => {
    setKeepDraft(String(work.compressionKeepTurns));
  }, [work.compressionKeepTurns]);

  function commitContext(raw: string) {
    if (raw.trim() === '') return;
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value < 1000) return;
    onChange({ ...work, contextLimit: normalizeContextLimit(value) });
  }

  function commitKeep(raw: string) {
    if (raw.trim() === '') return;
    onChange({ ...work, compressionKeepTurns: normalizeKeepTurns(Number(raw)) });
  }

  return (
    <>
      <section className="kb-card">
        <div className="kb-card__title">
          <SettingsIcon size={15} />
          {t('context.title')}
        </div>
        <p className="kb-card__desc">{t('context.desc')}</p>
        <div className="kb-card__row work-row">
          <input
            className="input"
            style={{ maxWidth: 200 }}
            type="number"
            min={1000}
            step={1000}
            value={contextDraft}
            aria-label={t('context.aria')}
            onChange={(event) => {
              setContextDraft(event.target.value);
              commitContext(event.target.value);
            }}
            onBlur={() => setContextDraft(String(work.contextLimit))}
          />
          <span className="kb-card__meta">
            {t('context.current', { tokens: formatTokens(work.contextLimit) })}
          </span>
        </div>
        <div className="work-presets">
          {CONTEXT_PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              className={`work-preset ${work.contextLimit === value ? 'is-active' : ''}`}
              onClick={() => onChange({ ...work, contextLimit: value })}
            >
              {formatTokens(value)}
            </button>
          ))}
        </div>
        <div className="field__hint">{t('context.hint')}</div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <StackIcon size={15} />
          {t('context.keep.title')}
        </div>
        <p className="kb-card__desc">{t('context.keep.desc')}</p>
        <div className="kb-card__row work-row">
          <input
            className="input"
            style={{ maxWidth: 120 }}
            type="number"
            min={1}
            max={10}
            step={1}
            value={keepDraft}
            aria-label={t('context.keep.aria')}
            onChange={(event) => {
              setKeepDraft(event.target.value);
              commitKeep(event.target.value);
            }}
            onBlur={() => setKeepDraft(String(work.compressionKeepTurns))}
          />
          <span className="kb-card__meta">
            {t('context.keep.current', { count: work.compressionKeepTurns })}
          </span>
        </div>
        <div className="field__hint">{t('context.keep.hint')}</div>
      </section>
    </>
  );
}
