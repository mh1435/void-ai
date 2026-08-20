package com.voidmusic.app.ui.search

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.voidmusic.app.domain.model.ArchiveItem

@Composable
fun SearchScreen(
    viewModel: SearchViewModel,
    onOpenItem: (ArchiveItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(
            value = viewModel.query,
            onValueChange = viewModel::onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Songs, artists, albums, or a YouTube link…") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = {
                if (viewModel.query.isNotEmpty()) {
                    IconButton(onClick = { viewModel.onQueryChange("") }) {
                        Icon(Icons.Filled.Clear, contentDescription = "Clear")
                    }
                }
            },
            singleLine = true,
        )

        Spacer(Modifier.height(16.dp))

        when (val status = viewModel.status) {
            is SearchStatus.Idle -> {
                Text("Try a song title, an artist, or paste a YouTube link.", style = MaterialTheme.typography.bodyMedium)
            }
            is SearchStatus.Loading -> LoadingRow("Searching…")
            is SearchStatus.ResolvingYoutubeLink -> LoadingRow("Reading that link…")
            is SearchStatus.Error -> {
                Text(status.message, color = MaterialTheme.colorScheme.error)
            }
            is SearchStatus.Results -> {
                if (status.albums.isEmpty()) {
                    Text("No matching albums.", style = MaterialTheme.typography.bodyMedium)
                    if (viewModel.offerYoutubeFallback) {
                        Spacer(Modifier.height(12.dp))
                        // Mirrors js/views.js's youtubeFallback(): the Archive's
                        // index is what a record label filed a song under, not
                        // what everyone actually calls it — YouTube's own index
                        // often finds what the Archive's cannot.
                        OutlinedButton(onClick = viewModel::searchYoutubeInstead) {
                            Text("Search YouTube instead")
                        }
                    }
                } else {
                    LazyColumn {
                        items(status.albums, key = { it.identifier }) { item ->
                            AlbumRow(item, onClick = { onOpenItem(item) })
                        }
                    }
                }
            }
            is SearchStatus.YoutubeResolved -> {
                LazyColumn {
                    items(status.entries) { entry ->
                        ListItem(
                            headlineContent = { Text(entry.title) },
                            supportingContent = { Text(entry.artist) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LoadingRow(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(12.dp))
        Text(text)
    }
}

@Composable
private fun AlbumRow(item: ArchiveItem, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(item.title) },
        supportingContent = { Text("${item.creator}${if (item.year.isNotEmpty()) " · ${item.year}" else ""}") },
        modifier = Modifier.clickable(onClick = onClick),
    )
}
