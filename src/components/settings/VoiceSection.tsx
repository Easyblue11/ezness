import { useCallback, useEffect, useState } from 'react';
import type { VoiceEvent, VoiceModelStatus, VoiceSettings } from '../../types';
import { useI18n } from '../../i18n';
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
  const { t } = useI18n();
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
      setDeviceError(t('settings.voice.device.unsupported'));
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
          t('settings.voice.device.permissionFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
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
          label: device.label || t('settings.voice.device.input', { count: index + 1 }),
        }));
      setDevices(inputs);
      // Chromium hides labels until the origin has microphone permission.
      setNeedsPermission(
        list.some((device) => device.kind === 'audioinput' && !device.label) || inputs.length === 0,
      );
    } catch (error) {
      setDeviceError(
        t('settings.voice.device.readFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [t]);

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
    if (!result.ok) setDownloadError(result.error ?? t('settings.voice.download.failed'));
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
          <h2>{t('settings.voice.title')}</h2>
          <p>{t('settings.voice.desc')}</p>
        </div>
        <button
          className="btn btn--ghost"
          disabled={asking}
          onClick={() => void refreshDevices(true)}
        >
          <MicIcon size={14} />
          {asking ? t('settings.voice.waiting') : t('settings.voice.authorize')}
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <MicIcon size={15} />
          {t('settings.voice.device.title')}
        </div>
        <p className="kb-card__desc">{t('settings.voice.device.desc')}</p>
        <div className="kb-card__row">
          <select
            className="select"
            value={voice.inputDeviceId}
            onChange={(event) => onChange({ inputDeviceId: event.target.value })}
          >
            <option value="">{t('settings.voice.device.systemDefault')}</option>
            {savedMissing && (
              <option value={voice.inputDeviceId}>
                {t('settings.voice.device.savedMissing')}
              </option>
            )}
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void refreshDevices(false)}>
            <RefreshIcon size={14} />
            {t('system.refresh')}
          </button>
        </div>
        {needsPermission && (
          <div className="notice notice--warn">{t('settings.voice.permissionNotice')}</div>
        )}
        {deviceError && <div className="notice notice--warn">{deviceError}</div>}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.voice.model.title')}</div>
        <p className="kb-card__desc">{t('settings.voice.model.desc')}</p>

        <div className="voice-files">
          {(status?.files ?? []).map((file) => (
            <div key={file.key} className="voice-file">
              <span className={`voice-file__dot ${file.ready ? 'is-ready' : ''}`} />
              <span className="voice-file__label">{file.label}</span>
              <span className="voice-file__meta">
                {file.ready
                  ? t('settings.voice.file.ready', { size: formatSize(file.size) })
                  : file.size > 0
                    ? t('settings.voice.file.incomplete', { size: formatSize(file.size) })
                    : t('settings.voice.file.missing')}
              </span>
            </div>
          ))}
        </div>

        {status && (
          <div className="kb-card__meta">{t('settings.voice.modelDir', { dir: status.dir })}</div>
        )}

        {progress && (
          <div className="voice-progress">
            <div className="voice-progress__bar">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="voice-progress__meta">
              {t('settings.voice.progress', {
                label: progress.label,
                percent,
                received: formatSize(progress.received),
                total: formatSize(progress.total),
              })}
            </div>
          </div>
        )}

        {downloadError && <div className="notice notice--warn">{downloadError}</div>}

        <div className="kb-card__row">
          <button className="btn btn--primary" disabled={downloading} onClick={() => void download()}>
            {downloading
              ? t('settings.voice.downloading')
              : ready
                ? t('settings.voice.complete')
                : t('settings.voice.download')}
          </button>
          {downloading && (
            <button className="btn" onClick={() => void api?.voiceCancelDownload()}>
              {t('settings.voice.cancel')}
            </button>
          )}
          {ready && !downloading && (
            <span className="kb-card__meta">{t('settings.voice.ready')}</span>
          )}
        </div>
      </section>
    </div>
  );
}
