/*
 * Service Worker — Rosenweg Apps Launcher (Hub)
 * Scope: /  (Wurzel)
 *
 * WICHTIG: Dieser SW hat scope '/', der Reparatur-SW scope '/reparatur/'.
 * Damit sich die beiden nicht ins Gehege kommen, cacht DIESER SW NUR die
 * eigene Launcher-Shell ('/', '/index.html', Manifest, Icons) und greift
 * NICHT aktiv in das fremde Scope der Reparatur-App ein. Navigationen ins
 * Reparatur-Scope laufen ueber den Reparatur-SW (das engste registrierte
 * Scope gewinnt).
 *
 * Strategie:
 *  - install: Launcher-Shell precachen (Offline-Start des Launchers moeglich).
 *  - Navigationen (mode 'navigate'): network-first, Fallback auf /index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk.
 *  - Sonstige GETs: stale-while-revalidate.
 */

const CACHE = 'rosenweg-launcher-v2';

// Launcher-App-Shell — nur das, was fuer den Offline-Start des Hubs noetig ist.
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// --- install: Shell precachen, sofort aktiv werden -------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // einzeln adden, damit ein fehlendes Asset den install nicht killt
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
  if (url.pathname.startsWith('/api/')) {
    return; // Default-Browserverhalten
  }

  // Nur GET wird gecacht; alles andere durchreichen.
  if (req.method !== 'GET') return;

  // 2) Navigationen → network-first mit Cache-Fallback auf den Launcher.
  //    Hinweis: Navigationen ins /reparatur/-Scope werden i.d.R. vom
  //    Reparatur-SW behandelt (engstes Scope gewinnt); landet hier nur,
  //    was zum Launcher-Scope gehoert.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // frische Launcher-Antwort fuer spaeter ablegen
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/'))
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
