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

const PRESETS = [
  '折线图',
  '曲线图',
  '散点图',
  '饼图',
  '柱状图',
  '条形图',
  '分组柱状图',
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
      setError('这个版本还不能生成可视化，请先更新应用。');
      return;
    }
    if (!target) {
      setError('还没有连接模型。先去「设置 → 模型接入」填好地址并获取模型。');
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
    scope === 'task' ? '不填则梳理当前任务里的数据' : '不填则汇总整个工作空间';

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
        aria-label="可视化工具"
      >
        <header className="viz-dialog__head">
          <div className="viz-dialog__titles">
            <h2 className="modal__title">
              <ChartIcon size={16} />
              可视化工具
            </h2>
            <p className="viz-dialog__sub">
              把当前任务里的对话和表格数据做成一块看板。表格（对话里的 Markdown 表格，以及工作空间里的
              Excel、SQLite、CSV、JSON、Markdown 文件）会先按行列读出真实数据，再按指标汇总成图表。
            </p>
          </div>
          <div className="viz-dialog__actions">
            {result && !running && (
              <div className="viz-clear">
                {confirmClear ? (
                  <>
                    <span className="viz-clear__ask">清空这块看板？</span>
                    <button
                      type="button"
                      className="viz-clear__btn viz-clear__btn--danger"
                      onClick={clearResult}
                    >
                      确认清空
                    </button>
                    <button
                      type="button"
                      className="viz-clear__btn"
                      onClick={() => setConfirmClear(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="viz-clear__btn"
                    onClick={() => setConfirmClear(true)}
                  >
                    清空
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="viz-dialog__icon"
              aria-label={fullscreen ? '退出全屏' : '全屏'}
              aria-pressed={fullscreen}
              title={fullscreen ? '退出全屏' : '全屏'}
              onClick={() => applyFullscreen(!fullscreen)}
            >
              {fullscreen ? <CollapseIcon size={15} /> : <ExpandIcon size={15} />}
            </button>
            <button type="button" className="viz-dialog__close" aria-label="关闭" onClick={onClose}>
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
            aria-label="想总结的方向"
            spellCheck={false}
            disabled={running}
            onChange={(event) => setTopic(event.target.value)}
          />
          {/* 停止 is its own button: the submit control must never turn into a
              cancel, or a double click throws the generation away. */}
          {running && (
            <button type="button" className="viz-ask__stop" onClick={stopRun}>
              停止
            </button>
          )}
          <button
            type="submit"
            className="btn btn--primary viz-ask__go"
            disabled={running || !target}
            title={target ? '' : '还没有连接模型'}
          >
            {running ? '生成中…' : result ? '重新生成' : '生成'}
          </button>
        </form>

        {activeChatId && (
          <div className="viz-scope" role="group" aria-label="数据范围">
            <button
              type="button"
              className={`viz-scope__item ${scope === 'task' ? 'is-active' : ''}`}
              aria-pressed={scope === 'task'}
              disabled={running}
              onClick={() => setScope('task')}
            >
              当前任务{taskTitle ? `：${taskTitle}` : ''}
            </button>
            <button
              type="button"
              className={`viz-scope__item ${scope === 'workspace' ? 'is-active' : ''}`}
              aria-pressed={scope === 'workspace'}
              disabled={running}
              onClick={() => setScope('workspace')}
            >
              整个工作空间
            </button>
          </div>
        )}

        <div className="viz-dialog__body">
          {running && result && (
            <div className="viz-running">
              <ScanIcon size={13} />
              正在按新的关注点重新生成…
            </div>
          )}

          {(error || (snapshot?.status === 'error' && snapshot.error)) && (
            <div className="viz-error">{error || snapshot?.error}</div>
          )}

          {snapshot?.status === 'stopped' && (
            <div className="viz-running">
              <ScanIcon size={13} />
              已停止这次生成。
            </div>
          )}

          {!result && !running && (
            <div className="viz-intro">
              <div className="viz-intro__icon">
                <ChartIcon size={24} />
              </div>
              <h3>把对话里的数据变成看板</h3>
              <p>
                默认只看当前任务：对话里的统计数字、Markdown 表格，以及工作空间里 Agent
                写出的 Excel、SQLite、CSV 等文件的真实数据都会被读出来（按国家、年龄、性别、
                年份这类指标汇总），排成一块看板。图只在本机展示，不会写回任务或消息。
              </p>
              <div className="viz-presets">
                {PRESETS.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              {!target && <p className="viz-intro__warn">还没有连接模型，先去设置里接入一个再回来。</p>}
            </div>
          )}

          {running && !result && (
            <div className="viz-state">
              <ScanIcon size={22} />
              <p>正在梳理{scope === 'task' ? '当前任务' : '这个工作空间'}里的数据…</p>
              <span>会先读出对话和本地表格，再规划图表，通常需要十几秒。</span>
            </div>
          )}

          {result && (
            <div className={`viz-result ${running ? 'is-stale' : ''}`}>
              <section className="viz-summary">
                <h3>{result.title || '数据看板'}</h3>
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
                <div className="viz-empty-note">
                  这次没有生成图表。可以在关注点里写清楚要看的指标，例如「各国死亡人数对比」。
                </div>
              )}

              <p className="viz-foot">
                图表由模型根据读到的数据生成。每张图右上角可以切到表格核对具体数值。
              </p>
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
