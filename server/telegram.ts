import { getSetting } from './db.ts';

export type TelegramConfig = {
  botToken: string | null;
  chatId: string | null;
};

export type BotInfo = {
  id: number;
  username: string;
  first_name: string;
};

export type ChatInfo = {
  id: number;
  type: string;
  title: string | null;
  username: string | null;
  first_name: string | null;
  last_message_at: number | null;
};

export type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
};

export type TelegramVideo = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
};

// Round "video note" messages carry the same fields we care about, so they
// reuse the video shape (no width/height, but file_id + duration + size).
export type TelegramVideoNote = {
  file_id: string;
  file_unique_id: string;
  length?: number;
  duration: number;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

// Voice notes (OGG/opus) and audio files (mp3, m4a, …) share the fields we use.
export type TelegramVoice = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TelegramAudio = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  animation?: TelegramVideo;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  chat: TelegramChat;
  // Forum-topic messages: thread id of the topic + a flag distinguishing them
  // from plain reply threads. Messages in a topic quote the topic-created
  // service message, which carries the topic's name.
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { forum_topic_created?: { name?: string } };
};

/** Where to send a message: a chat, optionally inside a forum topic. */
export type SendTarget = {
  chatId: string;
  threadId?: number | null;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  my_chat_member?: { date: number; chat: TelegramChat };
};

export function getTelegramConfig(): TelegramConfig {
  return {
    botToken: getSetting('telegram_bot_token'),
    chatId: getSetting('telegram_chat_id'),
  };
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

async function call<T>(token: string, path: string): Promise<Ok<{ result: T }> | Err> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}${path}`);
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok || data.result === undefined) {
      return { ok: false, error: data.description || `Telegram HTTP ${res.status}` };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getBotInfo(token: string): Promise<Ok<{ bot: BotInfo }> | Err> {
  const r = await call<BotInfo>(token, '/getMe');
  if (!r.ok) return r;
  const { id, username, first_name } = r.result;
  return { ok: true, bot: { id, username, first_name } };
}

export async function getRecentChats(token: string): Promise<Ok<{ chats: ChatInfo[] }> | Err> {
  const r = await call<TelegramUpdate[]>(token, '/getUpdates');
  if (!r.ok) return r;
  const seen = new Map<number, ChatInfo>();
  for (const upd of r.result) {
    const entry = upd.message || upd.edited_message || upd.channel_post || upd.my_chat_member;
    if (!entry) continue;
    const { chat, date } = entry;
    if (typeof chat?.id !== 'number') continue;
    const existing = seen.get(chat.id);
    if (existing && existing.last_message_at && existing.last_message_at >= date) continue;
    seen.set(chat.id, {
      id: chat.id,
      type: chat.type,
      title: chat.title ?? null,
      username: chat.username ?? null,
      first_name: chat.first_name ?? null,
      last_message_at: date,
    });
  }
  const chats = Array.from(seen.values()).sort(
    (a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0)
  );
  return { ok: true, chats };
}

export async function sendTelegram(
  text: string,
  options: { html?: boolean; target?: SendTarget } = {}
): Promise<{ ok: boolean; error?: string }> {
  const { botToken, chatId } = getTelegramConfig();
  const target = options.target ?? (chatId ? { chatId } : null);
  if (!botToken || !target) return { ok: false, error: 'Telegram not configured' };
  const html = options.html ?? true;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.chatId,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
        text,
        ...(html ? { parse_mode: 'HTML' } : {}),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Telegram ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const MAX_TG_MESSAGE = 4000;

export async function sendTelegramPlain(
  text: string,
  target?: SendTarget
): Promise<{ ok: boolean; error?: string }> {
  if (text.length <= MAX_TG_MESSAGE) return sendTelegram(text, { html: false, target });
  for (let i = 0; i < text.length; i += MAX_TG_MESSAGE) {
    const chunk = text.slice(i, i + MAX_TG_MESSAGE);
    const r = await sendTelegram(chunk, { html: false, target });
    if (!r.ok) return r;
  }
  return { ok: true };
}

export async function sendChatAction(action: string, target?: SendTarget): Promise<void> {
  const { botToken, chatId } = getTelegramConfig();
  const dest = target ?? (chatId ? { chatId } : null);
  if (!botToken || !dest) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: dest.chatId,
        ...(dest.threadId ? { message_thread_id: dest.threadId } : {}),
        action,
      }),
    });
  } catch {
    // non-critical
  }
}

export async function getUpdatesRaw(
  offset: number,
  timeoutSeconds = 25
): Promise<{ ok: true; updates: TelegramUpdate[] } | { ok: false; error: string }> {
  const { botToken } = getTelegramConfig();
  if (!botToken) return { ok: false, error: 'Bot token not set' };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}`,
      { signal: AbortSignal.timeout((timeoutSeconds + 5) * 1000) }
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: TelegramUpdate[];
      description?: string;
    };
    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true, updates: data.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setMyCommands(
  commands: Array<{ command: string; description: string }>
): Promise<{ ok: boolean; error?: string }> {
  const { botToken } = getTelegramConfig();
  if (!botToken) return { ok: false, error: 'Bot token not set' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function downloadTelegramFile(
  fileId: string,
  destPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { botToken } = getTelegramConfig();
  if (!botToken) return { ok: false, error: 'Bot token not set' };
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    const meta = (await metaRes.json()) as {
      ok: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (!meta.ok || !meta.result?.file_path) {
      return { ok: false, error: meta.description || `getFile HTTP ${metaRes.status}` };
    }
    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`
    );
    if (!fileRes.ok) return { ok: false, error: `download HTTP ${fileRes.status}` };
    const buf = await fileRes.arrayBuffer();
    await Bun.write(destPath, buf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
