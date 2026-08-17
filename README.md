# Void Music

A fast, offline-first music player for **openly-licensed** recordings. No account, no ads,
no subscription, and no dependency on any service that geo-blocks by country.

It is a plain static web app — HTML, CSS and ES modules, with **zero build step and zero
third-party dependencies**. Serve the folder and it runs.

---

## Why it works where other apps don't

Streaming apps usually break in sanctioned or heavily-filtered regions for reasons that have
nothing to do with audio: the app store won't serve the install, the SDK phones home to a
blocked host, the payment provider refuses the country, or a CDN returns 403 by IP. Void Music
avoids that class of failure by construction:

| Usual dependency | What this app does instead |
| --- | --- |
| App-store distribution | Installs straight from the browser as a PWA — no store account |
| Google Play Services / Firebase | None. No analytics, no push, no remote config |
| CDN-hosted fonts, CSS, JS | Everything is local and same-origin; nothing is fetched from a third party |
| Login / payment provider | No accounts and no payments exist |
| A single API host | One host by default, plus a user-configurable mirror list raced in parallel |

The only outbound host is `archive.org`. If that is blocked on your network, add your own
mirror or reverse proxy under **Settings → Connection** and every request follows it.

### Built for a bad connection, not just a blocked one

- **Timeouts on every request** — a hung socket fails in seconds instead of spinning forever.
- **Exponential backoff with jitter** on retryable failures; 4xx responses fail fast.
- **Mirror racing** — the same request goes to several hosts at once and the first answer wins,
  so you pay the latency of the *fastest* route rather than the slowest.
- **Per-track source failover** — each track carries several URLs (two Archive datanodes plus
  the main host). A dead node costs one failed request, not a dead track.
- **Stale-while-revalidate caching** of metadata in the service worker: a flaky link shows you
  yesterday's data instead of an error page.
- **Pre-buffering** of the next track so transitions don't stall.
- **A diagnostics log** in Settings showing every retry and failure, so you can tell whether a
  problem is the app, your connection, or a block upstream.

---

## Where the music comes from

Everything streams from the Internet Archive's open audio collections:

- **Netlabels** — Creative Commons electronic, ambient and indie releases
- **Live Concerts (etree)** — live recordings that the artists explicitly allow to be traded
- **78 RPM Archive** — digitised 78s: jazz, blues and early pop, in the public domain
- **Classical**, **Field Recordings**, and the Archive-wide **Open Music** pool

There are no ads and no subscription because **this material is free to share** — not because a
paywall was bypassed. Commercial catalogues (the Spotify/Apple/YouTube Music kind) are
deliberately absent: streaming those requires a licence, and stream-ripping them is both illegal
and something this project won't do. If you want your own commercial library here, import the
files you already own — see below.

---

## Features

**Playback** — queue with shuffle and repeat, seek, volume, pre-buffering, Media Session
integration so lock-screen and headset buttons work on Android.

**Library** — playlists, liked songs, and offline saves, all stored locally in IndexedDB.

**Offline** — save any track to the device and it plays with the network switched off entirely.
The app shell itself is cached by the service worker, so it launches offline too.

**Import your own files** — add audio from your phone or computer under **Library → Import**.
Files never leave the device; there is no server to upload them to.

**Demo mode** — the *Offline Sessions* album is six short instrumentals **synthesised in your
browser with Web Audio** the moment you press play. Nothing is downloaded, so it works with no
connection at all — useful for checking that playback and offline saving behave on your setup
before you trust the network path.

**Keyboard** — `space` play/pause · `←`/`→` seek · `shift+←`/`→` prev/next · `↑`/`↓` volume ·
`m` mute · `s` shuffle · `r` repeat · `/` focus search.

---

## Running it

Any static file server works. It must be served over `http://` or `https://` — not `file://` —
because service workers and ES modules require an origin.

```bash
python3 -m http.server 8000
# then open http://127.0.0.1:8000
```

Deploying is just uploading the folder. It works on any static host, or on a small VPS with
nginx — which is the better option if you want a deployment that no third party can pull.

---

## The Android app

