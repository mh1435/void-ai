package com.voidmusic.app.youtube

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/** A resolved song reference — title/artist, not yet matched to a playable file. */
data class MixEntry(val title: String, val artist: String, val album: String = "")
data class YoutubePlaylist(val id: String, val title: String, val count: Int?)

/**
 * Ties both YouTube auth paths (OAuth token, cookie session) and the
 * no-sign-in link resolver together behind one API — a Kotlin port of
 * js/youtube.js. Every caller (search fallback, playlist import, paste-a-
 * link) goes through this, the same way the JS's high-level functions hide
 * which auth mechanism is actually in use.
 */
class YoutubeRepository(
    private val oauth: YoutubeOAuthClient,
    private val cookie: YoutubeCookieSession,
    private val http: OkHttpClient,
) {
    fun connected(): Boolean = oauth.signedIn() || cookie.signedIn()

    /** The production noise people put in YouTube titles, several languages. */
    private val noise = Regex(
        "\\b(official\\s*(music\\s*)?(video|audio|visualizer|lyric[s]?\\s*video)?" +
            "|clip\\s*officiel|audio\\s*officiel|video\\s*oficial|videoclip" +
            "|lyric[s]?(\\s*video)?|letra|paroles" +
            "|hd|hq|4k|8k|full\\s*album|full\\s*ep|mv|m/v" +
            "|live\\s*(session|performance)?|remaster(ed)?(\\s*\\d{4})?" +
            "|audio|visualizer|explicit|free\\s*download|out\\s*now)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** "VIDEOCLUB - Amour Plastique (Clip Officiel)" -> Videoclub / Amour Plastique. */
    fun toEntry(rawTitle: String, channel: String?): MixEntry {
        var text = rawTitle
            .replace(Regex("[（(\\[【][^)）\\]】]*[)）\\]】]"), " ")
            .replace(noise, " ")
            .replace(Regex("\\s*[|｜]\\s*.*$"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

        val artistFromChannel = (channel ?: "")
            .replace(Regex("\\s*-\\s*Topic$", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s*(VEVO|Official|Music)$", RegexOption.IGNORE_CASE), "")
            .trim()

        val parts = text.split(Regex("\\s+[-–—]\\s+"))
        if (parts.size >= 2) {
            val artist = parts[0].trim()
            val title = parts.drop(1).joinToString(" - ").trim()
            if (artist.isNotEmpty() && title.isNotEmpty()) return MixEntry(title, artist)
        }
        return MixEntry(text.ifEmpty { rawTitle.trim() }, artistFromChannel)
    }

    /** video/shorts/live id and/or playlist id from anything that looks like a YouTube URL. */
    fun parseUrl(text: String): Pair<String, String>? {
        val raw = text.trim()
        val uri = try {
            Uri.parse(if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(raw)) raw else "https://$raw")
        } catch (_: Exception) { return null }

        val host = uri.host?.lowercase() ?: return null
        if (!(host.endsWith("youtube.com") || host.endsWith("youtu.be"))) return null

        var videoId = uri.getQueryParameter("v").orEmpty()
        if (videoId.isEmpty() && host.contains("youtu.be")) {
            videoId = uri.pathSegments.firstOrNull().orEmpty()
        }
        if (videoId.isEmpty()) {
            Regex("/(shorts|live|embed)/([^/?]+)").find(uri.path ?: "")?.let { videoId = it.groupValues[2] }
        }
        val playlistId = uri.getQueryParameter("list").orEmpty()
        return if (videoId.isNotEmpty() || playlistId.isNotEmpty()) videoId to playlistId else null
    }

    fun looksLikeUrl(text: String): Boolean = parseUrl(text) != null

    /** A video's title and channel — public oEmbed, no sign-in needed at all. */
    suspend fun videoInfo(videoId: String): MixEntry = withContext(Dispatchers.IO) {
        val url = "https://www.youtube.com/oembed?format=json&url=" +
            java.net.URLEncoder.encode("https://www.youtube.com/watch?v=$videoId", "UTF-8")
        val request = Request.Builder().url(url).build()
        http.newCall(request).execute().use { response ->
            if (response.code == 404 || response.code == 401) error("That video is private, deleted, or age-restricted")
            if (!response.isSuccessful) error("YouTube said HTTP ${response.code}")
            val json = JSONObject(response.body?.string().orEmpty())
            toEntry(json.optString("title"), json.optString("author_name"))
        }
    }

    /** A single video or a whole playlist, from whatever URL someone pasted. Prefers the video when both are present. */
    suspend fun entriesFromUrl(text: String): List<MixEntry> {
        val (videoId, playlistId) = parseUrl(text) ?: error("That does not look like a YouTube link")
        if (videoId.isNotEmpty()) return listOf(videoInfo(videoId))
        if (!connected()) error("Sign in to YouTube in Settings to read a playlist link")
        return playlistEntries(playlistId)
    }

    /** Every playlist you own (OAuth) or your library shows (cookie session). */
    suspend fun myPlaylists(): List<YoutubePlaylist> {
        val token = oauth.accessToken()
        if (token.isEmpty() && cookie.signedIn()) {
            return cookieItemsOrThrow(cookie.libraryPlaylists()).map {
                YoutubePlaylist(it.id, it.title.ifEmpty { "Untitled playlist" }, null)
            }
        }
        if (token.isEmpty()) error("Sign in to YouTube in Settings")
        // Data API path: playlists.list?mine=true — official Google endpoint.
        return dataApiPlaylists(token)
    }

    suspend fun playlistEntries(playlistId: String): List<MixEntry> {
        val token = oauth.accessToken()
        if (token.isEmpty() && cookie.signedIn()) {
            return cookieItemsOrThrow(cookie.playlistTracks(playlistId)).map { toEntry(it.title, it.subtitle) }
        }
        if (token.isEmpty()) error("Sign in to YouTube in Settings to read a playlist link")
        return dataApiPlaylistItems(token, playlistId)
    }

    suspend fun searchVideos(query: String): List<MixEntry> {
        if (query.isBlank()) return emptyList()
        val token = oauth.accessToken()
        if (token.isEmpty() && cookie.signedIn()) {
            return cookieItemsOrThrow(cookie.search(query)).map { toEntry(it.title, it.subtitle) }
        }
        if (token.isEmpty()) error("Sign in to YouTube in Settings to search there")
        return dataApiSearch(token, query)
    }

    /** An empty list from the cookie session is ambiguous alone — throw the real reason when one is present. */
    private fun cookieItemsOrThrow(items: List<YoutubeCookieSession.Item>): List<YoutubeCookieSession.Item> {
        if (items.isEmpty() && cookie.lastDiagnostic.isNotEmpty()) error(cookie.lastDiagnostic)
        return items
    }

    // ── Official Data API calls, used whenever an OAuth token is present ──

    private suspend fun dataApiPlaylists(token: String): List<YoutubePlaylist> = withContext(Dispatchers.IO) {
        val out = mutableListOf(YoutubePlaylist("LL", "Liked videos", null))
        var pageToken = ""
        do {
            val json = dataApiGet(token, "playlists", mapOf("part" to "snippet,contentDetails", "mine" to "true", "maxResults" to "50", "pageToken" to pageToken))
            json.optJSONArray("items")?.let { items ->
                for (i in 0 until items.length()) {
                    val item = items.getJSONObject(i)
                    out += YoutubePlaylist(
                        item.optString("id"),
                        item.optJSONObject("snippet")?.optString("title") ?: "Untitled playlist",
                        item.optJSONObject("contentDetails")?.optInt("itemCount"),
                    )
                }
            }
            pageToken = json.optString("nextPageToken", "")
        } while (pageToken.isNotEmpty())
        out
    }

    private suspend fun dataApiPlaylistItems(token: String, playlistId: String): List<MixEntry> = withContext(Dispatchers.IO) {
        val entries = mutableListOf<MixEntry>()
        var pageToken = ""
        do {
            val json = dataApiGet(token, "playlistItems", mapOf("part" to "snippet", "playlistId" to playlistId, "maxResults" to "50", "pageToken" to pageToken))
            json.optJSONArray("items")?.let { items ->
                for (i in 0 until items.length()) {
                    val snippet = items.getJSONObject(i).optJSONObject("snippet") ?: continue
                    val title = snippet.optString("title")
                    if (title.isEmpty() || Regex("^(deleted|private) video$", RegexOption.IGNORE_CASE).matches(title)) continue
                    entries += toEntry(title, snippet.optString("videoOwnerChannelTitle"))
                }
            }
            pageToken = json.optString("nextPageToken", "")
        } while (pageToken.isNotEmpty())
        entries
    }

    private suspend fun dataApiSearch(token: String, query: String): List<MixEntry> = withContext(Dispatchers.IO) {
        val json = dataApiGet(token, "search", mapOf("part" to "snippet", "q" to query, "type" to "video", "maxResults" to "20", "videoCategoryId" to "10"))
        val out = mutableListOf<MixEntry>()
        json.optJSONArray("items")?.let { items ->
            for (i in 0 until items.length()) {
                val snippet = items.getJSONObject(i).optJSONObject("snippet") ?: continue
                out += toEntry(snippet.optString("title"), snippet.optString("channelTitle"))
            }
        }
        out
    }

    private fun dataApiGet(token: String, path: String, params: Map<String, String>): JSONObject {
        val url = "https://www.googleapis.com/youtube/v3/$path?" +
            params.filterValues { it.isNotEmpty() }.entries.joinToString("&") { (k, v) -> "$k=${java.net.URLEncoder.encode(v, "UTF-8")}" }
        val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        http.newCall(request).execute().use { response ->
            if (response.code == 401) error("Token expired — connect again")
            if (response.code == 403) error("YouTube refused the request (quota or scope)")
            if (!response.isSuccessful) error("HTTP ${response.code}")
            return JSONObject(response.body?.string().orEmpty())
        }
    }
}
