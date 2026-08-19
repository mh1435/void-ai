package dev.loop.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import dev.loop.app.data.AppContainer

class LoopApplication : Application(), ImageLoaderFactory {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }

    /**
     * Image loading shares the API client, which matters for two reasons: the
     * session cookie rides along so /media accepts the request, and the host
     * guard applies — so a stray URL cannot make the image loader talk to
     * Instagram directly and hand over the device's IP.
     */
    override fun newImageLoader(): ImageLoader {
        val builder = ImageLoader.Builder(this)
            .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.25).build() }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("media"))
                    .maxSizeBytes(256L * 1024 * 1024)
                    .build()
            }
            .crossfade(true)
        container.api?.let { builder.okHttpClient(it.client) }
        return builder.build()
    }
}
