"""Provider-independent AI layer.

Supported: OpenAI-compatible endpoints (OpenAI, Groq, OpenRouter, Ollama,
custom), Google Gemini, plus an explicit demo provider.  API keys are read by
the Python process only and are never serialised to the browser.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from config import PROVIDER_ENV, settings, update_env_file
from backend.core.errors import ProviderError, ValidationError
from backend.intelligence.demo import demo_reply
from backend.security.sanitize import clean_line

MODEL_SUGGESTIONS = {
    "openai": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    "groq": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    "openrouter": ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "google/gemini-2.0-flash-001"],
    "gemini": ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
    "ollama": ["llama3.2", "qwen2.5", "mistral"],
    "custom": [],
}

VISION_PROVIDERS = {"openai", "gemini", "openrouter"}


@dataclass
class ChatResult:
    text: str
    provider: str
    model: str
    tool_calls: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    latency_ms: int = 0
    finish_reason: str = ""
    demo: bool = False


def _truncate(value: object, limit: int = 300) -> str:
    text = str(value or "").replace("\n", " ").strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _provider_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        return "".join(parts)
    return ""


async def _post_json(
    url: str,
    body: dict,
    *,
    headers: dict | None = None,
    timeout: float,
    retries: int = 1,
    provider_label: str,
) -> dict:
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    last_error = ""
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
                response = await client.post(url, json=body, headers=request_headers)
        except httpx.TimeoutException:
            last_error = f"request timed out after {int(timeout)}s"
        except httpx.HTTPError as exc:
            last_error = f"network error ({type(exc).__name__})"
        else:
            if response.status_code < 400:
                try:
                    return response.json()
                except ValueError:
                    raise ProviderError(f"{provider_label} returned a non-JSON response.") from None
            detail = ""
            try:
                payload = response.json()
                if isinstance(payload, dict):
                    error = payload.get("error")
                    if isinstance(error, dict):
                        detail = str(error.get("message", ""))
                    elif error:
                        detail = str(error)
                    detail = detail or str(payload.get("message", ""))
            except ValueError:
                detail = response.text[:200]
            last_error = f"HTTP {response.status_code}: {_truncate(detail) or 'request rejected'}"
            if response.status_code in {408, 409, 429, 500, 502, 503, 504} and attempt < retries:
                await asyncio.sleep(0.8)
                continue
            raise ProviderError(f"{provider_label}: {last_error}")
        if attempt < retries:
            await asyncio.sleep(0.8)
    raise ProviderError(f"{provider_label}: {last_error}")


def _to_openai_messages(messages: list[dict], images: list[str] | None = None) -> list[dict]:
    converted: list[dict] = []
    for message in messages:
        role = message.get("role", "user")
        content = message.get("content", "")
        if role == "assistant":
            item: dict = {"role": "assistant", "content": content}
            tool_calls = message.get("tool_calls") or []
            if tool_calls:
                item["tool_calls"] = [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["name"], "arguments": json.dumps(call.get("arguments", {}))},
                    }
                    for call in tool_calls
                ]
                item["content"] = content or None
            converted.append(item)
        elif role == "tool":
            converted.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id", ""),
                    "name": message.get("name", "tool"),
                    "content": str(content)[:8000],
                }
            )
        elif role == "system":
            converted.append({"role": "system", "content": content})
        else:
            converted.append({"role": "user", "content": content})

    if images:
        # Attach images to the final user turn (vision models only).
        for index in range(len(converted) - 1, -1, -1):
            if converted[index].get("role") == "user":
                text = converted[index].get("content") or ""
                parts: list[dict] = [{"type": "text", "text": str(text)}]
                for data_url in images[:3]:
                    parts.append({"type": "image_url", "image_url": {"url": data_url}})
                converted[index]["content"] = parts
                break
    return converted


def _to_gemini_contents(messages: list[dict], images: list[str] | None = None) -> tuple[list[dict], dict | None]:
    contents: list[dict] = []
    system_parts: list[str] = []

    for message in messages:
        role = message.get("role", "user")
        content = message.get("content", "")
        if role == "system":
            system_parts.append(str(content))
            continue
        if role == "assistant":
            parts: list[dict] = []
            if content:
                parts.append({"text": str(content)})
            for call in message.get("tool_calls") or []:
                parts.append({"functionCall": {"name": call["name"], "args": call.get("arguments", {})}})
            if parts:
                contents.append({"role": "model", "parts": parts})
            continue
        if role == "tool":
            contents.append(
                {
                    "role": "user",
                    "parts": [
                        {
                            "functionResponse": {
                                "name": message.get("name", "tool"),
                                "response": {"result": str(content)[:8000]},
                            }
                        }
                    ],
                }
            )
            continue
        contents.append({"role": "user", "parts": [{"text": str(content)}]})

    if images:
        for index in range(len(contents) - 1, -1, -1):
            if contents[index].get("role") == "user":
                for data_url in images[:3]:
                    mime, _, data = data_url.partition(";base64,")
                    mime_type = mime.replace("data:", "") or "image/jpeg"
                    if data:
                        contents[index]["parts"].append({"inline_data": {"mime_type": mime_type, "data": data}})
                break

    system_instruction = {"parts": [{"text": "\n\n".join(system_parts)}]} if system_parts else None
    return contents, system_instruction


class BaseProvider:
    id = "base"
    label = "Base"
    supports_tools = False
    supports_vision = False
    requires_key = True
    is_local = False
    docs = ""

    def __init__(self, entry: dict) -> None:
        self.entry = entry
        self.base_url = (entry.get("base_url") or "").rstrip("/")
        self.api_key = entry.get("api_key") or ""
        self.default_model = entry.get("model") or ""
        self.explicit_base = bool(entry.get("explicit_base"))
        self.explicit_model = bool(entry.get("explicit_model"))
        self.models = MODEL_SUGGESTIONS.get(self.id, []) or ([self.default_model] if self.default_model else [])

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @property
    def label_for_ui(self) -> str:
        return PROVIDER_ENV.get(self.id, {}).get("label", self.label)

    async def chat(
        self,
        messages: list[dict],
        *,
        model: str,
        tools: list[dict] | None = None,
        temperature: float = 0.6,
        max_tokens: int = 900,
        images: list[str] | None = None,
    ) -> ChatResult:
        raise NotImplementedError

    async def test(self, model: str | None = None) -> dict:
        started = time.monotonic()
        try:
            result = await self.chat(
                [{"role": "user", "content": "Reply with the single word: ready"}],
                model=model or self.default_model,
                temperature=0,
                max_tokens=24,
            )
        except ProviderError as exc:
            return {
                "ok": False,
                "provider": self.id,
                "model": model or self.default_model,
                "error": exc.message,
                "latency_ms": int((time.monotonic() - started) * 1000),
            }
        return {
            "ok": True,
            "provider": self.id,
            "model": result.model,
            "sample": _truncate(result.text, 80),
            "latency_ms": result.latency_ms,
        }


class OpenAICompatibleProvider(BaseProvider):
    supports_tools = True

    def __init__(self, entry: dict) -> None:
        super().__init__(entry)
        self.supports_vision = self.id in VISION_PROVIDERS
        self.is_local = self.id in {"ollama", "custom"}
        self.requires_key = not self.is_local

    @property
    def configured(self) -> bool:
        if self.id == "ollama":
            # Ollama has a default URL, so require an explicit opt-in (URL/model)
            # instead of auto-selecting a server that may not be running.
            return bool(self.explicit_base or self.explicit_model or self.api_key)
        if self.id == "custom":
            return bool(self.base_url and self.default_model)
        return bool(self.api_key and self.base_url)

    def _headers(self) -> dict:
        headers: dict = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.id == "openrouter":
            headers["HTTP-Referer"] = "http://127.0.0.1:8000"
            headers["X-Title"] = "JARVIS AI"
        return headers

    async def chat(self, messages, *, model, tools=None, temperature=0.6, max_tokens=900, images=None) -> ChatResult:
        if not self.base_url:
            raise ProviderError(f"{self.label_for_ui}: base URL is not configured.")
        if self.requires_key and not self.api_key:
            raise ProviderError(f"{self.label_for_ui}: API key is not configured.")
        model = (model or self.default_model).strip()
        if not model:
            raise ProviderError(f"{self.label_for_ui}: select a model first.")

        body: dict = {
            "model": model,
            "messages": _to_openai_messages(messages, images),
            "temperature": max(0.0, min(float(temperature), 1.5)),
            "max_tokens": max(16, min(int(max_tokens), 4000)),
            "stream": False,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        started = time.monotonic()
        payload = await _post_json(
            f"{self.base_url}/chat/completions",
            body,
            headers=self._headers(),
            timeout=settings.chat_timeout,
            provider_label=self.label_for_ui,
        )
        latency = int((time.monotonic() - started) * 1000)

        try:
            choice = payload["choices"][0]
            message = choice.get("message") or {}
        except (KeyError, IndexError, TypeError):
            raise ProviderError(f"{self.label_for_ui}: unexpected response shape.") from None

        tool_calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            raw_args = function.get("arguments") or "{}"
            try:
                parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except ValueError:
                parsed = {}
            if not isinstance(parsed, dict):
                parsed = {}
            tool_calls.append(
                {
                    "id": call.get("id") or f"call_{len(tool_calls)}",
                    "name": str(function.get("name", ""))[:80],
                    "arguments": parsed,
                }
            )

        usage = payload.get("usage") or {}
        return ChatResult(
            text=_provider_message_text(message.get("content")),
            provider=self.id,
            model=model,
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
            },
            latency_ms=latency,
            finish_reason=str(choice.get("finish_reason") or ""),
        )


class GeminiProvider(BaseProvider):
    supports_tools = True
    supports_vision = True
    label = "Google Gemini"

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url)

    async def chat(self, messages, *, model, tools=None, temperature=0.6, max_tokens=900, images=None) -> ChatResult:
        if not self.api_key:
            raise ProviderError("Google Gemini: API key is not configured.")
        model = (model or self.default_model).strip()
        if not model:
            raise ProviderError("Google Gemini: select a model first.")
        contents, system_instruction = _to_gemini_contents(messages, images)
        body: dict = {
            "contents": contents,
            "generationConfig": {
                "temperature": max(0.0, min(float(temperature), 2.0)),
                "maxOutputTokens": max(16, min(int(max_tokens), 4000)),
            },
        }
        if system_instruction:
            body["systemInstruction"] = system_instruction
        if tools:
            body["tools"] = tools

        started = time.monotonic()
        payload = await _post_json(
            f"{self.base_url}/models/{model}:generateContent",
            body,
            headers={"x-goog-api-key": self.api_key},
            timeout=settings.chat_timeout,
            provider_label="Google Gemini",
        )
        latency = int((time.monotonic() - started) * 1000)

        try:
            candidate = (payload.get("candidates") or [])[0]
            parts = (candidate.get("content") or {}).get("parts") or []
        except (IndexError, AttributeError, TypeError):
            raise ProviderError("Google Gemini: unexpected response shape.") from None

        text_chunks: list[str] = []
        tool_calls: list[dict] = []
        for part in parts:
            if "text" in part:
                text_chunks.append(str(part["text"]))
            if "functionCall" in part:
                call = part["functionCall"] or {}
                tool_calls.append(
                    {
                        "id": f"gemini_{len(tool_calls)}_{int(time.time() * 1000) % 100000}",
                        "name": str(call.get("name", ""))[:80],
                        "arguments": call.get("args") or {},
                    }
                )

        usage_meta = payload.get("usageMetadata") or {}
        return ChatResult(
            text="".join(text_chunks),
            provider=self.id,
            model=model,
            tool_calls=tool_calls,
            usage={
                "prompt_tokens": usage_meta.get("promptTokenCount"),
                "completion_tokens": usage_meta.get("candidatesTokenCount"),
                "total_tokens": usage_meta.get("totalTokenCount"),
            },
            latency_ms=latency,
            finish_reason=str(candidate.get("finishReason") or ""),
        )


class DemoProvider(BaseProvider):
    id = "demo"
    label = "Demo (local rules)"
    supports_tools = False
    requires_key = False
    docs = "No network. Deterministic local replies, clearly labelled."

    @property
    def configured(self) -> bool:
        return True

    async def chat(self, messages, *, model="demo", tools=None, temperature=0.6, max_tokens=900, images=None) -> ChatResult:
        started = time.monotonic()
        last_user = ""
        for message in reversed(messages):
            if message.get("role") == "user" and isinstance(message.get("content"), str):
                last_user = message["content"]
                break
        language = "en-US"
        for message in messages:
            if message.get("role") == "system" and "LANGUAGE:" in str(message.get("content", "")):
                marker = str(message["content"]).split("LANGUAGE:", 1)[1].strip()
                language = marker.split()[0] if marker else "en-US"
                break
        text = demo_reply(last_user, language=language)
        return ChatResult(
            text=text,
            provider="demo",
            model="demo",
            latency_ms=int((time.monotonic() - started) * 1000),
            demo=True,
        )

    async def test(self, model: str | None = None) -> dict:
        return {"ok": True, "provider": "demo", "model": "demo", "sample": "Demo provider is always available.", "latency_ms": 0}


def build_providers() -> dict[str, BaseProvider]:
    providers: dict[str, BaseProvider] = {"demo": DemoProvider(settings.provider_entry("demo"))}
    for provider_id in PROVIDER_ENV:
        entry = settings.provider_entry(provider_id)
        if provider_id == "gemini":
            providers[provider_id] = GeminiProvider(entry)
        else:
            providers[provider_id] = OpenAICompatibleProvider(entry)
    return providers


def public_provider_list(active_id: str | None = None, active_model: str | None = None) -> list[dict]:
    providers = build_providers()
    order = ["demo"] + [key for key in PROVIDER_ENV]
    result = []
    for provider_id in order:
        provider = providers.get(provider_id)
        if not provider:
            continue
        result.append(
            {
                "id": provider_id,
                "label": provider.label_for_ui,
                "configured": provider.configured,
                "requires_key": provider.requires_key,
                "supports_tools": provider.supports_tools,
                "supports_vision": provider.supports_vision,
                "is_local": provider.is_local,
                "base_url": provider.base_url if provider_id in {"ollama", "custom"} else "",
                "default_model": provider.default_model,
                "models": provider.models,
                "active": provider_id == active_id,
                "active_model": active_model if provider_id == active_id else None,
                "docs": provider.docs,
            }
        )
    return result


async def resolve_active(store) -> tuple[BaseProvider, str]:
    providers = build_providers()
    selection = await store.get_active_selection()
    if selection:
        provider_id, model = selection
        provider = providers.get(provider_id)
        if provider and provider.configured:
            return provider, (model or provider.default_model or ("demo" if provider_id == "demo" else ""))
        # Stored provider is no longer configured: fall through to auto with a note.
        await store.set_pref("provider.stale", provider_id)

    preferred = settings.default_provider
    order = ["openai", "gemini", "groq", "openrouter", "ollama", "custom"]
    if preferred in order:
        order.remove(preferred)
        order.insert(0, preferred)
    for provider_id in order:
        provider = providers.get(provider_id)
        if provider and provider.configured:
            return provider, provider.default_model
    return providers["demo"], "demo"


async def set_active(store, provider_id: str, model: str) -> dict:
    providers = build_providers()
    provider = providers.get(provider_id)
    if not provider:
        raise ValidationError(f"Unknown provider: {provider_id}")
    if not provider.configured:
        raise ValidationError(f"{provider.label_for_ui} is not configured yet. Save an API key first.")
    model = clean_line(model or provider.default_model, field="model", max_len=120)
    if not model:
        raise ValidationError("A model name is required.")
    await store.set_pref("provider.active", json.dumps({"provider": provider_id, "model": model}))
    await store.set_pref("provider.stale", "")
    return {"provider": provider_id, "model": model, "label": provider.label_for_ui}


async def test_provider(provider_id: str, model: str | None = None) -> dict:
    providers = build_providers()
    provider = providers.get(provider_id)
    if not provider:
        raise ValidationError(f"Unknown provider: {provider_id}")
    if not provider.configured:
        return {
            "ok": False,
            "provider": provider_id,
            "error": (
                f"{provider.label_for_ui} has no API key configured."
                if provider.requires_key
                else f"{provider.label_for_ui} needs a base URL configured."
            ),
        }
    return await provider.test(model)


def save_provider_config(provider_id: str, *, api_key: str | None = None, base_url: str | None = None, model: str | None = None) -> dict:
    """Persist provider settings to the server-side .env file (mode 0600)."""
    meta = PROVIDER_ENV.get(provider_id)
    if not meta:
        raise ValidationError(f"Unknown provider: {provider_id}")
    updates: list[tuple[str, str]] = []
    if api_key is not None:
        if not isinstance(api_key, str):
            raise ValidationError("api_key must be a string.")
        api_key = api_key.strip()
        if len(api_key) > 400 or any(char in api_key for char in "\r\n\t"):
            raise ValidationError("api_key contains invalid characters.")
        if api_key and not all(32 <= ord(char) < 127 for char in api_key):
            raise ValidationError("api_key must be printable ASCII.")
        updates.append((meta["key"], api_key))
    if base_url is not None:
        base_url = clean_line(base_url, field="base_url", max_len=400, allow_empty=True)
        if base_url and not base_url.startswith(("http://", "https://")):
            raise ValidationError("base_url must start with http:// or https://")
        updates.append((meta["base"], base_url))
    if model is not None:
        model = clean_line(model, field="model", max_len=120, allow_empty=True)
        updates.append((meta["model"], model))
    if not updates:
        raise ValidationError("Nothing to update.")
    for key, value in updates:
        update_env_file(key, value)
    entry = settings.provider_entry(provider_id)
    return {"provider": provider_id, "key_set": bool(entry["api_key"]), "base_url": entry["base_url"], "model": entry["model"]}
