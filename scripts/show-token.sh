#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — owner-only access-token retrieval.
# Prints the token to THIS terminal only. It is never sent to the browser,
# written to logs, or included in API responses.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -t 0 ]; then
  echo "[jarvis] Refusing to print the access token without an interactive terminal." >&2
  exit 1
fi

python - <<'PY'
from config import ensure_access_token, settings

ensure_access_token()
token = settings.access_token
if not token:
    raise SystemExit(
        "[jarvis] No token is configured (JARVIS_ACCESS_TOKEN is explicitly empty).\n"
        "[jarvis] Generate one with: bash scripts/set-token.sh"
    )
print("\nJARVIS access token (owner only — treat it like a password):\n")
print("  " + token)
print("\nReset any time with: bash scripts/set-token.sh\n")
PY
