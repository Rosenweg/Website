/*
 * Service Worker — Rosenweg Terminumfragen (Doodle) PWA
 * Scope: /doodle/
 *  - App-Shell precachen (Offline-Start).
 *  - Navigationen: network-first, Fallback auf gecachte index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk.
 *  - Sonstige GETs: stale-while-revalidate.
 */
const CACHE = 'rosenweg-doodle-v1';
const SHELL = [
  '/doodle/',
  '/doodle/index.html',
  '/doodle/manifest.webmanifest',
  '/icons/icon-192-2.png',
  '/icons/icon-512-2.png',
  '/js/authentik-auth.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;        // API nie cachen
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put('/doodle/index.html', copy)).catch(() => {}); return resp; })
        .catch(() => caches.match('/doodle/index.html').then((cached) => cached || caches.match('/doodle/')))
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((resp) => { if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) cache.put(req, resp.clone()).catch(() => {}); return resp; })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
