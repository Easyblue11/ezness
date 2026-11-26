import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { StorageInfo } from '../../types';
import {
  AgentIcon,
  BillingIcon,
  BookIcon,
  ChatIcon,
  ClockIcon,
  DirectorIcon,
  GlobeIcon,
  SparkleIcon,
  StackIcon,
  WorkspaceIcon,
} from '../Icons';

const FEATURES = [
  {
    icon: ChatIcon,
    titleKey: 'settings.about.features.chat.title',
    descKey: 'settings.about.features.chat.desc',
  },
  {
    icon: DirectorIcon,
    titleKey: 'settings.about.features.director.title',
    descKey: 'settings.about.features.director.desc',
  },
  {
    icon: WorkspaceIcon,
    titleKey: 'settings.about.features.workspace.title',
    descKey: 'settings.about.features.workspace.desc',
  },
  {
    icon: AgentIcon,
    titleKey: 'settings.about.features.agent.title',
    descKey: 'settings.about.features.agent.desc',
  },
  {
    icon: BookIcon,
    titleKey: 'settings.about.features.kb.title',
    descKey: 'settings.about.features.kb.desc',
  },
  {
    icon: SparkleIcon,
    titleKey: 'settings.about.features.prompts.title',
    descKey: 'settings.about.features.prompts.desc',
  },
  {
    icon: GlobeIcon,
    titleKey: 'settings.about.features.web.title',
    descKey: 'settings.about.features.web.desc',
  },
  {
    icon: BillingIcon,
    titleKey: 'settings.about.features.billing.title',
    descKey: 'settings.about.features.billing.desc',
  },
] as const;

/** Everything solved since the 1.0.0 release; the version is rendered live. */
const CHANGELOG = [
  'about.changelog.line1',
  'about.changelog.line2',
  'about.changelog.line3',
  'about.changelog.line4',
  'about.changelog.line5',
  'about.changelog.line6',
] as const;
const CHANGELOG_DATE = '2026-11-26';

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
  const { t } = useI18n();
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
    if (result && !result.ok) setError(result.error ?? t('system.storage.openError'));
  }

  const diagnostics = [
    `Ezness v${version}`,
    t('settings.about.diagnostics.os', { platform }),
    `Electron ${electron} / Chromium ${chrome} / Node ${node}`,
    t('settings.about.diagnostics.dataDir', {
      root: root || t('settings.about.diagnostics.unknown'),
    }),
  ].join('\n');

  return (
    <div className="section">
      <div className="section__head">
        <div>
          <h2>{t('settings.about.title')}</h2>
          <p>{t('settings.about.intro')}</p>
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
          <p className="about-brand__role">{t('settings.about.role')}</p>
          <p className="about-brand__lead">{t('settings.about.tagline')}</p>
          <p className="kb-card__desc about-brand__text">{t('settings.about.description')}</p>
          <div className="about-brand__tags">
            <span>{t('settings.about.tags.localFirst')}</span>
            <span>{t('settings.about.tags.noAccount')}</span>
            <span>{t('settings.about.tags.ownData')}</span>
            <span>{t('settings.about.tags.localModels')}</span>
          </div>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <WorkspaceIcon size={15} />
          {t('settings.about.features.title')}
        </div>
        <p className="kb-card__desc">{t('settings.about.features.desc')}</p>
        <div className="about-features">
          {FEATURES.map(({ icon: Icon, titleKey, descKey }) => (
            <div key={titleKey} className="about-feature">
              <span className="about-feature__icon">
                <Icon size={16} />
              </span>
              <div>
                <div className="about-feature__title">{t(titleKey)}</div>
                <div className="about-feature__desc">{t(descKey)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <SparkleIcon size={15} />
          {t('settings.about.principles.title')}
        </div>
        <div className="about-values">
          <div className="about-value">
            <h4>{t('settings.about.values.light.title')}</h4>
            <p>{t('settings.about.values.light.desc')}</p>
          </div>
          <div className="about-value">
            <h4>{t('settings.about.values.control.title')}</h4>
            <p>{t('settings.about.values.control.desc')}</p>
          </div>
          <div className="about-value">
            <h4>{t('settings.about.values.local.title')}</h4>
            <p>{t('settings.about.values.local.desc')}</p>
          </div>
          <div className="about-value">
            <h4>{t('settings.about.values.transparent.title')}</h4>
            <p>{t('settings.about.values.transparent.desc')}</p>
          </div>
        </div>
        <p className="about-note">{t('settings.about.note')}</p>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <ClockIcon size={15} />
          {t('about.changelog.title')}
        </div>
        <div className="about-changelog">
          <div className="about-changelog__head">
            <span className="about-changelog__version">v{version}</span>
            <span className="about-changelog__date">{CHANGELOG_DATE}</span>
          </div>
          <ul className="about-changelog__list">
            {CHANGELOG.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="kb-card">
        <div className="kb-card__title">
          <StackIcon size={15} />
          {t('settings.about.env.title')}
        </div>
        <p className="kb-card__desc">{t('settings.about.env.desc')}</p>
        <dl className="about-env">
          <div className="about-env__item">
            <dt>{t('settings.about.env.appVersion')}</dt>
            <dd>v{version}</dd>
          </div>
          <div className="about-env__item">
            <dt>{t('settings.about.env.os')}</dt>
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
            <dt>{t('settings.about.env.knowledge')}</dt>
            <dd>
              {stats
                ? t('settings.about.env.knowledgeValue', {
                    documents: stats.kbDocuments,
                    chunks: stats.kbChunks,
                  })
                : t('settings.about.env.reading')}
            </dd>
          </div>
          <div className="about-env__item">
            <dt>{t('settings.about.env.warehouse')}</dt>
            <dd>
              {stats
                ? t('settings.about.env.warehouseValue', { count: stats.warehouseFiles })
                : t('settings.about.env.reading')}
            </dd>
          </div>
          <div className="about-env__item">
            <dt>{t('settings.about.env.voice')}</dt>
            <dd>
              {stats
                ? stats.voiceReady
                  ? t('settings.about.env.voiceReady')
                  : t('settings.about.env.voiceMissing')
                : t('settings.about.env.reading')}
            </dd>
          </div>
          <div className="about-env__item">
            <dt>{t('settings.about.env.storage')}</dt>
            <dd>{stats ? formatSize(usedBytes) : t('settings.about.env.reading')}</dd>
          </div>
          <div className="about-env__item about-env__item--wide">
            <dt>{t('settings.about.env.dataDir')}</dt>
            <dd className="about-env__path">
              <code title={root}>{root || t('settings.about.env.reading')}</code>
              <span className="about-env__actions">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void openRoot()} disabled={!info}>
                  {t('system.storage.open')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => void copy(root, 'root')}
                  disabled={!root}
                >
                  {copied === 'root' ? t('settings.about.copied') : t('settings.about.copyPath')}
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
            {copied === 'diag' ? t('settings.about.copiedDiag') : t('settings.about.copyDiag')}
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
