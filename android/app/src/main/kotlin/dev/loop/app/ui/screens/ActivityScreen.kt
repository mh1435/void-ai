package dev.loop.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.common.AvatarUrl
import dev.loop.app.ui.common.EmptyState
import dev.loop.app.ui.common.ErrorState
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.common.RemoteImage
import dev.loop.app.ui.common.ago
import dev.loop.core.ActivityItem

@Composable
fun ActivityScreen(nav: NavHostController) {
    val api = LocalContainer.current.requireApi()
    var items by remember { mutableStateOf<List<ActivityItem>?>(null) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(reload) {
        error = null
        runCatching { api.activity().items }
            .onSuccess { items = it }
            .onFailure { error = it }
    }

    when {
        error != null -> ErrorState(error!!, Modifier.fillMaxSize()) { reload++ }
        items == null -> Loading(Modifier.fillMaxSize())
        items!!.isEmpty() -> EmptyState(
            "No activity yet",
            "Likes, comments and follows show up here.",
        )
        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(items!!, key = { it.id }) { item -> ActivityRow(item) }
        }
    }
}

@Composable
private fun ActivityRow(item: ActivityItem) {
    Row(
        Modifier.fillMaxWidth()
            .background(
                if (item.isNew) MaterialTheme.colorScheme.surfaceVariant
                else MaterialTheme.colorScheme.background,
            )
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (item.avatar.isNotBlank()) AvatarUrl(item.avatar, 44.dp)
        Column(Modifier.weight(1f)) {
            Text(item.text, style = MaterialTheme.typography.bodyLarge)
            Text(ago(item.timestamp), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (item.media.isNotBlank()) {
            RemoteImage(
                url = item.media,
                contentDescription = null,
                modifier = Modifier.size(44.dp).clip(RoundedCornerShape(4.dp)),
            )
        }
    }
}
