/*
 * Service Worker — Rosenweg Wetterstation-PWA
 * Scope: /wetter/
 *
 * Strategie:
 *  - App-Shell wird beim install precached (Offline-Start moeglich).
 *  - Navigationen (mode 'navigate'): network-first, Fallback auf gecachte index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk (Live-Historie).
 *  - Sonstige GETs (Assets) → stale-while-revalidate.
 *  (Live-Werte kommen ueber MQTT-WebSocket, nicht ueber den SW.)
 */

const CACHE = 'rosenweg-wetter-v1';

const SHELL = [
  '/wetter/',
  '/wetter/index.html',
  '/wetter/manifest.webmanifest',
  '/js/mqtt.min.js',
  '/icons/icon-192-2.png',
  '/icons/icon-512-2.png',
  '/logo-rosenweg.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) API niemals cachen — immer ans Netz.
  if (url.pathname.startsWith('/api/')) return;
  if (req.method !== 'GET') return;

  // 2) Navigationen → network-first mit Cache-Fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/wetter/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('/wetter/index.html').then((c) => c || caches.match('/wetter/')))
    );
    return;
  }

  // 3) Sonstige GETs → stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((resp) => {
            if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
              cache.put(req, resp.clone()).catch(() => {});
            }
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
