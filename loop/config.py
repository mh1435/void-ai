"""Runtime configuration, all via environment variables."""

import os
import secrets

# --- Where we listen -------------------------------------------------------
PORT = int(os.environ.get("PORT", 8080))
HOST = os.environ.get("HOST", "0.0.0.0")

# --- Who may use this deployment ------------------------------------------
# If set, the web app asks for this code before it will do anything. Without
# it, anyone who learns your URL can use your server to talk to Instagram.
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()

# --- How we reach Instagram -----------------------------------------------
# Optional upstream HTTP(S) proxy, e.g. "http://user:pass@host:port".
# Useful when the datacenter IP this runs on is itself rate-limited or
# challenged by Instagram (common on shared free-tier hosts).
UPSTREAM_PROXY = os.environ.get("UPSTREAM_PROXY", "").strip()

# Seconds before we give up on an upstream request.
TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", 20))

# How many times to retry a failed upstream request (network errors / 5xx).
RETRIES = int(os.environ.get("UPSTREAM_RETRIES", 2))

# --- Sessions --------------------------------------------------------------
# Where to keep session state so a process restart does not log you out.
# On ephemeral hosts this survives restarts but not redeploys.
SESSION_DIR = os.environ.get("SESSION_DIR", "/tmp/loop-sessions")

# Sessions idle for this long are dropped.
SESSION_TTL = int(os.environ.get("SESSION_TTL", 60 * 60 * 24 * 30))

# --- Secrets ---------------------------------------------------------------
# Signs media-proxy URLs so this server cannot be used as an open image proxy.
# Set it explicitly if you want signed URLs to survive a restart.
SECRET = os.environ.get("LOOP_SECRET", "") or secrets.token_hex(32)

# --- Identity we present to Instagram -------------------------------------
# Must be a *desktop* browser, because IG_APP_ID below is the desktop web
# app's id. Instagram serves mobile browsers a different app with a different
# id, and a mobile user-agent carrying the desktop id is a combination no real
# client produces - which is enough to get a login rejected outright.
USER_AGENT = os.environ.get(
    "LOOP_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
)

# Instagram's public web app id. Every instagram.com web request carries it.
IG_APP_ID = os.environ.get("IG_APP_ID", "936619743392459")
IG_ASBD_ID = os.environ.get("IG_ASBD_ID", "129477")

# --- Media proxy -----------------------------------------------------------
# In-memory LRU for CDN bytes, in megabytes. Keeps repeated avatar/thumb hits
# off the network. Set to 0 to disable caching entirely.
MEDIA_CACHE_MB = int(os.environ.get("MEDIA_CACHE_MB", 64))

DEBUG = os.environ.get("LOOP_DEBUG", "").lower() in ("1", "true", "yes")
