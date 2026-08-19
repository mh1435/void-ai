#!/usr/bin/env python3
"""Loop — a self-hosted Instagram client.

Run it anywhere Instagram is reachable; open it from anywhere it is not.

    python3 server.py            # http://localhost:8080

Configuration is entirely environment variables — see loop/config.py.
"""

import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from loop import __version__, app, config
from loop.sessions import store

MAX_BODY = 4 * 1024 * 1024  # nothing we accept is remotely this big


class Handler(BaseHTTPRequestHandler):
    server_version = f"loop/{__version__}"
    protocol_version = "HTTP/1.1"

    # -- plumbing -----------------------------------------------------------
    def _cookies(self):
        jar = {}
        for part in (self.headers.get("Cookie") or "").split(";"):
            part = part.strip()
            if "=" in part:
                name, _, value = part.partition("=")
                jar[name.strip()] = value.strip()
        return jar

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return b""
        if length <= 0:
            return b""
        if length > MAX_BODY:
            return b""
        return self.rfile.read(length)

    def _dispatch(self, method, send_body=True):
        try:
            result = app.handle(
                method,
                self.path,
                self._body(),
                self._cookies(),
                {k.lower(): v for k, v in self.headers.items()},
            )
        except Exception as exc:  # noqa: BLE001
            result = app.error_result(f"Server error: {exc}", "server", 500)

        try:
            self.send_response(result.status)
            headers = dict(result.headers)
            headers.setdefault("Content-Length", str(len(result.body)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            if send_body and result.body:
                self.wfile.write(result.body)
        except (BrokenPipeError, ConnectionResetError):
            # Scrolling a feed cancels in-flight image requests constantly.
            pass

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET", send_body=False)

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def log_message(self, fmt, *args):
        if config.DEBUG:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _sweeper():
    while True:
        time.sleep(3600)
        try:
            store.sweep()
        except Exception:  # noqa: BLE001
            pass


def main():
    if not config.ACCESS_CODE:
        print(
            "! ACCESS_CODE is not set: anyone who finds this URL can use this\n"
            "  server to talk to Instagram. Set ACCESS_CODE to lock it down.",
            file=sys.stderr,
        )
    if config.UPSTREAM_PROXY:
        print("→ routing Instagram traffic through the configured upstream proxy")

    threading.Thread(target=_sweeper, daemon=True).start()

    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    server.daemon_threads = True
    print(f"Loop {__version__} listening on http://{config.HOST}:{config.PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        server.shutdown()


if __name__ == "__main__":
    main()
