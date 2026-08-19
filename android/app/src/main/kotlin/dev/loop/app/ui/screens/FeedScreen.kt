package dev.loop.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.common.AvatarUrl
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.EmptyState
import dev.loop.app.ui.common.FooterStatus
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.PagedPosts
import dev.loop.app.ui.common.PostCard
import dev.loop.app.ui.common.paginate
import dev.loop.app.ui.rememberPostActions
import dev.loop.app.ui.toStory
import dev.loop.core.TrayEntry
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(nav: NavHostController) {
    val api = LocalContainer.current.requireApi()
    val listState = rememberLazyListState()
    val paged = remember { PagedPosts { cursor -> api.feed(cursor) } }
    var tray by remember { mutableStateOf<List<TrayEntry>>(emptyList()) }
    val actions = rememberPostActions(nav)
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { paged.loadMore() }
    LaunchedEffect(Unit) {
        // Stories are decoration. A failure here must never take out the feed.
        runCatching { tray = api.stories().tray }
    }
    LaunchedEffect(listState) { listState.paginate { paged.loadMore() } }

    Column(Modifier.fillMaxSize()) {
        CenterAlignedTopAppBar(
            title = { Text("Loop", style = MaterialTheme.typography.titleLarge) },
            actions = {
                IconButton(onClick = { nav.navigate("settings") }) {
                    Icon(Icons.Outlined.Settings, "Settings")
                }
            },
            colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                containerColor = MaterialTheme.colorScheme.background,
            ),
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)

        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            if (tray.isNotEmpty()) {
                item(key = "tray") {
                    StoryTray(tray) { nav.toStory(it.id) }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                }
            }

            items(paged.posts, key = { it.id }) { post ->
                PostCard(post, actions)
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            }

            item(key = "footer") {
                when {
                    paged.loading -> Loading()
                    paged.error != null -> ErrorState(paged.error!!) {
                        scope.launch { paged.retry() }
                    }
                    paged.isEmpty -> EmptyState(
                        "Your feed is empty",
                        "Follow some accounts and their posts show up here.",
                    )
                    paged.endReached -> FooterStatus("You're all caught up")
                }
            }
        }
    }
}

@Composable
private fun StoryTray(entries: List<TrayEntry>, onOpen: (TrayEntry) -> Unit) {
    LazyRow(
        Modifier.fillMaxWidth().padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp),
    ) {
        items(entries, key = { it.id }) { entry ->
            Column(
                Modifier.width(72.dp).clickable { onOpen(entry) },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val ring = if (entry.seen) {
                    Brush.linearGradient(listOf(Color(0xFF3A3A3A), Color(0xFF3A3A3A)))
                } else {
                    Brush.linearGradient(
                        listOf(
                            Color(0xFFFEDA75), Color(0xFFD62976),
                            Color(0xFF962FBF), Color(0xFF4F5BD5),
                        ),
                    )
                }
                androidx.compose.foundation.layout.Box(
                    Modifier.size(68.dp).clip(CircleShape).background(ring).padding(3.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    AvatarUrl(entry.avatar, 62.dp)
                }
                Text(
                    entry.username,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 5.dp),
                )
            }
        }
    }
}
