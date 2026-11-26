import type { Defaults, ProviderConfig, ProviderPreset } from '../types';

/**
 * 出厂不带任何模型接入：新装用户的接入列表是空的，密钥和模型一律自己填。
 * 下面这份只是「新增接入」时的厂家目录——名字、接口类型和地址帮你填好，
 * 密钥、模型一个都不预置。
 */
export function createDefaultProviders(): Record<string, ProviderConfig> {
  return {};
}

/**
 * 厂家目录：选一个就按它的接口类型和地址建一条接入，用户只补密钥和模型。
 * 最后一项是自定义，地址留空、接口类型可改，适合自建网关或未收录的厂家。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    initials: 'OL',
    apiType: 'ollama',
    baseUrl: 'http://localhost:11434',
    description: 'settings.providers.presets.ollama.desc',
    keyOptional: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    initials: 'AN',
    apiType: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    description: 'settings.providers.presets.anthropic.desc',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    initials: 'DS',
    apiType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    description: 'settings.providers.presets.deepseek.desc',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    initials: 'KM',
    apiType: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    description: 'settings.providers.presets.kimi.desc',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    initials: 'OC',
    apiType: 'openai',
    baseUrl: 'https://opencode.ai/zen/v1',
    description: 'settings.providers.presets.opencode.desc',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    initials: 'GO',
    apiType: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    description: 'settings.providers.presets.opencode-go.desc',
  },
  {
    id: 'custom',
    name: 'Custom',
    initials: '＋',
    apiType: 'openai',
    baseUrl: '',
    description: 'settings.providers.presets.custom.desc',
    editable: true,
  },
];

/** 按地址认厂家，用来在列表里显示对应缩写；改过地址就不再算预置。 */
export function presetForProvider(provider: ProviderConfig): ProviderPreset | undefined {
  const url = provider.baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  if (!url) return undefined;
  return PROVIDER_PRESETS.find((preset) => {
    if (!preset.baseUrl) return false;
    return preset.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === url;
  });
}

/** 「模型接入 → Ollama」里给用户指路的官方下载页。 */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/**
 * 设置 → 默认模型 里给出的本机模型建议。只是提示文案，不改变默认值：
 * 想换推荐模型只改这里，命令会原样出现在「复制」按钮旁边。
 * embedding 用 pull 不用 run：embedding 模型不参与生成，run 会报错。
 */
export const SUGGESTED_MODELS: Partial<
  Record<'embedding' | 'translation', { note: string; command: string }>
> = {
  embedding: {
    note: 'settings.defaults.suggest.embedding',
    command: 'ollama pull xagi/qwen3-embedding:0.6b-q4_k_m-1024',
  },
  translation: {
    note: 'settings.defaults.suggest.translation',
    command: 'ollama pull kaelri/hy-mt2.7b-q4_K_M',
  },
};

/** 默认模型出厂一个都不选，全部要用户自己挑。 */
export const EMPTY_DEFAULTS: Defaults = {
  chat: '',
  embedding: '',
  translation: '',
};

/** "providerId::modelId" — split back into its two halves. */
export function splitModelKey(key: string): { providerId: string; model: string } | null {
  const index = key.indexOf('::');
  if (index <= 0) return null;
  return { providerId: key.slice(0, index), model: key.slice(index + 2) };
}

export function joinModelKey(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}
