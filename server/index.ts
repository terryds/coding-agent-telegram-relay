import { resolve, extname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getSetting, setSetting, deleteSetting, recentMessages, recentFeed } from './db.ts';
import { getBotInfo, getRecentChats, getTelegramConfig } from './telegram.ts';
import { checkClaudeInstalled } from './claude-runner.ts';
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
    });
  }

  if (p === '/claude-check' && m === 'GET') {
    const result = await checkClaudeInstalled();
    return json(result);
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

console.log(`claude-code-telegram listening on http://localhost:${PORT}`);
