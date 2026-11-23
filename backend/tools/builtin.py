"""Built-in JARVIS tools, all sandboxed and validated."""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import time
from datetime import datetime, timezone

from config import settings
from backend.automation import browser as browser_engine
from backend.core.errors import ToolError, ValidationError
from backend.memory.store import store
from backend.security.sanitize import clean_line, clean_text, safe_workspace_path
from backend.tools.calculator import calculate
from backend.tools.registry import ToolContext, ToolRegistry, ToolSpec


def _now() -> datetime:
    return datetime.now(timezone.utc).astimezone()


def _human_size(size: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{size} B"
        size /= 1024
    return f"{size:.1f} GB"


# --------------------------------------------------------------------- handlers
async def _calculator(args: dict, ctx: ToolContext) -> dict:
    outcome = calculate(args["expression"])
    return {
        "_summary": f"{outcome['expression']} = {outcome['result']}",
        **outcome,
    }


async def _datetime(args: dict, ctx: ToolContext) -> dict:
    from datetime import datetime as _dt

    tz_name = (args.get("timezone") or "").strip()
    if tz_name:
        try:
            from zoneinfo import ZoneInfo

            now = _dt.now(ZoneInfo(clean_line(tz_name, field="timezone", max_len=64)))
        except Exception:
            raise ValidationError(f"Unknown timezone: {tz_name}") from None
    else:
        now = _now()
    return {
        "_summary": now.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "iso": now.isoformat(timespec="seconds"),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "timezone": now.tzname() or "local",
        "utc_offset": now.strftime("%z"),
        "unix": int(now.timestamp()),
    }


async def _note_create(args: dict, ctx: ToolContext) -> dict:
    title = clean_line(args["title"], field="title", max_len=120)
    content = clean_text(args.get("content", ""), field="content", max_len=4000, allow_empty=True)
    tags = clean_line(args.get("tags", ""), field="tags", max_len=120, allow_empty=True)
    note = await store.add_note(title, content, tags)
    return {"_summary": f"note #{note['id']} saved: {title}", "note": note, "verified": True}


async def _note_search(args: dict, ctx: ToolContext) -> dict:
    query = clean_line(args["query"], field="query", max_len=120)
    limit = int(args.get("limit", 10))
    notes = await store.list_notes(query, limit)
    return {"_summary": f"{len(notes)} note(s) matched '{query}'", "query": query, "notes": notes, "count": len(notes)}


async def _web_search(args: dict, ctx: ToolContext) -> dict:
    query = clean_line(args["query"], field="query", max_len=300)
    outcome = await browser_engine.web_search(query, max_results=int(args.get("max_results", 5)))
    if outcome["ok"]:
        summary = f"{outcome['count']} result(s) for '{query}'"
    else:
        summary = f"search failed for '{query}': {outcome.get('note', 'no results')}"
    return {"_summary": summary, **outcome}


async def _fetch_page(args: dict, ctx: ToolContext) -> dict:
    page = await browser_engine.fetch_page(
        args["url"],
        max_chars=int(args.get("max_chars", 6000)),
    )
    preview = page["text"][:200].replace("\n", " ")
    return {
        "_summary": f"read {page['bytes']} bytes from {page['url']} (HTTP {page['status']})",
        **page,
        "preview": preview,
    }


async def _open_website(args: dict, ctx: ToolContext) -> dict:
    page = await browser_engine.fetch_page(args["url"], max_chars=1500)
    return {
        "_summary": f"opened {page['url']} (HTTP {page['status']})",
        "url": page["url"],
        "status": page["status"],
        "title": page["title"],
        "reachable": page["ok"],
        "display_link": page["url"],
    }


async def _list_files(args: dict, ctx: ToolContext) -> dict:
    target = safe_workspace_path(args.get("path", "."))
    if target.exists() and not target.is_dir():
        raise ToolError("Path is a file; use fetch or create tools instead.")
    target.mkdir(parents=True, exist_ok=True)
    limit = int(args.get("limit", 50))
    entries = []
    for item in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))[:limit]:
        try:
            stat = item.stat()
        except OSError:
            continue
        entries.append(
            {
                "name": item.name,
                "type": "dir" if item.is_dir() else "file",
                "size": stat.st_size if item.is_file() else None,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            }
        )
    relative = str(target.relative_to(settings.workspace_dir.resolve())) or "."
    return {
        "_summary": f"{len(entries)} item(s) in workspace/{relative}",
        "path": relative,
        "entries": entries,
        "count": len(entries),
    }


