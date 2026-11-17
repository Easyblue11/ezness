import { useCallback, useEffect, useState } from 'react';
import type { WarehouseSnapshot } from '../../types';
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
          <h2>仓库</h2>
          <p>
            对话里粘贴的图片、文件都保存在这里。只存原文件，不解析、不向量化，和知识仓库互不影响。
            存储位置统一在「设置 → 系统设置」里管理，仓库放在数据目录的 ezstorge 文件夹。
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refresh()}>
          <RefreshIcon size={14} />
          刷新
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <WarehouseIcon size={15} />
          仓库内容
        </div>
        <p className="kb-card__desc">
          {snapshot
            ? `当前保存了 ${snapshot.count} 个文件，共 ${formatSize(snapshot.totalBytes)}。`
            : '正在读取仓库…'}
        </p>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WarehouseIcon size={15} />
          和知识仓库的关系
        </div>
        <p className="kb-card__desc">
          仓库和知识仓库是两套独立的目录与索引：仓库里的文件不会进入向量检索，知识仓库里的解析、切片、
          Embedding 也不会改动仓库里的原件。以后给仓库加处理能力时，也会使用单独的索引。
        </p>
      </section>
    </div>
  );
}
