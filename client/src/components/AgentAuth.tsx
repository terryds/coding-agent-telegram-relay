import { useEffect, useState } from 'react';
import { api, type AuthMethod, type EngineAuth, type EngineId } from '../api';

const DOCS: Record<
  EngineId,
  { label: string; loginCmd: string; keyEnv: string; keyHelp: string; href: string }
> = {
  claude: {
    label: 'Claude Code',
    loginCmd: 'claude   # then type /login and follow the flow',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyHelp: 'Anthropic API key (starts with sk-ant-…)',
    href: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  codex: {
    label: 'Codex',
    loginCmd: 'codex login',
    keyEnv: 'OPENAI_API_KEY',
    keyHelp: 'OpenAI API key (starts with sk-…)',
    href: 'https://developers.openai.com/codex/cli',
  },
};

type Props = {
  engine: EngineId;
  /** Run a live probe on mount / engine change. Onboarding wants this; the
   *  dashboard defaults to off (probing costs a request) and probes on demand. */
  autoProbe?: boolean;
  /** Notified whenever a probe resolves, so a parent can gate on auth. */
  onAuthed?: (authed: boolean) => void;
};

export function AgentAuth({ engine, autoProbe = true, onAuthed }: Props) {
  const docs = DOCS[engine];

  const [method, setMethod] = useState<AuthMethod>('subscription');
  const [hasKey, setHasKey] = useState(false);
  const [auth, setAuth] = useState<EngineAuth | null>(null);
  const [checking, setChecking] = useState(false);
  const [probed, setProbed] = useState(false);

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Interactive Claude subscription sign-in (no terminal).
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState('');
  const [loginBusy, setLoginBusy] = useState<'start' | 'submit' | null>(null);
  const [loginErr, setLoginErr] = useState<string | null>(null);

  const probe = async () => {
    setChecking(true);
    setErr(null);
    try {
      const r = await api.authCheck(engine);
      setAuth(r);
      setMethod(r.method);
      setHasKey(r.hasKey);
      setProbed(true);
      onAuthed?.(r.authed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const loadConfig = async () => {
    try {
      const c = await api.authConfig(engine);
      setMethod(c.method);
      setHasKey(c.hasKey);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    // Reset per-engine state, then either probe (onboarding) or just load the
    // saved config (dashboard) so we don't spend a request on every page load.
    setAuth(null);
    setProbed(false);
    setKey('');
    resetLogin();
    onAuthed?.(false);
    if (autoProbe) probe();
    else loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const resetLogin = () => {
    setLoginUrl(null);
    setLoginCode('');
    setLoginErr(null);
    api.claudeLoginCancel().catch(() => {});
  };

  const startLogin = async () => {
    setLoginBusy('start');
    setLoginErr(null);
    try {
      const r = await api.claudeLoginStart();
      setLoginUrl(r.url); // starts the status poll (effect below)
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(null);
    }
  };

  const submitLogin = async () => {
    setLoginBusy('submit');
    setLoginErr(null);
    try {
      // Feed the code; the poll detects completion and finishes the flow.
      await api.claudeLoginCode(loginCode.trim());
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(null);
    }
  };

  // While a sign-in is in progress, poll for completion. setup-token finishes
  // either on its own (loopback browser tab) or after the pasted code — both
  // surface here as state 'done'.
  useEffect(() => {
    if (!loginUrl) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await api.claudeLoginStatus();
        if (stopped) return;
        if (s.state === 'done') {
          setLoginUrl(null);
          setLoginCode('');
          await probe();
          return;
        }
        if (s.state === 'error') {
          setLoginErr(s.error || 'Sign-in failed — try again.');
          setLoginUrl(null);
          return;
        }
      } catch {
        // keep polling
      }
      if (!stopped) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginUrl]);

  const chooseMethod = async (m: AuthMethod) => {
    if (m === method) return;
    setMethod(m);
    setErr(null);
    try {
      await api.setAuthConfig(engine, { method: m });
      await probe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveKey = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.setAuthConfig(engine, { method: 'apikey', apiKey: key.trim() });
      setKey('');
      await probe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const authed = auth?.authed === true;

  return (
    <div className="space-y-4">
      {/* Status line */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          {checking ? (
            <span className="text-zinc-400">Checking authentication…</span>
          ) : authed ? (
            <span className="text-emerald-400">
              Authenticated via {method === 'apikey' ? 'API key' : 'subscription login'}.
            </span>
          ) : probed ? (
            <span className="text-amber-400">Not authenticated.</span>
          ) : (
            <span className="text-zinc-400">
              Auth not checked yet ({method === 'apikey' ? 'API key' : 'subscription login'}
              {method === 'apikey' && !hasKey ? ', no key saved' : ''}).
            </span>
          )}
        </div>
        <button
          onClick={probe}
          disabled={checking}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded text-sm shrink-0"
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {/* Method toggle */}
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1.5">
          Auth method
        </div>
        <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden text-sm font-medium">
          {(['subscription', 'apikey'] as AuthMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => chooseMethod(m)}
              disabled={checking || saving}
              className={[
                'px-3 py-1.5 transition-colors disabled:opacity-50',
                method === m
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
              ].join(' ')}
            >
              {m === 'subscription' ? 'Subscription' : 'API key'}
            </button>
          ))}
        </div>
      </div>

      {/* Method-specific guidance */}
      {method === 'subscription' ? (
        engine === 'claude' ? (
          <div className="text-sm space-y-3">
            {!authed && (
              <p className="text-zinc-400">
                Sign in with your Claude subscription — no terminal needed.
              </p>
            )}
            {!loginUrl ? (
              <button
                onClick={startLogin}
                disabled={loginBusy === 'start' || checking}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
              >
                {loginBusy === 'start'
                  ? 'Starting…'
                  : authed
                    ? 'Sign in again'
                    : 'Sign in with Claude'}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-zinc-300">
                  A browser should open automatically — just <strong>authorize</strong>,
                  and this finishes on its own. If it didn't open:
                </p>
                <div className="flex gap-2">
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-medium"
                  >
                    Open sign-in page ↗
                  </a>
                  <button
                    onClick={() => navigator.clipboard?.writeText(loginUrl)}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs"
                  >
                    Copy link
                  </button>
                </div>
                <div className="inline-flex items-center gap-2 text-zinc-400 text-xs">
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                  Waiting for you to authorize…
                </div>
                <div className="border-t border-zinc-800 pt-3 space-y-1.5">
                  <p className="text-zinc-400 text-xs">
                    On a remote server (no browser)? Paste the code the page shows
                    you — or the full callback URL:
                  </p>
                  <div className="flex gap-2">
                    <input
                      autoComplete="off"
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                      placeholder="paste code here…"
                      value={loginCode}
                      onChange={(e) => setLoginCode(e.target.value)}
                      disabled={loginBusy === 'submit'}
                    />
                    <button
                      onClick={submitLogin}
                      disabled={loginBusy === 'submit' || !loginCode.trim()}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
                    >
                      {loginBusy === 'submit' ? 'Sending…' : 'Submit code'}
                    </button>
                  </div>
                </div>
                <button
                  onClick={resetLogin}
                  className="text-zinc-500 hover:text-zinc-300 text-xs underline"
                >
                  Cancel
                </button>
              </div>
            )}
            {loginErr && (
              <pre className="bg-zinc-900 text-red-300/90 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
                {loginErr}
              </pre>
            )}
            <p className="text-xs text-zinc-600">
              Prefer the terminal? Run <code className="text-zinc-400">claude</code> then{' '}
              <code className="text-zinc-400">/login</code> on the host instead.
            </p>
          </div>
        ) : (
          <div className="text-sm text-zinc-400 space-y-2">
            <p>
              Uses {docs.label}'s own login on this machine. Sign in once in a
              terminal on the host, then re-check:
            </p>
            <pre className="bg-zinc-900 text-zinc-200 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
              {docs.loginCmd}
            </pre>
          </div>
        )
      ) : (
        <div className="text-sm space-y-2">
          <p className="text-zinc-400">
            The key is stored on this server and passed to {docs.label} as{' '}
            <code className="text-zinc-200">{docs.keyEnv}</code> on every run.
            Billing goes against this key (pay-per-token), not a subscription.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              placeholder={hasKey ? '•••••••••• (saved — paste to replace)' : docs.keyHelp}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={saving}
            />
            <button
              onClick={saveKey}
              disabled={saving || !key.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
            >
              {saving ? 'Saving…' : hasKey ? 'Replace' : 'Save key'}
            </button>
          </div>
          {hasKey && (
            <button
              onClick={() => api.setAuthConfig(engine, { apiKey: '' }).then(() => setHasKey(false))}
              className="text-zinc-500 hover:text-zinc-300 text-xs underline"
            >
              Remove saved key
            </button>
          )}
        </div>
      )}

      {/* Probe error detail */}
      {!authed && probed && auth?.error && (
        <pre className="bg-zinc-900 text-amber-300/80 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
          {auth.error}
        </pre>
      )}
      {err && <p className="text-red-400 text-sm">{err}</p>}

      <p className="text-xs text-zinc-600">
        Need the CLI or an account?{' '}
        <a className="underline hover:text-zinc-400" href={docs.href} target="_blank" rel="noreferrer">
          {docs.label} docs
        </a>
        .
      </p>
    </div>
  );
}
