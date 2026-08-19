package dev.loop.app.ui.common

import androidx.compose.foundation.text.ClickableText
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import kotlin.math.floor

/** Compact relative time, the way Instagram shows it: 5m, 3h, 2d, 4w, 1y. */
fun ago(unixSeconds: Long, nowSeconds: Long = System.currentTimeMillis() / 1000): String {
    if (unixSeconds <= 0) return ""
    val seconds = (nowSeconds - unixSeconds).coerceAtLeast(1)
    return when {
        seconds < 60 -> "${seconds}s"
        seconds < 3_600 -> "${seconds / 60}m"
        seconds < 86_400 -> "${seconds / 3_600}h"
        seconds < 604_800 -> "${seconds / 86_400}d"
        seconds < 2_629_800 -> "${seconds / 604_800}w"
        else -> {
            val months = seconds / 2_629_800
            if (months < 12) "${months}mo" else "${months / 12}y"
        }
    }
}

/** 1234567 -> "1.2M", matching Instagram's counters. */
fun compactCount(value: Int): String = when {
    value < 1_000 -> value.toString()
    value < 1_000_000 -> {
        val thousands = value / 1000.0
        val text = if (value < 10_000) String.format("%.1f", floor(thousands * 10) / 10)
        else thousands.toInt().toString()
        "${text.removeSuffix(".0")}K"
    }
    else -> {
        val millions = floor(value / 100_000.0) / 10
        "${String.format("%.1f", millions).removeSuffix(".0")}M"
    }
}

private val MENTION = Regex("""[@#][\p{L}0-9._]+""")

const val TAG_MENTION = "mention"
const val TAG_HASHTAG = "hashtag"

/**
 * Captions and bios carry @mentions and #hashtags that should be tappable.
 * Returns an annotated string with the target stashed under a tag so the
 * caller can navigate on click.
 */
@Composable
fun richCaption(text: String, leadingUsername: String? = null): AnnotatedString {
    val linkColor = MaterialTheme.colorScheme.primary
    return buildAnnotatedString {
        if (leadingUsername != null) {
            pushStringAnnotation(TAG_MENTION, leadingUsername)
            withStyleBold { append(leadingUsername) }
            pop()
            append("  ")
        }
        var last = 0
        for (match in MENTION.findAll(text)) {
            if (match.range.first > last) append(text.substring(last, match.range.first))
            val token = match.value
            val tag = if (token.startsWith("@")) TAG_MENTION else TAG_HASHTAG
            pushStringAnnotation(tag, token.substring(1))
            pushStyle(SpanStyle(color = linkColor))
            append(token)
            pop()
            pop()
            last = match.range.last + 1
        }
        if (last < text.length) append(text.substring(last))
    }
}

private fun androidx.compose.ui.text.AnnotatedString.Builder.withStyleBold(block: () -> Unit) {
    pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
    block()
    pop()
}

/** Caption text whose mentions and hashtags navigate. */
@Composable
fun LinkedText(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    style: TextStyle = LocalTextStyle.current,
    onUser: (String) -> Unit = {},
    onTag: (String) -> Unit = {},
    onOther: () -> Unit = {},
) {
    val colored = if (style.color.isSpecified) style
    else style.copy(color = MaterialTheme.colorScheme.onBackground)
    ClickableText(
        text = text,
        modifier = modifier,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        style = colored,
        onClick = { offset ->
            text.getStringAnnotations(TAG_MENTION, offset, offset).firstOrNull()?.let {
                onUser(it.item); return@ClickableText
            }
            text.getStringAnnotations(TAG_HASHTAG, offset, offset).firstOrNull()?.let {
                onTag(it.item); return@ClickableText
            }
            onOther()
        },
    )
}
