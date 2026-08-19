package dev.loop.core

/**
 * Every failure this app can show a person, named by what they should do
 * about it. The `kind` strings come from the server (loop/app.py); anything
 * unrecognised degrades to [Server] rather than crashing.
 */
sealed class LoopError(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** The phone cannot reach the Loop server. Usually the block, or a sleeping host. */
    class Offline(cause: Throwable? = null) : LoopError(
        "Cannot reach your Loop server. Check your connection, or whether the server is awake.",
        cause,
    )

    /** The server is locked behind ACCESS_CODE and this device has not unlocked it. */
    class Gate(message: String = "This server is locked.") : LoopError(message)

    /** Instagram wants a fresh sign-in. */
    class LoginRequired(message: String = "Sign in to Instagram again.") : LoopError(message)

    /** Instagram flagged the login and wants confirmation in the official app. */
    class Challenge(message: String) : LoopError(message)

    class RateLimited(message: String) : LoopError(message)

    /** The *server* could not reach Instagram — the interesting case for this app. */
    class Upstream(message: String) : LoopError(message)

    class NotFound(message: String) : LoopError(message)

    class BadCredentials(message: String) : LoopError(message)

    class Server(message: String) : LoopError(message)

    /** True when the right response is to send the user back to a sign-in screen. */
    val isAuthFailure: Boolean get() = this is LoginRequired || this is Gate

    companion object {
        fun fromKind(kind: String, message: String): LoopError = when (kind) {
            "gate" -> Gate(message)
            "login_required" -> LoginRequired(message)
            "challenge" -> Challenge(message)
            "rate_limited" -> RateLimited(message)
            "upstream_unreachable" -> Upstream(message)
            "not_found" -> NotFound(message)
            "bad_password", "bad_user", "bad_code", "input" -> BadCredentials(message)
            else -> Server(message)
        }
    }
}
