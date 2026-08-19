# Void Music

A self-hosted, zero-dependency music discovery player. Dark-purple
glassmorphism UI, bottom navigation, a persistent mini-player, and a catalog
built entirely on legal Creative Commons sources — no scraping, no
unlicensed streaming.

No build step. No npm install. Vanilla HTML, CSS and ES modules, same as
this repo's `web/` app.

## Run it

```bash
cd void-music
python3 -m http.server 8080
# open http://localhost:8080
```

Any static file server works — this is a plain PWA.

## Catalog sources

| Source | Auth | What it provides |
|---|---|---|
| **Internet Archive** | none | Creative Commons–licensed audio, searched via `advancedsearch.php`. Works out of the box. |
| **Jamendo** | free `client_id` | New releases, playlists, top albums, and search results, all CC-licensed. Get a key at [jamendo.com/admin/applications](https://www.jamendo.com/admin/applications) and paste it into **Settings → Audio & Catalog**. Stored only in this browser's `localStorage` — never bundled, never sent anywhere but Jamendo's own API. |

Without a Jamendo key, Void still works — New Releases pulls from the
Internet Archive, and Playlists/Top Albums show a prompt to add a key
instead of sitting blank.

## Layout

```
index.html          app shell: hero, category pills, all five views, mini-player, bottom nav
css/app.css          theme tokens + every component style
js/app.js            boot: theme, routing, settings wiring
js/player.js         the only file that touches <audio> — queue, play/pause/next
js/mini-player.js    wires the floating mini-player bar to player.js's events
js/views.js          renderCard/renderListItem + Home/Library/Sync/Settings loaders
js/search.js         debounced search, recent-searches history
js/catalog.js         merges Archive + Jamendo into one shape for Home/Search
js/jamendo.js        Jamendo API client
js/archive.js        Internet Archive API client (search + per-item metadata)
js/store.js          localStorage: recent searches, recently played, liked, settings
js/toast.js          tiny toast notifications
js/constants.js      shared constants (placeholder artwork path)
sw.js                offline app shell + short-TTL cache for catalog API calls
manifest.webmanifest  PWA metadata (installable, purple theme color)
```

## Design notes

- **Theme**: CSS custom properties in `:root`, overridden per `[data-theme]`
  attribute (`light`, `amoled`) or left alone to follow `prefers-color-scheme`
  via `system` (the default). Switch it in Settings → Appearance.
- **Track registry**: rendered cards only carry a `data-id`; the actual track
  object lives in an in-memory `Map` in `store.js`, registered the moment a
  card is rendered. A single delegated click listener in `views.js` resolves
  id → track → `player.playTrack()`. This avoids inlining track data into
  HTML attributes, which breaks on titles containing quotes.
- **Everything local**: liked songs, recently played, recent searches, theme
  and the Jamendo key all live in `localStorage`. Nothing is sent to a
  server Void doesn't already talk to (Jamendo's API, Archive's API).
