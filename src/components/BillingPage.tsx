import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import type { UsageRecord } from '../types';
import {
  FEATURE_LABELS,
  dailySeries,
  formatCost,
  formatCostExact,
  formatDateTime,
  formatTokens,
  groupRecords,
  startOfDay,
  startOfMonth,
  summarize,
  type DayPoint,
  type UsageGroup,
} from '../lib/usage';

interface Props {
  records: UsageRecord[];
  onClear: () => void | Promise<void>;
  /** USD→CNY rate used for the caption; ledger amounts are already CNY. */
  fxRate: number;
}

const RANGES = [
  { days: 7, labelKey: 'billing.range7' },
  { days: 30, labelKey: 'billing.range30' },
  { days: 90, labelKey: 'billing.range90' },
];

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * power;
}

function topRounded(x: number, y: number, width: number, height: number, radius = 4): string {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const bottom = y + height;
  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + width - r},${y}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `L${x + width},${bottom}`,
    'Z',
  ].join(' ');
}

const W = 760;
const H = 250;
const PAD = { left: 48, right: 12, top: 14, bottom: 28 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

function axisLabelEvery(days: number): number {
  if (days <= 7) return 1;
  if (days <= 30) return 5;
  if (days <= 90) return 15;
  return Math.ceil(days / 7);
}

function TokenChart({ points }: { points: DayPoint[] }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...points.map((point) => point.inputTokens + point.outputTokens), 0));
  const band = points.length > 0 ? PLOT_W / points.length : PLOT_W;
  const barWidth = Math.max(3, Math.min(24, band * 0.58));
  const every = axisLabelEvery(points.length);
  const ticks = [0, 1, 2, 3, 4];

  if (points.every((point) => point.inputTokens + point.outputTokens === 0)) {
    return <div className="billing-chart__empty">{t('billing.chart.emptyTokens')}</div>;
  }

  const active = hover !== null ? points[hover] : null;
  const activeX = hover !== null ? PAD.left + band * hover + band / 2 : 0;

  return (
    <div className="billing-chart">
      <div className="billing-chart__legend">
        <span><i className="swatch swatch--input" />{t('billing.chart.input')}</span>
        <span><i className="swatch swatch--output" />{t('billing.chart.output')}</span>
      </div>
      <div className="billing-chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('billing.chart.tokensAria')}>
          {ticks.map((tick) => {
            const y = PAD.top + PLOT_H - (PLOT_H * tick) / 4;
            return (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text x={PAD.left - 8} y={y + 3.5} textAnchor="end" className="billing-axis">
                  {formatTokens((max * tick) / 4)}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => {
            const x = PAD.left + band * index + (band - barWidth) / 2;
            const baseY = PAD.top + PLOT_H;
            const inputH = (point.inputTokens / max) * PLOT_H;
            const outputH = (point.outputTokens / max) * PLOT_H;
            const hasBoth = point.inputTokens > 0 && point.outputTokens > 0;
            const gap = hasBoth ? 2 : 0;
            const outputDraw = Math.max(0, outputH - gap);
            const inputY = baseY - inputH;
            const outputY = inputY - gap - outputDraw;
            return (
              <g key={point.key} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
                <rect x={x} y={PAD.top} width={barWidth} height={PLOT_H} fill="transparent" />
                {inputH > 0 && (
                  <rect
                    x={x}
                    y={inputY}
                    width={barWidth}
                    height={inputH}
                    rx={point.outputTokens > 0 ? 0 : 3}
                    fill="var(--accent)"
                  />
                )}
                {outputDraw > 0 && (
                  <path
                    d={topRounded(x, outputY, barWidth, outputDraw, 4)}
                    fill="var(--billing-output)"
                  />
                )}
                {(index % every === 0 || index === points.length - 1) && (
                  <text
                    x={PAD.left + band * index + band / 2}
                    y={H - 8}
                    textAnchor="middle"
                    className="billing-axis"
                  >
                    {point.label}
                  </text>
                )}
              </g>
            );
          })}

          {hover !== null && active && (
            <line
              x1={activeX}
              x2={activeX}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
              stroke="var(--border-strong)"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </svg>

        {hover !== null && active && (
          <div
            className="billing-tip"
            style={{ left: `${(activeX / W) * 100}%` }}
            role="status"
          >
            <div className="billing-tip__date">{active.label}</div>
            <div className="billing-tip__row"><span>{t('billing.chart.input')}</span><b>{formatTokens(active.inputTokens)}</b></div>
            <div className="billing-tip__row"><span>{t('billing.chart.output')}</span><b>{formatTokens(active.outputTokens)}</b></div>
            <div className="billing-tip__row"><span>{t('billing.chart.requests')}</span><b>{active.requests}</b></div>
            <div className="billing-tip__row"><span>{t('billing.chart.cost')}</span><b>{formatCost(active.cost)}</b></div>
          </div>
        )}
      </div>
    </div>
  );
}

function CostChart({ points }: { points: DayPoint[] }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...points.map((point) => point.cost), 0));
  const band = points.length > 0 ? PLOT_W / points.length : PLOT_W;
  const every = axisLabelEvery(points.length);
  const xOf = (index: number) => PAD.left + band * index + band / 2;
  const yOf = (value: number) => PAD.top + PLOT_H - (value / max) * PLOT_H;

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index)},${yOf(point.cost)}`).join(' ');
  const area =
    points.length > 0
      ? `${path} L${xOf(points.length - 1)},${PAD.top + PLOT_H} L${xOf(0)},${PAD.top + PLOT_H} Z`
      : '';
  const active = hover !== null ? points[hover] : null;
  const last = points[points.length - 1];

  if (points.every((point) => point.cost === 0)) {
    return <div className="billing-chart__empty">{t('billing.chart.emptyCost')}</div>;
  }

  return (
    <div className="billing-chart">
      <div className="billing-chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('billing.chart.costAria')}>
          {[0, 1, 2, 3, 4].map((tick) => {
            const y = PAD.top + PLOT_H - (PLOT_H * tick) / 4;
            return (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text x={PAD.left - 8} y={y + 3.5} textAnchor="end" className="billing-axis">
                  {formatCost((max * tick) / 4)}
                </text>
              </g>
            );
          })}

          <path d={area} fill="var(--billing-cost-wash)" />
          <path d={path} fill="none" stroke="var(--billing-cost)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {points.map((point, index) => (
            <g key={point.key} onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)}>
              <rect
                x={PAD.left + band * index}
                y={PAD.top}
                width={band}
                height={PLOT_H}
                fill="transparent"
              />
              {(index % every === 0 || index === points.length - 1) && (
                <text x={xOf(index)} y={H - 8} textAnchor="middle" className="billing-axis">
                  {point.label}
                </text>
              )}
            </g>
          ))}

          {last && last.cost > 0 && (
            <>
              <circle cx={xOf(points.length - 1)} cy={yOf(last.cost)} r={4} fill="var(--billing-cost)" stroke="var(--bg-elevated)" strokeWidth={2} />
              <text
                x={xOf(points.length - 1) - 6}
                y={yOf(last.cost) - 10}
                textAnchor="end"
                className="billing-endlabel"
              >
                {formatCost(last.cost)}
              </text>
            </>
          )}

          {hover !== null && active && (
            <>
              <line
                x1={xOf(hover)}
                x2={xOf(hover)}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
                stroke="var(--border-strong)"
                strokeWidth={1}
              />
              <circle
                cx={xOf(hover)}
                cy={yOf(active.cost)}
                r={4}
                fill="var(--billing-cost)"
                stroke="var(--bg-elevated)"
                strokeWidth={2}
              />
            </>
          )}
        </svg>

        {hover !== null && active && (
          <div className="billing-tip" style={{ left: `${(xOf(hover) / W) * 100}%` }} role="status">
            <div className="billing-tip__date">{active.label}</div>
            <div className="billing-tip__row"><span>{t('billing.chart.cost')}</span><b>{formatCost(active.cost)}</b></div>
            <div className="billing-tip__row"><span>{t('billing.chart.requests')}</span><b>{active.requests}</b></div>
            {active.unpriced > 0 && (
              <div className="billing-tip__note">
                {t('billing.chart.unpriced', { count: active.unpriced })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A partial total is approximate; an all-unpriced total is unknown, not zero. */
function costValue(summary: { requests: number; unpricedRequests: number; cost: number }): string {
  if (summary.requests > 0 && summary.unpricedRequests === summary.requests) return '—';
  if (summary.unpricedRequests > 0) return `≈ ${formatCost(summary.cost)}`;
  return formatCost(summary.cost);
}

function StatCard({
  label,
  value,
  hint,
  hero = false,
}: {
  label: string;
  value: string;
  hint: string;
  hero?: boolean;
}) {
  return (
    <div className={`billing-stat ${hero ? 'billing-stat--hero' : ''}`}>
      <div className="billing-stat__label">{label}</div>
      <div className="billing-stat__value">{value}</div>
      <div className="billing-stat__hint">{hint}</div>
    </div>
  );
}

function Breakdown({
  title,
  groups,
  empty,
}: {
  title: string;
  groups: UsageGroup[];
  empty: string;
}) {
  const { t } = useI18n();
  if (groups.length === 0) {
    return (
      <section className="billing-card billing-breakdown">
        <h2>{title}</h2>
        <div className="billing-chart__empty">{empty}</div>
      </section>
    );
  }
  const maxTokens = Math.max(
    ...groups.map((group) => group.summary.inputTokens + group.summary.outputTokens),
    1,
  );
  const totalCost = groups.reduce((sum, group) => sum + group.summary.cost, 0);

  return (
    <section className="billing-card billing-breakdown">
      <h2>{title}</h2>
      <div className="billing-breakdown__rows">
        {groups.map((group) => {
          const tokens = group.summary.inputTokens + group.summary.outputTokens;
          const share = (tokens / maxTokens) * 100;
          const costShare = totalCost > 0 ? (group.summary.cost / totalCost) * 100 : 0;
          return (
            <div className="billing-row" key={group.key}>
              <div className="billing-row__top">
                <span className="billing-row__label" title={group.label}>
                  {group.label}
                </span>
                <span className="billing-row__cost">
                  {group.summary.unpricedRequests === group.summary.requests
                    ? '—'
                    : formatCost(group.summary.cost)}
                </span>
              </div>
              <div className="billing-row__meter" aria-hidden="true">
                <i style={{ width: `${Math.max(share, 1)}%` }} />
              </div>
              <div className="billing-row__meta">
                <span>{formatTokens(tokens)} tokens</span>
                <span>{t('billing.breakdown.requests', { count: group.summary.requests })}</span>
                <span>
                  {group.summary.unpricedRequests === group.summary.requests
                    ? t('billing.breakdown.notCounted')
                    : t('billing.breakdown.costShare', { percent: costShare.toFixed(1) })}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function BillingPage({ records, onClear, fxRate }: Props) {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [confirmClear, setConfirmClear] = useState(false);
  const [exportNote, setExportNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const now = Date.now();
  const today = useMemo(() => summarize(records.filter((record) => record.at >= startOfDay(now))), [records, now]);
  const month = useMemo(() => summarize(records.filter((record) => record.at >= startOfMonth(now))), [records, now]);
  const all = useMemo(() => summarize(records), [records]);

  const from = startOfDay(now) - (days - 1) * 86_400_000;
  const period = useMemo(() => records.filter((record) => record.at >= from), [records, from]);
  const points = useMemo(() => dailySeries(records, days, now), [records, days, now]);

  const byModel = useMemo(
    () => groupRecords(period, (record) => record.model, (record) => record.model),
    [period],
  );
  const featureLabel = (feature: string) => {
    const key = FEATURE_LABELS[feature];
    return key ? t(key) : feature;
  };
  const byFeature = useMemo(
    () =>
      groupRecords(
        period,
        (record) => record.feature,
        (record) => featureLabel(record.feature),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, t],
  );
  const byProvider = useMemo(
    () =>
      groupRecords(
        period,
        (record) => record.providerId || record.providerName,
        (record) => record.providerName || record.providerId,
      ),
    [period],
  );

  const recent = useMemo(() => [...records].sort((a, b) => b.at - a.at).slice(0, 120), [records]);
  const estimatedCount = records.filter((record) => !record.reported).length;

  async function exportCsv() {
    setExportNote(null);
    const header = [
      t('billing.csv.time'),
      t('billing.csv.feature'),
      t('billing.csv.provider'),
      t('billing.csv.model'),
      t('billing.csv.inputTokens'),
      t('billing.csv.outputTokens'),
      t('billing.csv.cost'),
      t('billing.csv.fxRate'),
      t('billing.csv.priceSource'),
      t('billing.csv.estimated'),
    ];
    const rows = [...records]
      .sort((a, b) => a.at - b.at)
      .map((record) => [
        new Date(record.at).toISOString(),
        featureLabel(record.feature),
        record.providerName,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cost === null ? '' : record.cost.toFixed(6),
        record.fxRate.toFixed(2),
        record.priceSource,
        record.reported ? t('billing.csv.no') : t('billing.csv.yes'),
      ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const result = await window.ezness?.usageExport?.({
      csv,
      filename: `ezness-usage-${stamp}.csv`,
    });

    if (!result) {
      setExportNote({ tone: 'err', text: t('billing.export.unavailable') });
      return;
    }
    if (result.canceled) return;
    if (result.ok) {
      setExportNote({ tone: 'ok', text: t('billing.export.saved', { path: result.path ?? '' }) });
    } else {
      setExportNote({
        tone: 'err',
        text: t('billing.export.failed', {
          error: result.error ?? t('billing.export.unknownError'),
        }),
      });
    }
  }

  async function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    await onClear();
  }

  return (
    <div className="billing">
      <div className="billing__body">
        <header className="billing__head">
          <div>
            <h1>{t('billing.title')}</h1>
            <p>{t('billing.subtitle', { fxRate: fxRate.toFixed(2) })}</p>
          </div>
          <div className="billing__actions">
            <div className="billing__range" role="group" aria-label={t('billing.rangeAria')}>
              {RANGES.map((range) => (
                <button
                  key={range.days}
                  className={days === range.days ? 'is-on' : ''}
                  onClick={() => setDays(range.days)}
                >
                  {t(range.labelKey)}
                </button>
              ))}
            </div>
            <button className="btn btn--ghost billing__export" onClick={exportCsv} disabled={records.length === 0}>
              {t('billing.exportCsv')}
            </button>
            <button
              className={`btn btn--ghost billing__clear ${confirmClear ? 'is-confirm' : ''}`}
              onClick={() => void handleClear()}
              disabled={records.length === 0}
              onBlur={() => setConfirmClear(false)}
            >
              {confirmClear ? t('billing.confirmClear') : t('billing.clear')}
            </button>
          </div>
        </header>

        {exportNote && (
          <p
            className={`billing__export-note is-${exportNote.tone}`}
            role="status"
            title={exportNote.text}
          >
            {exportNote.text}
          </p>
        )}

        <section className="billing__stats">
          <StatCard
            label={t('billing.stat.today')}
            value={costValue(today)}
            hint={t('billing.stat.hintRequests', {
              tokens: formatTokens(today.inputTokens + today.outputTokens),
              requests: today.requests,
            })}
            hero
          />
          <StatCard
            label={t('billing.stat.month')}
            value={costValue(month)}
            hint={t('billing.stat.hint', {
              tokens: formatTokens(month.inputTokens + month.outputTokens),
              requests: month.requests,
            })}
          />
          <StatCard
            label={t('billing.stat.all')}
            value={costValue(all)}
            hint={t('billing.stat.hint', {
              tokens: formatTokens(all.inputTokens + all.outputTokens),
              requests: all.requests,
            })}
          />
          <StatCard
            label={t('billing.stat.estimated')}
            value={t('billing.stat.estimatedValue', { count: estimatedCount })}
            hint={
              records.length > 0
                ? t('billing.stat.estimatedHint', {
                    total: records.length,
                    unpriced: all.unpricedRequests,
                  })
                : t('billing.stat.noRecords')
            }
          />
        </section>

        {records.length === 0 ? (
          <section className="billing-card billing__empty">
            <h2>{t('billing.empty.title')}</h2>
            <p>{t('billing.empty.body')}</p>
          </section>
        ) : (
          <>
            <section className="billing__charts">
              <div className="billing-card">
                <div className="billing-card__head">
                  <h2>{t('billing.chart.tokensTitle')}</h2>
                  <span>{t('billing.chart.tokensSubtitle', { days })}</span>
                </div>
                <TokenChart points={points} />
              </div>
              <div className="billing-card">
                <div className="billing-card__head">
                  <h2>{t('billing.chart.costTitle')}</h2>
                  <span>{t('billing.chart.costSubtitle', { days })}</span>
                </div>
                <CostChart points={points} />
              </div>
            </section>

            <details className="billing__table-view">
              <summary>{t('billing.table.summary')}</summary>
              <div className="billing-table__scroll">
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>{t('billing.table.date')}</th>
                      <th className="num">{t('billing.table.input')}</th>
                      <th className="num">{t('billing.table.output')}</th>
                      <th className="num">{t('billing.table.requests')}</th>
                      <th className="num">{t('billing.table.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map((point) => (
                      <tr key={point.key}>
                        <td>{point.label}</td>
                        <td className="num">{point.inputTokens.toLocaleString('en-US')}</td>
                        <td className="num">{point.outputTokens.toLocaleString('en-US')}</td>
                        <td className="num">{point.requests}</td>
                        <td className="num">{formatCost(point.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <section className="billing__breakdowns">
              <Breakdown
                title={t('billing.breakdown.models')}
                groups={byModel}
                empty={t('billing.breakdown.emptyModels')}
              />
              <Breakdown
                title={t('billing.breakdown.features')}
                groups={byFeature}
                empty={t('billing.breakdown.emptyFeatures')}
              />
              <Breakdown
                title={t('billing.breakdown.providers')}
                groups={byProvider}
                empty={t('billing.breakdown.emptyProviders')}
              />
            </section>

            <section className="billing-card billing__records">
              <div className="billing-card__head">
                <h2>{t('billing.records.title')}</h2>
                <span>{t('billing.records.subtitle', { count: recent.length })}</span>
              </div>
              <div className="billing-table__scroll">
                <table className="billing-table billing-table--records">
                  <thead>
                    <tr>
                      <th>{t('billing.records.time')}</th>
                      <th>{t('billing.records.feature')}</th>
                      <th>{t('billing.records.model')}</th>
                      <th className="num">{t('billing.table.input')}</th>
                      <th className="num">{t('billing.table.output')}</th>
                      <th className="num">{t('billing.table.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((record) => (
                      <tr key={record.id}>
                        <td className="billing-table__time">{formatDateTime(record.at)}</td>
                        <td>
                          <span className={`billing-chip billing-chip--${record.feature}`}>
                            {featureLabel(record.feature)}
                          </span>
                        </td>
                        <td>
                          <div className="billing-table__model" title={`${record.providerName} · ${record.model}`}>
                            <span>{record.model}</span>
                            <small>{record.providerName}</small>
                          </div>
                        </td>
                        <td className="num">{record.inputTokens.toLocaleString('en-US')}</td>
                        <td className="num">{record.outputTokens.toLocaleString('en-US')}</td>
                        <td className="num">
                          {record.priced ? (
                            <span className="billing-table__cost" title={formatCostExact(record.cost)}>
                              {formatCost(record.cost)}
                              {!record.reported && (
                                <i className="billing-est">{t('billing.records.estimatedBadge')}</i>
                              )}
                            </span>
                          ) : (
                            <span
                              className="billing-unknown"
                              title={t('billing.records.unpricedTitle')}
                            >
                              {t('billing.records.unpriced')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="billing__footnote">
                {t('billing.footnote')}
                {estimatedCount > 0
                  ? t('billing.footnote.counts', {
                      total: records.length,
                      estimated: estimatedCount,
                    })
                  : ''}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
