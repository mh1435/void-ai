package com.voidmusic.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.voidmusic.app.ui.VoidMusicRoot
import com.voidmusic.app.ui.player.PlayerViewModel
import com.voidmusic.app.ui.search.SearchViewModel
import com.voidmusic.app.youtube.YoutubeLoginResult
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val app get() = application as VoidMusicApp

    // Same-shaped factory as the ViewModel classes' constructors —
    // deliberately manual, matching AppContainer's no-framework approach.
    private val playerViewModel: PlayerViewModel by viewModels {
        object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                @Suppress("UNCHECKED_CAST") (PlayerViewModel(app.container.exoPlayer) as T)
        }
    }
    private val searchViewModel: SearchViewModel by viewModels {
        object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                @Suppress("UNCHECKED_CAST") (SearchViewModel(app.container.archiveRepository, app.container.youtubeRepository) as T)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleOAuthIntent(intent)

        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                VoidMusicRoot(
                    playerViewModel = playerViewModel,
                    searchViewModel = searchViewModel,
                    onOpenArchiveItem = { item ->
                        lifecycleScope.launch {
                            val tracks = searchViewModel.tracksFor(item.identifier)
                            if (tracks.isNotEmpty()) playerViewModel.playQueue(tracks)
                        }
                    },
                    onSignInWithYoutube = ::openYoutubeCookieLogin,
                    onSignInWithGoogleAccount = ::pickGoogleAccount,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleOAuthIntent(intent)
    }

    /** The system browser returning from Google's OAuth consent page. */
    private fun handleOAuthIntent(intent: Intent?) {
        val data = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data ?: return
        lifecycleScope.launch {
            app.container.youtubeOAuthClient.handleRedirect(data)
        }
    }

    /** Opens the in-app youtube.com sign-in and awaits its result. */
    private fun openYoutubeCookieLogin(onDone: (Boolean, String) -> Unit) {
        YoutubeLoginResult.await(onDone)
        startActivity(Intent(this, com.voidmusic.app.youtube.YoutubeLoginActivity::class.java))
    }

    /** Where an account-picker result should be delivered, set just before launching it. */
    private var onAccountChosen: ((Boolean, String) -> Unit)? = null

    private val accountPicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val done = onAccountChosen
        onAccountChosen = null
        val auth = app.container.youtubeAccountAuth
        val name = auth.onAccountPicked(result.data)
        if (name == null) {
            done?.invoke(false, "No account chosen")
            return@registerForActivityResult
        }
        // getAuthToken may need to put its own consent screen on top of us the
        // first time, so this runs interactively with the Activity attached.
        lifecycleScope.launch {
            val token = auth.connect(this@MainActivity)
            if (token.isNotEmpty()) done?.invoke(true, "Connected as $name")
            else done?.invoke(false, auth.lastDiagnostic.ifEmpty { "Could not get a token for $name" })
        }
    }

    /** Sign in with a Google account already on the device (this is the microG path). */
    private fun pickGoogleAccount(onDone: (Boolean, String) -> Unit) {
        onAccountChosen = onDone
        try {
            accountPicker.launch(app.container.youtubeAccountAuth.pickAccountIntent())
        } catch (e: Exception) {
            onAccountChosen = null
            onDone(false, "No account picker on this device (${e.message})")
        }
    }
}
