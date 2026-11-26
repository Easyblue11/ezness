import type { CSSProperties } from 'react';
import type { AskLevel } from '../types';
import { useI18n } from '../i18n';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The four stops of the question slider. */
export const ASK_LEVELS: { level: AskLevel; nameKey: string; hintKey: string }[] = [
  {
    level: 0,
    nameKey: 'workspace.askLevel.auto',
    hintKey: 'workspace.askLevel.autoHint',
  },
  {
    level: 1,
    nameKey: 'workspace.askLevel.level1',
    hintKey: 'workspace.askLevel.level1Hint',
  },
  {
    level: 2,
    nameKey: 'workspace.askLevel.level2',
    hintKey: 'workspace.askLevel.level2Hint',
  },
  {
    level: 3,
    nameKey: 'workspace.askLevel.level3',
    hintKey: 'workspace.askLevel.level3Hint',
  },
];

export function askLevelNameKey(level: AskLevel): string {
  return (ASK_LEVELS[level] ?? ASK_LEVELS[3]).nameKey;
}

export function askLevelName(level: AskLevel, t: Translate): string {
  return t(askLevelNameKey(level));
}

interface Props {
  value: AskLevel;
  onChange: (value: AskLevel) => void;
  disabled?: boolean;
  /** Hide the hint line when the surrounding popover already shows one. */
  hideHint?: boolean;
}

/**
 * Four-stop permission-question slider: 自动 / 1 / 2 / 3. It is a real range
 * input so arrow keys work, with the labels below acting as buttons.
 */
export function AskLevelSlider({ value, onChange, disabled, hideHint }: Props) {
  const { t } = useI18n();
  const percent = (value / 3) * 100;
  const current = ASK_LEVELS[value] ?? ASK_LEVELS[3];
  return (
    <div className={`ask-slider ${disabled ? 'is-disabled' : ''}`}>
      <input
        className="ask-slider__range"
        type="range"
        min={0}
        max={3}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={t('workspace.askLevel.aria')}
        style={{ '--ask-fill': `${percent}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value) as AskLevel)}
      />
      <div className="ask-slider__labels">
        {ASK_LEVELS.map((item) => (
          <button
            key={item.level}
            type="button"
            className={`ask-slider__label ${item.level === value ? 'is-active' : ''}`}
            disabled={disabled}
            aria-pressed={item.level === value}
            onClick={() => onChange(item.level)}
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
