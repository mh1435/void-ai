"""A small, dependency-free HTTP client for talking to the open web.

We deliberately avoid `requests` so the whole thing installs with no build
step at all — the player has zero dependencies and so does its server. What
we need beyond urllib's defaults is: gzip, an optional upstream proxy,
retries with backoff, redirects we can see, and — because this thing serves
audio — a way to stream a response instead of buffering it.
"""

import gzip
import io
import json
import random
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

from . import config


class Response:
    __slots__ = ("status", "headers", "body", "url")

    def __init__(self, status, headers, body, url):
        self.status = status
        self.headers = headers          # dict, lower-cased keys
        self.body = body                # bytes
        self.url = url                  # final URL after redirects

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.text)

    @property
    def ok(self):
        return 200 <= self.status < 300

    def __repr__(self):
        return f"<Response {self.status} {self.url} {len(self.body)}b>"


class Stream:
    """An upstream response whose body has not been read yet.

    `body` is a file-like object; close it when done. This is what keeps a
    300 MB lossless track from becoming 300 MB of resident memory.
    """

    __slots__ = ("status", "headers", "body", "url")

    def __init__(self, status, headers, body, url):
        self.status = status
        self.headers = headers
        self.body = body
        self.url = url

    @property
    def ok(self):
        return 200 <= self.status < 300

    def chunks(self, size=64 * 1024):
        try:
            while True:
                chunk = self.body.read(size)
                if not chunk:
                    return
                yield chunk
        finally:
            self.close()

    def close(self):
        try:
            self.body.close()
        except Exception:  # noqa: BLE001
            pass


class HTTPError(Exception):
    """A request failed in a way the caller should surface to the user."""

    def __init__(self, message, status=0, body=b""):
        super().__init__(message)
        self.status = status
        self.body = body


# Verification stays on. A filtered network is exactly where a downgraded
# connection would be worth abusing.
_SSL_CTX = ssl.create_default_context()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects are followed by us, deliberately, or not at all.

    archive.org answers /download/<item>/<file> with a redirect to whichever
    datanode holds the bytes, so following them is not optional — but each
    hop has to be re-checked against the host allowlist by the caller.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _build_opener():
    handlers = [
        urllib.request.HTTPSHandler(context=_SSL_CTX),
        _NoRedirect(),
    ]
    if config.UPSTREAM_PROXY:
        handlers.append(
            urllib.request.ProxyHandler(
                {"http": config.UPSTREAM_PROXY, "https": config.UPSTREAM_PROXY}
            )
        )
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


_OPENER = _build_opener()

REDIRECT_CODES = (301, 302, 303, 307, 308)


def _decode(body, encoding):
    if not body:
        return body
    encoding = (encoding or "").lower()
    try:
        if encoding == "gzip":
            return gzip.GzipFile(fileobj=io.BytesIO(body)).read()
        if encoding == "deflate":
            return zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:  # noqa: BLE001
        # A CDN occasionally mislabels; the raw bytes beat an exception.
        return body
    return body


def _base_headers(extra=None, identity=False):
    hdrs = {
        "User-Agent": config.USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        # No brotli: the standard library cannot decode it.
        # For streamed bodies we ask for identity so the bytes we forward are
        # the bytes upstream measured in Content-Length.
        "Accept-Encoding": "identity" if identity else "gzip, deflate",
    }
    if extra:
        hdrs.update({k: v for k, v in extra.items() if v is not None})
    return hdrs


