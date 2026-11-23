#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — optional public HTTPS tunnel.
#
# Refuses to run until JARVIS_ACCESS_TOKEN is set. A tunnel exposes this
# server to the internet; the access token is the only thing protecting it.
#
#   bash scripts/tunnel.sh              auto-detect cloudflared or ngrok
#   bash scripts/tunnel.sh cloudflared  force cloudflared quick tunnel
#   bash scripts/tunnel.sh ngrok        force ngrok
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${JARVIS_PORT:-8000}"
MODE="${1:-auto}"

say() { printf '\033[36m[jarvis]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[jarvis] %s\033[0m\n' "$*" >&2; exit 1; }

HAS_TOKEN="$(python - <<'PY'
from config import settings
print("yes" if settings.access_token else "no")
PY
)"

if [ "$HAS_TOKEN" != "yes" ]; then
  cat >&2 <<'EOF'
[jarvis] REFUSING TO OPEN A PUBLIC TUNNEL.

JARVIS_ACCESS_TOKEN is empty, so anyone with the URL could use your AI keys,
memory and tools. Set a token first:

  bash scripts/set-token.sh
  bash scripts/stop.sh && bash scripts/start.sh --bg
EOF
  exit 1
fi

if ! curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  fail "JARVIS is not responding on http://127.0.0.1:$PORT. Start it first: bash scripts/start.sh --bg"
fi

if [ "$MODE" = "auto" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    MODE="cloudflared"
  elif command -v ngrok >/dev/null 2>&1; then
    MODE="ngrok"
  else
    cat >&2 <<'EOF'
[jarvis] No tunnel client found.

Install one of these in Termux, then run this script again:

  cloudflared  — check availability with: pkg search cloudflared
  ngrok        — download from https://ngrok.com/download (Android ARM64 build)

Both give you an HTTPS URL. HTTPS is required for microphone access in
Android Chrome; plain http://LAN-IP does NOT allow the mic.

Alternatively, use an SSH reverse tunnel on a server you control:
  ssh -R 8080:127.0.0.1:8000 user@your-server
EOF
    exit 1
  fi
fi

cat <<EOF

[jarvis] Opening a PUBLIC tunnel to http://127.0.0.1:$PORT
[jarvis] Access token: ENABLED (the HUD will ask for it once)
[jarvis] Anyone with the URL + token can use this server. Ctrl+C closes the tunnel.
[jarvis] Note: the tunnel URL is HTTPS, so browser voice input works there.

EOF

case "$MODE" in
  cloudflared)
    command -v cloudflared >/dev/null 2>&1 || fail "cloudflared is not installed."
    exec cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate
    ;;
  ngrok)
    command -v ngrok >/dev/null 2>&1 || fail "ngrok is not installed."
    exec ngrok http "$PORT"
    ;;
  *)
    fail "Unknown mode '$MODE'. Use: auto, cloudflared or ngrok."
    ;;
esac
