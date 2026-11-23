#!/usr/bin/env python3
"""JARVIS AI end-to-end API test suite.

Starts the real server in a subprocess against a throwaway database, workspace
and log directory, then exercises the HTTP and WebSocket API. No external AI
network calls are made: demo mode is forced so provider tests exercise local
validation only.

Usage:
    python tests/run_tests.py
    python tests/run_tests.py --keep    # keep the temporary environment
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

PREFERRED_TMP = "/data/user/0/com.termux/files/usr/tmp/opencode"
TMP_ROOT = PREFERRED_TMP if os.path.isdir(PREFERRED_TMP) else tempfile.gettempdir()
WORK = tempfile.mkdtemp(prefix="jarvis-tests-", dir=TMP_ROOT)

# Settings are read at import time, so the environment must be prepared first.
os.environ.update(
    {
        "JARVIS_DB_PATH": os.path.join(WORK, "db", "jarvis-test.db"),
        "JARVIS_WORKSPACE": os.path.join(WORK, "workspace"),
        "JARVIS_LOG_DIR": os.path.join(WORK, "logs"),
        "JARVIS_ACCESS_TOKEN": "",
        "JARVIS_LOCAL_AUTO_UNLOCK": "0",
        "JARVIS_DEFAULT_PROVIDER": "demo",
        "JARVIS_FALLBACK_PROVIDER": "",
        "JARVIS_RATE_LIMIT": "100000",
        "JARVIS_CHAT_RATE_LIMIT": "100000",
        "JARVIS_ALLOW_PRIVATE_URLS": "0",
        "JARVIS_MEMORY_RETENTION_DAYS": "0",
        # Guarantee demo mode even if the developer has real keys in .env.
        "OPENAI_API_KEY": "",
        "GEMINI_API_KEY": "",
        "GROQ_API_KEY": "",
        "OPENROUTER_API_KEY": "",
        "OLLAMA_API_KEY": "",
        "OLLAMA_BASE_URL": "",
        "OLLAMA_MODEL": "",
        "CUSTOM_API_KEY": "",
        "CUSTOM_BASE_URL": "",
        "CUSTOM_MODEL": "",
    }
)

import httpx  # noqa: E402
from websockets.sync.client import connect as ws_connect  # noqa: E402

from backend.security.auth import RateLimiter  # noqa: E402

PASSED: list[tuple[str, int]] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append((name, 0))
        print(f"  PASS  {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def timed(name: str, func):
    started = time.monotonic()
    failures_before = len(FAILED)
    try:
        func()
    except Exception:
        FAILED.append((name, traceback.format_exc(limit=3).strip().splitlines()[-1]))
        print(f"  FAIL  {name} — unexpected exception")
        traceback.print_exc()
    else:
        elapsed = int((time.monotonic() - started) * 1000)
        if len(FAILED) == failures_before:
            PASSED.append((name, elapsed))
            print(f"  PASS  {name} ({elapsed} ms)")


def keys_in(value) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        found.update(str(k).lower() for k in value)
        for item in value.values():
            found |= keys_in(item)
    elif isinstance(value, list):
        for item in value:
            found |= keys_in(item)
    return found


def free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
    finally:
        probe.close()


@contextmanager
def running_server(access_token: str = "", *, local_auto_unlock: bool | None = None):
    """Start the real JARVIS server, yield (httpx client, port), then stop it."""
    port = free_port()
    log_path = os.path.join(WORK, "server.log")
    log_file = open(log_path, "wb")
    env = os.environ.copy()
    env["JARVIS_ACCESS_TOKEN"] = access_token
    if local_auto_unlock is not None:
        env["JARVIS_LOCAL_AUTO_UNLOCK"] = "1" if local_auto_unlock else "0"
    proc = subprocess.Popen(
        [sys.executable, "main.py", "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=20.0, follow_redirects=False)
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                if client.get("/api/health").status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("server did not become healthy within 30s")
        if proc.poll() is not None:
            log_file.flush()
            tail = open(log_path, "r", encoding="utf-8", errors="replace").read()[-3000:]
            raise RuntimeError(f"server exited during startup:\n{tail}")
        yield client, port
    finally:
        client.close()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        log_file.close()


def main() -> int:
    print("JARVIS AI test suite")
    print(f"  workspace: {WORK}")
    print()

    with running_server() as (client, ws_port):
        csrf = ""
        session_id = ""

        def session_test():
            nonlocal csrf, session_id
            response = client.get("/api/session")
            check("GET /api/session returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            csrf = body.get("csrf", "")
            session_id = body.get("session_id", "")
            check("session returns CSRF token", isinstance(csrf, str) and len(csrf) > 16)
            check("session cookie is HttpOnly", "httponly" in response.headers.get("set-cookie", "").lower())
            check("session cookie is SameSite=lax", "samesite=lax" in response.headers.get("set-cookie", "").lower())

        timed("GET /api/session creates a protected session", session_test)
        headers = {"X-Jarvis-CSRF": csrf}

        def health_test():
            response = client.get("/api/health")
            check("GET /api/health returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            check("health reports ok + healthy", body.get("ok") is True and body.get("status") == "healthy")

        timed("GET /api/health", health_test)

        def index_test():
            response = client.get("/")
            check("GET / returns the HUD", response.status_code == 200, str(response.status_code))
            check("HUD is HTML", "text/html" in response.headers.get("content-type", ""))
            text = response.text
            check("HUD contains the app shell", 'id="app"' in text and "/js/app.js" in text)
            check("HUD loads one external module", text.count("<script") == 1 and 'src="/js/app.js"' in text)

        timed("GET / serves the frontend", index_test)

        def headers_test():
            response = client.get("/api/health")
            csp = response.headers.get("content-security-policy", "")
            script_src = ""
            for directive in csp.split(";"):
                if directive.strip().startswith("script-src"):
                    script_src = directive
            check("CSP header present", "default-src 'self'" in csp)
            check("CSP blocks inline scripts", "script-src 'self'" in script_src and "unsafe-inline" not in script_src)
            check("nosniff header present", response.headers.get("x-content-type-options") == "nosniff")
            check("frame embedding denied", response.headers.get("x-frame-options") == "DENY")
            check("API responses are no-store", response.headers.get("cache-control") == "no-store")

        timed("security headers", headers_test)

        def manifest_test():
            response = client.get("/manifest.webmanifest")
            check("manifest served", response.status_code == 200 and "manifest" in response.headers.get("content-type", ""))
            check("manifest is valid JSON", isinstance(response.json(), dict))

        timed("GET /manifest.webmanifest", manifest_test)

        def csrf_test():
            response = client.post("/api/chat", json={"message": "hello"})
            check("POST without CSRF is rejected", response.status_code == 401, str(response.status_code))
            check("CSRF error code", response.json().get("error", {}).get("code") == "csrf_failed")

        timed("CSRF protection blocks unsigned writes", csrf_test)

        def origin_test():
            response = client.post(
                "/api/chat",
                json={"message": "hello"},
                headers={**headers, "Origin": "http://evil.example"},
            )
            check("cross-origin write is blocked", response.status_code == 403, str(response.status_code))
            check("origin error code", response.json().get("error", {}).get("code") == "forbidden_origin")

        timed("origin checks block cross-site writes", origin_test)

        def validation_test():
            response = client.post("/api/chat", json={"message": ""}, headers=headers)
            check("empty message rejected", response.status_code == 422, str(response.status_code))
            response = client.post("/api/chat", json={"message": "hi", "language": "xx-YY"}, headers=headers)
            check("unsupported language rejected", response.status_code == 422, str(response.status_code))

        timed("chat input validation", validation_test)

        def chat_test():
            response = client.post("/api/chat", json={"message": "hello", "language": "en-US"}, headers=headers)
            check("demo chat returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            check("chat response ok", body.get("ok") is True)
            check("demo mode is explicit", body.get("demo") is True)
            check("demo reply is labelled", "DEMO MODE" in body.get("reply", ""))
            check("provider is demo", body.get("provider") == "demo")
            check("reply has speech chunks", isinstance(body.get("speak_chunks"), list))

        timed("POST /api/chat (demo provider)", chat_test)

        def demo_math_test():
            response = client.post("/api/chat", json={"message": "calculate 2 + 2 * 3"}, headers=headers)
            body = response.json()
            check("demo arithmetic works locally", "= 8" in body.get("reply", ""), body.get("reply", "")[:80])

        timed("demo arithmetic", demo_math_test)

        def voice_test():
            response = client.post(
                "/api/voice",
                json={"transcript": "hey jarvis what time is it", "language": "en-US"},
                headers=headers,
            )
            check("voice endpoint returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            check("wake phrase detected", body.get("wake_detected") is True)
            check("wake phrase stripped", body.get("command") == "what time is it", body.get("command", ""))
            check("voice reply present", "Local device time" in body.get("reply", ""))

        timed("POST /api/voice (wake phrase)", voice_test)

        def calc_tool_test():
            response = client.post(
                "/api/tools/execute",
                json={"tool": "calculator", "args": {"expression": "(12 * 8) + sqrt(144)"}},
                headers=headers,
            )
            check("calculator tool returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            check("calculator result is correct", body.get("result", {}).get("result") == 108, json.dumps(body)[:160])

        timed("POST /api/tools/execute (calculator)", calc_tool_test)

        def unknown_tool_test():
            response = client.post(
                "/api/tools/execute", json={"tool": "nope", "args": {}}, headers=headers
            )
            check("unknown tool returns 404", response.status_code == 404, str(response.status_code))
            check("unknown tool error code", response.json().get("error", {}).get("code") == "not_found")

        timed("unknown tools are refused", unknown_tool_test)

        def invalid_tool_test():
            response = client.post(
                "/api/tools/execute",
                json={"tool": "calculator", "args": {"expression": "2+2", "extra": 1}},
                headers=headers,
            )
            check("unknown tool argument rejected", response.status_code == 422, str(response.status_code))

        timed("tool arguments are validated", invalid_tool_test)

        def create_file_test():
            response = client.post(
                "/api/tools/execute",
                json={"tool": "create_file", "args": {"path": "approval.txt", "content": "hello jarvis"}},
                headers=headers,
            )
            check("create_file works inside workspace", response.status_code == 200, str(response.status_code))
            check("file verified on disk", response.json().get("result", {}).get("verified") is True)

        timed("workspace file creation", create_file_test)

        def traversal_test():
            response = client.post(
                "/api/tools/execute",
                json={"tool": "create_file", "args": {"path": "../escape.txt", "content": "x"}},
                headers=headers,
            )
            check("path traversal blocked", response.status_code == 422, str(response.status_code))
            check("nothing escaped the workspace", not os.path.exists(os.path.join(WORK, "escape.txt")))

        timed("workspace path traversal is blocked", traversal_test)

        pending_token = ""

        def approval_request_test():
            nonlocal pending_token
            response = client.post(
                "/api/tools/execute",
                json={"tool": "delete_file", "args": {"path": "approval.txt"}},
                headers=headers,
            )
            check("delete_file asks for approval", response.status_code == 202, str(response.status_code))
            body = response.json()
            check("approval error code", body.get("error", {}).get("code") == "approval_required")
            pending_token = body.get("error", {}).get("details", {}).get("action", {}).get("token", "")
            check("approval token issued", bool(pending_token))
            check("file still exists before approval", os.path.exists(os.path.join(WORK, "workspace", "approval.txt")))

        timed("dangerous tools require approval", approval_request_test)

        def approve_test():
            response = client.post(f"/api/tools/approve/{pending_token}", headers=headers)
            check("approval executes the tool", response.status_code == 200, str(response.status_code))
            check("delete verified", response.json().get("result", {}).get("verified") is True)
            check("file is gone after approval", not os.path.exists(os.path.join(WORK, "workspace", "approval.txt")))

        timed("POST /api/tools/approve executes the action", approve_test)

        def reject_test():
            client.post(
                "/api/tools/execute",
                json={"tool": "create_file", "args": {"path": "reject.txt", "content": "keep me"}},
                headers=headers,
            )
            requested = client.post(
                "/api/tools/execute", json={"tool": "delete_file", "args": {"path": "reject.txt"}}, headers=headers
            )
            token = requested.json().get("error", {}).get("details", {}).get("action", {}).get("token", "")
            rejected = client.post(f"/api/tools/reject/{token}", headers=headers)
            check("reject endpoint returns 200", rejected.status_code == 200, str(rejected.status_code))
            check("rejected action did not delete", os.path.exists(os.path.join(WORK, "workspace", "reject.txt")))
            # Clean up through the proper flow so the suite leaves no pending action.
            again = client.post(
                "/api/tools/execute", json={"tool": "delete_file", "args": {"path": "reject.txt"}}, headers=headers
            )
            cleanup = again.json().get("error", {}).get("details", {}).get("action", {}).get("token", "")
            if cleanup:
                client.post(f"/api/tools/approve/{cleanup}", headers=headers)

        timed("rejecting an approval keeps the file", reject_test)

        note_id = 0

        def notes_test():
            nonlocal note_id
            created = client.post(
                "/api/memory/notes",
                json={"title": "Test note", "content": "Jarvis remembers this", "tags": "test,memory"},
                headers=headers,
            )
            check("note created", created.status_code == 201, str(created.status_code))
            note_id = created.json().get("note", {}).get("id", 0)
            check("note has an id", isinstance(note_id, int) and note_id > 0)

            listed = client.get("/api/memory/notes?q=Test")
            titles = [note["title"] for note in listed.json().get("notes", [])]
            check("note search finds it", "Test note" in titles)

            updated = client.patch(
                f"/api/memory/notes/{note_id}", json={"tags": "updated"}, headers=headers
            )
            check("note update works", updated.status_code == 200, str(updated.status_code))
            check("note tags updated", updated.json().get("note", {}).get("tags") == "updated")

            deleted = client.delete(f"/api/memory/notes/{note_id}", headers=headers)
            check("note delete works", deleted.status_code == 200, str(deleted.status_code))
            missing = client.delete(f"/api/memory/notes/{note_id}", headers=headers)
            check("deleting a missing note returns 404", missing.status_code == 404, str(missing.status_code))

        timed("notes create/search/update/delete", notes_test)

        def pref_test():
            response = client.post(
                "/api/memory", json={"type": "pref", "key": "theme", "value": "cyan"}, headers=headers
            )
            check("preference stored", response.status_code == 201, str(response.status_code))
            check("preference namespaced", response.json().get("stored") == "user.theme")

        timed("preferences are stored server-side", pref_test)

        def memory_search_test():
            response = client.get("/api/memory?q=hello")
            check("memory search returns 200", response.status_code == 200, str(response.status_code))
            messages = response.json().get("messages", [])
            check("chat history is searchable", any("hello" in row.get("content", "").lower() for row in messages))
            stats = response.json().get("stats", {})
            check("memory stats count messages", stats.get("messages", 0) >= 2, str(stats))

        timed("GET /api/memory search", memory_search_test)

        def messages_test():
            listed = client.get("/api/memory/messages?limit=10")
            check("messages list works", listed.status_code == 200 and len(listed.json().get("messages", [])) > 0)
            refused = client.delete("/api/memory/messages", headers=headers)
            check("clearing messages needs confirmation", refused.status_code == 422, str(refused.status_code))

        timed("conversation history endpoints", messages_test)

        def backup_test():
            response = client.post("/api/memory/backup", headers=headers)
            check("backup returns 200", response.status_code == 200, str(response.status_code))
            path = response.json().get("backup", "")
            check("backup file exists", bool(path) and os.path.isfile(path), path)
            check("backup is non-empty", response.json().get("bytes", 0) > 0)

        timed("SQLite backup", backup_test)

        def export_test():
            response = client.get("/api/memory/export?limit=50")
            check("export returns 200", response.status_code == 200, str(response.status_code))
            check("export is an attachment", "attachment" in response.headers.get("content-disposition", ""))
            body = response.json()
            check("export contains messages and notes", isinstance(body.get("messages"), list) and isinstance(body.get("notes"), list))

        timed("memory export JSON", export_test)

        def vision_test():
            status = client.get("/api/vision/status")
            check("vision status works", status.status_code == 200 and status.json().get("available") is False)
            image = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"jarvis").decode("ascii")
            response = client.post(
                "/api/vision/analyze",
                json={"image": f"data:image/png;base64,{image}", "prompt": "describe"},
                headers=headers,
            )
            check("vision refuses without a vision provider", response.status_code == 501, str(response.status_code))
            check("vision limitation is structured", response.json().get("error", {}).get("code") == "not_supported")

        timed("vision limitation is explicit (501)", vision_test)

        def automation_test():
            status = client.get("/api/automation/status")
            check("automation status works", status.status_code == 200, str(status.status_code))
            check("Playwright reported unavailable", status.json().get("playwright", {}).get("available") is False)
            blocked = client.post(
                "/api/automation/fetch", json={"url": "http://127.0.0.1:8000/api/health"}, headers=headers
            )
            check("SSRF to loopback is blocked", blocked.status_code == 422, str(blocked.status_code))
            check("SSRF error explains the block", "Private" in blocked.text or "blocked" in blocked.text)
            screenshot = client.post(
                "/api/automation/screenshot", json={"url": "https://example.com"}, headers=headers
            )
            check("screenshots fail honestly without Playwright", screenshot.status_code == 501, str(screenshot.status_code))

        timed("automation status + SSRF guard", automation_test)

        def providers_test():
            response = client.get("/api/providers")
            check("providers list returns 200", response.status_code == 200, str(response.status_code))
            body = response.json()
            ids = [item["id"] for item in body.get("providers", [])]
            check("demo provider listed", "demo" in ids)
            check("demo is active", body.get("active", {}).get("demo") is True)
            check("no api_key field is exposed", "api_key" not in keys_in(body))
            check("env key names are not exposed", "OPENAI_API_KEY" not in json.dumps(body))

        timed("GET /api/providers hides secrets", providers_test)

        def provider_tests():
            demo = client.post("/api/providers/test", json={"provider": "demo"}, headers=headers)
            check("demo provider test passes", demo.status_code == 200 and demo.json().get("test", {}).get("ok") is True)
            openai = client.post("/api/providers/test", json={"provider": "openai"}, headers=headers)
            body = openai.json()
            check("unconfigured provider test returns ok:false", openai.status_code == 200 and body.get("test", {}).get("ok") is False)
            error = str(body.get("test", {}).get("error", "")).lower()
            check("unconfigured provider error explains the missing key", "key" in error, error[:120])
            select = client.post("/api/providers/select", json={"provider": "openai"}, headers=headers)
            check("selecting an unconfigured provider is refused", select.status_code == 422, str(select.status_code))

        timed("provider test + selection guards", provider_tests)

        def config_test():
            response = client.get("/api/config")
            check("config endpoint works", response.status_code == 200 and response.json().get("config", {}).get("app") == "JARVIS AI")
            check("config exposes no API key", "api_key" not in keys_in(response.json()))

        timed("GET /api/config", config_test)

        def status_test():
            response = client.get("/api/status")
            check("status endpoint works", response.status_code == 200, str(response.status_code))
            body = response.json()
            check("status includes provider + memory", "provider" in body and "memory" in body)
            check("status warns about missing access token", any("access" in warning.lower() for warning in body.get("warnings", [])))
            check("status includes LAN URLs", isinstance(body.get("urls"), list) and len(body["urls"]) >= 1)

        timed("GET /api/status", status_test)

        def audit_test():
            response = client.get("/api/audit?limit=20")
            check("audit endpoint works", response.status_code == 200, str(response.status_code))
            actions = [entry.get("action") for entry in response.json().get("entries", [])]
            check("audit recorded chat activity", "chat.respond" in actions, str(actions[-4:]))

        timed("GET /api/audit", audit_test)

        def not_found_test():
            response = client.get("/api/definitely-not-a-route")
            check("unknown API route returns 404 JSON", response.status_code == 404, str(response.status_code))
            check("unknown route error code", response.json().get("error", {}).get("code") == "not_found")

        timed("unknown API routes return JSON 404", not_found_test)

        def websocket_test():
            with ws_connect(f"ws://127.0.0.1:{ws_port}/ws", open_timeout=5) as websocket:
                raw = websocket.recv(timeout=5)
                message = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
                check("WebSocket sends hello", message.get("type") == "hello", str(message.get("type")))
                check("hello carries runtime state", isinstance(message.get("data", {}).get("runtime"), dict))
                check("hello version present", bool(message.get("data", {}).get("version")))

        timed("WebSocket /ws hello", websocket_test)

        def clear_test():
            removed = client.delete("/api/memory/messages?confirm=yes", headers=headers)
            check("confirmed clear works", removed.status_code == 200, str(removed.status_code))
            check("messages were removed", removed.json().get("removed", 0) >= 1)
            after = client.get("/api/memory/messages?limit=5")
            check("history is empty after clear", after.json().get("messages") == [])

        timed("DELETE /api/memory/messages?confirm=yes", clear_test)

    # Access-token protection is verified on a second isolated server.
    def access_token_test():
        token = "test-token-1234567890"
        with running_server(access_token=token) as (secure, secure_port):
            check("health stays public with a token", secure.get("/api/health").status_code == 200)
            handshake = secure.get("/api/session")
            body = handshake.json()
            csrf = body.get("csrf", "")
            check("session handshake stays public with a token", handshake.status_code == 200, str(handshake.status_code))
            check("handshake reports auth_required", body.get("auth_required") is True)
            check("handshake reports locked", body.get("unlocked") is False)
            locked = secure.get("/api/status")
            check("status is locked without a token", locked.status_code == 401, str(locked.status_code))
            check("lock error code is auth_required", locked.json().get("error", {}).get("code") == "auth_required")
            blocked_ws = False
            try:
                with ws_connect(f"ws://127.0.0.1:{secure_port}/ws", open_timeout=3):
                    pass
            except Exception:
                blocked_ws = True
            check("WebSocket rejects missing tokens", blocked_ws)

            no_csrf = secure.post("/api/unlock", json={"token": token})
            check("unlock requires CSRF", no_csrf.status_code == 401, str(no_csrf.status_code))
            check("unlock CSRF error code", no_csrf.json().get("error", {}).get("code") == "csrf_failed")
            bad = secure.post("/api/unlock", json={"token": "wrong-token"}, headers={"X-Jarvis-CSRF": csrf})
            check("wrong access token is rejected", bad.status_code == 401, str(bad.status_code))

            good = secure.post("/api/unlock", json={"token": token}, headers={"X-Jarvis-CSRF": csrf})
            check("correct access token unlocks", good.status_code == 200, str(good.status_code))
            payload = good.json()
            new_csrf = payload.get("csrf", "")
            new_sid = payload.get("session_id", "")
            grant = good.cookies.get("jarvis_unlock")
            set_cookie = "; ".join(good.headers.get_list("set-cookie"))
            check("login returns a fresh session", bool(new_csrf) and bool(new_sid))
            check("browser receives an opaque grant cookie", bool(grant))
            check("raw token is never set as a cookie", token not in set_cookie, set_cookie[:150])
            check("raw token is not echoed in the login response", token not in json.dumps(payload))

            old_csrf = secure.post("/api/chat", json={"message": "hello"}, headers={"X-Jarvis-CSRF": csrf})
            check("old CSRF is invalid after rotation", old_csrf.status_code == 401, str(old_csrf.status_code))
            session_after = secure.get("/api/session")
            check("session works after unlock", session_after.status_code == 200, str(session_after.status_code))
            check("handshake reports unlocked", session_after.json().get("unlocked") is True)
            check("CSRF rotates to the returned value", session_after.json().get("csrf") == new_csrf)
            status_after = secure.get("/api/status")
            check("status works after unlock", status_after.status_code == 200, str(status_after.status_code))
            check("status reports access protection", status_after.json().get("security", {}).get("access_token") is True)
            check("status reports unlocked state", status_after.json().get("security", {}).get("unlocked") is True)
            unsigned = secure.post("/api/chat", json={"message": "hello"})
            check("CSRF still required after unlock", unsigned.status_code == 401, str(unsigned.status_code))
            sent = secure.post(
                "/api/chat", json={"message": "hello"}, headers={"X-Jarvis-CSRF": new_csrf}
            )
            check("chat works with the rotated CSRF", sent.status_code == 200, str(sent.status_code))

            cookie_header = f"jarvis_session={new_sid}; jarvis_unlock={grant}"
            with ws_connect(
                f"ws://127.0.0.1:{secure_port}/ws",
                additional_headers={"Cookie": cookie_header},
                open_timeout=3,
            ) as websocket:
                raw = websocket.recv(timeout=5)
                hello = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
                check("WebSocket accepts browser login cookies", hello.get("type") == "hello")
            with ws_connect(
                f"ws://127.0.0.1:{secure_port}/ws",
                additional_headers={"X-Jarvis-Token": token},
                open_timeout=3,
            ) as websocket:
                raw = websocket.recv(timeout=5)
                hello = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
                check("WebSocket accepts an API token header", hello.get("type") == "hello")
            query_rejected = False
            try:
                with ws_connect(f"ws://127.0.0.1:{secure_port}/ws?token={token}", open_timeout=3):
                    pass
            except Exception:
                query_rejected = True
            check("tokens in URLs are rejected", query_rejected)

            page = secure.get("/")
            assets = [page.text]
            for asset in ("/js/api.js", "/js/app.js", "/js/panels.js", "/index.html"):
                assets.append(secure.get(asset).text)
            check("token is absent from HTML and frontend JS", all(token not in item for item in assets))

            with open(os.path.join(WORK, "server.log"), encoding="utf-8", errors="replace") as handle:
                server_log = handle.read()
            check("token is absent from server logs", token not in server_log)

            signed_out = secure.post("/api/logout", headers={"X-Jarvis-CSRF": new_csrf})
            check("logout works", signed_out.status_code == 200, str(signed_out.status_code))
            locked_again = secure.get("/api/status")
            check("logout revokes access", locked_again.status_code == 401, str(locked_again.status_code))
            revoked_ws = False
            try:
                with ws_connect(
                    f"ws://127.0.0.1:{secure_port}/ws",
                    additional_headers={"Cookie": cookie_header},
                    open_timeout=3,
                ):
                    pass
            except Exception:
                revoked_ws = True
            check("logout revokes the WebSocket grant", revoked_ws)

    timed("access token: login, cookies, CSRF, WebSocket, logout", access_token_test)

    def local_console_test():
        token = "local-console-token-1234567890"
        with running_server(access_token=token, local_auto_unlock=True) as (local, local_port):
            handshake = local.get("/api/session")
            body = handshake.json()
            check("localhost handshake is unlocked", body.get("unlocked") is True)
            check("localhost status works without a grant", local.get("/api/status").status_code == 200)
            check("no unlock cookie is issued on localhost", "jarvis_unlock" not in local.cookies)
            with ws_connect(f"ws://127.0.0.1:{local_port}/ws", open_timeout=3) as websocket:
                raw = websocket.recv(timeout=5)
                hello = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
            check("localhost WebSocket works without a token", hello.get("type") == "hello")

    timed("local console auto-unlock", local_console_test)

    def token_bootstrap_test():
        import config

        temp_env = os.path.join(WORK, "token-bootstrap")
        os.makedirs(temp_env, exist_ok=True)
        env_file = os.path.join(temp_env, ".env")
        previous_env = os.environ.get("JARVIS_ACCESS_TOKEN")
        previous_explicit = set(config._EXPLICIT_ENV_KEYS)

        class Stub:
            access_token = ""
            token_fingerprint = ""

        try:
            os.environ.pop("JARVIS_ACCESS_TOKEN", None)
            config._EXPLICIT_ENV_KEYS.discard("JARVIS_ACCESS_TOKEN")
            generated = config.ensure_access_token(Stub(), path=env_file)
            check("missing token is generated", bool(generated) and len(generated) >= 43, str(generated)[:8])
            check("generated token is persisted to .env", generated in open(env_file, encoding="utf-8").read())
            check("token file mode is 0600", (os.stat(env_file).st_mode & 0o777) == 0o600)
            loaded = Stub()
            loaded.access_token = generated
            restored = config.ensure_access_token(loaded, path=env_file)
            check("existing token is reused, not replaced", restored == generated)
            check("fingerprint is derived from the token", loaded.token_fingerprint == config.token_fingerprint(generated))
        finally:
            if previous_env is None:
                os.environ.pop("JARVIS_ACCESS_TOKEN", None)
            else:
                os.environ["JARVIS_ACCESS_TOKEN"] = previous_env
            config._EXPLICIT_ENV_KEYS.clear()
            config._EXPLICIT_ENV_KEYS.update(previous_explicit)

    timed("access token bootstrap (generate + persist)", token_bootstrap_test)

    # Pure unit checks that do not need the HTTP app.
    def limiter_test():
        limiter = RateLimiter()
        first = limiter.hit("1.2.3.4", "test", 2)
        second = limiter.hit("1.2.3.4", "test", 2)
        third = limiter.hit("1.2.3.4", "test", 2)
        check("rate limiter allows the quota", first[0] is True and second[0] is True)
        check("rate limiter blocks overage", third[0] is False)
        check("rate limiter reports retry window", third[1] >= 1)

    timed("rate limiter unit behaviour", limiter_test)

    print()
    total = len(PASSED) + len(FAILED)
    if FAILED:
        print(f"RESULT: {len(PASSED)} passed, {len(FAILED)} failed, {total} checks")
        for name, detail in FAILED:
            print(f"  - {name}: {detail}")
        return 1
    print(f"RESULT: all {len(PASSED)} checks passed.")
    print(f"Temporary environment: {WORK}")
    return 0


if __name__ == "__main__":
    keep = "--keep" in sys.argv[1:]
    try:
        code = main()
    except Exception:
        traceback.print_exc()
        code = 2
    finally:
        if not keep:
            shutil.rmtree(WORK, ignore_errors=True)
    raise SystemExit(code)
