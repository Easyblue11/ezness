import { useMemo, useState } from 'react';
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
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
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
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...points.map((point) => point.inputTokens + point.outputTokens), 0));
  const band = points.length > 0 ? PLOT_W / points.length : PLOT_W;
  const barWidth = Math.max(3, Math.min(24, band * 0.58));
  const every = axisLabelEvery(points.length);
  const ticks = [0, 1, 2, 3, 4];

  if (points.every((point) => point.inputTokens + point.outputTokens === 0)) {
    return <div className="billing-chart__empty">这段时间还没有用量。</div>;
  }

  const active = hover !== null ? points[hover] : null;
  const activeX = hover !== null ? PAD.left + band * hover + band / 2 : 0;

  return (
    <div className="billing-chart">
      <div className="billing-chart__legend">
        <span><i className="swatch swatch--input" />输入</span>
        <span><i className="swatch swatch--output" />输出</span>
      </div>
      <div className="billing-chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每日 Token 消耗，按输入与输出堆叠">
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
            <div className="billing-tip__row"><span>输入</span><b>{formatTokens(active.inputTokens)}</b></div>
            <div className="billing-tip__row"><span>输出</span><b>{formatTokens(active.outputTokens)}</b></div>
            <div className="billing-tip__row"><span>请求</span><b>{active.requests}</b></div>
            <div className="billing-tip__row"><span>费用</span><b>{formatCost(active.cost)}</b></div>
          </div>
        )}
      </div>
    </div>
  );
}

