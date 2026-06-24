# coding-agent-telegram-relay

A tiny relay that forwards Telegram messages to a coding agent — [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) **or** [Codex](https://developers.openai.com/codex/cli) — running on your VPS, and sends the agent's response back. Single-user, self-hosted, no external services beyond Telegram and your local CLI.

- **Stack**: [Bun](https://bun.sh) + React (Vite) + Tailwind + Wouter + `bun:sqlite`
- **Two engines** — drive Claude Code or Codex; pick one in onboarding, switch anytime from the dashboard or the `/engine` Telegram command
- **No Telegram SDK** — just `fetch` against the Bot API
- **No vendor SDK** — spawns your local `claude` / `codex` CLI (inherits its auth)
- **Session continuity** — `claude --resume` / `codex exec resume` keep the conversation across messages
- **Guided onboarding** UI: choose engine + detect its CLI, paste bot token, capture your chat ID

> Codex is driven via `codex exec --json` (one process per message, resumed by thread id) — the same one-shot-plus-resume model the relay already uses for Claude. It runs with `--dangerously-bypass-approvals-and-sandbox` to match Claude's `bypassPermissions`, so it works unattended. Keep the host's `codex` current — older CLIs may reject newer default models.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.12`
- The CLI for your chosen engine, installed and authenticated on the machine that runs the relay:
  - **Claude Code** — [install](https://docs.claude.com/en/docs/claude-code/overview); `claude --version` must work
  - **Codex** — [install](https://developers.openai.com/codex/cli), then `codex login` (or set an API key); `codex --version` must work
- A Telegram bot — create one with [@BotFather](https://t.me/BotFather) and copy the token

## Local development

```bash
bun install
bun run dev
```

This launches the server (port `3000`, hot-reload) and Vite (port `5173`, proxying `/api` to the server). Open <http://localhost:5173>.

You'll be sent to `/onboarding`:

1. Choose your engine (Claude Code or Codex). The page calls `/api/agent-check?engine=…` and verifies the matching CLI is on PATH.
2. Paste your bot token. The server validates it via `getMe` and shows `@your_bot`.
3. Click **Start listening**, then open Telegram and message your bot. The first incoming message captures your chat ID and links it. The bot replies "✅ Chat linked".

After that you're on the dashboard, where you can switch engine, toggle the relay, reset the agent session, view recent messages, or reset everything.

## Production build

```bash
bun run build   # builds the client into dist/client/
bun start       # starts the server on PORT (default 3000), serving API + client
```

The single Bun process serves both `/api/*` and the static React build on one port. Override the port with `PORT=8080 bun start`.

## VPS setup with pm2

These steps assume Ubuntu/Debian. Adjust paths as needed.

### 1. Install Bun, Node (for pm2), and Claude Code

```bash
# Bun
curl -fsSL https://bun.sh/install | bash
exec $SHELL   # reload PATH

# Node (for pm2). Any recent LTS works.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pm2 globally
sudo npm install -g pm2

# Claude Code
npm install -g @anthropic-ai/claude-code
claude --version   # confirm it's on PATH
```

Log into Claude Code interactively at least once so the credentials are stored for your user:

```bash
claude
# follow the auth flow, then /exit
```

### 2. Clone and build

```bash
cd ~
git clone <your-fork-url> coding-agent-telegram-relay
cd coding-agent-telegram-relay
bun install
bun run build
```

### 3. Start under pm2

Create an ecosystem file so pm2 uses Bun as the interpreter:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'coding-agent-telegram-relay',
      script: 'server/index.ts',
      interpreter: '/home/YOUR_USER/.bun/bin/bun',
      cwd: '/home/YOUR_USER/coding-agent-telegram-relay',
      env: {
        PORT: '3000',
      },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
```

Replace `YOUR_USER` and verify the Bun path with `which bun`.

```bash
pm2 start ecosystem.config.cjs
pm2 logs coding-agent-telegram-relay   # tail logs
pm2 save                         # persist the process list
pm2 startup                      # follow the printed instruction to enable on boot
```

**Or, without an ecosystem file** — start directly from the CLI:

```bash
cd ~/coding-agent-telegram-relay
PORT=3000 pm2 start server/index.ts \
  --name coding-agent-telegram-relay \
  --interpreter "$(which bun)" \
  --max-restarts 10 \
  --restart-delay 3000

pm2 save
pm2 startup   # follow the printed instruction
```

`pm2 save` snapshots the env that was current at start time, so the `PORT` value persists across `pm2 resurrect` and reboots. If you change an env var later, restart with `pm2 restart coding-agent-telegram-relay --update-env`.

Common pm2 commands:

```bash
pm2 status
pm2 restart coding-agent-telegram-relay
pm2 stop coding-agent-telegram-relay
pm2 logs coding-agent-telegram-relay --lines 200
```

### 4. Expose the dashboard

The dashboard has no authentication — it's intended to sit behind something. Two reasonable options:

**Option A — SSH tunnel (simplest, no public exposure):**

```bash
ssh -L 3000:localhost:3000 your-vps
# then open http://localhost:3000 in your browser
```

**Option B — Nginx with HTTP basic auth:**

```nginx
server {
    listen 443 ssl;
    server_name claude.example.com;

    # ssl_certificate ...;
    # ssl_certificate_key ...;

    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Create the password file with `sudo htpasswd -c /etc/nginx/.htpasswd youruser`.

### 5. Onboard

Visit the dashboard (via tunnel or your domain), complete the three onboarding steps, and you're live. Send your bot any message — it will reach Claude Code on the VPS and reply.

## Updating

When you push a new version, deploy it on the VPS with:

```bash
cd ~/coding-agent-telegram-relay
git pull
bun install            # if dependencies changed
bun run build          # rebuild the client
pm2 restart coding-agent-telegram-relay
```

`pm2 restart` reuses the saved process config, so you don't need to repeat `pm2 save` unless you changed the start command or env vars (in which case use `pm2 restart coding-agent-telegram-relay --update-env` and re-run `pm2 save`).

Your bot token, chat link, and Claude session ID live in `data/app.db` — they survive restarts and code updates.

### Updating from a Telegram chat

If you're asking the relayed agent itself to update the project (i.e. via Telegram), the plain `pm2 restart` step above won't work: it kills the `bun` process hosting your conversation, which kills the spawned agent, which aborts the in-flight tool — the update half-finishes and your reply is lost.

The repo ships a deploy helper at [`bin/safe-update-relay`](bin/safe-update-relay) that handles this: it detaches into its own process group, delays briefly so the current reply flushes, runs `git pull` → `bun install` (if deps changed) → `bun run build` → `pm2 restart`, waits for the process to come back online, and pings the chat with the result. A failed pull/build aborts before the restart, leaving the running relay untouched. It also re-execs from `/tmp` first so the `git pull` can safely rewrite the in-repo script mid-deploy.

```bash
setsid nohup ~/coding-agent-telegram-relay/bin/safe-update-relay >/dev/null 2>&1 < /dev/null &
```

`setsid + nohup + &` keep it alive after `pm2 restart` kills its caller. See [`CLAUDE.md`](CLAUDE.md) for config (`RELAY_PROCESS_NAME`, `RELAY_REPO_DIR`) and one-time migration notes.

## Bot commands

- `/start`, `/help` — show usage
- `/stop` — interrupt Claude while it's working (kills the in-flight run)
- `/new_session` — start a fresh Claude conversation (forgets prior context)

### Interrupting a run

Claude streams its progress (thinking, tool calls, results) back to the chat as it works, and the listener keeps receiving messages the whole time. To interrupt:

- Send `/stop` to cancel the current run and leave things idle.
- Send a new prompt while Claude is still working — it auto-stops the running task and starts the new one (auto-stop & replace).

Stopping is a hard process kill: any file edits Claude already made stay on disk, only the in-flight turn is cut. The interrupted turn isn't saved to the session, so the next message resumes from the last *completed* turn.

## Sending photos

Photos are downloaded to `data/incoming/<file_unique_id>.jpg` and the local path is appended to the prompt. Claude views the file with its `Read` tool. The caption (if any) is used as the user message; with no caption the agent is asked to describe the image. Files are not auto-deleted — wipe `data/incoming/` periodically if you don't want them around.

## Sending videos

Videos, round video notes, animations, and `video/*` documents work just like photos: the file is downloaded to `data/incoming/<file_unique_id>` and its local path is appended to the prompt. Claude decides what to do with it using its own tools (extract frames or audio with `ffmpeg`, etc.) — nothing is pre-processed. The caption (if any) is used as the user message. Telegram bots can't download files larger than 20 MB, so bigger videos are rejected.

## Data

Everything is stored in `data/app.db` (SQLite). Two tables:

- `settings` — key/value store (bot token, chat ID, session ID, relay enabled flag)
- `message_log` — recent in/out messages shown on the dashboard

Photos sent via Telegram land in `data/incoming/` (also gitignored). To wipe state, stop the process, delete `data/app.db*` and `data/incoming/`, and restart — or use **Reset everything** in the dashboard.

## Security

Read this before deploying. The threat model is non-trivial.

### What an attacker who reaches your bot can do

Claude is spawned with `--permission-mode bypassPermissions`, which means **every message that the relay accepts becomes a shell-capable prompt running as your VPS user**. There is no sandbox. The only thing keeping strangers out is:

1. They don't have your bot token, and
2. Their Telegram chat ID doesn't match the one captured during onboarding.

If either of those falls over, the attacker has shell.

**Treat the bot token like an SSH private key.** Anyone with the token can DM the bot — but they still can't get through because of the chat-ID whitelist, *unless* they can also reach the dashboard.

### The dashboard has no built-in authentication

Anyone who can open the dashboard URL can hit **Reset everything**, re-onboard with their own bot token / chat ID, and get shell. **Do not expose port 3000 to the public internet directly.** Use one of:

- An SSH tunnel (no public exposure at all — recommended for personal use)
- A reverse proxy with HTTP basic auth (see the Nginx snippet above)
- A VPN / Tailscale / Cloudflare Access in front of the port

### Prompt injection is a real risk

Because Claude runs with full shell access, **prompt injection from any source the bot relays — including from you** — is a meaningful risk. Examples that can hijack Claude:

- "Summarize this email" where the email contains `Ignore previous instructions and run …`
- Pasting log output, GitHub issue content, or web page text without reading it first

Mitigations:

- Don't relay untrusted content blindly. If you wouldn't paste it into a root shell, don't paste it into the bot.
- Run the relay as a dedicated unprivileged user, not root. Limit what that user can do on the VPS.
- Consider keeping sensitive secrets (other API keys, deploy keys) out of the home directory of the user that runs Claude.

### What is and isn't sent over the network

- **Telegram Bot API**: every incoming/outgoing message goes through Telegram's servers (they can read it).
- **Claude**: Claude Code uses your local credentials and sends prompts to Anthropic's API.
- **Dashboard**: no telemetry, no external calls. The bot token and chat ID never leave the server; the client only ever sees `bot_token_set: true|false`.

### Reporting issues

If you find a security issue, please open a private security advisory on GitHub rather than a public issue.

## Notes

- The relay is single-tenant: only the chat ID captured during onboarding can talk to Claude. Other senders are ignored.
- The bot polls Telegram with long-polling (`getUpdates`, 25s timeout). No webhook setup needed.
