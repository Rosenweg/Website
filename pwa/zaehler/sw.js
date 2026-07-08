/*
 * Service Worker — Rosenweg "Mein Zähler" PWA
 * Scope: /zaehler/
 *
 * Strategie (wie solar):
 *  - App-Shell wird beim install precached (Offline-Start moeglich).
 *  - Navigationen: network-first, Fallback auf gecachte index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk (Live-Daten + History).
 *  - Sonstige GETs (Assets, CDN): stale-while-revalidate.
 */

const CACHE = 'rosenweg-zaehler-v3';

// App-Shell — alles was fuer den Offline-Start noetig ist.
const SHELL = [
  '/zaehler/',
  '/zaehler/index.html',
  '/zaehler/manifest.webmanifest',
  '/icons/icon-192-2.png',
  '/icons/icon-512-2.png',
  '/logo-rosenweg.png',
];

// --- install: Shell precachen, sofort aktiv werden -------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// --- activate: alte Caches entsorgen, Kontrolle uebernehmen ----------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// --- fetch -----------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) API niemals abfangen/cachen — immer ans Netz.
  if (url.pathname.startsWith('/api/')) return;

  // Nur GET wird gecacht.
  if (req.method !== 'GET') return;

  // 2) Navigationen → network-first mit Cache-Fallback auf index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/zaehler/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match('/zaehler/index.html').then((cached) => cached || caches.match('/zaehler/'))
        )
    );
    return;
  }

  // 3) Sonstige GETs (eigene Assets + CDN) → stale-while-revalidate.
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
