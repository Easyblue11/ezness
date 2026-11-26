import { useEffect, useRef, useState } from 'react';
import type {
  AgentDefinition,
  ChatTarget,
  Message,
  UsageRecord,
  VizChart,
  WorkspaceVisualizeResult,
} from '../types';
import type { VizChatLike, VizWorkspaceLike } from '../lib/workspaceViz';
import { layoutBoard } from '../lib/vizLayout';
import {
  clearVizRun,
  startVizRun,
  stopVizRun,
  subscribeVizRun,
  vizRunSnapshot,
} from '../lib/vizRunner';
import { ChartIcon, CloseIcon, CollapseIcon, ExpandIcon, ScanIcon } from './Icons';
import { useI18n } from '../i18n';
import { VizChartCard } from './VizChart';
import { VizTableSheet } from './VizTableSheet';

type Scope = 'task' | 'workspace';

/** The last dashboard survives closing the dialog and restarting the app. */
const STORE_PREFIX = 'ezness.viz.result.';
const STORE_LIMIT = 400 * 1024;

interface StoredDashboard {
  scope: Scope;
  topic: string;
  at: number;
  result: WorkspaceVisualizeResult;
}

function storeKey(workspaceId: string, chatId: string): string {
  return `${STORE_PREFIX}${workspaceId || 'workspace'}:${chatId || 'all'}`;
}

function readStored(key: string): StoredDashboard | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDashboard;
    if (!parsed?.result || !Array.isArray(parsed.result.charts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredDashboard | null): void {
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    const text = JSON.stringify(value);
    if (text.length > STORE_LIMIT) return;
    window.localStorage.setItem(key, text);
  } catch {
    /* a full or disabled storage must never break the dialog */
  }
}

interface Props {
  workspace: VizWorkspaceLike;
  /** Needed to read tables the agent wrote into the workspace folder. */
  workspaceId: string;
  /** The task the dialog was opened from; scopes the data by default. */
  activeChatId: string;
  chats: VizChatLike[];
  messages: Message[];
  usage: UsageRecord[];
  agents: AgentDefinition[];
  target: ChatTarget | null;
  onClose: () => void;
}

const PRESET_KEYS = [
  'workspace.viz.preset.line',
  'workspace.viz.preset.curve',
  'workspace.viz.preset.scatter',
  'workspace.viz.preset.pie',
  'workspace.viz.preset.column',
  'workspace.viz.preset.bar',
  'workspace.viz.preset.groupedColumn',
];

