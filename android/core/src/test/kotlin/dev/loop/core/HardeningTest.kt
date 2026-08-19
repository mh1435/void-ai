package dev.loop.core

import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/** The properties that make this app worth using rather than the official one. */
class HardeningTest {

    @Test
    fun `a bare hostname is upgraded to https, never left as plaintext`() {
        assertEquals("https://loop.example.com/", LoopApi.normaliseBase("loop.example.com").toString())
        assertEquals("https://loop.example.com/", LoopApi.normaliseBase("  loop.example.com/  ").toString())
        assertEquals("https://loop.example.com/", LoopApi.normaliseBase("https://loop.example.com").toString())
        // A deliberate http:// (a LAN test server) is honoured, not silently rewritten.
        assertEquals("http://192.168.1.4:8080/", LoopApi.normaliseBase("http://192.168.1.4:8080").toString())
        // Any path the user pastes is discarded; the API is always rooted.
        assertEquals("https://loop.example.com/", LoopApi.normaliseBase("https://loop.example.com/u/alice").toString())
    }

    @Test
    fun `a bind address is rejected with an explanation, not a network error`() {
        // These get copied out of the server's own startup line.
        for (bad in listOf("0.0.0.0:3000", "http://0.0.0.0:8080", "0.0.0.0", "[::]:8080")) {
            try {
                LoopApi.normaliseBase(bad)
                fail("expected '$bad' to be rejected")
            } catch (e: LoopError) {
                assertTrue(
                    "message should explain the problem, was: ${e.message}",
                    e.message!!.contains("listen on everything"),
                )
            }
        }
        // A real address that merely looks similar must still work.
        assertEquals(
            "https://10.0.0.5:3000/",
            LoopApi.normaliseBase("https://10.0.0.5:3000").toString(),
        )
    }

    @Test
    fun `an unusable address is rejected with a readable message`() {
        for (bad in listOf("", "   ", "https://")) {
            try {
                LoopApi.normaliseBase(bad)
                fail("expected '$bad' to be rejected")
            } catch (e: LoopError) {
                assertTrue(e.message!!.isNotBlank())
            }
        }
    }

    @Test
    fun `the host guard blocks any request that is not to the configured server`() {
        val client = OkHttpClient.Builder()
            .addInterceptor(HostGuard("loop.example.com"))
            .build()

        for (leak in listOf(
            "https://www.instagram.com/api/v1/feed/timeline/",
            "https://scontent-lhr8-1.cdninstagram.com/v/photo.jpg",
            "https://graph.facebook.com/x",
        )) {
            try {
                client.newCall(Request.Builder().url(leak).build()).execute()
                fail("a request to $leak was allowed to leave the device")
            } catch (e: IOException) {
                assertTrue(e.message!!.contains("Blocked a request"))
            }
        }
    }

    @Test
    fun `the request identity carries nothing about the device`() {
        val request = Request.Builder().url("https://loop.example.com/").build()
        val sent = FixedIdentity.intercept(RecordingChain(request)).request.headers

        assertEquals("Loop", sent["User-Agent"])
        val joined = sent.toString().lowercase()
        for (leak in listOf("android", "sdk_int", "model", "okhttp/", "dalvik")) {
            assertFalse("header set leaks '$leak': $joined", joined.contains(leak))
        }
    }

    @Test
    fun `cookies survive a restart and an expiry clears them`() {
        val store = InMemoryCookieStore()
        val jar = LoopCookieJar(store)
        val url = okhttp3.HttpUrl.Builder().scheme("https").host("loop.example.com").build()

        jar.saveFromResponse(
            url,
            listOf(
                okhttp3.Cookie.Builder().name("loop_sid").value("tok")
                    .domain("loop.example.com").path("/")
                    .expiresAt(System.currentTimeMillis() + 86_400_000).build(),
            ),
        )
        assertEquals(mapOf("loop_sid" to "tok"), store.load())

        // A new jar over the same store is what happens after an app restart.
        assertEquals("tok", LoopCookieJar(store).loadForRequest(url).single().value)

        jar.saveFromResponse(
            url,
            listOf(
                okhttp3.Cookie.Builder().name("loop_sid").value("gone")
                    .domain("loop.example.com").path("/")
                    .expiresAt(1L).build(),
            ),
        )
        assertTrue("an expired cookie must be dropped, not replayed", store.load().isEmpty())
    }
}

/** Minimal Interceptor.Chain so the identity interceptor can be tested alone. */
private class RecordingChain(private val request: Request) : okhttp3.Interceptor.Chain {
    lateinit var seen: Request
    override fun request(): Request = request
    override fun proceed(request: Request): okhttp3.Response {
        seen = request
        return okhttp3.Response.Builder()
            .request(request)
            .protocol(okhttp3.Protocol.HTTP_1_1)
            .code(200).message("OK")
            .build()
    }
    override fun connection() = null
    override fun call(): okhttp3.Call = throw UnsupportedOperationException()
    override fun connectTimeoutMillis() = 0
    override fun withConnectTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
    override fun readTimeoutMillis() = 0
    override fun withReadTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
    override fun writeTimeoutMillis() = 0
    override fun withWriteTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
}
