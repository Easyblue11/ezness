import type { CSSProperties } from 'react';
import type { WebMode } from '../types';

/** The three stops of the 联网 slider. */
export const WEB_MODES: { mode: WebMode; name: string; hint: string }[] = [
  {
    mode: 'off',
    name: '关闭',
    hint: '回答前不检索网页。每条对话里仍可以单独打开「联网」。',
  },
  {
    mode: 'auto',
    name: '自动',
    hint: '由 AI 判断这条消息是否需要最新信息，需要才检索。寒暄、改写和通用问题不会白白搜一次。',
  },
  {
    mode: 'always',
    name: '总是',
    hint: '每次发送前都先检索网页，再把结果交给模型。',
  },
];

export function webModeName(mode: WebMode): string {
  return WEB_MODES.find((item) => item.mode === mode)?.name ?? '自动';
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
        aria-label="联网方式"
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
            {item.name}
          </button>
        ))}
      </div>
      {!hideHint && <p className="ask-slider__hint">{current.hint}</p>}
    </div>
  );
}
