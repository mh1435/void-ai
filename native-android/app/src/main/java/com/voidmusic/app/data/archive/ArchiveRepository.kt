package com.voidmusic.app.data.archive

import com.voidmusic.app.data.backend.BackendRouter
import com.voidmusic.app.domain.model.ArchiveItem
import com.voidmusic.app.domain.model.SearchResult
import com.voidmusic.app.domain.model.Track
import com.voidmusic.app.domain.model.TrackSource
import java.net.URLEncoder

/**
 * The Internet Archive client — a Kotlin port of js/archive.js's query
 * building and result shaping, kept faithful rather than rewritten, since
 * the exclusions here (mediatype, format, non-music collections, the year
 * cutoff) are the actual tuning that makes search results usable and not
 * something to redesign from scratch in a rewrite.
 */
class ArchiveRepository(
    private val api: ArchiveApi,
    private val backend: BackendRouter,
) {
    companion object {
        private const val DEFAULT_BASE = "https://archive.org"

        /**
         * Audio on the Archive is far more than music: audiobooks, sermons,
         * lectures, scanner traffic and news all carry mediatype:audio.
         * Excluded so a song search returns songs, not talking.
         */
        private val NON_MUSIC_COLLECTIONS = listOf(
            "librivoxaudio", "oldtimeradio", "audio_bookspoetry", "audio_news",
            "audio_religion", "audio_political", "radioprograms", "podcasts",
            "samples_only", "audio_tech", "gratefuldead_covers_only", "gdlivetapes",
        )

        /** Formats a device can realistically play, best first — mirrors AUDIO_FORMATS. */
        private val AUDIO_FORMAT_RANK: List<Pair<Regex, Int>> = listOf(
            Regex("^VBR MP3$", RegexOption.IGNORE_CASE) to 1,
            Regex("^\\d+Kbps MP3$", RegexOption.IGNORE_CASE) to 2,
            Regex("^MP3$", RegexOption.IGNORE_CASE) to 3,
            Regex("^Ogg Vorbis$", RegexOption.IGNORE_CASE) to 4,
            Regex("^(MPEG-4 Audio|M4A|AAC)$", RegexOption.IGNORE_CASE) to 5,
            Regex("^(Flac|24bit Flac)$", RegexOption.IGNORE_CASE) to 8,
            Regex("^(WAVE|AIFF)$", RegexOption.IGNORE_CASE) to 9,
        )
    }

    /** Oldest year to include. 0 disables the cutoff. Mirrors js/archive.js's minYear. */
    var minYear: Int = 2005

    private fun escapeLucene(s: String) =
        s.replace(Regex("([+\\-!(){}\\[\\]^\"~*?:\\\\/])"), "\\\\$1").trim()

    private fun buildQuery(query: String = "", collection: String = ""): String {
        val parts = mutableListOf("mediatype:(audio)")
        if (collection.isNotEmpty()) parts += "collection:(${escapeLucene(collection)})"
        if (minYear > 0) parts += "year:[$minYear TO 9999]"
        if (query.isNotEmpty()) {
            val q = escapeLucene(query)
            parts += "(title:($q) OR creator:($q))"
        }
        parts += "format:(MP3)"
        NON_MUSIC_COLLECTIONS.forEach { parts += "-collection:($it)" }
        return parts.joinToString(" AND ")
    }

    private fun bases(): List<String> {
        val direct = listOf(DEFAULT_BASE)
        if (!backend.state.value.active) return direct
        val proxied = backend.originFor("archive.org")
        return if (backend.state.value.exclusive) listOf(proxied) else listOf(proxied) + direct
    }

    suspend fun search(query: String = "", collection: String = "", page: Int = 1, rows: Int = 48): SearchResult {
        val q = buildQuery(query, collection)
        val params = buildString {
            append("q=").append(URLEncoder.encode(q, "UTF-8"))
            listOf("identifier", "title", "creator", "year", "downloads").forEach {
                append("&fl[]=").append(it)
            }
            append("&sort[]=").append(if (query.isNotEmpty()) "downloads desc" else "week desc")
            append("&rows=$rows&page=$page&output=json")
        }
        val base = bases().first()
        val url = backend.sign("$base/advancedsearch.php?$params")
        val data = api.advancedSearch(url)
        return SearchResult(
            total = data.response.numFound,
            page = page,
            items = data.response.docs.map {
                ArchiveItem(
                    identifier = it.identifier,
                    title = it.title?.trim().takeUnless { t -> t.isNullOrEmpty() } ?: it.identifier,
                    creator = it.creator?.trim().takeUnless { c -> c.isNullOrEmpty() } ?: "Unknown artist",
                    year = it.year ?: "",
                    downloads = it.downloads ?: 0,
                )
            },
        )
    }

    /** All playable tracks in one archive.org item, best format per file. */
    suspend fun tracksFor(identifier: String): List<Track> {
        val base = bases().first()
        val url = backend.sign("$base/metadata/$identifier")
        val meta = api.itemMetadata(url)
        val fileBase = "https://${meta.server}${meta.dir}"

        return meta.files.mapNotNull { file ->
            val rank = AUDIO_FORMAT_RANK.firstOrNull { (regex, _) -> file.format?.let(regex::containsMatchIn) == true }
                ?: return@mapNotNull null
            val streamUrl = backend.sign(backend.reroute("$fileBase/${file.name}"))
            Track(
                id = "$identifier/${file.name}",
                title = file.title?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: file.name.substringBeforeLast('.'),
                artist = file.creator?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: meta.metadata.creator?.trim().orEmpty(),
                album = file.album ?: meta.metadata.title.orEmpty(),
                year = (Regex("\\d{4}").find(meta.metadata.date ?: "")?.value) ?: "",
                durationSec = parseDuration(file.length),
                streamUrl = streamUrl,
                source = TrackSource.ARCHIVE,
            )
        }.sortedWith(compareBy { it.title })
    }

    /** IA's `length` is either seconds ("245.67") or clock time ("4:05"). */
    private fun parseDuration(len: String?): Double {
        if (len.isNullOrBlank()) return 0.0
        return if (len.contains(':')) {
            len.split(':').fold(0.0) { acc, p -> acc * 60 + (p.toDoubleOrNull() ?: 0.0) }
        } else {
            len.toDoubleOrNull() ?: 0.0
        }
    }
}
