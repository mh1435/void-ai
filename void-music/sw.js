// Void Music service worker.
// Caches the app shell for offline boot. Never caches Instagram-style
// personal API responses (there are none here) — Jamendo/Archive API calls
// get a short-lived cache so metadata is still browsable offline-ish, but
// audio streams and search results always prefer the network first.

const SHELL_CACHE = 'void-shell-v1';
const API_CACHE = 'void-api-v1';
const API_TTL_MS = 60 * 60 * 1000; // 1 hour

const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/player.js',
  '/js/mini-player.js',
  '/js/views.js',
  '/js/search.js',
  '/js/catalog.js',
  '/js/jamendo.js',
  '/js/archive.js',
  '/js/store.js',
  '/js/toast.js',
  '/js/constants.js',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/assets/default-art.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== API_CACHE)
        .map((k) => caches.delete(k)),
    )).then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.hostname === 'api.jamendo.com'
    || url.hostname === 'archive.org'
    || url.hostname === 'www.archive.org';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  if (isApiRequest(url)) {
    event.respondWith(networkFirstWithTtl(event.request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request)),
    );
  }
});

async function networkFirstWithTtl(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const clone = fresh.clone();
      const headers = new Headers(clone.headers);
      headers.set('sw-cached-at', String(Date.now()));
      const stamped = new Response(await clone.blob(), { status: clone.status, headers });
      cache.put(request, stamped);
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (!cached) throw new Error('offline, nothing cached');
    const cachedAt = Number(cached.headers.get('sw-cached-at') || 0);
    if (Date.now() - cachedAt > API_TTL_MS) {
      // Stale, but better than nothing while offline.
      return cached;
    }
    return cached;
  }
}
