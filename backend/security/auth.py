"""Sessions, CSRF protection, access tokens and rate limiting."""

from __future__ import annotations

import hmac
import secrets
import threading
import time
from dataclasses import dataclass, field

from config import settings

SESSION_COOKIE = "jarvis_session"
# The browser never receives the access token itself.  This cookie carries a
# random, server-issued unlock grant that maps to an authenticated session.
UNLOCK_COOKIE = "jarvis_unlock"
CSRF_HEADER = "x-jarvis-csrf"


@dataclass
class Session:
    sid: str
    csrf: str
    created_at: float
    last_seen: float
    seen_count: int = 0

    @property
    def expires_at(self) -> float:
        return self.last_seen + settings.session_ttl_hours * 3600


class SessionManager:
    def __init__(self, ttl_hours: int) -> None:
        self.ttl = ttl_hours * 3600
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self) -> Session:
        now = time.time()
        session = Session(sid=secrets.token_urlsafe(24), csrf=secrets.token_urlsafe(24), created_at=now, last_seen=now)
        with self._lock:
            self._prune(now)
            if len(self._sessions) > 2000:
                self._sessions.clear()
            self._sessions[session.sid] = session
        return session

    def get(self, sid: str | None) -> Session | None:
        if not sid:
            return None
        now = time.time()
        with self._lock:
            session = self._sessions.get(sid)
            if not session:
                return None
            if now > session.expires_at:
                self._sessions.pop(sid, None)
                return None
            session.last_seen = now
            session.seen_count += 1
            return session

    def rotate(self, sid: str | None) -> Session:
        """Issue a fresh session id + CSRF after a privilege change."""
        if sid:
            with self._lock:
                self._sessions.pop(sid, None)
        return self.create()

    def verify_csrf(self, sid: str | None, token: str | None) -> bool:
        session = self.get(sid)
        if not session or not token:
            return False
        return hmac.compare_digest(session.csrf, token)

    def revoke(self, sid: str | None) -> None:
        if not sid:
            return
        with self._lock:
            self._sessions.pop(sid, None)

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def _prune(self, now: float) -> None:
        stale = [sid for sid, session in self._sessions.items() if now > session.last_seen + self.ttl]
        for sid in stale:
            self._sessions.pop(sid, None)


@dataclass
class UnlockGrant:
    grant_id: str
    fingerprint: str
    sid: str
    ip: str
    created_at: float
    expires_at: float


class UnlockManager:
    """Opaque, expiring login grants — the access token is never a cookie."""

    def __init__(self) -> None:
        self._grants: dict[str, UnlockGrant] = {}
        self._lock = threading.Lock()

    def create(self, fingerprint: str, sid: str, ip: str) -> UnlockGrant:
        now = time.time()
        grant = UnlockGrant(
            grant_id=secrets.token_urlsafe(32),
            fingerprint=fingerprint,
            sid=sid,
            ip=ip[:64],
            created_at=now,
            expires_at=now + settings.session_ttl_hours * 3600,
        )
        with self._lock:
            self._prune(now)
            self._grants[grant.grant_id] = grant
        return grant

    def valid(self, grant_id: str | None, *, fingerprint: str | None = None, sid: str | None = None) -> bool:
        if not grant_id:
            return False
        now = time.time()
        with self._lock:
            grant = self._grants.get(grant_id)
            if not grant:
                return False
            if now > grant.expires_at:
                self._grants.pop(grant_id, None)
                return False
            if fingerprint is not None and not hmac.compare_digest(grant.fingerprint, fingerprint):
                return False
            if sid is not None and not hmac.compare_digest(grant.sid, sid):
                return False
            return True

    def revoke(self, grant_id: str | None) -> None:
        if not grant_id:
            return
        with self._lock:
            self._grants.pop(grant_id, None)

    def revoke_all(self) -> None:
        with self._lock:
            self._grants.clear()

    def _prune(self, now: float) -> None:
        stale = [key for key, grant in self._grants.items() if now > grant.expires_at]
        for key in stale:
            self._grants.pop(key, None)


@dataclass
class _LoginAttempts:
    failures: int = 0
    locked_until: float = 0.0


class LoginGuard:
    """Brief lockout after repeated wrong tokens (per client IP)."""

    def __init__(self, max_failures: int = 5, window: float = 300.0) -> None:
        self.max_failures = max_failures
        self.window = window
        self._attempts: dict[str, _LoginAttempts] = {}
        self._lock = threading.Lock()

    def check(self, ip: str) -> tuple[bool, int]:
        now = time.time()
        with self._lock:
            entry = self._attempts.get(ip)
            if not entry:
                return True, 0
            if entry.locked_until <= now:
                if entry.locked_until:
                    self._attempts.pop(ip, None)
                return True, 0
            return False, max(1, int(entry.locked_until - now))

    def failed(self, ip: str) -> int:
        now = time.time()
        with self._lock:
            entry = self._attempts.setdefault(ip, _LoginAttempts())
            if entry.locked_until and entry.locked_until <= now:
                entry = _LoginAttempts()
                self._attempts[ip] = entry
            entry.failures += 1
            if entry.failures >= self.max_failures:
                entry.locked_until = now + self.window
            return max(0, self.max_failures - entry.failures)

    def clear(self, ip: str) -> None:
        with self._lock:
            self._attempts.pop(ip, None)


@dataclass
class _Bucket:
    count: int = 0
    window_start: float = field(default_factory=time.time)


class RateLimiter:
    """Fixed-window limiter, keyed by client IP and bucket name."""

    def __init__(self) -> None:
        self._buckets: dict[tuple[str, str], _Bucket] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, bucket: str, limit: int, window: float = 60.0) -> tuple[bool, int, int]:
        now = time.time()
        bucket_key = (key, bucket)
        with self._lock:
            if len(self._buckets) > 5000:
                self._buckets.clear()
            entry = self._buckets.get(bucket_key)
            if not entry or now - entry.window_start >= window:
                entry = _Bucket(count=0, window_start=now)
                self._buckets[bucket_key] = entry
            entry.count += 1
            retry_after = max(1, int(window - (now - entry.window_start)))
            remaining = max(0, limit - entry.count)
            return entry.count <= limit, retry_after, remaining

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


sessions = SessionManager(settings.session_ttl_hours)
unlocks = UnlockManager()
login_guard = LoginGuard()
rate_limiter = RateLimiter()


def access_token_ok(candidate: str | None) -> bool:
    token = settings.access_token
    if not token:
        return True
    if not candidate:
        return False
    return hmac.compare_digest(token, candidate)


def local_console(ip: str | None) -> bool:
    """Auto-unlock only loopback and explicitly trusted LAN clients.

    Public / untrusted addresses must still present the access token, so an
    unauthenticated server can never be safely exposed through a tunnel.
    """
    return settings.local_auto_unlock and settings.is_trusted_ip(ip)


def unlock_grant_ok(candidate: str | None, *, sid: str | None = None) -> bool:
    """Validate a browser unlock grant without ever handling the real token."""
    if not settings.access_token:
        return True
    return unlocks.valid(candidate, fingerprint=settings.token_fingerprint, sid=sid)


def client_ip(scope_or_request) -> str:
    """Resolve the client IP, honouring X-Forwarded-For only if trusted."""
    headers = scope_or_request.headers
    if settings.trust_proxy:
        forwarded = headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()[:64]
    client = scope_or_request.client
    if client and client[0]:
        return client[0]
    return "unknown"


def parse_bearer(header_value: str | None) -> str | None:
    if not header_value:
        return None
    parts = header_value.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None
