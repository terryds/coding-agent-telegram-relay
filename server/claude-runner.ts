import type {
  AskQuestion,
  Engine,
  EngineCheck,
  EngineResult,
  OnStep,
} from './engine.ts';
import { ENGINE_LABELS } from './engine.ts';
import { watchSession } from './claude-stream.ts';

// Kept as aliases for back-compat with existing imports across the server.
export type {
  AskQuestion,
  AskQuestionOption,
} from './engine.ts';
export type ClaudeResult = EngineResult;
export type ClaudeCheck = EngineCheck;

const CLAUDE_TIMEOUT_MS = Number(Bun.env.CLAUDE_TIMEOUT_MS || '0');

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runClaudeHeadless(
  prompt: string,
  sessionId: string | null,
  signal?: AbortSignal
): Promise<ClaudeResult> {
  // Caller already aborted before we even spawned.
  if (signal?.aborted) {
    return { ok: false, error: 'Stopped before starting.', aborted: true };
  }

  const args = [
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'json',
  ];
  if (sessionId) args.push('--resume', sessionId);

  let proc;
  try {
    proc = Bun.spawn(['claude', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to spawn claude CLI: ${err instanceof Error ? err.message : String(err)}. Is it installed and on PATH?`,
    };
  }

  // SIGTERM the process, then SIGKILL after 3s if it ignores us. Shared by
  // both the timeout guard and the user-initiated abort below.
  const spawned = proc;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const killProc = (reason: string): void => {
    console.log(`[claude-runner] killing claude (PID ${spawned.pid}): ${reason}`);
    try { spawned.kill(); } catch {}
    forceKillTimer = setTimeout(() => {
      try { spawned.kill(9); } catch {}
    }, 3_000);
  };

  // Optional guard against Claude finishing work but the process never exiting.
  // Disabled by default; set CLAUDE_TIMEOUT_MS to a positive value to enable it.
  let timedOut = false;
  const timer = CLAUDE_TIMEOUT_MS > 0
    ? setTimeout(() => {
        timedOut = true;
        killProc(`${CLAUDE_TIMEOUT_MS / 1000}s timeout`);
      }, CLAUDE_TIMEOUT_MS)
    : undefined;

  // User-initiated stop (or replacement by a newer prompt).
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    killProc('aborted by caller');
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: `claude process error: ${err instanceof Error ? err.message : String(err)}`,
      aborted,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (aborted) {
    return { ok: false, error: 'Stopped by user.', aborted: true };
  }

  if (timedOut) {
    // Process was killed, but stdout may still contain a valid JSON result
    // (Claude writes it before the process hangs)
    const parsed = tryParseOutput(stdout);
    if (parsed.ok) {
      console.log('[claude-runner] recovered output from timed-out process');
      return parsed;
    }
    return {
      ok: false,
      error: `Claude timed out after ${CLAUDE_TIMEOUT_MS / 60_000} minutes. Partial output: ${stdout.slice(0, 300)}`,
    };
  }

  return tryParseOutput(stdout, stderr);
}

/**
 * In headless mode the CLI auto-denies AskUserQuestion (there's no interactive
 * UI), but the structured question is preserved in `permission_denials`. Pull
 * any out so the caller can render them as text for the user to answer.
 */
function extractQuestions(
  denials?: Array<{ tool_name?: string; tool_input?: any }>,
): AskQuestion[] | undefined {
  if (!Array.isArray(denials)) return undefined;
  const questions: AskQuestion[] = [];
  for (const d of denials) {
    if (d?.tool_name !== 'AskUserQuestion') continue;
    const qs = d.tool_input?.questions;
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      if (!q || typeof q.question !== 'string') continue;
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o: any) => o && typeof o.label === 'string')
            .map((o: any) => ({ label: o.label, description: o.description }))
        : [];
      questions.push({
        question: q.question,
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: Boolean(q.multiSelect),
        options,
      });
    }
  }
  return questions.length > 0 ? questions : undefined;
}

function tryParseOutput(
  stdout: string,
  stderr?: string,
): ClaudeResult {
  // A resumed session whose JSONL no longer exists (e.g. the working dir was
  // renamed, or ~/.claude was cleaned) makes claude exit with this on stderr
  // and nothing on stdout. Flag it so the caller can drop the stale id and
  // restart fresh instead of surfacing a scary parse error.
  if (/No conversation found with session ID/i.test(`${stdout}\n${stderr ?? ''}`)) {
    return {
      ok: false,
      error: 'Saved session no longer exists.',
      staleSession: true,
    };
  }
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      session_id?: string;
      is_error?: boolean;
      permission_denials?: Array<{ tool_name?: string; tool_input?: any }>;
    };
    if (parsed.is_error) {
      return { ok: false, error: parsed.result || 'claude reported an error' };
    }
    return {
      ok: true,
      text: (parsed.result ?? '').trim(),
      session_id: parsed.session_id ?? null,
      questions: extractQuestions(parsed.permission_denials),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse claude JSON output: ${err instanceof Error ? err.message : String(err)}. Raw: ${stdout.slice(0, 300)}${stderr ? ` Stderr: ${stderr.slice(0, 200)}` : ''}`,
    };
  }
}

export async function checkClaudeInstalled(): Promise<ClaudeCheck> {
  let versionProc;
  try {
    versionProc = Bun.spawn(['claude', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return {
      installed: false,
      error: `Could not spawn claude: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const [vOut, vErr, vCode] = await Promise.all([
    new Response(versionProc.stdout).text(),
    new Response(versionProc.stderr).text(),
    versionProc.exited,
  ]);

  if (vCode !== 0) {
    return {
      installed: false,
      error: vErr.trim() || vOut.trim() || `claude --version exited ${vCode}`,
    };
  }

  let pathStr: string | undefined;
  try {
    const which = Bun.spawn(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, , code] = await Promise.all([
      new Response(which.stdout).text(),
      new Response(which.stderr).text(),
      which.exited,
    ]);
    if (code === 0) pathStr = out.trim() || undefined;
  } catch {
    // best-effort
  }

  return {
    installed: true,
    version: vOut.trim() || vErr.trim(),
    path: pathStr,
  };
}

/**
 * Claude Code engine. Live steps come from tailing the JSONL session file
 * Claude writes to ~/.claude/projects/… (see claude-stream), which runs
 * alongside the headless `claude -p` invocation.
 */
export const claudeEngine: Engine = {
  id: 'claude',
  label: ENGINE_LABELS.claude,
  check: checkClaudeInstalled,
  async run(prompt, sessionId, signal, onStep: OnStep): Promise<EngineResult> {
    // The JSONL file is named after the session id. On a brand-new session we
    // don't know it yet, so live streaming only kicks in once a session exists
    // (same limitation as before this was an engine).
    const sid = sessionId ?? 'unknown';
    const stopWatch = await watchSession(sid, onStep);
    let watchStopped = false;
    const stop = () => {
      if (watchStopped) return;
      watchStopped = true;
      stopWatch();
    };
    // Stop the watcher synchronously the moment we're aborted, so a replacement
    // run can't end up with two watchers tailing the same file.
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });

    try {
      const result = await runClaudeHeadless(prompt, sessionId, signal);
      // Give the watcher a beat to flush final writes — but not when aborted,
      // since a replacement run may already be watching the same file.
      if (!signal?.aborted) await sleep(1000);
      return result;
    } finally {
      stop();
    }
  },
};
