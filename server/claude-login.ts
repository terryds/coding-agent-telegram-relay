/**
 * Drives Claude Code's subscription sign-in (`claude setup-token`) from the
 * dashboard, so the operator never has to open a terminal.
 *
 * `setup-token` is a raw-mode TUI (Ink): it crashes on a plain pipe and needs a
 * real PTY. We allocate one with the system `script` utility (present on Ubuntu
 * and macOS), then:
 *   1. read its output and scrape the OAuth authorize URL,
 *   2. hand the URL to the UI (the user authorizes in their own browser — the
 *      flow is out-of-band, redirecting to a hosted page that shows a code),
 *   3. write the pasted code back into the PTY,
 *   4. let the CLI finish the exchange and store the subscription credentials.
 *
 * Only one login runs at a time.
 */
import { homedir } from 'node:os';
import { setOauthToken } from './engine.ts';
import { claudeAuthStatus } from './claude-runner.ts';

/**
 * Env for the interactive CLI. pm2 runs the relay with a stripped environment
 * (often no TERM, sometimes no HOME), and the raw-mode TUI silently exits 0 with
 * no output when TERM is missing on Linux — so backfill sane defaults.
 */
function loginEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: process.env.HOME || homedir(),
    TERM: process.env.TERM || 'xterm-256color',
  };
}

type Subproc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

export type LoginState = 'awaiting' | 'done' | 'error';

type LoginSession = {
  proc: Subproc;
  buf: string;
  url: string | null;
  token: string | null;
  state: LoginState;
  error: string | null;
};

let session: LoginSession | null = null;

const TOKEN_RE = /sk-ant-oat[0-9]{0,2}-[A-Za-z0-9_-]{20,}/;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI/OSC escapes and stray control chars, keeping \n \r \t. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** A human-readable tail of CLI output for error messages. */
function tidyTail(raw: string, max = 500): string {
  const clean = stripAnsi(raw)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return clean.slice(-max);
}

/**
 * Reconstruct the authorize URL from PTY output. Ink hard-wraps the URL across
 * lines (inserting real newlines) and follows it with a blank line, so we join
 * the contiguous non-blank lines starting at the URL. Returns null until the
 * full block has printed (terminated by a blank line and containing `state=`).
 */
function extractUrl(raw: string): string | null {
  const lines = stripAnsi(raw).split('\n');
  const start = lines.findIndex((l) => /https?:\/\/\S*oauth\/authorize/i.test(l));
  if (start === -1) return null;

  const parts: string[] = [];
  let terminated = false;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') {
      if (parts.length) {
        terminated = true;
        break;
      }
      continue;
    }
    parts.push(t);
  }
  if (!terminated) return null;

  const url = parts.join('').replace(/\s+/g, '');
  if (!/^https?:\/\//.test(url) || !/state=/.test(url)) return null;
  return url;
}

/** Accept a bare code, or extract it from a pasted callback URL. */
function normalizePastedCode(raw: string): string {
  const s = raw.trim();
  if (/[?&]code=/.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get('code') ?? '';
      const state = u.searchParams.get('state');
      // Claude's manual exchange expects `code#state`.
      if (code) return state ? `${code}#${state}` : code;
    } catch {
      // not a URL — fall through
    }
  }
  return s;
}

// Run setup-token inside a real PTY via our Python bridge (the server has no
// controlling tty of its own, and the raw-mode TUI requires one).
const BRIDGE = new URL('./pty-bridge.py', import.meta.url).pathname;
function ptyCommand(): string[] {
  return ['python3', BRIDGE, 'claude', 'setup-token'];
}

export function cancelClaudeLogin(): void {
  if (!session) return;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
  session = null;
}

/** True if Claude reports a logged-in subscription (cheap, no billed request). */
export async function isClaudeLoggedIn(): Promise<boolean> {
  const status = await claudeAuthStatus();
  return status?.loggedIn === true;
}

/**
 * Start `claude setup-token` in a PTY and return the authorize URL to show the
 * user. Replaces any in-progress login.
 */
