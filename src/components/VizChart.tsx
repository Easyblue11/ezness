import { useMemo, useRef, useState } from 'react';
import type { VizChart, VizDatum, VizSeries, VizXYDatum } from '../types';
import { useElementWidth } from '../lib/useElementWidth';

/**
 * SVG chart renderer for the workspace visualization.
 *
 * The model supplies numbers only; this file owns the palette, geometry and
 * interaction. Colors come from the theme's validated categorical tokens
 * (`--viz-1` … `--viz-8`), assigned in fixed order. A ninth series is never
 * generated: the backend folds pie tails into 其他, and line series are capped
 * at four. Scatter is capped at three series (all-pairs CVD rule).
 */

/** Narrow cards keep text at this size; wide cards use WIDE_W so it doesn't scale up. */
const H = 260;
const COLORS = Array.from({ length: 8 }, (_, index) => `var(--viz-${index + 1})`);

let gradientSeq = 0;

/** Stable SVG gradient id per card (ids must be unique across the document). */
function useGradientId(): string {
  const idRef = useRef('');
  if (!idRef.current) idRef.current = `viz-bar-${(gradientSeq += 1)}`;
  return idRef.current;
}

/**
 * A light-to-solid fill keeps large bars from reading as flat blocks, the same
 * way the reference dashboards shade their headline series.
 */
function BarGradient({
  id,
  color,
  vertical = true,
}: {
  id: string;
  color: string;
  vertical?: boolean;
}) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '0'}>
        <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.68 }} />
        <stop offset="100%" style={{ stopColor: color, stopOpacity: 1 }} />
      </linearGradient>
    </defs>
  );
}

const TYPE_LABEL: Record<VizChart['type'], string> = {
  line: '折线图',
  'smooth-line': '曲线图',
  scatter: '散点图',
  pie: '饼图',
  bar: '柱状图',
  'horizontal-bar': '条形图',
  'grouped-bar': '分组柱状图',
  progress: '占比条',
  table: '表格',
};

interface TooltipRow {
  name: string;
  color: string;
  value: string;
}

interface TooltipState {
  left: number;
  top: number;
  title: string;
  rows: TooltipRow[];
  note?: string;
}

function isDatum(point: VizDatum | VizXYDatum): point is VizDatum {
  return typeof (point as VizDatum).label === 'string' && !('x' in point);
}

function isXY(point: VizDatum | VizXYDatum): point is VizXYDatum {
  return typeof (point as VizXYDatum).x === 'number';
}

function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function fmt(value: number, unit = ''): string {
  const abs = Math.abs(value);
  let text: string;
  if (abs >= 100000000) text = `${trim(value / 100000000)}亿`;
  else if (abs >= 10000) text = `${trim(value / 10000)}万`;
  else if (abs >= 1000) text = value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  else text = value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return unit ? `${text}${unit}` : text;
}

/** Exact numbers for the table view; charts may abbreviate, tables must not. */
function fmtFull(value: number, unit = ''): string {
  const rounded = Math.round(value * 100) / 100;
  const text = rounded.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return unit ? `${text}${unit}` : text;
}

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Long axis labels lose their middle, not their end: "2022-04-26" becomes
 * "202…26", which still tells the categories apart, while plain truncation
 * turned every date in a series into the same "2022-…".
 */
function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function niceScale(min: number, max: number, count = 4): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const step0 = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = lo; value <= hi + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { min: lo, max: hi, ticks };
}

function lineCategories(series: VizSeries[]): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const item of series) {
    for (const point of item.points) {
      if (!isDatum(point) || seen.has(point.label)) continue;
      seen.add(point.label);
      categories.push(point.label);
    }
  }
  return categories;
}

/** Wide cards use a wider viewBox so text keeps its size instead of scaling up. */
const WIDE_W = 1120;

function pointerAt(svg: SVGSVGElement, event: React.MouseEvent, width: number, height: number) {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * width,
    y: ((event.clientY - rect.top) / rect.height) * height,
    px: event.clientX - rect.left,
    py: event.clientY - rect.top,
    width: rect.width,
  };
}

function tooltipAt(
  px: number,
  py: number,
  width: number,
  title: string,
  rows: TooltipRow[],
  note?: string,
): TooltipState {
  // Keep the bubble's centre far enough from the edges that it stays inside
  // the card even at its widest.
  const half = Math.min(120, width / 2);
  return {
    left: clamp(px, half, Math.max(half, width - half)),
    // The tooltip sits above the pointer; keep it below the card's title row.
    top: Math.max(92, py - 10),
    title,
    rows,
    note,
  };
}

