import type { VizChart, WorkspaceVizTable, WorkspaceVisualizeResult } from '../types';

/**
 * Link a chart back to the file it was built from.
 *
 * The model only echoes a source string ("文件：sub/sales.csv（抽样 40/1200 行）"),
 * but the renderer still holds the tables that were sent, with their refs and
 * real row counts. Matching those lets a sampled card offer "view all rows"
 * without asking the model for anything.
 */

const SAMPLE_HINT = /抽样|sample/i;

function basename(source: string): string {
  const file = source.replace(/^[^：]*：/, '').split('（')[0].trim();
  return file.split(/[\\/]/).pop() ?? '';
}

function matches(chart: VizChart, table: WorkspaceVizTable): boolean {
  const source = chart.source ?? '';
  if (!source) return false;
  const token = table.refs?.[0]?.rel ?? basename(table.source);
  const name = token.split(/[\\/]/).pop() ?? '';
  if (name && source.includes(name)) return true;
  if (table.source && source.includes(table.source)) return true;
  // Sheet / table names are unique enough to match on their own.
  const title = table.title.split(' · ').pop() ?? '';
  return Boolean(title && source.includes(title));
}

function pickTable(chart: VizChart, tables: WorkspaceVizTable[]): WorkspaceVizTable | null {
  for (const table of tables) {
    if (!table.refs || table.refs.length === 0) continue;
    if (matches(chart, table)) return table;
  }
  return null;
}

export function attachTableRefs(
  result: WorkspaceVisualizeResult,
  tables: WorkspaceVizTable[],
): WorkspaceVisualizeResult {
  if (!result?.charts?.length || !tables?.length) return result;
  const charts = result.charts.map((chart) => {
    const table = pickTable(chart, tables);
    if (!table) return chart;
    const total = table.total ?? table.rows.length;
    // Only sampled tables get the affordance: there is nothing more to show
    // when every row already made it into the prompt.
    const sampled = total > table.rows.length || SAMPLE_HINT.test(chart.source ?? '');
    if (!sampled || !table.refs?.length) return chart;
    return {
      ...chart,
      table: { refs: table.refs, shown: table.rows.length, total: Math.max(total, table.rows.length) },
    };
  });
  return { ...result, charts };
}
