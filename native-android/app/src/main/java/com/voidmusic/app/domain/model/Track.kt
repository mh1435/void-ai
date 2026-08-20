package com.voidmusic.app.domain.model

/** One playable item, resolved from an Internet Archive identifier + file. */
data class Track(
    val id: String,          // "<identifier>/<file>"
    val title: String,
    val artist: String,
    val album: String = "",
    val year: String = "",
    val durationSec: Double = 0.0,
    val streamUrl: String,
    val cover: String? = null,
    val source: TrackSource = TrackSource.ARCHIVE,
)

enum class TrackSource { ARCHIVE, LOCAL, YOUTUBE_RESOLVED }

/** One archive.org item as it appears in search results, before its tracks are resolved. */
data class ArchiveItem(
    val identifier: String,
    val title: String,
    val creator: String,
    val year: String,
    val downloads: Int,
    val cover: String? = null,
)

data class SearchResult(
    val total: Int,
    val page: Int,
    val items: List<ArchiveItem>,
)

/** A curated entry point on the Home screen — mirrors js/archive.js's COLLECTIONS. */
data class Collection(
    val id: String,
    val displayName: String,
    val blurb: String,
    val historical: Boolean = false, // hidden when the year cutoff is active — see js/archive.js
)

val CURATED_COLLECTIONS = listOf(
    Collection("netlabels", "Netlabels", "Creative Commons electronic, ambient and indie releases"),
    Collection("etree", "Live Concerts", "Artist-authorised live recordings, taped and traded legally"),
    Collection("georgeblood", "78 RPM Archive", "Digitised 78s — jazz, blues and early pop, public domain", historical = true),
    Collection("audio_music", "Open Music", "The Archive-wide music pool, freely licensed"),
    Collection("classicalmusicarchive", "Classical", "Orchestral and chamber recordings in the public domain"),
    Collection("audio_field_recordings", "Field Recordings", "Folk, traditional and location recordings from around the world"),
)
