/*
 * Void Music — a music player for open catalogues.
 * Copyright (C) 2026 Void Music contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
 * General Public License in LICENSE for details.
 */

/* Service worker.
 *
 * Two jobs: make the app itself start instantly and work with no connection,
 * and keep a short-lived copy of Archive metadata so a flaky link doesn't turn
 * a browse into an error page.
 *
 * Audio bytes are deliberately NOT cached here — saved tracks live in
 * IndexedDB via the app's offline store, which gives us eviction control and
 * a real "saved" list rather than opaque cache entries. */

const VERSION = 'v27';
const SHELL_CACHE = `void-shell-${VERSION}`;
const API_CACHE = `void-api-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/ui.js',
  './js/views.js',
  './js/player.js',
  './js/archive.js',
  './js/store.js',
  './js/net.js',
  './js/backend.js',
  './js/demo.js',
  './js/native.js',
  './js/artwork.js',
  './js/lyrics.js',
  './js/theme.js',
  './js/update.js',
  './js/mix.js',
  './js/youtube.js',
  './js/tags.js',
  './js/import.js',
  './js/scrobble.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
];

/** Metadata is worth re-reading eventually, but stale beats broken. */
const API_TTL_MS = 24 * 60 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if any single file 404s, so add
    // individually and tolerate gaps.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, API_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/**
 * The real target of a request.
 *
 * With a self-hosted backend in use, every upstream URL is rewritten to
 * <server>/via/<host>/<path> — which to this worker looks like an ordinary
 * same-origin request for an app asset. Classifying those by our own origin
 * would cache-first a search result and range-break a track, so unwrap them
 * and judge them by where they are really going.
 */
function effective(url) {
  const match = url.pathname.match(/^\/via\/([^/]+)(\/.*)?$/);
  if (!match) return url;
  try {
    return new URL(`https://${match[1]}${match[2] || '/'}${url.search}`);
  } catch {
    return url;
  }
}

function isApiRequest(url) {
  return /(^|\.)archive\.org$/.test(url.hostname)
    && /^\/(metadata|advancedsearch|services\/search)/.test(url.pathname);
}

function isCoverRequest(url) {
  // Artwork comes from image files inside an item (served from the datanodes
  // too) and from the Cover Art Archive for items that ship none.
  if (/(^|\.)coverartarchive\.org$/.test(url.hostname)) return true;
  if (/(^|\.)archive\.org$/.test(url.hostname)) {
    return url.pathname.startsWith('/services/img/')
      || /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  }
  return false;
}

function isAudioRequest(url) {
  return /\.(mp3|ogg|m4a|flac|wav|aiff?|opus)(\?|$)/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // A request bound for a self-hosted server is classified by its upstream
  // target, not by the fact that it happens to share our origin.
  const proxied = url.pathname.startsWith('/via/');
  const target = proxied ? effective(url) : url;

  // Never intercept media: range requests and streaming are the browser's job,
  // and buffering a whole album through the SW would waste memory.
  if (isAudioRequest(target) || request.destination === 'audio') return;

  // Files being imported from a folder the user granted on Android are served
  // by the app itself and are read exactly once. Caching them would duplicate
  // an entire music library into the cache storage.
  if (url.pathname.startsWith('/localfile/')) return;

  if (isApiRequest(target)) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }

  if (isCoverRequest(target)) {
    event.respondWith(cacheFirst(request, API_CACHE));
    return;
  }

  // Anything else aimed at a server — /api/health, a host we have no rule
  // for — goes straight to the network. shellStrategy() matches with
  // ignoreSearch, which would hand one search's results to the next.
  if (proxied || url.pathname.startsWith('/api/')) return;

  // App shell and same-origin assets.
  if (url.origin === self.location.origin) {
    event.respondWith(shellStrategy(request));
  }
});

/** Serve from cache immediately, refresh in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        // Stamp the entry so we can tell how stale it is when offline.
        const headers = new Headers(copy.headers);
        headers.set('x-void-cached-at', String(Date.now()));
        copy.blob().then((body) => {
          cache.put(request, new Response(body, { status: copy.status, headers }));
        });
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    const age = Date.now() - Number(cached.headers.get('x-void-cached-at') || 0);
    if (age < API_TTL_MS) {
      network.catch(() => {}); // fire and forget
      return cached;
    }
  }

  const fresh = await network;
  if (fresh) return fresh;
  if (cached) return cached; // expired, but better than nothing offline

  return new Response(
    JSON.stringify({ error: 'offline', message: 'No cached copy of this request.' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    // A missing cover is cosmetic; hand back an empty image rather than an error.
    return new Response('', { status: 504 });
  }
}

/** Cache-first for the shell, with a network refresh behind it. */
async function shellStrategy(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    network.catch(() => {});
    return cached;
  }

  const fresh = await network;
  if (fresh) return fresh;

  // Navigations must always land somewhere: fall back to the app shell.
  if (request.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