async def _create_file(args: dict, ctx: ToolContext) -> dict:
    target = safe_workspace_path(args["path"])
    content = clean_text(args["content"], field="content", max_len=200_000, allow_empty=True)
    if target.exists():
        raise ToolError("File already exists. Delete it (with approval) before writing again.")
    if target.parent.exists() and not target.parent.is_dir():
        raise ToolError("Parent path is not a directory.")
    target.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(target.write_text, content, "utf-8")
    written = target.stat().st_size
    relative = str(target.relative_to(settings.workspace_dir.resolve()))
    return {
        "_summary": f"created workspace/{relative} ({written} bytes)",
        "path": relative,
        "bytes": written,
        "verified": target.exists() and written == len(content.encode("utf-8")),
    }


async def _delete_file(args: dict, ctx: ToolContext) -> dict:
    target = safe_workspace_path(args["path"], must_exist=True)
    if target.is_dir():
        raise ToolError("Only individual files can be deleted, not directories.")
    size = target.stat().st_size
    await asyncio.to_thread(target.unlink)
    return {
        "_summary": f"deleted workspace/{target.relative_to(settings.workspace_dir.resolve())}",
        "deleted": True,
        "bytes_freed": size,
        "verified": not target.exists(),
    }


def _meminfo() -> dict:
    info: dict[str, float] = {}
    try:
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                parts = rest.strip().split()
                if parts and parts[0].isdigit():
                    info[key] = int(parts[0]) / 1024  # MB
    except OSError:
        return {}
    return {
        "total_mb": round(info.get("MemTotal", 0)),
        "available_mb": round(info.get("MemAvailable", 0)),
        "used_mb": round(info.get("MemTotal", 0) - info.get("MemAvailable", 0)),
    }


def _battery() -> dict:
    base = "/sys/class/power_supply"
    if not os.path.isdir(base):
        return {"available": False}
    for entry in os.listdir(base):
        path = os.path.join(base, entry)
        if not os.path.isdir(path):
            continue
        try:
            capacity = open(os.path.join(path, "capacity"), encoding="ascii").read().strip()
            status = open(os.path.join(path, "status"), encoding="ascii").read().strip()
        except OSError:
            continue
        if capacity.isdigit():
            return {"available": True, "percent": int(capacity), "status": status, "source": entry}
    return {"available": False}


async def _system_info(args: dict, ctx: ToolContext) -> dict:
    load = os.getloadavg() if hasattr(os, "getloadavg") else (0, 0, 0)
    try:
        uptime = float(open("/proc/uptime", encoding="ascii").read().split()[0])
    except (OSError, ValueError):
        uptime = 0.0
    try:
        usage = shutil.disk_usage(settings.base_dir)
        disk = {"total_mb": round(usage.total / 1048576), "free_mb": round(usage.free / 1048576)}
    except OSError:
        disk = {}
    info = {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "android": os.environ.get("ANDROID_ROOT", "") != "",
        "python": platform.python_version(),
        "hostname": platform.node(),
        "cpu_count": os.cpu_count(),
        "load_1m": round(load[0], 2),
        "uptime_hours": round(uptime / 3600, 2),
        "memory": _meminfo(),
        "battery": _battery(),
        "disk": disk,
        "jarvis_uptime": None,
    }
    from backend.core.state import state

    info["jarvis_uptime"] = state.snapshot()["uptime_seconds"]
    return {"_summary": f"{info['os']} | Python {info['python']} | {info['cpu_count']} CPUs", **info}


