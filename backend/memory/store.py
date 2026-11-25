"""SQLite memory engine: conversation history, notes, preferences, tool logs."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from config import settings
from backend.core.errors import NotFoundError, ValidationError
from backend.core.events import now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    ok INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
"""

ROLES = {"user", "assistant", "system", "tool"}


class MemoryStore:
    """Thread-safe SQLite wrapper. Async methods run blocking IO in a thread."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._ready = False

    # ------------------------------------------------------------------ plumbing
    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.db_path), timeout=20)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def init_sync(self) -> None:
        with self._lock:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as connection:
                connection.executescript(SCHEMA)
                connection.execute(
                    "INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)", (now_iso(),)
                )
                connection.execute(
                    "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1')"
                )
            self._ready = True

    async def init(self) -> None:
        await asyncio.to_thread(self.init_sync)

    @property
    def ready(self) -> bool:
        return self._ready

    # ---------------------------------------------------------------- messages
    def add_message_sync(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        provider: str | None = None,
        model: str | None = None,
    ) -> int:
        if role not in ROLES:
            raise ValidationError("Invalid message role.")
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO messages(session_id, role, content, provider, model, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (session_id, role, content, provider, model, now_iso()),
            )
            return int(cursor.lastrowid)

    async def add_message(self, session_id: str, role: str, content: str, **kwargs) -> int:
        return await asyncio.to_thread(self.add_message_sync, session_id, role, content, **kwargs)

    def recent_messages_sync(self, session_id: str, limit: int = 18) -> list[dict]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT id, role, content, provider, model, created_at FROM messages"
                " WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (session_id, max(1, min(limit, 100))),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]

    async def recent_messages(self, session_id: str, limit: int = 18) -> list[dict]:
        return await asyncio.to_thread(self.recent_messages_sync, session_id, limit)

    def search_messages_sync(self, query: str, limit: int = 25, session_id: str | None = None) -> list[dict]:
        pattern = f"%{query}%"
        sql = (
            "SELECT id, session_id, role, content, created_at FROM messages"
            " WHERE content LIKE ?"
        )
        params: list = [pattern]
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(limit, 100)))
        with self._lock, self._connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        return [dict(row) for row in rows]

    async def search_messages(self, query: str, limit: int = 25, session_id: str | None = None) -> list[dict]:
        return await asyncio.to_thread(self.search_messages_sync, query, limit, session_id)

    def clear_messages_sync(self, session_id: str | None = None) -> int:
        with self._lock, self._connect() as connection:
            if session_id:
                cursor = connection.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            else:
                cursor = connection.execute("DELETE FROM messages")
            return cursor.rowcount

    async def clear_messages(self, session_id: str | None = None) -> int:
        return await asyncio.to_thread(self.clear_messages_sync, session_id)

    # ------------------------------------------------------------------- notes
    def add_note_sync(self, title: str, content: str = "", tags: str = "") -> dict:
        stamp = now_iso()
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO notes(title, content, tags, created_at, updated_at) VALUES(?,?,?,?,?)",
                (title, content, tags, stamp, stamp),
            )
            note_id = int(cursor.lastrowid)
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return dict(row)

    async def add_note(self, title: str, content: str = "", tags: str = "") -> dict:
        return await asyncio.to_thread(self.add_note_sync, title, content, tags)

    def list_notes_sync(self, query: str = "", limit: int = 50) -> list[dict]:
        with self._lock, self._connect() as connection:
            if query:
                pattern = f"%{query}%"
                rows = connection.execute(
                    "SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?"
                    " ORDER BY updated_at DESC, id DESC LIMIT ?",
                    (pattern, pattern, pattern, max(1, min(limit, 200))),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM notes ORDER BY updated_at DESC, id DESC LIMIT ?",
                    (max(1, min(limit, 200)),),
                ).fetchall()
        return [dict(row) for row in rows]

    async def list_notes(self, query: str = "", limit: int = 50) -> list[dict]:
        return await asyncio.to_thread(self.list_notes_sync, query, limit)

    def update_note_sync(self, note_id: int, *, title: str | None = None, content: str | None = None, tags: str | None = None) -> dict:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
            if not row:
                raise NotFoundError("Note not found.")
            new_title = row["title"] if title is None else title
            new_content = row["content"] if content is None else content
            new_tags = row["tags"] if tags is None else tags
            connection.execute(
                "UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?",
                (new_title, new_content, new_tags, now_iso(), note_id),
            )
            updated = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return dict(updated)

    async def update_note(self, note_id: int, **fields) -> dict:
        return await asyncio.to_thread(self.update_note_sync, note_id, **fields)

    def delete_note_sync(self, note_id: int) -> None:
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            if cursor.rowcount == 0:
                raise NotFoundError("Note not found.")

    async def delete_note(self, note_id: int) -> None:
        await asyncio.to_thread(self.delete_note_sync, note_id)

    # --------------------------------------------------------------- prefs/meta
    def get_pref_sync(self, key: str, default: str | None = None) -> str | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT value FROM prefs WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    async def get_pref(self, key: str, default: str | None = None) -> str | None:
        return await asyncio.to_thread(self.get_pref_sync, key, default)

    def set_pref_sync(self, key: str, value: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO prefs(key, value, updated_at) VALUES(?,?,?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, value, now_iso()),
            )

    async def set_pref(self, key: str, value: str) -> None:
        await asyncio.to_thread(self.set_pref_sync, key, value)

    def all_prefs_sync(self) -> dict:
        with self._lock, self._connect() as connection:
            rows = connection.execute("SELECT key, value FROM prefs ORDER BY key").fetchall()
        return {row["key"]: row["value"] for row in rows}

    async def all_prefs(self) -> dict:
        return await asyncio.to_thread(self.all_prefs_sync)

    def get_active_selection_sync(self) -> tuple[str, str] | None:
        raw = self.get_pref_sync("provider.active")
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        provider = str(data.get("provider", "")).strip()
        model = str(data.get("model", "")).strip()
        if not provider:
            return None
        return provider, model

    async def get_active_selection(self) -> tuple[str, str] | None:
        return await asyncio.to_thread(self.get_active_selection_sync)

    # ------------------------------------------------------------------ tool log
    def log_tool_sync(self, tool: str, args: dict, ok: bool, output: str) -> None:
        safe_args = json.dumps(args, ensure_ascii=False)[:4000]
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO tool_logs(tool, args, ok, output, created_at) VALUES(?,?,?,?,?)",
                (tool, safe_args, 1 if ok else 0, output[:4000], now_iso()),
            )

    async def log_tool(self, tool: str, args: dict, ok: bool, output: str) -> None:
        await asyncio.to_thread(self.log_tool_sync, tool, args, ok, output)

    def recent_tool_logs_sync(self, limit: int = 20) -> list[dict]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT id, tool, args, ok, output, created_at FROM tool_logs ORDER BY id DESC LIMIT ?",
                (max(1, min(limit, 100)),),
            ).fetchall()
        return [dict(row) for row in rows]

    async def recent_tool_logs(self, limit: int = 20) -> list[dict]:
        return await asyncio.to_thread(self.recent_tool_logs_sync, limit)

    # -------------------------------------------------------------------- stats
    def stats_sync(self) -> dict:
        with self._lock, self._connect() as connection:
            message_count = connection.execute("SELECT COUNT(*) AS c FROM messages").fetchone()["c"]
            note_count = connection.execute("SELECT COUNT(*) AS c FROM notes").fetchone()["c"]
            tool_count = connection.execute("SELECT COUNT(*) AS c FROM tool_logs").fetchone()["c"]
            sessions = connection.execute("SELECT COUNT(DISTINCT session_id) AS c FROM messages").fetchone()["c"]
        try:
            size = self.db_path.stat().st_size
        except OSError:
            size = 0
        return {
            "messages": message_count,
            "notes": note_count,
            "tool_calls": tool_count,
            "sessions": sessions,
            "db_bytes": size,
            "db_path": str(self.db_path),
        }

    async def stats(self) -> dict:
        return await asyncio.to_thread(self.stats_sync)

    # ------------------------------------------------------------------- upkeep
    def backup_sync(self) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        target = self.db_path.parent / "backups" / f"jarvis-{stamp}.db"
        target.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, self._connect() as source:
            destination = sqlite3.connect(str(target))
            try:
                source.backup(destination)
            finally:
                destination.close()
        try:
            target.chmod(0o600)
        except OSError:
            pass
        return str(target)

    async def backup(self) -> str:
        return await asyncio.to_thread(self.backup_sync)

    def prune_sync(self, days: int) -> int:
        if days <= 0:
            return 0
        cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
        cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat(timespec="seconds")
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM messages WHERE created_at < ?", (cutoff_iso,))
            return cursor.rowcount

    async def prune(self, days: int) -> int:
        return await asyncio.to_thread(self.prune_sync, days)

    # ------------------------------------------------------------------- users
    def create_user_sync(self, username: str, email: str, password_hash: str, salt: str) -> dict:
        stamp = now_iso()
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO users(username, email, password_hash, salt, created_at, updated_at)"
                " VALUES(?,?,?,?,?,?)",
                (username.strip(), email.strip().lower(), password_hash, salt, stamp, stamp),
            )
            user_id = int(cursor.lastrowid)
            row = connection.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row)

    async def create_user(self, username: str, email: str, password_hash: str, salt: str) -> dict:
        return await asyncio.to_thread(self.create_user_sync, username, email, password_hash, salt)

    def get_user_sync(self, username_or_email: str) -> dict | None:
        target = username_or_email.strip()
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM users WHERE username = ? OR email = ?",
                (target, target.lower()),
            ).fetchone()
        return dict(row) if row else None

    async def get_user(self, username_or_email: str) -> dict | None:
        return await asyncio.to_thread(self.get_user_sync, username_or_email)

    def delete_user_sync(self, username: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM users WHERE username = ?", (username.strip(),))
            return cursor.rowcount > 0

    async def delete_user(self, username: str) -> bool:
        return await asyncio.to_thread(self.delete_user_sync, username)

    def update_password_sync(self, username: str, new_hash: str, new_salt: str) -> bool:
        stamp = now_iso()
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "UPDATE users SET password_hash = ?, salt = ?, updated_at = ? WHERE username = ?",
                (new_hash, new_salt, stamp, username.strip()),
            )
            return cursor.rowcount > 0

    async def update_password(self, username: str, new_hash: str, new_salt: str) -> bool:
        return await asyncio.to_thread(self.update_password_sync, username, new_hash, new_salt)


store = MemoryStore(settings.db_path)
