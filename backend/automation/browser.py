"""Browser automation engine.

Two tiers:
1. Always available: HTTP fetch + readable text/link extraction + web search
   (``httpx`` only, no browser binary required).
2. Optional: Playwright-driven navigation and screenshots, only when the
   Android/Termux image actually provides Playwright + a Chromium build.
   Availability is detected at runtime and reported honestly.
"""

from __future__ import annotations

import asyncio
import importlib.util
import re
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, urljoin, urlsplit, unquote

import httpx

from config import settings
from backend.core.errors import ToolError, UnsupportedError, ValidationError
from backend.security.sanitize import validate_url

USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 14; Termux) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 JARVIS/1.0"
)
MAX_HTML_BYTES = 3 * 1024 * 1024
BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section",
    "article", "header", "footer", "main", "aside", "h1", "h2", "h3", "h4",
    "h5", "h6", "blockquote", "pre", "form", "nav",
}
SKIP_TAGS = {"script", "style", "noscript", "svg", "template", "iframe", "canvas"}


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._skip = 0
        self._in_title = False
        self._link: list | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: (value or "") for key, value in attrs}
        if tag == "title":
            self._in_title = True
        if tag in SKIP_TAGS:
            self._skip += 1
        if self._skip:
            return
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")
        if tag == "a" and attributes.get("href"):
            self._link = [attributes["href"], []]

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in SKIP_TAGS and self._skip > 0:
            self._skip -= 1
            return
        if self._skip:
            return
        if tag == "a" and self._link is not None:
            href, chunks = self._link
            text = re.sub(r"\s+", " ", " ".join(chunks)).strip()
            self.links.append((href, text[:160]))
            self._link = None
        if tag in BLOCK_TAGS:
            self.text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data.strip())
            return
        if self._skip:
            return
        text = re.sub(r"\s+", " ", data).strip()
        if not text:
            return
        self.text_parts.append(text + " ")
        if self._link is not None:
            self._link[1].append(text)

    # ----------------------------------------------------------------- helpers
    def title(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.title_parts)).strip()[:300]

    def text(self) -> str:
        raw = "".join(self.text_parts)
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.splitlines()]
        return "\n".join(line for line in lines if line)


class _SearchParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict] = []
        self._capture: str | None = None
        self._buffer: list[str] = []
        self._href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: (value or "") for key, value in attrs}
        classes = attributes.get("class", "")
        if tag == "a" and "result__a" in classes:
            self._capture = "title"
            self._buffer = []
            self._href = attributes.get("href", "")
        elif tag in {"a", "div", "span"} and "result__snippet" in classes:
            self._capture = "snippet"
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if not self._capture:
            return
        if self._capture == "title" and tag == "a":
            title = re.sub(r"\s+", " ", " ".join(self._buffer)).strip()
            self.results.append({"title": title[:200], "url": self._href, "snippet": ""})
            self._capture = None
        elif self._capture == "snippet" and tag in {"a", "div", "span"}:
            snippet = re.sub(r"\s+", " ", " ".join(self._buffer)).strip()
            if self.results and not self.results[-1]["snippet"]:
                self.results[-1]["snippet"] = snippet[:280]
            self._capture = None


def _normalise_href(base: str, href: str) -> str:
    href = (href or "").strip()
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:", "data:")):
        return ""
    if href.startswith("//"):
        href = "https:" + href
    elif href.startswith("/") and base:
        href = urljoin(base, href)
    elif not urlsplit(href).scheme and base:
        href = urljoin(base, href)
    if "duckduckgo.com/l/" in href and "uddg=" in href:
        try:
            target = parse_qs(urlsplit(href).query).get("uddg", [""])[0]
            if target:
                href = unquote(target)
        except ValueError:
            pass
    if not href.startswith(("http://", "https://")):
        return ""
    return href


def playwright_status() -> dict:
    available = importlib.util.find_spec("playwright") is not None
    chromium_hint = ""
    if available:
        chromium_hint = "Playwright package detected. Chromium must also be installed (`playwright install chromium`)."
    return {
        "available": available,
        "note": chromium_hint or (
            "Playwright is not installed. HTTP extraction and web search work without it; "
            "screenshots and form automation stay disabled."
        ),
    }


