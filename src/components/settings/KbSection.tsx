import { useCallback, useEffect, useState } from 'react';
import type { KbConfig, KbConfigPatch, KbSnapshot } from '../../types';
import { RefreshIcon } from '../Icons';

const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function KbSection() {
  const api = window.ezness;
  const [snapshot, setSnapshot] = useState<KbSnapshot | null>(null);

  const refresh = useCallback(async () => {
    const next = await api?.kbSnapshot();
    if (next) setSnapshot(next);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function update(patch: KbConfigPatch) {
    const next = await api?.kbSetConfig(patch);
    if (next) setSnapshot(next);
  }

  const config = snapshot?.config;

  if (!config) {
    return (
      <div className="section">
        <div className="section__head">
          <h2>知识仓库</h2>
        </div>
        <div className="notice">正在读取知识仓库配置…</div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>知识仓库</h2>
          <p>
            切片和混合检索参数，改完立即生效。存储位置统一在「设置 → 系统设置」里管理，
            知识仓库放在数据目录的 ezrag 文件夹。
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refresh()}>
          <RefreshIcon size={14} />
          刷新
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">向量模型</div>
        <p className="kb-card__desc">
          取自「设置 → 默认模型 → Embedding 模型」。当前使用：<code>{config.embedding.model || '未选择'}</code>
        </p>
        <div className="kb-card__row">
          <input className="input" readOnly value={config.embedding.baseUrl} />
        </div>
        {!config.embedding.model && (
          <div className="notice notice--warn">还没有选 Embedding 模型，上传的文件会解析成功但无法向量检索。</div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">切片</div>
        <p className="kb-card__desc">按段落和标题切分，单块接近目标长度时断开，块之间保留少量重叠。</p>
        <div className="kb-card__fields">
          <label className="field">
            <span className="field__label">目标长度（字）</span>
            <input
              key={`target-${config.chunk.target}`}
              className="input"
              type="number"
              defaultValue={config.chunk.target}
              onBlur={(event) =>
                void update({ chunk: { target: clamp(event.target.valueAsNumber, 200, 2000, 600) } })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">重叠（字）</span>
            <input
              key={`overlap-${config.chunk.overlap}`}
              className="input"
              type="number"
              defaultValue={config.chunk.overlap}
              onBlur={(event) => void update({ chunk: { overlap: clamp(event.target.valueAsNumber, 0, 400, 80) } })}
            />
          </label>
        </div>
        <div className="kb-card__meta">修改切片参数后，已入库的文件不会自动重切。</div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">检索</div>
        <p className="kb-card__desc">
          BM25 关键词与向量召回各取候选，用 RRF 融合后再重排。默认的「快速重排」在本地计算，不占模型。
        </p>
        <div className="kb-card__fields">
          <label className="field">
            <span className="field__label">返回条数</span>
            <input
              key={`topk-${config.retrieval.topK}`}
              className="input"
              type="number"
              defaultValue={config.retrieval.topK}
              onBlur={(event) =>
                void update({ retrieval: { topK: clamp(event.target.valueAsNumber, 1, 30, 6) } })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">候选数</span>
            <input
              key={`cand-${config.retrieval.candidates}`}
              className="input"
              type="number"
              defaultValue={config.retrieval.candidates}
              onBlur={(event) =>
                void update({ retrieval: { candidates: clamp(event.target.valueAsNumber, 10, 200, 40) } })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">重排方式</span>
            <select
              className="select"
              value={config.retrieval.rerank}
              onChange={(event) =>
                void update({ retrieval: { rerank: event.target.value as KbConfig['retrieval']['rerank'] } })
              }
            >
              <option value="fast">快速重排（本地，零开销）</option>
              <option value="llm">模型重排（本地 LLM，更准更慢）</option>
            </select>
          </label>
        </div>

        {config.retrieval.rerank === 'llm' && (
          <div className="kb-card__fields">
            <label className="field field--wide">
              <span className="field__label">重排模型（Ollama 模型名）</span>
              <input
                key={`rerank-${config.rerank.model}`}
                className="input"
                defaultValue={config.rerank.model}
                placeholder="qwen3:4b"
                onBlur={(event) => void update({ rerank: { model: event.target.value.trim() } })}
              />
            </label>
          </div>
        )}
      </section>
    </div>
  );
}
