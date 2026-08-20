package com.voidmusic.app.youtube

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The official, documented way to read a signed-in user's own YouTube
 * library: Authorization Code with PKCE, direct Kotlin port of the working
 * Java OAuthClient. Requires a Google Cloud Console client ID the user
 * registers once — see Settings for that flow. No client ID is compiled in:
 * this is GPL software, so anything shipped inside it is public, and an
 * Android OAuth client needs no secret anyway — Google verifies it by
 * package name and signing certificate instead.
 *
 * The browser handles the sign-in, deliberately not a WebView: Google
 * detects and blocks embedded WebViews on its OAuth consent screen
 * specifically (see YoutubeCookieSession's doc comment for the sibling
 * problem on the *plain* sign-in page, which needed a different fix).
 */
class YoutubeOAuthClient(private val context: Context, private val http: OkHttpClient) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("void_oauth", Context.MODE_PRIVATE)

    companion object {
        private const val AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
        private const val TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
        private const val SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
        const val REDIRECT_URI = "com.voidmusic.app:/oauth2redirect"
    }

    fun signedIn(): Boolean = prefs.getString("refresh_token", "").orEmpty().isNotEmpty()
    fun account(): String = prefs.getString("account", "").orEmpty()
    fun clientId(): String = prefs.getString("client_id", "").orEmpty()

    fun signOut() {
        prefs.edit()
            .remove("refresh_token").remove("access_token").remove("expires_at").remove("verifier")
            .remove("account")
            .apply()
    }

    /** Send the user to Google's real consent page in their browser. */
    fun begin(activity: Activity, clientId: String): Boolean {
        val id = clientId.trim()
        if (id.isEmpty()) return false

        val verifier = randomVerifier()
        prefs.edit().putString("client_id", id).putString("verifier", verifier).apply()

        val url = AUTH_ENDPOINT +
            "?client_id=${enc(id)}" +
            "&redirect_uri=${enc(REDIRECT_URI)}" +
            "&response_type=code" +
            "&scope=${enc(SCOPE)}" +
            "&code_challenge=${enc(challengeOf(verifier))}" +
            "&code_challenge_method=S256" +
            "&access_type=offline" +
            "&prompt=consent"

        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) {
            false
        }
    }

    /** The browser has come back to us. Returns null on success, an error message otherwise. */
    suspend fun handleRedirect(uri: Uri): String? {
        val error = uri.getQueryParameter("error")
        if (error != null) return friendly(error)

        val code = uri.getQueryParameter("code") ?: return "No authorization code in the redirect"
        return exchange(code)
    }

    private fun friendly(error: String) =
        if (error == "access_denied") "You cancelled the sign-in" else "Google refused the sign-in ($error)"

    private suspend fun exchange(code: String): String? {
        val verifier = prefs.getString("verifier", "").orEmpty()
        val id = prefs.getString("client_id", "").orEmpty()
        if (verifier.isEmpty() || id.isEmpty()) return "Sign-in expired, try again"

        val body = FormBody.Builder()
            .add("code", code)
            .add("client_id", id)
            .add("redirect_uri", REDIRECT_URI)
            .add("code_verifier", verifier)
            .add("grant_type", "authorization_code")
            .build()

        return try {
            val json = post(body)
            val refresh = json.optString("refresh_token", "")
            val access = json.optString("access_token", "")
            if (access.isEmpty()) return "Google sent no access token"

            val edit = prefs.edit()
                .putString("access_token", access)
                .putLong("expires_at", System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000)
                .remove("verifier")
            if (refresh.isNotEmpty()) edit.putString("refresh_token", refresh)
            edit.apply()
            null
        } catch (e: Exception) {
            "Could not complete sign-in (${e.message})"
        }
    }

    /** A usable access token, refreshed if it has expired. Empty when nobody is signed in. */
    suspend fun accessToken(): String {
        val access = prefs.getString("access_token", "").orEmpty()
        val expires = prefs.getLong("expires_at", 0)
        if (access.isNotEmpty() && System.currentTimeMillis() < expires - 60_000) return access

        val refresh = prefs.getString("refresh_token", "").orEmpty()
        val id = prefs.getString("client_id", "").orEmpty()
        if (refresh.isEmpty() || id.isEmpty()) return ""

        return try {
            val body = FormBody.Builder()
                .add("client_id", id)
                .add("refresh_token", refresh)
                .add("grant_type", "refresh_token")
                .build()
            val json = post(body)
            val fresh = json.optString("access_token", "")
            if (fresh.isEmpty()) return ""
            prefs.edit()
                .putString("access_token", fresh)
                .putLong("expires_at", System.currentTimeMillis() + json.optLong("expires_in", 3600) * 1000)
                .apply()
            fresh
        } catch (_: Exception) {
            ""
        }
    }

    private suspend fun post(body: FormBody): JSONObject = suspendCancellableCoroutine { cont ->
        val request = Request.Builder().url(TOKEN_ENDPOINT).post(body).build()
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = cont.resumeWith(Result.failure(e))
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val err = try {
                        JSONObject(text).let { it.optString("error_description", it.optString("error", "HTTP ${response.code}")) }
                    } catch (_: Exception) { "HTTP ${response.code}" }
                    cont.resumeWith(Result.failure(Exception(err)))
                } else {
                    cont.resumeWith(Result.success(JSONObject(text)))
                }
            }
        })
    }

    private fun randomVerifier(): String {
        val bytes = ByteArray(64)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun challengeOf(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun enc(v: String) = java.net.URLEncoder.encode(v, "UTF-8")
}
