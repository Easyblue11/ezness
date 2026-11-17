import { type DragEvent, useEffect, useMemo, useState } from 'react';
import type {
  DirectorActiveUsage,
  DirectorAudit,
  DirectorAuditItem,
  DirectorHistoryDetail,
  DirectorHistoryEntry,
  DirectorLedgerEntry,
  DirectorMode,
  DirectorPatch,
  DirectorSpaceAccess,
  DirectorState,
  VizChart,
} from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { BillingIcon, DirectorIcon, SettingsIcon } from './Icons';
import { MarkdownView } from './MarkdownView';
import { formatTokens } from './ContextRing';
import { VizChartCard } from './VizChart';

/**
 * 工作总监 · 顶部栏 + 分管范围.
 *
 * 汇报不在这里：总监主动说的话直接进它自己的对话消息流。这个面板只留
 * 授权（开关、三档）、分管范围和一个「对话历史」弹窗。
 *
 * 弹窗的层级是：对话存档（文件夹）→ 对话内容 / 总监事务。清空对话时按
 * 不相关的话题切段，每段一个存档，并把那段期间总监做的事一起装进去。
 */

interface SpaceRef {
  id: string;
  name: string;
  path?: string;
  kind?: string;
}

interface Props {
  state: DirectorState | null;
  workspaces: SpaceRef[];
  ledger: DirectorLedgerEntry[];
  onChange: (state: DirectorState) => void;
  onRefreshLedger: () => void;
  /** 清空对话并留档；返回是否成功。待确认的消息由调用方保留。 */
  onClearHistory: () => Promise<boolean>;
  /** 总监正在回复时不允许清空。 */
  canClear: boolean;
  /** 当前正在执行的任务及其花费；没有任务时为空。 */
  usageRows?: DirectorActiveUsage[];
  /** 所有在跑任务的合计输出速度。 */
  speed?: number | null;
}

const MODES: { key: DirectorMode; label: string; hint: string }[] = [
  { key: 'observe', label: '观察', hint: '有岔路口时主动提醒，不替你拍板' },
  { key: 'suggest', label: '建议', hint: '每个选项给出意见，决定权在你' },
  { key: 'run', label: '代跑', hint: '自己拍板推进；高危操作仍会问你' },
];

type ListFilter = 'archives' | 'ledger';
type ArchiveTab = 'chat' | 'ledger';

const LIST_FILTERS: { key: ListFilter; label: string }[] = [
  { key: 'archives', label: '对话存档' },
  { key: 'ledger', label: '总监事务' },
];

const LIST_NOTE: Record<ListFilter, string> = {
  archives:
    '每一条是一个对话存档：装着这段对话和它期间总监的事务。存档同时是总监的记忆索引——删掉存档，总监也会忘掉这段。',
  ledger: '所有存档里的总监事务汇总在这里；进某个存档也能单独看。',
};

type RecordView =
  | { kind: 'list' }
  | { kind: 'folder'; entry: DirectorHistoryDetail; tab: ArchiveTab }
  | {
      kind: 'ledger';
      entry: DirectorLedgerEntry;
      back: 'list' | 'folder';
      folder?: DirectorHistoryDetail;
      folderTab?: ArchiveTab;
    };

