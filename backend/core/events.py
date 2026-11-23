"""Tiny asynchronous event bus used to stream real application events to the HUD."""

from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
from typing import Any

MAX_QUEUE = 64


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class EventBus:
    """Fan-out bus with slow-consumer protection.

    Every websocket client owns one queue.  Publishing never blocks: when a
    client queue is full the oldest event is dropped, because HUD state is
    ephemeral and the latest state matters most.
    """

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._history: deque[dict] = deque(maxlen=20)
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUE)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    def publish(self, event_type: str, data: dict | None = None) -> dict:
        event = {"type": event_type, "ts": now_iso(), "data": data or {}}
        self._history.append(event)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
        return event

    def history(self) -> list[dict]:
        return list(self._history)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


bus = EventBus()
