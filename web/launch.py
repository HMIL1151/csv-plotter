#!/usr/bin/env python3
"""
Launch the CSV Plotter web app from the terminal.

    python web/launch.py                 # open the app
    python web/launch.py data.csv        # open the app with data.csv loaded
    python web/launch.py data.csv --port 8000 --no-browser

Serves the web/ folder on http://127.0.0.1 (this machine only) and opens it in
your default browser.  If a CSV is given, only that one file is exposed, at
/__data/<name>, and the app loads it on start.  Press Ctrl+C to stop.

Standard library only – no installs needed.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import os
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent
DATA_PREFIX = "/__data/"


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves web/ plus (optionally) a single CSV file under /__data/."""

    csv_path: Path | None = None

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith(DATA_PREFIX):
            return self._send_csv(path)
        return super().do_GET()

    def do_HEAD(self):
        return self.do_GET()

    def _send_csv(self, path: str):
        name = urllib.parse.unquote(path[len(DATA_PREFIX):])
        if self.csv_path is None or name != self.csv_path.name:
            self.send_error(404, "Not found")
            return
        try:
            size = self.csv_path.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command == "HEAD":
                return
            with open(self.csv_path, "rb") as fh:
                while chunk := fh.read(1 << 20):
                    self.wfile.write(chunk)
        except OSError as exc:
            self.send_error(500, str(exc))

    def end_headers(self):
        # Always serve fresh app files so edits/upgrades show up on reload
        if not self.path.startswith(DATA_PREFIX):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the terminal quiet
        pass


def make_server(csv_path: str | os.PathLike | None = None, host: str = "127.0.0.1",
                port: int = 0) -> tuple[http.server.ThreadingHTTPServer, str]:
    """Create (but don't start) the server. Returns (server, app_url)."""
    csv = Path(csv_path).expanduser().resolve() if csv_path else None
    if csv is not None and not csv.is_file():
        raise FileNotFoundError(f"No such file: {csv}")
    handler = type("BoundHandler", (Handler,), {"csv_path": csv})
    server = http.server.ThreadingHTTPServer(
        (host, port), functools.partial(handler, directory=str(WEB_DIR)))
    url = f"http://{host}:{server.server_address[1]}/index.html"
    if csv is not None:
        url += "?file=" + urllib.parse.quote(DATA_PREFIX + csv.name)
    return server, url


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open the CSV Plotter web app.")
    parser.add_argument("csv", nargs="?", help="CSV file to open (optional)")
    parser.add_argument("--port", type=int, default=0, help="port to use (default: any free port)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="interface to bind (default 127.0.0.1 – this machine only)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser automatically")
    args = parser.parse_args(argv)

    try:
        server, url = make_server(args.csv, args.host, args.port)
    except (FileNotFoundError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"CSV Plotter running at {url}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
