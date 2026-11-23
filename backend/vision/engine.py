"""Vision Engine: analyse uploaded images with a vision-capable provider.

Refuses to fabricate descriptions.  If the active provider cannot see images,
the API returns an explicit limitation instead of a made-up answer.
"""

from __future__ import annotations

import base64
import binascii
import re

from config import settings
from backend.core.errors import ProviderError, UnsupportedError, ValidationError
from backend.core.events import bus
from backend.intelligence import providers as provider_layer
from backend.memory.store import store
from backend.security.audit import audit
from backend.security.sanitize import clean_text

DATA_URL = re.compile(r"^data:(image/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)
MAGIC = {
    "png": b"\x89PNG\r\n\x1a\n",
    "jpeg": b"\xff\xd8\xff",
    "jpg": b"\xff\xd8\xff",
    "webp": b"RIFF",
    "gif": b"GIF8",
}


def decode_image(data_url: object) -> tuple[str, bytes, str]:
    if not isinstance(data_url, str) or not data_url.strip():
        raise ValidationError("image must be a base64 data URL.")
    if len(data_url) > 30_000_000:
        raise ValidationError("Image payload is too large.")
    match = DATA_URL.match(data_url.strip())
    if not match:
        raise ValidationError("image must look like data:image/png;base64,...")
    mime = match.group(1).lower()
    payload = re.sub(r"\s+", "", match.group(2))
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise ValidationError("Image base64 data is corrupted.") from None
    if not raw:
        raise ValidationError("Image is empty.")
    if len(raw) > settings.max_image_mb * 1024 * 1024:
        raise ValidationError(f"Image exceeds the {settings.max_image_mb} MB limit.")
    kind = mime.split("/")[-1]
    signature = MAGIC.get(kind, b"")
    if signature and not raw.startswith(signature):
        raise ValidationError("Image content does not match its declared type.")
    if kind == "webp" and raw[8:12] != b"WEBP":
        raise ValidationError("Image content does not match its declared type.")
    return mime, raw, payload


async def analyze_image(
    *,
    image: str,
    prompt: str,
    language: str,
    session_id: str,
    ip: str,
) -> dict:
    mime, raw, _payload = decode_image(image)
    question = clean_text(
        prompt or "Describe this image in detail and note anything actionable.",
        field="prompt",
        max_len=1000,
    )
    provider, model = await provider_layer.resolve_active(store)
    if provider.id == "demo" or not provider.supports_vision:
        raise UnsupportedError(
            f"Vision is unavailable: the active provider ({provider.label_for_ui}) cannot analyse images. "
            "Configure OpenAI, Gemini or OpenRouter with a vision-capable model, then try again.",
            details={
                "provider": provider.id,
                "supports_vision": provider.supports_vision,
                "max_image_mb": settings.max_image_mb,
            },
        )

    bus.publish("vision.start", {"provider": provider.id, "bytes": len(raw)})
    messages = [
        {
            "role": "system",
            "content": (
                "You are JARVIS's vision module. Describe only what is visibly present. "
                "Never invent text, people, or objects that are not visible. If the image is "
                f"unreadable, say so. Answer in the user's language (code: {language})."
            ),
        },
        {"role": "user", "content": question},
    ]
    result = await provider.chat(
        messages,
        model=model or provider.default_model,
        temperature=0.2,
        max_tokens=800,
        images=[f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"],
    )
    if not result.text.strip():
        raise ProviderError("The vision model returned an empty description.")

    audit.record("vision.analyze", ip=ip, detail={"provider": provider.id, "bytes": len(raw)})
    bus.publish("vision.done", {"provider": provider.id, "chars": len(result.text)})
    return {
        "ok": True,
        "analysis": result.text.strip(),
        "provider": provider.id,
        "provider_label": provider.label_for_ui,
        "model": result.model,
        "bytes": len(raw),
        "mime": mime,
        "latency_ms": result.latency_ms,
        "session_id": session_id,
    }


async def vision_status() -> dict:
    provider, model = await provider_layer.resolve_active(store)
    return {
        "available": provider.supports_vision and provider.id != "demo" and provider.configured,
        "provider": provider.id,
        "provider_label": provider.label_for_ui,
        "model": model or provider.default_model,
        "supports_vision": provider.supports_vision,
        "max_image_mb": settings.max_image_mb,
        "note": (
            "Ready to analyse images."
            if provider.supports_vision and provider.id != "demo"
            else "Configure a vision-capable provider (OpenAI, Gemini or OpenRouter) to analyse images."
        ),
    }
