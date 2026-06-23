/*
 * Service Worker — Rosenweg Reparatur-Melder PWA
 * Scope: /pwa/reparatur/
 *
 * Strategie:
 *  - App-Shell wird beim install precached (Offline-Start moeglich).
 *  - Navigationen (mode 'navigate'): network-first, Fallback auf gecachte index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk. Bei Fehler den Browser-Default
 *    durchreichen, damit die App-eigene Offline-Queue (IndexedDB) greift.
 *  - Sonstige GETs (Assets, CDN): stale-while-revalidate.
 */

const CACHE = 'rosenweg-reparatur-v1';

// App-Shell — alles was fuer den Offline-Start noetig ist.
const SHELL = [
  '/pwa/reparatur/',
  '/pwa/reparatur/index.html',
  '/pwa/reparatur/manifest.webmanifest',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png',
  '/js/authentik-auth.js',
];

// --- install: Shell precachen, sofort aktiv werden -------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // einzeln adden, damit ein fehlendes Asset (z.B. Icon) den install nicht killt
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

  // 1) API niemals abfangen/cachen — immer ans Netz; Fehler nicht kaschieren,
  //    damit die App-Queue den Netzfehler erkennt.
  if (url.pathname.startsWith('/api/')) {
    return; // Default-Browserverhalten
  }

  // Nur GET wird gecacht; alles andere durchreichen.
  if (req.method !== 'GET') return;

  // 2) Navigationen → network-first mit Cache-Fallback auf index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // frische Navigationsantwort fuer spaeter ablegen
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/pwa/reparatur/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match('/pwa/reparatur/index.html').then(
            (cached) => cached || caches.match('/pwa/reparatur/')
          )
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
            // nur erfolgreiche, vollstaendige Antworten cachen
            if (resp && resp.status === 200 && (resp.type === 'basic' || resp.type === 'cors')) {
              cache.put(req, resp.clone()).catch(() => {});
            }
            return resp;
          })
          .catch(() => cached); // offline → ggf. zwischengespeicherte Version
        return cached || network;
      })
    )
  );
});