async def _memory_search(args: dict, ctx: ToolContext) -> dict:
    query = clean_line(args["query"], field="query", max_len=200)
    limit = int(args.get("limit", 8))
    messages = await store.search_messages(query, limit, ctx.session_id)
    notes = await store.list_notes(query, limit)
    return {
        "_summary": f"{len(messages)} message(s) and {len(notes)} note(s) for '{query}'",
        "query": query,
        "messages": messages,
        "notes": notes,
    }


# ----------------------------------------------------------------------- schema
def _register(
    registry: ToolRegistry,
    name: str,
    description: str,
    parameters: dict,
    handler,
    *,
    category: str,
    requires_approval: bool = False,
    timeout: float | None = None,
) -> None:
    registry.register(
        ToolSpec(
            name=name,
            description=description,
            parameters=parameters,
            handler=handler,
            category=category,
            requires_approval=requires_approval,
            timeout=timeout,
        )
    )


def register_builtin_tools(registry: ToolRegistry) -> None:
    _register(
        registry,
        "calculator",
        "Evaluate a mathematical expression with + - * / // % **, parentheses and math functions (sqrt, sin, log, ...).",
        {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "For example: (12 * 8) + sqrt(144)",
                    "maxLength": 240,
                }
            },
            "required": ["expression"],
            "additionalProperties": False,
        },
        _calculator,
        category="utility",
    )

    _register(
        registry,
        "get_datetime",
        "Get the current date and time, optionally for an IANA timezone such as Asia/Dhaka.",
        {
            "type": "object",
            "properties": {
                "timezone": {"type": "string", "maxLength": 64, "description": "IANA timezone, optional."}
            },
            "required": [],
            "additionalProperties": False,
        },
        _datetime,
        category="utility",
    )

    _register(
        registry,
        "note_create",
        "Save a note to JARVIS memory.",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string", "maxLength": 120},
                "content": {"type": "string", "maxLength": 4000},
                "tags": {"type": "string", "maxLength": 120},
            },
            "required": ["title"],
            "additionalProperties": False,
        },
        _note_create,
        category="memory",
    )

    _register(
        registry,
        "note_search",
        "Search saved notes by title, content or tags.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 120},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        _note_search,
        category="memory",
    )

    _register(
        registry,
        "memory_search",
        "Search the conversation history and notes for context.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 200},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        _memory_search,
        category="memory",
    )

    _register(
        registry,
        "web_search",
        "Search the public web and return result titles, URLs and snippets. Results are extracted from DuckDuckGo HTML.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "maxLength": 300},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 8},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        _web_search,
        category="browser",
        timeout=30,
    )

    _register(
        registry,
        "fetch_page",
        "Fetch a public web page and return its readable text plus links. Useful for summarising or verifying content.",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "maxLength": 2048},
                "max_chars": {"type": "integer", "minimum": 500, "maximum": 12000},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
        _fetch_page,
        category="browser",
        timeout=30,
    )

    _register(
        registry,
        "open_website",
        "Verify that a website is reachable and return a link the user can open in their browser.",
        {
            "type": "object",
            "properties": {"url": {"type": "string", "maxLength": 2048}},
            "required": ["url"],
            "additionalProperties": False,
        },
        _open_website,
        category="browser",
        timeout=25,
    )

    _register(
        registry,
        "list_files",
        "List files in the JARVIS workspace sandbox (default path '.').",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": 300},
                "limit": {"type": "integer", "minimum": 1, "maximum": 200},
            },
            "required": [],
            "additionalProperties": False,
        },
        _list_files,
        category="files",
    )

    _register(
        registry,
        "create_file",
        "Create a text file inside the JARVIS workspace sandbox. Existing files are never overwritten.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "maxLength": 300},
                "content": {"type": "string", "maxLength": 100000},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
        _create_file,
        category="files",
    )

    _register(
        registry,
        "delete_file",
        "Delete a file inside the workspace. Requires explicit user approval.",
        {
            "type": "object",
            "properties": {"path": {"type": "string", "maxLength": 300}},
            "required": ["path"],
            "additionalProperties": False,
        },
        _delete_file,
        category="files",
        requires_approval=True,
    )

    _register(
        registry,
        "system_info",
        "Read host system information: OS, Python, CPU, memory, battery, disk and uptime.",
        {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        _system_info,
        category="system",
    )
