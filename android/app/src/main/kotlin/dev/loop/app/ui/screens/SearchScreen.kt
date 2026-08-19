package dev.loop.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.common.Avatar
import dev.loop.app.ui.common.EmptyState
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.VerifiedBadge
import dev.loop.app.ui.common.compactCount
import dev.loop.app.ui.toTag
import dev.loop.app.ui.toUser
import dev.loop.core.Hashtag
import dev.loop.core.SearchResults
import dev.loop.core.User
import kotlinx.coroutines.delay

@Composable
fun SearchScreen(nav: NavHostController) {
    val api = LocalContainer.current.requireApi()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<SearchResults?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var loading by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    // Debounce: typing is fast and Instagram's search endpoint is rate-limited.
    // Re-running on every `query` change cancels the previous wait for free.
    LaunchedEffect(query) {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) {
            results = null
            error = null
            loading = false
            return@LaunchedEffect
        }
        delay(320)
        loading = true
        error = null
        try {
            results = api.search(trimmed)
        } catch (e: Throwable) {
            error = e
        }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text("Search") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(12.dp).focusRequester(focus),
        )

        when {
            loading && results == null -> Loading()
            error != null -> ErrorState(error!!) { query = query }
            results == null -> EmptyState(
                "Search Instagram",
                "Find people and hashtags by name.",
            )
            results!!.users.isEmpty() && results!!.hashtags.isEmpty() -> EmptyState(
                "No results",
                "Nothing matched “${query.trim()}”.",
            )
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(results!!.users, key = { "u${it.id}${it.username}" }) { user ->
                    UserRow(user) { nav.toUser(user.username) }
                }
                items(results!!.hashtags, key = { "t${it.name}" }) { tag ->
                    HashtagRow(tag) { nav.toTag(tag.name) }
                }
            }
        }
    }
}

@Composable
private fun UserRow(user: User, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(user, 44.dp)
        Column(Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(user.username, style = MaterialTheme.typography.titleMedium)
                if (user.isVerified) VerifiedBadge()
            }
            if (user.fullName.isNotBlank()) {
                Text(user.fullName, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (user.isPrivate) {
            Text("Private", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun HashtagRow(tag: Hashtag, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(44.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Text("#", style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(Modifier.weight(1f)) {
            Text("#${tag.name}", style = MaterialTheme.typography.titleMedium)
            Text("${compactCount(tag.count)} posts",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
