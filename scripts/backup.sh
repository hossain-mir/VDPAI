#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — create a consistent SQLite backup (safe while the server runs).
#   bash scripts/backup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[36m[jarvis]\033[0m %s\n' "$*"; }

if [ ! -f database/jarvis.db ] && [ -z "${JARVIS_DB_PATH:-}" ]; then
  echo "[jarvis] no database found yet. Start JARVIS once so it can be created." >&2
  exit 1
fi

TARGET="$(python - <<'PY'
import asyncio
from backend.memory.store import store

async def main():
    await store.init()
    print(await store.backup())

asyncio.run(main())
PY
)"

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "[jarvis] backup failed: no file was written." >&2
  exit 1
fi

chmod 600 "$TARGET" 2>/dev/null || true
say "backup written: $TARGET"
say "size: $(wc -c < "$TARGET") bytes"
say "restore with: cp \"$TARGET\" database/jarvis.db  (stop the server first)"
