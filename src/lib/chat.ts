import type { Message, Session, WarehouseReadResult } from '../types';

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

/** Markdown handed to the save dialog when a conversation is exported. */
export function buildSessionMarkdown(
  session: Pick<Session, 'id' | 'title'>,
  messages: Message[],
  modelLabel: string,
): string {
  // Compressed originals stay in the file for search/undo, but they are not
  // part of the visible transcript any more.
  const items = messages.filter(
    (message) => message.sessionId === session.id && !message.hiddenBy,
  );
  const lines = [
    `# ${session.title}`,
    '',
    `- 模型：${modelLabel}`,
    `- 消息数：${items.length}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ];

  for (const message of items) {
    const who = message.role === 'user' ? '用户' : '助手';
    const time = new Date(message.createdAt).toLocaleString('zh-CN');
    if (message.summary) {
      lines.push(
        `## 压缩摘要 · ${time}`,
        '',
        `> 已压缩 ${message.summary.count} 条较早消息（约 ${Math.round(
          message.summary.tokensBefore,
        )} → ${Math.round(message.summary.tokensAfter)} 词元）。`,
        '',
        message.content.trim() || '（空）',
        '',
      );
      continue;
    }
    lines.push(`## ${who} · ${time}`, '', message.content.trim() || '（空）', '');
  }

  return lines.join('\n');
}

/**
 * Token count for the live rate readout. Providers only report exact usage at
 * the very end of a stream, so live rate has to be estimated: CJK characters
 * are close to one token each, everything else averages ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  return cjk + (text.length - cjk) / 4;
}
