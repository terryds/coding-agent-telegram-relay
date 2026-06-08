import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSetting, setSetting, db, logMessage, logStep } from './db.ts';
import {
  getTelegramConfig,
  getUpdatesRaw,
  sendTelegram,
  sendTelegramPlain,
  sendChatAction,
  setMyCommands,
  downloadTelegramFile,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram.ts';
import { runClaudeHeadless } from './claude-runner.ts';
import { watchSession, type ClaudeStep } from './claude-stream.ts';

const INCOMING_DIR = resolve('./data/incoming');
mkdirSync(INCOMING_DIR, { recursive: true });

const TG_OFFSET_KEY = 'telegram_update_offset';
const CLAUDE_SESSION_KEY = 'claude_session_id';
const ENABLED_KEY = 'relay_enabled';
const CAPTURE_KEY = 'capture_chat_id';
const CAPTURED_KEY = 'captured_chat_id';

export function isRelayEnabled(): boolean {
  return getSetting(ENABLED_KEY) === '1';
}

export function setRelayEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled ? '1' : '0');
}

export function setCaptureMode(on: boolean): void {
  if (on) {
    setSetting(CAPTURE_KEY, '1');
    db.prepare('DELETE FROM settings WHERE key = ?').run(CAPTURED_KEY);
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(CAPTURE_KEY);
  }
}

export function getCapturedChatId(): string | null {
  return getSetting(CAPTURED_KEY);
}

function isCapturing(): boolean {
  return getSetting(CAPTURE_KEY) === '1';
}

function setOffset(id: number): void {
  setSetting(TG_OFFSET_KEY, String(id));
}

function getOffset(): number {
  return Number(getSetting(TG_OFFSET_KEY) || '0') || 0;
}

let listenerLoopRunning = false;

