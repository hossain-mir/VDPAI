"""Structured error handling shared by every JARVIS module."""

from __future__ import annotations

from typing import Any


class JarvisError(Exception):
    """Base error carrying an HTTP status, machine code and safe details."""

    status = 400
    code = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        details: Any = None,
        public: bool = True,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status:
            self.status = status
        self.details = details
        self.public = public

    def payload(self) -> dict:
        body: dict[str, Any] = {
            "ok": False,
            "error": {
                "code": self.code,
                "message": self.message if self.public else "An internal error occurred.",
            },
        }
        if self.details is not None and self.public:
            body["error"]["details"] = self.details
        return body


class ValidationError(JarvisError):
    status = 422
    code = "validation_error"


class NotFoundError(JarvisError):
    status = 404
    code = "not_found"


class AuthError(JarvisError):
    status = 401
    code = "unauthorized"


class ForbiddenError(JarvisError):
    status = 403
    code = "forbidden"


class RateLimitError(JarvisError):
    status = 429
    code = "rate_limited"


class ProviderError(JarvisError):
    status = 502
    code = "provider_error"


class ToolError(JarvisError):
    status = 400
    code = "tool_error"


class ApprovalRequired(JarvisError):
    status = 202
    code = "approval_required"

    def __init__(self, message: str, *, action: dict) -> None:
        super().__init__(message, details={"action": action})
        self.action = action


class UnsupportedError(JarvisError):
    status = 501
    code = "not_supported"
