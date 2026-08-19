"""Proxy for Instagram's CDN.

Photos and videos live on scontent-*.cdninstagram.com / *.fbcdn.net, which are
blocked in the same places instagram.com is. So every media URL handed to the
browser is rewritten to point back here, and this module fetches the bytes.

URLs are HMAC-signed so this cannot be used as a general-purpose open image
proxy by anyone who finds the endpoint.
"""

import collections
import hashlib
import hmac
import threading
import time
import urllib.parse

from . import config, netclient

# Only these hosts are ever fetched, signature or not.
ALLOWED_SUFFIXES = (
    ".cdninstagram.com",
    ".fbcdn.net",
    "instagram.com",
    "cdninstagram.com",
)


def _sign(url):
    return hmac.new(
        config.SECRET.encode(), url.encode(), hashlib.sha256
    ).hexdigest()[:24]


def wrap(url):
    """Rewrite a CDN URL into a local, signed /media URL."""
    if not url or not isinstance(url, str):
        return url
    if url.startswith("/media?"):
        return url
    if not url.startswith("http"):
        return url
    query = urllib.parse.urlencode({"u": url, "s": _sign(url)})
    return f"/media?{query}"


def host_allowed(url):
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return any(host == s.lstrip(".") or host.endswith(s)
               for s in ALLOWED_SUFFIXES)


class _Cache:
    """Small LRU over CDN bytes, bounded by total size rather than count."""

    def __init__(self, limit_bytes):
        self.limit = limit_bytes
        self.size = 0
        self._data = collections.OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        if not self.limit:
            return None
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            body, ctype, stored = hit
            if time.time() - stored > 21600:
                del self._data[key]
                self.size -= len(body)
                return None
            self._data.move_to_end(key)
            return body, ctype

    def put(self, key, body, ctype):
        if not self.limit or len(body) > self.limit // 4:
            return
        with self._lock:
            if key in self._data:
                self.size -= len(self._data[key][0])
            self._data[key] = (body, ctype, time.time())
            self._data.move_to_end(key)
            self.size += len(body)
            while self.size > self.limit and self._data:
                _, (old, _c, _t) = self._data.popitem(last=False)
                self.size -= len(old)


_cache = _Cache(config.MEDIA_CACHE_MB * 1024 * 1024)


def fetch(url, signature, range_header=None):
    """Fetch one CDN object. Returns (status, headers, body)."""
    if not hmac.compare_digest(signature or "", _sign(url)):
        return 403, {"Content-Type": "text/plain"}, b"bad signature"
    if not host_allowed(url):
        return 403, {"Content-Type": "text/plain"}, b"host not allowed"

    # Range requests are how <video> seeks; they must not be cached whole.
    if range_header:
        return _passthrough(url, range_header)

    cached = _cache.get(url)
    if cached:
        body, ctype = cached
        return 200, _headers(ctype, len(body), cached=True), body

    resp = netclient.request(
        "GET", url,
        headers={"Referer": "https://www.instagram.com/", "Accept": "*/*"},
        raw=True,
    )
    if not resp.ok:
        return resp.status, {"Content-Type": "text/plain"}, b"upstream error"

    ctype = resp.headers.get("content-type", "application/octet-stream")
    _cache.put(url, resp.body, ctype)
    return 200, _headers(ctype, len(resp.body)), resp.body


def _passthrough(url, range_header):
    resp = netclient.request(
        "GET", url,
        headers={
            "Referer": "https://www.instagram.com/",
            "Range": range_header,
            "Accept": "*/*",
        },
        raw=True,
        retries=0,
    )
    headers = {
        "Content-Type": resp.headers.get("content-type", "video/mp4"),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
    }
    for key in ("content-range", "content-length"):
        if key in resp.headers:
            headers[key.title()] = resp.headers[key]
    return resp.status, headers, resp.body


def _headers(ctype, length, cached=False):
    return {
        "Content-Type": ctype,
        "Content-Length": str(length),
        "Accept-Ranges": "bytes",
        # CDN URLs are already content-addressed and expire on their own.
        "Cache-Control": "public, max-age=86400",
        "X-Loop-Cache": "hit" if cached else "miss",
    }
