import type {
  Message,
  UsageRecord,
  WorkspaceVizContext,
  WorkspaceVizMessage,
  WorkspaceVizTable,
  WorkspaceVizTask,
} from '../types';
import { isVisible } from './compression';
import { extractMarkdownTables, mergeTables } from './vizTables';

/**
 * Build the bounded context the visualization model gets to see.
 *
 * Two scopes:
 *   task      — only the task whose chat is open. Its transcript gets a much
 *               larger budget and keeps line breaks, because that is where the
 *               user's actual data (tables, figures) lives. Workspace-level
 *               token/cost totals are left out entirely, so the model cannot
 *               fall back to charting "input tokens" instead of the question.
 *   workspace — the previous behaviour: every task, capped per task.
 *
 * Tables found in the transcript are also lifted out into structured rows.
 */

const MAX_TASKS = 30;
const MAX_MESSAGES_PER_TASK = 30;
const MAX_MESSAGES = 160;
const MAX_TEXT = 400;

const MAX_FOCUS_MESSAGES = 24;
const MAX_FOCUS_TEXT = 6000;
const FOCUS_BUDGET = 48000;
const TABLE_PARSE_LIMIT = 16000;

export interface VizWorkspaceLike {
  name: string;
  path: string;
  kind?: string;
}

export interface VizChatLike {
  id: string;
  title: string;
  updatedAt: number;
  todos?: { content: string; status: string }[];
  agentId?: string;
}

export interface WorkspaceVizOptions {
  /** Scope the context to this chat (the task the dialog was opened from). */
  focusChatId?: string;
  /** Tables already parsed from local files. */
  extraTables?: WorkspaceVizTable[];
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** Like clip, but keeps line breaks so tables stay readable for the model. */
function clipBlock(text: string, max: number): string {
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function costOf(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildWorkspaceVizContext(
  workspace: VizWorkspaceLike,
  chats: VizChatLike[],
  messages: Message[],
  usage: UsageRecord[],
  agentName: (id: string) => string | undefined,
  options: WorkspaceVizOptions = {},
): WorkspaceVizContext {
  const focusChat = options.focusChatId
    ? chats.find((chat) => chat.id === options.focusChatId) ?? null
    : null;
  const focusMode = Boolean(focusChat);
  const ordered = focusChat
    ? [focusChat]
    : [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TASKS);
  const ids = new Set(ordered.map((chat) => chat.id));

  const usageBySession = new Map<string, { input: number; output: number; cost: number }>();
  for (const record of usage) {
    if (!record.sessionId || !ids.has(record.sessionId)) continue;
    const entry = usageBySession.get(record.sessionId) ?? { input: 0, output: 0, cost: 0 };
    entry.input += record.inputTokens || 0;
    entry.output += record.outputTokens || 0;
    entry.cost += costOf(record.cost);
    usageBySession.set(record.sessionId, entry);
  }

  const messagesBySession = new Map<string, Message[]>();
  for (const message of messages) {
    if (!ids.has(message.sessionId) || !isVisible(message)) continue;
    const text = String(message.content ?? '').trim();
    if (!text) continue;
    const list = messagesBySession.get(message.sessionId) ?? [];
    list.push(message);
    messagesBySession.set(message.sessionId, list);
  }

  const foundTables: WorkspaceVizTable[] = [];
  const collectTables = (content: string) => {
    if (foundTables.length >= 8) return;
    if (!content.includes('|')) return;
    foundTables.push(...extractMarkdownTables(content.slice(0, TABLE_PARSE_LIMIT), '对话'));
  };

  const tasks: WorkspaceVizTask[] = [];
  const excerpts: WorkspaceVizMessage[] = [];
  let totalMessages = 0;
  let todosDone = 0;
  let todosTotal = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  const topLevel: WorkspaceVizMessage[] = [];
  if (focusMode && focusChat) {
    // The open task's transcript is the subject, so it gets the larger budget
    // and keeps its formatting.
    const all = messagesBySession.get(focusChat.id) ?? [];
    let budget = FOCUS_BUDGET;
    for (const message of all) {
      if (topLevel.length >= MAX_FOCUS_MESSAGES || budget <= 0) break;
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const raw = String(message.content ?? '');
      collectTables(raw);
      const text = clipBlock(raw, Math.min(MAX_FOCUS_TEXT, budget));
      if (!text) continue;
      budget -= text.length;
      topLevel.push({
        task: clip(focusChat.title || '新任务', 60),
        role: message.role,
        text,
        at: message.createdAt || 0,
      });
    }
  } else {
    for (const chat of ordered) {
      const all = messagesBySession.get(chat.id) ?? [];
      const recent = all.slice(-MAX_MESSAGES_PER_TASK);
      for (const message of recent) {
        if (topLevel.length >= MAX_MESSAGES) break;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        collectTables(String(message.content ?? ''));
        const text = clip(String(message.content ?? ''), MAX_TEXT);
        if (!text) continue;
        topLevel.push({
          task: clip(chat.title || '新任务', 60),
          role: message.role,
          text,
          at: message.createdAt || 0,
        });
      }
    }
  }

  for (const chat of ordered) {
    const all = messagesBySession.get(chat.id) ?? [];
    const todos = Array.isArray(chat.todos) ? chat.todos : [];
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const spent = usageBySession.get(chat.id) ?? { input: 0, output: 0, cost: 0 };
    const agent = chat.agentId ? agentName(chat.agentId) : undefined;

    totalMessages += all.length;
    todosTotal += todos.length;
    todosDone += done;
    inputTokens += spent.input;
    outputTokens += spent.output;
    cost += spent.cost;

    tasks.push({
      title: clip(chat.title || '新任务', 80),
      updatedAt: chat.updatedAt || 0,
      messages: all.length,
      todosDone: done,
      todosTotal: todos.length,
      agent,
      inputTokens: spent.input,
      outputTokens: spent.output,
      cost: Math.round(spent.cost * 10000) / 10000,
    });
  }

  // The transcript is shown oldest-first so trends read left to right.
  topLevel.sort((a, b) => a.at - b.at);
  excerpts.push(...topLevel);

  // File tables come first: when the agent wrote data to disk, those rows are
  // the material for the dashboard, and chat tables often just describe the
  // files that were produced.
  const tables = mergeTables(options.extraTables ?? [], foundTables);

  return {
    workspace: {
      name: workspace.name || '未命名工作空间',
      path: workspace.path || '',
      kind: workspace.kind || 'folder',
    },
    generatedAt: Date.now(),
    totals: {
      tasks: ordered.length,
      messages: totalMessages,
      todosDone,
      todosTotal,
      inputTokens,
      outputTokens,
      cost: Math.round(cost * 10000) / 10000,
    },
    tasks,
    messages: excerpts,
    focus: {
      scope: focusMode ? 'task' : 'workspace',
      ...(focusMode && focusChat ? { task: clip(focusChat.title || '新任务', 80) } : {}),
    },
    tables,
  };
}
