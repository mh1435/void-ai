package dev.loop.core

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * Where the session token lives between launches.
 *
 * Only two cookies ever matter: `loop_sid` (this browser's opaque session id)
 * and `loop_gate` (proof the access code was entered). Instagram's own cookies
 * never leave the server, so nothing sensitive to Instagram is stored here.
 */
interface CookieStore {
    fun load(): Map<String, String>
    fun save(cookies: Map<String, String>)
    fun clear()
}

/** For tests and for a first launch before storage is wired up. */
class InMemoryCookieStore(initial: Map<String, String> = emptyMap()) : CookieStore {
    private var cookies = initial.toMutableMap()
    override fun load(): Map<String, String> = cookies.toMap()
    override fun save(cookies: Map<String, String>) {
        this.cookies = cookies.toMutableMap()
    }
    override fun clear() = cookies.clear()
}

/**
 * OkHttp cookie jar backed by [CookieStore].
 *
 * Deliberately host-agnostic: the user's server hostname is whatever they
 * chose, and it can change (that is the escape hatch when a domain gets
 * blocked). Cookies are only ever sent to the one configured base URL, which
 * [LoopApi] is the sole caller of.
 */
class LoopCookieJar(private val store: CookieStore) : CookieJar {

    private val cache = LinkedHashMap<String, String>().apply { putAll(store.load()) }

    override fun loadForRequest(url: HttpUrl): List<Cookie> = synchronized(this) {
        cache.map { (name, value) ->
            Cookie.Builder()
                .name(name)
                .value(value)
                .domain(url.host)
                .path("/")
                .build()
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = synchronized(this) {
        var changed = false
        for (cookie in cookies) {
            // A server-side logout clears the cookie by expiring it.
            if (cookie.value.isEmpty() || cookie.expiresAt < System.currentTimeMillis()) {
                if (cache.remove(cookie.name) != null) changed = true
            } else if (cache.put(cookie.name, cookie.value) != cookie.value) {
                changed = true
            }
        }
        if (changed) store.save(cache)
    }

    fun clear() = synchronized(this) {
        cache.clear()
        store.clear()
    }
}
