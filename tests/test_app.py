"""Routing, the access gate, and static file serving.

These exercise loop/app.handle() directly rather than over a socket, so they
run fast and do not need a port.
"""

import importlib
import json
import unittest

from loop import app, config
from loop.sessions import store


def call(method, path, body=b"", cookies=None, headers=None):
    return app.handle(method, path, body, cookies or {}, headers or {})


def payload(result):
    return json.loads(result.body.decode())


class RoutingTests(unittest.TestCase):

    def test_unknown_api_endpoint_is_a_404_not_the_app_shell(self):
        result = call("POST", "/api/does-not-exist")
        self.assertEqual(404, result.status)
        self.assertEqual("not_found", payload(result)["kind"])

    def test_session_endpoint_issues_a_cookie(self):
        result = call("GET", "/api/session")
        self.assertEqual(200, result.status)
        self.assertIn("loop_sid=", result.headers["Set-Cookie"])
        self.assertIn("HttpOnly", result.headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", result.headers["Set-Cookie"])

    def test_the_secure_flag_follows_the_forwarded_proto(self):
        plain = call("GET", "/api/session")
        self.assertNotIn("Secure", plain.headers["Set-Cookie"])

        secure = call("GET", "/api/session", headers={"x-forwarded-proto": "https"})
        self.assertIn("Secure", secure.headers["Set-Cookie"])

    def test_reading_endpoints_require_a_signed_in_session(self):
        for path in ("/api/feed", "/api/explore", "/api/reels", "/api/activity",
                     "/api/stories", "/api/user/someone", "/api/search?q=x"):
            result = call("GET", path)
            self.assertEqual(401, result.status, path)
            self.assertEqual("login_required", payload(result)["kind"], path)

    def test_writing_endpoints_require_a_signed_in_session(self):
        for method, path in (("POST", "/api/post/1/like"),
                             ("POST", "/api/post/1/save"),
                             ("POST", "/api/user/1/follow"),
                             ("POST", "/api/post/1/comments")):
            result = call(method, path, b"{}")
            self.assertEqual(401, result.status, path)

    def test_user_and_user_feed_routes_do_not_collide(self):
        """/api/user/<name> must not swallow /api/user/<id>/feed."""
        matched = []
        for method, pattern, handler in app.ROUTES:
            if method == "GET" and pattern.match("/api/user/12345/feed"):
                matched.append(pattern.pattern)
        self.assertEqual(["^/api/user/([0-9]+)/feed$"], matched)

    def test_health_needs_no_session(self):
        result = call("GET", "/api/health")
        self.assertEqual(200, result.status)
        self.assertIn("instagram_reachable", payload(result))


class GateTests(unittest.TestCase):

    def setUp(self):
        self._original = config.ACCESS_CODE
        config.ACCESS_CODE = "let-me-in"

    def tearDown(self):
        config.ACCESS_CODE = self._original

    def test_a_locked_server_refuses_before_asking_instagram(self):
        result = call("GET", "/api/feed")
        self.assertEqual(401, result.status)
        self.assertEqual("gate", payload(result)["kind"])

    def test_login_is_behind_the_gate_too(self):
        result = call("POST", "/api/session/login",
                      json.dumps({"username": "a", "password": "b"}).encode())
        self.assertEqual("gate", payload(result)["kind"])

    def test_the_wrong_code_is_refused(self):
        result = call("POST", "/api/session/gate", b'{"code": "guess"}')
        self.assertEqual(401, result.status)
        self.assertNotIn("Set-Cookie", result.headers)

    def test_the_right_code_returns_a_gate_cookie_that_opens_it(self):
        result = call("POST", "/api/session/gate", b'{"code": "let-me-in"}')
        self.assertEqual(200, result.status)
        cookie = result.headers["Set-Cookie"]
        self.assertIn("loop_gate=", cookie)

        token = cookie.split("loop_gate=")[1].split(";")[0]
        self.assertTrue(app.gate_open({"loop_gate": token}))
        self.assertFalse(app.gate_open({"loop_gate": "forged"}))
        self.assertFalse(app.gate_open({}))

    def test_a_gate_token_does_not_work_after_the_code_changes(self):
        result = call("POST", "/api/session/gate", b'{"code": "let-me-in"}')
        token = result.headers["Set-Cookie"].split("loop_gate=")[1].split(";")[0]

        config.ACCESS_CODE = "different-now"
        self.assertFalse(app.gate_open({"loop_gate": token}))

    def test_an_unset_code_leaves_the_gate_open(self):
        config.ACCESS_CODE = ""
        self.assertTrue(app.gate_open({}))


class StaticTests(unittest.TestCase):

    def test_the_app_shell_is_served_at_the_root(self):
        result = app.serve_static("/")
        self.assertEqual(200, result.status)
        self.assertIn("text/html", result.headers["Content-Type"])

    def test_client_routes_fall_back_to_the_shell(self):
        for path in ("/explore", "/u/someone", "/post/123", "/tag/sunset"):
            result = app.serve_static(path)
            self.assertEqual(200, result.status, path)
            self.assertIn(b"<!doctype html>", result.body[:40].lower(), path)

    def test_a_missing_asset_is_a_404_rather_than_the_shell(self):
        result = app.serve_static("/nope.js")
        self.assertEqual(404, result.status)

    def test_traversal_cannot_read_a_file_outside_the_web_root(self):
        for probe in ("/../../etc/passwd", "/js/../../server.py",
                      "/js/%2e%2e/%2e%2e/etc/passwd", "/../loop/config.py"):
            result = app.serve_static(probe)
            self.assertNotIn(b"root:", result.body, probe)
            self.assertNotIn(b"ACCESS_CODE", result.body, probe)
            self.assertNotIn(b"import sys", result.body, probe)

    def test_static_responses_carry_hardening_headers(self):
        result = app.serve_static("/app.css")
        self.assertEqual("nosniff", result.headers["X-Content-Type-Options"])
        self.assertEqual("no-referrer", result.headers["Referrer-Policy"])


class MediaRouteTests(unittest.TestCase):

    def test_a_media_request_without_a_url_is_rejected(self):
        result = call("GET", "/media")
        self.assertEqual(400, result.status)

    def test_a_media_request_with_a_bad_signature_is_rejected(self):
        result = call(
            "GET",
            "/media?u=https%3A%2F%2Fscontent.cdninstagram.com%2Fa.jpg&s=forged",
        )
        self.assertEqual(403, result.status)


class ErrorShapeTests(unittest.TestCase):

    def test_every_error_carries_a_kind_the_clients_can_switch_on(self):
        """Both clients map `kind` to a typed error, so it must always exist."""
        for result in (call("GET", "/api/feed"),
                       call("POST", "/api/nope"),
                       call("GET", "/media")):
            body = payload(result)
            self.assertIn("error", body)
            self.assertIn("kind", body)
            self.assertTrue(body["error"], "an empty message helps nobody")


if __name__ == "__main__":
    unittest.main()


class RequestIdentityTests(unittest.TestCase):
    """The headers must describe one coherent client, not two."""

    def test_user_agent_matches_the_app_id_it_is_paired_with(self):
        from loop import config
        # IG_APP_ID is the desktop web app's. A mobile user-agent alongside it
        # is a combination no real Instagram client sends.
        self.assertEqual("936619743392459", config.IG_APP_ID)
        agent = config.USER_AGENT.lower()
        for mobile in ("iphone", "android", "mobile", "ipad"):
            self.assertNotIn(mobile, agent,
                             f"desktop app id paired with a {mobile} user-agent")

    def test_web_app_headers_are_present(self):
        from loop import instagram
        from loop.sessions import Session
        headers = instagram._headers(Session("t"))
        for required in ("X-IG-App-ID", "X-Requested-With", "X-Instagram-AJAX",
                         "Referer", "Origin"):
            self.assertIn(required, headers)
        self.assertEqual("XMLHttpRequest", headers["X-Requested-With"])
