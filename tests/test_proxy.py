"""The proxy is the one endpoint that fetches a URL a client chose, so it is
the one place an open proxy could accidentally be created."""

import unittest

from voidmusic import config, proxy

from .stub import FakeStream, Upstream, body_of


JSON = {"content-type": "application/json", "content-length": "13"}


class AllowlistTests(unittest.TestCase):

    def test_the_hosts_the_player_uses_are_allowed(self):
        for url in (
            "https://archive.org/metadata/nasa",
            "https://ia902703.us.archive.org/12/items/x/y.mp3",
            "https://coverartarchive.org/release/abc/front-250",
            "https://musicbrainz.org/ws/2/recording",
            "https://lrclib.net/api/get",
        ):
            self.assertTrue(proxy.host_allowed(url), url)

    def test_everything_else_is_refused(self):
        for url in (
            "https://evil.example/x",
            "http://169.254.169.254/latest/meta-data/",   # cloud metadata
            "https://localhost:8080/api/health",
        ):
            self.assertFalse(proxy.host_allowed(url), url)

    def test_a_lookalike_suffix_does_not_pass(self):
        # "notarchive.org" ends with "archive.org" as a *string*; the check is
        # on label boundaries, not characters.
        self.assertFalse(proxy.host_allowed("https://notarchive.org/x"))
        self.assertFalse(proxy.host_allowed("https://archive.org.evil.example/x"))

    def test_non_http_schemes_are_refused(self):
        for url in ("file:///etc/passwd", "gopher://archive.org/x",
                    "ftp://archive.org/x"):
            self.assertFalse(proxy.host_allowed(url), url)

    def test_fetching_a_refused_host_never_opens_a_connection(self):
        with Upstream() as up:
            result = proxy.fetch("https://evil.example/x")
        self.assertEqual(403, result.status)
        self.assertEqual([], up.calls)


class RedirectTests(unittest.TestCase):
    """archive.org answers a download with a redirect to a datanode, so
    redirects must be followed — but re-checked, or the allowlist is a
    suggestion."""

    def test_every_hop_is_checked_against_the_allowlist(self):
        with Upstream(FakeStream(200, JSON, b'{"ok": true}')) as up:
            proxy.fetch("https://archive.org/download/x/y.mp3")
        check = up.calls[0]["on_redirect"]
        self.assertTrue(check("https://ia800.us.archive.org/1/x/y.mp3"))
        self.assertFalse(check("https://evil.example/y.mp3"))


class TargetUrlTests(unittest.TestCase):

    def test_a_path_keeps_its_separators_and_escapes_the_rest(self):
        url = proxy.target_url("archive.org", "/download/item/A B #2.mp3", "")
        self.assertEqual(
            "https://archive.org/download/item/A%20B%20%232.mp3", url)

    def test_the_query_string_is_carried_through_untouched(self):
        url = proxy.target_url("archive.org", "/services/search/v1/scrape",
                               "q=collection%3Anetlabels&count=100")
        self.assertTrue(url.endswith("?q=collection%3Anetlabels&count=100"))

    def test_a_host_cannot_smuggle_a_different_target(self):
        # The router only ever hands us one path segment as the host, but be
        # certain that a crafted one still resolves to a refused host.
        self.assertFalse(proxy.host_allowed(
            proxy.target_url("evil.example", "/x", "")))


