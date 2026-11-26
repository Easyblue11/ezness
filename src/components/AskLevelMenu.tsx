import { useEffect, useRef, useState } from 'react';
import type { AskLevel } from '../types';
import { useI18n } from '../i18n';
import { ASK_LEVELS, AskLevelSlider, askLevelName } from './AskLevelSlider';
import { ChevronDownIcon } from './Icons';

interface Props {
  value: AskLevel;
  onChange: (level: AskLevel) => void;
  disabled?: boolean;
}

/**
 * Question-level trigger for the workspace header. It used to sit in the
 * composer toolbar; the header keeps it visible while the conversation scrolls
 * and leaves the composer for the task's inputs.
 */
export function AskLevelMenu({ value, onChange, disabled }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="ask-level ask-level--header" ref={ref}>
      <button
        type="button"
        className={`chip ask-level__trigger ${open ? 'is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('workspace.askLevel.triggerTitle')}
        onClick={() => setOpen((visible) => !visible)}
      >
        {t('workspace.askLevel.trigger')}
        <b>{askLevelName(value, t)}</b>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="ask-level__pop" role="dialog" aria-label={t('workspace.askLevel.aria')}>
          <div className="ask-level__pop-head">
            <span>{t('workspace.askLevel.aria')}</span>
            <em>{t((ASK_LEVELS[value] ?? ASK_LEVELS[3]).hintKey)}</em>
          </div>
          <AskLevelSlider
            value={value}
            disabled={disabled}
            hideHint
            onChange={(level) => onChange(level)}
          />
          {value === 0 ? (
            <p className="ask-level__pop-foot ask-level__pop-foot--warn">
              {t('workspace.askLevel.autoFoot')}
            </p>
          ) : (
            <p className="ask-level__pop-foot">{t('workspace.askLevel.foot')}</p>
          )}
        </div>
      )}
    </div>
  );
}
