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
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.loop.app.ui.LocalContainer
import dev.loop.core.LoginResult
import kotlinx.coroutines.launch

private sealed interface Step {
    data object Gate : Step
    data object Credentials : Step
    data class TwoFactor(val challenge: LoginResult) : Step
}

@Composable
fun LoginScreen(
    gateRequired: Boolean,
    onDone: () -> Unit,
    onChangeServer: () -> Unit,
) {
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()

    var step by remember { mutableStateOf<Step>(if (gateRequired) Step.Gate else Step.Credentials) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    var code by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var otp by remember { mutableStateOf("") }

    fun run(block: suspend () -> Unit) {
        error = null
        busy = true
        scope.launch {
            try {
                block()
            } catch (e: Throwable) {
                error = e.message ?: "That did not work."
            } finally {
                busy = false
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

        when (val current = step) {
            Step.Gate -> {
                Hint("This server is private. Enter its access code.")
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; error = null },
                    label = { Text("Access code") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                ErrorLine(error)
                Button(
                    onClick = {
                        run {
                            container.requireApi().unlock(code)
                            step = Step.Credentials
                        }
                    },
                    enabled = code.isNotBlank() && !busy,
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                ) { Text(if (busy) "Checking…" else "Unlock") }
            }

            Step.Credentials -> {
                Hint("Sign in to Instagram.")
                OutlinedTextField(
                    value = username,
                    onValueChange = { username = it; error = null },
                    label = { Text("Username") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; error = null },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Go,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                )
                ErrorLine(error)
                Button(
                    onClick = {
                        run {
                            val result = container.requireApi()
                                .login(username.trim().removePrefix("@"), password)
                            password = ""
                            if (result.needsTwoFactor) step = Step.TwoFactor(result) else onDone()
                        }
                    },
                    enabled = username.isNotBlank() && password.isNotBlank() && !busy,
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                ) { Text(if (busy) "Signing in…" else "Log in") }

                Text(
                    "Your password goes to your server, which forwards it to " +
                        "Instagram to create a session. Nothing stores it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 22.dp),
                )
            }

            is Step.TwoFactor -> {
                val where = when (current.challenge.method) {
                    "app" -> "your authenticator app"
                    "sms" -> "the SMS Instagram just sent"
                    else -> "your two-factor method"
                }
                Hint("Enter the code from $where.")
                OutlinedTextField(
                    value = otp,
                    onValueChange = { otp = it.filter(Char::isDigit).take(8); error = null },
                    label = { Text("Verification code") },
                    singleLine = true,
                    enabled = !busy,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.NumberPassword,
                        imeAction = ImeAction.Go,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                ErrorLine(error)
                Button(
                    onClick = {
                        run {
                            container.requireApi().twoFactor(
                                current.challenge.username,
                                current.challenge.identifier,
                                otp,
                            )
                            onDone()
                        }
                    },
                    enabled = otp.isNotBlank() && !busy,
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                ) { Text(if (busy) "Checking…" else "Confirm") }
            }
        }

        TextButton(onClick = onChangeServer, modifier = Modifier.padding(top = 12.dp)) {
            Text("Use a different server")
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.padding(top = 6.dp, bottom = 22.dp),
    )
}

@Composable
private fun ErrorLine(error: String?) {
    if (error == null) return
    Text(
        error,
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
    )
}
