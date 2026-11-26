import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '../types';
import { useI18n } from '../i18n';
import { ToolSteps } from './ChatView';
import { MarkdownView } from './MarkdownView';

export type BubbleTaskStatus = 'running' | 'done' | 'error' | 'stopped';

export interface BubbleTask {
  id: string;
  title: string;
  status: BubbleTaskStatus;
}

const STATUS_LABEL_KEY: Record<BubbleTaskStatus, string> = {
  running: 'workspace.status.running',
  done: 'workspace.status.done',
  error: 'workspace.status.error',
  stopped: 'workspace.status.stopped',
};

interface TaskBubbleDialogProps {
  task: BubbleTask;
  messages: Message[];
  onClose: () => void;
  /** 直接对这个任务说一句话，等于在它的对话框里发消息。 */
  onSend: (text: string) => void;
  /** 右上角「进入工作」：关掉弹窗并跳回这个任务。 */
  onEnter: () => void;
}

/**
 * 总监页左侧的任务气泡：左键点开先看这个任务在说什么，可以顺手补一句，
 * 再决定要不要「进入工作」。不切走当前面板，也不丢失正在看的总监对话。
 */
export function TaskBubbleDialog({
  task,
  messages,
  onClose,
  onSend,
  onEnter,
}: TaskBubbleDialogProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 用户往上翻看历史时不强行拉回底部；停在底部时跟着新消息走。 */
  const stickRef = useRef(true);

  useEffect(() => {
    inputRef.current?.focus();
  }, [task.id]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [task.id, messages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = messages.filter(
    (message) =>
      message.role !== 'system' &&
      (Boolean(message.content?.trim()) ||
        (message.attachments?.length ?? 0) > 0 ||
        (message.steps?.length ?? 0) > 0),
  );

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onSend(text);
  }

  return createPortal(
    <div className="bubble-mask" onMouseDown={onClose}>
      <div
        className="bubble"
        role="dialog"
        aria-label={t('workspace.bubble.dialogAria', { title: task.title })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="bubble__head">
          <div className="bubble__who">
            <strong>{task.title}</strong>
            <span className={`bubble__status is-${task.status}`}>
              {t(STATUS_LABEL_KEY[task.status])}
            </span>
          </div>
          <div className="bubble__acts">
            <button type="button" className="btn btn--primary btn--tiny" onClick={onEnter}>
              {t('workspace.bubble.enter')}
            </button>
            <button
              type="button"
              className="bubble__close"
              aria-label={t('workspace.bubble.close')}
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </header>

        <div
          className="bubble__list"
          ref={listRef}
          onScroll={() => {
            const list = listRef.current;
            if (!list) return;
            stickRef.current =
              list.scrollHeight - list.scrollTop - list.clientHeight < 60;
          }}
        >
          {visible.length === 0 ? (
            <p className="bubble__empty">{t('workspace.bubble.empty')}</p>
          ) : (
            visible.map((message) => (
              <div key={message.id} className={`bubble__msg is-${message.role}`}>
                <span className="bubble__role">
                  {message.role === 'user'
                    ? t('workspace.bubble.roleUser')
                    : t('workspace.bubble.roleTask')}
                </span>
                <div className="bubble__text">
                  {message.role === 'assistant' &&
                    message.steps &&
                    message.steps.length > 0 && (
                      <div className="bubble__steps">
                        <ToolSteps steps={message.steps} />
                      </div>
                    )}
                  <MarkdownView text={message.content} citations={message.citations} />
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="bubble__files">
                      {message.attachments.map((file) => (
                        <span key={file.id} className="bubble__file">
                          {file.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {task.status === 'running' && (
            <p className="bubble__typing">{t('workspace.bubble.typing')}</p>
          )}
        </div>

        <footer className="bubble__foot">
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            placeholder={t('workspace.bubble.placeholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary btn--tiny"
            disabled={!draft.trim()}
            onClick={submit}
          >
            {t('workspace.bubble.send')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