export function WorkspaceVisualize({
  workspace,
  workspaceId,
  activeChatId,
  chats,
  messages,
  usage,
  agents,
  target,
  onClose,
}: Props) {
  const { t } = useI18n();
  const api = window.ezness;
  const key = storeKey(workspaceId, activeChatId);
  const stored = useRef<StoredDashboard | null>(null);
  if (stored.current === null) stored.current = readStored(key);

  const [topic, setTopic] = useState(stored.current?.topic ?? '');
  const [scope, setScope] = useState<Scope>(
    stored.current?.scope ?? (activeChatId ? 'task' : 'workspace'),
  );
  // A run started earlier keeps going when the dialog closes; this snapshot is
  // how reopening finds it again.
  const [snapshot, setSnapshot] = useState(() => vizRunSnapshot(key));
  const running = snapshot?.status === 'running';
  const [result, setResult] = useState<WorkspaceVisualizeResult | null>(
    snapshot?.result ?? stored.current?.result ?? null,
  );
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const [sheetChart, setSheetChart] = useState<VizChart | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The button takes the whole window fullscreen as well: the dialog is a
   * 16:9 box, so filling only the window left the board inside a small area.
   */
  function applyFullscreen(value: boolean) {
    fullscreenRef.current = value;
    setFullscreen(value);
    const call = window.ezness?.setFullscreen;
    if (typeof call === 'function') void Promise.resolve(call(value)).catch(() => undefined);
  }

  // Leaving the dialog (or the app) must not strand the window in fullscreen.
  useEffect(
    () => () => {
      if (!fullscreenRef.current) return;
      fullscreenRef.current = false;
      const call = window.ezness?.setFullscreen;
      if (typeof call === 'function') void Promise.resolve(call(false)).catch(() => undefined);
    },
    [],
  );

  const taskTitle = chats.find((chat) => chat.id === activeChatId)?.title ?? '';

  useEffect(() => subscribeVizRun(key, () => setSnapshot(vizRunSnapshot(key))), [key]);

  // The run may finish while the dialog is closed; taking the result here keeps
  // the board in sync whether it was open at the time or not.
  useEffect(() => {
    if (snapshot?.status === 'done' && snapshot.result) setResult(snapshot.result);
  }, [snapshot]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The confirmation is a one-off: it forgets itself if left alone.
  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  // Escape leaves fullscreen first; only a second press closes the dialog, and
  // the row sheet gets the key while it is open.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || sheetChart) return;
      applyFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, sheetChart]);

  function clearResult() {
    clearVizRun(key);
    setResult(null);
    setError('');
    setConfirmClear(false);
    setSheetChart(null);
    writeStored(key, null);
  }

  function run() {
    if (!api?.workspaceVisualize) {
      setError(t('workspace.viz.error.unsupported'));
      return;
    }
    if (!target) {
      setError(t('workspace.viz.error.noModel'));
      return;
    }
    const asked = topic.trim();
    setError('');
    startVizRun({
      key,
      workspaceId,
      workspace,
      activeChatId,
      chats,
      messages,
      usage,
      agents,
      scope,
      topic: asked,
      provider: target,
      // A run can outlive this dialog and fail later; its stored error text is
      // built by the runner, so it needs the translator rather than a string.
      translate: t,
      // Saved here rather than in the component: the run may finish long after
      // the dialog was closed.
      onResult: (next) => writeStored(key, { scope, topic: asked, at: Date.now(), result: next }),
    });
  }

  /** Stop the run in flight; nothing it produces will be shown. */
  function stopRun() {
    stopVizRun(key);
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!running) void run();
  };

  const placeholder =
    scope === 'task'
      ? t('workspace.viz.placeholderTask')
      : t('workspace.viz.placeholderWorkspace');

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal__panel viz-dialog ${fullscreen ? 'is-full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('workspace.viz.title')}
      >
        <header className="viz-dialog__head">
          <div className="viz-dialog__titles">
            <h2 className="modal__title">
              <ChartIcon size={16} />
              {t('workspace.viz.title')}
            </h2>
            <p className="viz-dialog__sub">{t('workspace.viz.subtitle')}</p>
          </div>
          <div className="viz-dialog__actions">
            {result && !running && (
              <div className="viz-clear">
                {confirmClear ? (
                  <>
                    <span className="viz-clear__ask">{t('workspace.viz.clear.ask')}</span>
                    <button
                      type="button"
                      className="viz-clear__btn viz-clear__btn--danger"
                      onClick={clearResult}
                    >
                      {t('workspace.viz.clear.confirm')}
                    </button>
                    <button
                      type="button"
                      className="viz-clear__btn"
                      onClick={() => setConfirmClear(false)}
                    >
                      {t('workspace.viz.clear.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="viz-clear__btn"
                    onClick={() => setConfirmClear(true)}
                  >
                    {t('workspace.viz.clear.clear')}
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="viz-dialog__icon"
              aria-label={
                fullscreen
                  ? t('workspace.viz.exitFullscreen')
                  : t('workspace.viz.fullscreen')
              }
              aria-pressed={fullscreen}
              title={
                fullscreen
                  ? t('workspace.viz.exitFullscreen')
                  : t('workspace.viz.fullscreen')
              }
              onClick={() => applyFullscreen(!fullscreen)}
            >
              {fullscreen ? <CollapseIcon size={15} /> : <ExpandIcon size={15} />}
            </button>
            <button
              type="button"
              className="viz-dialog__close"
              aria-label={t('workspace.viz.close')}
              onClick={onClose}
            >
              <CloseIcon size={15} />
            </button>
          </div>
        </header>

        <form className="viz-ask" onSubmit={submit}>
          <ChartIcon size={15} />
          <input
            ref={inputRef}
            value={topic}
            placeholder={placeholder}
            aria-label={t('workspace.viz.inputAria')}
            spellCheck={false}
            disabled={running}
            onChange={(event) => setTopic(event.target.value)}
          />
          {/* 停止 is its own button: the submit control must never turn into a
              cancel, or a double click throws the generation away. */}
          {running && (
            <button type="button" className="viz-ask__stop" onClick={stopRun}>
              {t('workspace.viz.stop')}
            </button>
          )}
          <button
            type="submit"
            className="btn btn--primary viz-ask__go"
            disabled={running || !target}
            title={target ? '' : t('workspace.viz.noModelTitle')}
          >
            {running
              ? t('workspace.viz.generating')
              : result
                ? t('workspace.viz.regenerate')
                : t('workspace.viz.generate')}
          </button>
        </form>

        {activeChatId && (
          <div
            className="viz-scope"
            role="group"
            aria-label={t('workspace.viz.scopeAria')}
          >
            <button
              type="button"
              className={`viz-scope__item ${scope === 'task' ? 'is-active' : ''}`}
              aria-pressed={scope === 'task'}
              disabled={running}
              onClick={() => setScope('task')}
            >
              {taskTitle
                ? t('workspace.viz.scope.taskWithTitle', { title: taskTitle })
                : t('workspace.viz.scope.task')}
            </button>
            <button
              type="button"
              className={`viz-scope__item ${scope === 'workspace' ? 'is-active' : ''}`}
              aria-pressed={scope === 'workspace'}
              disabled={running}
              onClick={() => setScope('workspace')}
            >
              {t('workspace.viz.scope.workspace')}
            </button>
          </div>
        )}

        <div className="viz-dialog__body">
          {running && result && (
            <div className="viz-running">
              <ScanIcon size={13} />
              {t('workspace.viz.state.regenerating')}
            </div>
          )}

          {(error || (snapshot?.status === 'error' && snapshot.error)) && (
            <div className="viz-error">{error || snapshot?.error}</div>
          )}

          {snapshot?.status === 'stopped' && (
            <div className="viz-running">
              <ScanIcon size={13} />
              {t('workspace.viz.state.stopped')}
            </div>
          )}

          {!result && !running && (
            <div className="viz-intro">
              <div className="viz-intro__icon">
                <ChartIcon size={24} />
              </div>
              <h3>{t('workspace.viz.intro.title')}</h3>
              <p>{t('workspace.viz.intro.desc')}</p>
              <div className="viz-presets">
                {PRESET_KEYS.map((item) => (
                  <span key={item}>{t(item)}</span>
                ))}
              </div>
              {!target && (
                <p className="viz-intro__warn">{t('workspace.viz.intro.warn')}</p>
              )}
            </div>
          )}

          {running && !result && (
            <div className="viz-state">
              <ScanIcon size={22} />
              <p>
                {t('workspace.viz.state.title', {
                  scope:
                    scope === 'task'
                      ? t('workspace.viz.state.scopeTask')
                      : t('workspace.viz.state.scopeWorkspace'),
                })}
              </p>
              <span>{t('workspace.viz.state.hint')}</span>
            </div>
          )}

          {result && (
            <div className={`viz-result ${running ? 'is-stale' : ''}`}>
              <section className="viz-summary">
                <h3>{result.title || t('workspace.viz.result.title')}</h3>
                {result.summary && <p>{result.summary}</p>}
                {result.highlights && result.highlights.length > 0 && (
                  <ul>
                    {result.highlights.map((item, index) => (
                      <li key={`${item}-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
              </section>

              {result.stats && result.stats.length > 0 && (
                <div className="viz-kpis">
                  {result.stats.map((stat, index) => (
                    <div className="viz-kpi" key={`${stat.label}-${index}`}>
                      <strong className="viz-kpi__value">{stat.value}</strong>
                      <span className="viz-kpi__label">{stat.label}</span>
                      {stat.note && <span className="viz-kpi__note">{stat.note}</span>}
                    </div>
                  ))}
                </div>
              )}

              {result.charts && result.charts.length > 0 ? (
                <div className="viz-board">
                  {layoutBoard(result.charts).map(({ chart, span }, index) => (
                    <VizChartCard
                      key={`${chart.title}-${index}`}
                      chart={chart}
                      span={span}
                      onOpenTable={setSheetChart}
                    />
                  ))}
                </div>
              ) : (
                <div className="viz-empty-note">{t('workspace.viz.result.empty')}</div>
              )}

              <p className="viz-foot">{t('workspace.viz.result.foot')}</p>
            </div>
          )}
        </div>

        {sheetChart && (
          <VizTableSheet
            workspaceId={workspaceId}
            chart={sheetChart}
            onClose={() => setSheetChart(null)}
          />
        )}
      </div>
    </div>
  );
}
