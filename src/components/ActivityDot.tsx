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
import { useI18n } from '../i18n';

export type ActivityStatus = 'running' | 'attention' | 'done';

const LABELS: Record<ActivityStatus, string> = {
  running: 'activity.running',
  attention: 'activity.attention',
  done: 'activity.done',
};

export function ActivityDot({ status }: { status: ActivityStatus | null }) {
  const { t } = useI18n();
  const label = status ? t(LABELS[status]) : undefined;
  return (
    <span
      className={`activity-dot${status ? ` is-${status}` : ''}`}
      role={status ? 'img' : undefined}
      aria-label={label}
      aria-hidden={status ? undefined : true}
      title={label}
    />
  );
}
