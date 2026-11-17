import { useEffect, useState } from 'react';
import {
  PROXY_MODES,
  PROXY_SCHEMES,
  proxyProblem,
  proxyRuleId,
} from '../../data/proxy';
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

const STATUS_TEXT: Record<ProxyStatus['mode'], string> = {
  direct: '直接连接',
  system: '系统代理',
  fixed: '固定代理',
  auto: '自动切换',
};

export function ProxySection({ proxy, onChange }: Props) {
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
      setMessage({ kind: 'error', text: problem });
      return;
    }
    const api = window.ezness;
    if (!api?.proxyApply) {
      setMessage({ kind: 'error', text: '当前版本不支持代理设置。' });
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
                ? `已应用。SSH 隧道监听 127.0.0.1:${next.tunnelPort}，新的请求会走它。`
                : '已应用。新的请求会使用这个代理。',
            }
          : { kind: 'error', text: next.error ?? '应用失败。' },
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
      setMessage({ kind: 'error', text: '当前版本不支持代理设置。' });
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
          text: next.enabled ? '代理已开启。' : '代理已关闭，所有请求都会直连。',
        });
      } else {
        setMessage({ kind: 'error', text: nextStatus.error ?? '切换失败。' });
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
      setMessage({ kind: 'error', text: '当前版本不支持代理测试。' });
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
        detail: '连接失败',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }

  const statusLabel = status
    ? !status.enabled
      ? '已关闭'
      : status.ok
        ? status.applied
          ? `已应用 · ${status.detail}`
          : status.error
            ? '未生效'
            : '未应用'
        : '未生效'
    : '读取中…';

  // The switch is the master toggle; the mode still decides what "on" means.
  const capsuleLabel = !proxy.enabled
    ? '代理已关闭'
    : proxy.mode === 'direct'
      ? '代理已开启（当前直连）'
      : proxy.mode === 'system'
        ? '代理已开启（系统代理）'
        : '代理已开启';

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>代理设置</h2>
          <p>
            给应用自身的网络请求设置出口：模型接口、联网检索、知识库与语音模型下载都会走这里。
            模式与 Zero Omega 类似，支持直接连接、系统代理、固定代理和按域名自动切换。
          </p>
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
          aria-label={proxy.enabled ? '关闭代理' : '开启代理'}
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
          {testing ? '连接中…' : '测试连接'}
        </button>
        {testResult && (
          <span className={`proxy-test ${testResult.ok ? 'is-ok' : 'is-bad'}`}>
            {testResult.ok
              ? `已连接 · ${testResult.latencyMs} ms`
              : `连接失败${testResult.error ? `：${testResult.error}` : ''}`}
          </span>
        )}
      </div>
      <p className="proxy-hint proxy-hint--toolbar">
        开关立即生效；修改模式、服务器或规则后，仍要点最下方的「应用代理」。
      </p>

      <section className="kb-card">
        <div className="kb-card__title">
          <ProxyIcon size={15} />
          代理模式
        </div>
        <p className="kb-card__desc">
          切换模式后点最下方的「应用代理」才会生效。直接连接和系统代理不需要填服务器。
        </p>
        <div className="proxy-modes">
          {PROXY_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={`proxy-mode ${proxy.mode === item.mode ? 'is-active' : ''}`}
              onClick={() => patch({ mode: item.mode })}
            >
              <strong>{item.label}</strong>
              <span>{item.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {usesServer && (
        <section className="kb-card">
          <div className="kb-card__title">代理服务器</div>
          <p className="kb-card__desc">
            {proxy.mode === 'auto'
              ? '自动切换模式下，命中的域名走这台服务器，其余按下面的默认动作处理。'
              : '所有请求都走这台服务器。SSH 代理会在本机开一个 SOCKS5 隧道。'}
          </p>

          <div className="proxy-schemes">
            {PROXY_SCHEMES.map((item) => (
              <button
                key={item.scheme}
                type="button"
                className={`proxy-scheme ${server.scheme === item.scheme ? 'is-active' : ''}`}
                title={item.desc}
                onClick={() => patchServer({ scheme: item.scheme })}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="field-grid">
            <label className="field">
              <span className="field__label">地址</span>
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
                端口
                <span className="field__hint">
                  {server.scheme === 'ssh' ? 'SSH 默认 22' : '本地代理常见 7890'}
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
                    用户名
                    <span className="field__hint">可选</span>
                  </span>
                  <input
                    className="input"
                    value={server.username}
                    placeholder="代理需要认证时填写"
                    autoComplete="off"
                    onChange={(event) => patchServer({ username: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field__label">
                    密码
                    <span className="field__hint">可选</span>
                  </span>
                  <div className="input-row">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={server.password}
                      placeholder="留空表示无需认证"
                      autoComplete="new-password"
                      onChange={(event) => patchServer({ password: event.target.value })}
                    />
                    <button
                      type="button"
                      className="iconbtn iconbtn--bordered"
                      title={showPassword ? '隐藏密码' : '显示密码'}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                </label>
              </div>
              <p className="proxy-hint">
                {server.scheme === 'https'
                  ? 'HTTPS 代理表示「到代理服务器这一段用 TLS 加密」；普通 HTTP 代理请选 HTTP 代理。'
                  : '认证信息保存在本机的 settings.json 里，和其他 API Key 一样不是加密存储。'}
              </p>
            </>
          )}

          {server.scheme === 'socks5' && (
            <p className="proxy-hint">
              Chromium 的 SOCKS5 客户端不支持用户名/密码认证。代理必须认证时，请改用 HTTP / HTTPS
              代理，或用 SSH 代理直接登录服务器。
            </p>
          )}

          {server.scheme === 'ssh' && (
            <>
              <div className="field-grid">
                <label className="field">
                  <span className="field__label">SSH 用户名</span>
                  <input
                    className="input"
                    value={server.username}
                    placeholder="root"
                    autoComplete="off"
                    onChange={(event) => patchServer({ username: event.target.value.trim() })}
                  />
                </label>
                <label className="field">
                  <span className="field__label">认证方式</span>
                  <div className="proxy-segment">
                    <button
                      type="button"
                      className={server.sshAuth === 'password' ? 'is-active' : ''}
                      onClick={() => patchServer({ sshAuth: 'password' })}
                    >
                      密码
                    </button>
                    <button
                      type="button"
                      className={server.sshAuth === 'key' ? 'is-active' : ''}
                      onClick={() => patchServer({ sshAuth: 'key' })}
                    >
                      私钥
                    </button>
                  </div>
                </label>
              </div>

              {server.sshAuth === 'password' ? (
                <label className="field">
                  <span className="field__label">SSH 密码</span>
                  <div className="input-row">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={server.password}
                      placeholder="登录密码"
                      autoComplete="new-password"
                      onChange={(event) => patchServer({ password: event.target.value })}
                    />
                    <button
                      type="button"
                      className="iconbtn iconbtn--bordered"
                      title={showPassword ? '隐藏密码' : '显示密码'}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                </label>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">私钥文件</span>
                    <div className="input-row">
                      <input
                        className="input"
                        value={server.privateKeyPath}
                        placeholder="选择 id_ed25519 / id_rsa"
                        spellCheck={false}
                        onChange={(event) => patchServer({ privateKeyPath: event.target.value })}
                      />
                      <button type="button" className="btn" onClick={() => void chooseKey()}>
                        浏览
                      </button>
                    </div>
                  </label>
                  <label className="field">
                    <span className="field__label">
                      私钥口令
                      <span className="field__hint">没有口令就留空</span>
                    </span>
                    <div className="input-row">
                      <input
                        className="input"
                        type={showPassphrase ? 'text' : 'password'}
                        value={server.privateKeyPassphrase}
                        placeholder="可选"
                        autoComplete="new-password"
                        onChange={(event) =>
                          patchServer({ privateKeyPassphrase: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="iconbtn iconbtn--bordered"
                        title={showPassphrase ? '隐藏口令' : '显示口令'}
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
                  主机指纹
                  <span className="field__hint">可选，填了会严格校验</span>
                </span>
                <input
                  className="input"
                  value={server.fingerprint}
                  placeholder="SHA256:..."
                  spellCheck={false}
                  onChange={(event) => patchServer({ fingerprint: event.target.value.trim() })}
                />
              </label>
              <p className="proxy-hint">
                SSH 隧道使用应用已有的 Python + paramiko 连接方式，和远程工作空间共用一套认证逻辑。
                密码与私钥口令保存在本机 settings.json。
              </p>
            </>
          )}
        </section>
      )}

      {proxy.mode === 'auto' && (
        <section className="kb-card">
          <div className="kb-card__title">自动切换规则</div>
          <p className="kb-card__desc">
            按顺序匹配域名，第一条命中的规则生效。规则只匹配域名本身：
            <code>*.openai.com</code> 匹配子域名，<code>openai.com</code> 只匹配它自己。
          </p>

          <div className="proxy-default">
            <span>没有命中任何规则时</span>
            <select
              className="select"
              value={proxy.autoDefault}
              onChange={(event) =>
                patch({ autoDefault: event.target.value === 'direct' ? 'direct' : 'proxy' })
              }
            >
              <option value="proxy">走代理</option>
              <option value="direct">直接连接</option>
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
                  <option value="proxy">走代理</option>
                  <option value="direct">直接连接</option>
                </select>
                <button
                  type="button"
                  className="iconbtn"
                  title="上移"
                  disabled={index === 0}
                  onClick={() => moveRule(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  title="下移"
                  disabled={index === proxy.rules.length - 1}
                  onClick={() => moveRule(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  title="删除这条规则"
                  onClick={() => removeRule(rule.id)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>

          {proxy.rules.length === 0 && (
            <div className="proxy-hint">还没有规则，所有请求都会使用上面的默认动作。</div>
          )}

          <div className="kb-card__row">
            <button type="button" className="btn" onClick={addRule}>
              <PlusIcon size={14} />
              新增规则
            </button>
          </div>
        </section>
      )}

      {usesServer && (
        <section className="kb-card">
          <div className="kb-card__title">不走代理的地址</div>
          <p className="kb-card__desc">
            每行一个域名、IP 或 <code>&lt;local&gt;</code>。本机地址默认直连，不会因为开了代理而绕一圈。
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
        <div className="kb-card__title">生效</div>
        <p className="kb-card__desc">
          点「应用代理」会立刻切换出口，正在生成的回复会被中断；设置本身会随其他设置一起保存，
          下次启动自动应用。
        </p>
        <div className="kb-card__row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? '正在应用…' : '应用代理'}
          </button>
          <span className="proxy-hint proxy-hint--inline">
            {status && !status.enabled
              ? '当前：已关闭（所有请求直连）'
              : status?.applied && status.ok
                ? `当前：${STATUS_TEXT[status.mode]}${status.tunnelPort ? ` · 隧道 ${status.tunnelPort}` : ''}`
                : status?.error
                  ? `未生效：${status.error}`
                  : '当前还没有应用代理配置。'}
          </span>
        </div>
        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice--warn' : 'notice--ok'}`}>
            {message.text}
          </div>
        )}
        <p className="proxy-hint">
          只作用于应用自身的网络请求；Agent 执行的外部命令（git、curl、pip）和远程工作空间的 SSH
          连接仍然直连。
        </p>
      </section>
    </div>
  );
}