class CacheTests(unittest.TestCase):

    def setUp(self):
        proxy.cache.clear()

    def test_a_small_body_is_served_from_cache_the_second_time(self):
        with Upstream(FakeStream(200, JSON, b'{"ok": true}')) as up:
            first = proxy.fetch("https://archive.org/metadata/nasa")
            self.assertEqual(b'{"ok": true}', body_of(first))
            second = proxy.fetch("https://archive.org/metadata/nasa")
        self.assertEqual(1, len(up.calls), "second fetch went upstream")
        self.assertEqual(b'{"ok": true}', body_of(second))
        self.assertEqual("hit", second.headers["X-Void-Cache"])
        self.assertEqual("miss", first.headers["X-Void-Cache"])

    def test_a_track_sized_body_is_streamed_and_never_cached(self):
        big = b"\0" * 4096
        headers = {"content-type": "audio/mpeg",
                   "content-length": str(proxy.CACHEABLE_BYTES + 1)}
        with Upstream(FakeStream(200, headers, big),
                      FakeStream(200, headers, big)) as up:
            first = proxy.fetch("https://archive.org/download/x/y.mp3")
            self.assertIsNotNone(first.chunks, "a large body must stream")
            self.assertEqual(big, body_of(first))
            proxy.fetch("https://archive.org/download/x/y.mp3")
        self.assertEqual(2, len(up.calls))

    def test_a_ranged_request_is_neither_cached_nor_served_from_cache(self):
        with Upstream(FakeStream(200, JSON, b'{"ok": true}'),
                      FakeStream(206, {"content-type": "audio/mpeg",
                                       "content-range": "bytes 0-3/12"},
                                 b"abcd")) as up:
            proxy.fetch("https://archive.org/download/x/y.mp3")
            ranged = proxy.fetch("https://archive.org/download/x/y.mp3",
                                 range_header="bytes=0-3")
        self.assertEqual(2, len(up.calls))
        self.assertEqual("bytes=0-3", up.calls[1]["headers"]["Range"])
        self.assertEqual(206, ranged.status)
        self.assertEqual("bytes 0-3/12", ranged.headers["Content-Range"])

    def test_a_head_does_not_cache_its_empty_body(self):
        with Upstream(FakeStream(200, JSON, b""),
                      FakeStream(200, JSON, b'{"ok": true}')) as up:
            proxy.fetch("https://archive.org/metadata/nasa", method="HEAD")
            after = proxy.fetch("https://archive.org/metadata/nasa")
        self.assertEqual(2, len(up.calls))
        self.assertEqual(b'{"ok": true}', body_of(after))

    def test_the_cache_evicts_oldest_first_when_full(self):
        small = proxy._Cache(400)
        for i in range(5):
            small.put(f"u{i}", b"\0" * 100, {})
        self.assertLessEqual(small.size, 400)
        self.assertIsNone(small.get("u0"))
        self.assertIsNotNone(small.get("u4"))

    def test_no_single_item_may_take_more_than_a_quarter_of_the_cache(self):
        # Otherwise one lucky-sized response evicts everything else worth
        # holding on to.
        small = proxy._Cache(400)
        small.put("big", b"\0" * 101, {})
        self.assertIsNone(small.get("big"))
        small.put("fits", b"\0" * 100, {})
        self.assertIsNotNone(small.get("fits"))

    def test_caching_can_be_turned_off_entirely(self):
        off = proxy._Cache(0)
        off.put("u", b"x", {})
        self.assertIsNone(off.get("u"))


class HeaderTests(unittest.TestCase):

    def setUp(self):
        proxy.cache.clear()

    def test_hop_by_hop_headers_are_not_forwarded(self):
        headers = {
            "content-type": "audio/mpeg",
            "content-length": "4",
            "transfer-encoding": "chunked",
            "content-encoding": "gzip",
            "connection": "keep-alive",
            "set-cookie": "track=me",
        }
        with Upstream(FakeStream(200, headers, b"abcd")):
            result = proxy.fetch("https://archive.org/download/x/y.mp3")
        for banned in ("Transfer-Encoding", "Content-Encoding", "Connection",
                       "Set-Cookie"):
            self.assertNotIn(banned, result.headers)
        self.assertEqual("audio/mpeg", result.headers["Content-Type"])

    def test_range_support_is_advertised_so_seeking_works(self):
        with Upstream(FakeStream(200, JSON, b'{"ok": true}')):
            result = proxy.fetch("https://archive.org/metadata/nasa")
        self.assertEqual("bytes", result.headers["Accept-Ranges"])


if __name__ == "__main__":
    unittest.main()