function Tooltip({ state }: { state: TooltipState }) {
  return (
    <div className="viz-tooltip" style={{ left: state.left, top: state.top }}>
      <div className="viz-tooltip__title">{state.title}</div>
      {state.rows.map((row, index) => (
        <div className="viz-tooltip__row" key={`${row.name}-${index}`}>
          <span className="viz-swatch" style={{ background: row.color }} aria-hidden="true" />
          <span className="viz-tooltip__name">{row.name}</span>
          <span className="viz-tooltip__value">{row.value}</span>
        </div>
      ))}
      {state.note && <div className="viz-tooltip__note">{state.note}</div>}
    </div>
  );
}

/* ---------------- line / smooth line ---------------- */

function LineChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);
  const [crossIndex, setCrossIndex] = useState<number | null>(null);

  const series = useMemo(
    () =>
      (chart.series ?? [])
        .map((item, index) => ({
          name: item.name || `系列 ${index + 1}`,
          color: COLORS[index % COLORS.length],
          points: item.points.filter(isDatum),
        }))
        .filter((item) => item.points.length >= 2),
    [chart.series],
  );
  const categories = useMemo(() => lineCategories(series), [series]);

  // Extra bottom space keeps rotated category labels inside the SVG.
  const pad = { top: 18, right: 18, bottom: 64, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const scale = niceScale(Math.min(...values), Math.max(...values), 4);
  const yOf = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const xOf = (index: number) =>
    categories.length <= 1
      ? pad.left + plotW / 2
      : pad.left + (index / (categories.length - 1)) * plotW;

  const byLabel = useMemo(
    () =>
      series.map((item) => {
        const valuesByLabel = new Map<string, number>();
        for (const point of item.points) valuesByLabel.set(point.label, point.value);
        return valuesByLabel;
      }),
    [series],
  );

  // Turn the labels as soon as the bands get narrow, not only when there are
  // many of them.
  const rotateLabels = categories.length > 7 || plotW / Math.max(1, categories.length) < 56;

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || categories.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, H);
    const index =
      categories.length <= 1
        ? 0
        : clamp(Math.round(((point.x - pad.left) / plotW) * (categories.length - 1)), 0, categories.length - 1);
    const label = categories[index];
    const rows = series.map((item, seriesIndex) => {
      const value = byLabel[seriesIndex]?.get(label);
      return {
        name: item.name,
        color: item.color,
        value: value === undefined ? '—' : fmt(value, chart.unit),
      };
    });
    setCrossIndex(index);
    setHover(tooltipAt(point.px, point.py, point.width, label, rows));
  };

  if (categories.length < 2) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          setCrossIndex(null);
        }}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line
              className="viz-grid-line"
              x1={pad.left}
              x2={W - pad.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
            />
            <text className="viz-axis-text" x={pad.left - 8} y={yOf(tick) + 3.5} textAnchor="end">
              {fmt(tick)}
            </text>
          </g>
        ))}

        {categories.map((label, index) => {
          const x = xOf(index);
          return (
            <g key={`${label}-${index}`}>
              <title>{label}</title>
              <text
                className="viz-axis-text"
                x={x}
                y={H - pad.bottom + 16}
                textAnchor={rotateLabels ? 'end' : 'middle'}
                transform={rotateLabels ? `rotate(-22 ${x} ${H - pad.bottom + 16})` : undefined}
              >
                {middle(label, 7)}
              </text>
            </g>
          );
        })}

        <line
          className="viz-axis-line"
          x1={pad.left}
          x2={W - pad.right}
          y1={H - pad.bottom}
          y2={H - pad.bottom}
        />
        <line className="viz-axis-line" x1={pad.left} x2={pad.left} y1={pad.top} y2={H - pad.bottom} />

        {series.map((item) => {
          const points = item.points
            .map((point) => ({ index: categories.indexOf(point.label), value: point.value }))
            .filter((point) => point.index >= 0)
            .sort((a, b) => a.index - b.index);
          if (points.length < 2) return null;
          let path = `M${xOf(points[0].index)},${yOf(points[0].value)}`;
          if (chart.type === 'smooth-line') {
            for (let index = 0; index < points.length - 1; index += 1) {
              const p0 = points[index - 1] ?? points[index];
              const p1 = points[index];
              const p2 = points[index + 1];
              const p3 = points[index + 2] ?? p2;
              const c1x = xOf(p1.index) + (xOf(p2.index) - xOf(p0.index)) / 6;
              const c1y = yOf(p1.value) + (yOf(p2.value) - yOf(p0.value)) / 6;
              const c2x = xOf(p2.index) - (xOf(p3.index) - xOf(p1.index)) / 6;
              const c2y = yOf(p2.value) - (yOf(p3.value) - yOf(p1.value)) / 6;
              path += ` C${c1x},${c1y} ${c2x},${c2y} ${xOf(p2.index)},${yOf(p2.value)}`;
            }
          } else {
            for (let index = 1; index < points.length; index += 1) {
              path += ` L${xOf(points[index].index)},${yOf(points[index].value)}`;
            }
          }
          return (
            <g key={item.name}>
              <path className="viz-line" d={path} stroke={item.color} />
              {points.map((point) => (
                <circle
                  key={point.index}
                  className="viz-point"
                  cx={xOf(point.index)}
                  cy={yOf(point.value)}
                  r={3.2}
                  fill={item.color}
                />
              ))}
            </g>
          );
        })}

        {crossIndex !== null && (
          <line
            className="viz-crosshair"
            x1={xOf(crossIndex)}
            x2={xOf(crossIndex)}
            y1={pad.top}
            y2={H - pad.bottom}
          />
        )}
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

