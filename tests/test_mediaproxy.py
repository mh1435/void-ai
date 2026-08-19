"""The media proxy is the one endpoint that fetches an arbitrary URL, so it is
the one place an open proxy could accidentally be created."""

import unittest
import urllib.parse

from loop import mediaproxy


class SigningTests(unittest.TestCase):

    def test_wrap_produces_a_signed_local_url(self):
        wrapped = mediaproxy.wrap("https://scontent.cdninstagram.com/a.jpg")
        self.assertTrue(wrapped.startswith("/media?"))
        query = urllib.parse.parse_qs(wrapped.split("?", 1)[1])
        self.assertEqual("https://scontent.cdninstagram.com/a.jpg", query["u"][0])
        self.assertEqual(24, len(query["s"][0]))

    def test_wrap_leaves_non_urls_alone(self):
        for value in ("", None, "/media?u=x&s=y", "not-a-url"):
            self.assertEqual(value, mediaproxy.wrap(value))

    def test_wrap_is_idempotent(self):
        once = mediaproxy.wrap("https://scontent.cdninstagram.com/a.jpg")
        self.assertEqual(once, mediaproxy.wrap(once))

    def test_an_unsigned_request_is_refused(self):
        status, _, _ = mediaproxy.fetch("https://scontent.cdninstagram.com/a.jpg", "")
        self.assertEqual(403, status)

    def test_a_signature_for_one_url_does_not_work_for_another(self):
        stolen = mediaproxy._sign("https://scontent.cdninstagram.com/a.jpg")
        status, _, _ = mediaproxy.fetch(
            "https://scontent.cdninstagram.com/b.jpg", stolen)
        self.assertEqual(403, status)


class AllowlistTests(unittest.TestCase):

    def test_instagram_cdn_hosts_are_allowed(self):
        for url in (
            "https://scontent-lhr8-1.cdninstagram.com/v/a.jpg",
            "https://instagram.fbey2-1.fna.fbcdn.net/v/a.jpg",
            "https://www.instagram.com/a.jpg",
            "https://cdninstagram.com/a.jpg",
        ):
            self.assertTrue(mediaproxy.host_allowed(url), url)

    def test_everything_else_is_refused(self):
        for url in (
            "https://evil.example.com/a.jpg",
            # Suffix confusion: the allowlisted name as a prefix of another domain.
            "https://cdninstagram.com.evil.net/a.jpg",
            "https://fbcdn.net.attacker.io/a.jpg",
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ):
            self.assertFalse(mediaproxy.host_allowed(url), url)

    def test_a_valid_signature_cannot_reach_a_disallowed_host(self):
        """Signing is not authorisation to fetch anything."""
        url = "http://169.254.169.254/latest/meta-data/"
        status, _, body = mediaproxy.fetch(url, mediaproxy._sign(url))
        self.assertEqual(403, status)
        self.assertIn(b"host not allowed", body)


class CacheTests(unittest.TestCase):

    def test_lru_evicts_the_least_recently_used(self):
        cache = mediaproxy._Cache(limit_bytes=1000)
        for key in ("a", "b", "c", "d", "e"):
            cache.put(key, b"x" * 200, "image/jpeg")
        self.assertEqual(1000, cache.size)

        cache.get("a")                      # touch, so 'b' becomes the oldest
        cache.put("f", b"x" * 200, "image/jpeg")

        self.assertIsNotNone(cache.get("a"), "a was touched and must survive")
        self.assertIsNone(cache.get("b"), "b was least recently used")
        self.assertIsNotNone(cache.get("f"))
        self.assertLessEqual(cache.size, 1000)

    def test_replacing_a_key_does_not_double_count_its_size(self):
        cache = mediaproxy._Cache(limit_bytes=1000)
        cache.put("a", b"x" * 200, "image/jpeg")
        cache.put("a", b"y" * 200, "image/jpeg")
        self.assertEqual(200, cache.size)

    def test_an_oversized_object_is_not_cached(self):
        cache = mediaproxy._Cache(limit_bytes=1000)
        cache.put("video", b"x" * 900, "video/mp4")
        self.assertIsNone(cache.get("video"))

    def test_a_zero_limit_disables_caching(self):
        cache = mediaproxy._Cache(limit_bytes=0)
        cache.put("a", b"x", "image/jpeg")
        self.assertIsNone(cache.get("a"))


if __name__ == "__main__":
    unittest.main()
