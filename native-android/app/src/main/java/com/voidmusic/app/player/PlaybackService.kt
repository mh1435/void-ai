package com.voidmusic.app.player

import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.voidmusic.app.VoidMusicApp

/**
 * Keeps audio playing and the lock-screen/notification controls live when
 * the app is backgrounded — Media3's own foreground-service session, which
 * is what the WebView app's PlaybackService.java hand-rolls against
 * MediaSessionCompat directly. A real Media3 app gets this mostly for free.
 */
class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player: ExoPlayer = (application as VoidMusicApp).container.exoPlayer
        mediaSession = MediaSession.Builder(this, player).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onDestroy() {
        mediaSession?.run {
            player.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }
}
