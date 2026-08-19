# Loop

A self-hosted Instagram client, built for one situation: **Instagram is blocked
where you are, and you want to use your own account anyway.**

Your phone talks to *your* server. Your server talks to Instagram. That
indirection is the entire trick — and it is worth being precise about why it is
the only thing that can work.

```
   your phone                    your server                  Instagram
  ┌───────────┐   HTTPS to      ┌─────────────┐   HTTPS to   ┌──────────┐
  │  Loop PWA │ ──────────────► │   Python    │ ───────────► │ /api/v1  │
  │           │  your-app.com   │  (stdlib)   │  instagram   │   CDN    │
  └───────────┘ ◄────────────── └─────────────┘ ◄─────────── └──────────┘
        ▲                              ▲
   blocked network             somewhere Instagram
   never sees an               is reachable
   Instagram domain
```

## Read this before you start

**An app on your phone cannot bypass a network block by itself.** If your ISP
blocks `instagram.com` by DNS, SNI or IP, then any app on your device that
connects to `instagram.com` is blocked, no matter how it is written. There is no
client-side trick that changes this.

So Loop does not try. Instead the *server* — which you run somewhere Instagram
is reachable — makes every Instagram request, including fetching photos and
videos from `*.cdninstagram.com` and `*.fbcdn.net`. Your device only ever loads
one hostname: your own — every request the frontend makes is same-origin, which
you can verify:

```bash
grep -rn "fetch(\|XMLHttpRequest\|src=\"http" web/js/    # only /api and /media
grep -rn "https://www.instagram" web/js/                   # one hit: see below
```

That single hit is the **Share** button, which copies an `instagram.com/p/…`
link to hand to someone else. It is text; nothing loads it. If you would rather
not have the string in the bundle at all, delete `sharePost` in
`web/js/components.js`.

**What this means in practice:** if your own domain also gets blocked later,
point a different domain at the same deployment. The app does not care what it
is called.

### The honest caveats

- **This uses Instagram's private web API.** There is no public API that can
  read your home feed. The endpoints under `/api/v1/` are the ones instagram.com
  itself calls; they are undocumented and Instagram changes them without notice.
  When something breaks, it will usually be an endpoint that moved.
- **Third-party clients are against Instagram's Terms of Use.** Logging in from
  a datacenter IP can trigger a verification checkpoint or, occasionally, a
  suspension. Use an account you can afford to have challenged, and expect to
  approve a login from the official app at least once.
- **Shared free-tier IPs are heavily rate-limited by Instagram**, because
  thousands of other people are on them. If the app is slow or keeps asking you
  to log in, that is usually why — see `UPSTREAM_PROXY` below.
- **I could not test this against live Instagram**, only against the API shapes
  it returns. Endpoint drift is the most likely thing you will hit first;
  `/api/health` and `LOOP_DEBUG=1` exist to make that diagnosable.

## Two clients, one server

| | What it is | Get it |
|---|---|---|
| **Android app** | Native Kotlin/Compose. No WebView, no browser, nothing that loads instagram.com. | Build the APK — see below |
| **Web app** | A PWA served by the same server. Installs via Add to Home Screen. | Just open your server's URL |

They speak the same JSON API, so the server does not care which you use. The
web app is the fastest way to check a deployment works; the Android app is the
one you actually live in.

## Run the server

No dependencies. No build step. Python 3.9+.

```bash
python3 server.py           # http://localhost:8080
python3 -m unittest discover -s tests   # 58 tests, no install needed
```

### Deploy to Render (what this repo is set up for)

`render.yaml` is a blueprint for a free web service. Push the repo, connect it,
and set `ACCESS_CODE` in the dashboard. `LOOP_SECRET` is generated for you.

The old service on this repo started with `python3 void_web_cloud.py`, which is
baked into the service rather than read from `render.yaml`, so that file is kept
as a shim that boots the same app. Either start command works.

Any host with outbound HTTPS works just as well — Fly, a $5 VPS, a Raspberry Pi
at a friend's place abroad. A VPS you own is the better option: its IP is yours
alone, so Instagram is far less likely to challenge it.

## Build the Android app

The APK is built by CI, because it needs the Android SDK:

1. Open the [**Android** workflow](../../actions/workflows/android.yml) and
   pick the newest green run.
