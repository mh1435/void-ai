"""The wire itself.

app.handle() returns a Result; turning that into bytes on a socket is where
response framing lives, and framing is the kind of thing that looks fine in
a unit test and then hangs a browser. These tests speak real HTTP/1.1 to a
real socket.
"""

import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer

import server as entrypoint

from .stub import FakeStream, Upstream

AUDIO = b"ID3" + b"\xff\xfb" * 4000


class ServerTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), entrypoint.Handler)
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        from voidmusic import proxy
        proxy.cache.clear()
        self.conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)

    def tearDown(self):
        self.conn.close()

    def get(self, path, headers=None, method="GET"):
        self.conn.request(method, path, headers=headers or {})
        res = self.conn.getresponse()
        return res, res.read()

    # -- the app ----------------------------------------------------------

    def test_the_app_is_served(self):
        res, body = self.get("/")
        self.assertEqual(200, res.status)
        self.assertIn(b"<title>", body)
        self.assertEqual(str(len(body)), res.getheader("Content-Length"))

    def test_health_is_json(self):
        res, body = self.get("/api/health")
        self.assertEqual(200, res.status)
        self.assertIn("application/json", res.getheader("Content-Type"))

    # -- streaming --------------------------------------------------------

    def test_a_known_length_is_passed_through_verbatim(self):
        headers = {"content-type": "audio/mpeg", "content-length": str(len(AUDIO))}
        with Upstream(FakeStream(200, headers, AUDIO)):
            res, body = self.get("/via/archive.org/download/x/y.mp3")
        self.assertEqual(200, res.status)
        self.assertEqual(AUDIO, body)
        self.assertEqual(str(len(AUDIO)), res.getheader("Content-Length"))
        self.assertIsNone(res.getheader("Transfer-Encoding"))

    def test_a_track_too_large_to_buffer_keeps_its_length(self):
        """The case a real track actually takes: streamed, but measured.

        Falling back to chunked here would work, but the offline downloader
        reads Content-Length to draw its progress bar, so it would silently
        lose it on exactly the files worth showing progress for.
        """
        from voidmusic import proxy
        size = proxy.CACHEABLE_BYTES + 1
        big = b"\xff" * size
        with Upstream(FakeStream(200, {"content-type": "audio/flac",
                                       "content-length": str(size)}, big)):
            res, body = self.get("/via/archive.org/download/x/y.flac")
        self.assertEqual(200, res.status)
        self.assertEqual(str(size), res.getheader("Content-Length"))
        self.assertIsNone(res.getheader("Transfer-Encoding"))
        self.assertEqual(size, len(body))

    def test_an_unknown_length_falls_back_to_chunked(self):
        # Some datanodes answer a range with no Content-Length at all. Without
        # chunked framing the client would wait for bytes that never come.
        with Upstream(FakeStream(200, {"content-type": "audio/mpeg"}, AUDIO)):
            res, body = self.get("/via/archive.org/download/x/y.mp3")
        self.assertEqual(200, res.status)
        self.assertEqual("chunked", res.getheader("Transfer-Encoding"))
        self.assertEqual(AUDIO, body)

    def test_a_ranged_response_keeps_its_content_range(self):
        headers = {"content-type": "audio/mpeg", "content-length": "4",
                   "content-range": f"bytes 0-3/{len(AUDIO)}"}
        with Upstream(FakeStream(206, headers, b"ID3\xff")):
            res, body = self.get("/via/archive.org/download/x/y.mp3",
                                 {"Range": "bytes=0-3"})
        self.assertEqual(206, res.status)
        self.assertEqual(b"ID3\xff", body)
        self.assertEqual(f"bytes 0-3/{len(AUDIO)}", res.getheader("Content-Range"))

    def test_head_returns_the_headers_and_no_body(self):
        headers = {"content-type": "audio/mpeg", "content-length": str(len(AUDIO))}
        with Upstream(FakeStream(200, headers, AUDIO)):
            res, body = self.get("/via/archive.org/download/x/y.mp3",
                                 method="HEAD")
        self.assertEqual(200, res.status)
        self.assertEqual(b"", body)

    # -- framing ----------------------------------------------------------

    def test_the_connection_survives_a_streamed_response(self):
        """The real test of framing: ask twice on one connection.

        If Content-Length or the chunked terminator is wrong by a byte, the
        second response is read as garbage or never arrives — which in a
        browser looks like a track that plays and then a UI that stops
        responding, and looks like nothing at all in a unit test.
        """
        with Upstream(
            FakeStream(200, {"content-type": "audio/mpeg",
                             "content-length": str(len(AUDIO))}, AUDIO),
            FakeStream(200, {"content-type": "audio/mpeg"}, AUDIO),   # chunked
        ):
            res, first = self.get("/via/archive.org/download/x/1.mp3")
            self.assertEqual(200, res.status)
            res, second = self.get("/via/archive.org/download/x/2.mp3")
            self.assertEqual(200, res.status)

        res, third = self.get("/api/health")
        self.assertEqual(200, res.status)
        self.assertEqual(AUDIO, first)
        self.assertEqual(AUDIO, second)

    def test_a_refused_host_is_a_json_403_not_a_hang(self):
        res, body = self.get("/via/evil.example/x")
        self.assertEqual(403, res.status)
        self.assertIn(b"will not fetch", body)


if __name__ == "__main__":
    unittest.main()
