#!/usr/bin/env python3
"""Loop — a self-hosted Instagram client.

Run it anywhere Instagram is reachable; open it from anywhere it is not.

    python3 server.py            # http://localhost:8080

Configuration is entirely environment variables — see loop/config.py.
"""

import socket
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


def lan_address():
    """This machine's address on the local network, for the phone to point at.

    Opening a UDP socket toward a routable address makes the OS pick the
    interface it would actually use. Nothing is sent.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def main():
    threading.Thread(target=_sweeper, daemon=True).start()

    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    server.daemon_threads = True

    # Printing the bind address alone is how people end up typing 0.0.0.0 into
    # the app, which is not somewhere a phone can connect to. Print what to use.
    print(f"Loop {__version__} is running.\n")
    print(f"  On this machine   http://localhost:{config.PORT}")

    # Only advertise the network address when actually listening on it.
    # Bound to loopback, that line would send someone to an address that
    # refuses the connection.
    if config.HOST not in ("127.0.0.1", "localhost", "::1"):
        lan = lan_address()
        if lan:
            print(f"  On your network   http://{lan}:{config.PORT}   <- enter this in the app")
            print("\n  Anyone on this network can reach it. Set ACCESS_CODE, or run")
            print("  with HOST=127.0.0.1 if the app is on this same machine.")
    else:
        print("\n  Listening on this machine only - nothing else can reach it.")
    print()

    if config.UPSTREAM_PROXY:
        print("  Instagram traffic goes through the configured upstream proxy.")
    if config.ACCESS_CODE:
        print("  An access code is required to use this server.")
    else:
        print(
            "  No access code set. Fine on your own network; set ACCESS_CODE\n"
            "  before putting this anywhere reachable from the internet."
        )
    print("\n  This machine must be able to reach Instagram itself.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping")
        server.shutdown()


if __name__ == "__main__":
    main()
