# CLAUDE.md

## Updating

The deploy script lives in the repo at [`bin/safe-update-relay`](bin/safe-update-relay).
It runs the full cycle: `git pull` → `bun install` (only if deps changed) →
`bun run build` → `pm2 restart` → wait for the process to come back online →
ping the linked Telegram chat with a status summary (or the failing step). A
failed pull/build aborts before the restart, so working state is never taken
offline.

To trigger a deploy (detached so it survives `pm2 restart` killing its caller):

```bash
setsid nohup ~/coding-agent-telegram-relay/bin/safe-update-relay >/dev/null 2>&1 < /dev/null &
```

The `setsid nohup … &` prefix is required for that survival. The script also
re-execs itself from a `/tmp` copy on startup, so the `git pull` can safely
rewrite the in-repo copy mid-deploy.

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
