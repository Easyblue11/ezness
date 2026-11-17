import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Only the languages that plausibly show up in a chat; core stays small. */
const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

/**
 * Fence tags models actually emit that are not highlight.js aliases. Without
 * this a ```node block (the natural tag for a custom Node tool) came out as
 * plain white text.
 */
const ALIASES: Record<string, string> = {
  node: 'javascript',
  nodejs: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  tsx: 'typescript',
  golang: 'go',
  pwsh: 'powershell',
  ps1: 'powershell',
  docker: 'dockerfile',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  yml: 'yaml',
  kt: 'kotlin',
  rs: 'rust',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  cs: 'csharp',
  'c++': 'cpp',
};

/** Fences that are not code at all: colouring them would only add noise. */
const PLAIN_LANGUAGES = new Set(['text', 'plaintext', 'plain', 'txt', 'none']);

/** Auto-detection only runs over this subset; the full set is too slow. */
const AUTO_SUBSET = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'php',
  'powershell',
  'python',
  'ruby',
  'rust',
  'sql',
  'typescript',
  'xml',
  'yaml',
];

/** Highlighting a huge block on every streamed token is not worth the jank. */
const MAX_LENGTH = 20_000;
const MAX_AUTO_LENGTH = 8_000;

/** A previewed file is highlighted once, so it can carry a much larger cap. */
const FILE_MAX_LENGTH = 240_000;
const FILE_MAX_AUTO_LENGTH = 60_000;

/** Files that name their language instead of carrying a useful extension. */
const FILE_NAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'bash',
  gnumakefile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.bash_profile': 'bash',
  '.env': 'ini',
};

/** Text formats where colouring the content would only add noise. */
const PLAIN_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'gitignore',
  'gitattributes',
  'npmrc',
  'editorconfig',
  'license',
  'lock',
]);

/** Extensions highlight.js does not register under the same name. */
const FILE_EXTENSION_ALIASES: Record<string, string> = {
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  toml: 'ini',
  env: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  svelte: 'xml',
  astro: 'xml',
  gradle: 'java',
  bat: 'bash',
  cmd: 'bash',
};

function resolveLanguage(language: string): string {
  const lang = language.trim().toLowerCase();
  if (!lang) return '';
  const mapped = ALIASES[lang] ?? lang;
  return hljs.getLanguage(mapped) ? mapped : '';
}

/**
 * Picks a language from a file name: exact name first, then extension.
 * `plain` marks formats (txt, log, .gitignore …) that must not be guessed,
 * otherwise auto-detection colours prose as code.
 */
function languageForFile(fileName: string): { language: string; plain: boolean } {
  const lower = fileName.trim().toLowerCase();
  const base = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1);

  const named = FILE_NAME_LANGUAGES[base];
  if (named) return { language: resolveLanguage(named), plain: false };

  const dot = base.lastIndexOf('.');
  if (dot < 0) return { language: '', plain: true };
  const extension = base.slice(dot + 1);
  if (PLAIN_EXTENSIONS.has(extension)) return { language: '', plain: true };

  return {
    language: resolveLanguage(FILE_EXTENSION_ALIASES[extension] ?? extension),
    plain: false,
  };
}

/** Human-readable language name, e.g. `typescript` → `TypeScript`. */
export function languageDisplayName(language: string): string {
  if (!language) return '';
  return hljs.getLanguage(language)?.name ?? language;
}

/** Shared auto-detection with the JS-over-C-family correction. */
function detectLanguage(code: string): HighlightedBlock | null {
  const detected = hljs.highlightAuto(code, AUTO_SUBSET);
  if (!detected.language) return null;
  if (C_FAMILY.has(detected.language) && JS_HINTS.test(code)) {
    return {
      html: hljs.highlight(code, { language: 'javascript', ignoreIllegals: true }).value,
      language: 'javascript',
    };
  }
  return { html: detected.value, language: detected.language };
}

/**
 * Detectors confuse JavaScript with C-family languages (`const`, braces), so
 * a model answer with an untagged Node snippet was labelled `cpp`. Strong JS
 * signals win over the score in that case.
 */
const JS_HINTS = /(?:console\.|require\(|module\.exports|process\.(?:env|argv)|JSON\.|=>|\bimport\s+.+?\s+from\b|\bexport\s+(?:default|const|function)\b)/;
const C_FAMILY = new Set(['c', 'cpp', 'csharp', 'java', 'objectivec', 'kotlin']);

export interface HighlightedBlock {
  html: string;
  /** The language that was actually used — auto-detected when the fence had none. */
  language: string;
}

/**
 * Returns escaped HTML with `hljs-*` spans for a fenced block.
 *
 * - Known tag (including aliases such as `node`, `py`, `html`) → highlight it.
 * - Missing or unknown tag → detect the language, so model output without a
 *   fence tag is still coloured instead of rendering as plain white text.
 * - Plain-text tags or oversized blocks → null, the caller renders the raw text.
 */
export function highlightBlock(code: string, language: string): HighlightedBlock | null {
  if (!code.trim() || code.length > MAX_LENGTH) return null;

  const requested = language.trim().toLowerCase();
  if (PLAIN_LANGUAGES.has(requested)) return null;

  const resolved = resolveLanguage(requested);
  try {
    if (resolved) {
      return {
        html: hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value,
        language: resolved,
      };
    }
    if (code.length > MAX_AUTO_LENGTH) return null;
    return detectLanguage(code);
  } catch {
    return null;
  }
}

/**
 * Highlights a file previewed from the workspace tree. The language comes from
 * the file name; unknown extensions are detected. Plain-text formats and files
 * over the cap stay unhighlighted so large files open instantly.
 */
export function highlightFile(code: string, fileName: string): HighlightedBlock | null {
  if (!code.trim() || code.length > FILE_MAX_LENGTH) return null;

  const { language, plain } = languageForFile(fileName);
  if (plain) return null;

  try {
    if (language) {
      return {
        html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
        language,
      };
    }
    if (code.length > FILE_MAX_AUTO_LENGTH) return null;
    return detectLanguage(code);
  } catch {
    return null;
  }
}
