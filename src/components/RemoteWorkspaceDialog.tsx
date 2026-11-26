import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

/**
 * Add a remote workspace over SSH.
 *
 * Step 1 collects the address and one kind of credential (password, or a key
 * file plus its passphrase). Step 2 browses the host and picks the folder that
 * becomes the workspace root. The credentials go straight to the main process:
 * they are encrypted on this machine and are never part of a model request or
 * the saved conversation.
 */

export interface RemoteWorkspaceResult {
  id: string;
  name: string;
  path: string;
  remote: {
    host: string;
    port: number;
    username: string;
    root: string;
    fingerprint?: string;
  };
}

interface Props {
  workspaceId: string;
  onCancel: () => void;
  onCreated: (workspace: RemoteWorkspaceResult) => void;
}

interface Entry {
  name: string;
  path: string;
  hidden?: boolean;
}

export function RemoteWorkspaceDialog({ workspaceId, onCancel, onCreated }: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState<'auth' | 'browse'>('auth');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [sessionId, setSessionId] = useState('');
  const [home, setHome] = useState('');
  const [current, setCurrent] = useState('');
  const [parent, setParent] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [label, setLabel] = useState('');

  const sessionRef = useRef('');

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // Closing the dialog must drop the pending connection.
  useEffect(
    () => () => {
      if (sessionRef.current) {
        void window.ezness?.workspaceRemoteClose?.({ sessionId: sessionRef.current });
      }
    },
    [],
  );

  async function connect() {
    if (busy) return;
    setError('');
    if (!host.trim()) {
      setError(t('workspace.remote.error.host'));
      return;
    }
    if (!username.trim()) {
      setError(t('workspace.remote.error.username'));
      return;
    }
    if (authMode === 'password' && !password) {
      setError(t('workspace.remote.error.password'));
      return;
    }
    if (authMode === 'key' && !keyPath.trim()) {
      setError(t('workspace.remote.error.key'));
      return;
    }

    setBusy(true);
    try {
      const result = await window.ezness?.workspaceRemoteConnect?.({
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        password: authMode === 'password' ? password : '',
        privateKeyPath: authMode === 'key' ? keyPath.trim() : '',
        privateKeyPassphrase: authMode === 'key' ? passphrase : '',
      });
      if (!result?.ok || !result.sessionId) {
        setError(result?.error || t('workspace.remote.error.connect'));
        return;
      }
      // The ref is what browse() checks; the effect that syncs it runs after
      // this render, too late for the first listing.
      sessionRef.current = result.sessionId;
      setSessionId(result.sessionId);
      setHome(result.home ?? '');
      setStep('browse');
      await browse(result.home ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function browse(dir: string) {
    if (!sessionRef.current) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.ezness?.workspaceRemoteList?.({
        sessionId: sessionRef.current,
        path: dir,
      });
      if (!result?.ok) {
        setError(result?.error || t('workspace.remote.error.list'));
        return;
      }
      setCurrent(result.path ?? dir);
      setParent(result.parent ?? '');
      setEntries(result.entries ?? []);
      setLabel(result.label ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function choosePath(path: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.ezness?.workspaceRemoteOpen?.({
        sessionId: sessionRef.current,
        path,
        workspaceId,
      });
      if (!result?.ok || !result.root) {
        setError(result?.error || t('workspace.remote.error.open'));
        return;
      }
      sessionRef.current = '';
      const user = username.trim();
      const portValue = Number(port) || 22;
      onCreated({
        id: workspaceId,
        name: result.name || result.root,
        path: `${user}@${host.trim()}${portValue === 22 ? '' : `:${portValue}`}:${result.root}`,
        remote: {
          host: host.trim(),
          port: portValue,
          username: user,
          root: result.root,
          fingerprint: result.fingerprint,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal__panel remote-dialog" role="dialog" aria-modal="true">
        <h2 className="modal__title">{t('workspace.remote.title')}</h2>

        {step === 'auth' ? (
          <>
            <p className="modal__message">{t('workspace.remote.intro')}</p>
            <div className="remote-dialog__grid">
              <label className="remote-field">
                <span className="remote-field__label">{t('workspace.remote.host')}</span>
                <input
                  className="input"
                  value={host}
                  placeholder={t('workspace.remote.hostPlaceholder')}
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => setHost(event.target.value)}
                />
              </label>
              <label className="remote-field remote-field--port">
                <span className="remote-field__label">{t('workspace.remote.port')}</span>
                <input
                  className="input"
                  value={port}
                  inputMode="numeric"
                  spellCheck={false}
                  onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, ''))}
                />
              </label>
              <label className="remote-field">
                <span className="remote-field__label">{t('workspace.remote.username')}</span>
                <input
                  className="input"
                  value={username}
                  placeholder="root"
                  spellCheck={false}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
            </div>

            <div className="remote-auth">
              <button
                type="button"
                className={`btn ${authMode === 'password' ? 'btn--primary' : ''}`}
                onClick={() => setAuthMode('password')}
              >
                {t('workspace.remote.password')}
              </button>
              <button
                type="button"
                className={`btn ${authMode === 'key' ? 'btn--primary' : ''}`}
                onClick={() => setAuthMode('key')}
              >
                {t('workspace.remote.privateKey')}
              </button>
            </div>

            {authMode === 'password' ? (
              <label className="remote-field">
                <span className="remote-field__label">{t('workspace.remote.loginPassword')}</span>
                <div className="perm__secret-text">
                  <input
                    className="input"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('workspace.remote.localOnly')}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void connect();
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword
                      ? t('workspace.remote.hide')
                      : t('workspace.remote.show')}
                  </button>
                </div>
              </label>
            ) : (
              <>
                <label className="remote-field">
                  <span className="remote-field__label">{t('workspace.remote.keyFile')}</span>
                  <div className="perm__secret-file">
                    <input
                      className="input"
                      value={keyPath}
                      placeholder={t('workspace.remote.keyPlaceholder')}
                      spellCheck={false}
                      onChange={(event) => setKeyPath(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const picked = await window.ezness?.workspacePickKeyFile?.();
                        if (picked) setKeyPath(picked);
                      }}
                    >
                      {t('workspace.remote.chooseFile')}
                    </button>
                  </div>
                </label>
                <label className="remote-field">
                  <span className="remote-field__label">{t('workspace.remote.passphrase')}</span>
                  <input
                    className="input"
                    type="password"
                    value={passphrase}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setPassphrase(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void connect();
                    }}
                  />
                </label>
              </>
            )}

            {error && <div className="notice notice--warn">{error}</div>}
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onCancel}>
                {t('workspace.remote.cancel')}
              </button>
              <button className="btn btn--primary" disabled={busy} onClick={() => void connect()}>
                {busy ? t('workspace.remote.connecting') : t('workspace.remote.connect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal__message">{t('workspace.remote.pickRoot')}</p>
            <div className="remote-path">
              <button
                type="button"
                className="btn remote-path__up"
                disabled={busy || !parent}
                title={t('workspace.remote.up')}
                onClick={() => void browse(parent)}
              >
                ↑ {t('workspace.remote.up')}
              </button>
              <span className="remote-path__value" title={current}>
                {label || current}
              </span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                title={t('workspace.remote.homeTitle')}
                onClick={() => void browse(home)}
              >
                {t('workspace.remote.home')}
              </button>
            </div>

            <div
              className="remote-list"
              role="listbox"
              aria-label={t('workspace.remote.listAria')}
            >
              {busy && entries.length === 0 && (
                <div className="ws-hint">{t('workspace.remote.loading')}</div>
              )}
              {!busy && entries.length === 0 && (
                <div className="ws-hint">{t('workspace.remote.emptyDir')}</div>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={`remote-list__row ${entry.hidden ? 'is-hidden' : ''}`}
                  disabled={busy}
                  onClick={() => void browse(entry.path)}
                  onDoubleClick={() => void choosePath(entry.path)}
                >
                  <span className="remote-list__icon">📁</span>
                  <span className="remote-list__name">{entry.name}</span>
                </button>
              ))}
            </div>

            {error && <div className="notice notice--warn">{error}</div>}
            <div className="modal__actions">
              <button
                className="btn btn--ghost"
                disabled={busy}
                onClick={async () => {
                  if (sessionRef.current) {
                    await window.ezness?.workspaceRemoteClose?.({ sessionId: sessionRef.current });
                    sessionRef.current = '';
                    setSessionId('');
                  }
                  setStep('auth');
                }}
              >
                {t('workspace.remote.otherAddress')}
              </button>
              <button className="btn btn--ghost" disabled={busy} onClick={onCancel}>
                {t('workspace.remote.cancel')}
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || !current}
                onClick={() => void choosePath(current)}
              >
                {t('workspace.remote.useFolder')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
