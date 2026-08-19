package dev.loop.core

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The only class in the app that touches the network.
 *
 * Two properties are load-bearing, and enforced here rather than promised in a
 * README:
 *
 *  1. Every request goes to the one configured server. [HostGuard] rejects
 *     anything else outright, so no code path — including image and video
 *     loading, which share this client — can leak a request to instagram.com
 *     and expose the device's IP.
 *  2. The app sends no device information. A fixed User-Agent, no advertising
 *     id, no device model, no locale. What reaches Instagram is decided by the
 *     server alone.
 */
class LoopApi(
    baseUrl: String,
    cookieStore: CookieStore,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    val base: HttpUrl = normaliseBase(baseUrl)

    private val cookieJar = LoopCookieJar(cookieStore)

    val client: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(HostGuard(base.host))
        .addInterceptor(FixedIdentity)
        // Media is large and links are often bad, so be patient on read but
        // impatient on connect: a dead host should fail fast, not hang.
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .callTimeout(90, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    // -- session ------------------------------------------------------------

    suspend fun session(): SessionState = get("api/session", SessionState.serializer())

    suspend fun unlock(code: String): Ok =
        post("api/session/gate", mapOf("code" to code), Ok.serializer())

    suspend fun login(username: String, password: String): LoginResult = post(
        "api/session/login",
        mapOf("username" to username, "password" to password),
        LoginResult.serializer(),
    )

    suspend fun twoFactor(username: String, identifier: String, code: String): LoginResult = post(
        "api/session/two-factor",
        mapOf("username" to username, "identifier" to identifier, "code" to code),
        LoginResult.serializer(),
    )

    suspend fun logout(): Ok =
        post("api/session/logout", emptyMap(), Ok.serializer()).also { cookieJar.clear() }

    // -- reading ------------------------------------------------------------

    suspend fun feed(maxId: String? = null): Page =
        get("api/feed", Page.serializer(), maxId?.let { "max_id" to it })

    suspend fun stories(): StoryTray = get("api/stories", StoryTray.serializer())

    suspend fun story(reelId: String): StoryReel =
        get("api/stories/$reelId", StoryReel.serializer())

    suspend fun explore(maxId: String? = null): Page =
        get("api/explore", Page.serializer(), maxId?.let { "max_id" to it })

    suspend fun reels(maxId: String? = null): Page =
        get("api/reels", Page.serializer(), maxId?.let { "max_id" to it })

    suspend fun profile(username: String): ProfilePage =
        get("api/user/$username", ProfilePage.serializer())

    suspend fun userFeed(userId: String, maxId: String? = null): Page =
        get("api/user/$userId/feed", Page.serializer(), maxId?.let { "max_id" to it })

    suspend fun post(id: String): Post = get("api/post/$id", Post.serializer())

    suspend fun comments(postId: String, minId: String? = null): CommentPage =
        get("api/post/$postId/comments", CommentPage.serializer(), minId?.let { "min_id" to it })

    suspend fun search(query: String): SearchResults =
        get("api/search", SearchResults.serializer(), "q" to query)

    suspend fun tag(name: String): TagPage = get("api/tag/$name", TagPage.serializer())

    suspend fun activity(): ActivityFeed = get("api/activity", ActivityFeed.serializer())

    suspend fun health(): Health = get("api/health", Health.serializer())

    // -- writing ------------------------------------------------------------

    suspend fun like(postId: String, on: Boolean): LikeResult =
        post("api/post/$postId/like", mapOf("on" to on), LikeResult.serializer())

    suspend fun save(postId: String, on: Boolean): SaveResult =
        post("api/post/$postId/save", mapOf("on" to on), SaveResult.serializer())

    suspend fun follow(userId: String, on: Boolean): FollowResult =
        post("api/user/$userId/follow", mapOf("on" to on), FollowResult.serializer())

    suspend fun addComment(postId: String, text: String): Comment =
        post("api/post/$postId/comments", mapOf("text" to text), Comment.serializer())

    /**
     * Absolute URL for a `/media?...` path the server handed us. Image and
     * video loaders take a string, so they need this rather than an HttpUrl.
     */
    fun mediaUrl(path: String?): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http")) return path
        return base.resolve(path)?.toString()
    }

    // -- plumbing -----------------------------------------------------------

    private suspend fun <T> get(
        path: String,
        serializer: DeserializationStrategy<T>,
        vararg params: Pair<String, String>?,
    ): T {
        val url = base.newBuilder().addPathSegments(path).apply {
            params.filterNotNull().forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        return execute(Request.Builder().url(url).get().build(), serializer)
    }

    private suspend fun <T> post(
        path: String,
        body: Map<String, Any>,
        serializer: DeserializationStrategy<T>,
    ): T {
        val url = base.newBuilder().addPathSegments(path).build()
        val request = Request.Builder().url(url)
            .post(encodeBody(body).toRequestBody(JSON_MEDIA))
            .build()
        return execute(request, serializer)
    }

    private suspend fun <T> execute(request: Request, serializer: DeserializationStrategy<T>): T =
        withContext(io) {
            val response = try {
                client.newCall(request).execute()
            } catch (e: IOException) {
                // Cannot reach *our own* server. This is the failure a user in a
                // blocked country hits most, so it never surfaces as "error".
                throw LoopError.Offline(e)
            }

            response.use { raw ->
                val text = raw.body?.string().orEmpty()
                if (!raw.isSuccessful) throw errorFrom(raw, text)
                try {
                    json.decodeFromString(serializer, text)
                } catch (e: Exception) {
                    throw LoopError.Server(
                        "The server sent something this app could not read. It is " +
                            "probably running a different version than this app expects.",
                    )
                }
            }
        }

    private fun encodeBody(body: Map<String, Any>): String = buildJsonObject {
        body.forEach { (key, value) ->
            when (value) {
                is Boolean -> put(key, value)
                is Number -> put(key, value)
                else -> put(key, value.toString())
            }
        }
    }.toString()

    private fun errorFrom(response: Response, text: String): LoopError {
        val body = runCatching { json.decodeFromString(ErrorBody.serializer(), text) }.getOrNull()
        if (body != null && body.error.isNotBlank()) {
            return LoopError.fromKind(body.kind, body.error)
        }
        return when (response.code) {
            401, 403 -> LoopError.LoginRequired()
            404 -> LoopError.NotFound("Not found.")
            429 -> LoopError.RateLimited("Too many requests. Wait a moment.")
            502, 503, 504 -> LoopError.Upstream(
                "Your server could not reach Instagram (HTTP ${response.code}).",
            )
            else -> LoopError.Server("Server error (HTTP ${response.code}).")
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        /** Accepts "example.com", "https://example.com", trailing slashes and so on. */
        fun normaliseBase(input: String): HttpUrl {
            val trimmed = input.trim()
            if (trimmed.isEmpty()) throw LoopError.Server("Enter your server address.")
            val withScheme = when {
                trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
                // Default to https. This app should never be talked into
                // plaintext by a hostname typed in a hurry.
                else -> "https://$trimmed"
            }
            // No trimming of trailing slashes before parsing: "https://" would
            // become "https:" and then parse as a host, sneaking an unusable
            // address past validation. Let the parser reject it, then root the
            // path and drop anything the user pasted after the host.
            val url = withScheme.toHttpUrlOrNull()
                ?: throw LoopError.Server("That does not look like a server address.")
            if (url.host.isBlank()) {
                throw LoopError.Server("That address has no server name in it.")
            }
            return url.newBuilder().encodedPath("/").query(null).fragment(null).build()
        }
    }
}

/** Rejects any request that is not addressed to the configured server. */
internal class HostGuard(private val host: String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val target = chain.request().url.host
        if (!target.equals(host, ignoreCase = true)) {
            throw IOException("Blocked a request to $target. This app only talks to $host.")
        }
        return chain.proceed(chain.request())
    }
}

/**
 * A fixed identity. OkHttp's default User-Agent leaks its version, and
 * anything device-derived would defeat the point of the app.
 */
internal object FixedIdentity : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response = chain.proceed(
        chain.request().newBuilder()
            .header("User-Agent", "Loop")
            .header("Accept-Language", "en-US,en;q=0.9")
            .build(),
    )
}
