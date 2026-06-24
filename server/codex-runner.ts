/**
 * Codex engine. Drives OpenAI's `codex` CLI in headless mode:
 *
 *   codex exec --json [resume <id>] -C <cwd> <flags> "<prompt>"
 *
 * Unlike Claude Code (whose live steps come from tailing a JSONL file), Codex
 * streams structured events on stdout, one JSON object per line. We parse those
 * inline — emitting steps as they arrive and capturing the final agent message
 * + thread id (the session id used to resume) when the turn completes.
 *
 * Auth is handled out-of-band: the operator runs `codex login` (or sets an API
 * key) on the host, the same way they install/auth the Claude CLI.
 */
import {
  ENGINE_LABELS,
  nowTs,
  truncate,
  type Engine,
  type EngineCheck,
  type EngineResult,
  type EngineStep,
  type OnStep,
} from './engine.ts';

const CODEX_TIMEOUT_MS = Number(Bun.env.CODEX_TIMEOUT_MS || '0');

// Mirror Claude's `bypassPermissions`: no approval prompts, full access. The
// relay runs on the operator's own machine and is already trusted to run
// arbitrary Claude tool calls, so we match that posture for Codex.
const SANDBOX_FLAG = '--dangerously-bypass-approvals-and-sandbox';

function buildArgs(prompt: string, sessionId: string | null, cwd: string): string[] {
  // `resume` is a subcommand of `exec`, so all exec-level flags must come
  // BEFORE it; only the session id and prompt follow. Putting flags after
  // `resume` fails with "unexpected argument".
  const args = ['exec', '--json', SANDBOX_FLAG, '--skip-git-repo-check', '-C', cwd];
  if (sessionId) args.push('resume', sessionId);
  args.push(prompt);
  return args;
}

/**
 * Parse one Codex `exec --json` event into zero or more steps, while folding
 * terminal state (session id, final text, errors) into `acc`.
 */
type Acc = {
  sessionId: string | null;
  finalText: string;
  errored: string | null;
};

/**
 * Codex sometimes nests an upstream API error as a JSON string inside the
 * `message` field (e.g. `{"error":{"message":"…"}}`). Unwrap to the human text.
 */
function cleanError(raw: unknown): string {
  if (raw == null) return '';
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed?.error?.message || parsed?.message || trimmed;
    } catch {
      // fall through
    }
  }
  return trimmed;
}

function handleEvent(obj: any, acc: Acc): EngineStep[] {
  const type = obj?.type;
  const ts = nowTs();

  if (type === 'thread.started') {
    if (typeof obj.thread_id === 'string') acc.sessionId = obj.thread_id;
    return [];
  }

  if (type === 'turn.failed') {
    acc.errored = cleanError(obj?.error?.message ?? obj?.error) || 'Codex turn failed';
    return [];
  }

  if (type === 'error') {
    acc.errored = cleanError(obj?.message) || 'Codex reported an error';
    return [];
  }

  if (type !== 'item.started' && type !== 'item.completed') return [];

  const item = obj.item ?? {};
  const itemType = item.type;
  const completed = type === 'item.completed';

  switch (itemType) {
    case 'agent_message':
      // The assistant's reply. Capture the final one as the result text;
      // don't stream it as a step (deliverResult sends it at the end).
      if (completed && typeof item.text === 'string') acc.finalText = item.text;
      return [];

    case 'reasoning':
      if (!completed) return [];
      return [{ kind: 'thinking', ts }];

    case 'command_execution': {
      const cmd =
        typeof item.command === 'string'
          ? item.command
          : Array.isArray(item.command)
            ? item.command.join(' ')
            : JSON.stringify(item.command ?? {});
      if (!completed) {
        return [{ kind: 'tool_use', ts, toolName: 'shell', toolInput: truncate(cmd, 300) }];
      }
      const out =
        item.aggregated_output ?? item.output ?? `exit ${item.exit_code ?? '?'}`;
      return [{ kind: 'tool_result', ts, resultText: truncate(String(out), 300) }];
    }

    case 'file_change': {
      if (!completed) return [];
      const files = Array.isArray(item.changes)
        ? item.changes.map((c: any) => c?.path).filter(Boolean).join(', ')
        : JSON.stringify(item.changes ?? {});
      return [{ kind: 'tool_use', ts, toolName: 'edit', toolInput: truncate(String(files), 300) }];
    }

    case 'mcp_tool_call': {
      const name = [item.server, item.tool].filter(Boolean).join('.') || 'mcp_tool';
      if (!completed) {
        return [
          { kind: 'tool_use', ts, toolName: name, toolInput: truncate(JSON.stringify(item.arguments ?? {}), 300) },
        ];
      }
      const res = item.result ?? item.output ?? '';
      return res ? [{ kind: 'tool_result', ts, resultText: truncate(String(res), 300) }] : [];
    }

    case 'web_search': {
      if (!completed) return [];
      return [{ kind: 'tool_use', ts, toolName: 'web_search', toolInput: truncate(String(item.query ?? ''), 300) }];
    }

    default:
      return [];
  }
}

