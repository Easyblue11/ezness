import { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageRecord } from '../types';
import { sessionStats } from '../lib/sessionStats';
import { formatTokens } from './ContextRing';
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

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds % 60);
    return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 时 ${minutes % 60} 分`;
}

function formatCost(cost: number, unpriced: number): string {
  if (cost > 0) {
    const shown = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
    return `¥${shown}`;
  }
  return unpriced > 0 ? '未定价' : '¥0';
}

function formatWhen(at: number | null): string {
  if (!at) return '—';
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return sameDay ? `今天 ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

export function SessionStats({ records, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stats = useMemo(() => sessionStats(records), [records]);
  const title = compact ? '本任务统计' : '本对话统计';

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
        title={stats.requests > 0 ? `${title} · ${stats.requests} 次请求` : title}
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
              aria-label="关闭统计"
              onClick={() => setOpen(false)}
            >
              <CloseIcon size={12} />
            </button>
          </header>
          <p className="stats-pop__sub">
            {stats.models.length > 0 ? stats.models.join('、') : '还没有模型记录'}
            {stats.lastAt ? ` · 最近 ${formatWhen(stats.lastAt)}` : ''}
          </p>

          {stats.requests === 0 ? (
            <p className="stats-pop__empty">
              这个{compact ? '任务' : '对话'}还没有发出请求。发一条消息后，词元用量和速度会出现在这里。
            </p>
          ) : (
            <>
              <div className="stats-pop__tiles">
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <ArrowDownIcon size={12} />
                    输出词元
                  </span>
                  <span className="stats-tile__value">{formatTokens(stats.outputTokens)}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <WaveIcon size={12} />
                    平均速度
                  </span>
                  <span className="stats-tile__value">{formatRate(stats.avgTokensPerSecond)}</span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <BoltIcon size={12} />
                    峰值速度
                  </span>
                  <span className="stats-tile__value">
                    {formatRate(stats.peakTokensPerSecond)}
                  </span>
                </div>
                <div className="stats-tile">
                  <span className="stats-tile__label">
                    <ClockIcon size={12} />
                    首词延迟
                  </span>
                  <span className="stats-tile__value">{formatDuration(stats.avgFirstTokenMs)}</span>
                </div>
              </div>

              <dl className="stats-rows">
                <div>
                  <dt>
                    <RefreshIcon size={12} />
                    请求次数
                  </dt>
                  <dd>{stats.requests} 次</dd>
                </div>
                <div>
                  <dt>
                    <ArrowUpIcon size={12} />
                    输入词元
                  </dt>
                  <dd>{formatTokens(stats.inputTokens)}</dd>
                </div>
                <div>
                  <dt>
                    <StackIcon size={12} />
                    缓存命中
                  </dt>
                  <dd>
                    {stats.cachedInputTokens > 0 ? formatTokens(stats.cachedInputTokens) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <SparkleIcon size={12} />
                    推理词元
                  </dt>
                  <dd>
                    {stats.reasoningTokens > 0 ? formatTokens(stats.reasoningTokens) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>
                    <BillingIcon size={12} />
                    花费
                  </dt>
                  <dd>{formatCost(stats.cost, stats.unpricedRequests)}</dd>
                </div>
                <div>
                  <dt>
                    <ClockIcon size={12} />
                    模型耗时
                  </dt>
                  <dd>{formatDuration(stats.totalDurationMs)}</dd>
                </div>
              </dl>

              {stats.avgTokensPerSecond === null && (
                <p className="stats-pop__note">
                  速度从下一次请求开始记录；更早的请求没有计时。
                </p>
              )}
              {stats.estimatedRequests > 0 && (
                <p className="stats-pop__note">
                  其中 {stats.estimatedRequests} 次请求的词元是估算值（供应商没有回报用量）。
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
