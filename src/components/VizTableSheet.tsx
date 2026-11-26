import { useEffect, useMemo, useState } from 'react';
import type { VizChart } from '../types';
import { useI18n } from '../i18n';
import { buildFullChart } from '../lib/vizFullChart';
import { ChartBody, Legend } from './VizChart';
import { useElementWidth } from '../lib/useElementWidth';
import { CloseIcon, SearchIcon } from './Icons';

interface Props {
  workspaceId: string;
  chart: VizChart;
  onClose: () => void;
}

interface SheetState {
  loading: boolean;
  error: string;
  columns: string[];
  rows: string[][];
  total: number;
  truncated: boolean;
}

const EMPTY: SheetState = {
  loading: true,
  error: '',
  columns: [],
  rows: [],
  total: 0,
  truncated: false,
};

/** Render at most this many rows at once; the search narrows the rest. */
const RENDER_LIMIT = 400;
/** Drawn at the sheet's real width so the chart never scales up with it. */
const SHEET_BASIS = 1080;

/**
 * Every row behind a sampled chart, read from its file.
 *
 * The dashboard only sends a sample to the model, so the card's numbers come
 * from a slice. This sheet re-reads the whole table and charts it again — the
 * table view is one click away, not the only thing on offer.
 */
export function VizTableSheet({ workspaceId, chart, onClose }: Props) {
  const { t, locale } = useI18n();
  const refs = chart.table?.refs ?? [];
  const [state, setState] = useState<SheetState>(EMPTY);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  /** The sheet can be nearly any width; the chart is drawn at exactly that. */
  const [measureFigure, figureWidth] = useElementWidth<HTMLDivElement>();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const api = window.ezness;
      if (!api?.workspaceVizTableRows || refs.length === 0) {
        setState({ ...EMPTY, loading: false, error: t('viz.sheet.noSource') });
        return;
      }
      try {
        const result = await api.workspaceVizTableRows({ workspaceId, refs });
        if (!alive) return;
        if (!result?.ok) {
          setState({ ...EMPTY, loading: false, error: result?.error || t('viz.sheet.readFailed') });
          return;
        }
        setState({
          loading: false,
          error: '',
          columns: result.columns ?? [],
          rows: result.rows ?? [],
          total: result.total ?? result.rows?.length ?? 0,
          truncated: Boolean(result.truncated),
        });
      } catch (reason) {
        if (!alive) return;
        setState({
          ...EMPTY,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [workspaceId, chart, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.rows;
    return state.rows.filter((row) =>
      row.some((cell) => String(cell ?? '').toLowerCase().includes(needle)),
    );
  }, [state.rows, query]);

  const full = useMemo(
    () => buildFullChart(chart, state.columns, rows, t),
    [chart, state.columns, rows, t],
  );

  // Without a usable numeric column there is nothing to draw; fall back to the
  // table so the sheet never opens empty.
  const mode = full ? view : 'table';
  const shown = rows.slice(0, RENDER_LIMIT);

  return (
    <div
      className="viz-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('viz.sheet.dialogAria', { title: chart.title })}
    >
      <header className="viz-sheet__head">
        <div className="viz-sheet__titles">
          <h3>{t('viz.sheet.title', { title: chart.title })}</h3>
          <p>
            {state.loading
              ? t('viz.sheet.loading')
              : t('viz.sheet.rowSummary', {
                  total: state.total.toLocaleString(locale),
                  shown: rows.length.toLocaleString(locale),
                })}
            {chart.source ? ` · ${chart.source}` : ''}
          </p>
        </div>
        {full && (
          <div className="viz-sheet__views" role="group" aria-label={t('viz.sheet.viewMode')}>
            <button
              type="button"
              className={`viz-sheet__view ${mode === 'chart' ? 'is-active' : ''}`}
              aria-pressed={mode === 'chart'}
              onClick={() => setView('chart')}
            >
              {t('viz.viewChart')}
            </button>
            <button
              type="button"
              className={`viz-sheet__view ${mode === 'table' ? 'is-active' : ''}`}
              aria-pressed={mode === 'table'}
              onClick={() => setView('table')}
            >
              {t('viz.viewTable')}
            </button>
          </div>
        )}
        <div className="viz-sheet__search">
          <SearchIcon size={13} />
          <input
            value={query}
            placeholder={t('viz.sheet.searchPlaceholder')}
            aria-label={t('viz.sheet.searchAria')}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="viz-sheet__close"
          aria-label={t('viz.sheet.closeAria')}
          onClick={onClose}
        >
          <CloseIcon size={15} />
        </button>
      </header>

      <div className="viz-sheet__body">
        {state.loading && <div className="viz-sheet__note">{t('viz.sheet.loading')}</div>}
        {state.error && <div className="viz-sheet__note viz-sheet__note--error">{state.error}</div>}

        {!state.loading && !state.error && mode === 'chart' && full && (
          <figure className="viz-sheet__figure" data-viz-type={full.chart.type}>
            <div className="viz-chart-fit" ref={measureFigure}>
              <ChartBody chart={full.chart} basis={figureWidth > 0 ? figureWidth : SHEET_BASIS} />
            </div>
            <Legend chart={full.chart} />
            <figcaption className="viz-sheet__note">
              {t('viz.sheet.caption', {
                label: full.labelColumn,
                value: full.valueColumn,
                used: full.used.toLocaleString(locale),
                scope:
                  full.drawn === full.used
                    ? t('viz.sheet.all')
                    : t('viz.sheet.topN', { count: full.drawn }),
              })}
            </figcaption>
          </figure>
        )}

        {!state.loading && !state.error && mode === 'table' && (
          <table className="viz-table viz-sheet__table">
            <thead>
              <tr>
                {state.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <tr key={index}>
                  {state.columns.map((_, cell) => (
                    <td key={cell}>{row[cell] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {state.truncated && (
          <p className="viz-sheet__note">
            {t('viz.sheet.truncated', { shown: state.rows.length.toLocaleString(locale) })}
          </p>
        )}
        {mode === 'table' && rows.length > RENDER_LIMIT && (
          <p className="viz-sheet__note">
            {t('viz.sheet.renderLimit', { limit: RENDER_LIMIT.toLocaleString(locale) })}
          </p>
        )}
        {mode === 'table' && !full && !state.loading && !state.error && (
          <p className="viz-sheet__note">{t('viz.sheet.noNumeric')}</p>
        )}
      </div>
    </div>
  );
}
