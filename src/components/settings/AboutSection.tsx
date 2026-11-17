import { useEffect, useRef, useState } from 'react';
import type { StorageInfo } from '../../types';
import {
  AgentIcon,
  BillingIcon,
  BookIcon,
  ChatIcon,
  DirectorIcon,
  GlobeIcon,
  SparkleIcon,
  StackIcon,
  WorkspaceIcon,
} from '../Icons';

const FEATURES = [
  {
    icon: ChatIcon,
    title: '对话',
    desc: '多模型切换、附件、流式输出，随时可以中断。',
  },
  {
    icon: DirectorIcon,
    title: '工作总监',
    desc: '常驻的总监盯进度、派工、验收；有新情况才汇报，没事不刷屏。',
  },
  {
    icon: WorkspaceIcon,
    title: '工作空间与文件',
    desc: '本地目录或 SSH 远程工作区；目录树按需展开，文本高亮、图片预览与编辑。',
  },
  {
    icon: AgentIcon,
    title: 'Agent 与 AI 能力',
    desc: '独立的提示词、知识库与记忆；权限分四级；Agent 和能力分类可整包导出导入。',
  },
  {
    icon: BookIcon,
    title: '知识库与仓库',
    desc: '本地切片检索，分类与文档级范围；对话附件收进仓库长期留存。',
  },
  {
    icon: SparkleIcon,
    title: '提示词模板',
    desc: '模板存在你自己的数据目录里，随时调用，也可以自己加。',
  },
  {
    icon: GlobeIcon,
    title: '联网、OCR 与语音',
    desc: '搜索从本机发出，OCR 和语音识别也在本地跑，不经过模型厂商。',
  },
  {
    icon: BillingIcon,
    title: '模型接入与计费',
    desc: '常见厂家的地址已经列好，选一家补上密钥就行；也能自填地址对接自建网关。',
  },
] as const;

const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

