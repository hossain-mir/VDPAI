"""Runtime state for the HUD and status endpoints."""

from __future__ import annotations

import platform
import time
from datetime import datetime, timezone

from backend.core.events import bus

VOICE_STATES = {"IDLE", "LISTENING", "THINKING", "SPEAKING", "EXECUTING", "ERROR"}


class RuntimeState:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.started_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.state = "IDLE"
        self.detail = "awaiting command"
        self.active_provider = "demo"
        self.active_model = "demo"
        self.messages_handled = 0
        self.tool_calls = 0
        self.last_error: str | None = None
        self.last_activity: float | None = None

    def set_state(self, state: str, detail: str = "", *, broadcast: bool = True) -> None:
        state = state.upper()
        if state not in VOICE_STATES:
            state = "IDLE"
        self.state = state
        self.detail = (detail or "")[:160]
        if broadcast:
            bus.publish("state", {"state": self.state, "detail": self.detail})

    def snapshot(self) -> dict:
        return {
            "state": self.state,
            "detail": self.detail,
            "active_provider": self.active_provider,
            "active_model": self.active_model,
            "messages_handled": self.messages_handled,
            "tool_calls": self.tool_calls,
            "started_at": self.started_iso,
            "uptime_seconds": int(time.time() - self.started_at),
            "last_error": self.last_error,
            "platform": f"{platform.system()} {platform.release()}",
            "python": platform.python_version(),
            "machine": platform.machine(),
            "ws_clients": bus.subscriber_count,
        }


state = RuntimeState()
