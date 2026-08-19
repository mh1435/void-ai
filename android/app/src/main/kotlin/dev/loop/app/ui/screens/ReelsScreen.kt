package dev.loop.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.LocalSnackbar
import dev.loop.app.ui.common.Avatar
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.LinkedText
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.PagedPosts
import dev.loop.app.ui.common.Playback
import dev.loop.app.ui.common.VideoSurface
import dev.loop.app.ui.common.compactCount
import dev.loop.app.ui.common.richCaption
import dev.loop.app.ui.toPost
import dev.loop.app.ui.toTag
import dev.loop.app.ui.toUser
import dev.loop.core.Post
import kotlinx.coroutines.launch

@Composable
fun ReelsScreen(nav: NavHostController) {
    val api = LocalContainer.current.requireApi()
    val paged = remember { PagedPosts { cursor -> api.reels(cursor) } }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { paged.loadMore() }

    val pagerState = rememberPagerState(pageCount = { paged.posts.size })

    // Fetch the next batch before the user runs out of reels to scroll.
    LaunchedEffect(pagerState, paged.posts.size) {
        snapshotFlow { pagerState.currentPage }.collect { page ->
            if (paged.posts.isNotEmpty() && page >= paged.posts.size - 3) paged.loadMore()
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when {
            paged.posts.isEmpty() && paged.loading -> Loading(Modifier.align(Alignment.Center))
            paged.posts.isEmpty() && paged.error != null ->
                ErrorState(paged.error!!, Modifier.align(Alignment.Center)) {
                    scope.launch { paged.retry() }
                }
            else -> VerticalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
                Reel(
                    post = paged.posts[page],
                    playing = pagerState.currentPage == page,
                    nav = nav,
                )
            }
        }
    }
}

@Composable
private fun Reel(post: Post, playing: Boolean, nav: NavHostController) {
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()

    var liked by remember(post.id) { mutableStateOf(post.liked) }
    var likes by remember(post.id) { mutableStateOf(post.likeCount) }

    Box(Modifier.fillMaxSize()) {
        val video = post.video
        if (video != null) {
            VideoSurface(
                url = video,
                modifier = Modifier.fillMaxSize(),
                play = playing,
                muted = Playback.muted,
                poster = post.thumb.ifBlank { null },
            )
        }

        // A tap anywhere is the fastest way to unmute, which is what people
        // reach for first on a silent video.
        Box(
            Modifier.fillMaxSize().clickable(
                indication = null,
                interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
            ) { Playback.toggleMuted() },
        )

        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f)),
                    ),
                )
                .padding(top = 80.dp),
        )

        Column(
            Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = 26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                IconButton(onClick = {
                    val next = !liked
                    liked = next
                    likes = (likes + if (next) 1 else -1).coerceAtLeast(0)
                    scope.launch {
                        runCatching { container.requireApi().like(post.id, next) }
                            .onFailure {
                                liked = !next
                                likes = (likes + if (next) -1 else 1).coerceAtLeast(0)
                                snackbar.showSnackbar(it.message ?: "Could not like that.")
                            }
                    }
                }) {
                    Icon(
                        if (liked) Icons.Filled.Favorite else Icons.Outlined.FavoriteBorder,
                        contentDescription = "Like",
                        tint = if (liked) MaterialTheme.colorScheme.error else Color.White,
                    )
                }
                Text(compactCount(likes), color = Color.White,
                    style = MaterialTheme.typography.labelSmall)
            }

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                IconButton(onClick = { nav.toPost(post.id) }) {
                    Icon(Icons.Outlined.ChatBubbleOutline, "Comments", tint = Color.White)
                }
                Text(compactCount(post.commentCount), color = Color.White,
                    style = MaterialTheme.typography.labelSmall)
            }

            IconButton(onClick = { Playback.toggleMuted() }) {
                Icon(
                    if (Playback.muted) Icons.Filled.VolumeOff else Icons.Filled.VolumeUp,
                    contentDescription = "Toggle sound",
                    tint = Color.White,
                )
            }
        }

        Column(
            Modifier.align(Alignment.BottomStart)
                .padding(start = 14.dp, end = 76.dp, bottom = 26.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                modifier = Modifier.clickable { nav.toUser(post.user.username) },
            ) {
                Avatar(post.user, 32.dp)
                Text(post.user.username, color = Color.White,
                    style = MaterialTheme.typography.titleMedium)
            }
            if (post.caption.isNotBlank()) {
                LinkedText(
                    text = richCaption(post.caption),
                    maxLines = 2,
                    style = MaterialTheme.typography.bodyMedium.copy(color = Color.White),
                    onUser = { nav.toUser(it) },
                    onTag = { nav.toTag(it) },
                )
            }
            post.audio?.let { audio ->
                Text(
                    "♪ ${audio.title}${if (audio.artist.isNotBlank()) " · ${audio.artist}" else ""}",
                    color = Color.White.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
