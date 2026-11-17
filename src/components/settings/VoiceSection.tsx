import { useCallback, useEffect, useState } from 'react';
import type { VoiceEvent, VoiceModelStatus, VoiceSettings } from '../../types';
import { MicIcon, RefreshIcon } from '../Icons';

interface Props {
  voice: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
}

interface InputDevice {
  deviceId: string;
  label: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function VoiceSection({ voice, onChange }: Props) {
  const api = window.ezness;
  const [status, setStatus] = useState<VoiceModelStatus | null>(null);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [asking, setAsking] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ label: string; received: number; total: number } | null>(
    null,
  );

  const refreshStatus = useCallback(async () => {
    const next = await api?.voiceStatus();
    if (next) setStatus(next);
  }, [api]);

  const refreshDevices = useCallback(async (ask: boolean) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceError('当前环境不支持枚举音频设备。');
      return;
    }

    setDeviceError(null);
    if (ask) {
      setAsking(true);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        setDeviceError(
          `麦克风授权失败：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setAsking(false);
      }
    }

    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `输入设备 ${index + 1}`,
        }));
      setDevices(inputs);
      // Chromium hides labels until the origin has microphone permission.
      setNeedsPermission(
        list.some((device) => device.kind === 'audioinput' && !device.label) || inputs.length === 0,
      );
    } catch (error) {
      setDeviceError(
        `读取音频设备失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshDevices(false);
  }, [refreshStatus, refreshDevices]);

  useEffect(() => {
    const unsubscribe = api?.onVoiceEvent?.((event: VoiceEvent) => {
      if (event.type !== 'download') return;
      if (event.done) {
        setProgress(null);
        void refreshStatus();
        return;
      }
      if (event.total) {
        setProgress({
          label: event.label ?? '',
          received: event.received ?? 0,
          total: event.total,
        });
      }
    });
    return () => unsubscribe?.();
  }, [api, refreshStatus]);

  async function download() {
    if (!api) return;
    setDownloadError(null);
    setProgress(null);
    setDownloading(true);
    const result = await api.voiceDownload();
    setDownloading(false);
    if (result.status) setStatus(result.status);
    if (!result.ok) setDownloadError(result.error ?? '下载失败');
  }

  const percent = progress
    ? Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
    : 0;
  const ready = status?.ready ?? false;
  const savedMissing =
    voice.inputDeviceId !== '' && !devices.some((device) => device.deviceId === voice.inputDeviceId);

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>语音配置</h2>
          <p>语音识别完全在本机运行：Silero VAD 负责断句，SenseVoiceSmall 负责转写，音频不会上传。</p>
        </div>
        <button
          className="btn btn--ghost"
          disabled={asking}
          onClick={() => void refreshDevices(true)}
        >
          <MicIcon size={14} />
          {asking ? '等待授权…' : '授权麦克风'}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <MicIcon size={15} />
          麦克风 / 声卡
        </div>
        <p className="kb-card__desc">
          选择语音输入使用的录音设备。系统会以 16 kHz 单声道采集，修改后下一条语音生效。
        </p>
        <div className="kb-card__row">
          <select
            className="select"
            value={voice.inputDeviceId}
            onChange={(event) => onChange({ inputDeviceId: event.target.value })}
          >
            <option value="">系统默认输入设备</option>
            {savedMissing && (
              <option value={voice.inputDeviceId}>已保存的设备（当前不可用）</option>
            )}
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void refreshDevices(false)}>
            <RefreshIcon size={14} />
            刷新
          </button>
        </div>
        {needsPermission && (
          <div className="notice notice--warn">
            还没有拿到麦克风权限，系统只显示占位名称。点右上角「授权麦克风」后再刷新。
          </div>
        )}
        {deviceError && <div className="notice notice--warn">{deviceError}</div>}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">识别模型</div>
        <p className="kb-card__desc">
          Silero VAD（2.3 MB）+ SenseVoiceSmall INT8 ONNX（约 228 MB），由 sherpa-onnx
          在本机推理，支持中、英、日、韩、粤语。
        </p>

        <div className="voice-files">
          {(status?.files ?? []).map((file) => (
            <div key={file.key} className="voice-file">
              <span className={`voice-file__dot ${file.ready ? 'is-ready' : ''}`} />
              <span className="voice-file__label">{file.label}</span>
              <span className="voice-file__meta">
                {file.ready
                  ? `已就绪 · ${formatSize(file.size)}`
                  : file.size > 0
                    ? `文件不完整 · ${formatSize(file.size)}`
                    : '未下载'}
              </span>
            </div>
          ))}
        </div>

        {status && <div className="kb-card__meta">模型目录：{status.dir}</div>}

        {progress && (
          <div className="voice-progress">
            <div className="voice-progress__bar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="voice-progress__meta">
              正在下载 {progress.label} · {percent}%（{formatSize(progress.received)} /{' '}
              {formatSize(progress.total)}）
            </div>
          </div>
        )}

        {downloadError && <div className="notice notice--warn">{downloadError}</div>}

        <div className="kb-card__row">
          <button className="btn btn--primary" disabled={downloading} onClick={() => void download()}>
            {downloading ? '正在下载…' : ready ? '检查并补全模型' : '下载语音模型（约 230 MB）'}
          </button>
          {downloading && (
            <button className="btn" onClick={() => void api?.voiceCancelDownload()}>
              取消
            </button>
          )}
          {ready && !downloading && <span className="kb-card__meta">语音输入已可用。</span>}
        </div>
      </section>
    </div>
  );
}
