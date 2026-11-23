"""Input sanitisation and path/URL safety checks."""

from __future__ import annotations

import ipaddress
import re
import socket
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

from config import settings
from backend.core.errors import ValidationError

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WORD = re.compile(r"[^\w\s@.,'\"!?()/:;+\-=%&#\[\]{}<>*]", re.UNICODE)
_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._ -]+")


def clean_text(value: object, *, field: str = "text", max_len: int | None = None, allow_empty: bool = False) -> str:
    """Normalise user text, strip control characters and enforce a length cap."""
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string.")
    text = unicodedata.normalize("NFC", value)
    text = _CONTROL.sub("", text).strip()
    limit = max_len if max_len is not None else settings.max_message_chars
    if len(text) > limit:
        raise ValidationError(f"{field} is longer than {limit} characters.")
    if not text and not allow_empty:
        raise ValidationError(f"{field} must not be empty.")
    return text


def clean_line(value: object, *, field: str = "value", max_len: int = 200, allow_empty: bool = False) -> str:
    text = clean_text(value, field=field, max_len=max_len, allow_empty=allow_empty)
    return text.replace("\n", " ").replace("\r", " ").strip()


def json_safe(value, *, depth: int = 0):
    """Recursively coerce values into JSON-safe primitives with bounded depth."""
    if depth > 8:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _CONTROL.sub("", value)[:20000]
    if isinstance(value, dict):
        return {str(k)[:80]: json_safe(v, depth=depth + 1) for k, v in list(value.items())[:80]}
    if isinstance(value, (list, tuple)):
        return [json_safe(v, depth=depth + 1) for v in list(value)[:200]]
    return str(value)[:2000]


def validate_url(url: object, *, allow_private: bool | None = None) -> str:
    """Accept only http(s) URLs and (by default) block private networks (SSRF)."""
    if not isinstance(url, str) or not url.strip():
        raise ValidationError("url must be a non-empty string.")
    candidate = url.strip()
    if len(candidate) > 2048:
        raise ValidationError("url is too long.")
    if "://" not in candidate:
        candidate = "https://" + candidate
    parts = urlsplit(candidate)
    if parts.scheme not in {"http", "https"}:
        raise ValidationError("Only http and https URLs are allowed.")
    if not parts.hostname:
        raise ValidationError("url has no host.")
    if parts.username or parts.password:
        raise ValidationError("Credentials in URLs are not allowed.")

    private_ok = settings.allow_private_urls if allow_private is None else allow_private
    if not private_ok:
        host = parts.hostname.strip("[]")
        try:
            infos = socket.getaddrinfo(host, None)
        except OSError:
            raise ValidationError("Could not resolve the host name.") from None
        for info in infos:
            address = info[4][0].split("%")[0]
            try:
                ip = ipaddress.ip_address(address)
            except ValueError:
                continue
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                raise ValidationError(
                    "Private, loopback and reserved addresses are blocked. "
                    "Set JARVIS_ALLOW_PRIVATE_URLS=1 to allow them on a trusted device."
                )
    return candidate


def safe_workspace_path(raw_path: object, *, must_exist: bool = False) -> Path:
    """Resolve a user supplied path inside the workspace jail."""
    from pathlib import Path as _Path

    if not isinstance(raw_path, str):
        raise ValidationError("path must be a string.")
    relative = raw_path.strip().lstrip("/")
    if not relative:
        relative = "."
    if len(relative) > 400:
        raise ValidationError("path is too long.")
    parts = _Path(relative).parts
    if any(part == ".." for part in parts):
        raise ValidationError("Path traversal is not allowed.")
    root = settings.workspace_dir.resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise ValidationError("Path escapes the workspace directory.")
    if must_exist and not target.exists():
        raise ValidationError("Path does not exist.")
    return target


def sanitize_filename(name: object, *, fallback: str = "file") -> str:
    if not isinstance(name, str):
        return fallback
    cleaned = _UNSAFE_FILENAME.sub("_", name.strip())[:80].strip(". ")
    return cleaned or fallback
