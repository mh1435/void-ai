package dev.loop.core

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection

class LoopApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: LoopApi
    private lateinit var cookies: InMemoryCookieStore

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        cookies = InMemoryCookieStore()
        api = LoopApi(server.url("/").toString(), cookies)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun respond(body: String, code: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    @Test
    fun `get builds the right path and query`() = runTest {
        respond("""{"posts":[],"next_max_id":null}""")
        api.feed(maxId = "QVFB abc/def")

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/feed?max_id=QVFB%20abc%2Fdef", request.path)
    }

    @Test
    fun `a null cursor is omitted rather than sent as the string null`() = runTest {
        respond("""{"posts":[]}""")
        api.feed(null)
        assertEquals("/api/feed", server.takeRequest().path)
    }

    @Test
    fun `post sends json and booleans stay booleans`() = runTest {
        respond("""{"liked":true}""")
        val result = api.like("123", true)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/post/123/like", request.path)
        assertEquals("""{"on":true}""", request.body.readUtf8())
        assertTrue(result.liked)
    }

    @Test
    fun `credentials are sent as json, not as a query string`() = runTest {
        respond("""{"status":"ok","user_id":"7","username":"alice"}""")
        api.login("alice", "pa\"ss word")

        val request = server.takeRequest()
        // A password must never end up in a URL, where it would land in logs.
        assertFalse(request.path!!.contains("pa"))
        assertEquals("""{"username":"alice","password":"pa\"ss word"}""", request.body.readUtf8())
    }

    @Test
    fun `server error kinds map to typed errors`() = runTest {
        val cases = listOf(
            "login_required" to LoopError.LoginRequired::class,
            "gate" to LoopError.Gate::class,
            "challenge" to LoopError.Challenge::class,
            "rate_limited" to LoopError.RateLimited::class,
            "upstream_unreachable" to LoopError.Upstream::class,
            "not_found" to LoopError.NotFound::class,
            "bad_password" to LoopError.BadCredentials::class,
            "something_new" to LoopError.Server::class,
        )
        for ((kind, expected) in cases) {
            respond("""{"error":"nope","kind":"$kind"}""", 400)
            try {
                api.session()
                fail("expected $kind to raise")
            } catch (e: LoopError) {
                assertEquals(kind, expected, e::class)
                assertEquals("nope", e.message)
            }
        }
    }

    @Test
    fun `auth failures are flagged so the ui can bounce to sign-in`() = runTest {
        respond("""{"error":"x","kind":"login_required"}""", 401)
        try {
            api.feed()
            fail("expected failure")
        } catch (e: LoopError) {
            assertTrue(e.isAuthFailure)
        }
        assertFalse(LoopError.Upstream("x").isAuthFailure)
    }

    @Test
    fun `a non-json error page still produces a useful message`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(HttpURLConnection.HTTP_BAD_GATEWAY)
                .setHeader("Content-Type", "text/html")
                .setBody("<html>502 Bad Gateway</html>"),
        )
        try {
            api.feed()
            fail("expected failure")
        } catch (e: LoopError.Upstream) {
            assertTrue(e.message!!.contains("could not reach Instagram"))
        }
    }

    @Test
    fun `an unreachable server reports as offline, not as a server error`() = runTest {
        server.shutdown()
        try {
            api.session()
            fail("expected failure")
        } catch (e: LoopError.Offline) {
            assertTrue(e.message!!.contains("Cannot reach your Loop server"))
        }
    }

    @Test
    fun `malformed json is reported as a version mismatch`() = runTest {
        respond("""{"posts": [ this is not json """)
        try {
            api.feed()
            fail("expected failure")
        } catch (e: LoopError.Server) {
            assertTrue(e.message!!.contains("could not read"))
        }
    }

    @Test
    fun `the session cookie is stored and replayed`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setHeader("Set-Cookie", "loop_sid=abc123; Path=/; HttpOnly")
                .setBody("""{"authenticated":false}"""),
        )
        api.session()
        assertEquals(mapOf("loop_sid" to "abc123"), cookies.load())

        respond("""{"posts":[]}""")
        api.feed()
        server.takeRequest()
        assertEquals("loop_sid=abc123", server.takeRequest().getHeader("Cookie"))
    }

    @Test
    fun `logout drops the stored session`() = runTest {
        cookies.save(mapOf("loop_sid" to "abc123"))
        val fresh = LoopApi(server.url("/").toString(), cookies)
        respond("""{"ok":true}""")
        fresh.logout()
        assertTrue("a stale token must not survive logout", cookies.load().isEmpty())
    }

    @Test
    fun `media urls resolve against the configured server`() {
        val url = api.mediaUrl("/media?u=https%3A%2F%2Fx.com%2Fa.jpg&s=sig")
        assertTrue(url!!.startsWith(server.url("/").toString().trimEnd('/')))
        assertTrue(url.contains("/media?u="))
        assertEquals(null, api.mediaUrl(null))
        assertEquals(null, api.mediaUrl(""))
    }
}
