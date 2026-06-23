/*
 * Service Worker — Rosenweg Solaranlage-Live PWA
 * Scope: /solar/
 *
 * Strategie:
 *  - App-Shell wird beim install precached (Offline-Start moeglich).
 *  - Navigationen (mode 'navigate'): network-first, Fallback auf gecachte index.html
 *    → Auto-Update der App ohne manuelles Cache-Busting.
 *  - /api/-Requests: NIE cachen — immer Netzwerk (Live-Daten).
 *  - Sonstige GETs (Assets, CDN): stale-while-revalidate.
 *  (Kein Web-Push noetig.)
 */

const CACHE = 'rosenweg-solar-v1';

// App-Shell — alles was fuer den Offline-Start noetig ist.
const SHELL = [
  '/solar/',
  '/solar/index.html',
  '/solar/manifest.webmanifest',
  '/icons/icon-192-2.png',
  '/icons/icon-512-2.png',
  '/logo-rosenweg.png',
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

  // 1) API niemals abfangen/cachen — immer ans Netz; Fehler nicht kaschieren.
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
          caches.open(CACHE).then((c) => c.put('/solar/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match('/solar/index.html').then(
            (cached) => cached || caches.match('/solar/')
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
