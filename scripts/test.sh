#!/data/data/com.termux/files/usr/bin/bash
# JARVIS AI — run the API test suite in an isolated temporary environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec python tests/run_tests.py "$@"
