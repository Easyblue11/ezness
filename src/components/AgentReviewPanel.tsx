import type { AgentReviewChange, AgentReviewResult } from '../types';
import type { AgentReviewState } from '../lib/useAgentReview';
import { CheckIcon, ChevronDownIcon, CloseIcon, ScanIcon } from './Icons';

/**
 * Agent 审查.
 *
 * The review itself lives in `useAgentReview` on the Agent page, so this
 * dialog is only a view: closing it never stops a running review, and opening
 * it again shows the result that is already there. Only agents with changes
 * are listed; expanding one reveals the same per-row 同意 buttons as before,
 * plus 全选 / 批量同意 in the footer.
 */

const KIND_LABEL: Record<AgentReviewChange['kind'], string> = {
  'capability-add': '添加能力',
  'capability-remove': '移除能力',
  'knowledge-add': '添加知识库',
  'knowledge-remove': '移除知识库',
  definition: '修改定义',
};

const FIELD_LABEL: Record<string, string> = {
  role: '角色',
  personality: '性格',
  inputSpec: '输入约定',
  outputSpec: '输出约定',
  prompt: '提示词',
};

interface Props {
  review: AgentReviewState;
  agentCount: number;
  modelReady: boolean;
  onClose: () => void;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function pendingOf(result: AgentReviewResult, isApplied: (id: string) => boolean): number {
  return result.changes.filter((change) => !isApplied(change.id)).length;
}

export function AgentReviewPanel({ review, agentCount, modelReady, onClose }: Props) {
  const { phase, results, error, notice, applying, finishedAt, pending, selectedPending } = review;

  const adjust = results.filter((result) => result.changes.length > 0);
  const failed = results.filter((result) => result.verdict === 'error');
  const fineCount = results.length - adjust.length - failed.length;
  const allSelected = pending.length > 0 && selectedPending.length === pending.length;

  const startLabel = phase === 'running' ? '审查中…' : results.length > 0 ? '重新审查' : '开始审查';
  const startClass = phase === 'ready' ? 'btn btn--ghost' : 'btn btn--primary';

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !applying) onClose();
      }}
    >
      <div
        className="modal__panel agent-review"
        role="dialog"
        aria-modal="true"
        aria-label="Agent 审查"
      >
        <header className="agent-review__head">
          <div className="agent-review__titles">
            <h2 className="modal__title">
              <ScanIcon size={16} />
              Agent 审查
            </h2>
            <p className="agent-review__sub">
              按每个 Agent 的定义检查能力范围与知识库，逐条确认后直接修改。关掉这个窗口，审查仍会在后台继续。
            </p>
          </div>
          <button
            type="button"
            className="agent-review__close"
            title="关闭"
            aria-label="关闭"
            onClick={onClose}
            disabled={applying}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        {phase === 'idle' && (
          <div className="agent-review__state is-idle">
            <ScanIcon size={20} />
            <p>还没有审查结果</p>
            <span>
              点击下方的「开始审查」，逐个检查 {agentCount} 个 Agent 的定义、能力和知识库是否匹配。
            </span>
            {!modelReady && (
              <div className="notice notice--warn">当前没有可用的模型，请先在设置里接入一个对话模型。</div>
            )}
          </div>
        )}

        {phase === 'running' && (
          <div className="agent-review__state">
            <ScanIcon size={20} />
            <p>正在审查 {agentCount} 个 Agent…</p>
            <span>可以放心关掉这个窗口，审查会在后台继续；完成后重新打开就能看到结果。</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="agent-review__body">
            <div className="notice notice--warn">{error}</div>
            <p className="agent-review__fine">处理完上面的问题后，点下方的按钮重新开始。</p>
          </div>
        )}

        {phase === 'ready' && (
          <div className="agent-review__body">
            {notice && <div className="notice notice--ok">{notice}</div>}
            {error && <div className="notice notice--warn">{error}</div>}

            <div className="agent-review__overview">
              共审查 {results.length} 个 Agent
              {adjust.length > 0 && (
                <span className="agent-review__count is-adjust">{adjust.length} 个需要整改</span>
              )}
              {fineCount > 0 && <span className="agent-review__count">{fineCount} 个配置合理</span>}
              {failed.length > 0 && (
                <span className="agent-review__count is-error">{failed.length} 个审查失败</span>
              )}
              {finishedAt !== null && (
                <span className="agent-review__time">完成于 {timeOf(finishedAt)}</span>
              )}
            </div>

            {adjust.length === 0 && failed.length === 0 && (
              <p className="agent-review__fine">所有 Agent 的配置都合适，没有需要整改的地方。</p>
            )}

            {adjust.map((result) => {
              const left = pendingOf(result, review.isApplied);
              return (
                <details key={result.agentId} className="agent-review__agent">
                  <summary className="agent-review__agent-head">
                    <ChevronDownIcon size={14} className="agent-review__chev" />
                    <span className="agent-review__name">{result.name}</span>
                    <span
                      className={`agent-review__verdict ${left > 0 ? 'is-adjust' : 'is-ok'}`}
                    >
                      {left > 0 ? `${left} 项待整改` : '已全部应用'}
                    </span>
                  </summary>
                  {result.summary && <p className="agent-review__summary">{result.summary}</p>}
                  <ul className="agent-review__list">
                    {result.changes.map((change) => {
                      const isApplied = review.isApplied(change.id);
                      return (
                        <li
                          key={change.id}
                          className={`agent-review__row ${isApplied ? 'is-applied' : ''}`}
                        >
                          <label className="agent-review__check">
                            <input
                              type="checkbox"
                              checked={review.isSelected(change.id) && !isApplied}
                              disabled={isApplied || applying}
                              aria-label={`选择建议：${change.label}`}
                              onChange={() => review.toggleSelected(change.id)}
                            />
                          </label>
                          <div className="agent-review__change">
                            <span className="agent-review__label">
                              <span className={`agent-review__kind is-${change.kind}`}>
                                {KIND_LABEL[change.kind]}
                              </span>
                              {change.label}
                            </span>
                            {change.detail && (
                              <span className="agent-review__detail">{change.detail}</span>
                            )}
                            {change.kind === 'definition' && change.value !== undefined && (
                              <details className="agent-review__diff">
                                <summary>
                                  查看改写后的{FIELD_LABEL[change.field ?? ''] ?? '内容'}
                                </summary>
                                <pre>{change.value}</pre>
                              </details>
                            )}
                          </div>
                          {isApplied ? (
                            <span className="agent-review__done">
                              <CheckIcon size={13} />
                              已应用
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={applying}
                              onClick={() => void review.apply([change.id])}
                            >
                              {applying ? '应用中…' : '同意'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })}

            {failed.map((result) => (
              <article key={result.agentId} className="agent-review__agent is-failed">
                <header className="agent-review__agent-head">
                  <span className="agent-review__name">{result.name}</span>
                  <span className="agent-review__verdict is-error">审查失败</span>
                </header>
                {result.error && <div className="notice notice--warn">{result.error}</div>}
              </article>
            ))}
          </div>
        )}

        <footer className="agent-review__foot">
          <label className="ws__selectall">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={pending.length === 0 || applying || phase === 'running'}
              onChange={(event) => review.selectAll(event.target.checked)}
            />
            全选
          </label>
          <span className="ws__selectcount">
            已选 {selectedPending.length} 条 · 共 {pending.length} 条建议
          </span>
          <button
            type="button"
            className={startClass}
            disabled={phase === 'running' || applying || !modelReady || agentCount === 0}
            onClick={() => void review.start()}
          >
            {startLabel}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={selectedPending.length === 0 || applying || phase !== 'ready'}
            onClick={() => void review.apply(selectedPending.map((change) => change.id))}
          >
            {applying
              ? '应用中…'
              : `批量同意${selectedPending.length > 0 ? `（${selectedPending.length}）` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
