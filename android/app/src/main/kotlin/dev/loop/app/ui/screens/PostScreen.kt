package dev.loop.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.LocalSnackbar
import dev.loop.app.ui.common.Avatar
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.LinkedText
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.PostCard
import dev.loop.app.ui.common.ago
import dev.loop.app.ui.common.compactCount
import dev.loop.app.ui.common.richCaption
import dev.loop.app.ui.rememberPostActions
import dev.loop.app.ui.toTag
import dev.loop.app.ui.toUser
import dev.loop.core.Comment
import dev.loop.core.Post
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PostScreen(nav: NavHostController, id: String) {
    val api = LocalContainer.current.requireApi()
    val snackbar = LocalSnackbar.current
    val scope = rememberCoroutineScope()
    val actions = rememberPostActions(nav)

    var post by remember(id) { mutableStateOf<Post?>(null) }
    var comments by remember(id) { mutableStateOf<List<Comment>>(emptyList()) }
    var error by remember(id) { mutableStateOf<Throwable?>(null) }
    var loadingComments by remember(id) { mutableStateOf(true) }
    var reload by remember(id) { mutableStateOf(0) }
    var draft by remember(id) { mutableStateOf("") }
    var sending by remember(id) { mutableStateOf(false) }

    LaunchedEffect(id, reload) {
        error = null
        try {
            post = api.post(id)
        } catch (e: Throwable) {
            error = e
            return@LaunchedEffect
        }
        loadingComments = true
        runCatching { api.comments(id) }
            .onSuccess { comments = it.comments }
        loadingComments = false
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopAppBar(
            title = { Text("Post") },
            navigationIcon = {
                IconButton(onClick = { nav.popBackStack() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.background,
            ),
        )

        when {
            error != null -> ErrorState(error!!, Modifier.fillMaxSize()) { reload++ }
            post == null -> Loading(Modifier.fillMaxSize())
            else -> {
                LazyColumn(Modifier.weight(1f)) {
                    item(key = "post") {
                        PostCard(post!!, actions, expandCaption = true)
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                    item(key = "heading") {
                        Text(
                            "Comments",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                    if (loadingComments) {
                        item(key = "loading") { Loading() }
                    } else if (comments.isEmpty()) {
                        item(key = "empty") {
                            Text(
                                "No comments yet.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                    }
                    items(comments, key = { it.id }) { comment ->
                        CommentRow(comment, nav)
                    }
                    item(key = "tail") { Spacer(Modifier.height(24.dp)) }
                }

                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = { Text("Add a comment…") },
                        enabled = !sending,
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        onClick = {
                            val text = draft.trim()
                            if (text.isEmpty()) return@TextButton
                            sending = true
                            scope.launch {
                                runCatching { api.addComment(id, text) }
                                    .onSuccess {
                                        comments = listOf(it) + comments
                                        draft = ""
                                    }
                                    .onFailure {
                                        snackbar.showSnackbar(
                                            it.message ?: "Comment was not posted.",
                                        )
                                    }
                                sending = false
                            }
                        },
                        enabled = draft.isNotBlank() && !sending,
                    ) { Text("Post") }
                }
            }
        }
    }
}

@Composable
private fun CommentRow(comment: Comment, nav: NavHostController) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(comment.user, 32.dp)
        Column(Modifier.weight(1f)) {
            LinkedText(
                text = richCaption(comment.text, comment.user.username),
                style = MaterialTheme.typography.bodyLarge,
                onUser = { nav.toUser(it) },
                onTag = { nav.toTag(it) },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(ago(comment.createdAt), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (comment.likeCount > 0) {
                    Text("${compactCount(comment.likeCount)} likes",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
