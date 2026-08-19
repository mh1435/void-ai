package dev.loop.app.ui.common

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Whether video plays with sound, shared by the feed, reels and stories.
 *
 * Not persisted: starting muted every launch is the polite default, and it is
 * what you want when you open the app somewhere you would rather not announce
 * that you are using it.
 */
object Playback {
    var muted by mutableStateOf(true)
        private set

    fun toggleMuted() {
        muted = !muted
    }
}
