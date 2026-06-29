import { resolve, extname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getSetting, setSetting, deleteSetting, recentMessages, recentFeed } from './db.ts';
import { getBotInfo, getRecentChats, getTelegramConfig } from './telegram.ts';
import {
  ENGINE_IDS,
  ENGINE_LABELS,
  getEngineId,
  setEngineId,
  isEngineId,
  isAuthMethod,
  getAuthConfig,
  setAuthMethod,
  setApiKey,
} from './engine.ts';
import { getEngine } from './engines.ts';
import {
  startClaudeLogin,
  submitClaudeLoginCode,
  cancelClaudeLogin,
  claudeLoginStatus,
} from './claude-login.ts';
import {
  startListener,
  isRelayEnabled,
  setRelayEnabled,
  setCaptureMode,
  getCapturedChatId,
  applyBotCommands,
  skipBacklog,
} from './tg-listener.ts';

const PORT = Number(process.env.PORT || 3000);
const CLIENT_DIR = resolve('./dist/client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function readBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function isOnboarded(): boolean {
  return Boolean(getSetting('telegram_bot_token') && getSetting('telegram_chat_id'));
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const m = req.method;

  if (p === '/status' && m === 'GET') {
    const cfg = getTelegramConfig();
    const bot = cfg.botToken
      ? await getBotInfo(cfg.botToken).then((r) => (r.ok ? r.bot : null))
      : null;
    return json({
      onboarded: isOnboarded(),
      bot_token_set: Boolean(cfg.botToken),
      chat_id: cfg.chatId,
      bot,
      relay_enabled: isRelayEnabled(),
      engine: getEngineId(),
      engines: ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id] })),
      auth: getAuthConfig(getEngineId()),
    });
  }

  // Verify a given engine's CLI is installed. `?engine=claude|codex`
  // (defaults to the active engine). `/claude-check` kept as a back-compat alias.
  if ((p === '/agent-check' || p === '/claude-check') && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : p === '/claude-check' ? 'claude' : getEngineId();
    const result = await getEngine(id).check();
    return json(result);
  }

  // Live-probe whether the given engine's CLI is authenticated. Slow (runs a
  // tiny real turn). `?engine=claude|codex` (defaults to the active engine).
  if (p === '/auth-check' && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : getEngineId();
    return json(await getEngine(id).checkAuth());
  }

  // Read the persisted auth setup (method + whether a key is saved) without a
  // probe. Used by the dashboard to render the current setting cheaply.
  if (p === '/auth-config' && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : getEngineId();
    return json(getAuthConfig(id));
  }

  // Update auth setup: switch method and/or save (or clear) the API key.
  if (p === '/auth-config' && m === 'POST') {
    const body = await readBody<{ engine?: string; method?: string; apiKey?: string }>(req);
    const id = (body.engine || getEngineId()).trim();
    if (!isEngineId(id)) return err(400, 'engine must be "claude" or "codex"');
    if (body.method !== undefined) {
      if (!isAuthMethod(body.method)) {
        return err(400, 'method must be "subscription" or "apikey"');
      }
      setAuthMethod(id, body.method);
    }
    // An explicit empty string clears the saved key; undefined leaves it alone.
    if (body.apiKey !== undefined) setApiKey(id, body.apiKey);
    return json({ ok: true, ...getAuthConfig(id) });
  }

  // Claude subscription sign-in, driven from the dashboard (no terminal).
  // Start → returns the authorize URL; the user authorizes and pastes the code.
  if (p === '/auth/claude-login/start' && m === 'POST') {
    try {
      return json(await startClaudeLogin());
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
  }

  if (p === '/auth/claude-login/code' && m === 'POST') {
    const body = await readBody<{ code?: string }>(req);
    const result = await submitClaudeLoginCode(body.code || '');
    if (!result.ok) return err(400, result.error || 'Sign-in failed.');
    return json({ ok: true });
  }

  // Poll the in-progress sign-in: { state: 'idle'|'awaiting'|'done'|'error' }.
  if (p === '/auth/claude-login/status' && m === 'GET') {
    return json(claudeLoginStatus());
  }

  if (p === '/auth/claude-login/cancel' && m === 'POST') {
    cancelClaudeLogin();
    return json({ ok: true });
  }

  if (p === '/engine' && m === 'GET') {
    return json({ engine: getEngineId() });
  }

  if (p === '/engine' && m === 'POST') {
    const body = await readBody<{ engine?: string }>(req);
    const id = (body.engine || '').trim();
    if (!isEngineId(id)) return err(400, 'engine must be "claude" or "codex"');
    setEngineId(id);
    // Sessions don't carry across engines; clear so the next message is fresh.
    deleteSetting('claude_session_id');
    return json({ ok: true, engine: id });
  }

  if (p === '/onboarding/save-token' && m === 'POST') {
    const body = await readBody<{ token?: string }>(req);
    const token = (body.token || '').trim();
    if (!token) return err(400, 'Token required');
    const r = await getBotInfo(token);
    if (!r.ok) return err(400, `Invalid token: ${r.error}`);
    setSetting('telegram_bot_token', token);
    // Reset any prior chat link so capture starts fresh.
    deleteSetting('telegram_chat_id');
    return json({ ok: true, bot: r.bot });
  }

  if (p === '/onboarding/start-capture' && m === 'POST') {
    if (!getSetting('telegram_bot_token')) return err(400, 'Save a bot token first');
    await skipBacklog();
    setCaptureMode(true);
    return json({ ok: true });
  }

  if (p === '/onboarding/captured' && m === 'GET') {
    return json({ chat_id: getCapturedChatId() });
  }

  if (p === '/onboarding/cancel-capture' && m === 'POST') {
    setCaptureMode(false);
    return json({ ok: true });
  }

  if (p === '/relay' && m === 'POST') {
    const body = await readBody<{ enabled?: boolean }>(req);
    const enabled = Boolean(body.enabled);
    if (enabled && !isOnboarded()) return err(400, 'Finish onboarding first');
    setRelayEnabled(enabled);
    if (enabled) {
      await skipBacklog();
      applyBotCommands().catch(() => {});
    }
    return json({ ok: true, enabled });
  }

  if (p === '/reset-session' && m === 'POST') {
    deleteSetting('claude_session_id');
    return json({ ok: true });
  }

  if (p === '/messages' && m === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    return json({ messages: recentMessages(limit) });
  }

  if (p === '/feed' && m === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 300), 1000);
    return json({ events: recentFeed(limit) });
  }

  if (p === '/chats' && m === 'GET') {
    const token = getSetting('telegram_bot_token');
    if (!token) return err(400, 'No bot token');
    const r = await getRecentChats(token);
    if (!r.ok) return err(400, r.error);
    return json({ chats: r.chats });
  }

  if (p === '/reset' && m === 'POST') {
    setRelayEnabled(false);
    deleteSetting('telegram_bot_token');
    deleteSetting('telegram_chat_id');
    deleteSetting('claude_session_id');
    deleteSetting('captured_chat_id');
    deleteSetting('capture_chat_id');
    return json({ ok: true });
  }

  return err(404, 'Not found');
}

