import type { Message, Session } from '../types';

/**
 * A fresh install starts with one empty conversation. Earlier builds seeded
 * demo messages here; those were being sent to the model as real history and
 * derailed the first reply, so they are gone.
 */
export const INITIAL_SESSIONS: Session[] = [
  { id: 's1', title: '新对话', updatedAt: Date.now(), model: '' },
];

export const INITIAL_MESSAGES: Message[] = [];
