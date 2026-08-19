package dev.loop.app.data

import android.content.Context
import dev.loop.core.LoopApi

/**
 * Hand-rolled dependency holder. A DI framework would be more machinery than
 * this app has moving parts.
 *
 * The API client is rebuilt whenever the server address changes, because the
 * host guard inside it is bound to a single hostname — which is the point.
 */
class AppContainer(context: Context) {

    val prefs = Prefs(context)

    private var cached: Pair<String, LoopApi>? = null

    val isConfigured: Boolean get() = prefs.isConfigured

    /** Null until a server has been configured. */
    val api: LoopApi?
        get() {
            val url = prefs.serverUrl
            if (url.isBlank()) return null
            cached?.let { (cachedUrl, api) -> if (cachedUrl == url) return api }
            return runCatching { LoopApi(url, prefs) }
                .onSuccess { cached = url to it }
                .getOrNull()
        }

    /** Requires a configured server; call sites past the setup screen. */
    fun requireApi(): LoopApi = api ?: error("no server configured")

    fun setServer(url: String) {
        // Validate before storing, so a typo cannot leave the app unable to boot.
        val normalised = LoopApi.normaliseBase(url).toString()
        prefs.serverUrl = normalised
        cached = null
    }

    fun forgetServer() {
        prefs.reset()
        cached = null
    }
}
