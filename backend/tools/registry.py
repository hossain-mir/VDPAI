"""Controlled tool execution: validation, timeouts, approvals and audit logs."""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from config import settings
from backend.core.errors import ApprovalRequired, JarvisError, NotFoundError, ToolError
from backend.core.events import bus
from backend.core.state import state
from backend.security.audit import audit
from backend.tools.validation import validate_arguments


@dataclass
class ToolContext:
    session_id: str = "anonymous"
    ip: str = "unknown"
    source: str = "api"


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict
    handler: Callable[[dict, ToolContext], Awaitable[dict]]
    category: str = "general"
    requires_approval: bool = False
    timeout: float | None = None


@dataclass
class PendingAction:
    token: str
    tool: str
    args: dict
    session_id: str
    ip: str
    created: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "token": self.token,
            "tool": self.tool,
            "args": self.args,
            "created": self.created,
            "expires_in": max(0, int(self.created + 600 - time.time())),
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}
        self._pending: dict[str, PendingAction] = {}

    # ------------------------------------------------------------------ registry
    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._tools:
            raise ValueError(f"duplicate tool name: {spec.name}")
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec:
        spec = self._tools.get(name)
        if not spec:
            raise NotFoundError(f"Unknown tool: {name}")
        return spec

    def names(self) -> list[str]:
        return sorted(self._tools)

    def brief_lines(self) -> list[str]:
        return [
            f"- {spec.name}: {spec.description[:130]}"
            for spec in sorted(self._tools.values(), key=lambda item: item.name)
        ]

    def public_specs(self) -> list[dict]:
        return [
            {
                "name": spec.name,
                "description": spec.description,
                "category": spec.category,
                "requires_approval": spec.requires_approval,
                "parameters": spec.parameters,
                "timeout": spec.timeout or settings.tool_timeout,
            }
            for spec in sorted(self._tools.values(), key=lambda item: item.name)
        ]

    def openai_tools(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                },
            }
            for spec in self._tools.values()
        ]

    def gemini_tools(self) -> list[dict]:
        def convert(schema: dict) -> dict:
            converted: dict = {}
            for key, value in schema.items():
                if key in {"type", "description", "required", "enum"}:
                    converted[key] = value
                elif key in {"properties", "items"}:
                    if key == "properties":
                        converted[key] = {name: convert(sub) for name, sub in value.items()}
                    else:
                        converted[key] = convert(value)
            return converted

        return [{"functionDeclarations": [
            {
                "name": spec.name,
                "description": spec.description,
                "parameters": convert(spec.parameters),
            }
            for spec in self._tools.values()
        ]}]

    # ----------------------------------------------------------------- execution
    async def execute(self, name: str, arguments: object, context: ToolContext, *, approved: bool = False) -> dict:
        spec = self.get(name)
        args = validate_arguments(spec.parameters, arguments or {})

        if spec.requires_approval and not approved:
            action = PendingAction(
                token=secrets.token_urlsafe(12),
                tool=name,
                args=args,
                session_id=context.session_id,
                ip=context.ip,
            )
            self._cleanup_pending()
            self._pending[action.token] = action
            audit.record("tool.approval_requested", ip=context.ip, tool=name, detail={"args": args})
            bus.publish("approval", {"action": action.public()})
            raise ApprovalRequired(
                f"'{name}' needs your explicit confirmation before it can run.",
                action=action.public(),
            )

        return await self._run(spec, args, context, approved=approved)

    async def _run(self, spec: ToolSpec, args: dict, context: ToolContext, *, approved: bool) -> dict:
        state.set_state("EXECUTING", f"tool: {spec.name}")
        bus.publish("tool.start", {"tool": spec.name, "args": args})
        started = time.monotonic()
        timeout = spec.timeout or settings.tool_timeout
        try:
            result = await asyncio.wait_for(spec.handler(args, context), timeout=timeout)
            if not isinstance(result, dict):
                raise ToolError("Tool returned an invalid result shape.")
        except asyncio.TimeoutError:
            await self._log_failure(spec.name, args, f"timed out after {timeout}s")
            audit.record("tool.timeout", ip=context.ip, ok=False, tool=spec.name, detail={"args": args})
            raise ToolError(f"'{spec.name}' timed out after {int(timeout)} seconds.") from None
        except ToolError as exc:
            await self._log_failure(spec.name, args, exc.message)
            audit.record("tool.error", ip=context.ip, ok=False, tool=spec.name, detail={"error": exc.message})
            raise
        except JarvisError as exc:
            # Validation/not-found errors from a handler keep their real status
            # and message instead of being flattened into a generic tool error.
            await self._log_failure(spec.name, args, exc.message)
            audit.record("tool.rejected", ip=context.ip, ok=False, tool=spec.name, detail={"error": exc.message})
            raise
        except Exception as exc:  # defensive: tools should raise ToolError
            await self._log_failure(spec.name, args, type(exc).__name__)
            audit.record("tool.crash", ip=context.ip, ok=False, tool=spec.name, detail={"error": type(exc).__name__})
            raise ToolError(f"'{spec.name}' failed: {type(exc).__name__}.") from None

        elapsed = int((time.monotonic() - started) * 1000)
        summary = str(result.pop("_summary", ""))[:300]
        state.tool_calls += 1
        state.last_activity = time.time()
        await self.db_log(spec.name, args, True, summary or "ok")
        audit.record("tool.run", ip=context.ip, tool=spec.name, detail={"args": args, "approved": approved}, ok=True)
        bus.publish("tool.done", {"tool": spec.name, "ok": True, "summary": summary, "elapsed_ms": elapsed})
        return {
            "ok": True,
            "tool": spec.name,
            "summary": summary,
            "result": result,
            "elapsed_ms": elapsed,
            "requires_approval": bool(spec.requires_approval),
        }

    async def _log_failure(self, tool: str, args: dict, error: str) -> None:
        bus.publish("tool.done", {"tool": tool, "ok": False, "summary": error})
        await self.db_log(tool, args, False, error)

    async def db_log(self, tool: str, args: dict, ok: bool, output: str) -> None:
        try:
            from backend.memory.store import store

            await store.log_tool(tool, args, ok, output)
        except Exception:
            # Logging must never mask a tool result.
            pass

    # ------------------------------------------------------------------ approvals
    def _cleanup_pending(self) -> None:
        now = time.time()
        for token in [key for key, action in self._pending.items() if now - action.created > 600]:
            self._pending.pop(token, None)

    def pending_actions(self, session_id: str | None = None) -> list[dict]:
        self._cleanup_pending()
        return [
            action.public()
            for action in self._pending.values()
            if session_id is None or action.session_id == session_id
        ]

    async def approve(self, token: str, context: ToolContext) -> dict:
        self._cleanup_pending()
        action = self._pending.get(token)
        if not action:
            raise NotFoundError("This approval request expired or does not exist.")
        if action.session_id != context.session_id:
            raise NotFoundError("This approval request belongs to another session.")
        self._pending.pop(token, None)
        spec = self.get(action.tool)
        audit.record("tool.approved", ip=context.ip, tool=spec.name, detail={"args": action.args})
        return await self._run(spec, action.args, context, approved=True)

    def reject(self, token: str, context: ToolContext) -> None:
        action = self._pending.pop(token, None)
        if not action or action.session_id != context.session_id:
            raise NotFoundError("This approval request expired or does not exist.")
        audit.record("tool.rejected", ip=context.ip, tool=action.tool, ok=True)
        bus.publish("approval.closed", {"token": token, "tool": action.tool})


registry = ToolRegistry()
