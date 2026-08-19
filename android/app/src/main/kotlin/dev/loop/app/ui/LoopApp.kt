package dev.loop.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PlayCircleOutline
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.loop.app.data.AppContainer
import dev.loop.app.ui.common.Loading
import dev.loop.app.ui.screens.ActivityScreen
import dev.loop.app.ui.screens.ExploreScreen
import dev.loop.app.ui.screens.FeedScreen
import dev.loop.app.ui.screens.LoginScreen
import dev.loop.app.ui.screens.PostScreen
import dev.loop.app.ui.screens.ProfileScreen
import dev.loop.app.ui.screens.ReelsScreen
import dev.loop.app.ui.screens.SearchScreen
import dev.loop.app.ui.screens.SettingsScreen
import dev.loop.app.ui.screens.SetupScreen
import dev.loop.app.ui.screens.StoryScreen
import dev.loop.app.ui.screens.TagScreen
import dev.loop.core.SessionState

/** Ambient handles so screens do not each thread the same three things through. */
val LocalContainer = staticCompositionLocalOf<AppContainer> { error("no container") }
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("no snackbar") }
val LocalSignOut = staticCompositionLocalOf<() -> Unit> { {} }

private sealed interface Phase {
    data object Loading : Phase
    data object NeedsServer : Phase
    data class NeedsAuth(val session: SessionState) : Phase
    data class Ready(val session: SessionState) : Phase
}

@Composable
fun LoopApp(container: AppContainer) {
    var phase by remember { mutableStateOf<Phase>(Phase.Loading) }
    var reloadKey by remember { mutableStateOf(0) }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(reloadKey) {
        val api = container.api
        if (api == null) {
            phase = Phase.NeedsServer
            return@LaunchedEffect
        }
        phase = try {
            val session = api.session()
            val locked = session.gateRequired && !session.gateOpen
            if (session.authenticated && !locked) Phase.Ready(session)
            else Phase.NeedsAuth(session)
        } catch (e: Throwable) {
            // A server we cannot reach is indistinguishable from one that was
            // typed wrong, so send the user to the screen that can fix both.
            Phase.NeedsAuth(SessionState())
        }
    }

    CompositionLocalProvider(
        LocalContainer provides container,
        LocalSnackbar provides snackbar,
        LocalSignOut provides { reloadKey++ },
    ) {
        when (val current = phase) {
            Phase.Loading -> Box(Modifier.fillMaxSize()) { Loading(Modifier.fillMaxSize()) }

            Phase.NeedsServer -> SetupScreen(onDone = { reloadKey++ })

            is Phase.NeedsAuth -> LoginScreen(
                gateRequired = current.session.gateRequired && !current.session.gateOpen,
                onDone = { reloadKey++ },
                onChangeServer = {
                    container.forgetServer()
                    reloadKey++
                },
            )

            is Phase.Ready -> MainScaffold(current.session, snackbar)
        }
    }
}

private data class Tab(
    val route: String,
    val label: String,
    val icon: ImageVector,
    val selectedIcon: ImageVector,
)

@Composable
private fun MainScaffold(session: SessionState, snackbar: SnackbarHostState) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route

    val tabs = listOf(
        Tab("feed", "Home", Icons.Outlined.Home, Icons.Filled.Home),
        Tab("explore", "Explore", Icons.Outlined.Search, Icons.Filled.Search),
        Tab("reels", "Reels", Icons.Outlined.PlayCircleOutline, Icons.Filled.PlayCircle),
        Tab("activity", "Activity", Icons.Outlined.FavoriteBorder, Icons.Filled.Favorite),
        Tab("user/${session.username}", "Profile", Icons.Outlined.Person, Icons.Filled.Person),
    )

    // Reels and stories are full-bleed; a bar over them would eat the video.
    val immersive = route == "reels" || route?.startsWith("story/") == true

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            if (!immersive) {
                NavigationBar(containerColor = MaterialTheme.colorScheme.background) {
                    tabs.forEach { tab ->
                        val selected = route == tab.route
                        NavigationBarItem(
                            selected = selected,
                            onClick = {
                                nav.navigate(tab.route) {
                                    popUpTo(nav.graph.startDestinationId) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = {
                                Icon(
                                    if (selected) tab.selectedIcon else tab.icon,
                                    contentDescription = tab.label,
                                )
                            },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = "feed",
            modifier = Modifier.padding(if (immersive) PaddingValues(0.dp) else padding),
        ) {
            composable("feed") { FeedScreen(nav) }
            composable("explore") { ExploreScreen(nav) }
            composable("reels") { ReelsScreen(nav) }
            composable("activity") { ActivityScreen(nav) }
            composable("search") { SearchScreen(nav) }
            composable("settings") { SettingsScreen(nav, session) }
            composable("user/{username}") { backStack ->
                ProfileScreen(nav, backStack.arguments?.getString("username").orEmpty(), session)
            }
            composable("post/{id}") { backStack ->
                PostScreen(nav, backStack.arguments?.getString("id").orEmpty())
            }
            composable("story/{id}") { backStack ->
                StoryScreen(nav, backStack.arguments?.getString("id").orEmpty())
            }
            composable("tag/{name}") { backStack ->
                TagScreen(nav, backStack.arguments?.getString("name").orEmpty())
            }
        }
    }
}

/** Shared navigation helpers so every screen spells routes the same way. */
fun NavHostController.toUser(username: String) = navigate("user/$username")
fun NavHostController.toPost(id: String) = navigate("post/$id")
fun NavHostController.toTag(name: String) = navigate("tag/$name")
fun NavHostController.toStory(id: String) = navigate("story/$id")
