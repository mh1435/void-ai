package dev.loop.app.ui

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import dev.loop.app.ui.common.PostActions
import kotlinx.coroutines.launch

/**
 * Wires a post card to the API and the navigator.
 *
 * Like and save are fire-and-forget from the card's point of view: the card
 * already updated itself optimistically, so all this has to do is tell the
 * user when Instagram refused — and the card re-reads the real value on the
 * next load.
 */
@Composable
fun rememberPostActions(nav: NavHostController): PostActions {
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    return remember(nav) {
        PostActions(
            onUser = { nav.toUser(it) },
            onTag = { nav.toTag(it) },
            onComments = { nav.toPost(it.id) },
            onShare = { post ->
                // Share the Instagram link: whoever receives it may not be
                // behind the same block, and a link to your private server
                // would be useless to them anyway.
                if (post.shortcode.isNotBlank()) {
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(
                            Intent.EXTRA_TEXT,
                            "https://www.instagram.com/p/${post.shortcode}/",
                        )
                    }
                    context.startActivity(Intent.createChooser(intent, null))
                }
            },
            onLike = { post, on ->
                scope.launch {
                    runCatching { container.requireApi().like(post.id, on) }
                        .onFailure { snackbar.showSnackbar(it.message ?: "Could not like that.") }
                }
            },
            onSave = { post, on ->
                scope.launch {
                    runCatching { container.requireApi().save(post.id, on) }
                        .onFailure { snackbar.showSnackbar(it.message ?: "Could not save that.") }
                }
            },
        )
    }
}
