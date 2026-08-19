package dev.loop.app.ui.common

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import dev.loop.core.User

/**
 * Every image in the app goes through here so nothing can accidentally load a
 * URL the API client did not hand out. Coil is configured in LoopApplication
 * to share the API's OkHttp client, so the host guard and session cookie apply.
 */
@Composable
fun RemoteImage(
    url: String?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
) {
    AsyncImage(
        model = url,
        contentDescription = contentDescription,
        modifier = modifier.background(Color(0xFF1A1A1A)),
        contentScale = contentScale,
    )
}

@Composable
fun Avatar(user: User, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    RemoteImage(
        url = user.avatar.ifBlank { null },
        contentDescription = if (user.username.isBlank()) null
        else "${user.username}'s profile picture",
        modifier = modifier.size(size).clip(CircleShape),
    )
}

@Composable
fun AvatarUrl(url: String, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    RemoteImage(url.ifBlank { null }, null, modifier.size(size).clip(CircleShape))
}

/**
 * A self-contained video surface.
 *
 * The player is created and released with the composable, so a LazyColumn only
 * ever holds players for the handful of items it has composed — scrolling a
 * feed never leaves a dozen decoders running. [play] lets a pager keep only the
 * page in view actually playing.
 */
@OptIn(UnstableApi::class)
@Composable
fun VideoSurface(
    url: String,
    modifier: Modifier = Modifier,
    play: Boolean = true,
    muted: Boolean = true,
    poster: String? = null,
) {
    val context = LocalContext.current
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            repeatMode = Player.REPEAT_MODE_ONE
            prepare()
        }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    LaunchedEffect(play, muted, player) {
        player.volume = if (muted) 0f else 1f
        if (play) player.play() else player.pause()
    }

    Box(modifier) {
        if (poster != null) {
            RemoteImage(poster, null, Modifier.fillMaxSize(), ContentScale.Fit)
        }
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    // Letterbox rather than crop: a reel and a 4:5 photo post
                    // should both be shown whole.
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                    this.player = player
                }
            },
            update = { it.player = player },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
