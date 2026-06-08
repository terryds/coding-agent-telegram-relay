/**
 * Watches the Claude Code JSONL session file and emits parsed step events
 * so the tg-listener can forward live progress to Telegram.
 */
import { watch, type FSWatcher } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export type StepKind = 'thinking' | 'tool_use' | 'tool_result' | 'text';

export type ClaudeStep = {
  kind: StepKind;
  ts: string;            // HH:MM:SS
  toolName?: string;     // for tool_use
  toolInput?: string;    // truncated input JSON
  resultText?: string;   // for tool_result
  text?: string;         // for text blocks
};

export type OnStep = (step: ClaudeStep) => void | Promise<void>;

const CLAUDE_PROJECTS = resolve(homedir(), '.claude/projects');

/** Derive the JSONL directory from the CWD that claude was launched in. */
function projectDir(cwd: string): string {
  // Claude Code stores sessions under a dir named with dashes replacing slashes
  // e.g. /home/exedev/personal-signal-dashboard → -home-exedev-personal-signal-dashboard
  const slug = cwd.replace(/\//g, '-');
  return resolve(CLAUDE_PROJECTS, slug);
}

function jsonlPath(cwd: string, sessionId: string): string {
  return resolve(projectDir(cwd), `${sessionId}.jsonl`);
}

function formatTs(iso: string): string {
  if (!iso) return '';
  // "2026-06-08T21:53:40.138Z" → "21:53:40"
  return iso.slice(11, 19);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Parse a single JSONL object into zero or more steps. */
function parseEntry(obj: any): ClaudeStep[] {
  const steps: ClaudeStep[] = [];
  const type = obj?.type;
  const ts = formatTs(obj?.timestamp ?? '');
  const content = obj?.message?.content;

  if (type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking') {
        steps.push({ kind: 'thinking', ts });
      } else if (block.type === 'text') {
        const txt = (block.text ?? '').trim();
        if (txt) steps.push({ kind: 'text', ts, text: txt });
      } else if (block.type === 'tool_use') {
        steps.push({
          kind: 'tool_use',
          ts,
          toolName: block.name ?? '?',
          toolInput: truncate(JSON.stringify(block.input ?? {}), 300),
        });
      }
    }
  } else if (type === 'user' && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        let text = '';
        const c = block.content;
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          text = c
            .filter((x: any) => x?.type === 'text')
            .map((x: any) => x.text)
            .join('\n');
        }
        if (text) {
          steps.push({ kind: 'tool_result', ts, resultText: truncate(text, 300) });
        }
      }
    }
  }
  return steps;
}

/**
 * Start watching the JSONL file for a given session.
 * Returns a stop() function.
 *
 * We open the file, seek to the end, then watch for changes.
 * Each time the file grows we read new lines and emit steps.
 */
export async function watchSession(
  sessionId: string,
  onStep: OnStep,
  cwd: string = process.cwd(),
): Promise<() => void> {
  const path = jsonlPath(cwd, sessionId);
  let fh: FileHandle | null = null;
  let watcher: FSWatcher | null = null;
  let offset = 0;
  let stopped = false;
  let reading = false;
  let buf = '';

  async function readNew() {
    if (reading || stopped || !fh) return;
    reading = true;
    try {
      const chunk = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        buf += chunk.toString('utf-8', 0, bytesRead);

        // Process complete lines
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const steps = parseEntry(obj);
            for (const step of steps) {
              try { await onStep(step); } catch {}
            }
          } catch { /* skip bad JSON */ }
        }
      }
    } catch (err) {
      if (!stopped) console.error('[claude-stream] read error:', err);
    } finally {
      reading = false;
    }
  }

  try {
    fh = await open(path, 'r');
    // Seek to end so we only get new entries
    const stat = await fh.stat();
    offset = stat.size;

    watcher = watch(path, () => { readNew(); });
    // Also poll every 2s in case fs.watch misses events
    const pollInterval = setInterval(() => { readNew(); }, 2000);

    return () => {
      stopped = true;
      clearInterval(pollInterval);
      watcher?.close();
      fh?.close().catch(() => {});
    };
  } catch (err) {
    console.error(`[claude-stream] failed to open ${path}:`, err);
    fh?.close().catch(() => {});
    return () => {};
  }
}
