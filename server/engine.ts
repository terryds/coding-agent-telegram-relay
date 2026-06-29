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
import { getSetting, setSetting, deleteSetting } from './db.ts';

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

// ── Auth ────────────────────────────────────────────────────────────

export type AuthMethod = 'subscription' | 'apikey';

/** Result of a live auth probe (a real one-shot run against the CLI). */
export type EngineAuth = {
  /** The probe completed a turn successfully — the CLI is usable. */
  authed: boolean;
  /** The configured auth method for this engine. */
  method: AuthMethod;
  /** Whether an API key is saved (only meaningful when method === 'apikey'). */
  hasKey: boolean;
  /** Explanation surfaced when not authed (the CLI's error, or a hint). */
  error?: string;
};

/** Persisted auth setup for an engine, without running a probe. */
export type AuthConfig = { method: AuthMethod; hasKey: boolean };

/** One pluggable coding agent. */
export interface Engine {
  id: EngineId;
  label: string;
  /** Verify the CLI is installed and usable. */
  check(): Promise<EngineCheck>;
  /**
   * Live-probe whether the CLI is authenticated, using the engine's configured
   * auth method (subscription login, or an injected saved API key). Runs a
   * tiny one-shot turn, so it is slow and consumes one request.
   */
  checkAuth(): Promise<EngineAuth>;
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

// ── Auth config (per-engine, persisted) ─────────────────────────────

/** Env var each CLI reads its API key from when using API-key auth. */
export const API_KEY_ENV: Record<EngineId, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

export function isAuthMethod(v: string): v is AuthMethod {
  return v === 'subscription' || v === 'apikey';
}

const authMethodKey = (id: EngineId) => `auth_method_${id}`;
const apiKeyKey = (id: EngineId) => `api_key_${id}`;
const oauthTokenKey = (id: EngineId) => `oauth_token_${id}`;

export function getAuthMethod(id: EngineId): AuthMethod {
  const v = getSetting(authMethodKey(id));
  return v && isAuthMethod(v) ? v : 'subscription';
}

export function setAuthMethod(id: EngineId, method: AuthMethod): void {
  setSetting(authMethodKey(id), method);
}

export function getApiKey(id: EngineId): string | null {
  return getSetting(apiKeyKey(id));
}

/** Save (or, with an empty string, clear) the API key for an engine. */
export function setApiKey(id: EngineId, key: string): void {
  const k = key.trim();
  if (k) setSetting(apiKeyKey(id), k);
  else deleteSetting(apiKeyKey(id));
}

/**
 * A long-lived subscription OAuth token (Claude's `setup-token` output). When
 * set, it's injected as CLAUDE_CODE_OAUTH_TOKEN so the relay authenticates with
 * the subscription without relying on on-disk credentials. Only Claude uses it.
 */
export function getOauthToken(id: EngineId): string | null {
  return getSetting(oauthTokenKey(id));
}

export function setOauthToken(id: EngineId, token: string): void {
  const t = token.trim();
  if (t) setSetting(oauthTokenKey(id), t);
  else deleteSetting(oauthTokenKey(id));
}

export function getAuthConfig(id: EngineId): AuthConfig {
  return { method: getAuthMethod(id), hasKey: Boolean(getApiKey(id)) };
}

/**
 * Env overrides to apply when spawning the CLI:
 *  - API-key auth: inject the saved key under the var the CLI reads.
 *  - Subscription auth: nothing, unless we captured a long-lived OAuth token
 *    (Claude), in which case inject it. The CLI otherwise uses its own login.
 */
export function authEnv(id: EngineId): Record<string, string> {
  if (getAuthMethod(id) === 'apikey') {
    const key = getApiKey(id);
    return key ? { [API_KEY_ENV[id]]: key } : {};
  }
  if (id === 'claude') {
    const token = getOauthToken('claude');
    if (token) return { CLAUDE_CODE_OAUTH_TOKEN: token };
  }
  return {};
}

/** Current HH:MM:SS, for steps whose source events carry no timestamp. */
export function nowTs(): string {
  return new Date().toISOString().slice(11, 19);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
