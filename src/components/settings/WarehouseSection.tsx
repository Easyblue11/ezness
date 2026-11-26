import { useCallback, useEffect, useState } from 'react';
import type { WarehouseSnapshot } from '../../types';
import { useI18n } from '../../i18n';
import { RefreshIcon, WarehouseIcon } from '../Icons';

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function WarehouseSection() {
  const { t } = useI18n();
  const api = window.ezness;
  const [snapshot, setSnapshot] = useState<WarehouseSnapshot | null>(null);

  const refresh = useCallback(async () => {
    const next = await api?.warehouseSnapshot();
    if (next) setSnapshot(next);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.warehouse.title')}</h2>
          <p>{t('settings.warehouse.desc')}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refresh()}>
          <RefreshIcon size={14} />
          {t('system.refresh')}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <WarehouseIcon size={15} />
          {t('settings.warehouse.content.title')}
        </div>
        <p className="kb-card__desc">
          {snapshot
            ? t('settings.warehouse.content.summary', {
                count: snapshot.count,
                size: formatSize(snapshot.totalBytes),
              })
            : t('settings.warehouse.content.reading')}
        </p>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WarehouseIcon size={15} />
          {t('settings.warehouse.relation.title')}
        </div>
        <p className="kb-card__desc">{t('settings.warehouse.relation.desc')}</p>
      </section>
    </div>
  );
}
