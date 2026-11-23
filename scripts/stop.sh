#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — stop a background server started with `start.sh --bg`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PIDFILE="logs/jarvis.pid"
PORT="${JARVIS_PORT:-8000}"

if [ ! -f "$PIDFILE" ]; then
  echo "[jarvis] no pid file at $PIDFILE"
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "[jarvis] a server is still responding on port $PORT. If you started it in the foreground, press Ctrl+C there."
    pgrep -af "main.py" || true
  fi
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[jarvis] process $PID is not running; removing stale pid file."
  rm -f "$PIDFILE"
  exit 0
fi

kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "[jarvis] stopped."
    exit 0
  fi
  sleep 0.25
done

echo "[jarvis] process did not stop; sending SIGKILL."
kill -KILL "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
echo "[jarvis] stopped."
