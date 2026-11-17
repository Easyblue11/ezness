import { useState } from 'react';
import type {
  Defaults,
  DefaultsKey,
  OcrSettings,
  ProviderConfig,
  ProxySettings,
  SettingsSection,
  VoiceSettings,
  WebSettings,
  WorkSettings,
} from '../types';
import {
  BookIcon,
  GlobeIcon,
  InfoIcon,
  MicIcon,
  PlugIcon,
  ProxyIcon,
  SettingsIcon,
  SparkleIcon,
  StackIcon,
  WarehouseIcon,
  WorkspaceIcon,
} from './Icons';
import { useI18n } from '../i18n';
import { AboutSection } from './settings/AboutSection';
import { DefaultsSection } from './settings/DefaultsSection';
import { KbSection } from './settings/KbSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { ProxySection } from './settings/ProxySection';
import { PythonSection } from './settings/PythonSection';
import { SystemSection } from './settings/SystemSection';
import { VoiceSection } from './settings/VoiceSection';
import { WarehouseSection } from './settings/WarehouseSection';
import { WebSection } from './settings/WebSection';
import { WorkSection } from './settings/WorkSection';

const SECTIONS: { key: SettingsSection; labelKey: string; icon: typeof PlugIcon }[] = [
  { key: 'system', labelKey: 'settings.nav.system', icon: SettingsIcon },
  { key: 'providers', labelKey: 'settings.nav.providers', icon: PlugIcon },
  { key: 'defaults', labelKey: 'settings.nav.defaults', icon: SparkleIcon },
  { key: 'work', labelKey: 'settings.nav.work', icon: WorkspaceIcon },
  { key: 'kb', labelKey: 'settings.nav.kb', icon: BookIcon },
  { key: 'warehouse', labelKey: 'settings.nav.warehouse', icon: WarehouseIcon },
  { key: 'python', labelKey: 'settings.nav.python', icon: StackIcon },
  { key: 'voice', labelKey: 'settings.nav.voice', icon: MicIcon },
  { key: 'web', labelKey: 'settings.nav.web', icon: GlobeIcon },
  { key: 'proxy', labelKey: 'settings.nav.proxy', icon: ProxyIcon },
  { key: 'about', labelKey: 'settings.nav.about', icon: InfoIcon },
];

interface Props {
  providers: Record<string, ProviderConfig>;
  onProviderChange: (id: string, patch: Partial<ProviderConfig>) => void;
  onProviderRemove: (id: string) => void;
  defaults: Defaults;
  onDefaultChange: (key: DefaultsKey, value: string) => void;
  voice: VoiceSettings;
  onVoiceChange: (patch: Partial<VoiceSettings>) => void;
  ocr: OcrSettings;
  onOcrChange: (patch: Partial<OcrSettings>) => void;
  web: WebSettings;
  onWebChange: (web: WebSettings) => void;
  proxy: ProxySettings;
  onProxyChange: (proxy: ProxySettings) => void;
  work: WorkSettings;
  onWorkChange: (work: WorkSettings) => void;
  rmbAnimation: boolean;
  onRmbAnimationChange: (on: boolean) => void;
}

export function SettingsPage({
  providers,
  onProviderChange,
  onProviderRemove,
  defaults,
  onDefaultChange,
  voice,
  onVoiceChange,
  ocr,
  onOcrChange,
  web,
  onWebChange,
  proxy,
  onProxyChange,
  work,
  onWorkChange,
  rmbAnimation,
  onRmbAnimationChange,
}: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>('providers');

  return (
    <div className="settings">
      <nav className="settings__nav">
        <div className="settings__label">{t('settings.title')}</div>
        {SECTIONS.map(({ key, labelKey, icon: Icon }) => (
          <button
            key={key}
            className={`snav-item ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            <Icon size={16} />
            {t(labelKey)}
          </button>
        ))}
      </nav>

      <div className="settings__panel">
        {section === 'system' && (
          <SystemSection
            work={work}
            onWorkChange={onWorkChange}
            rmbAnimation={rmbAnimation}
            onRmbAnimationChange={onRmbAnimationChange}
          />
        )}
        {section === 'providers' && (
          <ProvidersSection
            providers={providers}
            onChange={onProviderChange}
            onRemove={onProviderRemove}
          />
        )}
        {section === 'defaults' && (
          <DefaultsSection
            providers={providers}
            defaults={defaults}
            onChange={onDefaultChange}
            ocr={ocr}
            onOcrChange={onOcrChange}
          />
        )}
        {section === 'kb' && <KbSection />}
        {section === 'warehouse' && <WarehouseSection />}
        {section === 'python' && <PythonSection />}
        {section === 'voice' && <VoiceSection voice={voice} onChange={onVoiceChange} />}
        {section === 'web' && <WebSection web={web} onChange={onWebChange} />}
        {section === 'proxy' && <ProxySection proxy={proxy} onChange={onProxyChange} />}
        {section === 'work' && <WorkSection work={work} onChange={onWorkChange} />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  );
}
