import { useCallback, useEffect, useState } from 'react';
import type { KbConfig, KbConfigPatch, KbSnapshot } from '../../types';
import { useI18n } from '../../i18n';
import { RefreshIcon } from '../Icons';

const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function KbSection() {
  const { t } = useI18n();
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
          <h2>{t('settings.kb.title')}</h2>
        </div>
        <div className="notice">{t('settings.kb.reading')}</div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.kb.title')}</h2>
          <p>{t('settings.kb.desc')}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refresh()}>
          <RefreshIcon size={14} />
          {t('system.refresh')}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.kb.embedding.title')}</div>
        <p className="kb-card__desc">
          {t('settings.kb.embedding.desc')}{' '}
          <code>{config.embedding.model || t('settings.defaults.unselected')}</code>
        </p>
        <div className="kb-card__row">
          <input className="input" readOnly value={config.embedding.baseUrl} />
        </div>
        {!config.embedding.model && (
          <div className="notice notice--warn">{t('settings.kb.embedding.missing')}</div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.kb.chunk.title')}</div>
        <p className="kb-card__desc">{t('settings.kb.chunk.desc')}</p>
        <div className="kb-card__fields">
          <label className="field">
            <span className="field__label">{t('settings.kb.chunk.target')}</span>
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
            <span className="field__label">{t('settings.kb.chunk.overlap')}</span>
            <input
              key={`overlap-${config.chunk.overlap}`}
              className="input"
              type="number"
              defaultValue={config.chunk.overlap}
              onBlur={(event) => void update({ chunk: { overlap: clamp(event.target.valueAsNumber, 0, 400, 80) } })}
            />
          </label>
        </div>
        <div className="kb-card__meta">{t('settings.kb.chunk.note')}</div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.kb.retrieval.title')}</div>
        <p className="kb-card__desc">{t('settings.kb.retrieval.desc')}</p>
        <div className="kb-card__fields">
          <label className="field">
            <span className="field__label">{t('settings.kb.retrieval.topK')}</span>
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
            <span className="field__label">{t('settings.kb.retrieval.candidates')}</span>
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
            <span className="field__label">{t('settings.kb.retrieval.rerank')}</span>
            <select
              className="select"
              value={config.retrieval.rerank}
              onChange={(event) =>
                void update({ retrieval: { rerank: event.target.value as KbConfig['retrieval']['rerank'] } })
              }
            >
              <option value="fast">{t('settings.kb.retrieval.rerank.fast')}</option>
              <option value="llm">{t('settings.kb.retrieval.rerank.llm')}</option>
            </select>
          </label>
        </div>

        {config.retrieval.rerank === 'llm' && (
          <div className="kb-card__fields">
            <label className="field field--wide">
              <span className="field__label">{t('settings.kb.rerank.model')}</span>
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
