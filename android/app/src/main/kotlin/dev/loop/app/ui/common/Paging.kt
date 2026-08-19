package dev.loop.app.ui.common

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import dev.loop.core.Page
import dev.loop.core.Post
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter

/**
 * Cursor paging, shared by the feed, explore, reels, profile grids and tags.
 *
 * Two behaviours are deliberate. A failure stops the loop instead of letting
 * the scroll listener hammer a failing endpoint — the user retries explicitly.
 * And already-seen ids are dropped, because Instagram's cursors overlap: a
 * profile page and its follow-up feed request return some of the same posts.
 */
class PagedPosts(private val fetch: suspend (String?) -> Page) {

    var posts by mutableStateOf<List<Post>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<Throwable?>(null)
        private set
    var endReached by mutableStateOf(false)
        private set

    private var cursor: String? = null
    private val seen = LinkedHashSet<String>()

    val isEmpty: Boolean get() = posts.isEmpty() && !loading && error == null

    /**
     * Seed from a response that already carried its first page (profiles do).
     *
     * Paging then restarts from a null cursor, because the profile endpoint's
     * cursor belongs to a different endpoint than the one that pages it. The
     * overlap that causes is handled by the de-duplication above.
     */
    fun seed(initial: List<Post>, hasMore: Boolean) {
        posts = initial.also { seen += it.map(Post::id) }
        cursor = null
        endReached = !hasMore
        error = null
    }

    suspend fun loadMore() {
        if (loading || endReached) return
        loading = true
        error = null
        try {
            val page = fetch(cursor)
            val fresh = page.posts.filter { seen.add(it.id) }
            posts = posts + fresh
            cursor = page.nextMaxId
            endReached = page.nextMaxId == null
        } catch (e: Throwable) {
            error = e
            // Stop the scroll listener from retrying in a tight loop.
            endReached = true
        } finally {
            loading = false
        }
    }

    suspend fun retry() {
        endReached = false
        error = null
        loadMore()
    }

    suspend fun refresh() {
        cursor = null
        seen.clear()
        posts = emptyList()
        endReached = false
        error = null
        loadMore()
    }
}

/** Calls [onNearEnd] once per approach to the bottom of a list. */
suspend fun LazyListState.paginate(threshold: Int = 4, onNearEnd: suspend () -> Unit) {
    snapshotFlow { layoutInfo.visibleItemsInfo.lastOrNull()?.index to layoutInfo.totalItemsCount }
        .distinctUntilChanged()
        .filter { (last, total) -> last != null && total > 0 && last >= total - threshold }
        .collect { onNearEnd() }
}

/** Grid flavour of [paginate]. */
suspend fun LazyGridState.paginate(threshold: Int = 9, onNearEnd: suspend () -> Unit) {
    snapshotFlow { layoutInfo.visibleItemsInfo.lastOrNull()?.index to layoutInfo.totalItemsCount }
        .distinctUntilChanged()
        .filter { (last, total) -> last != null && total > 0 && last >= total - threshold }
        .collect { onNearEnd() }
}