2. Download the `loop-apk` artifact at the bottom of the run page and unzip
   it. It contains both `app-debug.apk` and `app-release.apk` — install the
   release one; the debug build is only there for troubleshooting.
3. Copy it to your phone and open it. Android will ask you to allow installs
   from this source, because this is not on Google Play.
4. On first launch, enter your server address. That is the only setup.

Artifacts expire after 90 days, so re-run the workflow if the latest one has
aged out. Every push to a branch rebuilds it.

The release build is signed with the standard debug key, so it installs but is
not Play-Store publishable — which is fine for an app you sideload onto your
own phone. To sign it properly, add a keystore and point `signingConfigs` at
it in `android/app/build.gradle.kts`.

Locally, with the Android SDK installed:

```bash
cd android
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/
./gradlew :core:test                # the data layer, no SDK required
```

`:core` is plain Kotlin/JVM — models, HTTP client, error mapping — so it
builds and tests with nothing but a JDK. `:app` is only configured when an
Android SDK is present, which is why `./gradlew :core:test` works anywhere.

### What the app does and does not send

The two things that matter here are enforced in code, not just documented:

- **`HostGuard`** (`android/core/.../LoopApi.kt`) rejects any request not
  addressed to your configured server. Image and video loading share the same
  OkHttp client, so no code path — not even a stray CDN URL — can reach
  Instagram directly and expose your device's IP. There is a test that tries.
- **A fixed identity.** The app sends `User-Agent: Loop` and nothing derived
  from your device: no model, no OS version, no advertising id, no locale.

The manifest requests `INTERNET` and `ACCESS_NETWORK_STATE`, and nothing else.
Backups are disabled so the session token cannot leave the device.

## Configuration

Everything is an environment variable. Nothing is required.

| Variable | Default | What it does |
|---|---|---|
| `ACCESS_CODE` | *(unset)* | Locks the deployment behind a code. **Set this** — without it, anyone who learns your URL can use your server to talk to Instagram. |
| `LOOP_SECRET` | random per boot | Signs media URLs and the access cookie. Set it explicitly so they survive a restart. |
| `UPSTREAM_PROXY` | *(unset)* | HTTP(S) proxy for all Instagram traffic, e.g. `http://user:pass@host:8080`. Use when the host's own IP is rate-limited or challenged. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `SESSION_DIR` | `/tmp/loop-sessions` | Where login sessions are kept so a restart does not sign you out. |
| `SESSION_TTL` | 30 days | How long an idle session lives. |
| `UPSTREAM_TIMEOUT` / `UPSTREAM_RETRIES` | `20` / `2` | Upstream request tuning. |
| `MEDIA_CACHE_MB` | `64` | In-memory cache for CDN bytes. `0` disables it. |
| `LOOP_DEBUG` | off | Request logging and tracebacks. |

## What it does

Home feed with stories · post view with comments (and posting them) · Reels in a
vertical snap feed · Explore grid · profiles with follow/unfollow · search for
people and hashtags · hashtag pages · activity/notifications · like, save,
comment · double-tap to like · carousels · story viewer with progress bars.

It installs as a PWA (Add to Home Screen) and works in both light and dark.

## What Instagram can and cannot see

This comes up a lot, and the answer has a common misconception in it.

**Your IP address: hidden.** Instagram sees your server's IP. Your home or
mobile IP never touches them. This is not a feature bolted on — it falls out of
the server making every request.

**Your MAC address: was never visible anyway.** MAC addresses do not travel
over the internet. They are layer-2 identifiers that get rewritten at every
router hop; yours reaches your Wi-Fi router and stops there. Instagram has
never seen it, from this client or the official app. There was nothing to
protect.

**Your identity: fully known.** You sign in with your username and password.
Instagram knows exactly who you are. Hiding your IP hides your *location and
network*, not your account.

**Device telemetry: not sent.** This is the bigger practical win. The official
app collects your advertising id, device model and OS, sensors, precise
location, contacts and installed-app signals. This client sends only what the
web API needs to answer a request.

**What Instagram still gets:** your account identity, everything you view, like
and comment, timing and session patterns, and a datacenter IP — which is itself
a flag, and part of why checkpoints happen.

### This is not a VPN

