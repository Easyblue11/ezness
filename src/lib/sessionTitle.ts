import type { LanguageVars } from '../i18n';

/**
 * A conversation's title is stored text, not a flag. One created before the
 * language pack finished loading — or before the reader switched language —
 * keeps the previous default ("新对话" / "New chat"). Recognise the defaults by
 * value so they can be shown in the language that is active now.
 */
const DEFAULT_TITLES = new Set(['新对话', 'New chat']);

type Translate = (key: string, vars?: LanguageVars) => string;

export function isDefaultTitle(title: string | undefined | null): boolean {
  return DEFAULT_TITLES.has(String(title ?? '').trim());
}

export function sessionTitle(
  title: string | undefined | null,
  t: Translate,
): string {
  return !title || isDefaultTitle(title) ? t('app.session.defaultTitle') : title;
}
