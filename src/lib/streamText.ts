import { useSyncExternalStore } from 'react';

/**
 * Text that has arrived but is not part of a message yet.
 *
 * Streaming used to append every delta to the message list, which meant the
 * page that owns the list (App, WorkspacePage) re-rendered twenty times a
 * second. Everything mounted under it re-rendered too, so typing in an
 * unrelated task stuttered whenever any conversation was generating. The live
 * tail now lives here: the streaming bubble subscribes to it and re-renders
 * itself, and the message list is written once when the run ends.
 */
export type StreamText = { content: string; thinking: string; version: number };

const EMPTY: StreamText = { content: '', thinking: '', version: 0 };

const entries = new Map<string, StreamText>();
const listeners = new Map<string, Set<() => void>>();

/** Coarse signal for views that show every run at once (the task bubble). */
let anyVersion = 0;
const anyListeners = new Set<() => void>();

function notify(messageId: string) {
  anyVersion += 1;
  for (const listener of anyListeners) listener();
  const set = listeners.get(messageId);
  if (!set) return;
  for (const listener of set) listener();
}

export function appendStreamText(
  messageId: string,
  kind: 'content' | 'thinking',
  text: string,
): void {
  if (!messageId || !text) return;
  const prev = entries.get(messageId) ?? EMPTY;
  entries.set(messageId, {
    content: kind === 'content' ? prev.content + text : prev.content,
    thinking: kind === 'thinking' ? prev.thinking + text : prev.thinking,
    version: prev.version + 1,
  });
  notify(messageId);
}

export function streamTextOf(messageId: string | null | undefined): StreamText {
  if (!messageId) return EMPTY;
  return entries.get(messageId) ?? EMPTY;
}

export function clearStreamText(messageId: string | null | undefined): void {
  if (!messageId) return;
  if (entries.delete(messageId)) notify(messageId);
}

export function subscribeStreamText(messageId: string, listener: () => void): () => void {
  let set = listeners.get(messageId);
  if (!set) {
    set = new Set();
    listeners.set(messageId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(messageId);
  };
}

/** Live tail for one message; only the component using it re-renders. */
export function useStreamText(messageId: string | null | undefined): StreamText {
  return useSyncExternalStore(
    (listener) =>
      messageId ? subscribeStreamText(messageId, listener) : () => undefined,
    () => streamTextOf(messageId),
    () => EMPTY,
  );
}

/** Re-render whenever any tail grows or is dropped. */
export function useStreamsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      anyListeners.add(listener);
      return () => anyListeners.delete(listener);
    },
    () => anyVersion,
    () => 0,
  );
}

/** Fold the live tail into the stored message, then drop the tail. */
export function takeStreamText(messageId: string | null | undefined): {
  content: string;
  thinking: string;
} {
  const live = streamTextOf(messageId);
  clearStreamText(messageId);
  return { content: live.content, thinking: live.thinking };
}
