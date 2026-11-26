import type { AgentReviewChange, AgentReviewResult } from '../types';
import type { AgentReviewState } from '../lib/useAgentReview';
import { useI18n } from '../i18n';
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

const KIND_LABEL_KEY: Record<AgentReviewChange['kind'], string> = {
  'capability-add': 'director.review.kind.capabilityAdd',
  'capability-remove': 'director.review.kind.capabilityRemove',
  'knowledge-add': 'director.review.kind.knowledgeAdd',
  'knowledge-remove': 'director.review.kind.knowledgeRemove',
  definition: 'director.review.kind.definition',
};

const FIELD_LABEL_KEY: Record<string, string> = {
  role: 'director.review.field.role',
  personality: 'director.review.field.personality',
  inputSpec: 'director.review.field.inputSpec',
  outputSpec: 'director.review.field.outputSpec',
  prompt: 'director.review.field.prompt',
};

interface Props {
  review: AgentReviewState;
  agentCount: number;
  modelReady: boolean;
  onClose: () => void;
}

function timeOf(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function pendingOf(result: AgentReviewResult, isApplied: (id: string) => boolean): number {
  return result.changes.filter((change) => !isApplied(change.id)).length;
}

export function AgentReviewPanel({ review, agentCount, modelReady, onClose }: Props) {
  const { t, locale } = useI18n();
  const { phase, results, error, notice, applying, finishedAt, pending, selectedPending } = review;

  const adjust = results.filter((result) => result.changes.length > 0);
  const failed = results.filter((result) => result.verdict === 'error');
  const fineCount = results.length - adjust.length - failed.length;
  const allSelected = pending.length > 0 && selectedPending.length === pending.length;

  const startLabel =
    phase === 'running'
      ? t('director.review.start.running')
      : results.length > 0
        ? t('director.review.start.restart')
        : t('director.review.start.start');
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
        aria-label={t('director.review.title')}
      >
        <header className="agent-review__head">
          <div className="agent-review__titles">
            <h2 className="modal__title">
              <ScanIcon size={16} />
              {t('director.review.title')}
            </h2>
            <p className="agent-review__sub">{t('director.review.subtitle')}</p>
          </div>
          <button
            type="button"
            className="agent-review__close"
            title={t('director.common.close')}
            aria-label={t('director.common.close')}
            onClick={onClose}
            disabled={applying}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        {phase === 'idle' && (
          <div className="agent-review__state is-idle">
            <ScanIcon size={20} />
            <p>{t('director.review.idle.title')}</p>
            <span>{t('director.review.idle.desc', { count: agentCount })}</span>
            {!modelReady && (
              <div className="notice notice--warn">{t('director.review.error.noModel')}</div>
            )}
          </div>
        )}

        {phase === 'running' && (
          <div className="agent-review__state">
            <ScanIcon size={20} />
            <p>{t('director.review.running.title', { count: agentCount })}</p>
            <span>{t('director.review.running.desc')}</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="agent-review__body">
            <div className="notice notice--warn">{error}</div>
            <p className="agent-review__fine">{t('director.review.errorHint')}</p>
          </div>
        )}

        {phase === 'ready' && (
          <div className="agent-review__body">
            {notice && <div className="notice notice--ok">{notice}</div>}
            {error && <div className="notice notice--warn">{error}</div>}

            <div className="agent-review__overview">
              {t('director.review.summary.total', { count: results.length })}
              {adjust.length > 0 && (
                <span className="agent-review__count is-adjust">
                  {t('director.review.summary.adjust', { count: adjust.length })}
                </span>
              )}
              {fineCount > 0 && (
                <span className="agent-review__count">
                  {t('director.review.summary.fine', { count: fineCount })}
                </span>
              )}
              {failed.length > 0 && (
                <span className="agent-review__count is-error">
                  {t('director.review.summary.failed', { count: failed.length })}
                </span>
              )}
              {finishedAt !== null && (
                <span className="agent-review__time">
                  {t('director.review.summary.finishedAt', { time: timeOf(finishedAt, locale) })}
                </span>
              )}
            </div>

            {adjust.length === 0 && failed.length === 0 && (
              <p className="agent-review__fine">{t('director.review.allFine')}</p>
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
                      {left > 0
                        ? t('director.review.agent.pending', { count: left })
                        : t('director.review.agent.appliedAll')}
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
                              aria-label={t('director.review.selectSuggestion', {
                                label: change.label,
                              })}
                              onChange={() => review.toggleSelected(change.id)}
                            />
                          </label>
                          <div className="agent-review__change">
                            <span className="agent-review__label">
                              <span className={`agent-review__kind is-${change.kind}`}>
                                {t(KIND_LABEL_KEY[change.kind])}
                              </span>
                              {change.label}
                            </span>
                            {change.detail && (
                              <span className="agent-review__detail">{change.detail}</span>
                            )}
                            {change.kind === 'definition' && change.value !== undefined && (
                              <details className="agent-review__diff">
                                <summary>
                                  {t('director.review.viewRewrite', {
                                    field: change.field
                                      ? t(FIELD_LABEL_KEY[change.field] ?? 'director.review.field.fallback')
                                      : t('director.review.field.fallback'),
                                  })}
                                </summary>
                                <pre>{change.value}</pre>
                              </details>
                            )}
                          </div>
                          {isApplied ? (
                            <span className="agent-review__done">
                              <CheckIcon size={13} />
                              {t('director.review.applied')}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={applying}
                              onClick={() => void review.apply([change.id])}
                            >
                              {applying ? t('director.review.applying') : t('director.review.accept')}
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
                  <span className="agent-review__verdict is-error">
                    {t('director.review.failedBadge')}
                  </span>
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
            {t('director.review.selectAll')}
          </label>
          <span className="ws__selectcount">
            {t('director.review.selected', {
              selected: selectedPending.length,
              total: pending.length,
            })}
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
              ? t('director.review.applying')
              : selectedPending.length > 0
                ? t('director.review.bulkApplyCount', { count: selectedPending.length })
                : t('director.review.bulkApply')}
          </button>
        </footer>
      </div>
    </div>
  );
}
