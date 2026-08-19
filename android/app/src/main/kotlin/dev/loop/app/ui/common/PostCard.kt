package dev.loop.app.ui.common

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import dev.loop.core.Post
import dev.loop.core.Slide

/** What a post card can do, wired by whichever screen shows it. */
data class PostActions(
    val onUser: (String) -> Unit = {},
    val onTag: (String) -> Unit = {},
    val onComments: (Post) -> Unit = {},
    val onShare: (Post) -> Unit = {},
    val onLike: (Post, Boolean) -> Unit = { _, _ -> },
    val onSave: (Post, Boolean) -> Unit = { _, _ -> },
)

@Composable
fun PostCard(
    post: Post,
    actions: PostActions,
    modifier: Modifier = Modifier,
    visible: Boolean = true,
    expandCaption: Boolean = false,
) {
    // Optimistic local state: the tap has to feel instant, and the server call
    // reverts it if Instagram refuses.
    var liked by remember(post.id) { mutableStateOf(post.liked) }
    var likes by remember(post.id) { mutableStateOf(post.likeCount) }
    var saved by remember(post.id) { mutableStateOf(post.saved) }
    var burst by remember(post.id) { mutableStateOf(false) }

    fun setLiked(next: Boolean) {
        if (liked == next) return
        liked = next
        likes = (likes + if (next) 1 else -1).coerceAtLeast(0)
        actions.onLike(post, next)
    }

    Column(modifier.fillMaxWidth()) {
        PostHeader(post, actions)

        MediaWithBurst(
            post = post,
            visible = visible,
            burst = burst,
            onBurstFinished = { burst = false },
            onDoubleTap = {
                if (!liked) setLiked(true)
                burst = true
            },
        )

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { setLiked(!liked) }) {
                Icon(
                    if (liked) Icons.Filled.Favorite else Icons.Outlined.FavoriteBorder,
                    contentDescription = if (liked) "Unlike" else "Like",
                    tint = if (liked) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onBackground,
                )
            }
            IconButton(onClick = { actions.onComments(post) }) {
                Icon(Icons.Outlined.ChatBubbleOutline, "Comments")
            }
            IconButton(onClick = { actions.onShare(post) }) {
                Icon(Icons.Outlined.Send, "Share")
            }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = {
                saved = !saved
                actions.onSave(post, saved)
            }) {
                Icon(
                    if (saved) Icons.Filled.Bookmark else Icons.Outlined.BookmarkBorder,
                    contentDescription = if (saved) "Remove from saved" else "Save",
                )
            }
        }

        Column(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(
                text = if (likes > 0) "${compactCount(likes)} ${if (likes == 1) "like" else "likes"}"
                else "Be the first to like this",
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (likes > 0) FontWeight.SemiBold else FontWeight.Normal,
                color = if (likes > 0) MaterialTheme.colorScheme.onBackground
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (post.caption.isNotBlank()) {
                var expanded by remember(post.id) { mutableStateOf(expandCaption) }
                LinkedText(
                    text = richCaption(post.caption, post.user.username),
                    maxLines = if (expanded) Int.MAX_VALUE else 2,
                    style = MaterialTheme.typography.bodyLarge,
                    onUser = actions.onUser,
                    onTag = actions.onTag,
                    onOther = { expanded = true },
                )
            }

            if (post.commentCount > 0) {
                Text(
                    text = "View all ${compactCount(post.commentCount)} comments",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.clickable { actions.onComments(post) },
                )
            }

            Text(
                text = ago(post.takenAt).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The media, with the double-tap heart layered over it.
 *
 * This is a separate composable rather than a Box inside PostCard's Column on
 * purpose: inside that Column, ColumnScope is still an implicit receiver, and
 * `AnimatedVisibility` then resolves to `ColumnScope.AnimatedVisibility`
 * instead of the plain overload. Here only BoxScope is in scope.
 */
@Composable
private fun MediaWithBurst(
    post: Post,
    visible: Boolean,
    burst: Boolean,
    onBurstFinished: () -> Unit,
    onDoubleTap: () -> Unit,
) {
    Box {
        PostMedia(post = post, visible = visible, onDoubleTap = onDoubleTap)
        AnimatedVisibility(
            visible = burst,
            enter = scaleIn(initialScale = 0.4f) + fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center),
        ) {
            Icon(
                Icons.Filled.Favorite,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.size(96.dp),
            )
        }
    }

    LaunchedEffect(burst) {
        if (burst) {
            delay(650)
            onBurstFinished()
        }
    }
}

@Composable
private fun PostHeader(post: Post, actions: PostActions) {
    Row(
        Modifier.fillMaxWidth()
            .clickable { actions.onUser(post.user.username) }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Avatar(post.user, 34.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(post.user.username, style = MaterialTheme.typography.titleMedium)
                if (post.user.isVerified) VerifiedBadge()
            }
            if (post.location.isNotBlank()) {
                Text(post.location, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
fun VerifiedBadge(size: androidx.compose.ui.unit.Dp = 14.dp) {
    Box(
        Modifier.size(size).clip(CircleShape).background(Color(0xFF3797F0))
            .semantics { contentDescription = "Verified" },
        contentAlignment = Alignment.Center,
    ) {
        Text("✓", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun PostMedia(post: Post, visible: Boolean, onDoubleTap: () -> Unit) {
    val slides = post.slides.ifEmpty { listOf(Slide()) }
    val ratio = slides.first().aspectRatio

    Box(
        Modifier.fillMaxWidth()
            .aspectRatio(ratio)
            .background(Color.Black)
            .pointerInput(post.id) {
                detectTapGestures(onDoubleTap = { onDoubleTap() })
            },
    ) {
        if (slides.size > 1) {
            val pagerState = rememberPagerState(pageCount = { slides.size })
            HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
                SlideMedia(slides[page], visible && pagerState.currentPage == page)
            }
            Box(
                Modifier.align(Alignment.TopEnd).padding(10.dp)
                    .clip(RoundedCornerShape(50))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 9.dp, vertical = 3.dp),
            ) {
                Text(
                    "${pagerState.currentPage + 1}/${slides.size}",
                    color = Color.White,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        } else {
            SlideMedia(slides.first(), visible)
        }

        if (post.isVideo) {
            IconButton(
                onClick = { Playback.toggleMuted() },
                modifier = Modifier.align(Alignment.BottomEnd).padding(10.dp)
                    .size(30.dp).clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.6f)),
            ) {
                Icon(
                    if (Playback.muted) Icons.Filled.VolumeOff else Icons.Filled.VolumeUp,
                    contentDescription = "Toggle sound",
                    tint = Color.White,
                    modifier = Modifier.size(17.dp),
                )
            }
        }
    }
}

@Composable
private fun SlideMedia(slide: Slide, visible: Boolean) {
    val video = slide.video
    if (video != null) {
        VideoSurface(
            url = video,
            modifier = Modifier.fillMaxSize(),
            play = visible,
            muted = Playback.muted,
            poster = slide.image.ifBlank { null },
        )
    } else {
        RemoteImage(
            url = slide.image.ifBlank { null },
            contentDescription = slide.alt.ifBlank { null },
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit,
        )
    }
}
