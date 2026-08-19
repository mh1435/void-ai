package dev.loop.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * These mirror the JSON the Loop server emits, one-for-one.
 *
 * The server already flattens Instagram's several response shapes into a
 * single post shape (see `normalise_post` in loop/instagram.py), so nothing
 * here has to know that a profile grid and a timeline arrive differently.
 *
 * Every field has a default. Instagram drops keys without warning, and a
 * missing `view_count` should never be the reason a feed fails to render.
 */

@Serializable
data class SessionState(
    @SerialName("gate_required") val gateRequired: Boolean = false,
    @SerialName("gate_open") val gateOpen: Boolean = true,
    val authenticated: Boolean = false,
    val username: String = "",
    @SerialName("user_id") val userId: String = "",
    val proxy: Boolean = false,
)

@Serializable
data class LoginResult(
    val status: String = "",
    val identifier: String = "",
    val username: String = "",
    val method: String = "",
    @SerialName("user_id") val userId: String = "",
) {
    val needsTwoFactor: Boolean get() = status == "two_factor"
}

@Serializable
data class User(
    val id: String = "",
    val username: String = "",
    @SerialName("full_name") val fullName: String = "",
    val avatar: String = "",
    @SerialName("is_verified") val isVerified: Boolean = false,
    @SerialName("is_private") val isPrivate: Boolean = false,
)

@Serializable
data class Counts(
    val posts: Int = 0,
    val followers: Int = 0,
    val following: Int = 0,
)

@Serializable
data class Profile(
    val id: String = "",
    val username: String = "",
    @SerialName("full_name") val fullName: String = "",
    val biography: String = "",
    val avatar: String = "",
    @SerialName("is_private") val isPrivate: Boolean = false,
    @SerialName("is_verified") val isVerified: Boolean = false,
    @SerialName("followed_by_viewer") val following: Boolean = false,
    @SerialName("follows_viewer") val followsYou: Boolean = false,
    @SerialName("requested_by_viewer") val requested: Boolean = false,
    @SerialName("external_url") val externalUrl: String = "",
    val counts: Counts = Counts(),
)

@Serializable
data class Slide(
    val image: String = "",
    val video: String? = null,
    val width: Int = 0,
    val height: Int = 0,
    val alt: String = "",
) {
    /** Instagram crops between 4:5 and 1.91:1; clamp so nothing runs off-screen. */
    val aspectRatio: Float
        get() = if (width <= 0 || height <= 0) 1f
        else (width.toFloat() / height).coerceIn(0.8f, 1.91f)
}

@Serializable
data class Audio(
    val title: String = "",
    val artist: String = "",
)

@Serializable
data class Post(
    val id: String = "",
    val shortcode: String = "",
    val type: String = "image",
    val user: User = User(),
    val caption: String = "",
    @SerialName("taken_at") val takenAt: Long = 0,
    @SerialName("like_count") val likeCount: Int = 0,
    @SerialName("comment_count") val commentCount: Int = 0,
    @SerialName("view_count") val viewCount: Int = 0,
    val liked: Boolean = false,
    val saved: Boolean = false,
    val location: String = "",
    val slides: List<Slide> = emptyList(),
    val video: String? = null,
    val thumb: String = "",
    val audio: Audio? = null,
) {
    val isCarousel: Boolean get() = slides.size > 1
    val isVideo: Boolean get() = video != null
}

@Serializable
data class Page(
    val posts: List<Post> = emptyList(),
    @SerialName("next_max_id") val nextMaxId: String? = null,
) {
    val hasMore: Boolean get() = nextMaxId != null
}

@Serializable
data class ProfilePage(
    val user: Profile = Profile(),
    val posts: List<Post> = emptyList(),
    @SerialName("next_max_id") val nextMaxId: String? = null,
)

@Serializable
data class TrayEntry(
    val id: String = "",
    val username: String = "",
    val avatar: String = "",
    val seen: Boolean = false,
    val count: Int = 0,
)

@Serializable
data class StoryTray(val tray: List<TrayEntry> = emptyList())

@Serializable
data class StoryItem(
    val id: String = "",
    @SerialName("taken_at") val takenAt: Long = 0,
    @SerialName("is_video") val isVideo: Boolean = false,
    val image: String = "",
    val video: String? = null,
    val duration: Double = 5.0,
) {
    val durationMillis: Long get() = (duration.coerceAtLeast(2.0) * 1000).toLong()
}

@Serializable
data class StoryReel(
    val username: String = "",
    val avatar: String = "",
    val items: List<StoryItem> = emptyList(),
)

@Serializable
data class Comment(
    val id: String = "",
    val text: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("like_count") val likeCount: Int = 0,
    val liked: Boolean = false,
    val user: User = User(),
)

@Serializable
data class CommentPage(
    val comments: List<Comment> = emptyList(),
    @SerialName("next_min_id") val nextMinId: String? = null,
    val count: Int = 0,
)

@Serializable
data class Hashtag(
    val name: String = "",
    val count: Int = 0,
)

@Serializable
data class SearchResults(
    val users: List<User> = emptyList(),
    val hashtags: List<Hashtag> = emptyList(),
)

@Serializable
data class TagPage(
    val name: String = "",
    val count: Int = 0,
    val posts: List<Post> = emptyList(),
)

@Serializable
data class ActivityItem(
    val id: String = "",
    val text: String = "",
    val timestamp: Long = 0,
    val avatar: String = "",
    val media: String = "",
    @SerialName("new") val isNew: Boolean = false,
)

@Serializable
data class ActivityFeed(val items: List<ActivityItem> = emptyList())

@Serializable
data class Health(
    val ok: Boolean = false,
    @SerialName("instagram_reachable") val instagramReachable: Boolean = false,
    val detail: String = "",
    @SerialName("upstream_proxy") val upstreamProxy: Boolean = false,
    val sessions: Int = 0,
)

@Serializable
data class LikeResult(val liked: Boolean = false)

@Serializable
data class SaveResult(val saved: Boolean = false)

@Serializable
data class FollowResult(
    val following: Boolean = false,
    val requested: Boolean = false,
)

@Serializable
data class Ok(val ok: Boolean = false)

@Serializable
internal data class ErrorBody(
    val error: String = "",
    val kind: String = "error",
)
