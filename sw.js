/* ==========================================================================
   HYBRID ATHLETE OS — Service Worker (V2.0)
   Strategy: cache-first for everything. The app shell is precached on
   install using Promise.allSettled (not cache.addAll) so one missing
   asset can never sink the whole install. Navigation requests that can't
   reach the network at all fall back to the cached app shell, which is
   enough for this app since it's a single-page, fully offline-capable UI.
   ========================================================================== */

const CACHE_VERSION = 'hao-v2.0.0';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Lets app.js trigger immediate activation after the user taps "Muat Ulang"
// on the update toast, instead of silently swapping the app under them.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Cache same-origin AND opaque cross-origin (fonts/CDN) 200s as we go,
          // so the second visit is fully offline-capable even for those.
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
