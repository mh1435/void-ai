"""HTTP routing: the reverse proxy, a health endpoint, and the app itself."""

import hmac
import json
import mimetypes
import os
import posixpath
import re
import traceback
import urllib.parse

from . import __version__, config, netclient, proxy

# The PWA lives at the repository root next to this package, so one process
# serves both halves and every request the browser makes is same-origin.
WEB_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Only these top-level entries are web-reachable. The repository root also
# holds this package, the tests and the Android project, and none of that
# belongs on the public internet.
PUBLIC = frozenset((
    "index.html", "sw.js", "manifest.webmanifest", "LICENSE",
    "css", "js", "assets",
))


class Result:
    """One response: either a complete `body`, or `chunks` to stream."""

    def __init__(self, status, headers, body=None, chunks=None):
        self.status = status
        self.headers = headers
        self.body = body
        self.chunks = chunks


def json_result(payload, status=200, headers=None):
    body = json.dumps(payload).encode()
    out = {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    }
    if headers:
        out.update(headers)
    return Result(status, out, body)


def error_result(message, kind="error", status=400):
    return json_result({"error": message, "kind": kind}, status)


# --------------------------------------------------------------------------
# CORS
#
# The Android app loads the player from its own assets and points it at a
# server on some other origin, so the proxy has to answer cross-origin
# requests. It is safe to be permissive here precisely because the endpoint
# carries no ambient authority: no cookies, no sessions, nothing to forge on
# a user's behalf. The access code travels in a header, never a cookie, so a
# stranger's page cannot spend your bandwidth just by being open in a tab.
# --------------------------------------------------------------------------

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, X-Void-Code, Content-Type",
    "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges, X-Void-Cache",
    "Access-Control-Max-Age": "86400",
}

CODE_HEADER = "x-void-code"


def gate_open(request):
    """True when this request may use the proxy."""
    if not config.ACCESS_CODE:
        return True
    offered = request.headers.get(CODE_HEADER) or request.query.get("code") or ""
    return hmac.compare_digest(offered, config.ACCESS_CODE)


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------

ROUTES = []


def route(methods, pattern):
    compiled = re.compile("^" + pattern + "$")

    def register(fn):
        ROUTES.append((tuple(methods.split()), compiled, fn))
        return fn
    return register


def _forwarded_query(raw_query):
    """The query to send upstream: everything except our own access code.

    It arrives in the query string because an <audio src> cannot set a header,
    which means it is sitting in the string we are about to forward. None of
    the allowlisted APIs take a parameter by that name, so dropping it costs
    nothing and keeps the code from being handed to a third party.
    """
    if not raw_query:
        return ""
    kept = [pair for pair in raw_query.split("&")
            if pair and not pair.startswith("code=")]
    return "&".join(kept)


class Request:
    def __init__(self, method, path, query, raw_query, headers):
        self.method = method
        self.path = path
        self.query = query           # dict of first values
        self.raw_query = raw_query   # the query string, untouched
        self.headers = headers       # dict, lower-cased keys


@route("GET HEAD", r"/api/health")
def api_health(request):
    """Enough to tell a working deployment from a broken one, and no more."""
    return json_result({
        "ok": True,
        "app": "void-music",
        "version": __version__,
        "gate_required": bool(config.ACCESS_CODE),
        "gate_open": gate_open(request),
        "upstream_proxy": bool(config.UPSTREAM_PROXY),
        "allowed_hosts": list(config.ALLOWED_HOSTS),
        "cache": proxy.cache.stats(),
    }, headers=dict(CORS))


@route("GET HEAD", r"/via/([^/]+)(/.*)?")
def api_via(request, host, path):
    """Fetch an allowlisted host on the browser's behalf.

    The player's mirror list points at `<this server>/via/archive.org`, which
    means every URL it already knows how to build — search, metadata, and
    /download/<item>/<file> for the audio — works unchanged.
    """
    if not gate_open(request):
        return json_result({
            "error": "This server requires an access code. Add it under "
                     "Settings → Connection.",
            "kind": "gate",
        }, 401, dict(CORS))

    url = proxy.target_url(host, path or "/",
                           _forwarded_query(request.raw_query))
    if not proxy.host_allowed(url):
        return json_result(
            {"error": f"This server will not fetch {host}.", "kind": "host"},
            403, dict(CORS))

    result = proxy.fetch(url, range_header=request.headers.get("range"),
                         method=request.method)
    headers = dict(result.headers)
    headers.update(CORS)
    return Result(result.status, headers, body=result.body,
                  chunks=result.chunks)


@route("OPTIONS", r"/(api|via)/.*")
def api_preflight(request, _prefix):
    return Result(204, dict(CORS), body=b"")


def handle(method, raw_path, headers):
    """Route one request. Returns a Result."""
    parsed = urllib.parse.urlsplit(raw_path)
    path = urllib.parse.unquote(parsed.path)
    query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
    request = Request(method, path, query, parsed.query, headers)

    for methods, pattern, handler in ROUTES:
        if method not in methods:
            continue
        match = pattern.match(path)
        if not match:
            continue
        try:
            return handler(request, *match.groups())
        except netclient.HTTPError as exc:
            # The interesting failure mode for this project: the server itself
            # cannot reach the catalogue.
            return json_result({
                "error": "This server could not reach the upstream host. If it "
                         "is deployed somewhere that is also filtered, set "
                         "UPSTREAM_PROXY. " + str(exc),
                "kind": "upstream_unreachable",
            }, 502, dict(CORS))
        except Exception as exc:  # noqa: BLE001 - last line of defence
            if config.DEBUG:
                traceback.print_exc()
            return json_result({"error": f"Unexpected server error: {exc}",
                                "kind": "server"}, 500, dict(CORS))

    if method in ("GET", "HEAD"):
        return serve_static(path)
    return error_result("No such endpoint.", "not_found", 404)


# --------------------------------------------------------------------------
# the app itself
# --------------------------------------------------------------------------

_STATIC_CACHE = {
    ".html": "no-cache, must-revalidate",
    ".js": "no-cache, must-revalidate",
    ".css": "no-cache, must-revalidate",
    ".png": "public, max-age=86400",
    ".svg": "public, max-age=86400",
    ".webmanifest": "no-cache, must-revalidate",
}


def serve_static(path):
    if path in ("/", ""):
        path = "/index.html"

    clean = posixpath.normpath(path).lstrip("/")
    top = clean.split("/", 1)[0]
    if top not in PUBLIC:
        return error_result("Not found.", "not_found", 404)

    root = os.path.abspath(WEB_ROOT)
    target = os.path.abspath(os.path.join(root, clean))
    # startswith() alone would also accept a sibling directory like /app-other.
    if target != root and not target.startswith(root + os.sep):
        return error_result("Not found.", "not_found", 404)
    if not os.path.isfile(target):
        return error_result("Not found.", "not_found", 404)

    try:
        with open(target, "rb") as fh:
            body = fh.read()
    except OSError:
        return error_result("Not found.", "not_found", 404)

    ext = os.path.splitext(target)[1]
    ctype, _ = mimetypes.guess_type(target)
    if ext == ".webmanifest":
        ctype = "application/manifest+json"
    return Result(200, {
        "Content-Type": ctype or "application/octet-stream",
        "Cache-Control": _STATIC_CACHE.get(ext, "no-cache, must-revalidate"),
        # This app never embeds a third-party frame and never wants to be one.
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }, body)
