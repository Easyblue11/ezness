import { useState } from 'react';
import { joinModelKey, SUGGESTED_MODELS } from '../../data/providers';
import type { Defaults, DefaultsKey, OcrSettings, ProviderConfig } from '../../types';
import { CheckIcon, CopyIcon } from '../Icons';
import { OcrSection } from './OcrSection';

const CARDS: { key: DefaultsKey; title: string; desc: string }[] = [
  {
    key: 'chat',
    title: '默认模型',
    desc: '新建会话默认使用，也是日常对话的主力模型',
  },
  {
    key: 'embedding',
    title: 'Embedding 模型',
    desc: '知识仓库切片与向量检索使用',
  },
  {
    key: 'translation',
    title: '翻译模型',
    desc: '界面翻译、文档翻译这类轻任务使用，可以选更便宜的',
  },
];

/** 一条可以直接复制到终端里的本机模型命令。 */
function SuggestCommand({ command }: { command: string }) {
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
        title={copied ? '已复制' : '复制命令'}
        aria-label={copied ? '已复制' : '复制命令'}
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
  const available = Object.values(providers).filter((provider) => provider.models.length > 0);

  return (
    <div className="defaults">
      {available.length === 0 && (
        <div className="notice">
          还没有可用的模型。先去「模型接入」里填好地址并获取模型，这里才会出现可选项。
        </div>
      )}

      {CARDS.map((card) => {
        const suggestion =
          card.key === 'embedding' || card.key === 'translation' ? SUGGESTED_MODELS[card.key] : undefined;

        return (
          <section key={card.key} className="default-card">
            <div className="default-card__main">
              <div className="default-card__text">
                <div className="default-card__title">{card.title}</div>
                <div className="default-card__desc">{card.desc}</div>
              </div>

              {suggestion && (
                <div className="default-tip">
                  <span className="default-tip__note">{suggestion.note}</span>
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
              <option value="">{available.length === 0 ? '暂无可选模型' : '未选择'}</option>
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
