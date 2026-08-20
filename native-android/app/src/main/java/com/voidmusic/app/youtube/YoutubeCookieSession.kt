package com.voidmusic.app.youtube

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Reading a YouTube Music library through a signed-in browser session,
 * instead of a registered OAuth client — a Kotlin port of the working
 * YoutubeCookieSession.java, kept exactly as honest about its tradeoffs.
 *
 * What this is, plainly: the official YouTube Data API has no method for
 * "my liked songs" or "my library playlists" usable by a personal,
 * unpublished app without registering an OAuth client — real friction for
 * someone sideloading an app with no build machine handy. What
 * music.youtube.com's own web client uses instead is not a public API: it
 * is the same internal "innertube" endpoint the page itself calls,
 * authenticated by attaching the session's own cookies plus a request
 * signature (SAPISIDHASH) computed from one of them.
 *
 * This is NOT the official, documented way to do this. Google could change
 * the response shape or start rejecting this kind of client at any time,
 * with no version to pin against — [YoutubeOAuthClient] is the
 * fully-supported alternative for exactly that reason. This class exists
 * because the registered-client path is real friction for this app's
 * audience, and the tradeoff is left to them: it only runs when someone
 * chooses "Sign in with YouTube" over the Cloud Console setup.
 */
class YoutubeCookieSession(context: Context, private val http: OkHttpClient) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("void_yt_cookie", Context.MODE_PRIVATE)

    companion object {
        private const val ORIGIN = "https://music.youtube.com"
        // The public web key music.youtube.com's own page embeds — not a
        // secret, widely referenced across community YouTube Music clients.
        // Unverifiable as "current" from a sandbox with no network access to
        // youtube.com; flag this first if auth starts failing outright.
        private const val API_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30"
        private val BROWSE_ENDPOINT = "$ORIGIN/youtubei/v1/browse?key=$API_KEY&prettyPrint=false"
        private val SEARCH_ENDPOINT = "$ORIGIN/youtubei/v1/search?key=$API_KEY&prettyPrint=false"
        private const val USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }

    data class Item(val id: String, val title: String, val subtitle: String, val isPlaylist: Boolean)

    /** Why the most recent call came back empty; "" once one that found something. */
    @Volatile var lastDiagnostic: String = ""
        private set

    fun signedIn(): Boolean = sapisidOf(cookie()) != null
    fun cookie(): String = prefs.getString("cookie", "").orEmpty()
    fun accountLabel(): String = prefs.getString("account", "").orEmpty()
    fun setAccountLabel(name: String) { prefs.edit().putString("account", name).apply() }
    fun signOut() { prefs.edit().remove("cookie").remove("account").apply() }

    /** Store a cookie header, however it arrived. Returns an error message, or null on success. */
    fun adopt(raw: String): String? {
        val cleaned = clean(raw)
        if (sapisidOf(cleaned) == null) {
            return "That does not look like a signed-in YouTube session — no SAPISID cookie in it. " +
                "Copy the whole 'cookie' request header from a signed-in tab, not just one value."
        }
        prefs.edit().putString("cookie", cleaned).apply()
        return null
    }

    private fun clean(raw: String): String {
        var s = raw.trim()
        if (s.startsWith("cookie:", ignoreCase = true)) s = s.substring(7).trim()
        if (s.length >= 2 && ((s.first() == '"' && s.last() == '"') || (s.first() == '\'' && s.last() == '\''))) {
            s = s.substring(1, s.length - 1).trim()
        }
        if (s.contains('\n') || s.contains('\r')) s = s.split(Regex("[\\r\\n]+")).joinToString("; ")
        return s
    }

    private fun sapisidOf(cookieHeader: String): String? {
        for (part in cookieHeader.split(';')) {
            val p = part.trim()
            if (p.startsWith("SAPISID=")) return p.substring(8)
            if (p.startsWith("__Secure-3PAPISID=")) return p.substring(19)
        }
        return null
    }

    /** SHA1("<unix-seconds> <SAPISID> <origin>") — Google's own SAPISIDHASH auth scheme. */
    private fun sapisidHash(sapisid: String): String {
        val ts = System.currentTimeMillis() / 1000
        val input = "$ts $sapisid $ORIGIN"
        val digest = MessageDigest.getInstance("SHA-1").digest(input.toByteArray(Charsets.UTF_8))
        val hex = digest.joinToString("") { "%02x".format(it) }
        return "SAPISIDHASH ${ts}_$hex"
    }

    /** "Your library" playlists, including Liked Music. */
    suspend fun libraryPlaylists(): List<Item> =
        fetch(BROWSE_ENDPOINT, baseBody().apply { put("browseId", "FEmusic_liked_playlists") }, wantPlaylists = true)

    /** The tracks in any playlist by id — innertube addresses it as "VL" + id. */
    suspend fun playlistTracks(playlistId: String): List<Item> {
        val browseId = if (playlistId.startsWith("VL")) playlistId else "VL$playlistId"
        return fetch(BROWSE_ENDPOINT, baseBody().apply { put("browseId", browseId) }, wantPlaylists = false)
    }

    /** Search YouTube Music itself. */
    suspend fun search(query: String): List<Item> {
        val body = baseBody().apply {
            put("query", query)
            // "Songs" filter param, from YouTube Music's own request shape.
            put("params", "EgWKAQIIAWoKEAMQBBAJEAoQBQ==")
        }
        return fetch(SEARCH_ENDPOINT, body, wantPlaylists = false)
    }

    private fun baseBody(): JSONObject = JSONObject().apply {
        put("context", JSONObject().apply {
            put("client", JSONObject().apply {
                put("clientName", "WEB_REMIX")
                put("clientVersion", "1.20260101.01.00")
                put("hl", "en")
                put("gl", "US")
            })
        })
    }

    private suspend fun fetch(url: String, body: JSONObject, wantPlaylists: Boolean): List<Item> {
        val response = post(url, body) ?: return emptyList() // post() already set lastDiagnostic
        val items = scanForItems(response, wantPlaylists)
        lastDiagnostic = if (items.isEmpty())
            "Signed in and got a reply (${response.toString().length} bytes) but the scanner found " +
                "nothing playable in it. Shape: ${keySkeleton(response, 0)}"
        else ""
        return items
    }

    private suspend fun post(url: String, body: JSONObject): JSONObject? = withContext(Dispatchers.IO) {
        val cookieHeader = cookie()
        val sapisid = sapisidOf(cookieHeader)
        if (sapisid == null) {
            lastDiagnostic = "No signed-in session stored"
            return@withContext null
        }
        val request = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .header("Cookie", cookieHeader)
            .header("Authorization", sapisidHash(sapisid))
            .header("Origin", ORIGIN)
            .header("X-Origin", ORIGIN)
            .header("X-Goog-AuthUser", "0")
            .header("User-Agent", USER_AGENT)
            .build()

        try {
            http.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    lastDiagnostic = "HTTP ${response.code}${errorSummary(text)}"
                    return@withContext null
                }
                JSONObject(text)
            }
        } catch (e: Exception) {
            lastDiagnostic = "Network error: ${e.message}"
            null
        }
    }

    private fun errorSummary(body: String): String {
        try {
            val error = JSONObject(body).optJSONObject("error")
            val message = error?.optString("message", "") ?: ""
            if (message.isNotEmpty()) return ": $message"
        } catch (_: Exception) { /* not that shape */ }
        val snippet = body.trim()
        return if (snippet.isEmpty()) "" else ": " + snippet.take(200)
    }

    /**
     * Innertube's response shape is neither documented nor stable across
     * client versions — this scans for a playable item's shape (a
     * playlistId/videoId alongside a title run, one or two levels up)
     * instead of pinning to one fixed path, so it is more likely to survive
     * Google changing the surrounding structure than an exact-path parser.
     */
    private fun scanForItems(node: Any?, wantPlaylists: Boolean): List<Item> {
        val out = mutableListOf<Item>()
        scan(node, wantPlaylists, out)
        return out
    }

    private fun scan(node: Any?, wantPlaylists: Boolean, out: MutableList<Item>) {
        if (out.size >= 100) return
        when (node) {
            is JSONObject -> {
                var id = if (wantPlaylists) node.optString("playlistId", "") else node.optString("videoId", "")
                if (id.isEmpty() && !wantPlaylists) id = node.optString("playlistId", "")
                if (id.isNotEmpty()) {
                    val title = titleNear(node)
                    if (title != null) {
                        out += Item(id, title, subtitleNear(node) ?: "", node.has("playlistId"))
                    }
                }
                node.keys().forEach { key -> scan(node.opt(key), wantPlaylists, out) }
            }
            is JSONArray -> for (i in 0 until node.length()) scan(node.opt(i), wantPlaylists, out)
        }
    }

    private fun titleNear(obj: JSONObject): String? = runTextOf(obj.opt("title")) ?: runTextOf(obj.opt("header"))
    private fun subtitleNear(obj: JSONObject): String? = runTextOf(obj.opt("subtitle"))

    /** Innertube spells plain text as {"runs":[{"text":"..."}]} or {"simpleText":"..."}. */
    private fun runTextOf(field: Any?): String? {
        if (field !is JSONObject) return null
        val simple = field.optString("simpleText", "")
        if (simple.isNotEmpty()) return simple
        val runs = field.optJSONArray("runs") ?: return null
        val text = runs.optJSONObject(0)?.optString("text", "") ?: return null
        return text.ifEmpty { null }
    }

    /** A compact key-name outline — ground truth for fixing [scanForItems] against a real device's response. */
    private fun keySkeleton(node: Any?, depth: Int): String {
        if (depth >= 5) return "…"
        return when (node) {
            is JSONObject -> {
                val out = StringBuilder("{")
                var first = true
                for (key in node.keys()) {
                    if (!first) out.append(',')
                    first = false
                    out.append(key)
                    val child = node.opt(key)
                    if (child is JSONObject || child is JSONArray) out.append(':').append(keySkeleton(child, depth + 1))
                    if (out.length > 350) { out.append(",…"); break }
                }
                out.append('}').toString()
            }
            is JSONArray -> if (node.length() == 0) "[]" else "[${node.length()}×${keySkeleton(node.opt(0), depth + 1)}]"
            else -> node.toString().let { if (it.length > 12) "\"${it.take(12)}…\"" else "\"$it\"" }
        }
    }
}