Your ISP still sees your phone connecting to your server's domain, via DNS and
SNI, plus how much data and when. They cannot see that it is Instagram content.
But this defeats a domain or IP block; it does not hide that you are using an
unusual server, and it is not anonymity from whoever runs the block. If
accessing Instagram where you are carries consequences beyond the site being
unavailable, this design does not protect you from that.

Whoever runs the server sees everything. That is you — set `ACCESS_CODE` so it
stays that way.

## Security posture

- Your Instagram password is forwarded to Instagram to create a session and is
  **never written to disk or logged**. Only the resulting session cookies are
  stored, server-side.
- The browser holds one opaque session id. Instagram cookies never reach it, so
  a stolen device cookie is useless off your server.
- `/media` only fetches HMAC-signed URLs on an explicit host allowlist
  (`*.cdninstagram.com`, `*.fbcdn.net`, `instagram.com`). Both checks are
  enforced independently, so a valid signature for an off-list host is still
  refused — this cannot be used as an open proxy.
- TLS verification is never disabled. On a network that already tampers with
  your traffic, that would be exactly the wrong corner to cut.
- Anyone with access to `SESSION_DIR` can act as your account. Run this on a
  host you control.

## Layout

```
server.py            HTTP server + entrypoint
void_web_cloud.py    shim for the pre-existing Render start command
loop/config.py       every environment variable, in one place
loop/netclient.py    dependency-free HTTP client: cookies, gzip, proxy, retries
loop/instagram.py    Instagram web API bindings + normalisation into one shape
loop/sessions.py     server-side session store (browser holds only a token)
loop/mediaproxy.py   signed, allowlisted CDN proxy with an LRU cache
loop/app.py          routing: the JSON API and static files

web/index.html       app shell
web/app.css          all styling, dark-first, mobile-first
web/js/app.js        boot, chrome, route table
web/js/api.js        the only file that makes network calls
web/js/router.js     History-API router
web/js/components.js post card, grids, avatars — the shared UI
web/js/media.js      one observer decides which video plays anywhere
web/js/views/*.js    feed, explore, reels, profile, post, search, story, tag,
                     activity, settings, login
web/sw.js            offline app shell (never caches API responses or media)

android/core/        plain Kotlin/JVM: models, HTTP client, error mapping.
                     Builds and tests without the Android SDK.
android/app/         Compose UI: feed, stories, reels, explore, profile,
                     post, search, activity, settings, setup/login/2FA
tools/gen_fixtures.py  generates the core module's test fixtures by running
                     Instagram-shaped payloads through the real normalisers
tests/               server unit tests (stdlib unittest, no install)
```

Instagram returns posts in at least two different shapes — GraphQL `edges` on a
profile, an `items` array on a timeline. Everything funnels through
`normalise_post` / `normalise_graphql` in `loop/instagram.py`, so every view in
the frontend consumes one post shape. **If you add an endpoint, normalise it
there** rather than teaching a view a second shape.

That shape is also a contract with the Android app. `tools/gen_fixtures.py`
feeds real Instagram-shaped payloads through those same normalisers and writes
the output to `android/core/src/test/resources/`; the Kotlin tests decode it.
CI regenerates the fixtures and fails if they differ from what is committed, so
changing a normaliser breaks the Android build instead of quietly drifting out
of sync. After changing one, run:

```bash
python3 tools/gen_fixtures.py && cd android && ./gradlew :core:test
```

## When it stops working

Open **Settings** in the app. It tells you whether *the server* can reach
Instagram, which is the one thing you cannot tell from a blank feed.

| Symptom | Cause | Fix |
|---|---|---|
| "Cannot reach your Loop server" | your device can't reach *your* domain | your domain is blocked or the host is asleep — try a different domain |
| "This server could not reach Instagram" | the host is blocked or offline | set `UPSTREAM_PROXY`, or move the server |
| Signed out repeatedly | Instagram is challenging the login | approve it once in the official app, then sign in again |
| "Instagram is rate-limiting this server" | shared datacenter IP | set `UPSTREAM_PROXY`, or move to a VPS with its own IP |
| One section blank, others fine | that endpoint moved | `LOOP_DEBUG=1`, then fix the call in `loop/instagram.py` |

## Not affiliated with Instagram or Meta

This is an independent client for your own account. It does not remove ads,
bypass any paid feature, or access anything your account cannot already see.
