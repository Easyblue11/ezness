import type { Message, Session } from '../types';
import enUS from '../i18n/en-US.json';
import zhCN from '../i18n/zh-CN.json';

/**
 * A fresh install starts with one empty conversation. Earlier builds seeded
 * demo messages here; those were being sent to the model as real history and
 * derailed the first reply, so they are gone.
 */

/** Same key the session list uses for an untouched conversation. */
const NEW_SESSION_KEY = 'app.session.defaultTitle';

const BUILTIN_PACKS: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  'en-US': enUS as unknown as Record<string, unknown>,
};

/**
 * The seed is a module-level constant, so it cannot call the `useI18n` hook.
 * Resolve its single label from the built-in packs synchronously, using the
 * language the app cached for its first paint (see App.tsx).
 */
function initialSessionTitle(): string {
  let language = 'zh-CN';
  try {
    language = window.localStorage.getItem('ezness.language') || language;
  } catch {
    /* storage unavailable: keep the default */
  }
  const pack = BUILTIN_PACKS[language] ?? BUILTIN_PACKS['zh-CN'];
  const value = pack?.[NEW_SESSION_KEY];
  return typeof value === 'string' ? value : '';
}

export const INITIAL_SESSIONS: Session[] = [
  { id: 's1', title: initialSessionTitle(), updatedAt: Date.now(), model: '' },
];

export const INITIAL_MESSAGES: Message[] = [];
