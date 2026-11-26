import type { LanguageVars } from '../i18n';

/**
 * Built-in capability groups carry their Chinese name as a stored identifier:
 * agent definitions keep those names and the main process compares them, so
 * translating the value would break saved agents. Only the label shown on
 * screen is localised; anything unrecognised (a user's own category) is shown
 * exactly as the user named it.
 */
const BUILTIN_CATEGORY_KEYS: Record<string, string> = {
  文件读取: 'category.builtin.readFiles',
  文件修改: 'category.builtin.writeFiles',
  命令执行: 'category.builtin.commands',
  任务管理: 'category.builtin.todos',
  联网: 'category.builtin.web',
  人机交互: 'category.builtin.interaction',
  自定义: 'category.custom',
  未分类: 'category.other',
};

type Translate = (key: string, vars?: LanguageVars) => string;

export function categoryName(name: string, t: Translate): string {
  const key = BUILTIN_CATEGORY_KEYS[name];
  return key ? t(key) : name;
}
