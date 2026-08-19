"""Routing, the access gate, and static file serving.

These exercise voidmusic.app.handle() directly rather than over a socket, so
they run fast and do not need a port.
"""

import json
import unittest

from voidmusic import app, config, proxy

from .stub import FakeStream, Upstream, body_of


def call(method, path, headers=None):
    return app.handle(method, path, headers or {})


def payload(result):
    return json.loads(body_of(result).decode())


class RoutingTests(unittest.TestCase):

    def setUp(self):
        # A cached answer from an earlier test would be served without ever
        # reaching the stub.
        proxy.cache.clear()

    def test_health_reports_what_the_deployment_can_do(self):
        result = call("GET", "/api/health")
        self.assertEqual(200, result.status)
        data = payload(result)
        self.assertTrue(data["ok"])
        self.assertIn("archive.org", data["allowed_hosts"])

    def test_an_unknown_api_endpoint_is_a_404(self):
        result = call("GET", "/api/does-not-exist")
        self.assertEqual(404, result.status)
        self.assertEqual("not_found", payload(result)["kind"])

    def test_a_write_method_is_refused_outright(self):
        # Nothing here accepts a body; a POST should not fall through to the
        # static handler and answer 404 as though the path were the problem.
        self.assertEqual(404, call("POST", "/via/archive.org/x").status)

    def test_preflight_is_answered_for_the_proxy(self):
        result = call("OPTIONS", "/via/archive.org/metadata/nasa")
        self.assertEqual(204, result.status)
        self.assertEqual("*", result.headers["Access-Control-Allow-Origin"])
        self.assertIn("Range", result.headers["Access-Control-Allow-Headers"])

    def test_the_proxy_answers_cross_origin(self):
        # The Android app serves the player from its own assets, so every
        # call it makes to a server is cross-origin.
        with Upstream(FakeStream(200, {"content-type": "application/json",
                                       "content-length": "2"}, b"{}")):
            result = call("GET", "/via/archive.org/metadata/nasa")
        self.assertEqual("*", result.headers["Access-Control-Allow-Origin"])
        self.assertIn("Content-Range",
                      result.headers["Access-Control-Expose-Headers"])

    def test_the_players_own_urls_survive_the_trip(self):
        with Upstream(FakeStream(200, {"content-type": "application/json",
                                       "content-length": "2"}, b"{}")) as up:
            call("GET", "/via/archive.org/services/search/v1/scrape"
                        "?q=collection%3Anetlabels&count=100")
        self.assertEqual(
            "https://archive.org/services/search/v1/scrape"
            "?q=collection%3Anetlabels&count=100",
            up.calls[0]["url"])

    def test_a_range_header_is_passed_upstream(self):
        with Upstream(FakeStream(206, {"content-type": "audio/mpeg"},
                                 b"abcd")) as up:
            result = call("GET", "/via/archive.org/download/x/y.mp3",
                          {"range": "bytes=100-200"})
        self.assertEqual("bytes=100-200", up.calls[0]["headers"]["Range"])
        self.assertEqual(206, result.status)

    def test_an_unreachable_upstream_says_so_usefully(self):
        from voidmusic import netclient
        with Upstream(netclient.HTTPError("cannot reach archive.org")):
            result = call("GET", "/via/archive.org/metadata/nasa")
        self.assertEqual(502, result.status)
        data = payload(result)
        self.assertEqual("upstream_unreachable", data["kind"])
        self.assertIn("UPSTREAM_PROXY", data["error"])


class GateTests(unittest.TestCase):

    def setUp(self):
        proxy.cache.clear()
        self._code = config.ACCESS_CODE
        config.ACCESS_CODE = "hunter2"

    def tearDown(self):
        config.ACCESS_CODE = self._code

    def test_the_proxy_is_locked_without_the_code(self):
        with Upstream() as up:
            result = call("GET", "/via/archive.org/metadata/nasa")
        self.assertEqual(401, result.status)
        self.assertEqual("gate", payload(result)["kind"])
        self.assertEqual([], up.calls, "a locked server still made a request")

    def test_a_wrong_code_is_refused(self):
        with Upstream() as up:
            result = call("GET", "/via/archive.org/metadata/nasa",
                          {"x-void-code": "hunter3"})
        self.assertEqual(401, result.status)
        self.assertEqual([], up.calls)

    def test_the_code_may_travel_as_a_header(self):
        with Upstream(FakeStream(200, {"content-type": "application/json",
                                       "content-length": "2"}, b"{}")) as up:
            result = call("GET", "/via/archive.org/metadata/nasa",
                          {"x-void-code": "hunter2"})
        self.assertEqual(200, result.status)
        self.assertEqual(1, len(up.calls))

    def test_the_code_may_travel_in_the_query_for_a_plain_audio_element(self):
        # <audio src> cannot carry a custom header, so the query string has to
        # work too.
        with Upstream(FakeStream(200, {"content-type": "audio/mpeg"},
                                 b"abcd")) as up:
            result = call("GET", "/via/archive.org/download/x/y.mp3?code=hunter2")
        self.assertEqual(200, result.status)
        self.assertEqual(1, len(up.calls))

    def test_the_app_itself_is_still_served_so_the_code_can_be_entered(self):
        self.assertEqual(200, call("GET", "/").status)

    def test_health_is_readable_but_admits_nothing(self):
        result = call("GET", "/api/health")
        self.assertEqual(200, result.status)
        data = payload(result)
        self.assertTrue(data["gate_required"])
        self.assertFalse(data["gate_open"])
        self.assertNotIn("hunter2", json.dumps(data))


class StaticTests(unittest.TestCase):

    def test_the_app_shell_is_served_at_the_root(self):
        result = call("GET", "/")
        self.assertEqual(200, result.status)
        self.assertIn("text/html", result.headers["Content-Type"])
        self.assertIn(b"<title>", body_of(result))

    def test_the_modules_and_the_worker_are_served(self):
        for path, ctype in (("/js/main.js", "javascript"),
                            ("/css/app.css", "css"),
                            ("/sw.js", "javascript"),
                            ("/manifest.webmanifest", "manifest")):
            result = call("GET", path)
            self.assertEqual(200, result.status, path)
            self.assertIn(ctype, result.headers["Content-Type"], path)

    def test_the_server_does_not_serve_its_own_source(self):
        # The player and the server share a directory, which is convenient
        # right up until the server publishes itself.
        for path in ("/server.py", "/voidmusic/config.py", "/voidmusic/app.py",
                     "/tests/test_app.py", "/render.yaml", "/.gitignore",
                     "/android/app/build.gradle"):
            self.assertEqual(404, call("GET", path).status, path)

    def test_traversal_out_of_the_web_root_is_refused(self):
        for path in ("/css/../../etc/passwd", "/../server.py",
                     "/js/../../../etc/hosts", "/assets/../../voidmusic/app.py"):
            self.assertEqual(404, call("GET", path).status, path)

    def test_an_unknown_path_is_a_404_rather_than_the_shell(self):
        # The player routes on the hash, so there are no server-side routes to
        # fall back for; a wrong path is simply wrong.
        self.assertEqual(404, call("GET", "/nope").status)


if __name__ == "__main__":
    unittest.main()
