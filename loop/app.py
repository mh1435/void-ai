"""HTTP routing: the JSON API the web app talks to, plus static files."""

import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import re
import traceback
import urllib.parse

from . import config, instagram, mediaproxy, netclient, passwords
from .sessions import Session, store

WEB_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

SID_COOKIE = "loop_sid"
GATE_COOKIE = "loop_gate"


# --------------------------------------------------------------------------
# tiny result helpers
# --------------------------------------------------------------------------

class Result:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body


def json_result(payload, status=200, headers=None):
    body = json.dumps(payload).encode()
    out = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
        "Cache-Control": "no-store",
    }
    if headers:
        out.update(headers)
    return Result(status, out, body)


def error_result(message, kind="error", status=400):
    return json_result({"error": message, "kind": kind}, status)


# --------------------------------------------------------------------------
# the access gate (optional, protects the deployment itself)
# --------------------------------------------------------------------------

def _gate_token():
    return hmac.new(config.SECRET.encode(), b"gate:" + config.ACCESS_CODE.encode(),
                    hashlib.sha256).hexdigest()[:32]


def gate_open(cookies):
    if not config.ACCESS_CODE:
        return True
    return hmac.compare_digest(cookies.get(GATE_COOKIE, ""), _gate_token())


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------

ROUTES = []


def route(method, pattern):
    compiled = re.compile("^" + pattern + "$")

    def register(fn):
        ROUTES.append((method, compiled, fn))
        return fn
    return register


