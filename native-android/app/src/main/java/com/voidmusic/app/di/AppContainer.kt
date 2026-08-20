package com.voidmusic.app.di

import android.content.Context
import androidx.media3.exoplayer.ExoPlayer
import com.voidmusic.app.data.archive.ArchiveApi
import com.voidmusic.app.data.archive.ArchiveRepository
import com.voidmusic.app.data.backend.BackendRouter
import com.voidmusic.app.youtube.YoutubeCookieSession
import com.voidmusic.app.youtube.YoutubeOAuthClient
import com.voidmusic.app.youtube.YoutubeRepository
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Manual dependency container — no annotation-processing framework, so the
 * whole graph is readable in one file rather than spread across generated
 * code this environment cannot compile to verify anyway.
 */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext

    val json = Json { ignoreUnknownKeys = true }

    val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl("https://archive.org/") // overridden per-call via @Url
        .client(okHttpClient)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    val archiveApi: ArchiveApi = retrofit.create(ArchiveApi::class.java)
    val backendRouter = BackendRouter(okHttpClient, json)
    val archiveRepository = ArchiveRepository(archiveApi, backendRouter)

    val youtubeOAuthClient = YoutubeOAuthClient(appContext, okHttpClient)
    val youtubeCookieSession = YoutubeCookieSession(appContext, okHttpClient)
    val youtubeRepository = YoutubeRepository(youtubeOAuthClient, youtubeCookieSession, okHttpClient)

    val exoPlayer: ExoPlayer by lazy { ExoPlayer.Builder(appContext).build() }
}
