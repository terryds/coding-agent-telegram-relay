import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { api, type EngineId, type FeedEvent, type Status } from '../api';
import { AgentAuth } from '../components/AgentAuth';

type Props = { status: Status; onChange: () => void };

export function Dashboard({ status, onChange }: Props) {
  const [, setLocation] = useLocation();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const engineLabel =
    status.engines.find((e) => e.id === status.engine)?.label ?? status.engine;

  const loadFeed = async () => {
    try {
      const r = await api.feed(300);
      setEvents(r.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    loadFeed();
    const id = window.setInterval(loadFeed, 3000);
    return () => window.clearInterval(id);
  }, []);

  // Newest events render at the top. Keep the view pinned there as they stream
  // in, but only if the user is already near the top — don't yank them back up
  // while they're scrolled down reading older activity.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (el.scrollTop < 120) el.scrollTop = 0;
  }, [events]);

  const toggleRelay = async () => {
    setBusy('relay');
    setError(null);
    try {
      await api.setRelay(!status.relay_enabled);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const switchEngine = async (id: EngineId) => {
    if (id === status.engine) return;
    setBusy('engine');
    setError(null);
    try {
      await api.setEngine(id);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const resetSession = async () => {
    setBusy('session');
    setError(null);
    try {
      await api.resetSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async () => {
    if (!confirm('Reset bot token, chat link, and session? You will need to re-onboard.')) {
      return;
    }
    setBusy('reset');
    setError(null);
    try {
      await api.reset();
      onChange();
      setLocation('/onboarding');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full max-w-4xl mx-auto px-6 py-10 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {status.bot ? (
              <>
                Connected to{' '}
                <a
                  className="underline hover:text-zinc-200"
                  href={`https://t.me/${status.bot.username}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  @{status.bot.username}
                </a>{' '}
                · chat <code className="text-zinc-300">{status.chat_id}</code>
              </>
            ) : (
              'No bot connected'
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-full border border-zinc-700 overflow-hidden text-xs font-medium">
            {status.engines.map((e) => (
              <button
                key={e.id}
                onClick={() => switchEngine(e.id)}
                disabled={busy === 'engine'}
                className={[
                  'px-3 py-1 transition-colors disabled:opacity-50',
                  status.engine === e.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
                ].join(' ')}
                title="Switch coding agent — starts a fresh conversation"
              >
                {e.label}
              </button>
            ))}
          </div>
          <span
            className={[
              'inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium',
              status.relay_enabled
                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-800'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                status.relay_enabled ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500',
              ].join(' ')}
            />
            {status.relay_enabled ? 'Relay on' : 'Relay off'}
          </span>
        </div>
      </header>

      {error && (
        <div className="bg-red-950/40 border border-red-900/60 text-red-200 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          onClick={toggleRelay}
          disabled={busy === 'relay'}
          className={[
            'p-4 rounded-lg border text-left transition-colors disabled:opacity-50',
            status.relay_enabled
              ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
              : 'border-blue-700 bg-blue-950/40 hover:bg-blue-950/60',
          ].join(' ')}
        >
          <div className="font-medium text-sm">
            {status.relay_enabled ? 'Pause relay' : 'Enable relay'}
          </div>
          <div className="text-xs text-zinc-400 mt-1">
            {status.relay_enabled
              ? `Stop forwarding incoming messages to ${engineLabel}.`
              : `Start forwarding incoming messages to ${engineLabel}.`}
          </div>
        </button>

        <button
          onClick={resetSession}
          disabled={busy === 'session'}
          className="p-4 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-left transition-colors disabled:opacity-50"
        >
          <div className="font-medium text-sm">Reset {engineLabel} session</div>
          <div className="text-xs text-zinc-400 mt-1">
            Next message starts a fresh conversation.
          </div>
        </button>

        <button
          onClick={resetAll}
          disabled={busy === 'reset'}
          className="p-4 rounded-lg border border-red-900/60 bg-red-950/20 hover:bg-red-950/40 text-left transition-colors disabled:opacity-50"
        >
          <div className="font-medium text-sm text-red-200">Reset everything</div>
          <div className="text-xs text-red-300/70 mt-1">
            Clear bot token, chat link, and session.
          </div>
        </button>
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          {engineLabel} authentication
        </h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5">
          {/* Re-mount when the active engine changes so config reloads. Skip the
              auto-probe here — probing costs a request; the user clicks Check. */}
          <AgentAuth key={status.engine} engine={status.engine} autoProbe={false} />
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Activity
        </h2>
        {events.length === 0 ? (
          <p className="text-zinc-500 text-sm">No activity yet.</p>
        ) : (
          <div
            ref={feedRef}
            className="max-h-[65vh] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2"
          >
            {events.map((e) => (
              <FeedItem key={`${e.etype}-${e.id}`} event={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FeedItem({ event }: { event: FeedEvent }) {
  const ts = new Date(event.created_at).toLocaleTimeString();

  if (event.etype === 'step') {
    if (event.kind === 'thinking') {
      return (
        <Row label="🧠 thinking" ts={ts} tone="muted">
          <span className="italic text-zinc-400">…</span>
        </Row>
      );
    }
    if (event.kind === 'tool_use') {
      return (
        <Row label={`🛠 ${event.tool_name ?? '?'}`} ts={ts} tone="tool">
          {event.tool_input && <Pre>{event.tool_input}</Pre>}
        </Row>
      );
    }
    // tool_result
    return (
      <Row label="✅ result" ts={ts} tone="result">
        {event.result_text && <Pre>{event.result_text}</Pre>}
      </Row>
    );
  }

  // message
  const isIn = event.direction === 'in';
  return (
    <Row
      label={isIn ? '→ Telegram' : '← Agent'}
      ts={ts}
      tone={isIn ? 'in' : event.ok ? 'out' : 'error'}
      session={event.session_id}
    >
      <div className="whitespace-pre-wrap break-words text-zinc-100">
        {event.error ? (
          <span className="text-red-300">{event.error}</span>
        ) : (
          truncate(event.text, 600)
        )}
      </div>
    </Row>
  );
}

const TONES: Record<string, string> = {
  in: 'border-zinc-800 bg-zinc-900/40',
  out: 'border-blue-900/40 bg-blue-950/20',
  error: 'border-red-900/40 bg-red-950/20',
  muted: 'border-zinc-800/60 bg-zinc-900/20',
  tool: 'border-amber-900/40 bg-amber-950/10',
  result: 'border-emerald-900/40 bg-emerald-950/10',
};

function Row({
  label,
  ts,
  tone,
  session,
  children,
}: {
  label: string;
  ts: string;
  tone: keyof typeof TONES | string;
  session?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className={['rounded border px-3 py-2 text-sm', TONES[tone] ?? TONES.in].join(' ')}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
        <span className="text-xs text-zinc-600">{ts}</span>
      </div>
      <div className="font-mono text-xs text-zinc-200">{children}</div>
      {session && (
        <div className="text-[10px] text-zinc-600 mt-1 font-mono">
          session {session.slice(0, 8)}
        </div>
      )}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-zinc-300 mt-0.5">{children}</pre>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (+${s.length - n} chars)`;
}
