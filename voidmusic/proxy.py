"""The reverse proxy that makes a blocked catalogue reachable.

Everything the player fetches — item metadata, search results, cover art,
lyrics, and the audio bytes themselves — can be routed through here, so a
device on a filtered network only ever resolves one hostname: this server's.

Two rules keep it from being an open proxy that strangers can point anywhere:

  * the target host must be on the allowlist in config.ALLOWED_HOSTS, and
  * every redirect hop is re-checked against that same list, because
    archive.org answers a download with a redirect to a datanode and an
    unchecked hop is a hole exactly as big as an unchecked request.
"""

import collections
import threading
import time
import urllib.parse

from . import config, netclient

# Bodies at or under this size are worth keeping in memory; anything larger is
# streamed straight through to the client.
CACHEABLE_BYTES = config.CACHE_MAX_ITEM_KB * 1024

# What we copy from upstream onto our own response. It is an allowlist rather
# than a denylist so that hop-by-hop headers (Connection, Transfer-Encoding,
# Content-Encoding...) can never leak through and describe our response
# wrongly. Content-Length is forwarded because a streamed body has no other
# way to state its size — a buffered one has its own length written over this
# by the handler, and streams ask upstream for identity encoding so the count
# is of the bytes we actually pass on.
_PASS_THROUGH = {
    "content-type": "Content-Type",
    "content-length": "Content-Length",
    "content-range": "Content-Range",
    "accept-ranges": "Accept-Ranges",
    "etag": "ETag",
    "last-modified": "Last-Modified",
}


def host_allowed(url):
    """True when `url` names a host this server is willing to fetch."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    host = (parts.hostname or "").lower()
    if not host:
        return False
    return any(host == allowed or host.endswith("." + allowed)
               for allowed in config.ALLOWED_HOSTS)


def target_url(host, path, query):
    """Build the upstream URL for a /via/<host>/<path> request."""
    host = (host or "").lower()
    # A path is already percent-decoded by the router; re-encode it, leaving
    # the separators alone, so a track called "A/B #2.mp3" survives the trip.
    quoted = urllib.parse.quote(path or "", safe="/:@!$&'()*+,;=~")
    url = f"https://{host}/{quoted.lstrip('/')}"
    if query:
        url += "?" + query
    return url


class _Cache:
    """Small LRU over upstream responses, bounded by total size not count."""

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
            body, headers, stored = hit
            if time.time() - stored > 21600:
                del self._data[key]
                self.size -= len(body)
                return None
            self._data.move_to_end(key)
            return body, headers

    def put(self, key, body, headers):
        if not self.limit or len(body) > min(CACHEABLE_BYTES, self.limit // 4):
            return
        with self._lock:
            if key in self._data:
                self.size -= len(self._data[key][0])
            self._data[key] = (body, headers, time.time())
            self._data.move_to_end(key)
            self.size += len(body)
            while self.size > self.limit and self._data:
                _, (old, _h, _t) = self._data.popitem(last=False)
                self.size -= len(old)

    def clear(self):
        with self._lock:
            self._data.clear()
            self.size = 0

    def stats(self):
        with self._lock:
            return {"items": len(self._data), "bytes": self.size,
                    "limit": self.limit}


cache = _Cache(config.CACHE_MB * 1024 * 1024)


class Proxied:
    """One proxied response: either `body` bytes, or `chunks` to stream."""

    __slots__ = ("status", "headers", "body", "chunks")

    def __init__(self, status, headers, body=None, chunks=None):
        self.status = status
        self.headers = headers
        self.body = body
        self.chunks = chunks


def _clean_headers(upstream, cached=False):
    out = {}
    for key, name in _PASS_THROUGH.items():
        if key in upstream:
            out[name] = upstream[key]
    out.setdefault("Content-Type", "application/octet-stream")
    out.setdefault("Accept-Ranges", "bytes")
    # Archive URLs are content-addressed and the metadata behind them changes
    # rarely; a day of browser caching saves the slow hop on a bad link.
    out["Cache-Control"] = upstream.get("cache-control", "public, max-age=3600")
    out["X-Void-Cache"] = "hit" if cached else "miss"
    return out


def fetch(url, *, range_header=None, method="GET"):
    """Fetch `url` for a client. Returns a Proxied, or raises HTTPError."""
    if not host_allowed(url):
        return Proxied(403, {"Content-Type": "text/plain; charset=utf-8"},
                       b"That host is not on this server's allowlist.")

    # Ranged requests are how <audio> seeks. They are never cached whole and
    # never served from a cache entry, which holds the complete body. A HEAD
    # has no body to cache, and storing its empty one would answer every
    # later GET for the same URL with nothing.
    cacheable = method == "GET" and not range_header
    if cacheable:
        hit = cache.get(url)
        if hit:
            body, headers = hit
            out = dict(headers)
            out["X-Void-Cache"] = "hit"
            return Proxied(200, out, body=body)

    upstream = netclient.stream(
        method, url,
        headers={"Range": range_header, "Accept": "*/*"},
        on_redirect=lambda hop: host_allowed(hop),
    )

    headers = _clean_headers(upstream.headers)
    try:
        length = int(upstream.headers.get("content-length", ""))
    except ValueError:
        length = None

    # Small and complete: read it, cache it, hand it over. Anything else —
    # a track, or a body of unknown length — is streamed.
    if (cacheable and upstream.ok and length is not None
            and length <= CACHEABLE_BYTES):
        body = upstream.body.read(CACHEABLE_BYTES + 1)
        upstream.close()
        cache.put(url, body, headers)
        out = dict(headers)
        return Proxied(upstream.status, out, body=body)

    return Proxied(upstream.status, headers, chunks=upstream.chunks())
