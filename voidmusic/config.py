"""Runtime configuration, all via environment variables."""

import os

# --- Where we listen -------------------------------------------------------
PORT = int(os.environ.get("PORT", 8080))
HOST = os.environ.get("HOST", "0.0.0.0")

# --- Who may use this deployment ------------------------------------------
# If set, every proxied request must carry this code. Without it, anyone who
# learns your URL can spend your bandwidth streaming through your server.
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()

# --- How we reach the open web --------------------------------------------
# Optional upstream HTTP(S) proxy, e.g. "http://user:pass@host:port", for when
# the machine this runs on is itself filtered or rate-limited.
UPSTREAM_PROXY = os.environ.get("UPSTREAM_PROXY", "").strip()

# Seconds before we give up on an upstream request. Audio is streamed rather
# than buffered, so this bounds the *first byte*, not the whole track.
TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", 20))

# How many times to retry a failed upstream request (network errors / 5xx).
RETRIES = int(os.environ.get("UPSTREAM_RETRIES", 2))

# --- What we are willing to fetch -----------------------------------------
# This server is a mirror for the handful of hosts the player uses, not a
# general-purpose open proxy. A host is matched by exact name or by suffix,
# so "archive.org" also covers the ia*.us.archive.org datanodes that actually
# serve the audio.
#
# Everything here is a public, read-only, no-account API — the same set the
# PWA would call directly if the network let it.
DEFAULT_ALLOWED_HOSTS = (
    "archive.org",              # metadata, search, and the audio itself
    "coverartarchive.org",      # release artwork
    "musicbrainz.org",          # the lookup that finds that artwork
    "mzstatic.com",             # iTunes artwork CDN (the artwork fallback)
    "itunes.apple.com",         # ...and the search that points at it
    "lrclib.net",               # synced lyrics
    "api.listenbrainz.org",     # scrobbling, if the user turns it on
    "api.github.com",           # update check
    "objects.githubusercontent.com",   # where a release APK actually lives
)

# Additional hosts, comma-separated. Use this for your own mirror of any of
# the above rather than editing the source.
_extra = os.environ.get("ALLOWED_HOSTS", "")
ALLOWED_HOSTS = DEFAULT_ALLOWED_HOSTS + tuple(
    h.strip().lower() for h in _extra.split(",") if h.strip()
)

# --- Cache -----------------------------------------------------------------
# In-memory LRU over small upstream responses (metadata JSON, artwork), in
# megabytes. Audio is never cached: it is streamed straight through, because
# a single FLAC would evict everything worth keeping. 0 disables the cache.
CACHE_MB = int(os.environ.get("CACHE_MB", 64))

# Responses larger than this are streamed and never cached, in kilobytes.
CACHE_MAX_ITEM_KB = int(os.environ.get("CACHE_MAX_ITEM_KB", 2048))

DEBUG = os.environ.get("VOID_DEBUG", "").lower() in ("1", "true", "yes")

# The identity we present upstream. Nothing here needs a real browser's
# fingerprint — these are public APIs — but a contactable UA is polite.
USER_AGENT = os.environ.get(
    "VOID_USER_AGENT",
    "VoidMusic/2.1 (+https://github.com/mh1435/void-ai)",
)
