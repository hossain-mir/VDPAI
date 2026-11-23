"""Chat orchestration: memory context, provider calls, tools, approvals."""

from __future__ import annotations

import json
import time
from datetime import datetime

from config import settings
from backend.core.errors import JarvisError, ProviderError, UnsupportedError
from backend.core.events import bus, now_iso
from backend.core.state import state
from backend.intelligence import providers as provider_layer
from backend.intelligence.providers import BaseProvider, ChatResult
from backend.memory.store import store
from backend.security.audit import audit
from backend.tools.builtin import register_builtin_tools
from backend.tools.registry import ToolContext, registry

LANGUAGE_NAMES = {"bn": "Bengali", "hi": "Hindi", "en": "English", "ur": "Urdu", "ar": "Arabic"}

MAX_TOOL_RESULT_CHARS = 6000


def _trim(value: str, limit: int) -> str:
    value = value or ""
    if len(value) <= limit:
        return value
    return value[:limit].rsplit(" ", 1)[0] + " …"


def build_system_prompt(*, language: str, notes: list[dict], provider_id: str) -> str:
    local_now = datetime.now().astimezone()
    note_lines = []
    for note in notes[:5]:
        title = str(note.get("title", ""))[:80]
        content = str(note.get("content", "")).replace("\n", " ")[:240]
        note_lines.append(f"- {title}: {content}")
    notes_block = "\n".join(note_lines) if note_lines else "none"
    tool_lines = "\n".join(registry.brief_lines())
    lang_name = LANGUAGE_NAMES.get(language.split("-")[0], "English")
    return f"""You are JARVIS, a private AI assistant running entirely on the user's Android phone
through a local Python server. You are calm, precise and useful — never theatrical.

IDENTITY
- Name: JARVIS AI (Just A Rather Very Intelligent System).
- Host: {state.snapshot()['platform']} / Python {state.snapshot()['python']}.
- Provider: {provider_id}. Local time: {local_now.strftime('%Y-%m-%d %H:%M:%S %Z')}.

LANGUAGE
- Active UI language code: {language} ({lang_name}).
- Reply in the language the user writes in. Bengali, Hindi and English must all be
  handled naturally. Keep spoken answers short and free of markdown tables.

BEHAVIOUR
- Be concise by default: 1-4 sentences unless the user asks for detail.
- When asked about the time/date, calculator results, files, websites or system
  state, call the matching tool instead of guessing.
- Never invent tool output. If a tool fails, state the failure and the reason.
- You cannot control the phone's UI, install apps, send messages or make payments.
- You can read public web pages via HTTP tools; full interactive browser automation
  is only available if Playwright is installed, and the tool will say so.
- For dangerous actions the tool asks the user for approval. Never claim an action
  succeeded before its tool result confirms it.

TOOLS
{tool_lines}

REMEMBERED NOTES
{notes_block}
"""


def _tool_payload(provider: BaseProvider) -> list[dict] | None:
    if provider.id == "demo" or not provider.supports_tools:
        return None
    if provider.id == "gemini":
        return registry.gemini_tools()
    return registry.openai_tools()


def _chunk_for_speech(text: str, limit: int = 220) -> list[str]:
    text = " ".join((text or "").split())
    if not text:
        return []
    chunks: list[str] = []
    current = ""
    for sentence in text.replace("!", ".").replace("?", ".").split("."):
        sentence = sentence.strip()
        if not sentence:
            continue
        candidate = f"{current}. {sentence}".strip(". ")
        if len(candidate) > limit and current:
            chunks.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks[:12]


