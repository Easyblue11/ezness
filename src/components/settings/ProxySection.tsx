import { useEffect, useState } from 'react';
import {
  PROXY_MODES,
  PROXY_SCHEMES,
  proxyProblem,
  proxyRuleId,
} from '../../data/proxy';
import { useI18n } from '../../i18n';
import type {
  ProxyRule,
  ProxyServerSettings,
  ProxySettings,
  ProxyStatus,
  ProxyTestResult,
} from '../../types';
import { EyeIcon, EyeOffIcon, PlusIcon, ProxyIcon, TrashIcon } from '../Icons';

interface Props {
  proxy: ProxySettings;
  onChange: (proxy: ProxySettings) => void;
}

const STATUS_KEY: Record<ProxyStatus['mode'], string> = {
  direct: 'settings.proxy.mode.direct',
  system: 'settings.proxy.mode.system',
  fixed: 'settings.proxy.mode.fixed',
  auto: 'settings.proxy.mode.auto',
};

export function ProxySection({ proxy, onChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  useEffect(() => {
    let alive = true;
    window.ezness
      ?.proxyStatus?.()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const server = proxy.server;
  const usesServer = proxy.mode === 'fixed' || proxy.mode === 'auto';

  function patch(patchValue: Partial<ProxySettings>) {
    onChange({ ...proxy, ...patchValue });
  }

  function patchServer(patchValue: Partial<ProxyServerSettings>) {
    onChange({ ...proxy, server: { ...server, ...patchValue } });
  }

  function patchRule(id: string, patchValue: Partial<ProxyRule>) {
    onChange({
      ...proxy,
      rules: proxy.rules.map((rule) => (rule.id === id ? { ...rule, ...patchValue } : rule)),
    });
  }

  function moveRule(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= proxy.rules.length) return;
    const rules = [...proxy.rules];
    const [item] = rules.splice(index, 1);
    rules.splice(target, 0, item);
    onChange({ ...proxy, rules });
  }

  function removeRule(id: string) {
    onChange({ ...proxy, rules: proxy.rules.filter((rule) => rule.id !== id) });
  }

  function addRule() {
    onChange({
      ...proxy,
      rules: [...proxy.rules, { id: proxyRuleId(), pattern: '', action: 'proxy' }],
    });
  }

  async function chooseKey() {
    const file = await window.ezness?.workspacePickKeyFile?.();
    if (file) patchServer({ privateKeyPath: file });
  }

  async function apply() {
    const problem = proxyProblem(proxy);
    if (problem) {
      setMessage({ kind: 'error', text: t(problem.key, problem.vars) });
      return;
    }
    const api = window.ezness;
    if (!api?.proxyApply) {
      setMessage({ kind: 'error', text: t('settings.proxy.error.unsupported') });
      return;
    }
    setApplying(true);
    setMessage(null);
    setTestResult(null);
    try {
      const next = await api.proxyApply(proxy);
      setStatus(next);
      setMessage(
        next.ok
          ? {
              kind: 'ok',
              text: next.tunnelPort
                ? t('settings.proxy.appliedTunnel', { port: next.tunnelPort })
                : t('settings.proxy.applied'),
            }
          : { kind: 'error', text: next.error ?? t('settings.proxy.error.apply') },
      );
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplying(false);
    }
  }

  /** The capsule applies immediately, without waiting for the 应用代理 button. */
  async function toggleEnabled() {
    const api = window.ezness;
    if (!api?.proxyApply) {
      setMessage({ kind: 'error', text: t('settings.proxy.error.unsupported') });
      return;
    }
    const next = { ...proxy, enabled: !proxy.enabled };
    setToggling(true);
    setMessage(null);
    setTestResult(null);
    try {
      const nextStatus = await api.proxyApply(next);
      setStatus(nextStatus);
      if (nextStatus.ok) {
        onChange(next);
        setMessage({
          kind: 'ok',
          text: next.enabled ? t('settings.proxy.enabled') : t('settings.proxy.disabled'),
        });
      } else {
        setMessage({ kind: 'error', text: nextStatus.error ?? t('settings.proxy.error.toggle') });
      }
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setToggling(false);
    }
  }

  async function testProxy() {
    const api = window.ezness;
    if (!api?.proxyTest) {
      setMessage({ kind: 'error', text: t('settings.proxy.error.testUnsupported') });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.proxyTest());
    } catch (error) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        detail: t('settings.proxy.error.connect'),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }

  const statusLabel = status
    ? !status.enabled
      ? t('settings.proxy.state.off')
      : status.ok
        ? status.applied
          ? t('settings.proxy.state.applied', { detail: status.detail })
          : status.error
            ? t('settings.proxy.state.inactive')
            : t('settings.proxy.state.notApplied')
        : t('settings.proxy.state.inactive')
    : t('settings.proxy.state.reading');

  // The switch is the master toggle; the mode still decides what "on" means.
  const capsuleLabel = !proxy.enabled
    ? t('settings.proxy.capsule.off')
    : proxy.mode === 'direct'
      ? t('settings.proxy.capsule.direct')
      : proxy.mode === 'system'
        ? t('settings.proxy.capsule.system')
        : t('settings.proxy.capsule.on');

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.proxy.title')}</h2>
          <p>{t('settings.proxy.desc')}</p>
        </div>
        <span className={`pill proxy-status ${status?.error ? 'is-bad' : ''}`}>
          <ProxyIcon size={12} />
          {statusLabel}
        </span>
      </div>

      <div className="proxy-toolbar">
        <button
          type="button"
          role="switch"
          aria-checked={proxy.enabled}
          aria-label={
            proxy.enabled ? t('settings.proxy.aria.disable') : t('settings.proxy.aria.enable')
          }
          className={`proxy-switch ${proxy.enabled ? 'is-on' : ''}`}
          disabled={toggling || applying}
          onClick={() => void toggleEnabled()}
        >
          <span className="proxy-switch__track" aria-hidden="true">
            <span className="proxy-switch__thumb" />
          </span>
          <strong>{capsuleLabel}</strong>
        </button>
        <button
          type="button"
          className="btn proxy-test-btn"
          disabled={testing || toggling}
          onClick={() => void testProxy()}
        >
          {testing ? t('settings.proxy.testing') : t('settings.proxy.test')}
        </button>
        {testResult && (
          <span className={`proxy-test ${testResult.ok ? 'is-ok' : 'is-bad'}`}>
            {testResult.ok
              ? t('settings.proxy.test.ok', { ms: testResult.latencyMs })
              : testResult.error
                ? t('settings.proxy.test.failDetail', { error: testResult.error })
                : t('settings.proxy.test.fail')}
          </span>
        )}
      </div>
      <p className="proxy-hint proxy-hint--toolbar">{t('settings.proxy.hint.toolbar')}</p>

      <section className="kb-card">
        <div className="kb-card__title">
          <ProxyIcon size={15} />
          {t('settings.proxy.modes.title')}
        </div>
        <p className="kb-card__desc">{t('settings.proxy.modes.desc')}</p>
        <div className="proxy-modes">
          {PROXY_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={`proxy-mode ${proxy.mode === item.mode ? 'is-active' : ''}`}
              onClick={() => patch({ mode: item.mode })}
            >
              <strong>{t(item.label)}</strong>
              <span>{t(item.desc)}</span>
            </button>
          ))}
        </div>
      </section>

      {usesServer && (
        <section className="kb-card">
          <div className="kb-card__title">{t('settings.proxy.server.title')}</div>
          <p className="kb-card__desc">
            {proxy.mode === 'auto'
              ? t('settings.proxy.server.desc.auto')
              : t('settings.proxy.server.desc.fixed')}
          </p>

          <div className="proxy-schemes">
            {PROXY_SCHEMES.map((item) => (
              <button
                key={item.scheme}
                type="button"
                className={`proxy-scheme ${server.scheme === item.scheme ? 'is-active' : ''}`}
                title={t(item.desc)}
                onClick={() => patchServer({ scheme: item.scheme })}
              >
                {t(item.label)}
              </button>
            ))}
          </div>

          <div className="field-grid">
            <label className="field">
              <span className="field__label">{t('settings.proxy.field.host')}</span>
              <input
                className="input"
                value={server.host}
                placeholder={server.scheme === 'ssh' ? 'ssh.example.com' : '127.0.0.1'}
                spellCheck={false}
                onChange={(event) => patchServer({ host: event.target.value.trim() })}
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('settings.proxy.field.port')}
                <span className="field__hint">
                  {server.scheme === 'ssh'
                    ? t('settings.proxy.field.portHint.ssh')
                    : t('settings.proxy.field.portHint.local')}
                </span>
              </span>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={server.port}
                onChange={(event) =>
                  patchServer({ port: Math.trunc(Number(event.target.value)) || 0 })
                }
              />
            </label>
          </div>

          {(server.scheme === 'http' || server.scheme === 'https') && (
            <>
              <div className="field-grid">
                <label className="field">
                  <span className="field__label">
                    {t('settings.proxy.field.username')}
                    <span className="field__hint">{t('settings.proxy.field.optional')}</span>
                  </span>
                  <input
                    className="input"
                    value={server.username}
                    placeholder={t('settings.proxy.field.usernamePlaceholder')}
                    autoComplete="off"
                    onChange={(event) => patchServer({ username: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field__label">
                    {t('settings.proxy.field.password')}
                    <span className="field__hint">{t('settings.proxy.field.optional')}</span>
                  </span>
                  <div className="input-row">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={server.password}
                      placeholder={t('settings.proxy.field.passwordPlaceholder')}
                      autoComplete="new-password"
                      onChange={(event) => patchServer({ password: event.target.value })}
                    />
                    <button
                      type="button"
                      className="iconbtn iconbtn--bordered"
                      title={
                        showPassword
                          ? t('settings.proxy.hidePassword')
                          : t('settings.proxy.showPassword')
                      }
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                </label>
              </div>
              <p className="proxy-hint">
                {server.scheme === 'https'
                  ? t('settings.proxy.hint.https')
                  : t('settings.proxy.hint.credentials')}
              </p>
            </>
          )}

          {server.scheme === 'socks5' && (
            <p className="proxy-hint">{t('settings.proxy.hint.socks5')}</p>
          )}

          {server.scheme === 'ssh' && (
            <>
              <div className="field-grid">
                <label className="field">
                  <span className="field__label">{t('settings.proxy.ssh.username')}</span>
                  <input
                    className="input"
                    value={server.username}
                    placeholder="root"
                    autoComplete="off"
                    onChange={(event) => patchServer({ username: event.target.value.trim() })}
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t('settings.proxy.ssh.auth')}</span>
                  <div className="proxy-segment">
                    <button
                      type="button"
                      className={server.sshAuth === 'password' ? 'is-active' : ''}
                      onClick={() => patchServer({ sshAuth: 'password' })}
                    >
                      {t('settings.proxy.ssh.auth.password')}
                    </button>
                    <button
                      type="button"
                      className={server.sshAuth === 'key' ? 'is-active' : ''}
                      onClick={() => patchServer({ sshAuth: 'key' })}
                    >
                      {t('settings.proxy.ssh.auth.key')}
                    </button>
                  </div>
                </label>
              </div>

              {server.sshAuth === 'password' ? (
                <label className="field">
                  <span className="field__label">{t('settings.proxy.ssh.password')}</span>
                  <div className="input-row">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={server.password}
                      placeholder={t('settings.proxy.ssh.passwordPlaceholder')}
                      autoComplete="new-password"
                      onChange={(event) => patchServer({ password: event.target.value })}
                    />
                    <button
                      type="button"
                      className="iconbtn iconbtn--bordered"
                      title={
                        showPassword
                          ? t('settings.proxy.hidePassword')
                          : t('settings.proxy.showPassword')
                      }
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                </label>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">{t('settings.proxy.ssh.keyFile')}</span>
                    <div className="input-row">
                      <input
                        className="input"
                        value={server.privateKeyPath}
                        placeholder={t('settings.proxy.ssh.keyPlaceholder')}
                        spellCheck={false}
                        onChange={(event) => patchServer({ privateKeyPath: event.target.value })}
                      />
                      <button type="button" className="btn" onClick={() => void chooseKey()}>
                        {t('settings.proxy.browse')}
                      </button>
                    </div>
                  </label>
                  <label className="field">
                    <span className="field__label">
                      {t('settings.proxy.ssh.passphrase')}
                      <span className="field__hint">
                        {t('settings.proxy.ssh.passphraseHint')}
                      </span>
                    </span>
                    <div className="input-row">
                      <input
                        className="input"
                        type={showPassphrase ? 'text' : 'password'}
                        value={server.privateKeyPassphrase}
                        placeholder={t('settings.proxy.ssh.passphrasePlaceholder')}
                        autoComplete="new-password"
                        onChange={(event) =>
                          patchServer({ privateKeyPassphrase: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="iconbtn iconbtn--bordered"
                        title={
                          showPassphrase
                            ? t('settings.proxy.hidePassphrase')
                            : t('settings.proxy.showPassphrase')
                        }
                        onClick={() => setShowPassphrase((value) => !value)}
                      >
                        {showPassphrase ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                      </button>
                    </div>
                  </label>
                </>
              )}

              <label className="field">
                <span className="field__label">
                  {t('settings.proxy.ssh.fingerprint')}
                  <span className="field__hint">{t('settings.proxy.ssh.fingerprintHint')}</span>
                </span>
                <input
                  className="input"
                  value={server.fingerprint}
                  placeholder="SHA256:..."
                  spellCheck={false}
                  onChange={(event) => patchServer({ fingerprint: event.target.value.trim() })}
                />
              </label>
              <p className="proxy-hint">{t('settings.proxy.ssh.hint')}</p>
            </>
          )}
        </section>
      )}

      {proxy.mode === 'auto' && (
        <section className="kb-card">
          <div className="kb-card__title">{t('settings.proxy.rules.title')}</div>
          <p className="kb-card__desc">
            {t('settings.proxy.rules.desc1')} <code>*.openai.com</code>{' '}
            {t('settings.proxy.rules.desc2')} <code>openai.com</code>{' '}
            {t('settings.proxy.rules.desc3')}
          </p>

          <div className="proxy-default">
            <span>{t('settings.proxy.rules.defaultLabel')}</span>
            <select
              className="select"
              value={proxy.autoDefault}
              onChange={(event) =>
                patch({ autoDefault: event.target.value === 'direct' ? 'direct' : 'proxy' })
              }
            >
              <option value="proxy">{t('settings.proxy.action.proxy')}</option>
              <option value="direct">{t('settings.proxy.action.direct')}</option>
            </select>
          </div>

          <div className="proxy-rules">
            {proxy.rules.map((rule, index) => (
              <div key={rule.id} className="proxy-rule">
                <input
                  className="input"
                  value={rule.pattern}
                  placeholder="*.example.com"
                  spellCheck={false}
                  onChange={(event) => patchRule(rule.id, { pattern: event.target.value.trim() })}
                />
                <select
                  className="select"
                  value={rule.action}
                  onChange={(event) =>
                    patchRule(rule.id, {
                      action: event.target.value === 'direct' ? 'direct' : 'proxy',
                    })
                  }
                >
                  <option value="proxy">{t('settings.proxy.action.proxy')}</option>
                  <option value="direct">{t('settings.proxy.action.direct')}</option>
                </select>
                <button
                  type="button"
                  className="iconbtn"
                  title={t('settings.proxy.rules.moveUp')}
                  disabled={index === 0}
                  onClick={() => moveRule(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  title={t('settings.proxy.rules.moveDown')}
                  disabled={index === proxy.rules.length - 1}
                  onClick={() => moveRule(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  title={t('settings.proxy.rules.remove')}
                  onClick={() => removeRule(rule.id)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>

          {proxy.rules.length === 0 && (
            <div className="proxy-hint">{t('settings.proxy.rules.empty')}</div>
          )}

          <div className="kb-card__row">
            <button type="button" className="btn" onClick={addRule}>
              <PlusIcon size={14} />
              {t('settings.proxy.rules.add')}
            </button>
          </div>
        </section>
      )}

      {usesServer && (
        <section className="kb-card">
          <div className="kb-card__title">{t('settings.proxy.bypass.title')}</div>
          <p className="kb-card__desc">
            {t('settings.proxy.bypass.desc.before')} <code>&lt;local&gt;</code>
            {t('settings.proxy.bypass.desc.after')}
          </p>
          <textarea
            className="textarea"
            rows={3}
            value={proxy.bypass}
            spellCheck={false}
            placeholder={'localhost\n127.0.0.1\n::1\n*.corp.local'}
            onChange={(event) => patch({ bypass: event.target.value })}
          />
        </section>
      )}

      <section className="kb-card">
        <div className="kb-card__title">{t('settings.proxy.apply.title')}</div>
        <p className="kb-card__desc">{t('settings.proxy.apply.desc')}</p>
        <div className="kb-card__row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? t('settings.proxy.apply.applying') : t('settings.proxy.apply.button')}
          </button>
          <span className="proxy-hint proxy-hint--inline">
            {status && !status.enabled
              ? t('settings.proxy.current.off')
              : status?.applied && status.ok
                ? `${t('settings.proxy.current.applied', {
                    mode: t(STATUS_KEY[status.mode]),
                  })}${status.tunnelPort ? t('settings.proxy.current.tunnel', { port: status.tunnelPort }) : ''}`
                : status?.error
                  ? t('settings.proxy.current.error', { error: status.error })
                  : t('settings.proxy.current.none')}
          </span>
        </div>
        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice--warn' : 'notice--ok'}`}>
            {message.text}
          </div>
        )}
        <p className="proxy-hint">{t('settings.proxy.hint.footer')}</p>
      </section>
    </div>
  );
}
