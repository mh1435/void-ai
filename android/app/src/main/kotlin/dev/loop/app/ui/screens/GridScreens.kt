package dev.loop.app.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.common.EmptyState
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.FooterStatus
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.PagedPosts
import dev.loop.app.ui.common.RemoteImage
import dev.loop.app.ui.common.compactCount
import dev.loop.app.ui.common.paginate
import dev.loop.app.ui.toPost
import dev.loop.core.Post
import kotlinx.coroutines.launch

/** One tile of a three-across grid: explore, a profile, a hashtag. */
@Composable
fun PostTile(post: Post, onClick: () -> Unit) {
    Box(
        Modifier.aspectRatio(1f).clickable(onClick = onClick),
    ) {
        RemoteImage(
            url = post.thumb.ifBlank { post.slides.firstOrNull()?.image },
            contentDescription = post.slides.firstOrNull()?.alt?.ifBlank { null },
            modifier = Modifier.fillMaxSize(),
        )
        val badge = when {
            post.isCarousel -> Icons.Filled.Layers
            post.isVideo -> Icons.Filled.PlayArrow
            else -> null
        }
        if (badge != null) {
            Icon(
                badge,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
            )
        }
    }
}

/** Shared body for every infinite three-across grid in the app. */
@Composable
fun PostGrid(
    paged: PagedPosts,
    nav: NavHostController,
    modifier: Modifier = Modifier,
    state: LazyGridState = rememberLazyGridState(),
    emptyTitle: String = "Nothing here",
    emptyBody: String? = null,
    header: (@Composable () -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    LaunchedEffect(state) { state.paginate { paged.loadMore() } }

    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        state = state,
        modifier = modifier.fillMaxSize(),
        verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(2.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(2.dp),
    ) {
        if (header != null) {
            item(span = { GridItemSpan(maxLineSpan) }) { header() }
        }
        items(paged.posts, key = { it.id }) { post ->
            PostTile(post) { nav.toPost(post.id) }
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            when {
                paged.loading -> Loading()
                paged.error != null -> ErrorState(paged.error!!) { scope.launch { paged.retry() } }
                paged.isEmpty -> EmptyState(emptyTitle, emptyBody)
                paged.endReached && paged.posts.isNotEmpty() -> FooterStatus("That's everything")
            }
        }
    }
}

@Composable
fun ExploreScreen(nav: NavHostController) {
    val api = LocalContainer.current.requireApi()
    val paged = remember { PagedPosts { cursor -> api.explore(cursor) } }
    LaunchedEffect(Unit) { paged.loadMore() }

    Column(Modifier.fillMaxSize()) {
        SearchTrigger { nav.navigate("search") }
        PostGrid(
            paged, nav,
            emptyTitle = "Nothing to explore",
            emptyBody = "Instagram returned no suggestions right now.",
        )
    }
}

@Composable
fun TagScreen(nav: NavHostController, name: String) {
    val api = LocalContainer.current.requireApi()
    val paged = remember(name) {
        PagedPosts { _ ->
            // Hashtag pages are not cursor-paged by the server; one shot.
            val page = api.tag(name)
            dev.loop.core.Page(posts = page.posts, nextMaxId = null)
        }
    }
    LaunchedEffect(name) { paged.loadMore() }

    PostGrid(
        paged, nav,
        emptyTitle = "No posts",
        emptyBody = "Nothing to show for #$name.",
        header = {
            Column(Modifier.fillMaxWidth().padding(20.dp)) {
                Text("#$name", style = MaterialTheme.typography.titleLarge)
                if (paged.posts.isNotEmpty()) {
                    Text(
                        "${compactCount(paged.posts.size)} shown",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
    )
}

@Composable
private fun SearchTrigger(onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().padding(12.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 11.dp),
    ) {
        Text(
            "Search",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
