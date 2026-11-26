/**
 * Interface text for the main process.
 *
 * The renderer has its own translation runtime; dialogs, tray menus, agent step
 * labels and IPC errors are built here instead, outside it. Those strings need
 * a lookup of their own, so they live in flat JSON packs beside this file.
 *
 * A key missing from English falls back to Chinese, and a key missing from both
 * renders as the key itself — a typo shows up on screen instead of disappearing.
 * Text meant for the model (prompts, tool output) is not here: it never reaches
 * the interface.
 */
const zh = require('./ui-text.zh.json');
const en = require('./ui-text.en.json');

const PACKS = { zh, en };
const FALLBACK_ORDER = { zh: ['zh'], en: ['en', 'zh'] };

let language = '';

/**
 * 'zh' | 'en' | ''. Only the two built-in packs exist here; a custom language
 * pack is a renderer-only file, so those fall back to English rather than
 * showing Chinese inside an otherwise foreign interface.
 */
function normalizeLanguage(value) {
  const text = String(value ?? '').trim();
  if (/^zh/i.test(text)) return 'zh';
  if (/^en/i.test(text)) return 'en';
  return '';
}

/** Chosen language, or the build's default when nothing was saved yet. */
function getLanguage() {
  if (language) return language;
  try {
    const { app } = require('electron');
    return app?.isPackaged ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function setLanguage(value) {
  language = normalizeLanguage(value);
  return getLanguage();
}

function lookup(key) {
  for (const code of FALLBACK_ORDER[getLanguage()]) {
    const value = PACKS[code][key];
    if (typeof value === 'string') return value;
  }
  return key;
}

/** `{name}` / `{count}` placeholders are replaced from `vars`. */
function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

function t(key, vars) {
  return fill(lookup(key), vars);
}

/** Whether the pack actually has this key (used by tests and callers that care). */
function has(key) {
  return FALLBACK_ORDER[getLanguage()].some((code) => typeof PACKS[code][key] === 'string');
}

module.exports = { t, has, setLanguage, getLanguage, normalizeLanguage };
