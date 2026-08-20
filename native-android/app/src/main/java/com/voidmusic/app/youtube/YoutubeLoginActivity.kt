package com.voidmusic.app.youtube

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

/**
 * A real youtube.com sign-in inside the app — Kotlin port of the working
 * YoutubeLoginActivity.java.
 *
 * Google blocks its sign-in pages from an embedded WebView on purpose —
 * "This browser or app may not be secure" — and that check is not limited
 * to the OAuth consent screen ([YoutubeOAuthClient] correctly uses the
 * system browser for that reason); the ordinary youtube.com form gets the
 * same refusal. What actually triggers it, independent of the spoofed
 * user-agent below, is X-Requested-With — a header every WebView silently
 * attaches naming the embedding app — suppressed via the AndroidX allow-list
 * API built for exactly this. Whether that alone is enough to clear
 * Google's check is genuinely unverified: this could not be tested against
 * a live sign-in from the environment that wrote it. The "Paste cookie"
 * button covers the case where it is not.
 */
class YoutubeLoginActivity : Activity() {

    private var webView: WebView? = null
    private var resolved = false

    companion object {
        private const val START_URL = "https://www.youtube.com/"
        private fun looksSignedIn(cookies: String?) =
            cookies != null && (cookies.contains("SAPISID=") || cookies.contains("__Secure-3PAPISID="))
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        val pad = dp(12)
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val cancel = Button(this).apply { text = "Cancel"; setOnClickListener { finishWith(false, "Cancelled") } }
        val paste = Button(this).apply { text = "Paste cookie"; setOnClickListener { showPasteDialog() } }
        val gap = View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 0, 1f) }
        bar.addView(cancel); bar.addView(gap); bar.addView(paste)

        val wv = WebView(this).also { webView = it }
        wv.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.userAgentString =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(wv.settings, emptySet())
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)

        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) = checkSignedIn()
        }

        root.addView(bar)
        root.addView(wv)
        setContentView(root)
        wv.loadUrl(START_URL)
    }

    private fun checkSignedIn() {
        if (resolved) return
        val cookies = CookieManager.getInstance().getCookie("https://www.youtube.com")
        if (!looksSignedIn(cookies)) return

        val musicCookies = CookieManager.getInstance().getCookie("https://music.youtube.com")
        val combined = if (looksSignedIn(musicCookies)) musicCookies else cookies
        finishWith(true, combined ?: "")
    }

    private fun showPasteDialog() {
        val field = EditText(this).apply {
            hint = "Cookie header value, copied from a signed-in browser tab"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
            val pad = dp(16)
            setPadding(pad, pad, pad, pad)
        }
        AlertDialog.Builder(this)
            .setTitle("Paste a YouTube cookie")
            .setMessage("From a browser where you are signed in to YouTube: open dev tools on any " +
                "music.youtube.com request, find the Cookie request header, and paste its whole value here.")
            .setView(field)
            .setPositiveButton("Use this") { _, _ -> finishWith(true, field.text.toString()) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun finishWith(ok: Boolean, cookieOrMessage: String) {
        if (resolved) return
        resolved = true

        if (!ok) {
            YoutubeLoginResult.deliver(false, cookieOrMessage)
            finish()
            return
        }

        val error = (application as? HasYoutubeCookieSession)?.youtubeCookieSession?.adopt(cookieOrMessage)
        if (error != null) {
            Toast.makeText(this, error, Toast.LENGTH_LONG).show()
            resolved = false // let them try again rather than close on a rejected paste
            return
        }

        YoutubeLoginResult.deliver(true, "")
        finish()
    }

    private fun dp(value: Int) = Math.round(value * resources.displayMetrics.density)

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}

/** Implemented by the Application class so this Activity can reach the shared session store. */
interface HasYoutubeCookieSession {
    val youtubeCookieSession: YoutubeCookieSession
}

/** A tiny result channel, since this Activity has no caller to return a value to directly. */
object YoutubeLoginResult {
    private var callback: ((Boolean, String) -> Unit)? = null
    fun await(onResult: (Boolean, String) -> Unit) { callback = onResult }
    fun deliver(ok: Boolean, message: String) {
        callback?.invoke(ok, message)
        callback = null
    }
}
