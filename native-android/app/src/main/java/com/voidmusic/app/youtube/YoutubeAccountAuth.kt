package com.voidmusic.app.youtube

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Sign-in through a Google account already added on the device, the same
 * mechanism other clients point people at "install microG" for. This is the
 * classic android.accounts.AccountManager "oauth2:<scope>" authenticator
 * flow — a different, older mechanism than com.google.android.gms.auth.api
 * .signin.GoogleSignInClient (the one that threw "UnregisteredOnApiConsole"
 * earlier, because that API validates the requesting app against a
 * registered Cloud Console OAuth client). This one asks whichever account
 * authenticator is installed — real Google Play Services, or microG
 * standing in for it — for a token against Android's own built-in OAuth
 * client, the same way apps have requested Google API access from a device
 * account for years, with no client of our own to register.
 *
 * Unverified against a real microG install from this sandbox. If this also
 * fails, [lastDiagnostic] carries whatever the authenticator actually said,
 * the same ground-truth-first approach as [YoutubeCookieSession].
 */
class YoutubeAccountAuth(private val context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("void_account_auth", Context.MODE_PRIVATE)

    companion object {
        private const val ACCOUNT_TYPE = "com.google"
        private const val SCOPE = "oauth2:https://www.googleapis.com/auth/youtube.readonly"
    }

    @Volatile var lastDiagnostic: String = ""
        private set

    fun accountName(): String = prefs.getString("account", "").orEmpty()
    fun signedIn(): Boolean = accountName().isNotEmpty()

    fun signOut() {
        prefs.edit().remove("account").apply()
    }

    /** The system's own account picker — no GET_ACCOUNTS permission needed for this. */
    fun pickAccountIntent(): Intent =
        AccountManager.newChooseAccountIntent(null, null, arrayOf(ACCOUNT_TYPE), null, null, null, null)

    /** Call with the picked-account Activity Result. Stores and returns the chosen name, or null if cancelled. */
    fun onAccountPicked(data: Intent?): String? =
        data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)?.also { name ->
            prefs.edit().putString("account", name).apply()
        }

    /** Interactive: may show the authenticator's own consent screen on top of [activity], the first time. */
    suspend fun connect(activity: Activity): String = withContext(Dispatchers.IO) {
        val name = accountName()
        if (name.isEmpty()) {
            lastDiagnostic = "No Google account chosen"
            return@withContext ""
        }
        try {
            val bundle = AccountManager.get(context)
                .getAuthToken(Account(name, ACCOUNT_TYPE), SCOPE, null, activity, null, null)
                .result
            val token = bundle.getString(AccountManager.KEY_AUTHTOKEN).orEmpty()
            lastDiagnostic = if (token.isEmpty())
                "$name did not return a usable token. Check that microG's Google Accounts and Device Registration are both on."
            else ""
            token
        } catch (e: Exception) {
            lastDiagnostic = describeFailure(name, e)
            ""
        }
    }

    /** Silent: for background calls once already connected — empty (no UI) if fresh consent is needed. */
    suspend fun accessToken(): String = withContext(Dispatchers.IO) {
        val name = accountName()
        if (name.isEmpty()) return@withContext ""
        try {
            val bundle = AccountManager.get(context)
                .getAuthToken(Account(name, ACCOUNT_TYPE), SCOPE, null, false, null, null)
                .result
            bundle.getString(AccountManager.KEY_AUTHTOKEN).orEmpty()
        } catch (e: Exception) {
            lastDiagnostic = describeFailure(name, e)
            ""
        }
    }

    private fun describeFailure(name: String, e: Exception): String =
        "Could not get a YouTube token for $name (${e.message ?: e.javaClass.simpleName}). " +
            "This needs microG (with Google Accounts + Device Registration on) or real Google Play Services."
}
