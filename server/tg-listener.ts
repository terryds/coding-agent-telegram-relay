import { mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { getSetting, setSetting, deleteSetting, db, logMessage, logStep } from './db.ts';
import {
  getTelegramConfig,
  getUpdatesRaw,
  sendTelegram,
  sendTelegramPlain,
  sendChatAction,
  setMyCommands,
  downloadTelegramFile,
  type SendTarget,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram.ts';
import {
  ENGINE_LABELS,
  getEngineId,
  setEngineId,
  isEngineId,
  type AskQuestion,
  type EngineResult,
  type EngineStep,
} from './engine.ts';
import { currentEngine } from './engines.ts';

const INCOMING_DIR = resolve('./data/incoming');
mkdirSync(INCOMING_DIR, { recursive: true });

// Telegram's Bot API will not let bots download files larger than 20 MB.
const TG_FILE_LIMIT = 20 * 1024 * 1024;

const TG_OFFSET_KEY = 'telegram_update_offset';
const CLAUDE_SESSION_KEY = 'claude_session_id';
const ENABLED_KEY = 'relay_enabled';
const CAPTURE_KEY = 'capture_chat_id';
const CAPTURED_KEY = 'captured_chat_id';
const GROUP_CAPTURE_KEY = 'capture_group_topic';
const GROUP_CHAT_KEY = 'group_chat_id';
const GROUP_TOPIC_KEY = 'group_topic_id';
const GROUP_TITLE_KEY = 'group_chat_title';
const GROUP_TOPIC_NAME_KEY = 'group_topic_name';

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

// ── Group-topic link ────────────────────────────────────────────────
//
// Besides the private chat linked during onboarding, the relay can be bound to
// one group (optionally a specific forum topic inside it). Linking works like
// onboarding: enable capture mode from the dashboard, send any message in the
// target group/topic, and the relay records the chat id + topic thread id.

export type GroupLink = {
  chat_id: string;
  topic_id: string | null; // null = plain group / the General topic
  chat_title: string | null;
  topic_name: string | null;
};

export function getGroupLink(): GroupLink | null {
  const chatId = getSetting(GROUP_CHAT_KEY);
  if (!chatId) return null;
  return {
    chat_id: chatId,
    topic_id: getSetting(GROUP_TOPIC_KEY),
    chat_title: getSetting(GROUP_TITLE_KEY),
    topic_name: getSetting(GROUP_TOPIC_NAME_KEY),
  };
}

export function unlinkGroup(): void {
  deleteSetting(GROUP_CHAT_KEY);
  deleteSetting(GROUP_TOPIC_KEY);
  deleteSetting(GROUP_TITLE_KEY);
  deleteSetting(GROUP_TOPIC_NAME_KEY);
  deleteSetting(GROUP_CAPTURE_KEY);
}

/** What the user chose to link: a specific forum topic, or the whole group. */
export type GroupCaptureMode = 'topic' | 'group';

export function setGroupCaptureMode(mode: GroupCaptureMode | null): void {
  if (mode) setSetting(GROUP_CAPTURE_KEY, mode);
  else deleteSetting(GROUP_CAPTURE_KEY);
}

export function getGroupCaptureMode(): GroupCaptureMode | null {
  const v = getSetting(GROUP_CAPTURE_KEY);
  if (v === 'topic' || v === 'group') return v;
  return v ? 'group' : null; // legacy '1' behaved like whole-group capture
}

export function isGroupCapturing(): boolean {
  return getGroupCaptureMode() !== null;
}

// During topic-mode capture, non-topic group messages keep the capture waiting.
// Reply with a hint so the user isn't left wondering — but at most once per
// 30s per chat, so a burst of setup chatter doesn't get a hint per message.
const captureHintSentAt = new Map<string, number>();

async function sendGroupCaptureHint(chatId: string): Promise<void> {
  const last = captureHintSentAt.get(chatId) ?? 0;
  if (Date.now() - last < 30_000) return;
  captureHintSentAt.set(chatId, Date.now());
  await sendTelegram(
    [
      '⏳ <b>Still waiting for a topic message.</b>',
      '',
      "This message isn't inside a topic, so nothing was linked yet.",
      'Create/open a topic in this group and send a message there.',
      '',
      "<i>No Topics in this group? Enable them in the group settings — or pick “Entire group” in the dashboard instead.</i>",
    ].join('\n'),
    { target: { chatId } }
  );
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

function formatStep(step: EngineStep): string {
  switch (step.kind) {
    case 'thinking':
      return `🧠 <i>thinking…</i>`;
    case 'tool_use': {
      // AskUserQuestion is rendered cleanly at the end by deliverResult;
      // skip its raw JSON step so we don't show the question twice.
      if (step.toolName === 'AskUserQuestion') return '';
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

async function sendStep(step: EngineStep, target: SendTarget): Promise<void> {
  const msg = formatStep(step);
  if (!msg) return;
  // Throttle
  const now = Date.now();
  const wait = MIN_STEP_INTERVAL_MS - (now - lastStepSentAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastStepSentAt = Date.now();
  const r = await sendTelegram(msg, { target });
  if (!r.ok) console.error(`[tg-listener] step send failed: ${r.error}`);
}

// ── Active run tracking ─────────────────────────────────────────────
//
// The poll loop must keep receiving updates while Claude works, so a run
// executes in the background (not awaited by the loop) and registers itself
// here. A `/stop` command — or a new prompt (auto-stop & replace) — aborts it.

type ActiveRun = { abort: AbortController };
let activeRun: ActiveRun | null = null;

/**
 * Abort the current run, if any. The engine owns its own stream cleanup and
 * tears it down synchronously off the abort signal, so a replacement run can't
 * overlap with it. Returns true if a run was actually stopped.
 */
function stopActiveRun(): boolean {
  const run = activeRun;
  if (!run) return false;
  activeRun = null; // claim it so the run's own cleanup won't double-clear
  run.abort.abort();
  return true;
}

/**
 * Run the active engine in the background with live step-by-step output to
 * Telegram. Does not block the caller — the poll loop stays free to receive
 * /stop and new messages.
 */
function startEngineRun(prompt: string, sessionId: string | null, target: SendTarget): void {
  // Auto-stop & replace: cancel whatever is already running.
  stopActiveRun();

  const abort = new AbortController();
  const run: ActiveRun = { abort };
  activeRun = run;

  void (async () => {
    const engine = currentEngine();
    // Persist every step for the dashboard feed, then forward it to Telegram.
    // Persisting first (and synchronously) keeps DB order correct even though
    // sendStep is throttled.
    const onStep = async (step: EngineStep) => {
      logStep(step, sessionId);
      await sendStep(step, target);
    };

    await sendChatAction('typing', target);
    const typing = setInterval(() => {
      sendChatAction('typing', target).catch(() => {});
    }, 4000);

    let result: EngineResult;
    try {
      result = await engine.run(prompt, sessionId, abort.signal, onStep);

      // The saved session id no longer resolves (e.g. the working dir was
      // renamed, or ~/.claude was cleaned). Drop it and transparently restart
      // as a fresh conversation rather than erroring at the user.
      if (!result.ok && result.staleSession && sessionId && !abort.signal.aborted) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(CLAUDE_SESSION_KEY);
        await sendTelegram(
          '♻️ <b>Previous session expired</b> — starting a fresh conversation…',
          { target }
        );
        const onFreshStep = async (step: EngineStep) => {
          logStep(step, null);
          await sendStep(step, target);
        };
        result = await engine.run(prompt, null, abort.signal, onFreshStep);
      }
    } finally {
      clearInterval(typing);
      if (activeRun === run) activeRun = null;
    }

    await deliverResult(result, target);
  })().catch((err) => {
    console.error('[tg-listener] engine run crashed:', err);
    if (activeRun === run) activeRun = null;
  });
}

/** Send the engine's result (or error) back to Telegram and log it. */
async function deliverResult(result: EngineResult, target: SendTarget): Promise<void> {
  if (result.ok) {
    if (result.session_id) setSetting(CLAUDE_SESSION_KEY, result.session_id);
    // Claude asked a question. Headless mode auto-cancels it, so the result
    // text is just a "question canceled" notice — suppress that and instead
    // show the question + options as text. The user answers by typing back,
    // which resumes the session via the normal message flow.
    if (result.questions && result.questions.length > 0) {
      const body = formatQuestions(result.questions);
      const r = await sendTelegram(body, { target });
      logMessage({
        direction: 'out',
        text: body,
        session_id: result.session_id,
        ok: r.ok,
        error: r.error ?? null,
      });
      if (!r.ok) console.error(`[tg-listener] question send failed: ${r.error}`);
      return;
    }
    const body = result.text || `(${ENGINE_LABELS[getEngineId()]} returned an empty response)`;
    const r = await sendTelegramPlain(body, target);
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
  await sendTelegram(
    `⚠️ <b>${escapeHtml(ENGINE_LABELS[getEngineId()])} error</b>\n${escapeHtml(result.error)}`,
    { target }
  );
}

/** Render AskUserQuestion(s) as a text prompt the user can answer by typing. */
function formatQuestions(questions: AskQuestion[]): string {
  const parts: string[] = [`❓ <b>${ENGINE_LABELS[getEngineId()]} needs your input</b>`];
  questions.forEach((q, i) => {
    const num = questions.length > 1 ? `${i + 1}. ` : '';
    parts.push('');
    parts.push(`${num}<b>${escapeHtml(q.question)}</b>`);
    if (q.multiSelect) parts.push('<i>(you can pick more than one)</i>');
    for (const opt of q.options) {
      const desc = opt.description ? ` — ${escapeHtml(opt.description)}` : '';
      parts.push(`• <b>${escapeHtml(opt.label)}</b>${desc}`);
    }
  });
  parts.push('');
  parts.push('<i>Reply with your choice (or type anything else).</i>');
  return parts.join('\n');
}

async function loop(): Promise<void> {
  while (listenerLoopRunning) {
    const { botToken, chatId } = getTelegramConfig();
    const capturing = isCapturing() || isGroupCapturing();

    if (!botToken) {
      await sleep(5000);
      continue;
    }
    // We poll if either we're capturing (onboarding / group linking) or
    // relaying is enabled.
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
  const isGroupChat = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  // Only trust message_thread_id when it's an actual forum topic — plain reply
  // threads in supergroups also carry a thread id but aren't topics.
  const topicThreadId =
    msg.is_topic_message && msg.message_thread_id != null ? msg.message_thread_id : null;

  // Group-topic capture: the first matching group message during capture wins.
  const captureMode = getGroupCaptureMode();
  if (captureMode && isGroupChat) {
    // Topic mode: only a message inside a forum topic completes the link.
    // Anything else (General, a non-forum group, service chatter) keeps the
    // capture waiting — reply with a hint so the user knows why.
    if (captureMode === 'topic' && topicThreadId == null) {
      await sendGroupCaptureHint(incomingChatId);
      return;
    }
    setSetting(GROUP_CHAT_KEY, incomingChatId);
    if (topicThreadId != null) setSetting(GROUP_TOPIC_KEY, String(topicThreadId));
    else deleteSetting(GROUP_TOPIC_KEY);
    if (msg.chat.title) setSetting(GROUP_TITLE_KEY, msg.chat.title);
    else deleteSetting(GROUP_TITLE_KEY);
    // A topic message quotes the topic-created service message, which carries
    // the topic's name — grab it for the dashboard when available.
    const topicName = msg.reply_to_message?.forum_topic_created?.name;
    if (topicName) setSetting(GROUP_TOPIC_NAME_KEY, topicName);
    else deleteSetting(GROUP_TOPIC_NAME_KEY);
    deleteSetting(GROUP_CAPTURE_KEY);
    const label = ENGINE_LABELS[getEngineId()];
    await sendTelegram(
      [
        '✅ <b>Group linked!</b>',
        '',
        `Chat ID: <code>${incomingChatId}</code>`,
        topicThreadId != null
          ? `Topic ID: <code>${topicThreadId}</code>`
          : 'Scope: entire group',
        '',
        `You can now talk to ${escapeHtml(label)} here — just say "Hi!"`,
      ].join('\n'),
      { target: { chatId: incomingChatId, threadId: topicThreadId } }
    );
    return;
  }

  // Onboarding capture: the first message during capture mode wins.
  if (isCapturing()) {
    // A group message can't be the primary (private) chat — and if a group
    // capture is pending it was handled above. Don't let it hijack onboarding.
    if (isGroupChat) return;
    setSetting(CAPTURED_KEY, incomingChatId);
    setSetting('telegram_chat_id', incomingChatId);
    db.prepare('DELETE FROM settings WHERE key = ?').run(CAPTURE_KEY);
    // Linking the chat completes onboarding — turn the relay on so the user can
    // talk to the agent right away.
    setRelayEnabled(true);
    applyBotCommands().catch(() => {});
    const label = ENGINE_LABELS[getEngineId()];
    // Acknowledge via the token used for this very chat — sendTelegram reads chat_id from settings.
    await sendTelegram(
      [
        '✅ <b>Chat linked!</b>',
        '',
        `Chat ID: <code>${incomingChatId}</code>`,
        '',
        `You can now talk to ${escapeHtml(label)} via Telegram — just say "Hi!"`,
      ].join('\n')
    );
    return;
  }

  // Authorization: the onboarded private chat, or the linked group. A link
  // with a topic id only matches that exact topic; a whole-group link (no
  // topic id) matches anywhere in the group.
  const group = getGroupLink();
  const fromPrivate = Boolean(expectedChatId && incomingChatId === expectedChatId);
  const fromGroupTopic = Boolean(
    group &&
      incomingChatId === group.chat_id &&
      (group.topic_id === null ||
        (topicThreadId != null && String(topicThreadId) === group.topic_id))
  );
  if (!fromPrivate && !fromGroupTopic) {
    console.log(`[tg-listener] ignored message from unauthorized chat ${incomingChatId}`);
    return;
  }

  if (!isRelayEnabled()) return;

  // Replies go back to where the message came from (inside the topic, if any).
  const target: SendTarget = { chatId: incomingChatId, threadId: topicThreadId };

  // In groups, commands arrive as e.g. "/stop@MyBot" — strip the mention.
  const text = (msg.text ?? '').trim().replace(/^\/([a-z_]+)@\S+/i, '/$1');
  const caption = (msg.caption ?? '').trim();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const video = extractVideo(msg);
  const audio = extractAudio(msg);

  if (!text && !hasPhoto && !video && !audio) return;

  const engineLabel = ENGINE_LABELS[getEngineId()];

  if (text === '/stop' || text.startsWith('/stop ')) {
    if (stopActiveRun()) {
      await sendTelegram(`🛑 <b>Stopped.</b> ${escapeHtml(engineLabel)} was interrupted.`, { target });
    } else {
      await sendTelegram('💤 Nothing is running right now.', { target });
    }
    return;
  }

  if (text === '/new_session' || text.startsWith('/new_session ')) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(CLAUDE_SESSION_KEY);
    await sendTelegram(
      `🔄 <b>New conversation started.</b>\nThe next message will begin a fresh ${escapeHtml(engineLabel)} session.`,
      { target }
    );
    return;
  }

  if (text === '/engine' || text.startsWith('/engine ')) {
    const arg = text.slice('/engine'.length).trim().toLowerCase();
    if (!arg) {
      await sendTelegram(
        [
          `🤖 <b>Current engine:</b> ${escapeHtml(engineLabel)}`,
          '',
          'Switch with:',
          '  /engine claude — use Claude Code',
          '  /engine codex — use Codex',
          '',
          '<i>Switching starts a fresh conversation.</i>',
        ].join('\n'),
        { target }
      );
      return;
    }
    if (!isEngineId(arg)) {
      await sendTelegram(`⚠️ Unknown engine <code>${escapeHtml(arg)}</code>. Use <code>claude</code> or <code>codex</code>.`, { target });
      return;
    }
    // Stop any in-flight run and clear the session — sessions don't carry
    // across engines.
    stopActiveRun();
    db.prepare('DELETE FROM settings WHERE key = ?').run(CLAUDE_SESSION_KEY);
    setEngineId(arg);
    await sendTelegram(
      `✅ <b>Engine switched to ${escapeHtml(ENGINE_LABELS[arg])}.</b>\nThe next message will begin a fresh conversation.`,
      { target }
    );
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendTelegram(
      [
        '<b>Coding Agent Telegram Relay</b>',
        '',
        `Send a message and I'll relay it to <b>${escapeHtml(engineLabel)}</b> running on your VPS.`,
        '',
        'You can also send photos (with or without a caption) — they get saved to disk and the file path is passed to the agent.',
        'Videos, video notes, voice notes and audio files work the same way — they get saved to disk and the file path is passed to the agent.',
        '',
        'Commands:',
        '  /stop — interrupt the agent while it\'s working',
        '  /new_session — start a fresh conversation',
        '  /engine — show or switch the active engine (Claude Code / Codex)',
        '  /help — show this message',
      ].join('\n'),
      { target }
    );
    return;
  }

  let prompt: string;
  if (video) {
    prompt = await buildVideoPrompt(msg, video, caption || text, target);
  } else if (audio) {
    prompt = await buildAudioPrompt(msg, audio, caption || text, target);
  } else if (hasPhoto) {
    prompt = await buildPhotoPrompt(msg, caption || text, target);
  } else {
    prompt = text;
  }
  if (!prompt) return;

  logMessage({ direction: 'in', text: prompt, session_id: getSetting(CLAUDE_SESSION_KEY) });

  const sessionId = getSetting(CLAUDE_SESSION_KEY);

  // Auto-stop & replace: a fresh prompt cancels whatever is still running.
  if (activeRun) {
    await sendTelegram('🛑 Stopping the previous task and starting the new one…', { target });
  }

  console.log(
    `[tg-listener] → ${getEngineId()} (${sessionId ? 'resume ' + sessionId.slice(0, 8) : 'new session'}): ${prompt.slice(0, 80)}`
  );

  // Fire-and-forget: the run streams its own output and the poll loop stays
  // free to receive /stop and further messages.
  startEngineRun(prompt, sessionId, target);
}

async function buildPhotoPrompt(
  msg: TelegramMessage,
  userText: string,
  target: SendTarget
): Promise<string> {
  const photos = msg.photo ?? [];
  // Telegram returns photos sorted ascending by size; the largest is best for vision.
  const largest = photos[photos.length - 1];
  if (!largest) return userText;

  const ext = '.jpg'; // Telegram always converts photos to JPEG
  const destPath = resolve(INCOMING_DIR, `${largest.file_unique_id}${ext}`);
  const dl = await downloadTelegramFile(largest.file_id, destPath);
  if (!dl.ok) {
    await sendTelegram(`⚠️ <b>Failed to download photo</b>\n${escapeHtml(dl.error)}`, { target });
    return '';
  }

  const ref = `An image was attached at: ${destPath}\nUse your Read tool to view it.`;
  return userText ? `${ref}\n\n${userText}` : `${ref}\n\nNo caption was provided — describe what you see, or wait for follow-up instructions.`;
}

// ── Video ───────────────────────────────────────────────────────────
//
// Like photos, videos are downloaded to disk and the local path is handed to
// Claude — no pre-processing. The agent decides what to do with it (extract
// frames, pull the audio, transcribe, etc.) using its own tools.
// Covers video, video_note, animation, and video/* documents.

type VideoAttachment = {
  file_id: string;
  file_unique_id: string;
  hint_ext: string;
  size: number;
};

function extractVideo(msg: TelegramMessage): VideoAttachment | null {
  if (msg.video) {
    return {
      file_id: msg.video.file_id,
      file_unique_id: msg.video.file_unique_id,
      hint_ext: '.mp4',
      size: msg.video.file_size ?? 0,
    };
  }
  if (msg.video_note) {
    return {
      file_id: msg.video_note.file_id,
      file_unique_id: msg.video_note.file_unique_id,
      hint_ext: '.mp4',
      size: msg.video_note.file_size ?? 0,
    };
  }
  if (msg.animation) {
    return {
      file_id: msg.animation.file_id,
      file_unique_id: msg.animation.file_unique_id,
      hint_ext: '.mp4',
      size: msg.animation.file_size ?? 0,
    };
  }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('video/')) {
    const ext = msg.document.file_name ? extname(msg.document.file_name) : '';
    return {
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      hint_ext: ext || '.mp4',
      size: msg.document.file_size ?? 0,
    };
  }
  return null;
}

/**
 * Download a video and return a Claude prompt that points at the local file —
 * mirrors buildPhotoPrompt. Returns '' if we already replied with an error
 * (too big, or download failed).
 */
async function buildVideoPrompt(
  msg: TelegramMessage,
  video: VideoAttachment,
  userText: string,
  target: SendTarget
): Promise<string> {
  if (video.size > TG_FILE_LIMIT) {
    await sendTelegram(
      "🎥 <b>Video received, but it's too big.</b>\nTelegram bots can only download files up to 20 MB.",
      { target }
    );
    return '';
  }

  const destPath = join(INCOMING_DIR, `${video.file_unique_id}${video.hint_ext}`);
  const dl = await downloadTelegramFile(video.file_id, destPath);
  if (!dl.ok) {
    await sendTelegram(`⚠️ <b>Failed to download video</b>\n${escapeHtml(dl.error)}`, { target });
    return '';
  }

  const ref = `A video was attached at: ${destPath}\nIt's a video file — use your tools to inspect it (e.g. extract frames or audio with ffmpeg) as needed.`;
  return userText
    ? `${ref}\n\n${userText}`
    : `${ref}\n\nNo caption was provided — figure out what the user wants, or wait for follow-up instructions.`;
}

// ── Audio ───────────────────────────────────────────────────────────
//
// Like videos, voice notes and audio files are downloaded to disk and the local
// path is handed to Claude — no pre-processing. The agent decides what to do
// with it (transcribe it, etc.) using its own tools.
// Covers voice, audio, and audio/* documents.

type AudioAttachment = {
  file_id: string;
  file_unique_id: string;
  hint_ext: string;
  size: number;
};

function extractAudio(msg: TelegramMessage): AudioAttachment | null {
  if (msg.voice) {
    return {
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      hint_ext: '.ogg',
      size: msg.voice.file_size ?? 0,
    };
  }
  if (msg.audio) {
    const ext = msg.audio.file_name ? extname(msg.audio.file_name) : '';
    return {
      file_id: msg.audio.file_id,
      file_unique_id: msg.audio.file_unique_id,
      hint_ext: ext || '.mp3',
      size: msg.audio.file_size ?? 0,
    };
  }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('audio/')) {
    const ext = msg.document.file_name ? extname(msg.document.file_name) : '';
    return {
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      hint_ext: ext || '.mp3',
      size: msg.document.file_size ?? 0,
    };
  }
  return null;
}

/**
 * Download an audio message and return a Claude prompt that points at the local
 * file — mirrors buildVideoPrompt. Returns '' if we already replied with an
 * error (too big, or download failed).
 */
async function buildAudioPrompt(
  msg: TelegramMessage,
  audio: AudioAttachment,
  userText: string,
  target: SendTarget
): Promise<string> {
  if (audio.size > TG_FILE_LIMIT) {
    await sendTelegram(
      "🎙 <b>Audio received, but it's too big.</b>\nTelegram bots can only download files up to 20 MB.",
      { target }
    );
    return '';
  }

  const destPath = join(INCOMING_DIR, `${audio.file_unique_id}${audio.hint_ext}`);
  const dl = await downloadTelegramFile(audio.file_id, destPath);
  if (!dl.ok) {
    await sendTelegram(`⚠️ <b>Failed to download audio</b>\n${escapeHtml(dl.error)}`, { target });
    return '';
  }

  const ref = `An audio message was attached at: ${destPath}\nIt's an audio file — use your tools to inspect it (e.g. transcribe it) as needed.`;
  return userText
    ? `${ref}\n\n${userText}`
    : `${ref}\n\nNo caption was provided — figure out what the user wants, or wait for follow-up instructions.`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function applyBotCommands(): Promise<void> {
  await setMyCommands([
    { command: 'stop', description: 'Interrupt the agent while it is working' },
    { command: 'new_session', description: 'Start a new conversation' },
    { command: 'engine', description: 'Show or switch the active engine' },
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
