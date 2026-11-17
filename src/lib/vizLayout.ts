import type { VizChart } from '../types';

/**
 * Board layout for the visualization dialog.
 *
 * The board is a grid of equal, repeating tracks (see `.viz-board`), so a wide
 * board — a fullscreen dialog on a large display — fits more cards per row
 * instead of stretching the same few charts across the screen. Each card asks
 * for one track, two tracks, or the whole row, judged by how much data it
 * holds: a two-bar chart only needs a track, a twelve-point line needs two,
 * and a table or a very long series needs the row.
 *
 * Spans keep their historical numbers (3/4/6/8/12) because the CSS class names
 * are part of the card markup; the mapping is in `global.css`.
 */

export type VizSpan = 3 | 4 | 6 | 8 | 12;

export interface VizBoardItem {
  chart: VizChart;
  span: VizSpan;
}

function pointCount(chart: VizChart): number {
  if (chart.items?.length) return chart.items.length;
  const series = chart.series ?? [];
  if (series.length === 0) return 0;
  return Math.max(...series.map((item) => item.points?.length ?? 0));
}

/**
 * How wide this chart wants to be, judged by its data volume.
 *
 * 3 → one track, 6 → two tracks, 12 → the whole row.
 */
export function preferredSpan(chart: VizChart): VizSpan {
  // A narrow detail table reads better as a card than as a full-width band of
  // stretched columns; only a wide one needs the row.
  if (chart.type === 'table') return (chart.columns?.length ?? 0) <= 4 ? 6 : 12;
  const count = pointCount(chart);
  const series = Math.max(1, chart.series?.length ?? 0);
  const wideHint = chart.size === 'lg';

  if (chart.type === 'line' || chart.type === 'smooth-line') {
    const total = count * series;
    if (total >= 36 || count > 20) return 12;
    if (total >= 12 || wideHint) return 6;
    return 3;
  }

  if (chart.type === 'scatter') return count > 16 || series >= 3 ? 12 : 6;

  if (chart.type === 'pie' || chart.type === 'progress') return 3;

  if (chart.type === 'grouped-bar') return 6;

  // bar / horizontal-bar. Up to nine bars fit a single track; a long list gets
  // two tracks so the labels keep their room.
  return count <= 9 ? 3 : 6;
}

export function layoutBoard(charts: VizChart[]): VizBoardItem[] {
  if (!Array.isArray(charts) || charts.length === 0) return [];
  // One chart alone is not stretched over the screen: two tracks is a
  // comfortable width for a single plot (a very wide table still keeps its row).
  if (charts.length === 1) {
    const span = preferredSpan(charts[0]);
    return [{ chart: charts[0], span: span < 6 ? 6 : span }];
  }
  return charts.map((chart) => ({ chart, span: preferredSpan(chart) }));
}
