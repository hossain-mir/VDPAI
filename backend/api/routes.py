"""REST API for JARVIS AI (Starlette)."""

from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
from functools import wraps

from starlette.requests import Request
from starlette.responses import JSONResponse

from config import settings
from backend.automation import browser as browser_engine
from backend.core.errors import AuthError, JarvisError, NotFoundError, RateLimitError, ValidationError
from backend.core.events import now_iso
from backend.core.state import state
from backend.intelligence import providers as provider_layer
from backend.intelligence.engine import engine
from backend.memory.store import store
from backend.security.audit import audit
from backend.security.auth import (
    SESSION_COOKIE,
    UNLOCK_COOKIE,
    access_token_ok,
    client_ip,
    local_console,
    login_guard,
    rate_limiter,
    sessions,
    unlocks,
)
from backend.security.sanitize import clean_line, clean_text, json_safe
from backend.tools.registry import ToolContext, registry
from backend.vision import engine as vision_engine
from backend.voice import engine as voice_engine


# --------------------------------------------------------------------- helpers
def ok(data: dict, status: int = 200) -> JSONResponse:
    payload = {"ok": True, **data}
    return JSONResponse(payload, status_code=status)


def fail(status: int, code: str, message: str, details=None) -> JSONResponse:
    body = {"ok": False, "error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(body, status_code=status)


def api(handler):
    """Wrap a route handler with structured error handling."""

    @wraps(handler)
    async def wrapper(request: Request):
        try:
            return await handler(request)
        except JarvisError as exc:
            return JSONResponse(exc.payload(), status_code=exc.status)
        except Exception as exc:  # defensive catch-all
            traceback.print_exc()
            code = f"unexpected_{type(exc).__name__}"
            audit.record("api.crash", ip=client_ip(request), ok=False, detail={"path": request.url.path, "error": type(exc).__name__})
            return fail(500, code, "Internal server error. Check the server console for details.")

    return wrapper


async def json_body(request: Request, *, limit: int | None = None) -> dict:
    limit = limit or settings.max_body_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise JarvisError("Request body is too large.", code="payload_too_large", status=413)
    body = await request.body()
    if len(body) > limit:
        raise JarvisError("Request body is too large.", code="payload_too_large", status=413)
    if not body:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        raise ValidationError("Request body must be valid JSON.") from None
    if not isinstance(data, dict):
        raise ValidationError("Request body must be a JSON object.")
    return data


def current_session(request: Request):
    session = sessions.get(request.cookies.get(SESSION_COOKIE))
    if not session:
        raise AuthError("Session expired. Reload the page and try again.")
    return session


def tool_context(request: Request) -> ToolContext:
    session = current_session(request)
    return ToolContext(session_id=session.sid, ip=client_ip(request), source="api")


def secure_cookie(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    if settings.trust_proxy and request.headers.get("x-forwarded-proto", "").lower() == "https":
        return True
    return False


def cookie_samesite(request: Request) -> str:
    """HTTPS sessions must work from the bundled APK's local WebView origin.

    A packaged WebView is cross-origin to the backend, so its cookies need
    SameSite=None (always paired with Secure). Plain HTTP/loopback keeps the
    original lax policy.
    """
    return "none" if secure_cookie(request) else "lax"


def throttle(request: Request, bucket: str, limit: int) -> None:
    allowed, retry_after, _remaining = rate_limiter.hit(client_ip(request), bucket, limit)
    if not allowed:
        raise RateLimitError(f"Too many {bucket} requests. Try again in {retry_after}s.")


# ------------------------------------------------------------------- endpoints
async def health(request: Request):
    return ok(
        {
            "status": "healthy",
            "version": settings.version,
            "app": settings.app_name,
            "uptime_seconds": state.snapshot()["uptime_seconds"],
            "time": now_iso(),
        }
    )


async def session_endpoint(request: Request):
    """Public handshake: session id + CSRF + whether login is required."""
    sid = request.cookies.get(SESSION_COOKIE)
    session = sessions.get(sid)
    created = False
    if not session:
        session = sessions.create()
        created = True
    grant = request.cookies.get(UNLOCK_COOKIE)
    unlocked = (
        (not settings.access_token)
        or local_console(client_ip(request))
        or bool(grant and unlocks.valid(grant, fingerprint=settings.token_fingerprint, sid=session.sid))
    )
    response = ok(
        {
            "session_id": session.sid,
            "csrf": session.csrf,
            "created": created,
            "auth_required": bool(settings.access_token),
            "unlocked": unlocked,
            "expires_in": settings.session_ttl_hours * 3600,
        }
    )
    response.set_cookie(
        SESSION_COOKIE,
        session.sid,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite=cookie_samesite(request),
        secure=secure_cookie(request),
        path="/",
    )
    return response


async def unlock(request: Request):
    """Exchange the owner's token for an opaque, expiring browser grant."""
    throttle(request, "unlock", 8)
    ip = client_ip(request)
    allowed, retry_after = login_guard.check(ip)
    if not allowed:
        raise RateLimitError(f"Too many failed unlock attempts. Try again in {retry_after}s.")

    body = await json_body(request, limit=4096)
    token = body.get("token")
    valid = isinstance(token, str) and access_token_ok(token.strip())
    if not valid:
        remaining = login_guard.failed(ip)
        audit.record("security.unlock_failed", ip=ip, ok=False)
        if remaining == 0:
            raise RateLimitError("Too many failed unlock attempts. Try again in a few minutes.")
        raise AuthError("Invalid access token.")

    login_guard.clear(ip)
    old_sid = request.cookies.get(SESSION_COOKIE)
    session = sessions.rotate(old_sid)
    grant = unlocks.create(settings.token_fingerprint, session.sid, ip)

    response = ok(
        {
            "unlocked": True,
            "auth_required": True,
            "session_id": session.sid,
            "csrf": session.csrf,
            "expires_in": settings.session_ttl_hours * 3600,
        }
    )
    max_age = settings.session_ttl_hours * 3600
    response.set_cookie(
        SESSION_COOKIE,
        session.sid,
        max_age=max_age,
        httponly=True,
        samesite=cookie_samesite(request),
        secure=secure_cookie(request),
        path="/",
    )
    # Only a random grant id is stored in the browser.  The access token
    # itself is never written to a cookie, JS, HTML, or a log line.
    response.set_cookie(
        UNLOCK_COOKIE,
        grant.grant_id,
        max_age=max_age,
        httponly=True,
        samesite=cookie_samesite(request),
        secure=secure_cookie(request),
        path="/",
    )
    audit.record("security.unlock", ip=ip, ok=True)
    return response


async def logout(request: Request):
    """Revoke the browser grant and rotate away the current session."""
    session = current_session(request)
    unlocks.revoke(request.cookies.get(UNLOCK_COOKIE))
    sessions.revoke(session.sid)
    response = ok({"logged_out": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(UNLOCK_COOKIE, path="/")
    audit.record("security.logout", ip=client_ip(request), ok=True)
    return response


async def status(request: Request):
    current_session(request)
    probe = request.query_params.get("probe") == "1"
    provider_status = await engine.public_status()
    memory = await store.stats()
    vision = await vision_engine.vision_status()
    payload = {
        "runtime": state.snapshot(),
        "provider": provider_status,
        "memory": memory,
        "security": {
            "access_token": bool(settings.access_token),
            "unlocked": (
                (not settings.access_token)
                or local_console(client_ip(request))
                or bool(
                    request.cookies.get(UNLOCK_COOKIE)
                    and unlocks.valid(
                        request.cookies.get(UNLOCK_COOKIE),
                        fingerprint=settings.token_fingerprint,
                        sid=request.cookies.get(SESSION_COOKIE),
                    )
                )
            ),
            "rate_limit_per_minute": settings.rate_limit_per_minute,
            "chat_rate_limit_per_minute": settings.chat_rate_limit_per_minute,
            "session_ttl_hours": settings.session_ttl_hours,
            "csrf": True,
            "cors_origins": settings.allowed_origins,
            "sessions": sessions.count(),
        },
        "browser": {
            "playwright": browser_engine.playwright_status(),
            "engine": "httpx + html.parser",
            "ssrf_private_allowed": settings.allow_private_urls,
        },
        "vision": vision,
        "voice": voice_engine.capabilities(),
        "warnings": settings.warnings,
        "urls": settings.lan_urls(),
        "time": now_iso(),
    }
    if probe:
        payload["network"] = await browser_engine.probe_network()
    return ok(payload)


async def config_endpoint(request: Request):
    public = settings.public()
    return ok(
        {
            "config": public,
            "tools": len(registry.names()),
            "voice": voice_engine.capabilities(),
            "playwright": browser_engine.playwright_status(),
        }
    )


# ------------------------------------------------------------------------ chat
async def chat(request: Request):
    session = current_session(request)
    throttle(request, "chat", settings.chat_rate_limit_per_minute)
    body = await json_body(request)
    message = body.get("message", body.get("text"))
    text = clean_text(message, field="message", max_len=settings.max_message_chars)
    language = voice_engine.normalise_language(body.get("language"))
    images = body.get("images") or []
    if images and not isinstance(images, list):
        raise ValidationError("images must be an array of data URLs.")
    if len(images) > 3:
        raise ValidationError("At most 3 images per message.")
    for image in images:
        if not isinstance(image, str) or not image.startswith("data:image/"):
            raise ValidationError("Each image must be a base64 image data URL.")
        if len(image) > settings.max_image_mb * 1024 * 1024 * 1.4:
            raise ValidationError(f"Each image must stay under {settings.max_image_mb} MB.")

    result = await engine.respond(
        session_id=session.sid,
        message=text,
        language=language,
        images=images or None,
        source="text",
        ip=client_ip(request),
    )
    return ok(json_safe(result))


async def voice(request: Request):
    session = current_session(request)
    throttle(request, "voice", settings.chat_rate_limit_per_minute)
    body = await json_body(request)
    transcript = body.get("transcript", body.get("text"))
    prepared = voice_engine.prepare_command(transcript, body.get("language"))
    result = await engine.respond(
        session_id=session.sid,
        message=prepared["command"],
        language=prepared["language"],
        source="voice",
        ip=client_ip(request),
    )
    payload = json_safe(result)
    payload["wake_detected"] = prepared["wake"]
    payload["command"] = prepared["command"]
    return ok(payload)


# ----------------------------------------------------------------------- tools
async def tools_list(request: Request):
    current_session(request)
    return ok({"tools": registry.public_specs(), "pending": registry.pending_actions()})


async def tools_execute(request: Request):
    context = tool_context(request)
    throttle(request, "tools", settings.chat_rate_limit_per_minute * 2)
    body = await json_body(request)
    name = clean_line(body.get("tool", body.get("name")), field="tool", max_len=80)
    arguments = body.get("args", body.get("arguments", {}))
    if not isinstance(arguments, dict):
        raise ValidationError("args must be a JSON object.")
    result = await registry.execute(name, arguments, context)
    return ok(json_safe(result))


async def tools_pending(request: Request):
    session = current_session(request)
    return ok({"pending": registry.pending_actions(session.sid)})


async def tools_approve(request: Request):
    context = tool_context(request)
    throttle(request, "approve", 30)
    token = clean_line(request.path_params.get("token"), field="token", max_len=100)
    result = await registry.approve(token, context)
    return ok(json_safe(result))


async def tools_reject(request: Request):
    context = tool_context(request)
    token = clean_line(request.path_params.get("token"), field="token", max_len=100)
    registry.reject(token, context)
    return ok({"rejected": True})


# ------------------------------------------------------------------- providers
async def providers_list(request: Request):
    current_session(request)
    provider, model = await provider_layer.resolve_active(store)
    return ok(
        {
            "providers": provider_layer.public_provider_list(provider.id, model),
            "active": {
                "provider": provider.id,
                "label": provider.label_for_ui,
                "model": model or provider.default_model,
                "demo": provider.id == "demo",
            },
            "fallback": settings.fallback_provider or None,
            "warnings": settings.warnings,
        }
    )


async def providers_test(request: Request):
    current_session(request)
    throttle(request, "provider_test", 12)
    body = await json_body(request)
    provider_id = clean_line(body.get("provider"), field="provider", max_len=40)
    model = clean_line(body.get("model", ""), field="model", max_len=120, allow_empty=True)
    result = await provider_layer.test_provider(provider_id, model or None)
    audit.record("provider.test", ip=client_ip(request), detail={"provider": provider_id, "ok": result.get("ok")})
    return ok({"test": result})


async def providers_select(request: Request):
    current_session(request)
    body = await json_body(request)
    provider_id = clean_line(body.get("provider"), field="provider", max_len=40)
    model = clean_line(body.get("model", ""), field="model", max_len=120, allow_empty=True)
    selection = await provider_layer.set_active(store, provider_id, model)
    provider, active_model = await provider_layer.resolve_active(store)
    state.active_provider = provider.id
    state.active_model = active_model or provider.default_model
    state.set_state("IDLE", "provider switched")
    audit.record("provider.select", ip=client_ip(request), detail=selection)
    return ok({"selection": selection})


async def providers_config(request: Request):
    current_session(request)
    throttle(request, "provider_config", 12)
    body = await json_body(request, limit=8192)
    provider_id = clean_line(body.get("provider"), field="provider", max_len=40)
    api_key = body.get("api_key")
    base_url = body.get("base_url")
    model = body.get("model")
    result = provider_layer.save_provider_config(provider_id, api_key=api_key, base_url=base_url, model=model)
    audit.record("provider.config", ip=client_ip(request), detail={"provider": provider_id, "key_set": result["key_set"]})
    return ok({"saved": result})


# ---------------------------------------------------------------------- memory
async def memory_overview(request: Request):
    session = current_session(request)
    query = clean_line(request.query_params.get("q", ""), field="q", max_len=200, allow_empty=True)
    limit = min(int(request.query_params.get("limit", 25) or 25), 100)
    if query:
        messages = await store.search_messages(query, limit, session.sid)
    else:
        messages = await store.recent_messages(session.sid, limit)
    notes = await store.list_notes(query, 50)
    stats = await store.stats()
    return ok({"messages": messages, "notes": notes, "stats": stats, "query": query})


async def memory_create(request: Request):
    session = current_session(request)
    body = await json_body(request)
    kind = body.get("type", "note")
    if kind == "note":
        title = clean_line(body.get("title"), field="title", max_len=120)
        content = clean_text(body.get("content", ""), field="content", max_len=4000, allow_empty=True)
        tags = clean_line(body.get("tags", ""), field="tags", max_len=120, allow_empty=True)
        note = await store.add_note(title, content, tags)
        return ok({"note": note}, status=201)
    if kind == "pref":
        key = clean_line(body.get("key"), field="key", max_len=80)
        value = clean_text(body.get("value", ""), field="value", max_len=2000, allow_empty=True)
        await store.set_pref(f"user.{key}", value)
        return ok({"stored": f"user.{key}"}, status=201)
    raise ValidationError("type must be 'note' or 'pref'.")


async def notes_list(request: Request):
    current_session(request)
    query = clean_line(request.query_params.get("q", ""), field="q", max_len=200, allow_empty=True)
    limit = min(int(request.query_params.get("limit", 50) or 50), 200)
    notes = await store.list_notes(query, limit)
    return ok({"notes": notes, "query": query})


async def notes_create(request: Request):
    current_session(request)
    body = await json_body(request)
    note = await store.add_note(
        clean_line(body.get("title"), field="title", max_len=120),
        clean_text(body.get("content", ""), field="content", max_len=4000, allow_empty=True),
        clean_line(body.get("tags", ""), field="tags", max_len=120, allow_empty=True),
    )
    return ok({"note": note}, status=201)


async def notes_update(request: Request):
    current_session(request)
    note_id = int(request.path_params["note_id"])
    body = await json_body(request)
    fields = {}
    if "title" in body:
        fields["title"] = clean_line(body["title"], field="title", max_len=120)
    if "content" in body:
        fields["content"] = clean_text(body["content"], field="content", max_len=4000, allow_empty=True)
    if "tags" in body:
        fields["tags"] = clean_line(body["tags"], field="tags", max_len=120, allow_empty=True)
    if not fields:
        raise ValidationError("Provide title, content or tags to update.")
    note = await store.update_note(note_id, **fields)
    return ok({"note": note})


async def notes_delete(request: Request):
    current_session(request)
    note_id = int(request.path_params["note_id"])
    await store.delete_note(note_id)
    audit.record("memory.note_deleted", ip=client_ip(request), detail={"id": note_id})
    return ok({"deleted": note_id})


async def messages_list(request: Request):
    session = current_session(request)
    query = clean_line(request.query_params.get("q", ""), field="q", max_len=200, allow_empty=True)
    limit = min(int(request.query_params.get("limit", 30) or 30), 100)
    rows = (
        await store.search_messages(query, limit, session.sid)
        if query
        else await store.recent_messages(session.sid, limit)
    )
    return ok({"messages": rows, "query": query})


async def messages_clear(request: Request):
    session = current_session(request)
    if request.query_params.get("confirm") != "yes":
        raise ValidationError("Add ?confirm=yes to clear the conversation history.")
    scope = request.query_params.get("scope", "session")
    removed = await store.clear_messages(None if scope == "all" else session.sid)
    audit.record("memory.messages_cleared", ip=client_ip(request), detail={"scope": scope, "removed": removed})
    return ok({"removed": removed, "scope": scope})


async def memory_backup(request: Request):
    current_session(request)
    path = await store.backup()
    audit.record("memory.backup", ip=client_ip(request), detail={"file": path.split("/")[-1]})
    return ok({"backup": path, "bytes": os.path.getsize(path)})


async def memory_export(request: Request):
    session = current_session(request)
    limit = min(int(request.query_params.get("limit", 500) or 500), 2000)
    messages = await store.recent_messages(session.sid, limit)
    notes = await store.list_notes("", 500)
    return JSONResponse(
        {
            "ok": True,
            "exported_at": now_iso(),
            "version": settings.version,
            "messages": messages,
            "notes": notes,
        },
        headers={"Content-Disposition": 'attachment; filename="jarvis-memory-export.json"'},
    )


# ---------------------------------------------------------------------- vision
async def vision_status(request: Request):
    current_session(request)
    return ok(await vision_engine.vision_status())


async def vision_analyze(request: Request):
    session = current_session(request)
    throttle(request, "vision", 12)
    body = await json_body(request, limit=settings.max_body_bytes)
    result = await vision_engine.analyze_image(
        image=body.get("image"),
        prompt=body.get("prompt", ""),
        language=voice_engine.normalise_language(body.get("language")),
        session_id=session.sid,
        ip=client_ip(request),
    )
    return ok(json_safe(result))


# ------------------------------------------------------------------ automation
async def automation_status(request: Request):
    current_session(request)
    return ok(
        {
            "playwright": browser_engine.playwright_status(),
            "http_engine": "httpx",
            "supports": ["fetch page text", "extract links", "web search", "optional screenshots with Playwright"],
        }
    )


async def automation_fetch(request: Request):
    current_session(request)
    throttle(request, "fetch", 30)
    body = await json_body(request)
    url = clean_line(body.get("url"), field="url", max_len=2048)
    max_chars = int(body.get("max_chars", 6000))
    max_chars = max(500, min(max_chars, 12000))
    page = await browser_engine.fetch_page(url, max_chars=max_chars)
    return ok(json_safe(page))


async def automation_search(request: Request):
    current_session(request)
    throttle(request, "search", 20)
    body = await json_body(request)
    query = clean_line(body.get("query"), field="query", max_len=300)
    max_results = max(1, min(int(body.get("max_results", 5)), 8))
    return ok(json_safe(await browser_engine.web_search(query, max_results=max_results)))


async def automation_screenshot(request: Request):
    current_session(request)
    throttle(request, "screenshot", 8)
    body = await json_body(request)
    url = clean_line(body.get("url"), field="url", max_len=2048)
    result = await browser_engine.screenshot(url, full_page=bool(body.get("full_page")))
    audit.record("automation.screenshot", ip=client_ip(request), ok=True, detail={"file": result["file"]})
    return ok(json_safe(result))


async def automation_actions(request: Request):
    current_session(request)
    throttle(request, "actions", 8)
    body = await json_body(request)
    url = clean_line(body.get("url"), field="url", max_len=2048)
    actions = body.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ValidationError("actions must be a non-empty array.")
    result = await browser_engine.browser_actions(url, actions)
    return ok(json_safe(result))


# --------------------------------------------------------------------- audit
async def audit_tail(request: Request):
    current_session(request)
    limit = max(1, min(int(request.query_params.get("limit", 40) or 40), 200))
    return ok({"entries": audit.tail(limit)})


async def network_probe(request: Request):
    current_session(request)
    return ok({"network": await browser_engine.probe_network(), "urls": settings.lan_urls()})


ROUTES = []
