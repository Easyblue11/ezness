import type { Message, Session, WarehouseReadResult } from '../types';
import { streamTextOf } from './streamText';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Rendering context for an exported transcript; the UI supplies both. */
export interface SessionMarkdownOptions {
  t: Translate;
  locale: string;
}

/**
 * Attachment text goes into the user turn, so every later message in the
 * session carries it again. 32k characters keeps a couple of normal documents
 * in context without crowding out the conversation on a 64k-token model.
 */
const ATTACHMENT_CHAR_BUDGET = 32_000;

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function buildAttachmentContext(reads: WarehouseReadResult[]): string {
  if (reads.length === 0) return '';

  const blocks: string[] = [];
  let budget = ATTACHMENT_CHAR_BUDGET;

  // The stored file is reachable by path; tools that need the real file
  // (a .pptx template, an .xlsx, an image) must be pointed at it instead of
  // searching the workspace for something that was never there.
  const locate = (read: WarehouseReadResult) =>
    read.path ? `\n｜文件路径：${read.path}（工具直接用它，不要去工作空间里找）` : '';

  for (const read of reads) {
    if (!read.ok) {
      blocks.push(
        `【附件：${read.name}】未能读取内容（${read.error ?? '未知原因'}）${locate(read)}`,
      );
      continue;
    }

    let body = read.text ?? '';
    if (budget <= 0) {
      blocks.push(`【附件：${read.name}】前面的附件已经用完本轮长度预算，这个文件没有放进上下文`);
      continue;
    }

    const cut = read.truncated || body.length > budget;
    if (body.length > budget) body = body.slice(0, budget);
    budget -= body.length;
    const tag = read.ocr ? ' · 本地 OCR' : '';
    const note = read.note ? `\n（${read.note}）` : '';
    blocks.push(
      `【附件：${read.name}（${formatBytes(read.size)}${tag}）】${locate(read)}\n${body}${note}${cut ? '\n…（内容较长，已截断）' : ''}`,
    );
  }

  return ['以下是用户在本条消息里附带的文件内容：', ...blocks].join('\n\n');
}

/**
 * English fallbacks for callers that do not pass a translator yet. Keeping them
 * here means an export never prints a raw i18n key.
 */
const FALLBACK_EXPORT: Record<string, string> = {
  'app.export.model': 'Model: {model}',
  'app.export.messageCount': 'Messages: {count}',
  'app.export.exportedAt': 'Exported: {time}',
  'app.export.user': 'User',
  'app.export.assistant': 'Assistant',
  'app.export.summaryHeading': 'Compressed summary · {time}',
  'app.export.summaryNote': '> Folded {count} earlier messages (about {before} → {after} tokens).',
  'app.export.empty': '(empty)',
};

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function fallbackTranslate(key: string, vars?: Record<string, string | number>): string {
  const text = FALLBACK_EXPORT[key] ?? key;
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
}

/** Markdown handed to the save dialog when a conversation is exported. */
export function buildSessionMarkdown(
  session: Pick<Session, 'id' | 'title'>,
  messages: Message[],
  modelLabel: string,
  i18n?: SessionMarkdownOptions,
): string {
  const t = i18n?.t ?? fallbackTranslate;
  const locale = i18n?.locale ?? 'en-US';
  // Compressed originals stay in the file for search/undo, but they are not
  // part of the visible transcript any more.
  const items = messages.filter(
    (message) => message.sessionId === session.id && !message.hiddenBy,
  );
  const lines = [
    `# ${session.title}`,
    '',
    `- ${t('app.export.model', { model: modelLabel })}`,
    `- ${t('app.export.messageCount', { count: items.length })}`,
    `- ${t('app.export.exportedAt', { time: new Date().toLocaleString(locale) })}`,
    '',
  ];

  for (const message of items) {
    const who = message.role === 'user' ? t('app.export.user') : t('app.export.assistant');
    const time = new Date(message.createdAt).toLocaleString(locale);
    // A run that is still writing lives outside the message list; an export
    // taken mid-answer should still contain what is already on screen.
    const content = message.content + streamTextOf(message.id).content;
    if (message.summary) {
      lines.push(
        `## ${t('app.export.summaryHeading', { time })}`,
        '',
        t('app.export.summaryNote', {
          count: message.summary.count,
          before: Math.round(message.summary.tokensBefore),
          after: Math.round(message.summary.tokensAfter),
        }),
        '',
        message.content.trim() || t('app.export.empty'),
        '',
      );
      continue;
    }
    lines.push(`## ${who} · ${time}`, '', content.trim() || t('app.export.empty'), '');
  }

  return lines.join('\n');
}

/**
 * Token count for the live rate readout. Providers only report exact usage at
 * the very end of a stream, so live rate has to be estimated: CJK characters
 * are close to one token each, everything else averages ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u8c48-\ufaff]/g)?.length ?? 0;
  return cjk + (text.length - cjk) / 4;
}
