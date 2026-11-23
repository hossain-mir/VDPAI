"""Configuration for JARVIS AI.

Loads ``.env`` from the project root without third-party dependencies and
exposes one immutable ``settings`` object shared by the backend.

Secrets stay on the Python side: nothing in this module is ever serialised to
the browser.  ``settings.public()`` returns only safe, non-secret metadata.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import secrets
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

_ENV_LINE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _parse_env(path: Path) -> dict[str, str]:
    """Parse a dotenv file. Supports comments, quotes and ``export``."""
    values: dict[str, str] = {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not _ENV_LINE.match(key):
            continue
        values[key] = value
    return values


# Remember which keys came from the real process environment before .env values
# are merged, so an explicit (even empty) JARVIS_ACCESS_TOKEN can be honoured.
_EXPLICIT_ENV_KEYS = set(os.environ)

_ENV = _parse_env(BASE_DIR / ".env")
for _k, _v in _ENV.items():
    # Real environment variables win over .env entries.
    os.environ.setdefault(_k, _v)


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _bool(name: str, default: bool = False) -> bool:
    return _env(name, "1" if default else "0").lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(_env(name) or default)
    except ValueError:
        return default


def _path(name: str, default: str) -> Path:
    value = Path(_env(name) or default).expanduser()
    return value if value.is_absolute() else (BASE_DIR / value)


def update_env_file(key: str, value: str, *, path: Path | str | None = None) -> None:
    """Persist a single key in ``.env`` (used for runtime key management).

    The file is rewritten atomically and restricted to the owner.  Existing
    comments and unrelated keys are preserved.  A custom ``path`` is used by
    tests; process environment updates only apply to the real project file.
    """
    if not _ENV_LINE.match(key):
        raise ValueError("invalid environment key")
    env_path = Path(path) if path else (BASE_DIR / ".env")
    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
    replaced = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if stripped.split("=", 1)[0].strip() == key and "=" in stripped:
            lines[index] = f"{key}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{key}={value}")
    tmp_path = env_path.with_suffix(".env.tmp")
    tmp_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    try:
        os.chmod(tmp_path, 0o600)
    except OSError:
        pass
    tmp_path.replace(env_path)
    if path is None:
        os.environ[key] = value
        _ENV[key] = value


def generate_access_token() -> str:
    """Return a 256-bit, URL-safe access token (never logged or sent to JS)."""
    return secrets.token_urlsafe(32)


def token_fingerprint(token: str) -> str:
    """Non-reversible identifier used to bind unlock grants to a token version."""
    if not token:
        return ""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def ensure_access_token(settings_obj=None, *, path: Path | str | None = None) -> str | None:
    """Guarantee that a deployed server has a strong access token.

    An explicit ``JARVIS_ACCESS_TOKEN`` environment variable is always
    respected (including an intentionally empty one in tests).  Otherwise a
    missing token is generated once, stored in a 0600 ``.env`` and activated in
    the running settings.  The returned secret is only for the caller; no
    caller in this project prints it to logs or to the browser.
    """
    target = settings_obj or globals().get("settings")
    if target is None:
        return None
    if "JARVIS_ACCESS_TOKEN" in _EXPLICIT_ENV_KEYS:
        return target.access_token or None
    if target.access_token:
        if not getattr(target, "token_fingerprint", ""):
            target.token_fingerprint = token_fingerprint(target.access_token)
        return target.access_token
    token = generate_access_token()
    update_env_file("JARVIS_ACCESS_TOKEN", token, path=path)
    target.access_token = token
    target.token_fingerprint = token_fingerprint(token)
    return token


PROVIDER_ENV = {
    "openai": {
        "label": "OpenAI",
        "key": "OPENAI_API_KEY",
        "base": "OPENAI_BASE_URL",
        "model": "OPENAI_MODEL",
        "default_base": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
    },
    "groq": {
        "label": "Groq",
        "key": "GROQ_API_KEY",
        "base": "GROQ_BASE_URL",
        "model": "GROQ_MODEL",
        "default_base": "https://api.groq.com/openai/v1",
        "default_model": "llama-3.3-70b-versatile",
    },
    "openrouter": {
        "label": "OpenRouter",
        "key": "OPENROUTER_API_KEY",
        "base": "OPENROUTER_BASE_URL",
        "model": "OPENROUTER_MODEL",
        "default_base": "https://openrouter.ai/api/v1",
        "default_model": "openai/gpt-4o-mini",
    },
    "gemini": {
        "label": "Google Gemini",
        "key": "GEMINI_API_KEY",
        "base": "GEMINI_BASE_URL",
        "model": "GEMINI_MODEL",
        "default_base": "https://generativelanguage.googleapis.com/v1beta",
        "default_model": "gemini-2.0-flash",
    },
    "ollama": {
        "label": "Ollama (local)",
        "key": "OLLAMA_API_KEY",
        "base": "OLLAMA_BASE_URL",
        "model": "OLLAMA_MODEL",
        "default_base": "http://127.0.0.1:11434/v1",
        "default_model": "llama3.2",
    },
    "custom": {
        "label": "Custom OpenAI-compatible",
        "key": "CUSTOM_API_KEY",
        "base": "CUSTOM_BASE_URL",
        "model": "CUSTOM_MODEL",
        "default_base": "",
        "default_model": "",
    },
}


class Settings:
    """Runtime settings resolved once at import time."""

    app_name = "HSAI 2.0"
    version = "2.0.0"

    def __init__(self) -> None:
        self.host = _env("JARVIS_HOST", "0.0.0.0")
        self.port = _int("JARVIS_PORT", 8000)
        self.debug = _bool("JARVIS_DEBUG", False)
        self.access_token = _env("JARVIS_ACCESS_TOKEN")
        self.token_fingerprint = token_fingerprint(self.access_token)
        self.local_auto_unlock = _bool("JARVIS_LOCAL_AUTO_UNLOCK", True)
        self.trust_proxy = _bool("JARVIS_TRUST_PROXY", False)
        # Networks allowed to reach the API without a token. Defaults cover
        # loopback and RFC1918 private LANs; extra CIDRs can be added via env.
        self.trusted_networks = self._build_trusted_networks()
        # The bundled APK's WebView runs on http://localhost and talks to a
        # different origin; keep credentialed CORS working for it by default.
        self.allowed_origins = [
            origin.strip().rstrip("/")
            for origin in _env("JARVIS_ALLOWED_ORIGINS", "http://localhost,capacitor://localhost").split(",")
            if origin.strip()
        ]
        self.allow_private_urls = _bool("JARVIS_ALLOW_PRIVATE_URLS", False)

        self.rate_limit_per_minute = _int("JARVIS_RATE_LIMIT", 120)
        self.chat_rate_limit_per_minute = _int("JARVIS_CHAT_RATE_LIMIT", 24)
        self.session_ttl_hours = _int("JARVIS_SESSION_TTL_HOURS", 12)
        self.max_body_bytes = _int("JARVIS_MAX_BODY_BYTES", 12 * 1024 * 1024)
        self.max_message_chars = _int("JARVIS_MAX_MESSAGE_CHARS", 8000)
        self.max_image_mb = _int("JARVIS_MAX_IMAGE_MB", 8)
        self.history_window = _int("JARVIS_HISTORY_WINDOW", 18)
        self.max_tool_rounds = _int("JARVIS_MAX_TOOL_ROUNDS", 4)
        self.tool_timeout = _float("JARVIS_TOOL_TIMEOUT", 20.0)
        self.chat_timeout = _float("JARVIS_CHAT_TIMEOUT", 70.0)
        self.memory_retention_days = _int("JARVIS_MEMORY_RETENTION_DAYS", 0)

        self.default_provider = _env("JARVIS_DEFAULT_PROVIDER", "auto").lower()
        self.fallback_provider = _env("JARVIS_FALLBACK_PROVIDER", "").lower()
        self.default_language = _env("JARVIS_DEFAULT_LANGUAGE", "en-US")
        self.temperature = _float("JARVIS_TEMPERATURE", 0.6)
        self.max_tokens = _int("JARVIS_MAX_TOKENS", 900)

        self.base_dir = BASE_DIR
        self.db_path = _path("JARVIS_DB_PATH", "database/jarvis.db")
        self.workspace_dir = _path("JARVIS_WORKSPACE", "workspace")
        self.log_dir = _path("JARVIS_LOG_DIR", "logs")
        self.frontend_dir = BASE_DIR / "frontend"

        for directory in (
            self.db_path.parent,
            self.db_path.parent / "backups",
            self.workspace_dir,
            self.workspace_dir / "uploads",
            self.log_dir,
            self.frontend_dir / "css",
            self.frontend_dir / "js",
            self.frontend_dir / "assets",
        ):
            directory.mkdir(parents=True, exist_ok=True)

        if self.memory_retention_days > 0:
            pass  # retention is applied by the memory engine on startup

        # Warnings are surfaced by /api/status but never include the value.
        self.warnings: list[str] = []
        if self.access_token and len(self.access_token) < 8:
            self.warnings.append(
                "JARVIS_ACCESS_TOKEN is shorter than 8 characters; access protection is weakened."
            )
        if not self.access_token:
            self.warnings.append(
                "Public access protection is off. Set JARVIS_ACCESS_TOKEN before using a tunnel."
            )

    def _build_trusted_networks(self) -> list:
        """Networks allowed to reach the API unauthenticated (loopback + LAN)."""
        networks: list = []
        defaults = (
            "127.0.0.0/8",
            "::1/128",
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "192.0.0.0/24",
        )
        extra = [item.strip() for item in _env("JARVIS_TRUSTED_CIDRS").split(",") if item.strip()]
        for entry in (*defaults, *extra):
            try:
                networks.append(ipaddress.ip_network(entry, strict=False))
            except ValueError:
                continue
        return networks

    def is_trusted_ip(self, ip: str | None) -> bool:
        if not ip:
            return False
        try:
            address = ipaddress.ip_address(ip.split("%")[0])
        except ValueError:
            return False
        return any(address in network for network in self.trusted_networks)

    # ------------------------------------------------------------------ helpers
    def provider_entry(self, provider_id: str) -> dict:
        meta = PROVIDER_ENV.get(provider_id, {})
        key_env = meta.get("key", "")
        base_env = meta.get("base", "")
        model_env = meta.get("model", "")
        return {
            "id": provider_id,
            "label": meta.get("label", provider_id),
            "key_env": key_env,
            "base_env": base_env,
            "model_env": model_env,
            "base_url": _env(base_env, meta.get("default_base", "")),
            "model": _env(model_env, meta.get("default_model", "")),
            "api_key": _env(key_env),
            "explicit_base": bool(_env(base_env)),
            "explicit_model": bool(_env(model_env)),
            "explicit_key": bool(_env(key_env)),
        }

    def configured_providers(self) -> list[str]:
        found = []
        for provider_id in PROVIDER_ENV:
            entry = self.provider_entry(provider_id)
            if provider_id == "ollama":
                # Ollama has a default URL, so require an explicit opt-in.
                if entry["explicit_base"] or entry["explicit_model"] or entry["api_key"]:
                    found.append(provider_id)
            elif provider_id == "custom":
                if entry["base_url"] and entry["model"]:
                    found.append(provider_id)
            elif entry["api_key"]:
                found.append(provider_id)
        return found

    def lan_urls(self) -> list[str]:
        """Best-effort list of URLs this server is reachable on."""
        import socket

        urls = [f"http://127.0.0.1:{self.port}"]
        addresses: set[str] = set()
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                addresses.add(info[4][0])
        except OSError:
            pass
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.settimeout(0.4)
            probe.connect(("8.8.8.8", 80))
            addresses.add(probe.getsockname()[0])
            probe.close()
        except OSError:
            pass
        for address in sorted(addresses):
            if address.startswith("127.") or address.startswith("0."):
                continue
            urls.append(f"http://{address}:{self.port}")
        return urls

    def disk_free_mb(self) -> int:
        try:
            return int(shutil.disk_usage(BASE_DIR).free / (1024 * 1024))
        except OSError:
            return 0

    def public(self) -> dict:
        """Non-secret configuration safe to expose to the browser."""
        return {
            "app": self.app_name,
            "version": self.version,
            "max_message_chars": self.max_message_chars,
            "max_image_mb": self.max_image_mb,
            "history_window": self.history_window,
            "tool_timeout": self.tool_timeout,
            "chat_timeout": self.chat_timeout,
            "default_language": self.default_language,
            "languages": [
                {"id": "en-US", "label": "English", "stt": "en-US", "tts": "en-US"},
                {"id": "bn-BD", "label": "বাংলা", "stt": "bn-BD", "tts": "bn-BD"},
                {"id": "hi-IN", "label": "हिन्दी", "stt": "hi-IN", "tts": "hi-IN"},
            ],
            "auth_required": bool(self.access_token),
            "public_warning": (
                "This server is protected by an access token."
                if self.access_token
                else "Local-only mode: do not expose this port with a public tunnel until you set JARVIS_ACCESS_TOKEN."
            ),
            "urls": self.lan_urls(),
        }


settings = Settings()
