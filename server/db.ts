import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClaudeStep } from './claude-stream.ts';

const DATA_DIR = resolve('./data');
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = resolve(DATA_DIR, 'app.db');
export const db = new Database(dbPath, { create: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    session_id TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT
  )
`);

db.run('CREATE INDEX IF NOT EXISTS idx_message_log_created_at ON message_log(created_at DESC)');

// Intermediate steps streamed from Claude during a run (thinking, tool calls,
// tool results) — the same events forwarded live to Telegram. Final text
// replies are NOT stored here; they live in message_log as `out` rows.
db.run(`
  CREATE TABLE IF NOT EXISTS step_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    session_id TEXT,
    kind TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    result_text TEXT
  )
`);

db.run('CREATE INDEX IF NOT EXISTS idx_step_log_created_at ON step_log(created_at DESC)');

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export type MessageLogEntry = {
  id: number;
  created_at: number;
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok: boolean;
  error: string | null;
};

export function logMessage(entry: {
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok?: boolean;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO message_log (created_at, direction, text, session_id, ok, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    entry.direction,
    entry.text,
    entry.session_id,
    entry.ok === false ? 0 : 1,
    entry.error ?? null
  );
}

/** Persist one streamed step. `text` steps are skipped (the final reply is
 *  stored as a message_log `out` row, so storing it here would duplicate it). */
export function logStep(step: ClaudeStep, sessionId: string | null): void {
  if (step.kind === 'text') return;
  db.prepare(
    `INSERT INTO step_log (created_at, session_id, kind, tool_name, tool_input, result_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    sessionId,
    step.kind,
    step.toolName ?? null,
    step.toolInput ?? null,
    step.resultText ?? null
  );
}

export type FeedEvent =
  | {
      etype: 'message';
      id: number;
      created_at: number;
      direction: 'in' | 'out';
      text: string;
      session_id: string | null;
      ok: boolean;
      error: string | null;
    }
  | {
      etype: 'step';
      id: number;
      created_at: number;
      session_id: string | null;
      kind: 'thinking' | 'tool_use' | 'tool_result';
      tool_name: string | null;
      tool_input: string | null;
      result_text: string | null;
    };

/**
 * Merged, time-ordered feed of messages and steps — the dashboard equivalent of
 * the live Telegram stream. Returns the most recent `limit` events in
 * chronological (oldest-first) order.
 */
export function recentFeed(limit = 300): FeedEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT 'message' AS etype, id, created_at, direction, text, session_id, ok,
                NULL AS kind, NULL AS tool_name, NULL AS tool_input, NULL AS result_text, error
         FROM message_log
         UNION ALL
         SELECT 'step' AS etype, id, created_at, NULL, NULL, session_id, NULL,
                kind, tool_name, tool_input, result_text, NULL
         FROM step_log
       )
       ORDER BY created_at DESC, etype DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    etype: 'message' | 'step';
    id: number;
    created_at: number;
    direction: 'in' | 'out' | null;
    text: string | null;
    session_id: string | null;
    ok: number | null;
    kind: 'thinking' | 'tool_use' | 'tool_result' | null;
    tool_name: string | null;
    tool_input: string | null;
    result_text: string | null;
    error: string | null;
  }>;

  // Query is newest-first for the LIMIT; flip to chronological for display.
  return rows.reverse().map((r): FeedEvent =>
    r.etype === 'message'
      ? {
          etype: 'message',
          id: r.id,
          created_at: r.created_at,
          direction: r.direction as 'in' | 'out',
          text: r.text ?? '',
          session_id: r.session_id,
          ok: r.ok === 1,
          error: r.error,
        }
      : {
          etype: 'step',
          id: r.id,
          created_at: r.created_at,
          session_id: r.session_id,
          kind: r.kind as 'thinking' | 'tool_use' | 'tool_result',
          tool_name: r.tool_name,
          tool_input: r.tool_input,
          result_text: r.result_text,
        }
  );
}

export function recentMessages(limit = 50): MessageLogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, direction, text, session_id, ok, error
       FROM message_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    created_at: number;
    direction: 'in' | 'out';
    text: string;
    session_id: string | null;
    ok: number;
    error: string | null;
  }>;
  return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
}
