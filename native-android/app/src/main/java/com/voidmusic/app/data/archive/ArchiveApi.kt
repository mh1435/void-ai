package com.voidmusic.app.data.archive

import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Url

/** archive.org's own JSON shapes, only the fields this app reads. */

@Serializable
data class AdvancedSearchResponse(val response: SearchResponseBody)

@Serializable
data class SearchResponseBody(val numFound: Int = 0, val docs: List<SearchDoc> = emptyList())

@Serializable
data class SearchDoc(
    val identifier: String,
    val title: String? = null,
    val creator: String? = null,
    val year: String? = null,
    val downloads: Int? = null,
)

@Serializable
data class ItemMetadataResponse(
    val metadata: ItemMetadata = ItemMetadata(),
    val files: List<ItemFile> = emptyList(),
    val server: String = "",
    val dir: String = "",
)

@Serializable
data class ItemMetadata(
    val title: String? = null,
    val creator: String? = null,
    val date: String? = null,
)

@Serializable
data class ItemFile(
    val name: String,
    val title: String? = null,
    val creator: String? = null,
    val track: String? = null,
    val album: String? = null,
    val format: String? = null,
    val length: String? = null,
)

interface ArchiveApi {
    @GET
    suspend fun advancedSearch(@Url url: String): AdvancedSearchResponse

    @GET
    suspend fun itemMetadata(@Url url: String): ItemMetadataResponse
}
