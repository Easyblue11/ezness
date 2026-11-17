import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '../types';
import { ToolSteps } from './ChatView';
import { MarkdownView } from './MarkdownView';

export type BubbleTaskStatus = 'running' | 'done' | 'error' | 'stopped';

export interface BubbleTask {
  id: string;
  title: string;
  status: BubbleTaskStatus;
}

const STATUS_LABEL: Record<BubbleTaskStatus, string> = {
  running: '运行中',
  done: '已完成',
  error: '出错',
  stopped: '已停止',
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
        aria-label={`${task.title} 的对话`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="bubble__head">
          <div className="bubble__who">
            <strong>{task.title}</strong>
            <span className={`bubble__status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
          </div>
          <div className="bubble__acts">
            <button type="button" className="btn btn--primary btn--tiny" onClick={onEnter}>
              进入工作
            </button>
            <button type="button" className="bubble__close" aria-label="关闭" onClick={onClose}>
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
            <p className="bubble__empty">这个任务还没有对话。可以直接在下面说一句。</p>
          ) : (
            visible.map((message) => (
              <div key={message.id} className={`bubble__msg is-${message.role}`}>
                <span className="bubble__role">{message.role === 'user' ? '你' : '任务'}</span>
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
          {task.status === 'running' && <p className="bubble__typing">正在生成…</p>}
        </div>

        <footer className="bubble__foot">
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            placeholder="直接对这个任务说话，回车发送（Shift+回车换行）"
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
            发送
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
