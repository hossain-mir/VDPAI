"""WebSocket stream of real runtime events for the HUD."""

from __future__ import annotations

import asyncio
import json

from starlette.websockets import WebSocket, WebSocketDisconnect

from config import settings
from backend.core.events import bus
from backend.core.state import state
from backend.security.auth import (
    SESSION_COOKIE,
    UNLOCK_COOKIE,
    access_token_ok,
    local_console,
    parse_bearer,
    unlocks,
)


async def websocket_endpoint(websocket: WebSocket) -> None:
    peer = websocket.client[0] if websocket.client else ""
    if settings.access_token and not local_console(peer):
        # API clients pass the token in a header.  Query strings are avoided
        # because proxies and uvicorn log them verbatim.
        api_token = websocket.headers.get("x-jarvis-token") or parse_bearer(
            websocket.headers.get("authorization")
        )
        grant = websocket.cookies.get(UNLOCK_COOKIE)
        sid = websocket.cookies.get(SESSION_COOKIE)
        browser_ok = bool(
            grant
            and sid
            and unlocks.valid(grant, fingerprint=settings.token_fingerprint, sid=sid)
        )
        if not (access_token_ok(api_token) or browser_ok):
            await websocket.close(code=4401)
            return

    await websocket.accept()
    queue = await bus.subscribe()
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "ts": None,
                "data": {
                    "runtime": state.snapshot(),
                    "history": bus.history()[-8:],
                    "version": settings.version,
                },
            }
        )
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=25)
                await websocket.send_json(event)
            except asyncio.TimeoutError:
                await websocket.send_json(
                    {"type": "heartbeat", "data": {"state": state.state, "uptime_seconds": state.snapshot()["uptime_seconds"]}}
                )
    except (WebSocketDisconnect, RuntimeError, ConnectionError):
        pass
    finally:
        await bus.unsubscribe(queue)