/** 本地数据占用，只用来给个量级；不追求精确到字节。 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AboutSection() {
  const api = window.ezness;
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [copied, setCopied] = useState<'root' | 'diag' | ''>('');
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      ?.storageInfo?.()
      .then((next) => {
        if (alive) setInfo(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [api]);

  const version = __APP_VERSION__;
  const platform = PLATFORM_LABEL[api?.platform ?? ''] ?? api?.platform ?? '—';
  const electron = api?.versions?.electron || '—';
  const chrome = api?.versions?.chrome || '—';
  const node = api?.versions?.node || '—';
  const root = info?.root ?? '';
  const stats = info?.stats;
  const usedBytes = stats
    ? stats.configBytes + stats.ragBytes + stats.warehouseDirBytes + stats.voiceBytes
    : 0;

  function flash(which: 'root' | 'diag') {
    setCopied(which);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(''), 1800);
  }

  async function copy(text: string, which: 'root' | 'diag') {
    if (!api || !text) return;
    const ok = await api.copyText(text);
    if (ok !== false) flash(which);
  }

  async function openRoot() {
    if (!api || !info) return;
    setError('');
    const result = await api.storageOpenRoot();
    if (result && !result.ok) setError(result.error ?? '打不开这个目录');
  }

  const diagnostics = [
    `Ezness v${version}`,
    `系统：${platform}`,
    `Electron ${electron} / Chromium ${chrome} / Node ${node}`,
    `数据目录：${root || '未知'}`,
  ].join('\n');

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>关于我们</h2>
          <p>
            Ezness 由 EasyBlue 独立开发。模型接入、知识库、工作区和用量记录都留在你自己的电脑上，
            没有账号，也没有云端中转。
          </p>
        </div>
        <span className="about__version">v{version}</span>
      </div>

      <section className="kb-card about-brand">
        <div className="about__avatar">E</div>
        <div className="about-brand__body">
          <div className="about-brand__title">
            <h3>Ezness</h3>
            <span className="about-brand__by">by EasyBlue</span>
          </div>
          <p className="about-brand__role">独立开发者 · Ezness 作者</p>
          <p className="about-brand__lead">把笨重的东西拆开，留下真正有用的部分。</p>
          <p className="kb-card__desc about-brand__text">
            Ezness 是一个本地优先的桌面 AI 工作台。对话、工作总监、工作空间与任务、文件浏览、知识库、
            仓库和提示词都在同一个窗口里完成；模型可以接云端 API，也可以用 Ollama 在本机跑；
            联网搜索、OCR 和语音识别按需开启，不用的部分不会在后台常驻。
          </p>
          <div className="about-brand__tags">
            <span>本地优先</span>
            <span>无账号</span>
            <span>数据自持</span>
            <span>可接本地模型</span>
          </div>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          现在能做什么
        </div>
        <p className="kb-card__desc">
          功能按需组合：常用的一直在，少用的才打开，不替你安排工作流。
        </p>
        <div className="about-features">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="about-feature">
              <span className="about-feature__icon">
                <Icon size={16} />
              </span>
              <div>
                <div className="about-feature__title">{title}</div>
                <div className="about-feature__desc">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <SparkleIcon size={15} />
          设计原则
        </div>
        <div className="about-values">
          <div className="about-value">
            <h4>轻</h4>
            <p>不引组件库，不挂常驻后台服务，启动就是启动。</p>
          </div>
          <div className="about-value">
            <h4>可控</h4>
            <p>每个接入、每个模型、每个默认项、每项工具权限都摆在你面前，没有隐藏的默认行为。</p>
          </div>
          <div className="about-value">
            <h4>本地优先</h4>
            <p>设置、会话与文件留在本机，密钥只保存在本机配置里。</p>
          </div>
          <div className="about-value">
            <h4>透明</h4>
            <p>没有账号系统，也不做埋点；请求只在你主动发起时离开本机。</p>
          </div>
        </div>
        <p className="about-note">
          设置、会话、知识库、仓库、提示词模板和用量记录都保存在下面的数据目录里；应用本身没有云端账号，
          也不会上传这些内容。换机器时把整个目录拷走即可。
        </p>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <StackIcon size={15} />
          运行环境与数据
        </div>
        <p className="kb-card__desc">
          版本信息用于排查问题；下面的用量来自本地统计，不包含密钥、会话内容或文件正文。
        </p>
        <dl className="about-env">
          <div className="about-env__item">
            <dt>应用版本</dt>
            <dd>v{version}</dd>
          </div>
          <div className="about-env__item">
            <dt>系统</dt>
            <dd>{platform}</dd>
          </div>
          <div className="about-env__item">
            <dt>Electron</dt>
            <dd>{electron}</dd>
          </div>
          <div className="about-env__item">
            <dt>Chromium</dt>
            <dd>{chrome}</dd>
          </div>
          <div className="about-env__item">
            <dt>Node.js</dt>
            <dd>{node}</dd>
          </div>
          <div className="about-env__item">
            <dt>知识库</dt>
            <dd>{stats ? `${stats.kbDocuments} 篇 · ${stats.kbChunks} 片` : '读取中…'}</dd>
          </div>
          <div className="about-env__item">
            <dt>仓库</dt>
            <dd>{stats ? `${stats.warehouseFiles} 个文件` : '读取中…'}</dd>
          </div>
          <div className="about-env__item">
            <dt>本地语音</dt>
            <dd>{stats ? (stats.voiceReady ? '已就绪' : '未安装') : '读取中…'}</dd>
          </div>
          <div className="about-env__item">
            <dt>数据占用</dt>
            <dd>{stats ? formatSize(usedBytes) : '读取中…'}</dd>
          </div>
          <div className="about-env__item about-env__item--wide">
            <dt>数据目录</dt>
            <dd className="about-env__path">
              <code title={root}>{root || '读取中…'}</code>
              <span className="about-env__actions">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void openRoot()} disabled={!info}>
                  打开目录
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void copy(root, 'root')}
                  disabled={!root}
                >
                  {copied === 'root' ? '已复制' : '复制路径'}
                </button>
              </span>
            </dd>
          </div>
        </dl>
        <div className="about-env__foot">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void copy(diagnostics, 'diag')}
          >
            {copied === 'diag' ? '已复制诊断信息' : '复制诊断信息'}
          </button>
          {error && <span className="about-env__error">{error}</span>}
        </div>
      </section>

      <footer className="about__meta">
        <span>Ezness v{version} · © {new Date().getFullYear()} EasyBlue</span>
        <span>Electron · React · TypeScript</span>
        <span className="about__sign">— EasyBlue</span>
      </footer>
    </div>
  );
}
