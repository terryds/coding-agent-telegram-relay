#!/usr/bin/env bash
# Shared dependency definitions + helpers for bin/doctor and bin/install.
# Sourced, not executed directly. Targets Ubuntu/Debian for installs, but the
# check helpers here are OS-agnostic.

# Core tools the relay + deploy script require.
#   git, curl  — clone/pull, and curl bootstraps bun + NodeSource
#   bun        — runtime, build, start
#   node, npm  — only as the vehicle for pm2
#   pm2        — process manager for production
#   jq, sqlite3 — used by bin/safe-update-relay (Telegram notify reads app.db)
CORE_DEPS=(git curl bun node npm pm2 jq sqlite3)

# At least one of these is needed to actually do anything; auth is manual.
AGENT_CLIS=(claude codex)

# Colors, only when stdout is a terminal.
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_WARN=''; C_DIM=''; C_RST=''
fi

have() { command -v "$1" >/dev/null 2>&1; }

# Best-effort one-line version string for a tool.
version_of() {
  case "$1" in
    bun)     bun --version 2>/dev/null ;;
    node)    node --version 2>/dev/null ;;
    npm)     npm --version 2>/dev/null ;;
    pm2)     pm2 --version 2>/dev/null | head -1 ;;
    git)     git --version 2>/dev/null | awk '{print $3}' ;;
    jq)      jq --version 2>/dev/null ;;
    sqlite3) sqlite3 --version 2>/dev/null | awk '{print $1}' ;;
    curl)    curl --version 2>/dev/null | head -1 | awk '{print $2}' ;;
    claude)  claude --version 2>/dev/null | head -1 ;;
    codex)   codex --version 2>/dev/null | head -1 ;;
    *)       "$1" --version 2>/dev/null | head -1 ;;
  esac
}

# Install/login pointers for the agent CLIs (no auto-install).
agent_hint() {
  case "$1" in
    claude) echo "https://docs.claude.com/en/docs/claude-code/overview  (then run: claude  and sign in)" ;;
    codex)  echo "https://developers.openai.com/codex/cli  (then run: codex login)" ;;
  esac
}
