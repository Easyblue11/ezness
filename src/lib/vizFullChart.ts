import type { VizChart, VizChartType, VizDatum } from '../types';

/**
 * Rebuilds a chart from every row of the file behind a sampled card.
 *
 * The model only saw a slice, so the card's numbers are a slice too. Once the
 * renderer has re-read the whole table, this turns those rows back into the
 * same kind of chart: it finds the column the original chart was counting and
 * the column it was grouping by, then aggregates and ranks the real data.
 */

/** Most categories a full-data chart will draw; the rest are cut by rank. */
const MAX_ITEMS = 16;
/** Long series (line / scatter) stop here, sampled evenly across the file. */
const MAX_POINTS = 60;

export interface FullChart {
  chart: VizChart;
  labelColumn: string;
  valueColumn: string;
  /** Rows that contributed a number. */
  used: number;
  /** Categories drawn after aggregation and ranking. */
  drawn: number;
}

/** The i18n `t` function, passed in from the component that owns the hook. */
export type VizTranslate = (key: string, vars?: Record<string, string | number>) => string;

function toNumber(cell: unknown): number | null {
  const text = String(cell ?? '')
    .replace(/[,，\s]/g, '')
    .replace(/[%％]$/, '');
  if (!text || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function numericShare(rows: string[][], column: number): number {
  let seen = 0;
  let numbers = 0;
  for (const row of rows) {
    const cell = String(row[column] ?? '').trim();
    if (!cell) continue;
    seen += 1;
    if (toNumber(cell) !== null) numbers += 1;
  }
  return seen === 0 ? 0 : numbers / seen;
}

/** The label/value pairs the original chart drew, whatever its shape. */
function basePairs(chart: VizChart): VizDatum[] {
  if (chart.items?.length) return chart.items;
  const series = chart.series ?? [];
  const points = series[0]?.points ?? [];
  return points
    .filter((point): point is VizDatum => typeof (point as VizDatum).label === 'string')
    .map((point) => ({ label: point.label, value: point.value }));
}

function closeEnough(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / scale <= 0.02;
}

/**
 * Pick the columns that reproduce the original chart: the text column whose
 * values are the chart's labels, and the numeric column whose values match.
 */
function chooseColumns(
  chart: VizChart,
  columns: string[],
  rows: string[][],
  numericCols: number[],
  labelCols: number[],
): { label: number; value: number } | null {
  if (numericCols.length === 0) return null;
  const pairs = basePairs(chart).slice(0, 40);

  let best = { label: -1, value: -1, score: 0 };
  for (const labelIndex of labelCols) {
    for (const valueIndex of numericCols) {
      let score = 0;
      for (const pair of pairs) {
        const row = rows.find((item) => String(item[labelIndex] ?? '').trim() === pair.label);
        if (!row) continue;
        const value = toNumber(row[valueIndex]);
        if (value !== null && closeEnough(value, pair.value)) score += 1;
      }
      if (score > best.score) best = { label: labelIndex, value: valueIndex, score };
    }
  }
  if (best.score > 0) return { label: best.label, value: best.value };

  // Nothing matched (the model may have aggregated a column the table does not
  // show): fall back to the first text column — or the first numeric column
  // when the labels are numbers, e.g. a table of years — and the numeric column
  // with the most values.
  const label =
    labelCols[0] ?? (numericCols.length >= 2 ? numericCols[0] : columns.findIndex((_, index) => !numericCols.includes(index)));
  if (label < 0) return null;
  const value = numericCols
    .filter((index) => index !== label)
    .sort((a, b) => numericShare(rows, b) - numericShare(rows, a))[0];
  if (value === undefined) return null;
  return { label, value };
}

function pickType(base: VizChart, categories: number, lineish: boolean): VizChartType {
  if (lineish) return base.type === 'smooth-line' ? 'smooth-line' : 'line';
  // "查看全部" keeps the chart the model chose: the full data is the same
  // measure, only more of it.
  switch (base.type) {
    case 'pie':
    case 'progress':
    case 'bar':
    case 'horizontal-bar':
    case 'grouped-bar':
      return base.type;
    default:
      return categories <= 8 ? 'bar' : 'horizontal-bar';
  }
}

/** Evenly sample a long series so the shape survives without 500 points. */
function thin<T>(list: T[], limit: number): T[] {
  if (list.length <= limit) return list;
  const step = (list.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => list[Math.round(index * step)]);
}

export function buildFullChart(
  base: VizChart,
  columns: string[],
  rows: string[][],
  translate: VizTranslate,
): FullChart | null {
  if (!columns || columns.length < 2 || !rows || rows.length === 0) return null;

  const numericCols: number[] = [];
  const labelCols: number[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const share = numericShare(rows, index);
    if (share >= 0.6) numericCols.push(index);
    else if (share <= 0.4) labelCols.push(index);
  }
  if (numericCols.length === 0) return null;

  const chosen = chooseColumns(base, columns, rows, numericCols, labelCols);
  if (!chosen) return null;

  const aggregated = new Map<string, { label: string; value: number; order: number }>();
  let used = 0;
  rows.forEach((row, index) => {
    const value = toNumber(row[chosen.value]);
    if (value === null) return;
    used += 1;
    const label =
      String(row[chosen.label] ?? '').trim() ||
      translate('viz.full.rowLabel', { count: index + 1 });
    const existing = aggregated.get(label);
    if (existing) existing.value += value;
    else aggregated.set(label, { label, value, order: index });
  });
  if (used === 0) return null;

  const groups = [...aggregated.values()];
  const lineish =
    (base.type === 'line' || base.type === 'smooth-line') &&
    groups.length === used &&
    groups.length >= 6;
  const ordered = lineish ? groups.sort((a, b) => a.order - b.order) : groups.sort((a, b) => b.value - a.value);
  const shown = lineish ? thin(ordered, MAX_POINTS) : ordered.slice(0, MAX_ITEMS);

  const points: VizDatum[] = shown.map((group) => ({ label: group.label, value: group.value }));
  const type = pickType(base, points.length, lineish);
  const title = translate('viz.full.title', { title: base.title });

  const chart: VizChart =
    type === 'line' || type === 'smooth-line' || type === 'grouped-bar'
      ? {
          type,
          title,
          source: base.source,
          xLabel: base.xLabel ?? columns[chosen.label],
          yLabel: base.yLabel ?? columns[chosen.value],
          unit: base.unit,
          series: [
            {
              name: base.series?.[0]?.name ?? columns[chosen.value],
              points,
            },
          ],
        }
      : {
          type,
          title,
          source: base.source,
          xLabel: base.xLabel ?? columns[chosen.label],
          yLabel: base.yLabel ?? columns[chosen.value],
          unit: base.unit,
          items: points,
        };

  return {
    chart,
    labelColumn: columns[chosen.label],
    valueColumn: columns[chosen.value],
    used,
    drawn: points.length,
  };
}
