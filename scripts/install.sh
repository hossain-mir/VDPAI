#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — Termux installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[36m[jarvis]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[jarvis] %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking Python…"
command -v python >/dev/null 2>&1 || fail "Python missing. Run: pkg install python"
python - <<'PY' || fail "Python 3.9+ is required."
import sys
if sys.version_info < (3, 9):
    raise SystemExit(1)
print("Python", sys.version.split()[0])
PY

say "Installing Python dependencies (Starlette ASGI stack)…"
python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
python -m pip install --quiet -r requirements.txt

say "Creating directories…"
mkdir -p database/backups logs workspace/uploads frontend/css frontend/js frontend/assets

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from template."
else
  say "Keeping existing .env."
fi
chmod 600 .env 2>/dev/null || true

say "Ensuring access token…"
python - <<'PY'
from config import ensure_access_token, settings
ensure_access_token()
print("Access protection: enabled" if settings.access_token else "Access protection: explicitly disabled by environment")
PY

say "Initialising SQLite…"
python - <<'PY'
import asyncio
from backend.memory.store import store
asyncio.run(store.init())
print("Database ready:", store.db_path)
PY

say "Running self-check…"
python - <<'PY'
import backend.app  # noqa: F401
from backend.intelligence.engine import engine
engine.initialize()
from config import settings
print("Routes loaded. Provider default:", settings.default_provider)
print("Access token:", "enabled" if settings.access_token else "disabled (local use only)")
PY

say "Installed. Start JARVIS with:"
printf '\n  cd %s\n  bash scripts/start.sh\n\n' "$ROOT"
say "Then open http://127.0.0.1:8000 in your phone browser."
