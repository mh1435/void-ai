package dev.loop.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Instagram's palette, near enough that the app feels familiar, without
// copying any asset.
private val Accent = Color(0xFF0095F6)
private val Danger = Color(0xFFED4956)

private val Dark = darkColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    background = Color(0xFF000000),
    onBackground = Color(0xFFF5F5F5),
    surface = Color(0xFF0E0E0E),
    onSurface = Color(0xFFF5F5F5),
    surfaceVariant = Color(0xFF1A1A1A),
    onSurfaceVariant = Color(0xFFA8A8A8),
    outline = Color(0xFF262626),
    error = Danger,
)

private val Light = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF000000),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF000000),
    surfaceVariant = Color(0xFFFAFAFA),
    onSurfaceVariant = Color(0xFF737373),
    outline = Color(0xFFDBDBDB),
    error = Danger,
)

private val LoopTypography = Typography(
    bodyLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodyMedium = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium),
    titleMedium = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun LoopTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) Dark else Light,
        typography = LoopTypography,
        content = content,
    )
}