async def fetch_page(url: str, *, max_chars: int = 6000, timeout: float = 18.0) -> dict:
    target = validate_url(url)
    started = time.monotonic()
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"}
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout, headers=headers) as client:
            current = target
            response = None
            for _hop in range(6):
                # Re-validate every hop: a public URL must not redirect into the
                # phone's private network (SSRF via redirect).
                current = validate_url(current)
                response = await client.get(current)
                if not response.is_redirect:
                    break
                location = response.headers.get("location")
                if not location:
                    break
                current = urljoin(str(response.url), location)
            else:
                raise ToolError("Too many redirects while fetching the page.")
    except httpx.TimeoutException:
        raise ToolError(f"Timed out after {int(timeout)}s while fetching {target}.") from None
    except httpx.HTTPError as exc:
        raise ToolError(f"Could not reach {target}: {type(exc).__name__}.") from None
    if response is None:
        raise ToolError("The page could not be fetched.")

    content_type = (response.headers.get("content-type") or "").lower()
    if not any(kind in content_type for kind in ("text/html", "text/plain", "application/xhtml", "application/json", "text/xml")):
        raise ToolError(f"Unsupported content type: {content_type or 'unknown'}. Only text pages can be read.")

    body = response.content[:MAX_HTML_BYTES]
    encoding = response.encoding or "utf-8"
    try:
        html = body.decode(encoding, errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")

    parser = _PageParser()
    parser.feed(html)
    parser.close()

    text = parser.text()
    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars].rsplit(" ", 1)[0] + " …"

    links = []
    seen = set()
    for href, label in parser.links:
        resolved = _normalise_href(str(response.url), href)
        if resolved and resolved not in seen:
            seen.add(resolved)
            links.append({"url": resolved, "label": label or resolved[:60]})
        if len(links) >= 20:
            break

    return {
        "url": str(response.url),
        "requested_url": target,
        "status": response.status_code,
        "ok": 200 <= response.status_code < 400,
        "content_type": content_type.split(";")[0] or "unknown",
        "title": parser.title() or target,
        "text": text,
        "truncated": truncated,
        "links": links,
        "bytes": len(body),
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "engine": "httpx+html.parser",
    }


async def web_search(query: str, *, max_results: int = 5, timeout: float = 15.0) -> dict:
    query = (query or "").strip()
    if not query:
        raise ValidationError("Search query must not be empty.")
    if len(query) > 300:
        raise ValidationError("Search query is too long.")
    headers = {"User-Agent": USER_AGENT}
    results: list[dict] = []
    errors: list[str] = []
    for endpoint in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, headers=headers) as client:
                response = await client.get(endpoint, params={"q": query})
            if response.status_code >= 400:
                errors.append(f"{urlsplit(endpoint).hostname}: HTTP {response.status_code}")
                continue
            parser = _SearchParser()
            parser.feed(response.text)
            parser.close()
            for item in parser.results:
                url = _normalise_href(str(response.url), item["url"])
                if not url or not item["title"]:
                    continue
                if "duckduckgo.com" in urlsplit(url).hostname.replace("www.", ""):
                    continue
                results.append({"title": item["title"], "url": url, "snippet": item["snippet"]})
                if len(results) >= max_results:
                    break
            if results:
                break
        except httpx.HTTPError as exc:
            errors.append(f"{urlsplit(endpoint).hostname}: {type(exc).__name__}")
            continue

    if not results:
        fallback = [
            {"title": f"Search '{query}' on DuckDuckGo", "url": f"https://duckduckgo.com/?q={quote_plus(query)}", "snippet": "Search page (no server-side results extracted)."},
            {"title": f"Search '{query}' on Google", "url": f"https://www.google.com/search?q={quote_plus(query)}", "snippet": "Search page (no server-side results extracted)."},
        ]
        return {
            "query": query,
            "results": [],
            "count": 0,
            "ok": False,
            "errors": errors,
            "fallback_links": fallback,
            "note": "Server-side search could not extract results; open a fallback link in the browser.",
        }
    return {"query": query, "results": results, "count": len(results), "ok": True, "errors": errors}


