package dev.loop.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.LocalSnackbar
import dev.loop.app.ui.common.Avatar
import dev.loop.app.ui.common.EmptyState
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.LinkedText
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.PagedPosts
import dev.loop.app.ui.common.VerifiedBadge
import dev.loop.app.ui.common.compactCount
import dev.loop.app.ui.common.richCaption
import dev.loop.app.ui.toTag
import dev.loop.app.ui.toUser
import dev.loop.core.Profile
import dev.loop.core.SessionState
import dev.loop.core.User
import kotlinx.coroutines.launch

@Composable
fun ProfileScreen(nav: NavHostController, username: String, session: SessionState) {
    val api = LocalContainer.current.requireApi()

    var profile by remember(username) { mutableStateOf<Profile?>(null) }
    var error by remember(username) { mutableStateOf<Throwable?>(null) }
    var reload by remember(username) { mutableStateOf(0) }

    // The profile endpoint returns its first page inline, then paging switches
    // to the user-feed endpoint — which is why PagedPosts can be seeded.
    val paged = remember(username) {
        PagedPosts { cursor -> api.userFeed(profile?.id.orEmpty(), cursor) }
    }

    LaunchedEffect(username, reload) {
        error = null
        try {
            val page = api.profile(username)
            profile = page.user
            paged.seed(page.posts, hasMore = page.posts.isNotEmpty())
        } catch (e: Throwable) {
            error = e
        }
    }

    when {
        error != null -> ErrorState(error!!, Modifier.fillMaxSize()) { reload++ }
        profile == null -> Loading(Modifier.fillMaxSize())
        else -> {
            val user = profile!!
            val locked = user.isPrivate && !user.following && user.username != session.username
            if (locked) {
                Column(Modifier.fillMaxSize()) {
                    ProfileHeader(user, session, nav)
                    EmptyState(
                        "This account is private",
                        "Follow this account to see their photos and videos.",
                    )
                }
            } else {
                PostGrid(
                    paged, nav,
                    emptyTitle = "No posts yet",
                    header = { ProfileHeader(user, session, nav) },
                )
            }
        }
    }
}

@Composable
private fun ProfileHeader(user: Profile, session: SessionState, nav: NavHostController) {
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()

    var following by remember(user.id) { mutableStateOf(user.following) }
    var requested by remember(user.id) { mutableStateOf(user.requested) }
    var busy by remember(user.id) { mutableStateOf(false) }

    Column(
        Modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(
                User(username = user.username, avatar = user.avatar),
                86.dp,
            )
            Row(
                Modifier.weight(1f).padding(start = 20.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                Stat(user.counts.posts, "posts")
                Stat(user.counts.followers, "followers")
                Stat(user.counts.following, "following")
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(
                    user.fullName.ifBlank { user.username },
                    style = MaterialTheme.typography.titleMedium,
                )
                if (user.isVerified) VerifiedBadge()
            }
            if (user.biography.isNotBlank()) {
                LinkedText(
                    text = richCaption(user.biography),
                    style = MaterialTheme.typography.bodyLarge,
                    onUser = { nav.toUser(it) },
                    onTag = { nav.toTag(it) },
                )
            }
            if (user.externalUrl.isNotBlank()) {
                Text(
                    user.externalUrl.removePrefix("https://").removePrefix("http://"),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (user.followsYou) {
                Text(
                    "Follows you",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (user.username != session.username) {
            Button(
                onClick = {
                    val next = !following
                    following = next
                    requested = false
                    busy = true
                    scope.launch {
                        runCatching { container.requireApi().follow(user.id, next) }
                            .onSuccess { following = it.following; requested = it.requested }
                            .onFailure {
                                following = !next
                                snackbar.showSnackbar(it.message ?: "Could not do that.")
                            }
                        busy = false
                    }
                },
                enabled = !busy,
                colors = if (following || requested) {
                    ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onBackground,
                    )
                } else {
                    ButtonDefaults.buttonColors()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (requested) "Requested" else if (following) "Following" else "Follow")
            }
        }
    }
}

@Composable
private fun Stat(value: Int, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(compactCount(value), style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold)
        Text(label, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
