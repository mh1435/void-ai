package com.voidmusic.app.data.backend

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URI

/**
 * The optional self-hosted backend — a direct Kotlin port of js/backend.js.
 *
 * Everything in this app works with no server at all: requests go straight
 * to archive.org. That stops working in exactly one situation — every route
 * to the catalogue is filtered on this network — and no client-side
 * cleverness fixes it, because a blocked host is blocked for every app on
 * the device. So the user runs `server.py` (voidmusic/) somewhere the Archive
 * is reachable, and this class points requests at it instead:
 *
 *     https://archive.org/metadata/x  ->  https://their.server/via/archive.org/metadata/x
 *
 * which is the whole integration: only the prefix changes.
 */
enum class BackendStatus { OFF, CHECKING, OK, ERROR }

data class BackendState(
    val base: String = "",
    val code: String = "",
    /** Route everything through the server rather than racing it against direct hosts. */
    val exclusive: Boolean = true,
    val status: BackendStatus = BackendStatus.OFF,
    val detail: String = "",
) {
    val active: Boolean get() = base.isNotEmpty() && status == BackendStatus.OK
}

@Serializable
data class HealthResponse(
    val app: String = "",
    @SerialName("gate_required") val gateRequired: Boolean = false,
    @SerialName("gate_open") val gateOpen: Boolean = false,
)

class BackendRouter(private val http: okhttp3.OkHttpClient, private val json: kotlinx.serialization.json.Json) {

    val state = MutableStateFlow(BackendState())

    /** Trim a user-typed URL down to a bare origin. Throws on nonsense, same as the JS. */
    fun normalise(raw: String): String {
        val text = raw.trim()
        require(text.isNotEmpty())
        val withScheme = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(text)) text else "https://$text"
        val url = withScheme.toHttpUrlOrNull() ?: error("Not a valid URL")
        return "${url.scheme}://${url.host}${if (url.port !in listOf(80, 443)) ":${url.port}" else ""}"
    }

    /** The base URL to use when talking to [host]. */
    fun originFor(host: String): String =
        if (state.value.active) "${state.value.base}/via/$host" else "https://$host"

    /**
     * Rewrite an absolute URL to go through the server, if one is in use.
     * Deliberately unsigned — [sign] is always the caller's last step.
     */
    fun reroute(url: String): String {
        val s = state.value
        if (!s.active) return url
        return try {
            val parsed = URI(url)
            val origin = "${parsed.scheme}://${parsed.host}"
            if (origin == s.base) url
            else "${s.base}/via/${parsed.host}${parsed.path}${parsed.query?.let { "?$it" } ?: ""}"
        } catch (_: Exception) {
            url
        }
    }

    /**
     * Add the access code to a URL pointing at our server. Travels in the
     * query string, not a header: ExoPlayer's data source cannot attach a
     * custom header to every redirect a stream might follow, and a header
     * would force a CORS-style preflight this app cannot spare per track.
     */
    fun sign(url: String): String {
        val s = state.value
        if (s.code.isEmpty() || !url.startsWith("${s.base}/via/")) return url
        val sep = if (url.contains('?')) '&' else '?'
        return "$url$sep" + "code=" + java.net.URLEncoder.encode(s.code, "UTF-8")
    }

    /**
     * Order the candidate URLs for one resource — direct routes first,
     * proxied kept as the catch-all, unless exclusive mode drops direct
     * routes entirely.
     */
    fun route(urls: List<String>): List<String> {
        val s = state.value
        if (!s.active) return urls
        val viaServer = urls.map(::reroute)
        return if (s.exclusive) viaServer.distinct() else (urls + viaServer).distinct()
    }

    /** Ask a server what it is. A plain static host answers something other than our shape here. */
    suspend fun check(base: String, code: String): HealthResponse {
        val url = "$base/api/health" + (if (code.isNotEmpty()) "?code=${java.net.URLEncoder.encode(code, "UTF-8")}" else "")
        val request = okhttp3.Request.Builder().url(url).build()
        val body = kotlinx.coroutines.suspendCancellableCoroutine<String> { cont ->
            val call = http.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = cont.resumeWith(Result.failure(e))
                override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) =
                    cont.resumeWith(Result.success(response.body?.string().orEmpty()))
            })
        }
        val health = json.decodeFromString(HealthResponse.serializer(), body)
        require(health.app == "void-music") { "That URL answered, but it is not a Void Music server." }
        return health
    }

    /** Point the app at [base], verifying it first. */
    suspend fun connect(base: String, code: String) {
        state.value = state.value.copy(status = BackendStatus.CHECKING)
        try {
            val health = check(base, code)
            if (health.gateRequired && !health.gateOpen) {
                state.value = state.value.copy(status = BackendStatus.ERROR, detail = "connected, but the access code is wrong")
                error("This server requires an access code.")
            }
            state.value = BackendState(base = base, code = code, status = BackendStatus.OK, detail = "connected to $base")
        } catch (e: Exception) {
            state.value = state.value.copy(status = BackendStatus.ERROR, detail = e.message ?: "unreachable")
            throw e
        }
    }

    fun disconnect() {
        state.value = BackendState()
    }
}
