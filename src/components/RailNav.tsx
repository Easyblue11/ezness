import { useState } from 'react';
import type { Theme, UsageSummary, ViewKey } from '../types';
import { formatCost, formatTokens } from '../lib/usage';
import { useI18n } from '../i18n';
import {
  AgentIcon,
  BillingIcon,
  BookIcon,
  ChatIcon,
  EyeIcon,
  MoonIcon,
  RefreshIcon,
  SettingsIcon,
  SparkleIcon,
  SunIcon,
  WarehouseIcon,
  WorkspaceIcon,
} from './Icons';

const NAV: { key: ViewKey; labelKey: string; icon: typeof ChatIcon }[] = [
  { key: 'chat', labelKey: 'rail.chat', icon: ChatIcon },
  { key: 'workspace', labelKey: 'rail.workspace', icon: WorkspaceIcon },
  { key: 'assistants', labelKey: 'rail.prompts', icon: SparkleIcon },
  { key: 'knowledge', labelKey: 'rail.knowledge', icon: BookIcon },
  { key: 'warehouse', labelKey: 'rail.warehouse', icon: WarehouseIcon },
];

interface Props {
  active: ViewKey;
  onChange: (key: ViewKey) => void;
  theme: Theme;
  onToggleTheme: () => void;
  usageToday: UsageSummary | null;
  /** 系统设置里的金额动画开关。 */
  rmbAnimation: boolean;
  /** 每跨过 0.1 元 +1；变化时重放一次金币动画。 */
  coinKey: number;
  /** 重新加载所有功能（等同重启）；正在生成时为空。 */
  onReload: null | (() => void);
  /** 重新加载进行中：图标持续旋转。 */
  reloading: boolean;
}

/** 累计花费多出 0.1 元时，从计费按钮上跳起来的金币。 */
function RmbCoin({ playKey }: { playKey: number }) {
  if (playKey === 0) return null;
  return (
    <span key={playKey} className="rail-coin" aria-hidden="true">
      <span className="rail-coin__body">
        <span className="rail-coin__face">¥</span>
        <span className="rail-coin__face rail-coin__face--back">¥</span>
      </span>
    </span>
  );
}

export function RailNav({
  active,
  onChange,
  theme,
  onToggleTheme,
  usageToday,
  rmbAnimation,
  coinKey,
  onReload,
  reloading,
}: Props) {
  const { t, locale } = useI18n();
  const [billingHover, setBillingHover] = useState(false);
  const allUnpriced =
    usageToday !== null && usageToday.requests > 0 && usageToday.unpricedRequests === usageToday.requests;

  return (
    <nav className="rail">
      <span className="rail__logo" role="img" aria-label="Ezness" title="Ezness" />

      <div className="rail__group">
        {NAV.map(({ key, labelKey, icon: Icon }) => (
          <button
            key={key}
            className={`rail__btn ${active === key ? 'is-active' : ''}`}
            title={t(labelKey)}
            aria-label={t(labelKey)}
            onClick={() => onChange(key)}
          >
            <Icon size={19} />
          </button>
        ))}

        <div className="rail__divider" />

        <button
          className={`rail__btn ${active === 'sensory' ? 'is-active' : ''}`}
          title={t('rail.abilities')}
          aria-label={t('rail.abilities')}
          onClick={() => onChange('sensory')}
        >
          <EyeIcon size={19} />
        </button>

        <button
          className={`rail__btn ${active === 'agent' ? 'is-active' : ''}`}
          title={t('rail.agent')}
          aria-label={t('rail.agent')}
          onClick={() => onChange('agent')}
        >
          <AgentIcon size={19} />
        </button>
      </div>

      <div className="rail__spacer" />

      <div className="rail__group">
        <button
          className={`rail__btn ${reloading ? 'is-busy' : ''}`}
          title={onReload === null ? t('rail.reloadBusy') : t('rail.reloadHint')}
          aria-label={t('rail.reload')}
          disabled={onReload === null}
          onClick={() => onReload?.()}
        >
          <RefreshIcon size={18} />
        </button>

        <div
          className="rail__billing"
          onMouseEnter={() => setBillingHover(true)}
          onMouseLeave={() => setBillingHover(false)}
        >
          <button
            className={`rail__btn ${active === 'billing' ? 'is-active' : ''}`}
            title={t('rail.billing')}
            aria-label={t('rail.billing')}
            aria-describedby={billingHover ? 'rail-billing-tip' : undefined}
            onClick={() => onChange('billing')}
            onFocus={() => setBillingHover(true)}
            onBlur={() => setBillingHover(false)}
          >
            <BillingIcon size={18} />
          </button>

          {rmbAnimation && <RmbCoin playKey={coinKey} />}

          {billingHover && (
            <div className="rail-tip" id="rail-billing-tip" role="tooltip">
              <div className="rail-tip__head">
                <span>{t('rail.today')}</span>
                <span className="rail-tip__date">{new Date().toLocaleDateString(locale)}</span>
              </div>
              {usageToday === null ? (
                <div className="rail-tip__empty">{t('rail.loading')}</div>
              ) : usageToday.requests === 0 ? (
                <div className="rail-tip__empty">{t('rail.noRequests')}</div>
              ) : (
                <>
                  <div className="rail-tip__cost">
                    {allUnpriced ? (
                      '—'
                    ) : (
                      <>
                        {usageToday.unpricedRequests > 0 && (
                          <span className="rail-tip__approx">≈</span>
                        )}
                        {formatCost(usageToday.cost)}
                      </>
                    )}
                  </div>
                  <div className="rail-tip__rows">
                    <span>{t('rail.input')}</span>
                    <strong>{formatTokens(usageToday.inputTokens)}</strong>
                    <span>{t('rail.output')}</span>
                    <strong>{formatTokens(usageToday.outputTokens)}</strong>
                    <span>{t('rail.requests')}</span>
                    <strong>
                      {t('rail.requestsCount', {
                        count: usageToday.requests,
                        value: usageToday.requests.toLocaleString(locale),
                      })}
                    </strong>
                  </div>
                  {usageToday.unpricedRequests > 0 && (
                    <div className="rail-tip__note">
                      {t('rail.unpricedNote', { count: usageToday.unpricedRequests })}
                    </div>
                  )}
                </>
              )}
              <div className="rail-tip__foot">{t('rail.viewDetails')}</div>
            </div>
          )}
        </div>

        <button
          className="rail__btn"
          title={theme === 'dark' ? t('rail.themeLight') : t('rail.themeDark')}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
        </button>
        <button
          className={`rail__btn ${active === 'settings' ? 'is-active' : ''}`}
          title={t('rail.settings')}
          onClick={() => onChange('settings')}
        >
          <SettingsIcon size={18} />
        </button>
      </div>
    </nav>
  );
}
