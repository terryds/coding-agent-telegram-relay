/**
 * Drives Codex's subscription sign-in (`codex login --device-auth`) from the
 * dashboard, so the operator never has to open a terminal.
 *
 * The device-authorization flow is headless-native: the CLI prints a
 * verification URL + a one-time code, then polls OpenAI on its own. The user
 * opens the URL and enters the code in their browser (on any machine — no
 * loopback callback, no pasting anything back into the CLI). When they finish,
 * the CLI stores the login and exits. So unlike Claude's setup-token, this
 * needs no PTY and no code-paste step — just show the URL+code and poll.
 *
 * Only one login runs at a time.
 */
import { homedir } from 'node:os';
import { codexLoginStatus } from './codex-runner.ts';

type Subproc = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

export type CodexLoginState = 'awaiting' | 'done' | 'error';

type LoginSession = {
  proc: Subproc;
  buf: string;
  url: string | null;
  code: string | null;
  state: CodexLoginState;
  error: string | null;
};

let session: LoginSession | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function tidyTail(raw: string, max = 500): string {
  return stripAnsi(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(-max);
}

function extractUrlAndCode(raw: string): { url: string | null; code: string | null } {
  const clean = stripAnsi(raw);
  const url = clean.match(/https?:\/\/[^\s]*device[^\s]*/i)?.[0] ?? null;
  // One-time code like "DPB1-YF8KX" (groups of letters/digits joined by a dash).
  const code = clean.match(/\b[A-Z0-9]{3,6}-[A-Z0-9]{3,6}\b/)?.[0] ?? null;
  return { url, code };
}

export function cancelCodexLogin(): void {
  if (!session) return;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
  session = null;
}

/**
 * Start `codex login --device-auth` and return the verification URL + one-time
 * code to show the user. The CLI keeps polling; completion surfaces via
 * `codexLoginState`. Replaces any in-progress login.
 */
export async function startCodexLogin(): Promise<{ url: string; code: string }> {
  cancelCodexLogin();

  let proc: Subproc;
  try {
    proc = Bun.spawn(['codex', 'login', '--device-auth'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // pm2 can run the relay with a stripped env; backfill HOME/TERM.
      env: {
        ...process.env,
        HOME: process.env.HOME || homedir(),
        TERM: process.env.TERM || 'xterm-256color',
      },
    });
  } catch (err) {
    throw new Error(
      `Couldn't start codex login: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const s: LoginSession = { proc, buf: '', url: null, code: null, state: 'awaiting', error: null };
  session = s;

  // Drain stdout, watching for the URL + code.
  (async () => {
    try {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        s.buf += dec.decode(value, { stream: true });
        if (!s.url || !s.code) {
          const found = extractUrlAndCode(s.buf);
          s.url = s.url ?? found.url;
          s.code = s.code ?? found.code;
        }
      }
    } catch {
      // ended / killed
    }
  })();
  // Drain stderr too.
  (async () => {
    try {
      s.buf += await new Response(proc.stderr).text();
    } catch {
      // ignore
    }
  })();

  // When the CLI exits, it either signed in (poll confirms) or failed/expired.
  proc.exited.then(async (exitCode) => {
    if (s.state !== 'awaiting') return;
    const st = await codexLoginStatus();
    if (st?.loggedIn) {
      s.state = 'done';
    } else {
      s.state = 'error';
      s.error = tidyTail(s.buf) || `codex login exited ${exitCode}.`;
    }
  });

  // Wait up to 20s for the URL + code to print (or an early exit).
  const deadline = Date.now() + 20_000;
  while ((!s.url || !s.code) && s.state === 'awaiting' && Date.now() < deadline) {
    await sleep(200);
  }

  if (!s.url || !s.code) {
    const tail = tidyTail(s.buf);
    cancelCodexLogin();
    throw new Error(
      tail
        ? `Couldn't read a device code from codex. Output:\n${tail}`
        : 'Timed out waiting for a device code from codex.'
    );
  }
  return { url: s.url, code: s.code };
}

/** Poll the in-progress sign-in. `done` means the CLI is now logged in. */
export function codexLoginState(): { state: 'idle' | CodexLoginState; error?: string } {
  if (!session) return { state: 'idle' };
  return { state: session.state, error: session.error ?? undefined };
}
