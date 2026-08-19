package dev.loop.app.data

import android.content.Context
import android.content.SharedPreferences
import dev.loop.core.CookieStore

/**
 * Everything this app remembers, which is deliberately very little: the
 * address of your server, and the opaque session token it gave you.
 *
 * Plain SharedPreferences rather than EncryptedSharedPreferences: the file is
 * already inside the app's private storage, which the OS sandbox protects and
 * full-disk encryption covers, and backups are disabled in the manifest. The
 * encrypted variant would add an alpha-stage dependency to protect against an
 * attacker who already has root, which is not a threat this can survive anyway.
 *
 * The Instagram password is never here. It goes to the server, which forwards
 * it to Instagram, and nothing keeps it afterwards.
 */
class Prefs(context: Context) : CookieStore {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("loop", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    val isConfigured: Boolean get() = serverUrl.isNotBlank()

    // -- CookieStore --------------------------------------------------------

    override fun load(): Map<String, String> {
        val blob = prefs.getString(KEY_COOKIES, "").orEmpty()
        if (blob.isBlank()) return emptyMap()
        return blob.split('\n').mapNotNull { line ->
            val index = line.indexOf('=')
            if (index <= 0) null else line.substring(0, index) to line.substring(index + 1)
        }.toMap()
    }

    override fun save(cookies: Map<String, String>) {
        // Cookie names cannot contain '=' or newlines, so this encoding is
        // unambiguous without pulling in a JSON round-trip.
        val blob = cookies.entries.joinToString("\n") { "${it.key}=${it.value}" }
        prefs.edit().putString(KEY_COOKIES, blob).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_COOKIES).apply()
    }

    /** Forget the server too — used by "Change server" in Settings. */
    fun reset() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_SERVER = "server_url"
        const val KEY_COOKIES = "cookies"
    }
}
