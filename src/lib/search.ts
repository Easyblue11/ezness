import type { Message } from '../types';

/**
 * Both conversation search boxes (对话 sidebar and 工作空间 任务 list) look past
 * the title at what was actually said. A conversation matches when any of its
 * message bodies contains the query; the row then shows the surrounding words
 * so it is obvious why it was listed.
 */

const SNIPPET_BEFORE = 16;
const SNIPPET_AFTER = 46;

/** Group message bodies by conversation, keeping the order they were sent in. */
export function textByConversation(messages: Message[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const message of messages) {
    const text = message.content?.trim();
    if (!text) continue;
    const list = map.get(message.sessionId);
    if (list) list.push(text);
    else map.set(message.sessionId, [text]);
  }
  return map;
}

/**
 * The first body that contains `keyword` (already lower-cased), trimmed to the
 * words around the hit. Empty string when nothing matches.
 */
export function findSnippet(texts: string[] | undefined, keyword: string): string {
  if (!texts || !keyword) return '';
  for (const text of texts) {
    const at = text.toLowerCase().indexOf(keyword);
    if (at === -1) continue;
    const start = Math.max(0, at - SNIPPET_BEFORE);
    const end = Math.min(text.length, at + keyword.length + SNIPPET_AFTER);
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
  }
  return '';
}
