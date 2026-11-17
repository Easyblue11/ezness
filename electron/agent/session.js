/**
 * Per-task conversation log.
 *
 * ClawCode persists a session as JSONL and resumes from it. The same idea here:
 * every message the agent loop exchanges — user turns, assistant text, tool
 * calls and tool results — is written to
 * `<data root>/agent/sessions/<taskId>.jsonl`. A follow-up message loads that
 * file instead of the renderer's display transcript, so the agent still knows
 * which files it changed two turns ago.
 *
 * The whole file is rewritten atomically after each step. Files stay small
 * because compaction folds older turns into a summary.
 */

const path = require('node:path');
const fs = require('node:fs/promises');

function safeId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'session';
}

function encode(message) {
  const row = { role: message.role, content: message.content ?? '' };
  // Reasoning is part of the record the director is allowed to see. It is
  // never replayed to the model as history; only the inspector reads it.
  if (String(message.thinking ?? '').trim()) row.thinking = message.thinking;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    row.toolCalls = message.toolCalls;
  }
  if (message.role === 'tool') {
    row.toolCallId = message.toolCallId;
    row.name = message.name;
  }
  return JSON.stringify(row);
}

function decode(line) {
  const row = JSON.parse(line);
  if (!row || typeof row !== 'object' || typeof row.role !== 'string') return null;
  return row;
}

class AgentSession {
  constructor({ dir, sessionId }) {
    this.dir = dir;
    this.sessionId = safeId(sessionId);
    this.file = path.join(dir, `${this.sessionId}.jsonl`);
  }

  async load() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = decode(line);
        if (message) messages.push(message);
      } catch {
        /* a torn last line from a crash — skip it */
      }
    }
    return messages;
  }

  async save(messages) {
    await fs.mkdir(this.dir, { recursive: true });
    const body = messages.map(encode).join('\n');
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, body ? `${body}\n` : '', 'utf8');
    await fs.rename(temp, this.file);
  }

  static async remove(dir, sessionId) {
    const file = path.join(dir, `${safeId(sessionId)}.jsonl`);
    try {
      await fs.rm(file, { force: true });
    } catch {
      /* already gone */
    }
  }
}

module.exports = { AgentSession };
