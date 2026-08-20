package com.voidmusic.app.ui.search

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voidmusic.app.data.archive.ArchiveRepository
import com.voidmusic.app.domain.model.ArchiveItem
import com.voidmusic.app.domain.model.Track
import com.voidmusic.app.youtube.MixEntry
import com.voidmusic.app.youtube.YoutubeRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

sealed interface SearchStatus {
    data object Idle : SearchStatus
    data object Loading : SearchStatus
    data object ResolvingYoutubeLink : SearchStatus
    data class Results(val albums: List<ArchiveItem>) : SearchStatus
    data class Error(val message: String) : SearchStatus
    data class YoutubeResolved(val entries: List<MixEntry>) : SearchStatus
}

class SearchViewModel(
    private val archive: ArchiveRepository,
    private val youtube: YoutubeRepository,
) : ViewModel() {

    var query by mutableStateOf("")
        private set
    var status by mutableStateOf<SearchStatus>(SearchStatus.Idle)
        private set
    /** Set only when Songs came back empty on an ordinary archive search — mirrors the JS's fallback button. */
    var offerYoutubeFallback by mutableStateOf(false)
        private set

    private var debounce: Job? = null

    fun onQueryChange(text: String) {
        query = text
        offerYoutubeFallback = false
        debounce?.cancel()
        if (text.isBlank()) { status = SearchStatus.Idle; return }

        debounce = viewModelScope.launch {
            delay(400)
            runSearch(text)
        }
    }

    private suspend fun runSearch(text: String) {
        // A pasted YouTube link is not a search term — the Archive has no
        // idea what "?v=dQw4w9WgXcQ" means, so resolve it instead of
        // searching for it. Mirrors renderSearch()'s early check in
        // js/views.js.
        if (youtube.looksLikeUrl(text)) {
            status = SearchStatus.ResolvingYoutubeLink
            status = try {
                SearchStatus.YoutubeResolved(youtube.entriesFromUrl(text))
            } catch (e: Exception) {
                SearchStatus.Error(e.message ?: "Could not read that link")
            }
            return
        }

        status = SearchStatus.Loading
        status = try {
            val result = archive.search(query = text, rows = 30)
            offerYoutubeFallback = result.items.isEmpty()
            SearchStatus.Results(result.items)
        } catch (e: Exception) {
            SearchStatus.Error(e.message ?: "Could not reach the Archive")
        }
    }

    /** "Search YouTube instead" — same query, YouTube's index, resolved through the same pipeline. */
    fun searchYoutubeInstead() {
        viewModelScope.launch {
            status = SearchStatus.Loading
            status = try {
                SearchStatus.YoutubeResolved(youtube.searchVideos(query))
            } catch (e: Exception) {
                SearchStatus.Error(e.message ?: "Could not search YouTube")
            }
        }
    }

    suspend fun tracksFor(identifier: String): List<Track> = archive.tracksFor(identifier)

    /** 0 disables the cutoff entirely — mirrors js/archive.js's setMinYear. */
    fun setMinYear(year: Int) {
        archive.minYear = year
        if (query.isNotBlank()) onQueryChange(query) // re-run so the toggle takes effect immediately
    }
}
