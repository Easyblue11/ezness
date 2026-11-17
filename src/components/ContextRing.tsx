/**
 * How full this conversation is, next to the send button.
 *
 * The estimate is characters-based (see estimateTokens), so it is a yardstick
 * rather than a model-exact count: enough to notice a conversation growing
 * toward the window before the model starts dropping history. Clicking the
 * ring opens the compression card; at 85% a small notice points at it.
 */

import { useEffect, useRef, useState } from 'react';

export interface CompressionUi {
  /** Rounds kept verbatim, shown in the explanation. */
  keepTurns: number;
  busy: boolean;
  /** e.g. 正在压缩… 第 1/2 段. */
  progress: string | null;
  error: string | null;
  /** Why compression cannot start right now (streaming, too few messages…). */
  disabledReason: string | null;
  /** Changes when the conversation changes, so the notice resets. */
  sessionKey: string;
  onCompress: () => void;
  onCancel: () => void;
}

interface Props {
  /** Estimated tokens in this conversation's history. */
  used: number;
  /** The window to measure against, from 设置 → 工作设置. */
  limit: number;
  compression?: CompressionUi;
}

/** 1234 → 1.2K, 1_050_000 → 1.05M; whole numbers stay whole. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(Math.round(value));
}

export function ContextRing({ used, limit, compression }: Props) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 1;
  const ratio = Math.min(1, Math.max(0, used / safeLimit));
  const percent = (used / safeLimit) * 100;
  const shown = used > 0 && percent < 1 ? '<1%' : `${Math.min(100, Math.round(percent))}%`;
  const tone = ratio >= 0.85 ? 'is-danger' : ratio >= 0.6 ? 'is-warn' : '';

  const [open, setOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sessionKey = compression?.sessionKey ?? '';
  useEffect(() => {
    setNoticeDismissed(false);
    setOpen(false);
  }, [sessionKey]);

  // A finished compression closes the card; a failed one stays open so the
  // error is visible and the retry button is one click away.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (compression?.busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      if (!compression?.error) setOpen(false);
    }
  }, [compression?.busy, compression?.error]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A 20px circle: r = 7.6 leaves room for the 2.6px stroke.
  const radius = 7.6;
  const circumference = 2 * Math.PI * radius;
  const detail = `已用 ${formatTokens(used)} / ${formatTokens(safeLimit)} 词元`;

  const showNotice =
    ratio >= 0.85 && !noticeDismissed && !open && !compression?.busy;
  const noticeText =
    ratio >= 1
      ? `上下文已满（${shown}），点圆环压缩`
      : `上下文已用 ${shown}，点圆环压缩`;

  return (
    <div className={`ctx ${open ? 'is-open' : ''}`} ref={wrapRef}>
      {showNotice && (
        <div className="ctx-notice" role="status">
          <span className="ctx-notice__dot" aria-hidden="true" />
          <span className="ctx-notice__text">{noticeText}</span>
          <button
            className="ctx-notice__close"
            aria-label="关闭提醒"
            onClick={() => setNoticeDismissed(true)}
          >
            ×
          </button>
          <span className="ctx-notice__arrow" aria-hidden="true" />
        </div>
      )}

      <button
        type="button"
        className={`ctx-ring ${tone} ${compression?.busy ? 'is-busy' : ''} ${
          compression ? 'is-actionable' : ''
        }`}
        aria-expanded={open}
        aria-haspopup={compression ? 'dialog' : undefined}
        aria-label={`上下文占用 ${shown}（${detail}）${
          compression ? '，点击压缩上下文' : ''
        }`}
        title={compression ? `${detail} · 点击压缩上下文` : detail}
        onClick={() => {
          if (!compression) return;
          setOpen((value) => !value);
        }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle className="ctx-ring__track" cx="10" cy="10" r={radius} />
          <circle
            className="ctx-ring__value"
            cx="10"
            cy="10"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
          />
        </svg>
      </button>

      {compression && !open && (
        <div className="ctx-ring__tip" role="tooltip">
          <span className="ctx-ring__tip-pct">{shown}</span>
          <span className="ctx-ring__tip-detail">{detail}</span>
        </div>
      )}

      {compression && open && (
        <div className="ctx-pop" role="dialog" aria-label="压缩上下文">
          <div className="ctx-pop__head">
            <span className="ctx-pop__title">上下文</span>
            <button
              className="ctx-pop__close"
              aria-label="关闭"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="ctx-pop__meter">
            <span className="ctx-pop__percent">{shown}</span>
            <span className="ctx-pop__detail">{detail}</span>
          </div>
          <div className="ctx-pop__bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <p className="ctx-pop__desc">
            把最近 {compression.keepTurns} 轮以前的对话合并成一份摘要。原文会归档，随时可以撤销。
          </p>
          {compression.busy ? (
            <div className="ctx-pop__busy">
              <span className="ctx-pop__spinner" aria-hidden="true" />
              <span>{compression.progress ?? '正在压缩…'}</span>
              <button className="ctx-pop__cancel" onClick={compression.onCancel}>
                取消
              </button>
            </div>
          ) : compression.disabledReason ? (
            <div className="ctx-pop__disabled">{compression.disabledReason}</div>
          ) : (
            <button className="ctx-pop__go" onClick={compression.onCompress}>
              压缩上下文
            </button>
          )}
          {compression.error && <div className="ctx-pop__error">{compression.error}</div>}
        </div>
      )}
    </div>
  );
}