/* ---------------- scatter ---------------- */

function ScatterChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);

  const series = useMemo(
    () =>
      (chart.series ?? [])
        .slice(0, 3)
        .map((item, index) => ({
          name: item.name || `系列 ${index + 1}`,
          color: COLORS[index % COLORS.length],
          points: item.points.filter(isXY),
        }))
        .filter((item) => item.points.length > 0),
    [chart.series],
  );

  const pad = { top: 18, right: 22, bottom: 46, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const all = series.flatMap((item) => item.points);
  const xScale = niceScale(Math.min(...all.map((point) => point.x)), Math.max(...all.map((point) => point.x)), 5);
  const yScale = niceScale(Math.min(...all.map((point) => point.y)), Math.max(...all.map((point) => point.y)), 4);
  const xOf = (value: number) =>
    pad.left + ((value - xScale.min) / (xScale.max - xScale.min || 1)) * plotW;
  const yOf = (value: number) =>
    pad.top + plotH - ((value - yScale.min) / (yScale.max - yScale.min || 1)) * plotH;

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || all.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, H);
    let best: { series: (typeof series)[number]; point: VizXYDatum; distance: number } | null = null;
    for (const item of series) {
      for (const dot of item.points) {
        const distance = Math.hypot(xOf(dot.x) - point.x, yOf(dot.y) - point.y);
        if (!best || distance < best.distance) best = { series: item, point: dot, distance };
      }
    }
    if (!best || best.distance > 22) {
      setHover(null);
      return;
    }
    const rows = [
      { name: chart.xLabel || 'X', color: best.series.color, value: fmt(best.point.x, chart.unit) },
      { name: chart.yLabel || 'Y', color: best.series.color, value: fmt(best.point.y, chart.unit) },
    ];
    const title = [best.series.name, best.point.label].filter(Boolean).join(' · ');
    setHover(tooltipAt(point.px, point.py, point.width, title, rows));
  };

  if (all.length < 2) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => setHover(null)}
      >
        {yScale.ticks.map((tick) => (
          <g key={`y-${tick}`}>
            <line className="viz-grid-line" x1={pad.left} x2={W - pad.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="viz-axis-text" x={pad.left - 8} y={yOf(tick) + 3.5} textAnchor="end">
              {fmt(tick)}
            </text>
          </g>
        ))}
        {xScale.ticks.map((tick) => (
          <g key={`x-${tick}`}>
            <line className="viz-grid-line" x1={xOf(tick)} x2={xOf(tick)} y1={pad.top} y2={H - pad.bottom} />
            <text className="viz-axis-text" x={xOf(tick)} y={H - pad.bottom + 18} textAnchor="middle">
              {fmt(tick)}
            </text>
          </g>
        ))}
        <line className="viz-axis-line" x1={pad.left} x2={W - pad.right} y1={H - pad.bottom} y2={H - pad.bottom} />
        <line className="viz-axis-line" x1={pad.left} x2={pad.left} y1={pad.top} y2={H - pad.bottom} />

        {series.map((item) => (
          <g key={item.name}>
            {item.points.map((point, index) => (
              <circle
                key={`${point.x}-${point.y}-${index}`}
                className="viz-point viz-point--scatter"
                cx={xOf(point.x)}
                cy={yOf(point.y)}
                r={4}
                fill={item.color}
              />
            ))}
          </g>
        ))}
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

/* ---------------- bars ---------------- */

function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  roundTop: boolean,
): string {
  if (height <= 0.4 || width <= 0) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  if (roundTop) {
    return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${
      x + width
    },${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
  }
  return `M${x},${y} L${x},${y + height - r} Q${x},${y + height} ${x + r},${y + height} L${
    x + width - r
  },${y + height} Q${x + width},${y + height} ${x + width},${y + height - r} L${x + width},${y} Z`;
}

function hBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  roundRight: boolean,
): string {
  if (width <= 0.4 || height <= 0) return '';
  const r = Math.max(0, Math.min(radius, height / 2, width));
  if (roundRight) {
    return `M${x},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${
      y + height - r
    } Q${x + width},${y + height} ${x + width - r},${y + height} L${x},${y + height} Z`;
  }
  return `M${x + width},${y} L${x + r},${y} Q${x},${y} ${x},${y + r} L${x},${y + height - r} Q${x},${
    y + height
  } ${x + r},${y + height} L${x + width},${y + height} Z`;
}

function BarChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const items = useMemo(() => (chart.items ?? []).filter((item) => Number.isFinite(item.value)), [chart.items]);

  const gradientId = useGradientId();
  const pad = { top: 22, right: 18, bottom: 64, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const values = items.map((item) => item.value);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  const yOf = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const band = plotW / Math.max(1, items.length);
  const barW = Math.min(40, band * 0.5);
  // Turn the labels as soon as the bands are narrow, not only when there are
  // many of them: five dates in a one-track card overlap otherwise.
  const rotateLabels = items.length > 7 || band < 56;
  // How much of a label fits in one band (roughly 5.6px per character).
  const labelChars = rotateLabels
    ? Math.max(4, Math.min(7, Math.floor(band / 6)))
    : Math.max(4, Math.min(10, Math.floor(band / 5.6)));
  // Values on top of the bars need room of their own; in a narrow card they
  // would run into each other, and the tooltip still shows them.
  const showValues = band >= 46;

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || items.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, H);
    if (point.x < pad.left || point.x > W - pad.right) {
      setHover(null);
      setHoverIndex(null);
      return;
    }
    const index = clamp(Math.floor((point.x - pad.left) / band), 0, items.length - 1);
    const item = items[index];
    setHoverIndex(index);
    setHover(
      tooltipAt(point.px, point.py, point.width, item.label, [
        {
          name: chart.yLabel || '数值',
          color: COLORS[0],
          value: fmt(item.value, chart.unit),
        },
      ]),
    );
  };

  if (items.length === 0) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          setHoverIndex(null);
        }}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="viz-grid-line" x1={pad.left} x2={W - pad.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="viz-axis-text" x={pad.left - 8} y={yOf(tick) + 3.5} textAnchor="end">
              {fmt(tick)}
            </text>
          </g>
        ))}

        <BarGradient id={gradientId} color={COLORS[0]} />
        {items.map((item, index) => {
          const center = pad.left + band * index + band / 2;
          const x = center - barW / 2;
          const zero = yOf(0);
          const valueY = yOf(item.value);
          const top = Math.min(zero, valueY);
          const height = Math.abs(valueY - zero);
          return (
            <g key={`${item.label}-${index}`}>
              <rect
                className={`viz-hover-band ${hoverIndex === index ? 'is-active' : ''}`}
                x={pad.left + band * index}
                y={pad.top}
                width={band}
                height={plotH}
                rx={4}
              />
              <path
                d={barPath(x, top, barW, height, 4, item.value >= 0)}
                fill={`url(#${gradientId})`}
              />
              {showValues && (
                <text
                  className="viz-value-text"
                  x={center}
                  y={item.value >= 0 ? top - 6 : top + height + 13}
                  textAnchor="middle"
                >
                  {fmt(item.value, chart.unit)}
                </text>
              )}
              <g>
                <title>{item.label}</title>
                <text
                  className="viz-axis-text"
                  x={center}
                  y={H - pad.bottom + 16}
                  textAnchor={rotateLabels ? 'end' : 'middle'}
                  transform={rotateLabels ? `rotate(-22 ${center} ${H - pad.bottom + 16})` : undefined}
                >
                  {middle(item.label, labelChars)}
                </text>
              </g>
            </g>
          );
        })}

        <line className="viz-axis-line" x1={pad.left} x2={W - pad.right} y1={yOf(0)} y2={yOf(0)} />
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

