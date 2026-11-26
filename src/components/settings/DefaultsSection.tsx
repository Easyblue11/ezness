import { useState } from 'react';
import { joinModelKey, SUGGESTED_MODELS } from '../../data/providers';
import { useI18n } from '../../i18n';
import type { Defaults, DefaultsKey, OcrSettings, ProviderConfig } from '../../types';
import { CheckIcon, CopyIcon } from '../Icons';
import { OcrSection } from './OcrSection';

const CARDS: { key: DefaultsKey; titleKey: string; descKey: string }[] = [
  {
    key: 'chat',
    titleKey: 'settings.defaults.cards.chat.title',
    descKey: 'settings.defaults.cards.chat.desc',
  },
  {
    key: 'embedding',
    titleKey: 'settings.defaults.cards.embedding.title',
    descKey: 'settings.defaults.cards.embedding.desc',
  },
  {
    key: 'translation',
    titleKey: 'settings.defaults.cards.translation.title',
    descKey: 'settings.defaults.cards.translation.desc',
  },
];

/** 一条可以直接复制到终端里的本机模型命令。 */
function SuggestCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (window.ezness?.copyText) await window.ezness.copyText(command);
      else await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — leave the button silent */
    }
  }

  return (
    <span className="default-tip__cmd">
      <code>{command}</code>
      <button
        className={`default-tip__copy ${copied ? 'is-copied' : ''}`}
        title={copied ? t('settings.defaults.copied') : t('settings.defaults.copyCommand')}
        aria-label={copied ? t('settings.defaults.copied') : t('settings.defaults.copyCommand')}
        onClick={copy}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      </button>
    </span>
  );
}

interface Props {
  providers: Record<string, ProviderConfig>;
  defaults: Defaults;
  onChange: (key: DefaultsKey, value: string) => void;
  /** 图片/扫描件的本机识别；它属于「读什么进模型」，所以和默认模型放在一起。 */
  ocr: OcrSettings;
  onOcrChange: (patch: Partial<OcrSettings>) => void;
}

export function DefaultsSection({ providers, defaults, onChange, ocr, onOcrChange }: Props) {
  const { t } = useI18n();
  const available = Object.values(providers).filter((provider) => provider.models.length > 0);

  return (
    <div className="defaults">
      {available.length === 0 && <div className="notice">{t('settings.defaults.empty')}</div>}

      {CARDS.map((card) => {
        const suggestion =
          card.key === 'embedding' || card.key === 'translation' ? SUGGESTED_MODELS[card.key] : undefined;

        return (
          <section key={card.key} className="default-card">
            <div className="default-card__main">
              <div className="default-card__text">
                <div className="default-card__title">{t(card.titleKey)}</div>
                <div className="default-card__desc">{t(card.descKey)}</div>
              </div>

              {suggestion && (
                <div className="default-tip">
                  <span className="default-tip__note">{t(suggestion.note)}</span>
                  <SuggestCommand command={suggestion.command} />
                </div>
              )}
            </div>

            <select
              className="select select--inline"
              value={defaults[card.key]}
              disabled={available.length === 0}
              onChange={(event) => onChange(card.key, event.target.value)}
            >
              <option value="">
                {available.length === 0
                  ? t('settings.defaults.noModels')
                  : t('settings.defaults.unselected')}
              </option>
              {available.map((provider) => (
                <optgroup key={provider.id} label={provider.name}>
                  {provider.models.map((model) => (
                    <option key={model} value={joinModelKey(provider.id, model)}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </section>
        );
      })}

      <OcrSection ocr={ocr} onChange={onOcrChange} sub />
    </div>
  );
}