async def screenshot(url: str, *, full_page: bool = False, timeout: float = 45.0) -> dict:
    target = validate_url(url)
    status = playwright_status()
    if not status["available"]:
        raise UnsupportedError(
            "Screenshot capture needs Playwright with a Chromium build, which is not installed here. "
            "Use text extraction (/api/automation/fetch) or open the page in your browser instead.",
            details={"playwright": status},
        )
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except ImportError:
        raise UnsupportedError("Playwright import failed on this platform.", details={"playwright": status}) from None

    stamp = int(time.time())
    filename = f"uploads/screenshot-{stamp}.png"
    target_path = settings.workspace_dir / filename
    try:
        async with async_playwright() as runtime:
            browser = await runtime.chromium.launch(headless=True, args=["--no-sandbox"])
            try:
                page = await browser.new_page(viewport={"width": 1280, "height": 900})
                await page.goto(target, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                await page.screenshot(path=str(target_path), full_page=full_page)
                title = await page.title()
            finally:
                await browser.close()
    except Exception as exc:  # Playwright raises a family of errors
        raise ToolError(
            "Playwright is installed but the browser failed to launch. "
            f"Reason: {type(exc).__name__}. Install Chromium with `playwright install chromium`.",
            details={"playwright": status},
        ) from None

    return {
        "url": target,
        "title": title,
        "file": filename,
        "bytes": target_path.stat().st_size if target_path.exists() else 0,
        "engine": "playwright/chromium",
        "verified": target_path.exists(),
    }


async def browser_actions(url: str, actions: list[dict], *, timeout: float = 45.0) -> dict:
    """Run a bounded Playwright action list (goto/click/fill/wait/screenshot/extract)."""
    target = validate_url(url)
    status = playwright_status()
    if not status["available"]:
        raise UnsupportedError(
            "Interactive browser automation needs Playwright + Chromium, which is unavailable here. "
            "Use HTTP extraction, or open the site manually in the browser.",
            details={"playwright": status},
        )
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except ImportError:
        raise UnsupportedError("Playwright import failed on this platform.") from None

    log: list[dict] = []
    screenshot_file = None
    extracted = ""
    try:
        async with async_playwright() as runtime:
            browser = await runtime.chromium.launch(headless=True, args=["--no-sandbox"])
            try:
                page = await browser.new_page(viewport={"width": 1280, "height": 900})
                await page.goto(target, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                for action in actions[:8]:
                    kind = action.get("type")
                    if kind == "click":
                        await page.click(action["selector"], timeout=8000)
                        log.append({"type": kind, "selector": action["selector"], "ok": True})
                    elif kind == "fill":
                        await page.fill(action["selector"], action.get("value", ""), timeout=8000)
                        log.append({"type": kind, "selector": action["selector"], "ok": True})
                    elif kind == "wait":
                        await page.wait_for_timeout(min(int(action.get("ms", 1000)), 5000))
                        log.append({"type": kind, "ms": action.get("ms", 1000), "ok": True})
                    elif kind == "extract":
                        extracted = (await page.inner_text("body"))[:6000]
                        log.append({"type": kind, "chars": len(extracted), "ok": True})
                    elif kind == "screenshot":
                        filename = f"uploads/browser-{int(time.time())}.png"
                        await page.screenshot(path=str(settings.workspace_dir / filename), full_page=bool(action.get("full_page")))
                        screenshot_file = filename
                        log.append({"type": kind, "file": filename, "ok": True})
                    else:
                        log.append({"type": str(kind), "ok": False, "error": "unsupported action"})
            finally:
                await browser.close()
    except Exception as exc:
        raise ToolError(f"Browser action failed: {type(exc).__name__}.") from None

    return {
        "url": target,
        "actions": log,
        "extracted_text": extracted,
        "screenshot": screenshot_file,
        "engine": "playwright/chromium",
    }


async def probe_network(timeout: float = 4.0) -> dict:
    """Lightweight connectivity probe used by the status endpoint."""
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.head("https://www.google.com/generate_204")
        return {
            "online": response.status_code < 500,
            "status": response.status_code,
            "latency_ms": int((time.monotonic() - started) * 1000),
        }
    except httpx.HTTPError as exc:
        return {"online": False, "status": 0, "latency_ms": int((time.monotonic() - started) * 1000), "error": type(exc).__name__}


browser = {
    "fetch_page": fetch_page,
    "web_search": web_search,
    "screenshot": screenshot,
    "browser_actions": browser_actions,
    "playwright_status": playwright_status,
    "probe_network": probe_network,
}

# Exported for tools that only need parsing helpers.
__all__ = [
    "browser", "fetch_page", "web_search", "screenshot", "browser_actions",
    "playwright_status", "probe_network", "_PageParser", "asyncio",
]
