#!/usr/bin/env python3
"""Void Music — the optional self-hosted backend.

Run it anywhere the Internet Archive is reachable; open it from anywhere it
is not. It serves the player itself and proxies everything the player needs,
so the device only ever talks to one host: this one.

    python3 server.py            # http://localhost:8080

Configuration is entirely environment variables — see voidmusic/config.py.
"""

import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voidmusic import __version__, app, config, proxy

CHUNK = 64 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = f"voidmusic/{__version__}"
    protocol_version = "HTTP/1.1"

    def _dispatch(self, method, send_body=True):
        try:
            result = app.handle(
                method, self.path,
                {k.lower(): v for k, v in self.headers.items()},
            )
        except Exception as exc:  # noqa: BLE001
            result = app.error_result(f"Server error: {exc}", "server", 500)

        try:
            if result.chunks is not None:
                self._send_stream(result, send_body)
            else:
                self._send_body(result, send_body)
        except (BrokenPipeError, ConnectionResetError):
            # Skipping a track cancels an in-flight audio request; seeking
            # cancels several. This is normal, not an error.
            pass

    def _send_body(self, result, send_body):
        body = result.body or b""
        self.send_response(result.status)
        headers = dict(result.headers)
        headers["Content-Length"] = str(len(body))
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if send_body and body:
            self.wfile.write(body)

    def _send_stream(self, result, send_body):
        """Forward an upstream body without ever holding it all in memory.

        With a Content-Length from upstream we can pass it straight through;
        without one there is nothing to promise, so the body is chunk-encoded
        instead. Either way the player gets bytes as they arrive, which is
        what makes seeking in a long track feel immediate.
        """
        headers = dict(result.headers)
        length = headers.get("Content-Length")
        chunked = length is None

        self.send_response(result.status)
        if chunked:
            headers["Transfer-Encoding"] = "chunked"
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()

        if not send_body:
            # A HEAD asked only for the headers; closing the generator closes
            # the upstream connection with it.
            result.chunks.close()
            return

        try:
            for chunk in result.chunks:
                if chunked:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                else:
                    self.wfile.write(chunk)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            # The generator's finally: closes the upstream connection for us.
            raise

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD", send_body=False)

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def log_message(self, fmt, *args):
        if config.DEBUG:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _sweeper():
    """Drop the whole cache periodically rather than expiring entry by entry.

    Entries carry their own age check, so this only reclaims memory held by
    things nobody has asked for in a long time.
    """
    while True:
        time.sleep(6 * 3600)
        try:
            proxy.cache.clear()
        except Exception:  # noqa: BLE001
            pass


def lan_address():
    """This machine's address on the local network, for the phone to use.

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
    print(f"Void Music {__version__} is running.\n")
    print(f"  On this machine   http://localhost:{config.PORT}")

    if config.HOST not in ("127.0.0.1", "localhost", "::1"):
        lan = lan_address()
        if lan:
            print(f"  On your network   http://{lan}:{config.PORT}"
                  "   <- open this on your phone")
            print("\n  Anyone on this network can reach it. Set ACCESS_CODE, or")
            print("  run with HOST=127.0.0.1 if the app is on this machine.")
    else:
        print("\n  Listening on this machine only - nothing else can reach it.")
    print()

    if config.UPSTREAM_PROXY:
        print("  Upstream traffic goes through the configured proxy.")
    if config.ACCESS_CODE:
        print("  An access code is required to use this server.")
    else:
        print(
            "  No access code set. Fine on your own network; set ACCESS_CODE\n"
            "  before putting this anywhere reachable from the internet."
        )
    print("\n  This machine must be able to reach archive.org itself.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping")
        server.shutdown()


if __name__ == "__main__":
    main()
