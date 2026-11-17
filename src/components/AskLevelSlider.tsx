import type { CSSProperties } from 'react';
import type { AskLevel } from '../types';

/** The four stops of the question slider. */
export const ASK_LEVELS: { level: AskLevel; name: string; hint: string }[] = [
  {
    level: 0,
    name: '自动',
    hint: '不再询问：常规操作直接执行，破坏性命令先交给独立 AI 评估，评估认为有风险时由你决定是否执行。',
  },
  { level: 1, name: '1 级', hint: '只有破坏性操作或工作空间之外的命令才询问。' },
  { level: 2, name: '2 级', hint: '关键操作才询问：未知命令、自定义功能等。' },
  { level: 3, name: '3 级', hint: '常规操作也询问：修改文件、不熟悉的命令。' },
];

export function askLevelName(level: AskLevel): string {
  return ASK_LEVELS[level]?.name ?? ASK_LEVELS[3].name;
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
  const percent = (value / 3) * 100;
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
        aria-label="问询级别"
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
            {item.name}
          </button>
        ))}
      </div>
      {!hideHint && <p className="ask-slider__hint">{ASK_LEVELS[value]?.hint}</p>}
    </div>
  );
}
