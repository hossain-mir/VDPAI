"""Voice Engine (server side).

Audio capture and speech synthesis happen in the browser because mobile
browsers own the microphone.  The backend validates languages, normalises
spoken commands (wake phrase) and prepares TTS-friendly chunks.
"""

from __future__ import annotations

from backend.core.errors import ValidationError
from backend.security.sanitize import clean_text

LANGUAGES = [
    {"id": "en-US", "label": "English", "stt": "en-US", "tts": "en-US", "wake": ["hey jarvis", "hi jarvis", "ok jarvis"]},
    {"id": "bn-BD", "label": "বাংলা", "stt": "bn-BD", "tts": "bn-BD", "wake": ["হেই জার্ভিস", "জার্ভিস"]},
    {"id": "hi-IN", "label": "हिन्दी", "stt": "hi-IN", "tts": "hi-IN", "wake": ["हे जार्विस", "जार्विस"]},
]
LANGUAGE_IDS = {item["id"] for item in LANGUAGES}
WAKE_PHRASES = ["hey jarvis", "hi jarvis", "ok jarvis", "hey, jarvis", "jarvis"]


def normalise_language(value: object) -> str:
    if not value:
        return "en-US"
    code = str(value).strip()
    if code in LANGUAGE_IDS:
        return code
    short = code.split("-")[0].lower()
    for item in LANGUAGES:
        if item["id"].split("-")[0] == short:
            return item["id"]
    raise ValidationError("Unsupported language. Use en-US, bn-BD or hi-IN.")


def strip_wake_phrase(text: str) -> tuple[str, bool]:
    """Remove a leading wake phrase; returns (command, wake_detected)."""
    cleaned = (text or "").strip()
    lowered = cleaned.lower()
    for phrase in sorted(WAKE_PHRASES, key=len, reverse=True):
        if lowered.startswith(phrase):
            remainder = cleaned[len(phrase):].lstrip(" ,.!?-—")
            return remainder, True
    return cleaned, False


def prepare_command(transcript: object, language: object = "en-US") -> dict:
    text = clean_text(transcript, field="transcript", max_len=4000)
    command, wake = strip_wake_phrase(text)
    if not command:
        raise ValidationError("The wake phrase was detected but no command followed.")
    return {"command": command, "wake": wake, "language": normalise_language(language)}


def capabilities() -> dict:
    return {
        "engine": "browser",
        "stt": "Web Speech API (SpeechRecognition)",
        "tts": "Web Speech API (speechSynthesis)",
        "languages": LANGUAGES,
        "wake_phrase": "Hey Jarvis",
        "wake_supported": "while the browser tab is active and the mic is streaming",
        "limitations": [
            "Android browsers pause microphone capture when the tab is backgrounded or the screen locks.",
            "Speech recognition needs an internet connection on most Android browsers (Google service).",
            "Wake-word listening is opt-in, runs only while this page is open, and is never a background service.",
            "The manual microphone button is the reliable fallback at all times.",
        ],
    }
