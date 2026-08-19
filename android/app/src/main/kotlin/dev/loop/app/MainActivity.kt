package dev.loop.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import dev.loop.app.ui.LoopApp
import dev.loop.app.ui.theme.LoopTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            val container = remember { (application as LoopApplication).container }
            LoopTheme {
                LoopApp(container)
            }
        }
    }
}
