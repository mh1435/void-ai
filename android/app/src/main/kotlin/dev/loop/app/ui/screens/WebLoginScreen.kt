package dev.loop.app.ui.screens

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Logs into Instagram inside the app.
 *
 * A WebView is a real browser, so it handles whatever Instagram throws at a
 * login — including the checkpoint that a headless request cannot answer. When
 * the login lands, the session cookie and, crucially, *this WebView's own
 * user-agent* are handed back: the two match by construction, which is the
 * whole reason a pasted browser cookie kept being rejected as a mismatch.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebLoginScreen(
    onCaptured: (sessionid: String, userAgent: String) -> Unit,
) {
    val handled = remember { booleanArrayOf(false) }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            val cookies = CookieManager.getInstance()
            cookies.setAcceptCookie(true)

            WebView(context).apply {
                cookies.setAcceptThirdPartyCookies(this, true)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true

                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        if (handled[0]) return
                        val jar = cookies.getCookie("https://www.instagram.com") ?: return
                        val sessionid = jar.split(";")
                            .map { it.trim() }
                            .firstOrNull { it.startsWith("sessionid=") }
                            ?.removePrefix("sessionid=")
                            ?.takeIf { it.isNotBlank() }
                            ?: return

                        // A sessionid appears only once logged in; make sure we
                        // are off the login/challenge pages before accepting it.
                        val onLoginFlow = url.contains("/accounts/login") ||
                            url.contains("/challenge") ||
                            url.contains("/two_factor")
                        if (!onLoginFlow) {
                            handled[0] = true
                            onCaptured(sessionid, settings.userAgentString ?: "")
                        }
                    }
                }
                loadUrl("https://www.instagram.com/accounts/login/")
            }
        },
    )
}
