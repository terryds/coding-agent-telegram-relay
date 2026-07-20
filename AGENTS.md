# AGENTS.md

Guidance for AI coding agents working in this repo. (Claude Code reads this via
the `@AGENTS.md` import in `CLAUDE.md`.)

This is a single-user, self-hosted relay that forwards Telegram messages to a
coding agent — **Claude Code or Codex** — running on the host, and sends the
reply back. Stack: Bun + React (Vite) + Tailwind + `bun:sqlite`. The active
engine is a global setting (switchable via the dashboard or the `/engine`
Telegram command); engine implementations live behind `server/engine.ts` /
`server/engines.ts`.

## Replying over Telegram

When your reply will be sent back to Telegram, output URLs as bare, unformatted
links — never wrap them in Markdown emphasis (`**…**`, `*…*`, `_…_`) or link
syntax. Telegram's parser mangles a URL wrapped in bold (e.g.
`**https://example.com**`), producing a broken/incorrect link. Just paste the
raw URL on its own:

```
https://example.com/#project/foo
```

## Messaging the user proactively (reminders, "tell me later")

The relay is purely reactive: each incoming Telegram message spawns a one-shot
headless run (`claude -p` / `codex exec`), and your process dies the moment
your turn ends. Harness timers (`ScheduleWakeup`, cron tools, background
tasks) will **not** fire after that — never rely on them here.

To push a message to the user's Telegram at any time, use:

```bash
bin/notify "your message"        # or pipe:  some-command | bin/notify
```

It reads the bot token and linked chat id from the relay's settings DB
(`data/app.db`), so it works even while the relay is down. Options:
`--chat <id>` / `--thread <id>` to target a linked group topic, `--html` for
Telegram-HTML (default is plain text — safest for piped output), `--dry-run`
to print the request instead of sending.

To say something **later**, schedule a detached job that outlives your turn
(same trick safe-update-relay uses). Use an absolute path — resolve it while
your turn is still alive, e.g. `N="$PWD/bin/notify"`:

```bash
# one-off in 2 minutes — survives your process exiting and pm2 restarts,
# but NOT a host reboot; use cron for durable/recurring schedules:
setsid nohup bash -c "sleep 120 && \"$N\" '👋 2 minutes are up'" >/dev/null 2>&1 &
```

For "check X later and tell me" — a real agent turn, not canned text — have
the scheduled job run a fresh headless turn and pipe the result:

```bash
setsid nohup bash -c "sleep 7200 && cd $PWD && claude -p 'Check the deploy status of foo; summarize in 3 lines.' --permission-mode bypassPermissions 2>&1 | \"$N\"" >/dev/null 2>&1 &
```

Prefer a fresh session with a self-contained prompt over `--resume`: resuming
the relay's live session from a background job can race with a run the relay
starts at the same moment.

### Recurring checks (cron)

For "check X every N hours", install a crontab entry (survives reboots; the
relay doesn't need to be running). Rules that matter:

- **cron's PATH is nearly empty** (`/usr/bin:/bin`) — resolve absolute paths
  while your turn is alive (`command -v claude`, `$PWD/bin/notify`) and use
  those in the entry. A bare `claude` silently does nothing under cron.
- **Every firing is a fresh session with no memory** — write the prompt to be
  self-contained ("alert only if >80%", not "check it again"). If a check
  needs to compare against last time, have the prompt read/write a state file
  (e.g. under `/tmp` or the repo's `data/`).
- **Every firing is a billed agent turn** — keep scheduled prompts small, and
  prefer "message only when something's wrong" prompts so quiet runs stay
  cheap and don't spam the chat (`bin/notify` skips empty input).

```bash
CLAUDE="$(command -v claude)"; N="$PWD/bin/notify"
( crontab -l 2>/dev/null; echo "0 */6 * * * cd $PWD && $CLAUDE -p 'Check disk usage on this host; reply ONLY if a filesystem is over 80% full, else output nothing.' --permission-mode bypassPermissions 2>&1 | $N" ) | crontab -
```

List entries with `crontab -l`; remove one by filtering it out and re-piping
to `crontab -`. When the user asks to stop a recurring check, do that cleanup.

## Setup

Install the system dependencies (bun, Node, pm2, git, jq, sqlite3):

```bash
bin/doctor     # read-only: report what's present / missing
bin/install    # install anything missing (Ubuntu/Debian, idempotent, uses sudo)
```

`bin/install` does **not** install or log into the agent CLIs — install + auth
Claude Code (`claude`) and/or Codex (`codex login`) yourself; `bin/doctor`
prints the links. See the README "VPS setup" section for the full flow.

## Updating

To pull, build, and restart the relay seamlessly (and get a Telegram ping when
it's back), run:

```bash
setsid nohup ~/coding-agent-telegram-relay/bin/safe-update-relay >/dev/null 2>&1 < /dev/null &
```

The `setsid nohup … &` prefix is required so the script survives `pm2 restart`
killing its caller. The script re-execs itself from a `/tmp` copy on startup, so
the `git pull` can safely rewrite the in-repo copy mid-deploy. A failed
pull/build aborts before the restart, leaving the running relay untouched.

Config via env vars (defaults shown):

- `RELAY_PROCESS_NAME` — pm2 process name (default `coding-agent-telegram-relay`)
- `RELAY_REPO_DIR` — checkout to deploy (default: auto-derived from the script's
  own location, i.e. the repo it lives in)

### One-time VPS migration (from the old `claude-code-telegram` name)

The repo, dir, and pm2 process were renamed. If your VPS still uses the old
names, after the first pull either rename them or override via env:

```bash
# Option A — keep old names, just override the pm2 process name per run:
RELAY_PROCESS_NAME=claude-code-telegram ~/claude-code-telegram/bin/safe-update-relay

# Option B — migrate to the new names (then the defaults just work):
pm2 delete claude-code-telegram
mv ~/claude-code-telegram ~/coding-agent-telegram-relay
cd ~/coding-agent-telegram-relay
pm2 start "bun start" --name coding-agent-telegram-relay   # re-add with your usual env (PORT, etc.)
pm2 save
```

The old external `~/bin/safe-update-relay` can be deleted once the in-repo
script is in use.
