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
    var checking by remember { mutableStateOf(false) }

    fun submit() {
        error = null
        checking = true
        scope.launch {
            try {
                container.setServer(url)
                // Prove it answers before committing the user to it: a typo
                // here would otherwise look like the block.
                container.requireApi().session()
                onDone()
            } catch (e: Throwable) {
                container.forgetServer()
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

        Button(
            onClick = ::submit,
            enabled = url.isNotBlank() && !checking,
            modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
        ) {
            Text(if (checking) "Connecting…" else "Connect")
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
    }
}
