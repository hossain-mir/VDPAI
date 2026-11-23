"""Append-only audit log with rotation (JSON lines, owner-only permissions)."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

from config import settings
from backend.core.events import now_iso


class AuditLog:
    def __init__(self, directory: Path, *, max_bytes: int = 2 * 1024 * 1024, keep: int = 3) -> None:
        self.directory = directory
        self.path = directory / "audit.jsonl"
        self.max_bytes = max_bytes
        self.keep = keep
        self._lock = threading.Lock()

    def record(self, action: str, *, ip: str = "", ok: bool = True, detail: dict | None = None, tool: str = "") -> None:
        entry = {
            "ts": now_iso(),
            "action": action[:80],
            "tool": tool[:80],
            "ip": ip[:64],
            "ok": bool(ok),
            "detail": detail or {},
        }
        try:
            with self._lock:
                self.directory.mkdir(parents=True, exist_ok=True)
                self._rotate()
                with open(self.path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
                try:
                    os.chmod(self.path, 0o600)
                except OSError:
                    pass
        except OSError:
            # Audit writing must never break a user request; stderr is enough.
            print("[jarvis] warning: could not write audit log")

    def _rotate(self) -> None:
        try:
            if not self.path.exists() or self.path.stat().st_size < self.max_bytes:
                return
        except OSError:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        archived = self.directory / f"audit-{stamp}.jsonl"
        try:
            self.path.replace(archived)
        except OSError:
            return
        archives = sorted(self.directory.glob("audit-*.jsonl"))
        for old in archives[: max(0, len(archives) - self.keep)]:
            try:
                old.unlink()
            except OSError:
                pass

    def tail(self, limit: int = 50) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()[-limit:]
        except OSError:
            return []
        entries = []
        for line in lines:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
        return entries


audit = AuditLog(settings.log_dir)
