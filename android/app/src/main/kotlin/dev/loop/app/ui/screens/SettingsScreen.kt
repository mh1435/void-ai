package dev.loop.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.loop.app.ui.LocalContainer
import dev.loop.app.ui.LocalSignOut
import dev.loop.app.ui.LocalSnackbar
import dev.loop.app.ui.common.Loading
import dev.loop.core.Health
import dev.loop.core.SessionState
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavHostController, session: SessionState) {
    val container = LocalContainer.current
    val snackbar = LocalSnackbar.current
    val signOut = LocalSignOut.current
    val scope = rememberCoroutineScope()

    var health by remember { mutableStateOf<Health?>(null) }
    var healthError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { container.requireApi().health() }
            .onSuccess { health = it }
            .onFailure { healthError = it.message }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = {
                IconButton(onClick = { nav.popBackStack() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = MaterialTheme.colorScheme.background,
            ),
        )

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Card("Account") {
                Text(
                    if (session.authenticated) "Signed in as @${session.username}."
                    else "Not signed in.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(
                    onClick = {
                        scope.launch {
                            runCatching { container.requireApi().logout() }
                            container.prefs.clear()
                            signOut()
                        }
                    },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                ) {
                    Text("Log out", color = MaterialTheme.colorScheme.error)
                }
            }

            Card("Server") {
                Text(
                    container.prefs.serverUrl,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    "Your phone only ever talks to this address. It never " +
                        "contacts Instagram, so Instagram sees your server's " +
                        "IP and not your device's.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedButton(onClick = {
                    container.forgetServer()
                    signOut()
                }) { Text("Change server") }
            }

            Card("Connection") {
                when {
                    healthError != null -> StatusRow(false, "Cannot reach your server", healthError)
                    health == null -> Loading()
                    else -> {
                        StatusRow(
                            good = health!!.instagramReachable,
                            title = if (health!!.instagramReachable) {
                                "Server can reach Instagram"
                            } else {
                                "Server cannot reach Instagram"
                            },
                            detail = health!!.detail,
                        )
                        StatusRow(
                            good = health!!.upstreamProxy,
                            title = if (health!!.upstreamProxy) {
                                "Going through an upstream proxy"
                            } else {
                                "Connecting directly"
                            },
                            detail = null,
                            neutral = !health!!.upstreamProxy,
                        )
                    }
                }
            }

            Card("Privacy") {
                Bullet("This app requests only the INTERNET permission. No location, contacts, storage or advertising id.")
                Bullet("It sends no device information — a fixed User-Agent, nothing about your phone, OS or locale.")
                Bullet("Instagram sees your server's IP, never your device's. It still knows which account you are, because you signed in.")
                Bullet("Your network provider can still see that you connect to your server's domain, though not what you do there. This is not a VPN.")
            }

            Card("If it stops working") {
                Bullet("If your server's domain gets blocked, point a new domain at the same deployment and change it above.")
                Bullet("If Instagram rate-limits or challenges the server, set UPSTREAM_PROXY on the host and redeploy.")
                Bullet("If you get signed out repeatedly, approve the login once in the official Instagram app, then sign in here again.")
            }
        }
    }
}

@Composable
private fun Card(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

@Composable
private fun StatusRow(good: Boolean, title: String, detail: String?, neutral: Boolean = false) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(9.dp).clip(CircleShape).background(
                when {
                    neutral -> MaterialTheme.colorScheme.onSurfaceVariant
                    good -> Color(0xFF21C063)
                    else -> MaterialTheme.colorScheme.error
                },
            ),
        )
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (!detail.isNullOrBlank()) {
                Text(detail, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Bullet(text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("•", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
