"""ASGI application assembly (Starlette) for JARVIS AI."""

from __future__ import annotations

import logging

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from config import settings
from backend.api import routes
from backend.api.ws import websocket_endpoint
from backend.core.events import bus, now_iso
from backend.core.state import state
from backend.intelligence.engine import engine
from backend.memory.store import store
from backend.security.audit import audit
from backend.security.middleware import SecurityMiddleware

logger = logging.getLogger("jarvis")

LAN_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|\[::1\]"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r")(?::\d+)?$"
)


async def startup() -> None:
    await store.init()
    engine.initialize()
    if settings.memory_retention_days > 0:
        removed = await store.prune(settings.memory_retention_days)
        if removed:
            logger.info("pruned %s old messages", removed)
    audit.record("server.start", detail={"port": settings.port, "version": settings.version})
    state.set_state("IDLE", "system online")
    logger.info("JARVIS core online (v%s)", settings.version)
    for warning in settings.warnings:
        logger.warning(warning)


async def shutdown() -> None:
    audit.record("server.stop", ok=True)
    logger.info("JARVIS shutting down")


async def index(request):
    target = settings.frontend_dir / "index.html"
    if not target.exists():
        return JSONResponse(
            {"ok": False, "error": {"code": "ui_missing", "message": "frontend/index.html is missing."}},
            status_code=500,
        )
    return FileResponse(target, media_type="text/html; charset=utf-8")


async def manifest(request):
    target = settings.frontend_dir / "manifest.webmanifest"
    if not target.exists():
        return Response(status_code=404)
    return FileResponse(target, media_type="application/manifest+json")


async def favicon(request):
    target = settings.frontend_dir / "assets" / "favicon.svg"
    if target.exists():
        return FileResponse(target, media_type="image/svg+xml")
    return Response(status_code=204)


async def api_not_found(request):
    return JSONResponse(
        {"ok": False, "error": {"code": "not_found", "message": f"No route for {request.url.path}."}},
        status_code=404,
    )


async def http_error(request, exc: HTTPException):
    return JSONResponse(
        {"ok": False, "error": {"code": f"http_{exc.status_code}", "message": exc.detail or "Request failed."}},
        status_code=exc.status_code,
    )


def build_routes() -> list:
    api = routes.api
    return [
        Route("/", index),
        Route("/index.html", index),
        Route("/manifest.webmanifest", manifest),
        Route("/favicon.ico", favicon),
        Mount("/css", StaticFiles(directory=settings.frontend_dir / "css")),
        Mount("/js", StaticFiles(directory=settings.frontend_dir / "js")),
        Mount("/assets", StaticFiles(directory=settings.frontend_dir / "assets")),
        Route("/api/health", api(routes.health)),
        Route("/api/session", api(routes.session_endpoint)),
        Route("/api/unlock", api(routes.unlock), methods=["POST"]),
        Route("/api/logout", api(routes.logout), methods=["POST"]),
        Route("/api/status", api(routes.status)),
        Route("/api/config", api(routes.config_endpoint)),
        Route("/api/chat", api(routes.chat), methods=["POST"]),
        Route("/api/voice", api(routes.voice), methods=["POST"]),
        Route("/api/tools", api(routes.tools_list)),
        Route("/api/tools/execute", api(routes.tools_execute), methods=["POST"]),
        Route("/api/tools/pending", api(routes.tools_pending)),
        Route("/api/tools/approve/{token}", api(routes.tools_approve), methods=["POST"]),
        Route("/api/tools/reject/{token}", api(routes.tools_reject), methods=["POST"]),
        Route("/api/providers", api(routes.providers_list)),
        Route("/api/providers/test", api(routes.providers_test), methods=["POST"]),
        Route("/api/providers/select", api(routes.providers_select), methods=["POST"]),
        Route("/api/providers/config", api(routes.providers_config), methods=["POST"]),
        Route("/api/memory", api(routes.memory_overview)),
        Route("/api/memory", api(routes.memory_create), methods=["POST"]),
        Route("/api/memory/notes", api(routes.notes_list)),
        Route("/api/memory/notes", api(routes.notes_create), methods=["POST"]),
        Route("/api/memory/notes/{note_id:int}", api(routes.notes_update), methods=["PATCH"]),
        Route("/api/memory/notes/{note_id:int}", api(routes.notes_delete), methods=["DELETE"]),
        Route("/api/memory/messages", api(routes.messages_list)),
        Route("/api/memory/messages", api(routes.messages_clear), methods=["DELETE"]),
        Route("/api/memory/backup", api(routes.memory_backup), methods=["POST"]),
        Route("/api/memory/export", api(routes.memory_export)),
        Route("/api/vision/status", api(routes.vision_status)),
        Route("/api/vision/analyze", api(routes.vision_analyze), methods=["POST"]),
        Route("/api/automation/status", api(routes.automation_status)),
        Route("/api/automation/fetch", api(routes.automation_fetch), methods=["POST"]),
        Route("/api/automation/search", api(routes.automation_search), methods=["POST"]),
        Route("/api/automation/screenshot", api(routes.automation_screenshot), methods=["POST"]),
        Route("/api/automation/actions", api(routes.automation_actions), methods=["POST"]),
        Route("/api/audit", api(routes.audit_tail)),
        Route("/api/network", api(routes.network_probe)),
        WebSocketRoute("/ws", websocket_endpoint),
        Route("/api/{rest:path}", api(api_not_found), methods=["GET", "POST", "PUT", "PATCH", "DELETE"]),
        Route("/{rest:path}", api(api_not_found), methods=["GET", "POST", "PUT", "PATCH", "DELETE"]),
    ]


core_app = Starlette(
    routes=build_routes(),
    on_startup=[startup],
    on_shutdown=[shutdown],
    exception_handlers={HTTPException: http_error},
)

_secured = SecurityMiddleware(core_app)

app = CORSMiddleware(
    _secured,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=LAN_ORIGIN_REGEX,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Jarvis-CSRF", "Authorization", "X-Jarvis-Token"],
    expose_headers=["X-RateLimit-Remaining"],
    allow_credentials=False,
    max_age=600,
)
