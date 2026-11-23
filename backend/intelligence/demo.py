"""Demo mode: deterministic local rules used only when no AI provider is set.

Demo responses are always labelled.  They never pretend to be language-model
output; the API also returns ``demo: true`` and the HUD shows a DEMO badge.
"""

from __future__ import annotations

from datetime import datetime

from backend.tools.calculator import calculate

DEMO_BANNER = "DEMO MODE — local rules only, no language model is connected."


def _local_time() -> str:
    now = datetime.now().astimezone()
    return now.strftime("%A, %d %B %Y · %H:%M:%S %Z")


def demo_reply(message: str, *, language: str = "en-US") -> str:
    text = (message or "").strip()
    lowered = text.lower()

    if lowered in {"hi", "hello", "hey", "hey jarvis", "hi jarvis", "salam", "assalamu alaikum"}:
        return (
            f"Hello. {DEMO_BANNER}\n"
            "I can already run local tools: calculator, date/time, notes, web search, "
            "page reading, workspace files and system info. Add an API key in Settings to "
            "enable real AI reasoning."
        )

    if any(word in lowered for word in ("who are you", "what are you", "your name", "jarvis")):
        return (
            f"I am JARVIS AI, running locally on this Android device. {DEMO_BANNER}\n"
            "My backend, memory and tools are real; only the language model is missing."
        )

    if any(word in lowered for word in ("api key", "configure", "provider", "setup", "settings")):
        return (
            "To connect a real model:\n"
            "1. Open Settings in the HUD.\n"
            "2. Pick a provider (OpenAI, Gemini, Groq, OpenRouter, Ollama or custom).\n"
            "3. Paste the API key and press Save, then Test.\n"
            "Keys are written to the server-side .env file and never sent to the browser."
        )

    if any(word in lowered for word in ("help", "capabilit", "what can you do", "commands")):
        return (
            f"{DEMO_BANNER}\n"
            "Available now: arithmetic, date/time, notes, memory search, web search, "
            "page reading, workspace file listing/creation, system telemetry, plus voice "
            "input and speech output in English, Bengali and Hindi."
        )

    if any(word in lowered for word in ("time", "date", "today", "now")):
        return f"Local device time: {_local_time()}.\n{DEMO_BANNER}"

    # A small amount of genuinely useful behaviour: arithmetic.
    candidate = text.replace("calculate", "").replace("what is", "").strip(" ?=")
    if candidate and any(char.isdigit() for char in candidate) and any(op in candidate for op in "+-*/^%"):
        try:
            outcome = calculate(candidate)
            return f"{outcome['expression']} = {outcome['result']}\n{DEMO_BANNER}"
        except Exception:
            pass

    return (
        f"{DEMO_BANNER}\n"
        f"I received: \"{text[:200]}\"\n"
        "I cannot write a natural answer without a model. Connect a provider in Settings, "
        "or ask me to calculate, save a note, search the web, read a page, list files, "
        "or report system information."
    )