class ChatEngine:
    def __init__(self) -> None:
        self._initialized = False

    def initialize(self) -> None:
        if self._initialized:
            return
        register_builtin_tools(registry)
        self._initialized = True

    async def respond(
        self,
        *,
        session_id: str,
        message: str,
        language: str = "en-US",
        images: list[str] | None = None,
        source: str = "text",
        ip: str = "unknown",
    ) -> dict:
        self.initialize()
        provider, model = await provider_layer.resolve_active(store)
        state.active_provider = provider.id
        state.active_model = model or provider.default_model or provider.id
        if images and (provider.id == "demo" or not provider.supports_vision):
            raise UnsupportedError(
                f"The active provider ({provider.label_for_ui}) cannot analyse images. "
                "Use the Vision panel with OpenAI, Gemini or OpenRouter, or select a vision-capable provider.",
                details={"provider": provider.id, "supports_vision": provider.supports_vision},
            )
        state.set_state("THINKING", f"{provider.label_for_ui} · {state.active_model}")

        history = await store.recent_messages(session_id, settings.history_window)
        notes = await store.list_notes("", 5)
        await store.add_message(session_id, "user", message, provider=provider.id, model=model)

        working: list[dict] = [
            {"role": "system", "content": build_system_prompt(language=language, notes=notes, provider_id=provider.id)}
        ]
        for row in history:
            if row["role"] in {"user", "assistant"} and row["content"]:
                working.append({"role": row["role"], "content": row["content"]})
        working.append({"role": "user", "content": message})

        context = ToolContext(session_id=session_id, ip=ip, source=source)
        actions: list[dict] = []
        pending: list[dict] = []
        last_result: ChatResult | None = None
        fallback_used = ""
        started = time.monotonic()

        for round_index in range(settings.max_tool_rounds):
            tool_payload = _tool_payload(provider)
            try:
                result = await provider.chat(
                    working,
                    model=model,
                    tools=tool_payload if tool_payload else None,
                    temperature=settings.temperature,
                    max_tokens=settings.max_tokens,
                    images=images if round_index == 0 else None,
                )
            except ProviderError as exc:
                fallback_id = settings.fallback_provider
                if (
                    round_index == 0
                    and fallback_id
                    and fallback_id != provider.id
                    and not fallback_used
                ):
                    fallback = provider_layer.build_providers().get(fallback_id)
                    if fallback and fallback.configured:
                        state.set_state("THINKING", f"fallback: {fallback.label_for_ui}")
                        fallback_used = fallback_id
                        provider = fallback
                        model = fallback.default_model
                        state.active_provider = provider.id
                        state.active_model = model
                        bus.publish(
                            "provider.fallback",
                            {"from": exc.message[:120], "to": provider.label_for_ui},
                        )
                        result = await provider.chat(
                            working,
                            model=model,
                            tools=_tool_payload(provider),
                            temperature=settings.temperature,
                            max_tokens=settings.max_tokens,
                            images=images if round_index == 0 else None,
                        )
                    else:
                        raise
                else:
                    raise
            last_result = result
            if not result.tool_calls:
                break

            working.append(
                {
                    "role": "assistant",
                    "content": result.text or "",
                    "tool_calls": result.tool_calls,
                }
            )
            for call in result.tool_calls:
                name = call.get("name", "")
                arguments = call.get("arguments", {})
                bus.publish("tool.requested", {"tool": name})
                try:
                    outcome = await registry.execute(name, arguments, context)
                    payload_text = json.dumps(outcome["result"], ensure_ascii=False, default=str)
                    working.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.get("id", ""),
                            "name": name,
                            "content": _trim(payload_text, MAX_TOOL_RESULT_CHARS),
                        }
                    )
                    actions.append(
                        {
                            "tool": name,
                            "ok": True,
                            "summary": outcome.get("summary", ""),
                            "result": outcome.get("result"),
                            "elapsed_ms": outcome.get("elapsed_ms"),
                        }
                    )
                except JarvisError as exc:
                    if exc.code == "approval_required":
                        pending.append(exc.details["action"])
                        working.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.get("id", ""),
                                "name": name,
                                "content": "The user must approve this action before it can run.",
                            }
                        )
                        actions.append({"tool": name, "ok": False, "pending": True, "summary": exc.message})
                    else:
                        working.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.get("id", ""),
                                "name": name,
                                "content": f"ERROR: {exc.message}",
                            }
                        )
                        actions.append({"tool": name, "ok": False, "summary": exc.message})
            if pending:
                break
            state.set_state("THINKING", "processing tool results")

        final_text = (last_result.text if last_result else "").strip()
        if pending:
            names = ", ".join(sorted({action["tool"] for action in pending}))
            approval_line = f"Approval required before I run: {names}."
            final_text = (final_text + "\n\n" + approval_line).strip() if final_text else approval_line
        if not final_text:
            if actions:
                final_text = "Done: " + "; ".join(action.get("summary", "") for action in actions)[:600]
            else:
                final_text = "I could not produce a response. Check the provider configuration in Settings."

        elapsed_ms = int((time.monotonic() - started) * 1000)
        await store.add_message(
            session_id,
            "assistant",
            final_text,
            provider=state.active_provider,
            model=state.active_model,
        )
        state.messages_handled += 1
        state.last_activity = time.time()
        state.set_state("IDLE", "response ready")
        audit.record(
            "chat.respond",
            ip=ip,
            detail={
                "session": session_id[:24],
                "provider": state.active_provider,
                "model": state.active_model,
                "tools": [action["tool"] for action in actions],
                "chars": len(message),
                "source": source,
            },
        )

        return {
            "ok": True,
            "reply": final_text,
            "provider": state.active_provider,
            "provider_label": provider.label_for_ui,
            "model": state.active_model,
            "demo": state.active_provider == "demo",
            "fallback": fallback_used,
            "language": language,
            "session_id": session_id,
            "actions": actions,
            "pending_approvals": pending,
            "usage": (last_result.usage if last_result else {}),
            "latency_ms": elapsed_ms,
            "speak_chunks": _chunk_for_speech(final_text),
            "timestamp": now_iso(),
        }

    async def public_status(self) -> dict:
        provider, model = await provider_layer.resolve_active(store)
        return {
            "provider": provider.id,
            "label": provider.label_for_ui,
            "model": model or provider.default_model,
            "configured": provider.configured,
            "supports_tools": provider.supports_tools,
            "supports_vision": provider.supports_vision,
            "demo": provider.id == "demo",
            "fallback": settings.fallback_provider,
        }


engine = ChatEngine()


def initialize_tools() -> None:
    engine.initialize()

