package com.voidmusic.app

import android.app.Application
import com.voidmusic.app.di.AppContainer
import com.voidmusic.app.youtube.HasYoutubeCookieSession
import com.voidmusic.app.youtube.YoutubeCookieSession

class VoidMusicApp : Application(), HasYoutubeCookieSession {
    lateinit var container: AppContainer
        private set

    override val youtubeCookieSession: YoutubeCookieSession
        get() = container.youtubeCookieSession

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
