package com.voidmusic.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.voidmusic.app.domain.model.ArchiveItem
import com.voidmusic.app.ui.player.MiniPlayerBar
import com.voidmusic.app.ui.player.PlayerScreen
import com.voidmusic.app.ui.player.PlayerViewModel
import com.voidmusic.app.ui.search.SearchScreen
import com.voidmusic.app.ui.search.SearchViewModel

private data class Tab(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)

private val TABS = listOf(
    Tab("search", "Search", Icons.Filled.Search),
    Tab("player", "Player", Icons.Filled.PlayArrow),
    Tab("settings", "Settings", Icons.Filled.Settings),
)

@Composable
fun VoidMusicRoot(
    playerViewModel: PlayerViewModel,
    searchViewModel: SearchViewModel,
    onOpenArchiveItem: (ArchiveItem) -> Unit,
    onSignInWithYoutube: ((Boolean, String) -> Unit) -> Unit,
) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    Scaffold(
        bottomBar = {
            NavigationBar {
                TABS.forEach { tab ->
                    NavigationBarItem(
                        selected = currentRoute == tab.route,
                        onClick = { navController.navigate(tab.route) { launchSingleTop = true } },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            if (currentRoute != "player" && playerViewModel.uiState.current != null) {
                MiniPlayerBar(playerViewModel, onExpand = { navController.navigate("player") })
            }
            NavHost(navController, startDestination = "search", modifier = Modifier.fillMaxSize()) {
                composable("search") { SearchScreen(searchViewModel, onOpenItem = onOpenArchiveItem) }
                composable("player") { PlayerScreen(playerViewModel) }
                composable("settings") { SettingsScreen(searchViewModel, onSignInWithYoutube) }
            }
        }
    }
}

/**
 * The two required behaviours from the spec live here: the pre-2005 filter
 * toggle, and the YouTube sign-in entry point (both auth paths — OAuth is
 * the primary flow to wire a client-ID field into; cookie sign-in needs no
 * field at all).
 */
@Composable
private fun SettingsScreen(
    searchViewModel: SearchViewModel,
    onSignInWithYoutube: ((Boolean, String) -> Unit) -> Unit,
) {
    var modernOnly by remember { mutableStateOf(true) }
    var signInStatus by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        ListItem(
            headlineContent = { Text("Modern releases only") },
            supportingContent = { Text("Hide anything released before 2005, and anything the Archive has no year for.") },
            trailingContent = {
                Switch(
                    checked = modernOnly,
                    onCheckedChange = { checked ->
                        modernOnly = checked
                        // Mirrors js/archive.js: 0 disables the cutoff entirely.
                        searchViewModel.setMinYear(if (checked) 2005 else 0)
                    },
                )
            },
        )
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("YouTube") },
            supportingContent = { Text(signInStatus.ifEmpty { "Not connected" }) },
            trailingContent = {
                TextButton(onClick = {
                    onSignInWithYoutube { ok, message ->
                        signInStatus = if (ok) "Connected" else message
                    }
                }) { Text("Sign in") }
            },
        )
    }
}