class Request:
    def __init__(self, method, path, query, body, cookies, headers):
        self.method = method
        self.path = path
        self.query = query           # dict of first values
        self.body = body             # bytes
        self.cookies = cookies
        self.headers = headers
        self._session = None
        self.set_cookies = []

    def json(self):
        if not self.body:
            return {}
        try:
            return json.loads(self.body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    @property
    def session(self):
        """The session for this browser, created on first sight."""
        if self._session is None:
            self._session = store.get(self.cookies.get(SID_COOKIE, ""))
            if self._session is None:
                self._session = store.create()
                self.set_cookies.append(
                    _cookie(SID_COOKIE, self._session.token, self.secure)
                )
        return self._session

    @property
    def secure(self):
        proto = self.headers.get("x-forwarded-proto", "")
        return proto == "https"


def _cookie(name, value, secure, max_age=60 * 60 * 24 * 365):
    parts = [
        f"{name}={value}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={max_age}",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def handle(method, raw_path, body, cookies, headers):
    parsed = urllib.parse.urlsplit(raw_path)
    path = urllib.parse.unquote(parsed.path)
    query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    request = Request(method, path, query, body, cookies, headers)

    for route_method, pattern, handler in ROUTES:
        if route_method != method:
            continue
        match = pattern.match(path)
        if not match:
            continue
        try:
            result = handler(request, *match.groups())
        except instagram.InstagramError as exc:
            status = 401 if exc.kind == "login_required" else (exc.status or 400)
            result = error_result(str(exc), exc.kind, status)
        except netclient.HTTPError as exc:
            # This is the interesting failure mode for this project: the server
            # itself cannot reach Instagram.
            result = error_result(
                "This server could not reach Instagram. If it is deployed "
                "somewhere Instagram is also blocked or rate-limited, set "
                "UPSTREAM_PROXY. " + str(exc),
                kind="upstream_unreachable", status=502,
            )
        except Exception as exc:  # noqa: BLE001 - last line of defence
            if config.DEBUG:
                traceback.print_exc()
            result = error_result(f"Unexpected server error: {exc}", "server", 500)

        for cookie in request.set_cookies:
            result.headers.setdefault("Set-Cookie", cookie)
        return result

    if method in ("GET", "HEAD"):
        return serve_static(path)
    return error_result("No such endpoint.", "not_found", 404)


def guard(fn):
    """Require the access gate, and a signed-in Instagram session."""
    def wrapped(request, *args):
        if not gate_open(request.cookies):
            return error_result("This server is locked.", "gate", 401)
        if not request.session.authenticated:
            return error_result("Sign in to Instagram first.",
                                "login_required", 401)
        return fn(request, *args)
    return wrapped


def gated(fn):
    """Require only the access gate."""
    def wrapped(request, *args):
        if not gate_open(request.cookies):
            return error_result("This server is locked.", "gate", 401)
        return fn(request, *args)
    return wrapped


# --------------------------------------------------------------------------
# session / auth
# --------------------------------------------------------------------------

@route("GET", r"/api/session")
def api_session(request):
    session = request.session
    return json_result({
        "gate_required": bool(config.ACCESS_CODE),
        "gate_open": gate_open(request.cookies),
        "authenticated": session.authenticated,
        "username": session.username,
        "user_id": session.user_id,
        "proxy": bool(config.UPSTREAM_PROXY),
    })


@route("POST", r"/api/session/gate")
def api_gate(request):
    if not config.ACCESS_CODE:
        return json_result({"ok": True})
    supplied = str(request.json().get("code", ""))
    if not hmac.compare_digest(supplied, config.ACCESS_CODE):
        return error_result("Wrong code.", "gate", 401)
    return json_result({"ok": True}, headers={
        "Set-Cookie": _cookie(GATE_COOKIE, _gate_token(), request.secure),
    })


@route("POST", r"/api/session/login")
@gated
def api_login(request):
    payload = request.json()
    username = str(payload.get("username", "")).strip().lstrip("@")
    password = str(payload.get("password", ""))
    if not username or not password:
        return error_result("Username and password are both required.", "input")
    result = instagram.login(request.session, username, password, store)
    return json_result(result)


@route("POST", r"/api/session/cookie")
@gated
def api_login_cookie(request):
    payload = request.json()
    result = instagram.login_with_session(
        request.session,
        str(payload.get("sessionid", "")),
        str(payload.get("csrftoken", "")),
        store,
    )
    return json_result(result)


@route("POST", r"/api/session/two-factor")
@gated
def api_two_factor(request):
    payload = request.json()
    result = instagram.two_factor(
        request.session,
        str(payload.get("username", "")),
        str(payload.get("identifier", "")),
        str(payload.get("code", "")),
        store,
    )
    return json_result(result)


@route("POST", r"/api/session/logout")
def api_logout(request):
    session = request.session
    instagram.logout(session, store)
    store.drop(session.token)
    return json_result({"ok": True}, headers={
        "Set-Cookie": _cookie(SID_COOKIE, "", request.secure, max_age=0),
    })


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------

@route("GET", r"/api/feed")
@guard
def api_feed(request):
    return json_result(
        instagram.timeline(request.session, request.query.get("max_id"), store))


@route("GET", r"/api/stories")
@guard
def api_stories(request):
    return json_result(instagram.stories_tray(request.session, store))


@route("GET", r"/api/stories/([0-9]+)")
@guard
def api_story(request, reel_id):
    return json_result(instagram.story_reel(request.session, reel_id, store))


@route("GET", r"/api/explore")
@guard
def api_explore(request):
    return json_result(
        instagram.explore(request.session, request.query.get("max_id"), store))


@route("GET", r"/api/reels")
@guard
def api_reels(request):
    return json_result(
        instagram.clips(request.session, request.query.get("max_id"), store))


@route("GET", r"/api/user/([A-Za-z0-9._]+)")
@guard
def api_user(request, username):
    return json_result(instagram.profile(request.session, username, store))


@route("GET", r"/api/user/([0-9]+)/feed")
@guard
def api_user_feed(request, user_id):
    return json_result(
        instagram.user_feed(request.session, user_id,
                            request.query.get("max_id"), store))


@route("GET", r"/api/post/([0-9_]+)")
@guard
def api_post(request, media_id):
    return json_result(instagram.media_info(request.session, media_id, store))


@route("GET", r"/api/p/([A-Za-z0-9_-]+)")
@guard
def api_shortcode(request, shortcode):
    return json_result(
        instagram.media_by_shortcode(request.session, shortcode, store))


@route("GET", r"/api/post/([0-9_]+)/comments")
@guard
def api_comments(request, media_id):
    return json_result(
        instagram.comments(request.session, media_id,
                           request.query.get("min_id"), store))


@route("GET", r"/api/search")
@guard
def api_search(request):
    query = (request.query.get("q") or "").strip()
    if not query:
        return json_result({"users": [], "hashtags": []})
    return json_result(instagram.search(request.session, query, store))


@route("GET", r"/api/tag/([^/]+)")
@guard
def api_tag(request, name):
    return json_result(instagram.hashtag(request.session, name, store))


@route("GET", r"/api/activity")
@guard
def api_activity(request):
    return json_result(instagram.activity(request.session, store))


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------

@route("POST", r"/api/post/([0-9_]+)/like")
@guard
def api_like(request, media_id):
    on = bool(request.json().get("on", True))
    return json_result(instagram.like(request.session, media_id, on, store))


@route("POST", r"/api/post/([0-9_]+)/save")
@guard
def api_save(request, media_id):
    on = bool(request.json().get("on", True))
    return json_result(instagram.save(request.session, media_id, on, store))


@route("POST", r"/api/user/([0-9]+)/follow")
@guard
def api_follow(request, user_id):
    on = bool(request.json().get("on", True))
    return json_result(instagram.follow(request.session, user_id, on, store))


@route("POST", r"/api/post/([0-9_]+)/comments")
@guard
def api_add_comment(request, media_id):
    payload = request.json()
    text = str(payload.get("text", "")).strip()
    if not text:
        return error_result("Write something first.", "input")
    return json_result(instagram.add_comment(
        request.session, media_id, text, payload.get("replied_to")))


@route("DELETE", r"/api/post/([0-9_]+)/comments/([0-9]+)")
@guard
def api_delete_comment(request, media_id, comment_id):
    return json_result(
        instagram.delete_comment(request.session, media_id, comment_id))


# --------------------------------------------------------------------------
# media + health
# --------------------------------------------------------------------------

@route("GET", r"/media")
def api_media(request):
    url = request.query.get("u", "")
    signature = request.query.get("s", "")
    if not url:
        return error_result("Missing url.", "input")
    status, headers, body = mediaproxy.fetch(
        url, signature, request.headers.get("range"))
    return Result(status, headers, body)


@route("GET", r"/api/health")
def api_health(request):
    """What the user needs when the app shows nothing and they cannot tell
    whose fault it is.

    Reachability alone is not enough: Instagram will happily answer a request
    from an address it has no intention of letting anyone sign in from. So
    this also checks whether it will issue a session token, which is the step
    that actually gates logging in.
    """
    reachable, detail = False, ""
    try:
        resp = netclient.request("GET", instagram.BASE + "/robots.txt",
                                 retries=0, timeout=8)
        reachable = resp.status < 500
        detail = f"HTTP {resp.status}"
    except netclient.HTTPError as exc:
        detail = str(exc)

    can_sign_in, sign_in_detail = False, "not checked"
    if reachable:
        probe = Session("health-probe")
        try:
            can_sign_in = instagram.bootstrap(probe)
            sign_in_detail = (
                "Instagram issued a session token"
                if can_sign_in else
                "Instagram would not issue a session token from this address"
            )
        except netclient.HTTPError as exc:
            sign_in_detail = str(exc)

    return json_result({
        "ok": True,
        "instagram_reachable": reachable,
        "detail": detail,
        "can_sign_in": can_sign_in,
        "sign_in_detail": sign_in_detail,
        # Whether passwords will be encrypted the way instagram.com does, or
        # fall back to the plaintext form it increasingly refuses.
        "password_encryption": passwords.ENCRYPTION_AVAILABLE,
        "upstream_proxy": bool(config.UPSTREAM_PROXY),
        "sessions": len(store),
    })


# --------------------------------------------------------------------------
# static files
# --------------------------------------------------------------------------

# The app's own code must revalidate, or a deploy is invisible for up to an
# hour while browsers serve a stale bundle. Only genuinely static art gets a
# long cache. "no-cache" here means "check with the server before reusing",
# not "never cache" - a 304 keeps it cheap.
_STATIC_CACHE = {
    ".css": "no-cache, must-revalidate",
    ".js": "no-cache, must-revalidate",
    ".svg": "public, max-age=86400",
    ".png": "public, max-age=86400",
    ".webmanifest": "no-cache, must-revalidate",
}


def serve_static(path):
    if path in ("/", ""):
        path = "/index.html"

    # Any unknown non-asset path is a client-side route (/explore, /u/name…),
    # so hand back the app shell and let the router sort it out.
    clean = posixpath.normpath(path).lstrip("/")
    root = os.path.abspath(WEB_ROOT)
    target = os.path.abspath(os.path.join(root, clean))
    # startswith() would also accept a sibling like /app/web-other.
    if target != root and not target.startswith(root + os.sep):
        return error_result("Nope.", "not_found", 404)
    if not os.path.isfile(target):
        if "." in posixpath.basename(clean):
            return error_result("Not found.", "not_found", 404)
        target = os.path.join(WEB_ROOT, "index.html")

    try:
        with open(target, "rb") as fh:
            body = fh.read()
    except OSError:
        return error_result("Not found.", "not_found", 404)

    ext = os.path.splitext(target)[1]
    ctype, _ = mimetypes.guess_type(target)
    if ext == ".webmanifest":
        ctype = "application/manifest+json"
    headers = {
        "Content-Type": ctype or "application/octet-stream",
        "Content-Length": str(len(body)),
        "Cache-Control": _STATIC_CACHE.get(ext, "no-cache, must-revalidate"),
        # This app never embeds third-party frames and never wants to be one.
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }
    return Result(200, headers, body)
