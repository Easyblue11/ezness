/**
 * Small status circle shown left of a task or conversation title.
 *
 *   running   正在运行
 *   attention 需要用户选择或确认
 *   done      已经结束，但用户还没点开看
 *
 * Idle rows keep the same slot (just an invisible dot) so titles never shift
 * horizontally when a run starts or ends.
 */
export type ActivityStatus = 'running' | 'attention' | 'done';

const LABELS: Record<ActivityStatus, string> = {
  running: '正在运行',
  attention: '等待你的确认',
  done: '已完成，尚未查看',
};

export function ActivityDot({ status }: { status: ActivityStatus | null }) {
  return (
    <span
      className={`activity-dot${status ? ` is-${status}` : ''}`}
      role={status ? 'img' : undefined}
      aria-label={status ? LABELS[status] : undefined}
      aria-hidden={status ? undefined : true}
      title={status ? LABELS[status] : undefined}
    />
  );
}
