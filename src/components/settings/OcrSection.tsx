import { useCallback, useEffect, useState } from 'react';
import type { OcrModelStatus, OcrSettings } from '../../types';
import { useI18n } from '../../i18n';
import { ScanIcon } from '../Icons';

interface Props {
  ocr: OcrSettings;
  onChange: (patch: Partial<OcrSettings>) => void;
  /** 嵌在「默认模型」里：降一级标题，和上面的模型卡片区分开。 */
  sub?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function Switch({
  on,
  title,
  onClick,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`switch ${on ? 'is-on' : ''}`}
      role="switch"
      aria-checked={on}
      title={title}
      onClick={onClick}
    >
      <span />
    </button>
  );
}

export function OcrSection({ ocr, onChange, sub = false }: Props) {
  const { t } = useI18n();
  const api = window.ezness;
  const [status, setStatus] = useState<OcrModelStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    const next = await api?.ocrStatus?.();
    if (next) setStatus(next);
  }, [api]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const ready = status?.ready ?? false;

  return (
    <div className={`section ${sub ? 'section--sub' : ''}`}>
      <div className="section__head">
        <div>
          <h2>{sub ? t('settings.ocr.title.sub') : t('settings.ocr.title')}</h2>
          <p>{t('settings.ocr.desc')}</p>
        </div>
        <span className={`pill ${ready ? '' : 'pill--warn'}`}>
          <ScanIcon size={12} />{' '}
          {ready ? t('settings.ocr.status.ready') : t('settings.ocr.status.missing')}
        </span>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <ScanIcon size={15} />
          {t('settings.ocr.scope.title')}
        </div>
        <p className="kb-card__desc">{t('settings.ocr.scope.desc')}</p>

        <div className="ocr-row">
          <div className="ocr-row__text">
            <strong>{t('settings.ocr.images.title')}</strong>
            <span>{t('settings.ocr.images.desc')}</span>
          </div>
          <Switch
            on={ocr.enabled}
            title={
              ocr.enabled ? t('settings.ocr.images.on') : t('settings.ocr.images.off')
            }
            onClick={() => onChange({ enabled: !ocr.enabled })}
          />
        </div>

        <div className="ocr-row">
          <div className="ocr-row__text">
            <strong>{t('settings.ocr.pdf.title')}</strong>
            <span>{t('settings.ocr.pdf.desc')}</span>
          </div>
          <Switch
            on={ocr.pdf}
            title={ocr.pdf ? t('settings.ocr.pdf.on') : t('settings.ocr.pdf.off')}
            onClick={() => onChange({ pdf: !ocr.pdf })}
          />
        </div>

        <div className="field ocr-row__field">
          <label className="field__label" htmlFor="ocr-max-pages">
            {t('settings.ocr.maxPages.label')}
          </label>
          <input
            id="ocr-max-pages"
            className="input"
            type="number"
            min={-1}
            max={200}
            value={ocr.maxPages}
            disabled={!ocr.pdf}
            onChange={(event) => {
              const value = Math.round(Number(event.target.value));
              onChange({
                maxPages: Number.isFinite(value) ? Math.max(-1, Math.min(200, value)) : -1,
              });
            }}
          />
          <div className="field__hint ocr-row__hint">{t('settings.ocr.maxPages.hint')}</div>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.ocr.model.title')}</div>
        <p className="kb-card__desc">{t('settings.ocr.model.desc')}</p>

        <div className="voice-files">
          {status?.files.map((file) => (
            <div key={file.key} className="voice-file">
              <span className={`voice-file__dot ${file.ready ? 'is-ready' : ''}`} />
              <span className="voice-file__label">{file.label}</span>
              <span className="voice-file__meta">
                {file.ready
                  ? t('settings.ocr.file.ready', { size: formatSize(file.size) })
                  : t('settings.ocr.file.missing')}
              </span>
            </div>
          ))}
        </div>

        {status && !ready && (
          <div className="notice notice--warn">
            {t('settings.ocr.missingBefore')} <code>npm install</code>{' '}
            {t('settings.ocr.missingAfter')}
          </div>
        )}
      </section>
    </div>
  );
}
