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
import { useI18n } from '../i18n';
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

type Translate = ReturnType<typeof useI18n>['t'];

const MODES: { key: DirectorMode; labelKey: string; hintKey: string }[] = [
  { key: 'observe', labelKey: 'director.page.mode.observe', hintKey: 'director.page.mode.observeHint' },
  { key: 'suggest', labelKey: 'director.page.mode.suggest', hintKey: 'director.page.mode.suggestHint' },
  { key: 'run', labelKey: 'director.page.mode.run', hintKey: 'director.page.mode.runHint' },
];

type ListFilter = 'archives' | 'ledger';
type ArchiveTab = 'chat' | 'ledger';

const LIST_FILTERS: { key: ListFilter; labelKey: string }[] = [
  { key: 'archives', labelKey: 'director.page.records.archives' },
  { key: 'ledger', labelKey: 'director.page.records.ledger' },
];

const LIST_NOTE_KEY: Record<ListFilter, string> = {
  archives: 'director.page.records.archivesNote',
  ledger: 'director.page.records.ledgerNote',
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

function fullStamp(at: number, locale: string): string {
  if (!at) return '';
  return new Date(at).toLocaleString(locale, { hour12: false });
}

function costText(cost: number, unpriced: number, t: Translate): string {
  if (cost > 0) return `¥${cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)}`;
  return unpriced > 0 ? t('director.page.cost.unpriced') : '¥0';
}

/** 审计里的时长：秒 / 分 / 小时，最多两级。 */
function formatSpan(ms: number, t: Translate): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return t('director.page.span.seconds', { count: total });
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) {
    return seconds
      ? t('director.page.span.minutesSeconds', { minutes, seconds })
      : t('director.page.span.minutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? t('director.page.span.hoursMinutes', { hours, minutes: rest })
    : t('director.page.span.hours', { count: hours });
}

/**
 * 审计的两张图：重复投入的时间、重复投入的 token。
 * 数字只来自本地运行记录，模型没有参与算账；单序列条形图用同一色相。
 */
function auditCharts(audit: DirectorAudit | null, t: Translate): VizChart[] {
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
      title: t('director.page.chart.time.title'),
      subtitle: t('director.page.chart.time.subtitle'),
      unit: t('director.page.chart.time.unit'),
      xLabel: t('director.page.chart.time.xLabel'),
      source: t('director.page.chart.time.source'),
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
      title: t('director.page.chart.tokens.title'),
      subtitle: t('director.page.chart.tokens.subtitle'),
      unit: 'tok',
      xLabel: t('director.page.chart.tokens.xLabel'),
      source: t('director.page.chart.tokens.source'),
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
  const { t, locale } = useI18n();
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

  const auditChartList = useMemo(() => auditCharts(audit, t), [audit, t]);

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
      setNotice(result?.error ?? t('director.page.saveFailed'));
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
        setHistoryError(result?.error ?? t('director.page.history.loadFailed'));
      }
    } catch (error) {
      setHistory([]);
      setHistoryError(
        t('director.page.history.loadFailedDetail', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
      flashRecords(t('director.page.restartRequired'));
      setConfirmDedupe(false);
      return;
    }
    setDeduping(true);
    try {
      const result = await window.ezness.directorHistoryDedupe();
      if (!result?.ok) {
        flashRecords(result?.error ?? t('director.page.dedupe.failed'));
        return;
      }
      flashRecords(
        result.removed
          ? t('director.page.dedupe.done', { count: result.removed })
          : t('director.page.dedupe.none'),
      );
      cancelSelect();
      await loadHistory();
    } catch (error) {
      flashRecords(
        t('director.page.dedupe.failedDetail', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
        setHistoryError(result?.error ?? t('director.page.archive.unavailable'));
        return;
      }
      setHistoryError('');
      setView({ kind: 'folder', entry: result.entry, tab: 'chat' });
    } catch (error) {
      setHistoryError(
        t('director.page.archive.unavailableDetail', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
      flashRecords(t('director.page.restartRequired'));
      setConfirmDeletePicked(false);
      return;
    }
    setDeleting(true);
    const ids = [...picked];
    try {
      const result = await window.ezness.directorHistoryDelete(ids);
      if (!result?.ok) {
        flashRecords(result?.error ?? t('director.page.delete.failed'));
        return;
      }
      const tx = Number(result.transactions) || 0;
      flashRecords(
        result.removed
          ? t(tx > 0 ? 'director.page.delete.doneWithTx' : 'director.page.delete.done', {
              count: result.removed,
              transactions: tx,
            })
          : t('director.page.delete.none'),
      );
      cancelSelect();
      await loadHistory();
      // 存档里的事务一起没了，事务列表也要跟着刷新。
      if (tx > 0) onRefreshLedger();
    } catch (error) {
      flashRecords(
        t('director.page.delete.failedDetail', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setDeleting(false);
      setConfirmDeletePicked(false);
    }
  }

  async function loadAudit(announce = false) {
    const api = window.ezness?.directorAudit;
    if (!api) {
      setAuditError(t('director.page.audit.unavailable'));
      return;
    }
    setAuditLoading(true);
    setAuditError('');
    try {
      const result = await api({ announce });
      if (result?.ok) setAudit(result);
      else setAuditError(result?.error || t('director.page.audit.readFailed'));
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
      setAuditNote(t('director.page.audit.reviewUnavailable'));
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
          t('director.page.audit.reviewSent', { title: result.title || t('director.page.untitled') }),
        );
        await loadAudit();
      } else {
        setAuditNoteKind('fail');
        setAuditNote(result?.error || t('director.page.audit.reviewFailed'));
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
        <p className="director__empty">{t('director.page.loading')}</p>
      </section>
    );
  }

  const activeMode = MODES.find((item) => item.key === state.mode) ?? MODES[1];
  const sideLabel = (side: string | undefined): string =>
    side === 'director' ? t('director.page.side.director') : t('director.page.side.task');
  const detailTitle =
    view.kind === 'folder'
      ? view.entry.title
      : view.kind === 'ledger'
        ? view.entry.title || view.entry.taskId || t('director.page.records.ledger')
        : t('director.page.history.title');
  const detailSubtitle =
    view.kind === 'folder'
      ? t('director.page.history.folderSubtitle', {
          messages: view.entry.count,
          transactions: folderTransactions(view.entry).length,
          time: fullStamp(view.entry.from || view.entry.at, locale),
        })
      : view.kind === 'ledger'
        ? t('director.page.history.ledgerSubtitle', {
            time: fullStamp(view.entry.at, locale),
            side: sideLabel(view.entry.side),
            label: view.entry.label || view.entry.kind,
          })
        : t('director.page.history.listSubtitle');

  return (
    <section className="director">
      <div className="director__head">
        <div className="director__title">
          <DirectorIcon size={18} />
          <h2>{t('director.page.title')}</h2>
          <button
            className={`switch ${state.enabled ? 'is-on' : ''}`}
            role="switch"
            aria-checked={state.enabled}
            aria-label={t('director.page.enable')}
            title={
              state.enabled ? t('director.page.disableTitle') : t('director.page.enable')
            }
            onClick={() => void save({ enabled: !state.enabled })}
          >
            <span />
          </button>
          <button
            type="button"
            className="director__config-btn"
            title={t('director.page.configButtonTitle')}
            aria-label={t('director.page.config.title')}
            onClick={() => setConfigOpen(true)}
          >
            <SettingsIcon size={14} />
          </button>
        </div>

        <div className="director__modes" role="group" aria-label={t('director.page.modeGroup')}>
          {MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              className={`director__mode ${state.mode === mode.key ? 'is-active' : ''}`}
              disabled={!state.enabled}
              title={t(mode.hintKey)}
              onClick={() => void save({ mode: mode.key })}
            >
              {t(mode.labelKey)}
            </button>
          ))}
        </div>

        <p className="director__hint" title={t(activeMode.hintKey)}>
          {state.enabled
            ? t('director.page.scopeSummary', {
                assigned: assigned.length,
                total: spaces.length,
                hint: t(activeMode.hintKey),
              })
            : t('director.page.disabledHint')}
        </p>
      </div>

      {usageRows.length > 0 && (
        <div className="director__usage">
          <button
            type="button"
            className="director__usage-sum"
            aria-expanded={usageOpen}
            title={t('director.page.usage.title')}
            onClick={() => setUsageOpen((value) => !value)}
          >
            <BillingIcon size={13} />
            <span>{t('director.page.usage.running', { count: usageRows.length })}</span>
            <span className="director__usage-cost">
              {costText(
                usageRows.reduce((sum, row) => sum + row.cost, 0),
                usageRows.reduce((sum, row) => sum + row.unpriced, 0),
                t,
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
            <div
              className="director__usage-pop"
              role="dialog"
              aria-label={t('director.page.usage.aria')}
            >
              {usageRows.map((row) => (
                <div key={row.taskId} className="director__usage-row">
                  <span className="director__usage-name" title={row.title}>
                    {row.title}
                  </span>
                  <span>{formatTokens(row.outputTokens)} tok</span>
                  <span>{costText(row.cost, row.unpriced, t)}</span>
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
          {t('director.page.scopeButton')}
          <span className="director__scope-count">
            {assigned.length} / {spaces.length}
          </span>
        </button>
        <div className="director__drawer-tabs">
          <button type="button" className="director__tab" onClick={openRecords}>
            {t('director.page.history.title')}
          </button>
          <button
            type="button"
            className="director__tab"
            title={t('director.page.audit.buttonTitle')}
            onClick={openAudit}
            disabled={auditLoading}
          >
            {auditLoading ? t('director.page.auditing') : t('director.page.audit.title')}
          </button>
        </div>
        {spaces.length === 0 && (
          <span className="director__spaces-sum">{t('director.page.noSpaces')}</span>
        )}
        <button
          type="button"
          className="director__clear"
          disabled={!canClear}
          title={canClear ? t('director.page.clearTitle') : t('director.page.clearDisabledTitle')}
          onClick={() => setConfirmClear(true)}
        >
          {t('director.page.clear')}
        </button>
      </div>

      {configOpen && (
        <div className="director__modal-mask" onClick={() => setConfigOpen(false)}>
          <div
            className="director__modal director__modal--config"
            role="dialog"
            aria-label={t('director.page.config.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>{t('director.page.config.title')}</h3>
              <span>{t('director.page.config.subtitle')}</span>
              <button type="button" className="btn btn--tiny" onClick={() => setConfigOpen(false)}>
                {t('director.common.close')}
              </button>
            </header>
            <div className="director__config-body">
              <label className="director__config-field">
                <span>{t('director.page.config.maxDispatch')}</span>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={maxDraft}
                  onChange={(event) => setMaxDraft(event.target.value)}
                />
              </label>
              <p className="director__config-hint">{t('director.page.config.maxDispatchHint')}</p>
              <label className="director__config-field">
                <span>{t('director.page.config.rework')}</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={reworkDraft}
                  onChange={(event) => setReworkDraft(event.target.value)}
                />
              </label>
              <p className="director__config-hint">{t('director.page.config.reworkHint')}</p>
              {notice && <p className="director__config-error">{notice}</p>}
              <div className="director__config-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setDesignOpen(true)}
                >
                  {t('director.page.config.design')}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={savingConfig}
                  onClick={() => void saveConfig()}
                >
                  {savingConfig ? t('director.common.saving') : t('director.common.save')}
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
            aria-label={t('director.page.design.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>{t('director.page.design.title')}</h3>
              <span>{t('director.page.design.subtitle')}</span>
              <button type="button" className="btn btn--tiny" onClick={() => setDesignOpen(false)}>
                {t('director.common.close')}
              </button>
            </header>
            <div className="director__design-body">
              <section>
                <h4>{t('director.page.design.s1.title')}</h4>
                <p>{t('director.page.design.s1.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s2.title')}</h4>
                <p>
                  {t('director.page.design.s2.body1a')}
                  <b>{t('director.page.design.s2.body1b')}</b>
                  {t('director.page.design.s2.body1c')}
                  <b>{t('director.page.design.s2.body1d')}</b>
                  {t('director.page.design.s2.body1e')}
                </p>
                <p>{t('director.page.design.s2.body2')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s3.title')}</h4>
                <p>{t('director.page.design.s3.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s4.title')}</h4>
                <p>{t('director.page.design.s4.body1')}</p>
                <p>
                  {t('director.page.design.s4.body2a')}
                  <b>{t('director.page.design.s4.body2b')}</b>
                  {t('director.page.design.s4.body2c')}
                </p>
              </section>
              <section>
                <h4>{t('director.page.design.s5.title')}</h4>
                <p>{t('director.page.design.s5.body1')}</p>
                <p>{t('director.page.design.s5.body2')}</p>
                <p>{t('director.page.design.s5.body3')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s6.title')}</h4>
                <p>{t('director.page.design.s6.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s7.title')}</h4>
                <p>{t('director.page.design.s7.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s8.title')}</h4>
                <p>{t('director.page.design.s8.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s9.title')}</h4>
                <p>{t('director.page.design.s9.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s10.title')}</h4>
                <p>{t('director.page.design.s10.body')}</p>
              </section>
              <section>
                <h4>{t('director.page.design.s11.title')}</h4>
                <p>{t('director.page.design.s11.body')}</p>
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
            aria-label={t('director.page.audit.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              <h3>{t('director.page.audit.title')}</h3>
              <span>{t('director.page.audit.subtitle', { days: audit?.windowDays ?? 30 })}</span>
              <button type="button" className="btn btn--tiny" onClick={closeAudit}>
                {t('director.common.close')}
              </button>
            </header>

            {auditLoading && !audit && (
              <p className="director__empty">{t('director.page.audit.loading')}</p>
            )}
            {auditError && <p className="director__config-error">{auditError}</p>}

            {audit && (
              <div className="director__audit-body">
                {audit.report?.markdown && (
                  <details className="director__audit-report" open>
                    <summary>{t('director.page.audit.report')}</summary>
                    <div className="director__audit-report-body">
                      <MarkdownView text={audit.report.markdown} />
                    </div>
                  </details>
                )}

                <h4 className="director__audit-subhead">{t('director.page.audit.stats')}</h4>
                <div className="viz-kpis">
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">
                      {formatSpan(audit.totals?.reclaimMs ?? 0, t)}
                    </strong>
                    <span className="viz-kpi__label">{t('director.page.audit.kpi.time')}</span>
                    <span className="viz-kpi__note">{t('director.page.audit.kpi.timeNote')}</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">
                      {formatTokens(audit.totals?.reclaimTokens ?? 0)}
                    </strong>
                    <span className="viz-kpi__label">{t('director.page.audit.kpi.tokens')}</span>
                    <span className="viz-kpi__note">{t('director.page.audit.kpi.tokensNote')}</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">{audit.totals?.share ?? 0}%</strong>
                    <span className="viz-kpi__label">{t('director.page.audit.kpi.share')}</span>
                    <span className="viz-kpi__note">{t('director.page.audit.kpi.shareNote')}</span>
                  </div>
                  <div className="viz-kpi">
                    <strong className="viz-kpi__value">{audit.pending ?? 0}</strong>
                    <span className="viz-kpi__label">{t('director.page.audit.kpi.ready')}</span>
                    <span className="viz-kpi__note">
                      {t('director.page.audit.kpi.readyNote', {
                        count: audit.totals?.repeated ?? 0,
                      })}
                    </span>
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
                        <summary>
                          {t('director.page.audit.group.projects', {
                            count: audit.projects?.length ?? 0,
                          })}
                        </summary>
                        {(audit.projects ?? []).map((project) => (
                          <p key={project.id} className="director__audit-line">
                            <strong>{project.title}</strong> ·{' '}
                            {project.status === 'done'
                              ? t('director.page.audit.project.done')
                              : t('director.page.audit.project.active')}{' '}
                            ·{' '}
                            {t('director.page.audit.project.meta', {
                              employees: project.employees,
                              accepted: project.accepted,
                            })}
                            {project.unverified > 0
                              ? ` · ${t('director.page.audit.unverified', {
                                  count: project.unverified,
                                })}`
                              : ''}
                            {project.held > 0
                              ? ` · ${t('director.page.audit.project.held', {
                                  count: project.held,
                                })}`
                              : ''}
                            {project.failed > 0
                              ? ` · ${t('director.page.audit.failedCount', {
                                  count: project.failed,
                                })}`
                              : ''}{' '}
                            · {t('director.page.audit.project.time', {
                              time: formatSpan(project.elapsedMs, t),
                            })}
                            {project.estimateMs > 0
                              ? `${t('director.page.audit.project.estimate', {
                                  time: formatSpan(project.estimateMs, t),
                                })}${
                                  project.overMs > 0
                                    ? t('director.page.audit.project.over', {
                                        time: formatSpan(project.overMs, t),
                                      })
                                    : ''
                                }`
                              : t('director.page.audit.project.noEstimate')}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.tasks ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>
                          {t('director.page.audit.group.tasks', {
                            count: audit.tasks?.length ?? 0,
                          })}
                        </summary>
                        {(audit.tasks ?? []).map((task) => (
                          <p key={task.taskId} className="director__audit-line">
                            <strong>{task.title}</strong> ·{' '}
                            {t('director.page.audit.task.meta', {
                              instructions: task.instructions,
                              accepted: task.accepted,
                            })}
                            {task.rework > 0
                              ? ` · ${t('director.page.audit.task.rework', { count: task.rework })}`
                              : ''}
                            {task.unverified > 0
                              ? ` · ${t('director.page.audit.unverified', {
                                  count: task.unverified,
                                })}`
                              : ''}
                            {task.failed > 0
                              ? ` · ${t('director.page.audit.failedCount', {
                                  count: task.failed,
                                })}`
                              : ''}{' '}
                            · {formatSpan(task.runMs, t)}
                            {task.tokens > 0 ? ` · ${formatTokens(task.tokens)} tok` : ''}
                            {task.files > 0
                              ? ` · ${t('director.page.audit.task.files', { count: task.files })}`
                              : ''}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.agents ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>
                          {t('director.page.audit.group.agents', {
                            count: audit.agents?.length ?? 0,
                          })}
                        </summary>
                        {(audit.agents ?? []).map((agent) => (
                          <p key={agent.id || agent.name} className="director__audit-line">
                            <strong>{agent.name}</strong> ·{' '}
                            {t('director.page.audit.agent.meta', {
                              tasks: agent.tasks,
                              instructions: agent.instructions,
                              accepted: agent.accepted,
                            })}
                            {agent.rework > 0
                              ? ` · ${t('director.page.audit.task.rework', {
                                  count: agent.rework,
                                })}`
                              : ''}
                            {agent.unverified > 0
                              ? ` · ${t('director.page.audit.unverified', {
                                  count: agent.unverified,
                                })}`
                              : ''}
                            {agent.failed > 0
                              ? ` · ${t('director.page.audit.failedCount', {
                                  count: agent.failed,
                                })}`
                              : ''}{' '}
                            · {formatSpan(agent.runMs, t)}
                          </p>
                        ))}
                      </details>
                    )}
                    {(audit.tools ?? []).length > 0 && (
                      <details className="director__audit-advice">
                        <summary>
                          {t('director.page.audit.group.tools', {
                            count: audit.tools?.length ?? 0,
                          })}
                        </summary>
                        {(audit.tools ?? []).map((tool) => (
                          <p key={tool.name} className="director__audit-line">
                            <strong>{tool.name}</strong> ·{' '}
                            {t('director.page.audit.tool.meta', {
                              calls: tool.calls,
                              runs: tool.runs,
                              tasks: tool.tasks,
                            })}
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
                            {item.candidate
                              ? t('director.page.audit.item.candidate')
                              : t('director.page.audit.item.watching')}
                          </span>
                          {item.muted && (
                            <span className="director__audit-badge">
                              {t('director.page.audit.item.muted')}
                            </span>
                          )}
                          <span className="director__audit-meta">
                            {t('director.page.audit.item.meta', {
                              count: item.runs,
                              tasks: item.tasks,
                              time: formatSpan(item.reclaimMs, t),
                            })}
                            {item.reclaimTokens > 0
                              ? ` · ${formatTokens(item.reclaimTokens)} tok`
                              : ''}
                          </span>
                        </header>
                        <p className="director__audit-evidence">{item.evidence.join('\n')}</p>
                        {item.adviceBody && (
                          <details className="director__audit-advice">
                            <summary>
                              {t('director.page.audit.item.advice', { time: stamp(item.adviceAt) })}
                            </summary>
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
                    {auditLoading
                      ? t('director.page.audit.writing')
                      : t('director.page.audit.refresh')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--tiny"
                    disabled={auditReviewing || (audit.items ?? []).length === 0}
                    title={
                      (audit.items ?? []).length === 0
                        ? t('director.page.audit.reviewEmptyTitle')
                        : undefined
                    }
                    onClick={() => void auditReview()}
                  >
                    {auditReviewing ? t('director.page.audit.reviewing') : t('director.page.audit.review')}
                  </button>
                  <span
                    className={`director__audit-hint${auditNoteKind ? ` is-${auditNoteKind}` : ''}`}
                    role="status"
                  >
                    {auditNote ||
                      (auditReviewing
                        ? t('director.page.audit.reviewingHint')
                        : t('director.page.audit.footerHint'))}
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
            aria-label={t('director.page.history.title')}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="director__modal-head">
              {view.kind !== 'list' && (
                <button type="button" className="btn btn--tiny" onClick={goBack}>
                  ← {t('director.page.back')}
                </button>
              )}
              <h3>{detailTitle}</h3>
              <span>{detailSubtitle}</span>
              <button type="button" className="btn btn--tiny" onClick={closeRecords}>
                {t('director.common.close')}
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
                      {t(item.labelKey)}
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
                              ? t('director.page.records.deselectAll')
                              : t('director.page.records.selectAll')}
                          </button>
                          <button type="button" className="btn btn--tiny" onClick={cancelSelect}>
                            {t('director.common.cancel')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--tiny director__records-danger"
                            disabled={picked.size === 0 || deleting}
                            onClick={() => setConfirmDeletePicked(true)}
                          >
                            {deleting
                              ? t('director.page.records.deleting')
                              : picked.size
                                ? t('director.page.records.deleteSelectedCount', {
                                    count: picked.size,
                                  })
                                : t('director.page.records.deleteSelected')}
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
                            {t('director.page.records.select')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--tiny"
                            disabled={historyLoading || deduping}
                            onClick={() => setConfirmDedupe(true)}
                          >
                            {deduping
                              ? t('director.page.records.cleaning')
                              : t('director.page.records.cleanDuplicates')}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <p className="director__ledger-note">{t(LIST_NOTE_KEY[listFilter])}</p>
                {recordsNote && (
                  <p className="director__records-note" role="status">
                    {recordsNote}
                  </p>
                )}

                {opening && <p className="director__empty">{t('director.page.records.opening')}</p>}

                {!opening && listFilter === 'archives' && historyLoading && (
                  <p className="director__empty">{t('director.page.records.loading')}</p>
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
                          title={
                            selecting
                              ? isPicked
                                ? t('director.page.records.deselect')
                                : t('director.page.records.selectItem')
                              : entry.title
                          }
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
                          <span className="director__record-tag is-archive">
                            {t('director.page.records.archives')}
                          </span>
                          <span className="director__record-title">{entry.title}</span>
                          <span className="director__record-text">
                            {selecting
                              ? t('director.page.records.rowMeta', {
                                  messages: entry.count,
                                  transactions: transactionCount(entry),
                                })
                              : `${t('director.page.records.rowMeta', {
                                  messages: entry.count,
                                  transactions: transactionCount(entry),
                                })} ›`}
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
                    <p className="director__empty">{t('director.page.records.empty')}</p>
                  )}

                {!opening && listFilter === 'ledger' && ledgerRows.length === 0 && (
                  <p className="director__empty">{t('director.page.records.emptyLedger')}</p>
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
                          {sideLabel(entry.side)} ·{' '}
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
                    {t('director.page.history.chatTab', { count: view.entry.messages.length })}
                  </button>
                  <button
                    type="button"
                    className={`director__records-chip ${view.tab === 'ledger' ? 'is-active' : ''}`}
                    onClick={() => setView({ kind: 'folder', entry: view.entry, tab: 'ledger' })}
                  >
                    {t('director.page.history.ledgerTab', {
                      count: folderTransactions(view.entry).length,
                    })}
                  </button>
                </div>

                {view.tab === 'chat' && (
                  <>
                    <div className="director__history-list">
                      {view.entry.messages.length === 0 && (
                        <p className="director__empty">
                          {t('director.page.history.noMessages')}
                        </p>
                      )}
                      {view.entry.messages.map((message, index) => (
                        <article
                          key={`${message.id ?? 'row'}-${index}`}
                          className={`director__history-msg is-${message.role}`}
                        >
                          <header>
                            <span>
                              {message.director
                                ? t('director.page.history.roleReport')
                                : message.role === 'user'
                                  ? t('director.page.history.roleMe')
                                  : t('director.page.title')}
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
                          {t('director.page.history.rawSession', {
                            count: view.entry.session.length,
                          })}
                        </summary>
                        <pre>{JSON.stringify(view.entry.session, null, 2)}</pre>
                      </details>
                    )}
                  </>
                )}

                {view.tab === 'ledger' && (
                  <div className="director__records-body">
                    {folderTransactions(view.entry).length === 0 ? (
                      <p className="director__empty">{t('director.page.history.noTransactions')}</p>
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
                              {sideLabel(entry.side)} ·{' '}
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
                    <dt>{t('director.page.ledger.time')}</dt>
                    <dd>{fullStamp(view.entry.at, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('director.page.ledger.category')}</dt>
                    <dd>
                      {sideLabel(view.entry.side)} · {view.entry.label || view.entry.kind}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('director.page.ledger.task')}</dt>
                    <dd>{view.entry.title || view.entry.taskId || '—'}</dd>
                  </div>
                  <div className="is-wide">
                    <dt>{t('director.page.ledger.content')}</dt>
                    <dd>{view.entry.text || t('director.page.ledger.noDetail')}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmDedupe && (
        <ConfirmDialog
          title={t('director.page.dedupe.title')}
          message={t('director.page.dedupe.message')}
          confirmLabel={
            deduping
              ? t('director.page.records.cleaningConfirm')
              : t('director.page.records.cleanDuplicates')
          }
          danger
          raised
          busy={deduping}
          onConfirm={() => void dedupeHistory()}
          onCancel={() => setConfirmDedupe(false)}
        />
      )}

      {confirmDeletePicked && (
        <ConfirmDialog
          title={t('director.page.deletePicked.title', { count: picked.size })}
          message={t('director.page.deletePicked.message')}
          confirmLabel={
            deleting ? t('director.page.deletePicked.deleting') : t('director.page.deletePicked.delete')
          }
          danger
          raised
          busy={deleting}
          onConfirm={() => void deletePicked()}
          onCancel={() => setConfirmDeletePicked(false)}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title={t('director.page.clearConfirm.title')}
          message={t('director.page.clearConfirm.message')}
          confirmLabel={
            clearing ? t('director.page.clearConfirm.clearing') : t('director.page.clearConfirm.confirm')
          }
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
  const { t } = useI18n();
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
        aria-label={t('director.page.scopeButton')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="director__modal-head">
          <h3>{t('director.page.scopeButton')}</h3>
          <span>{t('director.page.scope.subtitle')}</span>
          <button type="button" className="btn btn--tiny" onClick={onClose}>
            {t('director.page.scope.done')}
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
              <strong>{t('director.page.scope.unassigned')}</strong>
              <span>{available.length}</span>
            </header>
            <input
              className="input"
              value={queryLeft}
              placeholder={t('director.page.scope.searchAll')}
              onChange={(event) => setQueryLeft(event.target.value)}
            />
            <ul className="director__scope-list">
              {visibleLeft.length === 0 && (
                <li className="director__scope-empty">
                  {available.length === 0
                    ? t('director.page.scope.allAssigned')
                    : t('director.page.scope.noMatch')}
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
                    aria-label={t('director.page.scope.assign', { name: space.name })}
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
              <strong>{t('director.page.scope.assigned')}</strong>
              <span>{mine.length}</span>
            </header>
            <input
              className="input"
              value={queryRight}
              placeholder={t('director.page.scope.searchAssigned')}
              onChange={(event) => setQueryRight(event.target.value)}
            />
            <ul className="director__scope-list">
              {visibleRight.length === 0 && (
                <li className="director__scope-empty">
                  {mine.length === 0
                    ? t('director.page.scope.dragIn')
                    : t('director.page.scope.noMatch')}
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
                    aria-label={t('director.page.scope.remove', { name: space.name })}
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
              {t('director.page.scope.assignPicked', { count: pickedLeft.size })}
            </button>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={pickedRight.size === 0}
              onClick={() => move([...pickedRight], false)}
            >
              {t('director.page.scope.removePicked', { count: pickedRight.size })}
            </button>
          </div>
          <div>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={available.length === 0}
              onClick={() => move(available.map((space) => space.id), true)}
            >
              {t('director.page.scope.assignAll')}
            </button>
            <button
              type="button"
              className="btn btn--tiny"
              disabled={mine.length === 0}
              onClick={() => move(mine.map((space) => space.id), false)}
            >
              {t('director.page.scope.removeAll')}
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
