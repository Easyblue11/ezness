import { useEffect, useRef } from 'react';
import { InfoIcon, TrashIcon } from './Icons';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 确认后正在执行耗时操作：按钮禁用，避免重复点击和误关。 */
  busy?: boolean;
  /** 从别的弹窗里再弹出的确认框：层级要高过那个弹窗，否则会被盖住。 */
  raised?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for `window.confirm`. Cancel takes focus by default so a
 * stray Enter can't destroy something; Escape and a backdrop click close it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  raised = false,
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className={`modal ${raised ? 'modal--raised' : ''}`}
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal__panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className={`modal__icon ${danger ? 'is-danger' : ''}`}>
          {danger ? <TrashIcon size={18} /> : <InfoIcon size={18} />}
        </div>
        <h2 className="modal__title">{title}</h2>
        <p className="modal__message">{message}</p>
        <div className="modal__actions">
          <button ref={cancelRef} className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
