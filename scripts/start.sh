#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — start the server.
#   bash scripts/start.sh              foreground (Ctrl+C stops)
#   bash scripts/start.sh --bg         background + logs/jarvis.pid
#   bash scripts/start.sh --open       also open the Android browser
#   bash scripts/start.sh --port 8080
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${JARVIS_PORT:-8000}"
HOST="${JARVIS_HOST:-0.0.0.0}"
BACKGROUND=0
OPEN=""
EXTRA=()

for argument in "$@"; do
  case "$argument" in
    --bg) BACKGROUND=1 ;;
    --open) OPEN="--open" ;;
    *) EXTRA+=("$argument") ;;
  esac
done

health() { curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
urls() {
  python - <<'PY'
from config import settings
for url in settings.lan_urls():
    print("   ", url)
PY
}

if health; then
  echo "[jarvis] already running on port $PORT:"
  urls
  exit 0
fi

if ! python -c "import starlette, uvicorn, httpx, websockets" >/dev/null 2>&1; then
  echo "[jarvis] dependencies missing — running installer"
  bash scripts/install.sh
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env 2>/dev/null || true
  echo "[jarvis] created .env (DEMO MODE until you add a provider key)"
fi

if [ "$BACKGROUND" -eq 1 ]; then
  mkdir -p logs
  nohup python main.py --host "$HOST" --port "$PORT" "${EXTRA[@]}" $OPEN > logs/server.out 2>&1 &
  echo $! > logs/jarvis.pid
  for _ in $(seq 1 30); do
    sleep 0.5
    if health; then
      echo "[jarvis] started in background (pid $(cat logs/jarvis.pid))"
      echo "[jarvis] open:"
      urls
      echo "[jarvis] logs: $ROOT/logs/server.out"
      exit 0
    fi
  done
  echo "[jarvis] failed to start; last log lines:" >&2
  tail -n 30 logs/server.out >&2 || true
  rm -f logs/jarvis.pid
  exit 1
fi

exec python main.py --host "$HOST" --port "$PORT" "${EXTRA[@]}" $OPEN
