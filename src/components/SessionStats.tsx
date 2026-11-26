import { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageRecord } from '../types';
import { sessionStats } from '../lib/sessionStats';
import { useI18n } from '../i18n';
import { formatTokens } from './ContextRing';
import type { Translate } from './AskLevelSlider';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BillingIcon,
  BoltIcon,
  ClockIcon,
  CloseIcon,
  RefreshIcon,
  SparkleIcon,
  StackIcon,
  StatsIcon,
  WaveIcon,
} from './Icons';

interface Props {
  /** Usage ledger rows for this conversation or task only. */
  records: UsageRecord[];
  /** Workspace task: the panel calls itself 本任务统计. */
  compact?: boolean;
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} tok/s`;
}

function formatDuration(ms: number | null, t: Translate): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return t('workspace.stats.ms', { value: Math.round(ms) });
  const seconds = ms / 1000;
  if (seconds < 60) return t('workspace.stats.sec', { value: seconds.toFixed(seconds >= 10 ? 0 : 1) });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds % 60);
    return rest > 0
      ? t('workspace.stats.minSec', { min: minutes, sec: rest })
      : t('workspace.stats.min', { value: minutes });
  }
  const hours = Math.floor(minutes / 60);
  return t('workspace.stats.hourMin', { hours, minutes: minutes % 60 });
}

function formatCost(cost: number, unpriced: number, t: Translate): string {
  if (cost > 0) {
    const shown = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
    return `¥${shown}`;
  }
  return unpriced > 0 ? t('workspace.stats.unpriced') : '¥0';
}

function formatWhen(at: number | null, t: Translate, locale: string): string {
  if (!at) return '—';
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return sameDay
    ? t('workspace.stats.today', { clock })
    : t('workspace.stats.date', { month: date.getMonth() + 1, day: date.getDate(), clock });
}

export function SessionStats({ records, compact = false }: Props) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stats = useMemo(() => sessionStats(records), [records]);
  const title = compact ? t('workspace.stats.titleTask') : t('workspace.stats.titleChat');

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

  return (
    <div className={`session-stats ${open ? 'is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={`session-stats__trigger ${open ? 'is-open' : ''}`}
        title={
          stats.requests > 0
            ? t('workspace.stats.triggerTitle', { title, count: stats.requests })
            : title
        }
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatsIcon size={13} />
        {stats.requests > 0 && <span>{formatTokens(stats.outputTokens)}</span>}
      </button>

      {open && (
        <div className="session-stats__pop" role="dialog" aria-label={title}>
          <header className="stats-pop__head">
            <span className="stats-pop__title">
              <StatsIcon size={14} />
              {title}
            </span>
            <button
              type="button"
              className="stats-pop__close"
              aria-label={t('workspace.stats.closeAria')}
              onClick={() => setOpen(false)}
            >
              <CloseIcon size={12} />
            </button>
          </header>
          <p className="stats-pop__sub">
            {stats.models.length > 0
              ? stats.models.join(t('workspace.stats.modelSeparator'))
              : t('workspace.stats.noModels')}
            {stats.lastAt
              ? ` · ${t('workspace.stats.lastAt', {
                  when: formatWhen(stats.lastAt, t, locale),
                })}`
              : ''}
          </p>

          {stats.requests === 0 ? (
            <p className="stats-pop__empty">
              {compact
                ? t('workspace.stats.emptyTask')
                : t('workspace.stats.emptyChat')}
            </p>
          ) : (
            <>
              <div className="stats-pop__tiles">
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <ArrowDownIcon size={12} />
                    {t('workspace.stats.outputTokens')}
                  </span>
                  <span className="stats-tile__value">{formatTokens(stats.outputTokens)}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <WaveIcon size={12} />
                    {t('workspace.stats.avgSpeed')}
                  </span>
                  <span className="stats-tile__value">{formatRate(stats.avgTokensPerSecond)}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <BoltIcon size={12} />
                    {t('workspace.stats.peakSpeed')}
                  </span>
                  <span className="stats-tile__value">
                    {formatRate(stats.peakTokensPerSecond)}
                  </span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <ClockIcon size={12} />
                    {t('workspace.stats.firstToken')}
                  </span>
                  <span className="stats-tile__value">
                    {formatDuration(stats.avgFirstTokenMs, t)}
                  </span>
                </div>
              </div>

              <dl className="stats-rows">
                <div>
                  <dt>
                    <RefreshIcon size={12} />
                    {t('workspace.stats.requests')}
                  </dt>
                  <dd>{t('workspace.stats.requestsValue', { count: stats.requests })}</dd>
                </div>
                <div>
                  <dt>
                    <ArrowUpIcon size={12} />
                    {t('workspace.stats.inputTokens')}
                  </dt>
                  <dd>{formatTokens(stats.inputTokens)}</dd>
                </div>
                <div>
                  <dt>
                    <StackIcon size={12} />
                    {t('workspace.stats.cacheHit')}
                  </dt>
                  <dd>
                    {stats.cachedInputTokens > 0 ? formatTokens(stats.cachedInputTokens) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <SparkleIcon size={12} />
                    {t('workspace.stats.reasoningTokens')}
                  </dt>
                  <dd>
                    {stats.reasoningTokens > 0 ? formatTokens(stats.reasoningTokens) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <BillingIcon size={12} />
                    {t('workspace.stats.cost')}
                  </dt>
                  <dd>{formatCost(stats.cost, stats.unpricedRequests, t)}</dd>
                </div>
                <div>
                  <dt>
                    <ClockIcon size={12} />
                    {t('workspace.stats.duration')}
                  </dt>
                  <dd>{formatDuration(stats.totalDurationMs, t)}</dd>
                </div>
              </dl>

              {stats.avgTokensPerSecond === null && (
                <p className="stats-pop__note">{t('workspace.stats.speedNote')}</p>
              )}
              {stats.estimatedRequests > 0 && (
                <p className="stats-pop__note">
                  {t('workspace.stats.estimatedNote', { count: stats.estimatedRequests })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