def request(method, url, *, headers=None, data=None, timeout=None,
            retries=None, max_redirects=3, on_redirect=None):
    """Perform a request and return a fully-read Response.

    `on_redirect(url)` is called for each hop and may return False to refuse
    it, which is how the proxy keeps a redirect from walking off the
    allowlist.
    """
    timeout = config.TIMEOUT if timeout is None else timeout
    retries = config.RETRIES if retries is None else retries

    body = None
    hdrs = _base_headers(headers)
    if isinstance(data, dict):
        body = urllib.parse.urlencode(data).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif isinstance(data, tuple) and data and data[0] == "json":
        body = json.dumps(data[1]).encode()
        hdrs["Content-Type"] = "application/json"
    elif isinstance(data, (bytes, bytearray)):
        body = bytes(data)

    last_error = None
    for attempt in range(retries + 1):
        try:
            return _once(method, url, hdrs, body, timeout, max_redirects,
                         on_redirect)
        except HTTPError as exc:
            # 4xx is an answer, not a failure to reach the host — don't retry.
            if exc.status and exc.status < 500:
                raise
            last_error = exc
        except (urllib.error.URLError, OSError, ssl.SSLError) as exc:
            last_error = HTTPError(f"cannot reach {url}: {exc}")
        if attempt < retries:
            time.sleep((0.6 * (2 ** attempt)) + random.uniform(0, 0.4))

    raise last_error or HTTPError(f"request to {url} failed")


def _open(method, url, hdrs, body, timeout):
    req = urllib.request.Request(url, data=body, method=method.upper())
    for key, value in hdrs.items():
        req.add_header(key, value)
    try:
        resp = _OPENER.open(req, timeout=timeout)
        return resp.status, resp.headers, resp
    except urllib.error.HTTPError as exc:
        # urllib raises on >=400; that is still a real response we want.
        return exc.code, exc.headers, exc


def _once(method, url, hdrs, body, timeout, max_redirects, on_redirect):
    seen = 0
    current = url
    while True:
        status, raw_headers, handle = _open(method, current, hdrs, body, timeout)
        try:
            payload = handle.read()
        finally:
            handle.close()
        headers_out = {k.lower(): v for k, v in raw_headers.items()}

        location = raw_headers.get("Location")
        if status in REDIRECT_CODES and location and seen < max_redirects:
            seen += 1
            current = urllib.parse.urljoin(current, location)
            if on_redirect and on_redirect(current) is False:
                raise HTTPError(f"refused redirect to {current}", 403)
            if status in (301, 302, 303):
                method, body = "GET", None
                hdrs.pop("Content-Type", None)
            continue

        payload = _decode(payload, headers_out.get("content-encoding"))
        if status >= 500:
            raise HTTPError(f"upstream returned {status}", status, payload[:400])
        return Response(status, headers_out, payload, current)


def stream(method, url, *, headers=None, timeout=None, max_redirects=3,
           on_redirect=None):
    """Open a response and hand back its body unread, as a Stream.

    Retries cover the connection attempt only: once bytes are flowing there is
    nothing to retry, and the caller has already started forwarding them.
    """
    timeout = config.TIMEOUT if timeout is None else timeout
    hdrs = _base_headers(headers, identity=True)

    last_error = None
    for attempt in range(config.RETRIES + 1):
        try:
            return _stream_once(method, url, hdrs, timeout, max_redirects,
                                on_redirect)
        except HTTPError as exc:
            if exc.status and exc.status < 500:
                raise
            last_error = exc
        except (urllib.error.URLError, OSError, ssl.SSLError) as exc:
            last_error = HTTPError(f"cannot reach {url}: {exc}")
        if attempt < config.RETRIES:
            time.sleep((0.6 * (2 ** attempt)) + random.uniform(0, 0.4))

    raise last_error or HTTPError(f"request to {url} failed")


def _stream_once(method, url, hdrs, timeout, max_redirects, on_redirect):
    seen = 0
    current = url
    while True:
        status, raw_headers, handle = _open(method, current, hdrs, None, timeout)
        headers_out = {k.lower(): v for k, v in raw_headers.items()}

        location = raw_headers.get("Location")
        if status in REDIRECT_CODES and location and seen < max_redirects:
            handle.close()
            seen += 1
            current = urllib.parse.urljoin(current, location)
            if on_redirect and on_redirect(current) is False:
                raise HTTPError(f"refused redirect to {current}", 403)
            continue

        if status >= 500:
            handle.close()
            raise HTTPError(f"upstream returned {status}", status)

        return Stream(status, headers_out, handle, current)
