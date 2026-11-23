#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — set, generate or clear the public access token.
#   bash scripts/set-token.sh                 generate a strong token
#   bash scripts/set-token.sh "my long token" use your own token
#   bash scripts/set-token.sh --clear         disable the token (local use only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[36m[jarvis]\033[0m %s\n' "$*"; }

if [ "${1:-}" = "--clear" ]; then
  python - <<'PY'
from config import update_env_file
update_env_file("JARVIS_ACCESS_TOKEN", "")
print("Access token cleared.")
PY
  say "Restart JARVIS for the change to take effect."
  say "WARNING: without a token, never expose this port through a public tunnel."
  exit 0
fi

GENERATED=0
if [ "$#" -ge 1 ]; then
  TOKEN="$1"
else
  TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
  GENERATED=1
fi

if [ "${#TOKEN}" -lt 8 ]; then
  echo "[jarvis] token must be at least 8 characters." >&2
  exit 1
fi

python - "$TOKEN" <<'PY'
import sys
from config import update_env_file
update_env_file("JARVIS_ACCESS_TOKEN", sys.argv[1])
print("Access token saved to .env (mode 0600).")
PY
chmod 600 .env 2>/dev/null || true

if [ "$GENERATED" -eq 1 ]; then
  say "Generated token (save it now, it is not shown again):"
  printf '\n  %s\n\n' "$TOKEN"
fi
say "Restart JARVIS: bash scripts/stop.sh && bash scripts/start.sh --bg"
say "Then enter the token once in the HUD lock screen."
say "Read it again any time with: bash scripts/show-token.sh"
say "Restarting also revokes all active browser logins."