export function startListener(): void {
  if (listenerLoopRunning) return;
  listenerLoopRunning = true;
  console.log('[tg-listener] loop started');
  loop().catch((err) => {
    console.error('[tg-listener] loop crashed:', err);
    listenerLoopRunning = false;
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


// ── Live step streaming ─────────────────────────────────────────────

const MAX_TG = 4000;

function formatStep(step: ClaudeStep): string {
  switch (step.kind) {
    case 'thinking':
      return `🧠 <i>thinking…</i>`;
    case 'tool_use': {
      const name = escapeHtml(step.toolName ?? '?');
      const input = escapeHtml(step.toolInput ?? '');
      return `🛠 <b>${name}</b>\n<pre>${input.slice(0, MAX_TG - 200)}</pre>`;
    }
    case 'tool_result': {
      const txt = escapeHtml(step.resultText ?? '');
      return `✅ <pre>${txt.slice(0, MAX_TG - 100)}</pre>`;
    }
    case 'text': {
      // The final text response will be sent separately by the caller,
      // so skip it here to avoid duplication.
      return '';
    }
    default:
      return '';
  }
}

/** Rate-limiter: avoid hitting Telegram's flood limits (~30 msg/s). */
let lastStepSentAt = 0;
const MIN_STEP_INTERVAL_MS = 500;

async function sendStep(step: ClaudeStep): Promise<void> {
  const msg = formatStep(step);
  if (!msg) return;
  // Throttle
  const now = Date.now();
  const wait = MIN_STEP_INTERVAL_MS - (now - lastStepSentAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastStepSentAt = Date.now();
  const r = await sendTelegram(msg);
  if (!r.ok) console.error(`[tg-listener] step send failed: ${r.error}`);
}

// ── Active run tracking ─────────────────────────────────────────────
//
// The poll loop must keep receiving updates while Claude works, so a run
// executes in the background (not awaited by the loop) and registers itself
// here. A `/stop` command — or a new prompt (auto-stop & replace) — aborts it.

type ActiveRun = { abort: AbortController; stop: () => void };
let activeRun: ActiveRun | null = null;

/**
 * Abort the current run, if any, and stop its stream watcher synchronously so
 * it can't overlap with a replacement run on the same session file.
 * Returns true if a run was actually stopped.
 */
function stopActiveRun(): boolean {
  const run = activeRun;
  if (!run) return false;
  activeRun = null; // claim it so the run's own cleanup won't double-clear
  run.abort.abort();
  run.stop();
  return true;
}

/**
 * Run Claude in the background with live step-by-step output to Telegram,
 * watching the JSONL session file while claude-runner executes. Does not block
 * the caller — the poll loop stays free to receive /stop and new messages.
 */
function startClaudeRun(prompt: string, sessionId: string | null): void {
  // Auto-stop & replace: cancel whatever is already running.
  stopActiveRun();

  const abort = new AbortController();
  const run: ActiveRun = { abort, stop: () => {} };
  activeRun = run;

  void (async () => {
    const sid = sessionId ?? 'unknown';
    // Persist every step for the dashboard feed, then forward it to Telegram.
    // Persisting first (and synchronously) keeps DB order correct even though
    // sendStep is throttled.
    const onStep = async (step: ClaudeStep) => {
      logStep(step, sessionId);
      await sendStep(step);
    };
    const stopWatch = await watchSession(sid, onStep);
    let watcherStopped = false;
    run.stop = () => {
      if (watcherStopped) return;
      watcherStopped = true;
      stopWatch();
    };
    // If we were aborted while the watcher was starting up, stop immediately.
    if (abort.signal.aborted) run.stop();

    await sendChatAction('typing');
    const typing = setInterval(() => {
      sendChatAction('typing').catch(() => {});
    }, 4000);

    let result: Awaited<ReturnType<typeof runClaudeHeadless>>;
    try {
      result = await runClaudeHeadless(prompt, sessionId, abort.signal);
    } finally {
      clearInterval(typing);
      // Give the watcher a beat to flush final writes — but not when aborted,
      // since a replacement run may already be watching the same file.
      if (!abort.signal.aborted) await sleep(1000);
      run.stop();
      if (activeRun === run) activeRun = null;
    }

    await deliverResult(result);
  })().catch((err) => {
    console.error('[tg-listener] claude run crashed:', err);
    if (activeRun === run) activeRun = null;
  });
}

/** Send Claude's result (or error) back to Telegram and log it. */
async function deliverResult(
  result: Awaited<ReturnType<typeof runClaudeHeadless>>,
): Promise<void> {
  if (result.ok) {
    if (result.session_id) setSetting(CLAUDE_SESSION_KEY, result.session_id);
    const body = result.text || '(Claude returned an empty response)';
    const r = await sendTelegramPlain(body);
    logMessage({
      direction: 'out',
      text: body,
      session_id: result.session_id,
      ok: r.ok,
      error: r.error ?? null,
    });
    if (!r.ok) console.error(`[tg-listener] send failed: ${r.error}`);
    return;
  }

  logMessage({
    direction: 'out',
    text: '',
    session_id: null,
    ok: false,
    error: result.error,
  });
  // Aborted runs were stopped on purpose; the /stop or replacement message
  // already acknowledged that, so don't surface a scary error.
  if (result.aborted) return;
  await sendTelegram(`⚠️ <b>Claude error</b>\n${escapeHtml(result.error)}`);
}

async function loop(): Promise<void> {
  while (listenerLoopRunning) {
    const { botToken, chatId } = getTelegramConfig();
    const capturing = isCapturing();

    if (!botToken) {
      await sleep(5000);
      continue;
    }
    // We poll if either we're capturing (onboarding) or relaying is enabled.
    if (!capturing && (!isRelayEnabled() || !chatId)) {
      await sleep(3000);
      continue;
    }

    const r = await getUpdatesRaw(getOffset(), 25);
    if (!r.ok) {
      console.error(`[tg-listener] getUpdates failed: ${r.error}`);
      await sleep(5000);
      continue;
    }
    if (r.updates.length === 0) continue;

    for (const upd of r.updates) {
      // Persist offset BEFORE processing so we don't replay this update if
      // bun is killed mid-process (e.g. by pm2 restart during a long claude
      // call). Trade-off: in-flight messages get dropped on crash instead of
      // retried, which is far better than the alternative of infinite replay
      // when the same message keeps killing the relay.
      setOffset(upd.update_id + 1);
      try {
        await processUpdate(upd, chatId);
      } catch (err) {
        console.error('[tg-listener] process error:', err);
      }
    }
  }
}

async function processUpdate(upd: TelegramUpdate, expectedChatId: string | null): Promise<void> {
  const msg = upd.message;
  if (!msg) return;

  const incomingChatId = String(msg.chat.id);

  // Onboarding capture: the first message during capture mode wins.
  if (isCapturing()) {
    setSetting(CAPTURED_KEY, incomingChatId);
    setSetting('telegram_chat_id', incomingChatId);
    db.prepare('DELETE FROM settings WHERE key = ?').run(CAPTURE_KEY);
    // Acknowledge via the token used for this very chat — sendTelegram reads chat_id from settings.
    await sendTelegram(
      [
        '✅ <b>Chat linked!</b>',
        '',
        `Chat ID: <code>${incomingChatId}</code>`,
        '',
        'Onboarding complete. Head back to the dashboard to enable the relay.',
      ].join('\n')
    );
    return;
  }

  if (!expectedChatId) return;
  if (incomingChatId !== expectedChatId) {
    console.log(`[tg-listener] ignored message from unauthorized chat ${incomingChatId}`);
    return;
  }

  if (!isRelayEnabled()) return;

  const text = (msg.text ?? '').trim();
  const caption = (msg.caption ?? '').trim();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

  if (!text && !hasPhoto) return;

  if (text === '/stop' || text.startsWith('/stop ')) {
    if (stopActiveRun()) {
      await sendTelegram('🛑 <b>Stopped.</b> Claude was interrupted.');
    } else {
      await sendTelegram('💤 Nothing is running right now.');
    }
    return;
  }

  if (text === '/new_session' || text.startsWith('/new_session ')) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(CLAUDE_SESSION_KEY);
    await sendTelegram(
      '🔄 <b>New conversation started.</b>\nThe next message will begin a fresh Claude session.'
    );
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendTelegram(
      [
        '<b>Claude Code Telegram Relay</b>',
        '',
        "Send a message and I'll relay it to Claude Code running on your VPS.",
        '',
        'You can also send photos (with or without a caption) — they get saved to disk and the file path is passed to Claude.',
        '',
        'Commands:',
        '  /stop — interrupt Claude while it\'s working',
        '  /new_session — start a fresh Claude conversation',
        '  /help — show this message',
      ].join('\n')
    );
    return;
  }

  const prompt = hasPhoto ? await buildPhotoPrompt(msg, caption || text) : text;
  if (!prompt) return;

  logMessage({ direction: 'in', text: prompt, session_id: getSetting(CLAUDE_SESSION_KEY) });

  const sessionId = getSetting(CLAUDE_SESSION_KEY);

  // Auto-stop & replace: a fresh prompt cancels whatever is still running.
  if (activeRun) {
    await sendTelegram('🛑 Stopping the previous task and starting the new one…');
  }

  console.log(
    `[tg-listener] → claude (${sessionId ? 'resume ' + sessionId.slice(0, 8) : 'new session'}): ${prompt.slice(0, 80)}`
  );

  // Fire-and-forget: the run streams its own output and the poll loop stays
  // free to receive /stop and further messages.
  startClaudeRun(prompt, sessionId);
}

async function buildPhotoPrompt(msg: TelegramMessage, userText: string): Promise<string> {
  const photos = msg.photo ?? [];
  // Telegram returns photos sorted ascending by size; the largest is best for vision.
  const largest = photos[photos.length - 1];
  if (!largest) return userText;

  const ext = '.jpg'; // Telegram always converts photos to JPEG
  const destPath = resolve(INCOMING_DIR, `${largest.file_unique_id}${ext}`);
  const dl = await downloadTelegramFile(largest.file_id, destPath);
  if (!dl.ok) {
    await sendTelegram(`⚠️ <b>Failed to download photo</b>\n${escapeHtml(dl.error)}`);
    return '';
  }

  const ref = `An image was attached at: ${destPath}\nUse your Read tool to view it.`;
  return userText ? `${ref}\n\n${userText}` : `${ref}\n\nNo caption was provided — describe what you see, or wait for follow-up instructions.`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function applyBotCommands(): Promise<void> {
  await setMyCommands([
    { command: 'stop', description: 'Interrupt Claude while it is working' },
    { command: 'new_session', description: 'Start a new Claude conversation' },
    { command: 'help', description: 'Show usage' },
  ]);
}

export async function skipBacklog(): Promise<void> {
  const r = await getUpdatesRaw(0, 0);
  if (r.ok) {
    const maxId = r.updates.reduce((m, u) => Math.max(m, u.update_id), 0);
    setOffset(Math.max(maxId + 1, getOffset()));
  }
}