/** Several measures side by side for the same categories (确诊 vs 死亡 …). */
function GroupedBarChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const gradientId = useGradientId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const series = useMemo(
    () =>
      (chart.series ?? [])
        .slice(0, 4)
        .map((item, index) => ({
          name: item.name || `系列 ${index + 1}`,
          color: COLORS[index % COLORS.length],
          points: item.points.filter(isDatum),
        }))
        .filter((item) => item.points.length > 0),
    [chart.series],
  );
  const categories = useMemo(() => lineCategories(series), [series]);
  const byLabel = useMemo(
    () =>
      series.map((item) => {
        const values = new Map<string, number>();
        for (const point of item.points) values.set(point.label, point.value);
        return values;
      }),
    [series],
  );

  const pad = { top: 22, right: 18, bottom: 64, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  const yOf = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min || 1)) * plotH;

  const band = plotW / Math.max(1, categories.length);
  const gap = 2;
  const groupW = Math.min(band * 0.74, series.length * 26);
  const barW = Math.max(3, (groupW - gap * (series.length - 1)) / Math.max(1, series.length));
  const rotateLabels = categories.length > 7 || band < 56;

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || categories.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, H);
    if (point.x < pad.left || point.x > W - pad.right) {
      setHover(null);
      setHoverIndex(null);
      return;
    }
    const index = clamp(Math.floor((point.x - pad.left) / band), 0, categories.length - 1);
    const label = categories[index];
    setHoverIndex(index);
    setHover(
      tooltipAt(
        point.px,
        point.py,
        point.width,
        label,
        series.map((item, seriesIndex) => {
          const value = byLabel[seriesIndex].get(label);
          return {
            name: item.name,
            color: item.color,
            value: value === undefined ? '—' : fmt(value, chart.unit),
          };
        }),
      ),
    );
  };

  if (series.length < 2 || categories.length < 2) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          setHoverIndex(null);
        }}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="viz-grid-line" x1={pad.left} x2={W - pad.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="viz-axis-text" x={pad.left - 8} y={yOf(tick) + 3.5} textAnchor="end">
              {fmt(tick)}
            </text>
          </g>
        ))}

        {series.map((item, index) => (
          <BarGradient key={item.name} id={`${gradientId}-${index}`} color={item.color} />
        ))}
        {categories.map((label, categoryIndex) => {
          const startX = pad.left + band * categoryIndex + (band - groupW) / 2;
          return (
            <g key={`${label}-${categoryIndex}`}>
              <rect
                className={`viz-hover-band ${hoverIndex === categoryIndex ? 'is-active' : ''}`}
                x={pad.left + band * categoryIndex}
                y={pad.top}
                width={band}
                height={plotH}
                rx={4}
              />
              {series.map((item, seriesIndex) => {
                const value = byLabel[seriesIndex].get(label);
                if (value === undefined) return null;
                const zero = yOf(0);
                const valueY = yOf(value);
                const top = Math.min(zero, valueY);
                const height = Math.abs(valueY - zero);
                return (
                  <path
                    key={item.name}
                    d={barPath(startX + seriesIndex * (barW + gap), top, barW, height, 4, value >= 0)}
                    fill={`url(#${gradientId}-${seriesIndex})`}
                  />
                );
              })}
              <g>
                <title>{label}</title>
                <text
                  className="viz-axis-text"
                  x={pad.left + band * categoryIndex + band / 2}
                  y={H - pad.bottom + 16}
                  textAnchor={rotateLabels ? 'end' : 'middle'}
                  transform={
                    rotateLabels
                      ? `rotate(-22 ${pad.left + band * categoryIndex + band / 2} ${H - pad.bottom + 16})`
                      : undefined
                  }
                >
                  {middle(label, rotateLabels ? 7 : 10)}
                </text>
              </g>
            </g>
          );
        })}

        <line className="viz-axis-line" x1={pad.left} x2={W - pad.right} y1={yOf(0)} y2={yOf(0)} />
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

function HorizontalBarChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const gradientId = useGradientId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const items = useMemo(() => (chart.items ?? []).filter((item) => Number.isFinite(item.value)), [chart.items]);

  const labelW = clamp(
    Math.max(...items.map((item) => item.label.length), 4) * 11 + 12,
    76,
    150,
  );
  const pad = { top: 16, right: 62, bottom: 34, left: labelW };
  // Every category needs its own row; a long list grows the chart instead of
  // squeezing twenty bars into the height of five.
  const viewH = Math.max(H, items.length * 26 + pad.top + pad.bottom);
  const plotW = W - pad.left - pad.right;
  const plotH = viewH - pad.top - pad.bottom;
  const values = items.map((item) => item.value);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  const xOf = (value: number) =>
    pad.left + ((value - scale.min) / (scale.max - scale.min || 1)) * plotW;
  const band = plotH / Math.max(1, items.length);
  const barH = Math.min(22, band * 0.62);

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || items.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, viewH);
    if (point.y < pad.top || point.y > viewH - pad.bottom) {
      setHover(null);
      setHoverIndex(null);
      return;
    }
    const index = clamp(Math.floor((point.y - pad.top) / band), 0, items.length - 1);
    const item = items[index];
    setHoverIndex(index);
    setHover(
      tooltipAt(point.px, point.py, point.width, item.label, [
        {
          name: chart.xLabel || '数值',
          color: COLORS[0],
          value: fmt(item.value, chart.unit),
        },
      ]),
    );
  };

  if (items.length === 0) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${viewH}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          setHoverIndex(null);
        }}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="viz-grid-line" x1={xOf(tick)} x2={xOf(tick)} y1={pad.top} y2={viewH - pad.bottom} />
            <text className="viz-axis-text" x={xOf(tick)} y={viewH - pad.bottom + 16} textAnchor="middle">
              {fmt(tick)}
            </text>
          </g>
        ))}

        <BarGradient id={gradientId} color={COLORS[0]} vertical={false} />
        {items.map((item, index) => {
          const center = pad.top + band * index + band / 2;
          const y = center - barH / 2;
          const zero = xOf(0);
          const valueX = xOf(item.value);
          const left = Math.min(zero, valueX);
          const width = Math.abs(valueX - zero);
          return (
            <g key={`${item.label}-${index}`}>
              <rect
                className={`viz-hover-band ${hoverIndex === index ? 'is-active' : ''}`}
                x={pad.left}
                y={pad.top + band * index}
                width={plotW}
                height={band}
                rx={4}
              />
              <path
                d={hBarPath(left, y, width, barH, 4, item.value >= 0)}
                fill={`url(#${gradientId})`}
              />
              <text className="viz-axis-text" x={pad.left - 8} y={center + 3.5} textAnchor="end">
                {short(item.label, 10)}
              </text>
              <text
                className="viz-value-text"
                x={item.value >= 0 ? valueX + 6 : valueX - 6}
                y={center + 3.5}
                textAnchor={item.value >= 0 ? 'start' : 'end'}
              >
                {fmt(item.value, chart.unit)}
              </text>
            </g>
          );
        })}

        <line className="viz-axis-line" x1={xOf(0)} x2={xOf(0)} y1={pad.top} y2={viewH - pad.bottom} />
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

/* ---------------- pie ---------------- */

function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function donutSlice(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  start: number,
  end: number,
): string {
  const span = end - start;
  if (span >= Math.PI * 2 - 1e-6) {
    return [
      `M${cx - outer},${cy}`,
      `A${outer},${outer} 0 1 1 ${cx + outer},${cy}`,
      `A${outer},${outer} 0 1 1 ${cx - outer},${cy}`,
      `M${cx - inner},${cy}`,
      `A${inner},${inner} 0 1 0 ${cx + inner},${cy}`,
      `A${inner},${inner} 0 1 0 ${cx - inner},${cy}`,
      'Z',
    ].join(' ');
  }
  const [x0, y0] = polar(cx, cy, outer, start);
  const [x1, y1] = polar(cx, cy, outer, end);
  const [x2, y2] = polar(cx, cy, inner, end);
  const [x3, y3] = polar(cx, cy, inner, start);
  const large = span > Math.PI ? 1 : 0;
  return `M${x0},${y0} A${outer},${outer} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${inner},${inner} 0 ${large} 0 ${x3},${y3} Z`;
}

