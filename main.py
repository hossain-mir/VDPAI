#!/usr/bin/env python3
"""JARVIS AI launcher.

Usage:
    python main.py                 # http://127.0.0.1:8000 + LAN access
    python main.py --open          # also open the phone browser
    python main.py --port 8080
    python main.py --host 127.0.0.1
"""

from __future__ import annotations

import argparse
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
from logging.handlers import RotatingFileHandler

from config import BASE_DIR, ensure_access_token, settings

BANNER = r"""
   ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
   ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
   ██║███████║██████╔╝██║   ██║██║███████╗
██ ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
"""


def configure_logging(debug: bool) -> None:
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = logging.Formatter("%(asctime)s | %(levelname)-7s | %(name)s | %(message)s")
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(formatter)
    root.addHandler(stream)

    file_handler = RotatingFileHandler(
        settings.log_dir / "jarvis.log", maxBytes=1_500_000, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)


def port_available(host: str, port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def open_browser(url: str) -> None:
    """Open the URL on Android; fall back gracefully on other systems."""
    if shutil.which("am") and "ANDROID_ROOT" in os.environ:
        try:
            subprocess.Popen(
                ["am", "start", "-a", "android.intent.action.VIEW", "-d", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return
        except OSError:
            pass
    if platform.system() == "Linux" and shutil.which("xdg-open"):
        try:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            pass
    print(f"Open this URL manually: {url}")


def print_banner(host: str, port: int) -> None:
    print(BANNER)
    print(f"  JARVIS AI v{settings.version} · Android browser host")
    print("  " + "-" * 58)
    print(f"  Local          http://127.0.0.1:{port}")
    for url in settings.lan_urls():
        if "127.0.0.1" in url:
            continue
        print(f"  Same Wi-Fi     {url}")
    print("  " + "-" * 58)
    print(f"  Bind address   {host}:{port}")
    print(f"  Database       {settings.db_path}")
    print(f"  Workspace      {settings.workspace_dir}")
    print(f"  Provider       {settings.default_provider} (auto = first configured)")
    if settings.access_token:
        print("  Access token   enabled (public tunnel ready)")
    else:
        print("  Access token   disabled — local network only, do not tunnel publicly")
    if host not in {"0.0.0.0", "::"}:
        print("  Note           bound to loopback only; LAN devices cannot connect")
    print("  " + "-" * 58)
    print("  Press Ctrl+C to stop.")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the JARVIS AI server")
    parser.add_argument("--host", default=settings.host, help="bind address (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=settings.port, help="port (default 8000)")
    parser.add_argument("--debug", action="store_true", help="verbose logging")
    parser.add_argument("--open", action="store_true", help="open the browser after start")
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes (development)")
    args = parser.parse_args()

    configure_logging(args.debug)
    logger = logging.getLogger("jarvis.main")

    if not (0 < args.port < 65536):
        print("Port must be between 1 and 65535.", file=sys.stderr)
        return 2
    if not port_available(args.host if args.host != "::" else "0.0.0.0", args.port):
        print(
            f"Port {args.port} is already in use. Stop the other process "
            f"(bash scripts/stop.sh) or use --port {args.port + 1}.",
            file=sys.stderr,
        )
        return 2
    if args.port < 1024 and os.geteuid() != 0:
        print("Ports below 1024 need root on Android. Choose a port >= 1024.", file=sys.stderr)
        return 2

    for warning in settings.warnings:
        logger.warning(warning)

    had_token = bool(settings.access_token)
    ensure_access_token()
    if not had_token and settings.access_token:
        # Log the event, never the secret itself.
        logger.info("Access token generated and saved to .env (mode 0600).")

    print_banner(args.host, args.port)
    if args.open:
        open_browser(f"http://127.0.0.1:{args.port}")

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is missing. Run: bash scripts/install.sh", file=sys.stderr)
        return 3

    try:
        uvicorn.run(
            "backend.app:app",
            host=args.host,
            port=args.port,
            # WARNING by default: uvicorn logs full WebSocket URLs (including
            # query strings) at INFO, which could leak a token passed in a URL.
            log_level="debug" if args.debug else "warning",
            access_log=args.debug,
            reload=args.reload,
            reload_dirs=[str(BASE_DIR)] if args.reload else None,
            workers=1,
            timeout_keep_alive=30,
        )
    except KeyboardInterrupt:
        print("\nJARVIS offline.")
    except OSError as exc:
        print(f"Server failed to start: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