function serveStatic(url: URL): Response {
  if (!existsSync(CLIENT_DIR)) {
    return new Response(
      [
        'Client not built yet.',
        '',
        'Run `bun run build` to build the client, or `bun run dev` for hot-reload development.',
        '',
        `Looked in: ${CLIENT_DIR}`,
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
  const safePath = url.pathname.replace(/\.\./g, '');
  let filePath = resolve(CLIENT_DIR, '.' + safePath);
  if (!filePath.startsWith(CLIENT_DIR)) return new Response('Forbidden', { status: 403 });

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    stat = null;
  }

  if (!stat || stat.isDirectory()) {
    filePath = resolve(CLIENT_DIR, 'index.html');
    try {
      stat = statSync(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  const ext = extname(filePath).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  const data = readFileSync(filePath);
  return new Response(data, { headers: { 'Content-Type': ct } });
}

startListener();

// Refresh the Telegram command menu on boot so deploys pick up command changes.
// (Otherwise setMyCommands only runs when the relay is toggled on, leaving the
// menu stale across restarts.)
if (isRelayEnabled()) applyBotCommands().catch(() => {});

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api')) {
      try {
        return await handleApi(req, url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[api] error:', msg);
        return err(500, msg);
      }
    }
    return serveStatic(url);
  },
});

console.log(`coding-agent-telegram-relay listening on http://localhost:${PORT}`);
