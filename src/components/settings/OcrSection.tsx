import { useCallback, useEffect, useState } from 'react';
import type { OcrModelStatus, OcrSettings } from '../../types';
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
          <h2>{sub ? 'OCR 识别' : 'OCR 配置'}</h2>
          <p>
            图片和扫描件在本机用 PaddleOCR PP-OCRv5 识别，识别出的文字随消息交给模型，图像本身不会上传。
          </p>
        </div>
        <span className={`pill ${ready ? '' : 'pill--warn'}`}>
          <ScanIcon size={12} /> {ready ? '模型已就绪' : '模型不可用'}
        </span>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <ScanIcon size={15} />
          识别范围
        </div>
        <p className="kb-card__desc">
          识别发生在附件读取阶段：先把文件内容变成文字，再放进这一轮对话。识别结果会记在这条消息上，
          之后的追问仍然能引用。
        </p>

        <div className="ocr-row">
          <div className="ocr-row__text">
            <strong>识别对话里的图片</strong>
            <span>截图、照片、扫描图都可以；纯图片附件不再只存原图。</span>
          </div>
          <Switch
            on={ocr.enabled}
            title={ocr.enabled ? '已开启，图片会先做 OCR' : '已关闭，图片不会识别'}
            onClick={() => onChange({ enabled: !ocr.enabled })}
          />
        </div>

        <div className="ocr-row">
          <div className="ocr-row__text">
            <strong>识别扫描版 PDF</strong>
            <span>PDF 没有文字层（或文字层很少）时，逐页渲染后 OCR，而不是把空附件交给模型。</span>
          </div>
          <Switch
            on={ocr.pdf}
            title={ocr.pdf ? '已开启，扫描件会逐页识别' : '已关闭，扫描件只读取文字层'}
            onClick={() => onChange({ pdf: !ocr.pdf })}
          />
        </div>

        <div className="field ocr-row__field">
          <label className="field__label" htmlFor="ocr-max-pages">
            扫描版 PDF 最多识别页数
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
          <div className="field__hint ocr-row__hint">
            填 -1 表示不限制页数（默认）；填正数时最多 200 页，超出部分会提示未识别
          </div>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">识别模型</div>
        <p className="kb-card__desc">
          PP-OCRv5 mobile（中英混排，检测 + 识别约 21 MB）随应用一起分发，由 onnxruntime-node
          在本机推理，不需要下载，也不依赖 GPU。
        </p>

        <div className="voice-files">
          {status?.files.map((file) => (
            <div key={file.key} className="voice-file">
              <span className={`voice-file__dot ${file.ready ? 'is-ready' : ''}`} />
              <span className="voice-file__label">{file.label}</span>
              <span className="voice-file__meta">
                {file.ready ? `已就绪 · ${formatSize(file.size)}` : '文件缺失或不完整'}
              </span>
            </div>
          ))}
        </div>

        {status && !ready && (
          <div className="notice notice--warn">
            模型文件缺失，OCR 暂时不可用。重新执行 <code>npm install</code> 即可恢复。
          </div>
        )}
      </section>
    </div>
  );
}
