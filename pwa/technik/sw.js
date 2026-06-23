/*
 * Service Worker — Rosenweg Technik-Cockpit PWA
 * Scope: /technik/
 *
 * Strategie:
 *  - App-Shell wird beim install precached (Offline-Start moeglich).
 *  - Navigationen (mode 'navigate'): network-first, Fallback auf gecachte index.html.
 *  - /api/-Requests: NIE cachen — immer Netzwerk (Live-/Session-Daten).
 *  - Sonstige GETs (Assets, CDN): stale-while-revalidate.
 *  - Web-Push: push + notificationclick (Status-/Alert-Benachrichtigungen).
 */

const CACHE = 'rosenweg-technik-v1';

// App-Shell — alles was fuer den Offline-Start noetig ist.
const SHELL = [
  '/technik/',
  '/technik/index.html',
  '/technik/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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

  // 1) API niemals abfangen/cachen — immer ans Netz.
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
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('/technik/index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match('/technik/index.html').then(
            (cached) => cached || caches.match('/technik/')
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

// --- Web-Push --------------------------------------------------------------
self.addEventListener('push', (e) => {
  const d = (() => { try { return e.data ? e.data.json() : {}; } catch { return {}; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'Rosenweg', {
    body: d.body || '',
    icon: d.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) {
      if (c.url.includes(new URL(e.notification.data.url, self.location.origin).pathname) && 'focus' in c) return c.focus();
    }
    return clients.openWindow(e.notification.data.url);
  }));
});
