"""The HTTP client, against a real server on a real socket.

Everything else stubs this module out, so without these tests the code that
actually opens connections — redirects especially — would never run.
"""

import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from voidmusic import netclient

PAYLOAD = b"x" * 50_000


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path == "/small":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/big":
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.end_headers()
            self.wfile.write(PAYLOAD)
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/small")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/offsite":
            self.send_response(302)
            self.send_header("Location", "https://evil.example/x")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/missing":
            self.send_error(404)
        else:
            self.send_error(418)

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()

    def log_message(self, *args):
        pass


class NetClientTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.httpd.daemon_threads = True
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_a_body_can_be_read_whole(self):
        res = netclient.request("GET", self.base + "/small")
        self.assertEqual(200, res.status)
        self.assertEqual({"ok": True}, res.json())

    def test_a_body_can_be_streamed_without_being_held(self):
        stream = netclient.stream("GET", self.base + "/big")
        self.assertEqual(200, stream.status)
        received = b"".join(stream.chunks(4096))
        self.assertEqual(PAYLOAD, received)

    def test_a_stream_asks_for_no_content_encoding(self):
        # Forwarding a gzipped body while reporting the upstream
        # Content-Length would describe our response wrongly.
        self.assertEqual(
            "identity",
            netclient._base_headers(identity=True)["Accept-Encoding"])

    def test_redirects_are_followed(self):
        res = netclient.request("GET", self.base + "/redirect")
        self.assertEqual(200, res.status)
        self.assertEqual({"ok": True}, res.json())
        self.assertTrue(res.url.endswith("/small"))

    def test_a_streamed_redirect_is_followed_too(self):
        # archive.org answers /download/ with exactly this.
        stream = netclient.stream("GET", self.base + "/redirect")
        self.assertEqual(200, stream.status)
        self.assertEqual(b'{"ok": true}', b"".join(stream.chunks()))

    def test_a_hop_the_caller_refuses_is_not_followed(self):
        seen = []

        def check(url):
            seen.append(url)
            return False

        with self.assertRaises(netclient.HTTPError) as caught:
            netclient.stream("GET", self.base + "/offsite", on_redirect=check)
        self.assertEqual(403, caught.exception.status)
        self.assertEqual(["https://evil.example/x"], seen)

    def test_a_404_comes_back_as_a_response_not_an_exception(self):
        res = netclient.request("GET", self.base + "/missing", retries=0)
        self.assertEqual(404, res.status)

    def test_an_unreachable_host_raises(self):
        with self.assertRaises(netclient.HTTPError):
            netclient.request("GET", "http://127.0.0.1:1/nope", retries=0,
                              timeout=2)


if __name__ == "__main__":
    unittest.main()
