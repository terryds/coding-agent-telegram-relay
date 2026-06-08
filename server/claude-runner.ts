export type ClaudeResult =
  | { ok: true; text: string; session_id: string | null }
  | { ok: false; error: string };

// 10 minutes — long enough for complex tool-calling tasks,
// short enough to unblock the listener if the process hangs.
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

export async function runClaudeHeadless(
  prompt: string,
  sessionId: string | null
): Promise<ClaudeResult> {
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

  // Guard against Claude finishing work but the process never exiting.
  // When the timeout fires we kill the process, which closes its streams
  // and lets the Promise.all below resolve with whatever was already written.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`[claude-runner] killing claude (PID ${proc.pid}) after ${CLAUDE_TIMEOUT_MS / 1000}s timeout`);
    try { proc.kill(); } catch {}
    // If SIGTERM doesn't work, force-kill after 3s
    setTimeout(() => {
      try { proc.kill(9); } catch {}
    }, 3_000);
  }, CLAUDE_TIMEOUT_MS);

  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: `claude process error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
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

function tryParseOutput(
  stdout: string,
  stderr?: string,
): ClaudeResult {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: string;
      session_id?: string;
      is_error?: boolean;
    };
    if (parsed.is_error) {
      return { ok: false, error: parsed.result || 'claude reported an error' };
    }
    return {
      ok: true,
      text: (parsed.result ?? '').trim(),
      session_id: parsed.session_id ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse claude JSON output: ${err instanceof Error ? err.message : String(err)}. Raw: ${stdout.slice(0, 300)}${stderr ? ` Stderr: ${stderr.slice(0, 200)}` : ''}`,
    };
  }
}

export type ClaudeCheck = {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
};

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
