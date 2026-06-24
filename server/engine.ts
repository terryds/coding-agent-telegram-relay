/**
 * Shared types and selection logic for pluggable coding-agent engines.
 *
 * The relay can drive either Claude Code or Codex. Both follow the same model:
 * spawn a CLI once per Telegram message, stream intermediate steps (thinking,
 * tool calls, results) back live, and return a final result. Conversations are
 * continued by resuming a session id. A single global engine is active at a
 * time (stored in settings); the user switches it via the dashboard or the
 * `/engine` Telegram command.
 */
import { getSetting, setSetting } from './db.ts';

export type EngineId = 'claude' | 'codex';

export const ENGINE_IDS: EngineId[] = ['claude', 'codex'];

export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export function isEngineId(v: string): v is EngineId {
  return v === 'claude' || v === 'codex';
}

// ── Streamed steps ──────────────────────────────────────────────────

export type StepKind = 'thinking' | 'tool_use' | 'tool_result' | 'text';

export type EngineStep = {
  kind: StepKind;
  ts: string; // HH:MM:SS
  toolName?: string; // for tool_use
  toolInput?: string; // truncated input
  resultText?: string; // for tool_result
  text?: string; // for text blocks
};

export type OnStep = (step: EngineStep) => void | Promise<void>;

// ── Results ─────────────────────────────────────────────────────────

export type AskQuestionOption = { label: string; description?: string };
export type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
};

export type EngineResult =
  | { ok: true; text: string; session_id: string | null; questions?: AskQuestion[] }
  | { ok: false; error: string; aborted?: boolean; staleSession?: boolean };

export type EngineCheck = {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
};

/** One pluggable coding agent. */
export interface Engine {
  id: EngineId;
  label: string;
  /** Verify the CLI is installed and usable. */
  check(): Promise<EngineCheck>;
  /**
   * Run one turn. Streams steps via `onStep` while working, honours `signal`
   * for user-initiated stops, and resolves with the final result. `sessionId`
   * is null for a fresh conversation, otherwise the id to resume.
   */
  run(
    prompt: string,
    sessionId: string | null,
    signal: AbortSignal | undefined,
    onStep: OnStep
  ): Promise<EngineResult>;
}

// ── Selection ───────────────────────────────────────────────────────

const ENGINE_KEY = 'engine';

export function getEngineId(): EngineId {
  const v = getSetting(ENGINE_KEY);
  return v && isEngineId(v) ? v : 'claude';
}

export function setEngineId(id: EngineId): void {
  setSetting(ENGINE_KEY, id);
}

/** Current HH:MM:SS, for steps whose source events carry no timestamp. */
export function nowTs(): string {
  return new Date().toISOString().slice(11, 19);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
