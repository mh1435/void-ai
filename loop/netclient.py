"""A small, dependency-free HTTP client for talking to Instagram.

We deliberately avoid `requests` so the whole app installs with no build step
(Render free tier runs `buildCommand: ""`). What we need beyond urllib's
defaults is: explicit cookie handling, gzip, an optional upstream proxy,
retries with backoff, and never following a redirect silently into a
login wall we cannot see.
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
    __slots__ = ("status", "headers", "body", "url", "cookies")

    def __init__(self, status, headers, body, url, cookies):
        self.status = status
        self.headers = headers          # dict, lower-cased keys
        self.body = body                # bytes
        self.url = url                  # final URL after redirects
        self.cookies = cookies          # dict of Set-Cookie name -> value

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


class HTTPError(Exception):
    """A request failed in a way the caller should surface to the user."""

    def __init__(self, message, status=0, body=b""):
        super().__init__(message)
        self.status = status
        self.body = body


# Instagram serves modern TLS; we keep verification on. Never turn this off —
# a blocked network is exactly where a downgraded connection would be abused.
_SSL_CTX = ssl.create_default_context()


def _build_opener():
    handlers = [
        urllib.request.HTTPSHandler(context=_SSL_CTX),
        # Redirects are handled by us, not silently.
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = _build_opener()


def _decode(body, encoding):
    if not body:
        return body
    encoding = (encoding or "").lower()
    try:
        if encoding == "gzip":
            return gzip.GzipFile(fileobj=io.BytesIO(body)).read()
        if encoding == "deflate":
            return zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:
        # A CDN occasionally mislabels; the raw bytes beat an exception.
        return body
    return body


def _parse_cookies(raw_headers):
    """Pull name=value out of every Set-Cookie header."""
    out = {}
    for raw in raw_headers.get_all("Set-Cookie") or []:
        pair = raw.split(";", 1)[0].strip()
        if "=" not in pair:
            continue
        name, _, value = pair.partition("=")
        name, value = name.strip(), value.strip()
        # Instagram clears cookies by setting them to a placeholder.
        if value and value not in ('""', "deleted"):
            out[name] = value
    return out


def request(
    method,
    url,
    *,
    headers=None,
    data=None,
    cookies=None,
    timeout=None,
    retries=None,
    max_redirects=3,
    raw=False,
):
    """Perform an HTTP request and return a Response.

    `data` may be bytes, a dict (form-encoded) or ("json", obj).
    `cookies` is a plain dict; Set-Cookie values come back on the Response
    rather than being stored anywhere global, so sessions stay isolated.
    """
    timeout = config.TIMEOUT if timeout is None else timeout
    retries = config.RETRIES if retries is None else retries

    body = None
    hdrs = {
        "User-Agent": config.USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        # No brotli: stdlib cannot decode it.
        "Accept-Encoding": "gzip, deflate",
    }
    if isinstance(data, dict):
        body = urllib.parse.urlencode(data).encode()
        hdrs["Content-Type"] = "application/x-www-form-urlencoded"
    elif isinstance(data, tuple) and data and data[0] == "json":
        body = json.dumps(data[1]).encode()
        hdrs["Content-Type"] = "application/json"
    elif isinstance(data, (bytes, bytearray)):
        body = bytes(data)
    if headers:
        hdrs.update({k: v for k, v in headers.items() if v is not None})
    if cookies:
        hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())

    last_error = None
    for attempt in range(retries + 1):
        try:
            return _once(method, url, hdrs, body, timeout, max_redirects, raw)
        except HTTPError as exc:
            # 4xx is an answer, not a failure to reach Instagram — don't retry.
            if exc.status and exc.status < 500:
                raise
            last_error = exc
        except (urllib.error.URLError, OSError, ssl.SSLError) as exc:
            last_error = HTTPError(f"cannot reach {url}: {exc}")
        if attempt < retries:
            time.sleep((0.6 * (2 ** attempt)) + random.uniform(0, 0.4))

    raise last_error or HTTPError(f"request to {url} failed")


def _once(method, url, hdrs, body, timeout, max_redirects, raw):
    seen = 0
    current = url
    cookies = {}
    while True:
        req = urllib.request.Request(current, data=body, method=method.upper())
        for key, value in hdrs.items():
            req.add_header(key, value)
        try:
            resp = _OPENER.open(req, timeout=timeout)
            status = resp.status
            raw_headers = resp.headers
            payload = resp.read()
        except urllib.error.HTTPError as exc:
            # urllib raises on >=400; that is still a real response we want.
            status = exc.code
            raw_headers = exc.headers
            payload = exc.read()
        except urllib.error.URLError:
            raise

        cookies.update(_parse_cookies(raw_headers))
        headers_out = {k.lower(): v for k, v in raw_headers.items()}

        if status in (301, 302, 303, 307, 308) and seen < max_redirects:
            location = raw_headers.get("Location")
            if location:
                seen += 1
                current = urllib.parse.urljoin(current, location)
                if status in (301, 302, 303):
                    method, body = "GET", None
                    hdrs.pop("Content-Type", None)
                if cookies:
                    merged = dict(_cookie_header_to_dict(hdrs.get("Cookie", "")))
                    merged.update(cookies)
                    hdrs["Cookie"] = "; ".join(f"{k}={v}" for k, v in merged.items())
                continue

        if not raw:
            payload = _decode(payload, headers_out.get("content-encoding"))

        if status >= 500:
            raise HTTPError(f"upstream returned {status}", status, payload[:400])

        return Response(status, headers_out, payload, current, cookies)


def _cookie_header_to_dict(header):
    for part in header.split(";"):
        part = part.strip()
        if "=" in part:
            name, _, value = part.partition("=")
            yield name.strip(), value.strip()