export async function runCodexHeadless(
  prompt: string,
  sessionId: string | null,
  signal: AbortSignal | undefined,
  onStep: OnStep
): Promise<EngineResult> {
  if (signal?.aborted) {
    return { ok: false, error: 'Stopped before starting.', aborted: true };
  }

  const args = buildArgs(prompt, sessionId, process.cwd());

  let proc;
  try {
    // stdin = /dev/null: the prompt is passed as an arg, and we must not let
    // codex block waiting to read a piped prompt from stdin.
    proc = Bun.spawn(['codex', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to spawn codex CLI: ${err instanceof Error ? err.message : String(err)}. Is it installed and on PATH?`,
    };
  }

  const spawned = proc;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const killProc = (reason: string): void => {
    console.log(`[codex-runner] killing codex (PID ${spawned.pid}): ${reason}`);
    try { spawned.kill(); } catch {}
    forceKillTimer = setTimeout(() => {
      try { spawned.kill(9); } catch {}
    }, 3_000);
  };

  let timedOut = false;
  const timer = CODEX_TIMEOUT_MS > 0
    ? setTimeout(() => { timedOut = true; killProc(`${CODEX_TIMEOUT_MS / 1000}s timeout`); }, CODEX_TIMEOUT_MS)
    : undefined;

  let aborted = false;
  const onAbort = () => { aborted = true; killProc('aborted by caller'); };
  signal?.addEventListener('abort', onAbort, { once: true });

  const acc: Acc = { sessionId, finalText: '', errored: null };

  // Stream stdout line-by-line, parsing each JSON event as it arrives.
  const readStdout = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          const steps = handleEvent(obj, acc);
          for (const step of steps) {
            try { await onStep(step); } catch {}
          }
        }
      }
    } catch (err) {
      if (!aborted) console.error('[codex-runner] stdout read error:', err);
    }
  };

  let stderr = '';
  try {
    [, stderr] = await Promise.all([
      readStdout(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: `codex process error: ${err instanceof Error ? err.message : String(err)}`,
      aborted,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (aborted) return { ok: false, error: 'Stopped by user.', aborted: true };

  if (acc.errored && !acc.finalText) {
    // If a resume failed because the thread/session can't be found, flag it so
    // the caller drops the stale id and restarts fresh.
    const stale =
      sessionId != null &&
      /not found|no (such )?(session|thread|conversation|rollout)/i.test(acc.errored);
    return { ok: false, error: acc.errored, staleSession: stale || undefined };
  }

  if (timedOut && !acc.finalText) {
    return {
      ok: false,
      error: `Codex timed out after ${CODEX_TIMEOUT_MS / 60_000} minutes.`,
    };
  }

  if (!acc.finalText && proc.exitCode !== 0) {
    return {
      ok: false,
      error: `codex exited ${proc.exitCode}.${stderr ? ` ${stderr.slice(0, 300)}` : ''}`,
    };
  }

  return { ok: true, text: acc.finalText.trim(), session_id: acc.sessionId };
}

export async function checkCodexInstalled(): Promise<EngineCheck> {
  let versionProc;
  try {
    versionProc = Bun.spawn(['codex', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  } catch (err) {
    return {
      installed: false,
      error: `Could not spawn codex: ${err instanceof Error ? err.message : String(err)}`,
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
      error: vErr.trim() || vOut.trim() || `codex --version exited ${vCode}`,
    };
  }

  let pathStr: string | undefined;
  try {
    const which = Bun.spawn(['which', 'codex'], { stdout: 'pipe', stderr: 'pipe' });
    const [out, , code] = await Promise.all([
      new Response(which.stdout).text(),
      new Response(which.stderr).text(),
      which.exited,
    ]);
    if (code === 0) pathStr = out.trim() || undefined;
  } catch {
    // best-effort
  }

  return { installed: true, version: vOut.trim() || vErr.trim(), path: pathStr };
}

export const codexEngine: Engine = {
  id: 'codex',
  label: ENGINE_LABELS.codex,
  check: checkCodexInstalled,
  run: runCodexHeadless,
};
