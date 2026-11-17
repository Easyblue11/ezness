import { useEffect, useRef, useState } from 'react';
import type { AskLevel } from '../types';
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
        title="问询级别：决定代理多久停下来问你一次"
        onClick={() => setOpen((visible) => !visible)}
      >
        问询
        <b>{askLevelName(value)}</b>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className="ask-level__pop" role="dialog" aria-label="问询级别">
          <div className="ask-level__pop-head">
            <span>问询级别</span>
            <em>{ASK_LEVELS[value].hint}</em>
          </div>
          <AskLevelSlider
            value={value}
            disabled={disabled}
            hideHint
            onChange={(level) => onChange(level)}
          />
          {value === 0 ? (
            <p className="ask-level__pop-foot ask-level__pop-foot--warn">
              自动只取消询问，不会推翻权限模式。破坏性命令和越界命令会先交给一个独立的 AI
              评估：判定安全就直接执行，判定有风险会带着 AI 的理由弹给你确认，由你决定。
            </p>
          ) : (
            <p className="ask-level__pop-foot">只影响这个任务；全局默认在「设置 → 工作设置」。</p>
          )}
        </div>
      )}
    </div>
  );
}
