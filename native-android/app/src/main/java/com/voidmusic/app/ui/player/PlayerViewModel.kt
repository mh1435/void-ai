package com.voidmusic.app.ui.player

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.voidmusic.app.domain.model.Track
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

data class PlayerUiState(
    val queue: List<Track> = emptyList(),
    val currentIndex: Int = -1,
    val isPlaying: Boolean = false,
    val positionSec: Float = 0f,
    val durationSec: Float = 0f,
) {
    val current: Track? get() = queue.getOrNull(currentIndex)
}

class PlayerViewModel(private val player: ExoPlayer) : ViewModel() {

    var uiState by mutableStateOf(PlayerUiState())
        private set

    init {
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                uiState = uiState.copy(isPlaying = isPlaying)
            }
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                val index = player.currentMediaItemIndex
                uiState = uiState.copy(currentIndex = index, durationSec = (player.duration.takeIf { it > 0 } ?: 0L) / 1000f)
            }
        })
        // Position ticks — Media3 has no push-based position callback, so this
        // polls at a UI-relevant rate rather than every frame.
        viewModelScope.launch {
            while (true) {
                uiState = uiState.copy(positionSec = player.currentPosition / 1000f)
                delay(500)
            }
        }
    }

    fun playQueue(tracks: List<Track>, startIndex: Int = 0) {
        player.setMediaItems(tracks.map { MediaItem.fromUri(it.streamUrl) }, startIndex, 0)
        player.prepare()
        player.play()
        uiState = uiState.copy(queue = tracks, currentIndex = startIndex)
    }

    fun togglePlayPause() {
        if (player.isPlaying) player.pause() else player.play()
    }

    fun next() = player.seekToNextMediaItem()
    fun previous() = player.seekToPreviousMediaItem()
    fun seekTo(sec: Float) = player.seekTo((sec * 1000).toLong())

    override fun onCleared() {
        player.release()
    }
}
