import type { CSSProperties } from 'react';
import type { WebMode } from '../types';
import { useI18n } from '../i18n';
import type { Translate } from './AskLevelSlider';

/** The three stops of the 联网 slider. */
export const WEB_MODES: {
  mode: WebMode;
  nameKey: string;
  hintKey: string;
  /** Used by call sites that do not have the i18n hook at hand. */
  fallbackName: string;
}[] = [
  {
    mode: 'off',
    nameKey: 'workspace.webMode.off',
    hintKey: 'workspace.webMode.offHint',
    fallbackName: 'Off',
  },
  {
    mode: 'auto',
    nameKey: 'workspace.webMode.auto',
    hintKey: 'workspace.webMode.autoHint',
    fallbackName: 'Auto',
  },
  {
    mode: 'always',
    nameKey: 'workspace.webMode.always',
    hintKey: 'workspace.webMode.alwaysHint',
    fallbackName: 'Always',
  },
];

export function webModeName(mode: WebMode, t?: Translate): string {
  const item = WEB_MODES.find((entry) => entry.mode === mode) ?? WEB_MODES[1];
  return t ? t(item.nameKey) : item.fallbackName;
}

interface Props {
  value: WebMode;
  onChange: (value: WebMode) => void;
  disabled?: boolean;
  /** Hide the hint line when the surrounding popover already shows one. */
  hideHint?: boolean;
}

/**
 * Three-stop 联网 slider: 关闭 / 自动 / 总是. A real range input keeps arrow
 * keys working, and the labels below double as buttons.
 */
export function WebModeSlider({ value, onChange, disabled, hideHint }: Props) {
  const { t } = useI18n();
  const index = Math.max(0, WEB_MODES.findIndex((item) => item.mode === value));
  const percent = (index / (WEB_MODES.length - 1)) * 100;
  const current = WEB_MODES[index] ?? WEB_MODES[1];

  return (
    <div className={`ask-slider ${disabled ? 'is-disabled' : ''}`}>
      <input
        className="ask-slider__range"
        type="range"
        min={0}
        max={WEB_MODES.length - 1}
        step={1}
        value={index}
        disabled={disabled}
        aria-label={t('workspace.webMode.aria')}
        style={{ '--ask-fill': `${percent}%` } as CSSProperties}
        onChange={(event) => {
          const next = WEB_MODES[Number(event.target.value)];
          if (next) onChange(next.mode);
        }}
      />
      <div className="ask-slider__labels">
        {WEB_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            className={`ask-slider__label ${item.mode === value ? 'is-active' : ''}`}
            disabled={disabled}
            aria-pressed={item.mode === value}
            onClick={() => onChange(item.mode)}
          >
            <span className="ask-slider__dot" />
            {t(item.nameKey)}
          </button>
        ))}
      </div>
      {!hideHint && <p className="ask-slider__hint">{t(current.hintKey)}</p>}
    </div>
  );
}
