package dev.loop.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.loop.app.ui.LocalContainer
import dev.loop.core.LoopApi
import kotlinx.coroutines.launch

/**
 * First launch: where is your server?
 *
 * This is the one piece of configuration the app cannot guess, and the reason
 * it exists — the address is yours, so a blocked domain is replaced by pointing
 * a new one at the same deployment and typing it here.
 */
@Composable
fun SetupScreen(onDone: () -> Unit) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()

    var url by remember { mutableStateOf(container.prefs.serverUrl) }
    var error by remember { mutableStateOf<String?>(null) }
    var warning by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    var unreachable by remember { mutableStateOf(false) }

    /**
     * Saves the address whether or not the server answers.
     *
     * The check is a convenience, not a gate. A server that is merely asleep,
     * or not started yet, must not lock someone out of their own app — and the
     * Settings screen can explain the problem far better than this one can.
     */
    fun submit(force: Boolean = false) {
        error = null
        warning = null
        checking = true
        scope.launch {
            try {
                container.setServer(url)
            } catch (e: Throwable) {
                // A malformed address is worth refusing; an unreachable one is not.
                error = e.message ?: "That does not look like a server address."
                checking = false
                return@launch
            }

            val api = container.requireApi()
            if (LoopApi.isRiskyPlaintext(api.base)) {
                warning = "This sends your traffic unencrypted across the internet. " +
                    "Use https:// unless the server is on your own network."
            }

            if (force) {
                onDone()
                checking = false
                return@launch
            }

            try {
                api.session()
                onDone()
            } catch (e: Throwable) {
                unreachable = true
                error = e.message ?: "Could not reach that address."
            } finally {
                checking = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .imePadding().padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Loop", style = MaterialTheme.typography.titleLarge)
        Text(
            "Connect to your own Loop server.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 6.dp, bottom = 26.dp),
        )

        OutlinedTextField(
            value = url,
            onValueChange = { url = it; error = null },
            label = { Text("Server address") },
            placeholder = { Text("my-loop.onrender.com") },
            singleLine = true,
            isError = error != null,
            enabled = !checking,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Go,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        if (error != null) {
            Text(
                error!!,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )
        }

        if (warning != null) {
            Text(
                warning!!,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )
        }

        Button(
            onClick = { submit() },
            enabled = url.isNotBlank() && !checking,
            modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
        ) {
            Text(if (checking) "Connecting…" else "Connect")
        }

        // The server may simply not be running yet. Do not make that a dead end.
        if (unreachable && !checking) {
            TextButton(
                onClick = { submit(force = true) },
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            ) {
                Text("Save it anyway")
            }
        }

        Text(
            "This app only ever talks to the address you enter. It never " +
                "contacts Instagram directly, which is what keeps your IP " +
                "address off Instagram's side of the connection.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 26.dp),
        )

        Text(
            "Running it on your own computer? Use that computer's address on " +
                "your WiFi, like http://192.168.1.5:8080 — not 0.0.0.0. That " +
                "machine has to be able to reach Instagram itself.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 14.dp),
        )
    }
}