`android/` is a native APK wrapper. The whole web app is **bundled inside the APK**, so it
installs and runs with no server anywhere and works offline from the first launch.

### Getting the APK

**From CI (no toolchain needed).** Every push builds one. Open the repo's **Actions → Build
APK** run and download the `void-music-apk` artifact. Tagging a commit `v1.0.0` also attaches
the APK to a GitHub Release.

**Locally**, with the Android SDK installed:

```bash
cd android
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

Copy the `.apk` to the phone and open it (Android will ask you to allow installing from that
source). Debug builds are signed with the standard debug key, which is what makes them
installable with no setup. To ship signed release builds, set the `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` repository secrets
and push a `v*` tag.

### Why a WebView wrapper and not a TWA

Bubblewrap-style Trusted Web Activities need the site hosted on HTTPS, a Digital Asset Links
file served from that domain, and Chrome present on the device — a chain of dependencies that
fails in exactly the conditions this project targets. This wrapper bundles the assets instead
and serves them through `WebViewAssetLoader` over `https://appassets.androidplatform.net/`.

That origin detail is the important part: loading from `file://` would put the app on an opaque
origin where IndexedDB is unreliable and service workers refuse to register. Served this way the
packaged app is an ordinary secure origin, so playlists, offline audio and the rest behave
exactly as they do in a browser — with no server involved at all.

### What the native layer adds

- **Background playback.** A `mediaPlayback` foreground service keeps audio running when the
  app is backgrounded or the screen is off, with the notification Android requires in exchange.
  The audio still belongs to the WebView — there is no second player — the web app just tells
  the service when something is playing via `window.VoidNative`.
- **File import.** The system file picker is wired to the web app's import control.
- **Back button** maps to the app's own history.
- **External links** (an item's "Source" button) open in the browser rather than inside the app.

### Notes

- The APK is HTTPS-only (`usesCleartextTraffic="false"`). A self-hosted mirror configured under
  Settings must therefore be `https://` — a plain `http://` mirror works in a desktop browser
  but is blocked inside the app.
- `minSdk` is 24 (Android 7.0). Playback quality depends on the system WebView version.
- The web app is **not** duplicated into `android/`. A Gradle `Sync` task copies it from the
  repo root at build time, so `index.html` and friends stay the single source of truth for both
  the hosted PWA and the APK; CI fails the build if that copy comes out empty.

### Installing as a PWA instead

You don't need the APK. Open the site in Chrome and choose **Install app** / **Add to Home
screen** — you get an icon and a full-screen window **without the Play Store**, which matters
because Play is exactly the piece that's unavailable in a lot of the places this app is meant to
work. The APK mainly buys you background playback and a file you can pass around directly.

---

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA manifest
sw.js                   service worker: shell caching + metadata SWR
css/app.css             all styles
js/net.js               timeouts, backoff, mirror racing, health tracking
js/archive.js           Internet Archive client: search, metadata, stream URLs
js/store.js             IndexedDB: playlists, likes, offline blobs, imports
js/player.js            audio engine: queue, failover, Media Session
js/demo.js              Web Audio synthesis for the offline demo album
js/native.js            optional bridge to the Android wrapper (no-op in a browser)
js/views.js             route views
js/ui.js                DOM helpers, formatting, toasts
js/main.js              routing and wiring
android/                native APK wrapper (bundles the web app above)
tools/make_icons.py     regenerates assets/ icons (pure Python, no deps)
tools/make_android_icons.py  regenerates the APK launcher icons
```

## Notes and limits

- Saving a track for offline use needs a CORS-readable response from the mirror. Playback
  itself does not, so a host with strict CORS can still stream — the save will just report a
  failure it can't work around.
- Cover art comes from `archive.org/services/img/`. If it's blocked, covers fall back to a
  glyph and nothing else breaks.
- Storage is per-browser. Clearing site data removes playlists, likes and offline audio; the
  app asks for persistent storage to reduce the chance of eviction under pressure.

## Licence

The application code is MIT. The recordings it plays are **not** covered by that — each carries
its own licence (public domain, Creative Commons, or a trading policy set by the artist), shown
on the item page and linked back to its Archive source.