export async function startClaudeLogin(): Promise<{ url: string }> {
  cancelClaudeLogin();

  let proc: Subproc;
  try {
    proc = Bun.spawn(ptyCommand(), {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: loginEnv(),
    });
  } catch (err) {
    throw new Error(
      `Couldn't start the login process (is python3 installed?): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const s: LoginSession = {
    proc,
    buf: '',
    url: null,
    token: null,
    state: 'awaiting',
    error: null,
  };
  session = s;
  console.error(`[claude-login] started pid=${proc.pid} cmd=${ptyCommand().join(' ')}`);

  // Continuously drain stdout (so the PTY doesn't block) and watch for both the
  // authorize URL and the minted token. The token appears either after the user
  // pastes a code (headless/OOB) OR on its own when setup-token captures the code
  // via a loopback browser tab (desktop) — so we must catch it without a paste.
  (async () => {
    try {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        s.buf += dec.decode(value, { stream: true });
        if (!s.url) s.url = extractUrl(s.buf);
        if (!s.token && s.state === 'awaiting') {
          const clean = stripAnsi(s.buf);
          const m = clean.match(TOKEN_RE);
          if (m) {
            s.token = m[0];
            setOauthToken('claude', s.token);
            s.state = 'done';
          } else if (/OAuth error:|Invalid code|expired|Press Enter to retry/i.test(clean)) {
            // The CLI rejected the code (wrong/truncated/expired). Surface it
            // and stop, rather than leaving the user staring at a spinner.
            const line = clean.match(/OAuth error:[^\n\r]*/i)?.[0];
            s.error = (line || 'Sign-in failed — the code may be wrong or expired.')
              .replace(/\s+/g, ' ')
              .trim();
            s.state = 'error';
            try {
              s.proc.kill();
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // process ended / killed
    }
    // The process has exited. If we never got a token, it's a failure.
    const exitCode = await proc.exited.catch(() => -1);
    if (s.state === 'awaiting') {
      s.state = 'error';
      const tail = tidyTail(s.buf, 600);
      s.error =
        tail || `Sign-in ended before completing (CLI exited code ${exitCode}, no output).`;
      console.error(
        `[claude-login] setup-token exited code=${exitCode} bufLen=${s.buf.length} tail=${JSON.stringify(
          stripAnsi(s.buf).slice(-400)
        )}`
      );
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

  // Wait up to 25s for the URL to appear (or the process to die early).
  const deadline = Date.now() + 25_000;
  let exitedEarly = false;
  proc.exited.then(() => {
    exitedEarly = true;
  });
  while (!s.url && Date.now() < deadline && !exitedEarly) {
    await sleep(200);
  }

  if (!s.url) {
    const tail = tidyTail(s.buf);
    cancelClaudeLogin();
    throw new Error(
      tail
        ? `Couldn't read a sign-in URL from the CLI. Output:\n${tail}`
        : 'Timed out waiting for a sign-in URL from the CLI.'
    );
  }
  return { url: s.url };
}

/**
 * Feed the code the user pasted into the waiting CLI (the headless/OOB path).
 * Completion is observed asynchronously by the drain loop (it captures the
 * minted token), so callers poll `claudeLoginStatus` for the result.
 */
export async function submitClaudeLoginCode(
  raw: string
): Promise<{ ok: boolean; error?: string }> {
  const s = session;
  if (!s) return { ok: false, error: 'No sign-in is in progress — start again.' };
  if (s.state === 'done') return { ok: true };
  if (s.state === 'error') {
    return { ok: false, error: s.error || 'Sign-in already failed — start again.' };
  }

  const code = normalizePastedCode(raw);
  if (!code) return { ok: false, error: 'Paste the code from the sign-in page.' };

  try {
    // The CLI's paste prompt is a raw-mode Ink input. Send the code, then send
    // Enter (\r — NOT \n) as a SEPARATE write: if the \r rides in the same chunk
    // as the code, Ink treats it as pasted text and never submits.
    s.proc.stdin.write(code);
    await s.proc.stdin.flush();
    await sleep(250);
    s.proc.stdin.write('\r');
    await s.proc.stdin.flush();
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't send the code to the CLI: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true };
}

/** Poll the in-progress sign-in. `done` means a token was captured + saved. */
export function claudeLoginStatus(): { state: 'idle' | LoginState; error?: string } {
  if (!session) return { state: 'idle' };
  return { state: session.state, error: session.error ?? undefined };
}