function PieChart({ chart, basis = 560 }: { chart: VizChart; basis?: number }) {
  const W = basis;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hover, setHover] = useState<TooltipState | null>(null);
  const items = useMemo(
    () => (chart.items ?? []).filter((item) => Number.isFinite(item.value) && item.value > 0),
    [chart.items],
  );
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const cx = W / 2;
  const cy = H / 2 + 2;
  const outer = 104;
  const inner = 62;
  const angles = useMemo(() => {
    let cursor = -Math.PI / 2;
    return items.map((item) => {
      const span = total > 0 ? (item.value / total) * Math.PI * 2 : 0;
      const start = cursor;
      cursor += span;
      return { start, end: cursor };
    });
  }, [items, total]);

  const move = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || items.length === 0) return;
    const point = pointerAt(svgRef.current, event, W, H);
    const dx = point.x - cx;
    const dy = point.y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance < inner - 2 || distance > outer + 8) {
      setHover(null);
      setHoverIndex(null);
      return;
    }
    let angle = Math.atan2(dy, dx);
    if (angle < -Math.PI / 2) angle += Math.PI * 2;
    const index = angles.findIndex((slice) => angle >= slice.start && angle < slice.end);
    if (index < 0) {
      setHover(null);
      setHoverIndex(null);
      return;
    }
    const item = items[index];
    const percent = total > 0 ? (item.value / total) * 100 : 0;
    setHoverIndex(index);
    setHover(
      tooltipAt(point.px, point.py, point.width, item.label, [
        { name: '数值', color: COLORS[index % COLORS.length], value: fmt(item.value, chart.unit) },
      ], `占比 ${percent.toFixed(1)}%`),
    );
  };

  if (items.length === 0) return <div className="viz-empty">数据不足，无法绘图。</div>;

  return (
    <div className="viz-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={chart.title}
        onMouseMove={move}
        onMouseLeave={() => {
          setHover(null);
          setHoverIndex(null);
        }}
      >
        {items.map((item, index) => {
          const percent = total > 0 ? (item.value / total) * 100 : 0;
          const angle = (angles[index].start + angles[index].end) / 2;
          const [labelX, labelY] = polar(cx, cy, outer + 16, angle);
          return (
            <g key={`${item.label}-${index}`}>
              <path
                d={donutSlice(cx, cy, inner, outer, angles[index].start, angles[index].end)}
                fill={COLORS[index % COLORS.length]}
                opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.45}
                stroke="var(--bg-elevated)"
                strokeWidth={2}
              />
              {percent >= 8 && (
                <text
                  className="viz-axis-text"
                  x={labelX}
                  y={labelY + 3}
                  textAnchor={Math.cos(angle) >= 0 ? 'start' : 'end'}
                >
                  {percent.toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}
        <text className="viz-donut__total" x={cx} y={cy - 2} textAnchor="middle">
          {fmt(total, chart.unit)}
        </text>
        <text className="viz-donut__label" x={cx} y={cy + 16} textAnchor="middle">
          合计
        </text>
      </svg>
      {hover && <Tooltip state={hover} />}
    </div>
  );
}

/* ---------------- table + card ---------------- */

function DataTable({ chart }: { chart: VizChart }) {
  if (chart.type === 'line' || chart.type === 'smooth-line' || chart.type === 'grouped-bar') {
    const series = (chart.series ?? []).map((item) => ({
      name: item.name || '数值',
      points: item.points.filter(isDatum),
    }));
    const categories = lineCategories(series);
    return (
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>类别</th>
              {series.map((item) => (
                <th key={item.name}>{item.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((label) => (
              <tr key={label}>
                <td>{label}</td>
                {series.map((item) => {
                  const value = item.points.find((point) => point.label === label)?.value;
                  return <td key={item.name}>{value === undefined ? '—' : fmtFull(value, chart.unit)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chart.type === 'scatter') {
    const rows = (chart.series ?? []).flatMap((item) =>
      item.points.filter(isXY).map((point) => ({ name: item.name, point })),
    );
    return (
      <div className="viz-table-wrap">
        <table className="viz-table">
          <thead>
            <tr>
              <th>系列</th>
              <th>{chart.xLabel || 'X'}</th>
              <th>{chart.yLabel || 'Y'}</th>
              <th>标签</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.name}-${index}`}>
                <td>{row.name}</td>
                <td>{fmtFull(row.point.x, chart.unit)}</td>
                <td>{fmtFull(row.point.y, chart.unit)}</td>
                <td>{row.point.label || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const items = chart.items ?? [];
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>数值</th>
            {chart.type === 'pie' && <th>占比</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.label}-${index}`}>
              <td>{item.label}</td>
              <td>{fmtFull(item.value, chart.unit)}</td>
              {chart.type === 'pie' && (
                <td>{total > 0 ? `${((item.value / total) * 100).toFixed(1)}%` : '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Legend({ chart }: { chart: VizChart }) {
  if (chart.type === 'pie') {
    const items = chart.items ?? [];
    const total = items.reduce((sum, item) => sum + item.value, 0);
    return (
      <ul className="viz-legend viz-legend--values">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <span className="viz-swatch" style={{ background: COLORS[index % COLORS.length] }} />
            <span className="viz-legend__name">{item.label}</span>
            <span className="viz-legend__value">
              {fmt(item.value, chart.unit)}
              {total > 0 && <em>{((item.value / total) * 100).toFixed(1)}%</em>}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (
    chart.type === 'bar' ||
    chart.type === 'horizontal-bar' ||
    chart.type === 'progress' ||
    chart.type === 'table'
  ) {
    return null;
  }
  const series = chart.series ?? [];
  if (series.length < 2) return null;
  return (
    <ul className="viz-legend">
      {series.map((item, index) => (
        <li key={`${item.name}-${index}`}>
          <span className="viz-swatch" style={{ background: COLORS[index % COLORS.length] }} />
          <span className="viz-legend__name">{item.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** Share / completion ranking bars: label · track · value, one hue. */
function ProgressChart({ chart }: { chart: VizChart }) {
  const items = (chart.items ?? []).filter((item) => Number.isFinite(item.value) && item.value >= 0);
  const max = Math.max(...items.map((item) => item.value), 1);
  if (items.length === 0) return <div className="viz-empty">数据不足，无法绘图。</div>;
  return (
    <div className="viz-progress">
      {items.map((item, index) => (
        <div className="viz-progress__row" key={`${item.label}-${index}`}>
          <span className="viz-progress__label" title={item.label}>
            {short(item.label, 12)}
          </span>
          <span className="viz-progress__track">
            <span
              className="viz-progress__fill"
              style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%`, background: COLORS[0] }}
            />
          </span>
          <span className="viz-progress__value">{fmt(item.value, chart.unit)}</span>
        </div>
      ))}
    </div>
  );
}

/** The source table shown as-is: the "有图有表" half of a dashboard. */
function TableChart({ chart }: { chart: VizChart }) {
  const columns = chart.columns ?? [];
  const rows = chart.rows ?? [];
  if (columns.length === 0 || rows.length === 0) {
    return <div className="viz-empty">数据不足，无法生成表格。</div>;
  }
  return (
    <div className="viz-table-wrap viz-table-wrap--card">
      <table className="viz-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={`${column}-${index}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, cellIndex) => (
                <td key={cellIndex}>{row[cellIndex] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartBody({ chart, basis }: { chart: VizChart; basis?: number }) {
  // The viewBox is chosen from how wide the card actually is, so labels stay
  // readable whether the card spans four columns or the whole row.
  const size = basis ?? (chart.size === 'lg' ? WIDE_W : 560);
  if (chart.type === 'table') return <TableChart chart={chart} />;
  if (chart.type === 'progress') return <ProgressChart chart={chart} />;
  if (chart.type === 'line' || chart.type === 'smooth-line') return <LineChart chart={chart} basis={size} />;
  if (chart.type === 'scatter') return <ScatterChart chart={chart} basis={size} />;
  if (chart.type === 'bar') return <BarChart chart={chart} basis={size} />;
  if (chart.type === 'horizontal-bar') return <HorizontalBarChart chart={chart} basis={size} />;
  if (chart.type === 'grouped-bar') return <GroupedBarChart chart={chart} basis={size} />;
  return <PieChart chart={chart} basis={size} />;
}

export function VizChartCard({
  chart,
  span = 6,
  onOpenTable,
}: {
  chart: VizChart;
  span?: 3 | 4 | 6 | 8 | 12;
  /** Opens every row of the file this chart was built from. */
  onOpenTable?: (chart: VizChart) => void;
}) {
  const [table, setTable] = useState(false);
  // The viewBox follows the box the chart actually gets. Drawing at a fixed
  // width per span was why a fullscreen card blew the whole chart up: the SVG
  // was scaled to fit. Measuring keeps marks and labels at their real size.
  const [measureBody, width] = useElementWidth<HTMLDivElement>();
  const guess = span >= 12 ? WIDE_W : span >= 8 ? 760 : span >= 6 ? 560 : span >= 4 ? 400 : 340;
  const basis = width > 0 ? width : guess;
  return (
    <section
      className={`viz-card is-span-${span} ${span === 12 ? 'is-full' : ''}`}
    >
      <header className="viz-card__head">
        <div className="viz-card__titles">
          <h3>{chart.title}</h3>
          {chart.subtitle && <p>{chart.subtitle}</p>}
        </div>
        <div className="viz-card__tools">
          {chart.table && onOpenTable && (
            <button
              type="button"
              className="viz-card__sample"
              title={`图表只用了 ${chart.table.shown} 行抽样，文件里共有 ${chart.table.total} 行`}
              onClick={() => onOpenTable(chart)}
            >
              抽样 {chart.table.shown}/{chart.table.total} · 查看全部
            </button>
          )}
          <span className="viz-card__type">{TYPE_LABEL[chart.type]}</span>
          {chart.type !== 'table' && (
            <button
              type="button"
              className="viz-card__toggle"
              aria-pressed={table}
              onClick={() => setTable((value) => !value)}
            >
              {table ? '图表' : '表格'}
            </button>
          )}
        </div>
      </header>
      {table && chart.type !== 'table' ? (
        <DataTable chart={chart} />
      ) : (
        <div className="viz-chart-fit" ref={measureBody}>
          <ChartBody chart={chart} basis={basis} />
        </div>
      )}
      {!table && <Legend chart={chart} />}
      {(chart.xLabel || chart.yLabel) && !table && chart.type !== 'table' && (
        <p className="viz-card__axes">
          {chart.xLabel && <span>横轴：{chart.xLabel}</span>}
          {chart.yLabel && <span>纵轴：{chart.yLabel}</span>}
          {chart.unit && <span>单位：{chart.unit}</span>}
        </p>
      )}
      {chart.source && <p className="viz-card__source">数据来源：{chart.source}</p>}
    </section>
  );
}
