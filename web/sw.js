// The service worker exists for one reason: make the app shell open instantly
// and keep working when the link drops mid-session. It deliberately never
// caches API responses or media — stale feeds are worse than no feed, and
// cached media would balloon storage on a phone.

const SHELL = 'loop-shell-v1';
const FILES = [
  '/', '/app.css', '/icon.svg', '/manifest.webmanifest',
  '/js/app.js', '/js/api.js', '/js/dom.js', '/js/icons.js',
  '/js/router.js', '/js/components.js', '/js/media.js',
  '/js/state.js', '/js/toast.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media')) return;

  // Network-first for the shell so a redeploy is picked up on the next load,
  // with the cache as the offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/'))),
  );
});
