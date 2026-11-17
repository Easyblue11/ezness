import { useCallback, useEffect, useState } from 'react';
import type { PythonEnvStatus, PythonModule } from '../../types';
import { CheckIcon, DownloadIcon, RefreshIcon, StackIcon } from '../Icons';

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export function PythonSection() {
  const api = window.ezness;
  const [status, setStatus] = useState<PythonEnvStatus | null>(null);
  const [modules, setModules] = useState<PythonModule[]>([]);
  const [modulesError, setModulesError] = useState('');
  const [indexDraft, setIndexDraft] = useState('');
  const [installDraft, setInstallDraft] = useState('');
  const [busy, setBusy] = useState<'' | 'ensure' | 'modules' | 'install' | 'index'>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const refreshStatus = useCallback(async () => {
    const next = await api?.pythonEnvStatus();
    if (!next) return null;
    setStatus(next);
    setIndexDraft((current) => current || next.indexUrl);
    return next;
  }, [api]);

  const loadModules = useCallback(async () => {
    setModulesError('');
    try {
      const list = await api?.pythonModules();
      if (Array.isArray(list)) setModules(list);
      return true;
    } catch (error) {
      setModules([]);
      setModulesError(errorText(error));
      return false;
    }
  }, [api]);

  useEffect(() => {
    void (async () => {
      const next = await refreshStatus();
      if (next?.installed) await loadModules();
    })();
  }, [refreshStatus, loadModules]);

  async function ensureEnv() {
    if (!api || busy) return;
    setBusy('ensure');
    setMessage({ kind: 'ok', text: '正在检查并补全 Python 环境，首次部署需要下载约 12 MB…' });
    try {
      const next = await api.pythonEnvEnsure();
      setStatus(next);
      setIndexDraft(next.indexUrl);
      setMessage({
        kind: 'ok',
        text: `环境已就绪：${next.version || 'Python'}${next.pipVersion ? `，${next.pipVersion}` : ''}`,
      });
      await loadModules();
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function saveIndex() {
    if (!api || busy) return;
    setBusy('index');
    setMessage(null);
    try {
      const result = await api.pythonSetIndex(indexDraft);
      setIndexDraft(result.indexUrl);
      setStatus((prev) => (prev ? { ...prev, indexUrl: result.indexUrl } : prev));
      setMessage({ kind: 'ok', text: '安装源已保存。' });
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function installModule() {
    if (!api || busy) return;
    const spec = installDraft.trim();
    if (!spec) return;
    setBusy('install');
    setMessage({ kind: 'ok', text: `正在安装 ${spec}…` });
    try {
      const result = await api.pythonInstallModule(spec);
      setInstallDraft('');
      setMessage({ kind: 'ok', text: `${result.spec} 已安装。` });
      await loadModules();
    } catch (error) {
      setMessage({ kind: 'warn', text: errorText(error) });
    } finally {
      setBusy('');
    }
  }

  async function refreshModules() {
    if (!api || busy) return;
    setBusy('modules');
    setMessage(null);
    try {
      await loadModules();
      await refreshStatus();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>程序环境</h2>
          <p>
            给自定义功能用的独立 Python，装在数据目录里，跟着储存地址一起迁移；换电脑时不用重新找
            Python。
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => void refreshModules()} disabled={Boolean(busy)}>
          <RefreshIcon size={14} />
          刷新
        </button>
      </div>

      <section className="kb-card">
        <div className="kb-card__title">
          <StackIcon size={15} />
          独立 Python 环境
        </div>
        <p className="kb-card__desc">
          「检查并补全环境」会把 Python {status?.targetVersion ?? ''} 和 pip 部署到下面的目录。
          AI能力里的 Python 脚本会优先使用它，系统里装的 Python 不会参与。
        </p>
        <div className="kb-card__row">
          <input className="input" readOnly value={status?.dir ?? '正在读取…'} />
          <button className="btn btn--primary" onClick={() => void ensureEnv()} disabled={Boolean(busy)}>
            <DownloadIcon size={14} />
            {busy === 'ensure' ? '正在部署…' : '检查并补全环境'}
          </button>
        </div>
        {status && (
          <div className="kb-card__meta">
            {status.installed ? (
              <>
                已就绪 · {status.version || '版本未知'} · pip{' '}
                {status.pip ? status.pipVersion || '已安装' : '缺失（点上面的按钮补全）'} ·{' '}
                {modules.length} 个模块
              </>
            ) : (
              <>尚未部署 · 目标 Python {status.targetVersion} · 部署后占用约 30 MB</>
            )}
          </div>
        )}
        {status?.installed && status.pip === false && (
          <div className="notice notice--warn">环境里缺 pip，点「检查并补全环境」补上即可，不会覆盖已有模块。</div>
        )}
      </section>

      <section className="kb-card">
        <div className="kb-card__title">安装源</div>
        <p className="kb-card__desc">
          安装模块用的索引地址，默认清华源。部署 Python 时会从华为云镜像取安装包，失败再回落到官方地址。
        </p>
        <div className="kb-card__row">
          <input
            className="input py-index-input"
            value={indexDraft}
            onChange={(event) => setIndexDraft(event.target.value)}
            placeholder={status?.defaultIndex ?? ''}
            spellCheck={false}
          />
          <button className="btn" onClick={() => void saveIndex()} disabled={Boolean(busy)}>
            保存
          </button>
        </div>
        <div className="kb-card__meta">
          当前源：<code>{status?.indexUrl ?? '正在读取…'}</code>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">已安装模块</div>
        <p className="kb-card__desc">
          列出这个环境里的模块。输入模块名安装，可以带版本，例如 <code>requests</code> 或{' '}
          <code>pandas==2.2.3</code>。
        </p>
        <div className="kb-card__row">
          <input
            className="input py-install-input"
            value={installDraft}
            onChange={(event) => setInstallDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void installModule();
            }}
            placeholder="要安装的模块名"
            spellCheck={false}
            disabled={busy === 'install'}
          />
          <button
            className="btn btn--primary"
            onClick={() => void installModule()}
            disabled={Boolean(busy) || !installDraft.trim()}
          >
            {busy === 'install' ? '正在安装…' : '安装'}
          </button>
          <button className="btn btn--ghost" onClick={() => void refreshModules()} disabled={Boolean(busy)}>
            刷新列表
          </button>
        </div>

        {modulesError && <div className="notice notice--warn">{modulesError}</div>}

        {modules.length > 0 ? (
          <div className="py-modules">
            {modules.map((item) => (
              <div className="py-module" key={item.name}>
                <span className="py-module__name">{item.name}</span>
                <span className="py-module__version">{item.version}</span>
              </div>
            ))}
          </div>
        ) : (
          !modulesError && (
            <div className="kb-card__meta">
              {status?.installed ? '这个环境里还没有第三方模块。' : '部署环境后可以在这里查看模块。'}
            </div>
          )
        )}
      </section>

      {message && (
        <div className={message.kind === 'warn' ? 'notice notice--warn' : 'notice'}>
          <CheckIcon size={14} /> {message.text}
        </div>
      )}
    </div>
  );
}