function stamp(at: number): string {
  if (!at) return '';
  const date = new Date(at);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (value: number) => String(value).padStart(2, '0');
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fullStamp(at: number): string {
  if (!at) return '';
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

function costText(cost: number, unpriced: number): string {
  if (cost > 0) return `¥${cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)}`;
  return unpriced > 0 ? '未定价' : '¥0';
}

/** 审计里的时长：秒 / 分 / 小时，最多两级。 */
function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/**
 * 审计的两张图：重复投入的时间、重复投入的 token。
 * 数字只来自本地运行记录，模型没有参与算账；单序列条形图用同一色相。
 */
function auditCharts(audit: DirectorAudit | null): VizChart[] {
  const items: DirectorAuditItem[] = audit?.items ?? [];
  if (items.length === 0) return [];
  const charts: VizChart[] = [];
  const timeItems = items
    .map((item) => ({ item, value: Math.round((item.reclaimMs / 60000) * 10) / 10 }))
    .filter(({ value }) => value > 0)
    .slice(0, 6);
  if (timeItems.length > 0) {
    charts.push({
      type: 'horizontal-bar',
      title: '重复投入的时间',
      subtitle: '同类活重走的部分，第一次不算浪费',
      unit: '分钟',
      xLabel: '可回收时间',
      source: '工作总监的本地运行记录',
      items: timeItems.map(({ item, value }) => ({ label: item.title.slice(0, 12), value })),
    });
  }
  const tokenItems = items
    .map((item) => ({ item, value: Math.round(item.reclaimTokens) }))
    .filter(({ value }) => value > 0)
    .slice(0, 6);
  if (tokenItems.length > 0) {
    charts.push({
      type: 'horizontal-bar',
      title: '重复投入的 token',
      subtitle: '同类活重走的部分，第一次不算浪费',
      unit: 'tok',
      xLabel: '可回收 token',
      source: '工作总监的用量账本',
      items: tokenItems.map(({ item, value }) => ({ label: item.title.slice(0, 12), value })),
    });
  }
  return charts;
}

export function DirectorPage({
  state,
  workspaces,
  ledger,
  onChange,
  onRefreshLedger,
  onClearHistory,
  canClear,
  usageRows = [],
  speed = null,
}: Props) {
  const [notice, setNotice] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [maxDraft, setMaxDraft] = useState('4');
  const [reworkDraft, setReworkDraft] = useState('2');
  // 总监怎么跑：写成用户能看懂的说明，不用翻代码。
  const [designOpen, setDesignOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [view, setView] = useState<RecordView>({ kind: 'list' });
  const [listFilter, setListFilter] = useState<ListFilter>('archives');
  const [opening, setOpening] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmDedupe, setConfirmDedupe] = useState(false);
  const [deduping, setDeduping] = useState(false);
  // 对话存档多选删除：选中只存在界面里，确认后才真的删文件。
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [confirmDeletePicked, setConfirmDeletePicked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 弹窗里的操作结果就地显示；外面的 toast 被弹窗盖住，用户看不到。
  const [recordsNote, setRecordsNote] = useState('');
  const [history, setHistory] = useState<DirectorHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  // 内容审计：打开弹窗先画本地统计，模型只在用户主动要建议时才出场。
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<DirectorAudit | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditNote, setAuditNote] = useState('');
  const [auditNoteKind, setAuditNoteKind] = useState<'' | 'ok' | 'fail'>('');
  const [auditReviewing, setAuditReviewing] = useState(false);

  // 配置弹窗打开时跟随主进程的当前值，别拿旧数字覆盖。
  useEffect(() => {
    if (!configOpen) return;
    setMaxDraft(String(state?.maxDispatch ?? 4));
    setReworkDraft(String(state?.reworkRounds ?? 2));
  }, [configOpen, state?.maxDispatch, state?.reworkRounds]);

  // 后台把旧存档的名字整理好后推过来，弹窗开着就直接换掉，不用重新打开。
  useEffect(() => {
    const off = window.ezness?.onDirectorHistory?.((payload) => {
      const updates = Array.isArray(payload?.updates) ? payload.updates : [];
      if (updates.length === 0) return;
      const byId = new Map(updates.map((update) => [update.id, update]));
      setHistory((previous) =>
        previous
          ? previous.map((item) => {
              const update = byId.get(item.id);
              return update
                ? { ...item, title: update.title, titleSource: update.titleSource }
                : item;
            })
          : previous,
      );
      setView((current) => {
        if (current.kind !== 'folder') return current;
        const update = byId.get(current.entry.id);
        if (!update) return current;
        return {
          ...current,
          entry: { ...current.entry, title: update.title, titleSource: update.titleSource },
        };
      });
    });
    return () => off?.();
  }, []);

  // 功能分类 / Agent 编辑空间是工具和提示词的工作台，不是任务场所。
  const spaces = useMemo(
    () =>
      workspaces.filter(
        (space) =>
          space.kind !== 'tool-editor' &&
          space.kind !== 'agent-editor' &&
          space.kind !== 'director',
      ),
    [workspaces],
  );

  const assigned = useMemo(
    () => spaces.filter((space) => (state?.spaces[space.id] ?? 'off') !== 'off'),
    [spaces, state],
  );

  const auditChartList = useMemo(() => auditCharts(audit), [audit]);

  const archives = useMemo(
    () => [...(history ?? [])].sort((a, b) => b.at - a.at),
    [history],
  );

  const ledgerRows = useMemo(
    () => [...ledger].sort((a, b) => b.at - a.at),
    [ledger],
  );

  function transactionCount(entry: DirectorHistoryEntry): number {
    const stored = typeof entry.transactionCount === 'number' ? entry.transactionCount : 0;
    if (!entry.from || !entry.to) return stored;
    // 旧存档的 transactionCount 可能是硬写成 0 的；账本里有这段时间的事务就按账本数。
    const live = ledger.filter(
      (item) => item.at >= entry.from! && item.at <= entry.to!,
    ).length;
    return Math.max(stored, live);
  }

  function folderTransactions(entry: DirectorHistoryDetail): DirectorLedgerEntry[] {
    if (Array.isArray(entry.transactions)) {
      return [...entry.transactions].sort((a, b) => b.at - a.at);
    }
    // 旧存档没有事务快照：用消息时间范围从当前账本里补。
    const messages = entry.messages ?? [];
    const from =
      Number(entry.from) || Number(messages[0]?.createdAt) || entry.at;
    const to =
      Number(entry.to) ||
      Number(messages[messages.length - 1]?.createdAt) ||
      entry.at;
    return ledger
      .filter((item) => item.at >= from && item.at <= to)
      .sort((a, b) => b.at - a.at);
  }

  async function save(patch: DirectorPatch) {
    const result = await window.ezness?.directorSave?.(patch);
    if (!result?.ok) {
      setNotice(result?.error ?? '保存失败');
      return false;
    }
    setNotice('');
    if (result.state) onChange(result.state);
    return true;
  }

  async function saveConfig() {
    const value = Math.max(1, Math.min(12, Math.round(Number(maxDraft) || 4)));
    const rounds = Math.max(0, Math.min(5, Math.round(Number(reworkDraft) || 0)));
    setSavingConfig(true);
    const ok = await save({ maxDispatch: value, reworkRounds: rounds });
    setSavingConfig(false);
    if (ok) setConfigOpen(false);
  }

  async function moveSpaces(ids: string[], into: boolean) {
    if (ids.length === 0) return;
    const patch: Record<string, DirectorSpaceAccess> = {};
    for (const id of ids) patch[id] = into ? 'write' : 'off';
    await save({ spaces: patch });
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const result = await window.ezness?.directorHistory?.();
      if (result?.ok) {
        setHistory(result.items);
        setHistoryError('');
      } else {
        setHistory([]);
        setHistoryError(result?.error ?? '读取历史记录失败');
      }
    } catch (error) {
      setHistory([]);
      setHistoryError(`读取历史记录失败：${error instanceof Error ? error.message : String(error)}`);
    }
    setHistoryLoading(false);
  }

  function flashRecords(message: string) {
    setRecordsNote(message);
    window.setTimeout(() => setRecordsNote(''), 3600);
  }

  /** 清掉内容完全相同的重复存档（清空卡住时被连点留下的副本）。 */
  async function dedupeHistory() {
    if (deduping) return;
    if (!window.ezness?.directorHistoryDedupe) {
      flashRecords('这个功能要重启应用后才生效');
      setConfirmDedupe(false);
      return;
    }
    setDeduping(true);
    try {
      const result = await window.ezness.directorHistoryDedupe();
      if (!result?.ok) {
        flashRecords(result?.error ?? '清理失败');
        return;
      }
      flashRecords(
        result.removed
          ? `已清理 ${result.removed} 个重复存档`
          : '没有发现重复存档',
      );
      cancelSelect();
      await loadHistory();
    } catch (error) {
      flashRecords(`清理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeduping(false);
      setConfirmDedupe(false);
    }
  }

  async function openArchive(entry: DirectorHistoryEntry) {
    setOpening(true);
    try {
      const result = await window.ezness?.directorHistoryGet?.(entry.id);
      if (!result?.ok || !result.entry) {
        setHistoryError(result?.error ?? '这条存档已经读不到了');
        return;
      }
      setHistoryError('');
      setView({ kind: 'folder', entry: result.entry, tab: 'chat' });
    } catch (error) {
      setHistoryError(`这条存档已经读不到了：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpening(false);
    }
  }

  function openLedger(entry: DirectorLedgerEntry, from: RecordView) {
    if (from.kind === 'folder') {
      setView({
        kind: 'ledger',
        entry,
        back: 'folder',
        folder: from.entry,
        folderTab: from.tab,
      });
    } else {
      setView({ kind: 'ledger', entry, back: 'list' });
    }
  }

  function goBack() {
    if (view.kind === 'folder') {
      setView({ kind: 'list' });
      return;
    }
    if (view.kind === 'ledger') {
      if (view.back === 'folder' && view.folder) {
        setView({ kind: 'folder', entry: view.folder, tab: view.folderTab ?? 'ledger' });
      } else {
        setView({ kind: 'list' });
      }
    }
  }

  function openRecords() {
    setRecordsOpen(true);
    setView({ kind: 'list' });
    setListFilter('archives');
    setRecordsNote('');
    cancelSelect();
    onRefreshLedger();
    void loadHistory();
  }

  function closeRecords() {
    setRecordsOpen(false);
    setView({ kind: 'list' });
    setRecordsNote('');
    cancelSelect();
  }

  function cancelSelect() {
    setSelecting(false);
    setPicked(new Set());
  }

  function togglePick(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function pickAll() {
    setPicked((current) =>
      archives.length > 0 && current.size === archives.length
        ? new Set()
        : new Set(archives.map((entry) => entry.id)),
    );
  }

  function switchFilter(next: ListFilter) {
    if (next !== 'archives') cancelSelect();
    setListFilter(next);
  }

  /** 删掉用户选中的几条存档；确认框先拦一道，删了就找不回来。 */
  async function deletePicked() {
    if (deleting || picked.size === 0) return;
    if (!window.ezness?.directorHistoryDelete) {
      flashRecords('这个功能要重启应用后才生效');
      setConfirmDeletePicked(false);
      return;
    }
    setDeleting(true);
    const ids = [...picked];
    try {
      const result = await window.ezness.directorHistoryDelete(ids);
      if (!result?.ok) {
        flashRecords(result?.error ?? '删除失败');
        return;
      }
      const tx = Number(result.transactions) || 0;
      flashRecords(
        result.removed
          ? `已删除 ${result.removed} 个对话存档${tx > 0 ? `，连带 ${tx} 条总监事务` : ''}`
          : '没有可删除的存档',
      );
      cancelSelect();
      await loadHistory();
      // 存档里的事务一起没了，事务列表也要跟着刷新。
      if (tx > 0) onRefreshLedger();
    } catch (error) {
      flashRecords(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeleting(false);
      setConfirmDeletePicked(false);
    }
  }

  async function loadAudit(announce = false) {
    const api = window.ezness?.directorAudit;
    if (!api) {
      setAuditError('当前版本还没有审计能力，重启后再试。');
      return;
    }
    setAuditLoading(true);
    setAuditError('');
    try {
      const result = await api({ announce });
      if (result?.ok) setAudit(result);
      else setAuditError(result?.error || '审计读不出来，稍后再试。');
    } catch (cause) {
      setAuditError(String((cause as Error)?.message ?? cause));
    } finally {
      setAuditLoading(false);
    }
  }

  function openAudit() {
    // 正在读就别再发一次：连点会让审计组连发好几条一样的结论。
    if (auditLoading) return;
    setAuditOpen(true);
    setAudit(null);
    setAuditNote('');
    setAuditNoteKind('');
    // 点开就是开始审计：审计组会直接在总监对话里回一条结论。
    void loadAudit(true);
  }

  function closeAudit() {
    setAuditOpen(false);
    setAuditNote('');
    setAuditNoteKind('');
  }

  /** 用户主动要一次建议；模型的话会写回这一类活，弹窗刷新就能看到。 */
  async function auditReview() {
    if (auditReviewing) return;
    const api = window.ezness?.directorReviewNow;
    if (!api) {
      setAuditNote('当前版本还没有这个能力，重启后再试。');
      return;
    }
    setAuditReviewing(true);
    setAuditNote('');
    setAuditNoteKind('');
    try {
      const result = await api();
      if (result?.ok) {
        setAuditNoteKind('ok');
        setAuditNote(
          `审计组已经把建议发到对话里：「${result.title || '未命名'}」。下面的清单里也能看到这条建议。`,
        );
        await loadAudit();
      } else {
        setAuditNoteKind('fail');
        setAuditNote(result?.error || '审计组这次没有给出可用的建议。');
      }
    } catch (cause) {
      setAuditNoteKind('fail');
      setAuditNote(String((cause as Error)?.message ?? cause));
    } finally {
      setAuditReviewing(false);
    }
  }

  async function clearHistory() {
    if (clearing) return;
    setClearing(true);
    try {
      const ok = await onClearHistory();
      setConfirmClear(false);
      if (ok && recordsOpen) void loadHistory();
    } finally {
      setClearing(false);
    }
  }

  if (!state) {
    return (
      <section className="director">
        <p className="director__empty">正在读取工作总监设置…</p>
      </section>
    );
  }

  const activeMode = MODES.find((item) => item.key === state.mode) ?? MODES[1];
  const detailTitle =
    view.kind === 'folder'
      ? view.entry.title
      : view.kind === 'ledger'
        ? view.entry.title || view.entry.taskId || '总监事务'
        : '对话历史';
  const detailSubtitle =
    view.kind === 'folder'
      ? `${view.entry.count} 条对话 · ${folderTransactions(view.entry).length} 条事务 · ${fullStamp(
          view.entry.from || view.entry.at,
        )}`
      : view.kind === 'ledger'
        ? `${fullStamp(view.entry.at)} · ${view.entry.side === 'director' ? '总监' : '任务'} · ${
            view.entry.label || view.entry.kind
          }`
        : '对话和它期间的总监事务装在一起。';

  return (
    <section className="director">
      <div className="director__head">
        <div className="director__title">
          <DirectorIcon size={18} />
          <h2>工作总监</h2>
          <button
            className={`switch ${state.enabled ? 'is-on' : ''}`}
            role="switch"
            aria-checked={state.enabled}
            aria-label="启用工作总监"
            title={state.enabled ? '关闭后总监不再巡视或分管任何空间' : '启用工作总监'}
            onClick={() => void save({ enabled: !state.enabled })}
          >
            <span />
          </button>
          <button
            type="button"
            className="director__config-btn"
            title="配置：最多下发多少个任务同时执行"
            aria-label="任务配置"
            onClick={() => setConfigOpen(true)}
          >
            <SettingsIcon size={14} />
          </button>
        </div>

        <div className="director__modes" role="group" aria-label="授权级别">
          {MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              className={`director__mode ${state.mode === mode.key ? 'is-active' : ''}`}
              disabled={!state.enabled}
              title={mode.hint}
              onClick={() => void save({ mode: mode.key })}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <p className="director__hint" title={activeMode.hint}>
          {state.enabled
            ? `分管 ${assigned.length} / ${spaces.length} 个空间 · ${activeMode.hint}`
            : '未启用：总监不巡视任何空间，也不会推进任何任务'}
        </p>
      </div>

      {usageRows.length > 0 && (
        <div className="director__usage">
          <button
            type="button"
            className="director__usage-sum"
            aria-expanded={usageOpen}
            title="当前正在执行的任务合计花费"
            onClick={() => setUsageOpen((value) => !value)}
          >
            <BillingIcon size={13} />
            <span>{usageRows.length} 个任务运行中</span>
            <span className="director__usage-cost">
              {costText(
                usageRows.reduce((sum, row) => sum + row.cost, 0),
                usageRows.reduce((sum, row) => sum + row.unpriced, 0),
              )}
            </span>
            <span>
              {formatTokens(usageRows.reduce((sum, row) => sum + row.outputTokens, 0))} tok
            </span>
            {speed !== null && speed > 0 && (
              <span className="director__usage-speed">{speed.toFixed(1)} tok/s</span>
            )}
          </button>
          {usageOpen && (
            <div className="director__usage-pop" role="dialog" aria-label="激活任务的用量">
              {usageRows.map((row) => (
                <div key={row.taskId} className="director__usage-row">
                  <span className="director__usage-name" title={row.title}>
                    {row.title}
                  </span>
                  <span>{formatTokens(row.outputTokens)} tok</span>
                  <span>{costText(row.cost, row.unpriced)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="director__spaces-bar">
        <button
          type="button"
          className="director__scope-btn"
          onClick={() => setScopeOpen(true)}
        >
          分管范围
          <span className="director__scope-count">
            {assigned.length} / {spaces.length}
          </span>
        </button>
        <div className="director__drawer-tabs">
          <button type="button" className="director__tab" onClick={openRecords}>
            对话历史
          </button>
          <button
            type="button"
            className="director__tab"
            title="审计重复投入：查清浪费、给出可视化报告和预制建议；不会改动任何能力"
            onClick={openAudit}
            disabled={auditLoading}
          >
            {auditLoading ? '审计中…' : '内容审计'}
          </button>
        </div>
        {spaces.length === 0 && (
          <span className="director__spaces-sum">还没有工作空间</span>
        )}
        <button
          type="button"
          className="director__clear"
          disabled={!canClear}
          title={canClear ? '清空对话并留档，未处理的待确认事项会保留' : '总监正在回复，等这一轮结束再清空'}
          onClick={() => setConfirmClear(true)}
        >
          清空对话
        </button>
      </div>

      {configOpen && (
        <div className="director__modal-mask" onClick={() => setConfigOpen(false)}>
          <div
            className="director__modal director__modal--config"
            role="dialog"
            aria-label="任务配置"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>任务配置</h3>
              <span>派工的上限</span>
              <button type="button" className="btn btn--tiny" onClick={() => setConfigOpen(false)}>
                关闭
              </button>
            </header>
            <div className="director__config-body">
              <label className="director__config-field">
                <span>最多同时执行的下发任务数</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={maxDraft}
                  onChange={(event) => setMaxDraft(event.target.value)}
                />
              </label>
              <p className="director__config-hint">
                超出的员工会排队，等有空位再开始。验收员也占一个位置：一个人要么在编制，要么在验收。
              </p>
              <label className="director__config-field">
                <span>验收不通过时最多返工几轮</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={reworkDraft}
                  onChange={(event) => setReworkDraft(event.target.value)}
                />
              </label>
              <p className="director__config-hint">
                默认 2 轮。到上限就停下来问你，不再自己反复重做。
              </p>
              {notice && <p className="director__config-error">{notice}</p>}
              <div className="director__config-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setDesignOpen(true)}
                >
                  查看总监设计思路
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={savingConfig}
                  onClick={() => void saveConfig()}
                >
                  {savingConfig ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {designOpen && (
        <div className="director__modal-mask" onClick={() => setDesignOpen(false)}>
          <div
            className="director__modal director__modal--design"
            role="dialog"
            aria-label="总监设计思路"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>总监设计思路</h3>
              <span>它是怎么接活、派人、验收和收尾的</span>
              <button type="button" className="btn btn--tiny" onClick={() => setDesignOpen(false)}>
                关闭
              </button>
            </header>
            <div className="director__design-body">
              <section>
                <h4>1. 先看授权，再动手</h4>
                <p>
                  观察级别只提醒、不派活；建议级别会先把分工写成一条建议等你点头；代跑级别才会直接派。
                  分管范围之外的工作空间一律不碰。
                </p>
              </section>
              <section>
                <h4>2. 接活先建档，先说两个时间</h4>
                <p>
                  每件事都会建一个项目档案，记下目标、工作空间、涉及的任务和已经拍过的板。
                  开工前它会给两个预计时间：<b>编制完成时间</b>和<b>验收完成时间</b>。
                  这两个时间不是硬截止，是它自己检查进度的闹钟——到点会主动看一次，慢了就重新分配人手。
                </p>
                <p>
                  默认只派一个员工。只有文件集互不重叠、又能各自独立启动的活才拆开；小项目、单文件、
                  接口强耦合的活都走一个人。有先后依赖的（比如先有后端接口再做前端），
                  后一个的验收会等前一个收口，不拿半截接口去判错。
                </p>
              </section>
              <section>
                <h4>3. 一个任务占一个工位</h4>
                <p>
                  派工上限就是工位数。一个员工从编制到验收结束只占一个位置：编制完成、验收员接手时，
                  位置直接转给验收员，不会多占。所以同时在场的人数永远不超过你设的上限。
                </p>
              </section>
              <section>
                <h4>4. 编制 → 先交给你 → 再验收</h4>
                <p>
                  员工一停，总监先把这一版交给你：单个文件给文件，整个项目给工作空间路径和入口，
                  并标明这是阶段版。然后它才安排验收员。你不需要等验收结束才能看到东西。
                </p>
                <p>
                  交付的定义是<b>能按真实入口跑起来的程序</b>，不是“文件写完了”。交过来之前，
                  它会先自己核对一遍：有没有桩、模拟服务器、改 PYTHONPATH 或临时脚本顶替真实实现，
                  有没有可启动的入口，工人的答复里有没有启动命令和实际输出。核对不过，
                  交付消息里会直接标出来，这一版不会被当成完成。
                </p>
              </section>
              <section>
                <h4>5. 验收员只验不改</h4>
                <p>
                  验收员是单独的一次任务，不占用编制员工，也不改任何源码。它只盯 3–6 个关键点：
                  交付是不是真实实现、交付文件在不在、核心功能能不能用、程序能不能启动。
                  它必须按说明实际启动真实入口跑一次，把启动命令和看到的输出写进证据；只看文件存在不算通过。
                  5–10 分钟内收口，结论只有三种：通过、不通过、未验证。
                </p>
                <p>
                  没有证据就记“未验证”，不会算成通过；验收员说通过、但预检发现是桩或测试产物的，
                  也不会算成通过——这种情况它会在返工额度内自动打回重做一次，不用你处理。
                  验收员本身不再被验收，避免无限套娃。
                  有前置依赖的任务，验收会等前置交付并收口后再开始，不拿半截接口判错。
                </p>
                <p>
                  验收是它的活，不是你的：验收没给出结论，它会如实记“未验证”并说明原因，
                  不会把“你来验一下”丢给你。要补验，跟它说一声就行。
                </p>
              </section>
              <section>
                <h4>6. 不通过就只补缺口</h4>
                <p>
                  验收没过，原员工只补没过的那几项，不重做已经通过的部分。默认最多返工 2 轮
                  （可在上面的配置里改）；三件事自动做，不问你：验收不通过就返工、
                  交付像测试产物就打回重做、验收员没给结论就记未验证。只有返工到上限还不过，
                  才问你要不要再试一次。
                </p>
              </section>
              <section>
                <h4>7. 汇报按项目走，不刷屏</h4>
                <p>
                  单个任务完成：发一条交付消息，标明“验收中”。验收有结论：更新同一条，不另发。
                  一个项目的编制全部结束、验收还没结束时：发一条“编制完毕，正在验收”，
                  之后结论都往这条里补。返工、卡住、需要你拍板，才会单独提醒。
                </p>
              </section>
              <section>
                <h4>8. 员工卡住会先判断，再处理</h4>
                <p>
                  总监会旁听每个员工的状态、输出和工具调用，判断是模型报错、网络断了、
                  还是长时间没有新内容/陷入重复。处理顺序是：先叫停重来，再换模型或换任务，
                  都不行才向你报告，并说清卡在哪一步。
                </p>
              </section>
              <section>
                <h4>9. 你说的话优先级最高</h4>
                <p>
                  任何阶段你让它停、重开或改任务，它都照做。你直接进任务里改了东西并离开后，
                  它会先看改了什么：已经按你的要求完成就收尾，还差东西就继续安排。
                </p>
              </section>
              <section>
                <h4>10. 空出来的位置去补位</h4>
                <p>
                  一个项目全部验收通过、位置空出来后，它会看别的项目谁偏慢、谁在等验收，
                  把空位派过去帮忙。如果帮忙会跟别人写同一批文件，就不硬塞，改用接力或验收的方式。
                  没有值得帮的活，位置就空着，不为了填满而派工。
                </p>
              </section>
              <section>
                <h4>11. 最后做一次整体检查</h4>
                <p>
                  所有项目都完工、验收都有结论后，它会对照验收结论检查接口和衔接处。
                  有疑问会再派一次“只回答、不要开始编制”的询问任务给相关员工，
                  确认后再给你最终结论。
                </p>
              </section>
            </div>
          </div>
        </div>
      )}

      {auditOpen && (
        <div className="director__modal-mask" onClick={closeAudit}>
          <div
            className="director__modal director__modal--audit"
            role="dialog"
            aria-label="内容审计"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>内容审计</h3>
              <span>
                近 {audit?.windowDays ?? 30} 天 · 审计组出具只读审计报告，不会改动任何能力
              </span>
              <button type="button" className="btn btn--tiny" onClick={closeAudit}>
                关闭
              </button>
            </header>

            {auditLoading && !audit && (
              <p className="director__empty">正在整理运行记录…</p>
            )}
            {auditError && <p className="director__config-error">{auditError}</p>}

            {audit && (
              <div className="director__audit-body">
                {audit.report?.markdown && (
                  <details className="director__audit-report" open>
                    <summary>审计报告</summary>
                    <div className="director__audit-report-body">
                      <MarkdownView text={audit.report.markdown} />
                    </div>
                  </details>
                )}

                <h4 className="director__audit-subhead">统计明细</h4>
                <div className="viz-kpis">
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">
                      {formatSpan(audit.totals?.reclaimMs ?? 0)}
                    </strong>
                    <span className="viz-kpi__label">重复投入的时间</span>
                    <span className="viz-kpi__note">第一次不算浪费</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">
                      {formatTokens(audit.totals?.reclaimTokens ?? 0)}
                    </strong>
                    <span className="viz-kpi__label">可回收 token</span>
                    <span className="viz-kpi__note">按每次平均消耗折算</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">{audit.totals?.share ?? 0}%</strong>
                    <span className="viz-kpi__label">重复投入占比</span>
                    <span className="viz-kpi__note">按时间算</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">{audit.pending ?? 0}</strong>
                    <span className="viz-kpi__label">已达到预制标准</span>
                    <span className="viz-kpi__note">共 {audit.totals?.repeated ?? 0} 类重复</span>
                  </div>
                </div>

                <p className="director__audit-summary">{audit.summary}</p>
                {audit.detail && <p className="director__audit-detail">{audit.detail}</p>}

                {((audit.tasks ?? []).length > 0 ||
                  (audit.agents ?? []).length > 0 ||
                  (audit.projects ?? []).length > 0 ||
                  (audit.tools ?? []).length > 0) && (
                  <div className="director__audit-groups">
                    {(audit.projects ?? []).length > 0 && (
                      <details className="director__audit-advice" open>
                        <summary>按项目看（{audit.projects?.length ?? 0}）</summary>
                        {(audit.projects ?? []).map((project) => (
                          <p key={project.id} className="director__audit-line">
                            <strong>{project.title}</strong> ·{' '}
                            {project.status === 'done' ? '已收口' : '进行中'} ·{' '}
                            {project.employees} 个员工 · 通过 {project.accepted}
                            {project.unverified > 0 ? ` · 未验证 ${project.unverified}` : ''}
                            {project.held > 0 ? ` · 等你确认 ${project.held}` : ''}
                            {project.failed > 0 ? ` · 没通过 ${project.failed}` : ''} · 用时{' '}
                            {formatSpan(project.elapsedMs)}
                            {project.estimateMs > 0
                              ? ` / 预估 ${formatSpan(project.estimateMs)}${
                                  project.overMs > 0 ? `（超 ${formatSpan(project.overMs)}）` : ''
                                }`
                              : ' / 未估时'}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.tasks ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>按任务看（{audit.tasks?.length ?? 0}）</summary>
                        {(audit.tasks ?? []).map((task) => (
                          <p key={task.taskId} className="director__audit-line">
                            <strong>{task.title}</strong> · {task.instructions} 条指令 · 通过{' '}
                            {task.accepted}
                            {task.rework > 0 ? ` · 返工 ${task.rework}` : ''}
                            {task.unverified > 0 ? ` · 未验证 ${task.unverified}` : ''}
                            {task.failed > 0 ? ` · 没通过 ${task.failed}` : ''} ·{' '}
                            {formatSpan(task.runMs)}
                            {task.tokens > 0 ? ` · ${formatTokens(task.tokens)} tok` : ''}
                            {task.files > 0 ? ` · ${task.files} 个文件` : ''}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.agents ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>按员工看（{audit.agents?.length ?? 0}）</summary>
                        {(audit.agents ?? []).map((agent) => (
                          <p key={agent.id || agent.name} className="director__audit-line">
                            <strong>{agent.name}</strong> · {agent.tasks} 个任务 ·{' '}
                            {agent.instructions} 条指令 · 通过 {agent.accepted}
                            {agent.rework > 0 ? ` · 返工 ${agent.rework}` : ''}
                            {agent.unverified > 0 ? ` · 未验证 ${agent.unverified}` : ''}
                            {agent.failed > 0 ? ` · 没通过 ${agent.failed}` : ''} ·{' '}
                            {formatSpan(agent.runMs)}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.tools ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>按能力看（{audit.tools?.length ?? 0}）</summary>
                        {(audit.tools ?? []).map((tool) => (
                          <p key={tool.name} className="director__audit-line">
                            <strong>{tool.name}</strong> · {tool.calls} 次 · {tool.runs} 轮 ·{' '}
                            {tool.tasks} 个任务
                          </p>
                        ))}
                      </details>
                    )}
                  </div>
                )}

                {auditChartList.length > 0 && (
                  <div className="director__audit-charts">
                    {auditChartList.map((chart) => (
                      <VizChartCard key={chart.title} chart={chart} span={4} />
                    ))}
                  </div>
                )}

                {(audit.items ?? []).length > 0 && (
                  <div className="director__audit-list">
                    {(audit.items ?? []).map((item) => (
                      <article className="director__audit-row" key={item.key}>
                        <header className="director__audit-rowhead">
                          <strong>{item.title}</strong>
                          <span
                            className={`director__audit-badge ${
                              item.candidate ? 'is-candidate' : ''
                            }`}
                          >
                            {item.candidate ? '可预制' : '观察中'}
                          </span>
                          {item.muted && <span className="director__audit-badge">已静默</span>}
                          <span className="director__audit-meta">
                            {item.runs} 次 · 跨 {item.tasks} 个任务 · 回收{' '}
                            {formatSpan(item.reclaimMs)}
                            {item.reclaimTokens > 0
                              ? ` · ${formatTokens(item.reclaimTokens)} tok`
                              : ''}
                          </span>
                        </header>
                        <p className="director__audit-evidence">{item.evidence.join('\n')}</p>
                        {item.adviceBody && (
                          <details className="director__audit-advice">
                            <summary>总监的建议（{stamp(item.adviceAt)}）</summary>
                            <p>{item.adviceBody}</p>
                          </details>
                        )}
                      </article>
                    ))}
                  </div>
                )}

                <footer className="director__audit-foot">
                  <button
                    type="button"
                    className="btn btn--primary btn--tiny"
                    disabled={auditLoading}
                    onClick={() => void loadAudit(true)}
                  >
                    {auditLoading ? '审计组正在写…' : '刷新审计报告'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--tiny"
                    disabled={auditReviewing || (audit.items ?? []).length === 0}
                    title={
                      (audit.items ?? []).length === 0
                        ? '同一类活至少出现 3 次、跨 2 个任务，才有可复盘的对象'
                        : undefined
                    }
                    onClick={() => void auditReview()}
                  >
                    {auditReviewing ? '审计组正在看…' : '补充改进建议'}
                  </button>
                  <span
                    className={`director__audit-hint${auditNoteKind ? ` is-${auditNoteKind}` : ''}`}
                    role="status"
                  >
                    {auditNote ||
                      (auditReviewing
                        ? '模型正在看几类活的证据（最多三类）；答不上来会自动停，不会一直卡着。'
                        : '审计报告会署名发到对话里；报告只读，需要执行时告诉总监，由他派人做。')}
                  </span>
                </footer>
              </div>
            )}
          </div>
        </div>
      )}

      {recordsOpen && (
        <div className="director__modal-mask" onClick={closeRecords}>
          <div
            className="director__modal director__modal--records"
            role="dialog"
            aria-label="对话历史"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              {view.kind !== 'list' && (
                <button type="button" className="btn btn--tiny" onClick={goBack}>
                  ← 返回
                </button>
              )}
              <h3>{detailTitle}</h3>
              <span>{detailSubtitle}</span>
              <button type="button" className="btn btn--tiny" onClick={closeRecords}>
                关闭
              </button>
            </header>

            {view.kind === 'list' && (
              <div className="director__records-body">
                <div className="director__records-bar">
                  {LIST_FILTERS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`director__records-chip ${listFilter === item.key ? 'is-active' : ''}`}
                      onClick={() => switchFilter(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                  {listFilter === 'archives' && (
                    <div className="director__records-actions">
                      {selecting ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--tiny"
                            disabled={historyLoading || archives.length === 0}
                            onClick={pickAll}
                          >
                            {picked.size === archives.length && archives.length > 0
                              ? '取消全选'
                              : '全选'}
                          </button>
                          <button type="button" className="btn btn--tiny" onClick={cancelSelect}>
                            取消
                          </button>
                          <button
                            type="button"
                            className="btn btn--tiny director__records-danger"
                            disabled={picked.size === 0 || deleting}
                            onClick={() => setConfirmDeletePicked(true)}
                          >
                            {deleting ? '删除中…' : `删除所选${picked.size ? ` (${picked.size})` : ''}`}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn--tiny"
                            disabled={historyLoading || archives.length === 0}
                            onClick={() => {
                              setSelecting(true);
                              setPicked(new Set());
                            }}
                          >
                            多选
                          </button>
                          <button
                            type="button"
                            className="btn btn--tiny"
                            disabled={historyLoading || deduping}
                            onClick={() => setConfirmDedupe(true)}
                          >
                            {deduping ? '清理中…' : '清理重复'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <p className="director__ledger-note">{LIST_NOTE[listFilter]}</p>
                {recordsNote && (
                  <p className="director__records-note" role="status">
                    {recordsNote}
                  </p>
                )}

                {opening && <p className="director__empty">正在打开存档…</p>}

                {!opening && listFilter === 'archives' && historyLoading && (
                  <p className="director__empty">正在读取对话存档…</p>
                )}
                {!opening && listFilter === 'archives' && !historyLoading && historyError && (
                  <p className="director__empty">{historyError}</p>
                )}
                {!opening && listFilter === 'archives' && !historyLoading && archives.length > 0 && (
                  <div className={`director__records ${selecting ? 'is-selecting' : ''}`}>
                    {archives.map((entry) => {
                      const isPicked = picked.has(entry.id);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          className={`director__record-row ${selecting ? 'is-picking' : ''} ${
                            isPicked ? 'is-picked' : ''
                          }`}
                          title={selecting ? (isPicked ? '取消选择' : '选中这条存档') : entry.title}
                          aria-pressed={selecting ? isPicked : undefined}
                          onClick={() =>
                            selecting ? togglePick(entry.id) : void openArchive(entry)
                          }
                        >
                          {selecting && (
                            <span
                              className={`director__record-check ${isPicked ? 'is-on' : ''}`}
                              aria-hidden="true"
                            >
                              {isPicked ? '✓' : ''}
                            </span>
                          )}
                          <span className="director__record-time">{stamp(entry.at)}</span>
                          <span className="director__record-tag is-archive">对话存档</span>
                          <span className="director__record-title">{entry.title}</span>
                          <span className="director__record-text">
                            {selecting
                              ? `${entry.count} 条对话 · ${transactionCount(entry)} 条事务`
                              : `${entry.count} 条对话 · ${transactionCount(entry)} 条事务 ›`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {!opening &&
                  listFilter === 'archives' &&
                  !historyLoading &&
                  !historyError &&
                  archives.length === 0 && (
                    <p className="director__empty">
                      还没有对话存档。清空对话时会按话题分段留档，并把这段期间的总监事务一起装进去。
                    </p>
                  )}

                {!opening && listFilter === 'ledger' && ledgerRows.length === 0 && (
                  <p className="director__empty">还没有事务记录。</p>
                )}
                {!opening && listFilter === 'ledger' && ledgerRows.length > 0 && (
                  <div className="director__records">
                    {ledgerRows.map((entry, index) => (
                      <button
                        key={`${entry.at}-${index}`}
                        type="button"
                        className="director__record-row"
                        onClick={() => openLedger(entry, view)}
                      >
                        <span className="director__record-time">{stamp(entry.at)}</span>
                        <span
                          className={`director__record-tag is-${entry.side === 'director' ? 'director' : 'task'}`}
                        >
                          {entry.side === 'director' ? '总监' : '任务'} ·{' '}
                          {entry.label || entry.kind}
                        </span>
                        <span className="director__record-title">
                          {entry.title || entry.taskId}
                        </span>
                        <span className="director__record-text">{entry.text}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {view.kind === 'folder' && (
              <>
                <div className="director__records-bar">
                  <button
                    type="button"
                    className={`director__records-chip ${view.tab === 'chat' ? 'is-active' : ''}`}
                    onClick={() => setView({ kind: 'folder', entry: view.entry, tab: 'chat' })}
                  >
                    对话内容 {view.entry.messages.length}
                  </button>
                  <button
                    type="button"
                    className={`director__records-chip ${view.tab === 'ledger' ? 'is-active' : ''}`}
                    onClick={() => setView({ kind: 'folder', entry: view.entry, tab: 'ledger' })}
                  >
                    总监事务 {folderTransactions(view.entry).length}
                  </button>
                </div>

                {view.tab === 'chat' && (
                  <>
                    <div className="director__history-list">
                      {view.entry.messages.length === 0 && (
                        <p className="director__empty">这段存档没有可显示的消息。</p>
                      )}
                      {view.entry.messages.map((message, index) => (
                        <article
                          key={`${message.id ?? 'row'}-${index}`}
                          className={`director__history-msg is-${message.role}`}
                        >
                          <header>
                            <span>
                              {message.director
                                ? '工作总监 · 汇报'
                                : message.role === 'user'
                                  ? '我'
                                  : '工作总监'}
                            </span>
                            <time>{stamp(message.createdAt)}</time>
                          </header>
                          {message.director && (
                            <strong className="director__history-msg-title">
                              {message.director.title}
                            </strong>
                          )}
                          <div className="director__history-msg-body">
                            <MarkdownView text={message.content} />
                          </div>
                        </article>
                      ))}
                    </div>
                    {Array.isArray(view.entry.session) && view.entry.session.length > 0 && (
                      <details className="director__history-raw">
                        <summary>
                          原始会话记录（{view.entry.session.length} 条，含工具调用）
                        </summary>
                        <pre>{JSON.stringify(view.entry.session, null, 2)}</pre>
                      </details>
                    )}
                  </>
                )}

                {view.tab === 'ledger' && (
                  <div className="director__records-body">
                    {folderTransactions(view.entry).length === 0 ? (
                      <p className="director__empty">这段对话期间，总监没有留下事务记录。</p>
                    ) : (
                      <div className="director__records">
                        {folderTransactions(view.entry).map((entry, index) => (
                          <button
                            key={`${entry.at}-${index}`}
                            type="button"
                            className="director__record-row"
                            onClick={() => openLedger(entry, view)}
                          >
                            <span className="director__record-time">{stamp(entry.at)}</span>
                            <span
                              className={`director__record-tag is-${entry.side === 'director' ? 'director' : 'task'}`}
                            >
                              {entry.side === 'director' ? '总监' : '任务'} ·{' '}
                              {entry.label || entry.kind}
                            </span>
                            <span className="director__record-title">
                              {entry.title || entry.taskId}
                            </span>
                            <span className="director__record-text">{entry.text}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {view.kind === 'ledger' && (
              <div className="director__record-detail">
                <dl>
                  <div>
                    <dt>时间</dt>
                    <dd>{fullStamp(view.entry.at)}</dd>
                  </div>
                  <div>
                    <dt>分类</dt>
                    <dd>
                      {view.entry.side === 'director' ? '总监' : '任务'} ·{' '}
                      {view.entry.label || view.entry.kind}
                    </dd>
                  </div>
                  <div>
                    <dt>任务 / 事项</dt>
                    <dd>{view.entry.title || view.entry.taskId || '—'}</dd>
                  </div>
                  <div className="is-wide">
                    <dt>内容</dt>
                    <dd>{view.entry.text || '（没有更多细节）'}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmDedupe && (
        <ConfirmDialog
          title="清理重复的对话存档？"
          message="只删除对话内容完全相同的副本，每组保留时间范围最完整的一份；正常的存档不会动。"
          confirmLabel={deduping ? '正在清理…' : '清理重复'}
          danger
          raised
          busy={deduping}
          onConfirm={() => void dedupeHistory()}
          onCancel={() => setConfirmDedupe(false)}
        />
      )}

      {confirmDeletePicked && (
        <ConfirmDialog
          title={`彻底删除选中的 ${picked.size} 个对话存档？`}
          message="这一步不可恢复：存档文件、对应的总监记忆、这段对话期间的事务记录会一起删掉，总监以后再也想不起来这段。其他存档、总监主动保存的长期记忆不受影响。"
          confirmLabel={deleting ? '正在删除…' : '删除'}
          danger
          raised
          busy={deleting}
          onConfirm={() => void deletePicked()}
          onCancel={() => setConfirmDeletePicked(false)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title="清空历史对话？"
          message="总监当前的对话记录和模型上下文会被清空，并按话题分段留档到「对话历史」：以后可以靠记忆匹配到摘要，再读回原话。没有处理过的待确认事项会保留在对话里；不想留档就在「对话历史」里彻底删除。"
          confirmLabel={clearing ? '正在留档…' : '清空并留档'}
          danger
          busy={clearing}
          onConfirm={() => void clearHistory()}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {scopeOpen && (
        <ScopeDialog
          spaces={spaces}
          assigned={new Set(assigned.map((space) => space.id))}
          onClose={() => setScopeOpen(false)}
          onMove={(ids, into) => void moveSpaces(ids, into)}
        />
      )}

      {notice && <div className="director__toast">{notice}</div>}
    </section>
  );
}

function ScopeDialog({
  spaces,
  assigned,
  onClose,
  onMove,
}: {
  spaces: SpaceRef[];
  assigned: Set<string>;
  onClose: () => void;
  onMove: (ids: string[], into: boolean) => void;
}) {
  const [queryLeft, setQueryLeft] = useState('');
  const [queryRight, setQueryRight] = useState('');
  const [pickedLeft, setPickedLeft] = useState<Set<string>>(() => new Set());
  const [pickedRight, setPickedRight] = useState<Set<string>>(() => new Set());
  const [dragOver, setDragOver] = useState<'left' | 'right' | null>(null);

  const available = spaces.filter((space) => !assigned.has(space.id));
  const mine = spaces.filter((space) => assigned.has(space.id));

  const visibleLeft = available.filter((space) => matches(space, queryLeft));
  const visibleRight = mine.filter((space) => matches(space, queryRight));

  function toggle(side: 'left' | 'right', id: string) {
    const setter = side === 'left' ? setPickedLeft : setPickedRight;
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function move(ids: string[], into: boolean) {
    if (ids.length === 0) return;
    onMove(ids, into);
    if (into) {
      setPickedLeft((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    } else {
      setPickedRight((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }

  function drop(side: 'left' | 'right', event: DragEvent) {
    event.preventDefault();
    setDragOver(null);
    const id = event.dataTransfer.getData('text/plain');
    if (!id) return;
    const isAssigned = assigned.has(id);
    if (side === 'right' && !isAssigned) move([id], true);
    if (side === 'left' && isAssigned) move([id], false);
  }

  return (
    <div className="director__modal-mask" onClick={onClose}>
      <div
        className="director__modal"
        role="dialog"
        aria-label="分管范围"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="director__modal-head">
          <h3>分管范围</h3>
          <span>右侧是总监分管的全部空间；拖动或点箭头调整。未分管的空间它看不到。</span>
          <button type="button" className="btn btn--tiny" onClick={onClose}>
            完成
          </button>
        </header>

        <div className="director__scope-grid">
          <section
            className={`director__scope-panel ${dragOver === 'left' ? 'is-over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver('left');
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(event) => drop('left', event)}
          >
            <header className="director__scope-head">
              <strong>未分管</strong>
              <span>{available.length}</span>
            </header>
            <input
              className="input"
              value={queryLeft}
              placeholder="搜索工作空间…"
              onChange={(event) => setQueryLeft(event.target.value)}
            />
            <ul className="director__scope-list">
              {visibleLeft.length === 0 && (
                <li className="director__scope-empty">
                  {available.length === 0 ? '所有空间都已在右侧' : '没有匹配的空间'}
                </li>
              )}
              {visibleLeft.map((space) => (
                <li
                  key={space.id}
                  className={`director__scope-row ${pickedLeft.has(space.id) ? 'is-picked' : ''}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', space.id);
                  }}
                  onClick={() => toggle('left', space.id)}
                  title={space.path || space.name}
                >
                  <span className="director__scope-name">{space.name}</span>
                  <span className="director__scope-path">{space.path}</span>
                  <button
                    type="button"
                    className="director__scope-arrow"
                    aria-label={`分管 ${space.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      move([space.id], true);
                    }}
                  >
                    →
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section
            className={`director__scope-panel ${dragOver === 'right' ? 'is-over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver('right');
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(event) => drop('right', event)}
          >
            <header className="director__scope-head">
              <strong>分管</strong>
              <span>{mine.length}</span>
            </header>
            <input
              className="input"
              value={queryRight}
              placeholder="搜索分管空间…"
              onChange={(event) => setQueryRight(event.target.value)}
            />
            <ul className="director__scope-list">
              {visibleRight.length === 0 && (
                <li className="director__scope-empty">
                  {mine.length === 0 ? '把左侧的工作空间拖进来' : '没有匹配的空间'}
                </li>
              )}
              {visibleRight.map((space) => (
                <li
                  key={space.id}
                  className={`director__scope-row ${pickedRight.has(space.id) ? 'is-picked' : ''}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', space.id);
                  }}
                  onClick={() => toggle('right', space.id)}
                  title={space.path || space.name}
                >
                  <button
                    type="button"
                    className="director__scope-arrow"
                    aria-label={`移出 ${space.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      move([space.id], false);
                    }}
                  >
                    ←
                  </button>
                  <span className="director__scope-name">{space.name}</span>
                  <span className="director__scope-path">{space.path}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="director__scope-foot">
          <div>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={pickedLeft.size === 0}
              onClick={() => move([...pickedLeft], true)}
            >
              → 纳入分管（{pickedLeft.size}）
            </button>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={pickedRight.size === 0}
              onClick={() => move([...pickedRight], false)}
            >
              ← 移出分管（{pickedRight.size}）
            </button>
          </div>
          <div>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={available.length === 0}
              onClick={() => move(available.map((space) => space.id), true)}
            >
              全部纳入
            </button>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={mine.length === 0}
              onClick={() => move(mine.map((space) => space.id), false)}
            >
              全部移出
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function matches(space: SpaceRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    space.name.toLowerCase().includes(needle) ||
    (space.path ?? '').toLowerCase().includes(needle)
  );
}
