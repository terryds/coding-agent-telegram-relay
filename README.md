# claude-code-telegram

A tiny relay that forwards Telegram messages to [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) running on your VPS, and sends Claude's response back. Single-user, self-hosted, no external services beyond Telegram and your local `claude` CLI.

- **Stack**: [Bun](https://bun.sh) + React (Vite) + Tailwind + Wouter + `bun:sqlite`
- **No Telegram SDK** — just `fetch` against the Bot API
- **No Anthropic SDK** — spawns your local `claude` CLI (inherits your auth)
- **Session continuity** — Claude `--resume` keeps the conversation across messages
- **Three-step onboarding** UI: detect Claude, paste bot token, capture your chat ID

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.12`
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed and authenticated on the machine that runs the relay (`claude --version` must work)
- A Telegram bot — create one with [@BotFather](https://t.me/BotFather) and copy the token

## Local development

```bash
bun install
bun run dev
```

This launches the server (port `3000`, hot-reload) and Vite (port `5173`, proxying `/api` to the server). Open <http://localhost:5173>.

You'll be sent to `/onboarding`:

1. The page calls `/api/claude-check` and verifies `claude` is on PATH.
2. Paste your bot token. The server validates it via `getMe` and shows `@your_bot`.
3. Click **Start listening**, then open Telegram and message your bot. The first incoming message captures your chat ID and links it. The bot replies "✅ Chat linked".

After that you're on the dashboard, where you can toggle the relay, reset the Claude session, view recent messages, or reset everything.

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
git clone <your-fork-url> claude-code-telegram
cd claude-code-telegram
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
      name: 'claude-code-telegram',
      script: 'server/index.ts',
      interpreter: '/home/YOUR_USER/.bun/bin/bun',
      cwd: '/home/YOUR_USER/claude-code-telegram',
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
pm2 logs claude-code-telegram   # tail logs
pm2 save                         # persist the process list
pm2 startup                      # follow the printed instruction to enable on boot
```

Common pm2 commands:

```bash
pm2 status
pm2 restart claude-code-telegram
pm2 stop claude-code-telegram
pm2 logs claude-code-telegram --lines 200
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

## Bot commands

- `/start`, `/help` — show usage
- `/new_session` — start a fresh Claude conversation (forgets prior context)

## Data

Everything is stored in `data/app.db` (SQLite). Two tables:

- `settings` — key/value store (bot token, chat ID, session ID, relay enabled flag)
- `message_log` — recent in/out messages shown on the dashboard

To wipe state, stop the process, delete `data/app.db*`, and restart — or use **Reset everything** in the dashboard.

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
