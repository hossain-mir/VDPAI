"""HTTP security middleware: auth, CSRF, rate limiting, headers, origin checks."""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from config import settings
from backend.core.errors import (  # noqa: F401  (re-exported convenience)
    AuthError,
    ForbiddenError,
    JarvisError,
    RateLimitError,
    ValidationError,
)
from backend.security.auth import (
    SESSION_COOKIE,
    UNLOCK_COOKIE,
    access_token_ok,
    client_ip,
    local_console,
    parse_bearer,
    rate_limiter,
    sessions,
    unlocks,
)
from backend.security.audit import audit

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
# /api/session is public so the HUD can obtain a CSRF token and learn that
# authentication is required without triggering a 401 on every boot.
PUBLIC_API = {"/api/health", "/api/session", "/api/unlock"}
# Unlock now requires the CSRF token from /api/session (no login CSRF bypass).
NO_CSRF = {"/api/health"}

CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "font-src 'self' data:; "
    "connect-src 'self' ws: wss:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


def _normal_origin(value: str) -> str:
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}"


def _is_allowed_origin(origin: str, request: Request) -> bool:
    origin = _normal_origin(origin)
    if not origin:
        return False
    current = _normal_origin(str(request.base_url))
    if origin == current:
        return True
    configured = {_normal_origin(item) for item in settings.allowed_origins}
    if origin in configured:
        return True
    host = urlsplit(origin).hostname or ""
    return host in {"127.0.0.1", "localhost", "::1"}


def _error_response(status: int, code: str, message: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(
        {"ok": False, "error": {"code": code, "message": message}},
        status_code=status,
        headers=headers or {},
    )


class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        ip = client_ip(request)
        headers = {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Permissions-Policy": "microphone=(self), camera=(self), geolocation=()",
            "Content-Security-Policy": CSP,
            "Cross-Origin-Opener-Policy": "same-origin",
        }

        if not path.startswith("/api"):
            response = await call_next(request)
            response.headers.update(headers)
            response.headers.setdefault("Cache-Control", "no-cache")
            return response

        # ------------------------------------------------------------ rate limit
        allowed, retry_after, remaining = rate_limiter.hit(ip, "api", settings.rate_limit_per_minute)
        if not allowed:
            audit.record("security.rate_limited", ip=ip, ok=False, detail={"path": path})
            response = _error_response(429, "rate_limited", "Too many requests. Slow down.", {"Retry-After": str(retry_after)})
            response.headers.update(headers)
            response.headers["X-RateLimit-Remaining"] = "0"
            return response

        # ---------------------------------------------------------- access token
        if settings.access_token and path not in PUBLIC_API and not local_console(ip):
            api_token = parse_bearer(request.headers.get("authorization")) or request.headers.get("x-jarvis-token")
            if api_token:
                authenticated = access_token_ok(api_token)
            else:
                grant = request.cookies.get(UNLOCK_COOKIE)
                sid = request.cookies.get(SESSION_COOKIE)
                authenticated = bool(
                    grant
                    and sid
                    and unlocks.valid(grant, fingerprint=settings.token_fingerprint, sid=sid)
                )
            if not authenticated:
                response = _error_response(
                    401,
                    "auth_required",
                    "This network is not trusted. Use the local/LAN URL or contact the owner.",
                )
                response.headers.update(headers)
                return response

        # ------------------------------------------------------ origin / CSRF
        if request.method in MUTATING:
            origin = request.headers.get("origin")
            if origin and not _is_allowed_origin(origin, request):
                audit.record("security.bad_origin", ip=ip, ok=False, detail={"origin": origin[:120], "path": path})
                response = _error_response(403, "forbidden_origin", "Cross-origin request blocked.")
                response.headers.update(headers)
                return response

            if path not in NO_CSRF:
                sid = request.cookies.get(SESSION_COOKIE)
                csrf = request.headers.get("x-jarvis-csrf")
                if not sessions.verify_csrf(sid, csrf):
                    response = _error_response(
                        401,
                        "csrf_failed",
                        "Missing or expired session. Reload the page and retry.",
                    )
                    response.headers.update(headers)
                    return response

        response = await call_next(request)
        response.headers.update(headers)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response