function CostChart({ points }: { points: DayPoint[] }) {
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
    return <div className="billing-chart__empty">这段时间还没有可计价的费用。</div>;
  }

  return (
    <div className="billing-chart">
      <div className="billing-chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每日费用折线图">
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
            <div className="billing-tip__row"><span>费用</span><b>{formatCost(active.cost)}</b></div>
            <div className="billing-tip__row"><span>请求</span><b>{active.requests}</b></div>
            {active.unpriced > 0 && (
              <div className="billing-tip__note">{active.unpriced} 次未定价</div>
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
                <span>{group.summary.requests} 次</span>
                <span>
                  {group.summary.unpricedRequests === group.summary.requests
                    ? '未计入费用'
                    : `${costShare.toFixed(1)}% 费用`}
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
  const byFeature = useMemo(
    () =>
      groupRecords(
        period,
        (record) => record.feature,
        (record) => FEATURE_LABELS[record.feature] ?? record.feature,
      ),
    [period],
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
      '时间',
      '功能',
      '供应商',
      '模型',
      '输入 tokens',
      '输出 tokens',
      '费用 (CNY)',
      '折算汇率',
      '计价来源',
      '是否估算',
    ];
    const rows = [...records]
      .sort((a, b) => a.at - b.at)
      .map((record) => [
        new Date(record.at).toISOString(),
        FEATURE_LABELS[record.feature] ?? record.feature,
        record.providerName,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cost === null ? '' : record.cost.toFixed(6),
        record.fxRate.toFixed(2),
        record.priceSource,
        record.reported ? '否' : '是',
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
      setExportNote({ tone: 'err', text: '导出不可用：当前版本的预加载脚本缺少导出接口，请重启应用。' });
      return;
    }
    if (result.canceled) return;
    if (result.ok) {
      setExportNote({ tone: 'ok', text: `已导出：${result.path ?? ''}` });
    } else {
      setExportNote({ tone: 'err', text: `导出失败：${result.error ?? '未知错误'}` });
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
            <h1>计费统计</h1>
            <p>
              每次模型请求都记一条：优先使用供应商返回的精确用量，没有返回时按字符估算。金额按人民币显示，
              模型原价按 1:{fxRate.toFixed(2)} 的汇率折算。
            </p>
          </div>
          <div className="billing__actions">
            <div className="billing__range" role="group" aria-label="统计范围">
              {RANGES.map((range) => (
                <button
                  key={range.days}
                  className={days === range.days ? 'is-on' : ''}
                  onClick={() => setDays(range.days)}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <button className="btn btn--ghost billing__export" onClick={exportCsv} disabled={records.length === 0}>
              导出 CSV
            </button>
            <button
              className={`btn btn--ghost billing__clear ${confirmClear ? 'is-confirm' : ''}`}
              onClick={() => void handleClear()}
              disabled={records.length === 0}
              onBlur={() => setConfirmClear(false)}
            >
              {confirmClear ? '确认清空？' : '清空统计'}
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
            label="今日费用"
            value={costValue(today)}
            hint={`${formatTokens(today.inputTokens + today.outputTokens)} tokens · ${today.requests} 次请求`}
            hero
          />
          <StatCard
            label="本月费用"
            value={costValue(month)}
            hint={`${formatTokens(month.inputTokens + month.outputTokens)} tokens · ${month.requests} 次`}
          />
          <StatCard
            label="累计费用"
            value={costValue(all)}
            hint={`${formatTokens(all.inputTokens + all.outputTokens)} tokens · ${all.requests} 次`}
          />
          <StatCard
            label="估算记录"
            value={`${estimatedCount} 条`}
            hint={records.length > 0 ? `共 ${records.length} 条记录，${all.unpricedRequests} 条未定价` : '还没有记录'}
          />
        </section>

        {records.length === 0 ? (
          <section className="billing-card billing__empty">
            <h2>还没有用量记录</h2>
            <p>发起一次对话、压缩一次上下文，或在工作空间里跑一个任务，这里就会出现对应的 token 与费用。</p>
          </section>
        ) : (
          <>
            <section className="billing__charts">
              <div className="billing-card">
                <div className="billing-card__head">
                  <h2>每日 Token</h2>
                  <span>近 {days} 天 · 堆叠显示输入与输出</span>
                </div>
                <TokenChart points={points} />
              </div>
              <div className="billing-card">
                <div className="billing-card__head">
                  <h2>每日费用</h2>
                  <span>近 {days} 天 · 未定价请求不计入</span>
                </div>
                <CostChart points={points} />
              </div>
            </section>

            <details className="billing__table-view">
              <summary>查看每日数据表</summary>
              <div className="billing-table__scroll">
                <table className="billing-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th className="num">输入</th>
                      <th className="num">输出</th>
                      <th className="num">请求</th>
                      <th className="num">费用</th>
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
              <Breakdown title="按模型" groups={byModel} empty="这段时间没有按模型的数据。" />
              <Breakdown title="按功能" groups={byFeature} empty="这段时间没有按功能的数据。" />
              <Breakdown title="按供应商" groups={byProvider} empty="这段时间没有按供应商的数据。" />
            </section>

            <section className="billing-card billing__records">
              <div className="billing-card__head">
                <h2>最近请求</h2>
                <span>最近 {recent.length} 条 · 悬停金额可查看精确值</span>
              </div>
              <div className="billing-table__scroll">
                <table className="billing-table billing-table--records">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>功能</th>
                      <th>模型</th>
                      <th className="num">输入</th>
                      <th className="num">输出</th>
                      <th className="num">费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((record) => (
                      <tr key={record.id}>
                        <td className="billing-table__time">{formatDateTime(record.at)}</td>
                        <td>
                          <span className={`billing-chip billing-chip--${record.feature}`}>
                            {FEATURE_LABELS[record.feature] ?? record.feature}
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
                              {!record.reported && <i className="billing-est">估</i>}
                            </span>
                          ) : (
                            <span className="billing-unknown" title="没有这个模型的价格">未定价</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="billing__footnote">
                带「估」的记录表示供应商没有返回 usage，token 数由字符估算；出现未定价时，费用合计会偏低。
                {estimatedCount > 0 ? ` 当前共 ${records.length} 条记录，其中 ${estimatedCount} 条为估算。` : ''}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
