package dev.loop.app.ui.screens

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.common.AvatarUrl
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.RemoteImage
import dev.loop.app.ui.common.VideoSurface
import dev.loop.app.ui.common.ago
import dev.loop.core.StoryReel
import kotlinx.coroutines.delay

@Composable
fun StoryScreen(nav: NavHostController, reelId: String) {
    val api = LocalContainer.current.requireApi()
    var reel by remember(reelId) { mutableStateOf<StoryReel?>(null) }
    var error by remember(reelId) { mutableStateOf<Throwable?>(null) }
    var index by remember(reelId) { mutableIntStateOf(0) }

    LaunchedEffect(reelId) {
        error = null
        runCatching { api.story(reelId) }
            .onSuccess { reel = it }
            .onFailure { error = it }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        val current = reel
        when {
            error != null -> ErrorState(error!!, Modifier.align(Alignment.Center)) {
                nav.popBackStack()
            }
            current == null -> Loading(Modifier.align(Alignment.Center))
            current.items.isEmpty() -> {
                Text("Nothing to show.", color = Color.White,
                    modifier = Modifier.align(Alignment.Center))
            }
            else -> {
                val item = current.items[index.coerceIn(current.items.indices)]

                // Advance on a timer; a video's own length drives its slot.
                LaunchedEffect(reelId, index) {
                    delay(item.durationMillis)
                    if (index + 1 < current.items.size) index++ else nav.popBackStack()
                }

                val video = item.video
                if (video != null) {
                    VideoSurface(
                        url = video,
                        modifier = Modifier.fillMaxSize(),
                        play = true,
                        muted = false,
                        poster = item.image.ifBlank { null },
                    )
                } else {
                    RemoteImage(
                        url = item.image.ifBlank { null },
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit,
                    )
                }

                // Tap left to go back, tap right to skip forward.
                Row(Modifier.fillMaxSize()) {
                    TapZone(Modifier.weight(0.32f)) {
                        if (index > 0) index-- else nav.popBackStack()
                    }
                    TapZone(Modifier.weight(0.68f)) {
                        if (index + 1 < current.items.size) index++ else nav.popBackStack()
                    }
                }

                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp)) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        current.items.forEachIndexed { position, _ ->
                            val progress by animateFloatAsState(
                                targetValue = when {
                                    position < index -> 1f
                                    position > index -> 0f
                                    else -> 1f
                                },
                                animationSpec = tween(
                                    durationMillis = if (position == index) {
                                        item.durationMillis.toInt()
                                    } else 0,
                                ),
                                label = "storyProgress",
                            )
                            Box(
                                Modifier.weight(1f).height(2.dp)
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(Color.White.copy(alpha = 0.35f)),
                            ) {
                                Box(
                                    Modifier.fillMaxHeight()
                                        .fillMaxWidth(if (position == index) progress else if (position < index) 1f else 0f)
                                        .background(Color.White),
                                )
                            }
                        }
                    }

                    Row(
                        Modifier.fillMaxWidth().padding(top = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AvatarUrl(current.avatar, 32.dp)
                        Text(current.username, color = Color.White,
                            style = MaterialTheme.typography.titleMedium)
                        Text(ago(item.takenAt), color = Color.White.copy(alpha = 0.7f),
                            style = MaterialTheme.typography.labelSmall)
                        Box(Modifier.weight(1f))
                        IconButton(onClick = { nav.popBackStack() }) {
                            Icon(Icons.Filled.Close, "Close", tint = Color.White)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TapZone(modifier: Modifier, onTap: () -> Unit) {
    Box(
        modifier.fillMaxHeight().clickable(
            indication = null,
            interactionSource = remember { MutableInteractionSource() },
            onClick = onTap,
        ),
    )
}
