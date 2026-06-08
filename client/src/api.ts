async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && String((body as any).error)) ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export type BotInfo = { id: number; username: string; first_name: string };

export type Status = {
  onboarded: boolean;
  bot_token_set: boolean;
  chat_id: string | null;
  bot: BotInfo | null;
  relay_enabled: boolean;
};

export type ClaudeCheck = {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
};

export type MessageLogEntry = {
  id: number;
  created_at: number;
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok: boolean;
  error: string | null;
};

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

export const api = {
  status: () => request<Status>('/status'),
  claudeCheck: () => request<ClaudeCheck>('/claude-check'),
  saveToken: (token: string) =>
    request<{ ok: true; bot: BotInfo }>('/onboarding/save-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  startCapture: () =>
    request<{ ok: true }>('/onboarding/start-capture', { method: 'POST' }),
  cancelCapture: () =>
    request<{ ok: true }>('/onboarding/cancel-capture', { method: 'POST' }),
  captured: () => request<{ chat_id: string | null }>('/onboarding/captured'),
  setRelay: (enabled: boolean) =>
    request<{ ok: true; enabled: boolean }>('/relay', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  resetSession: () => request<{ ok: true }>('/reset-session', { method: 'POST' }),
  messages: (limit = 50) =>
    request<{ messages: MessageLogEntry[] }>(`/messages?limit=${limit}`),
  feed: (limit = 300) =>
    request<{ events: FeedEvent[] }>(`/feed?limit=${limit}`),
  reset: () => request<{ ok: true }>('/reset', { method: 'POST' }),
};
