/*
 * Service Worker — Rosenweg Terminumfragen (Doodle)
 * Bewusst OHNE Caching: nur installierbar machen, aber NIE eine alte Version
 * ausliefern (Stale-Cache war die Loop-Ursache). Alle Requests gehen ans Netz,
 * der OAuth-Callback (#auth=) wird normal verarbeitet.
 */
const CACHE = 'rosenweg-doodle-v3-nocache';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // nur eigene alte Doodle-Caches weg - die anderen Apps teilen sich den Cache-Speicher der Origin
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rosenweg-doodle-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Kein fetch-Handler mit respondWith → Browser-Standard (immer Netzwerk).
// (Web-Push bleibt erhalten.)
self.addEventListener('push', (e) => {
  const d = (() => { try { return e.data ? e.data.json() : {}; } catch { return {}; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'Rosenweg', {
    body: d.body || '', icon: '/icons/icon-notif.png', badge: '/icons/icon-badge.png',
    tag: d.tag, data: { url: d.url || '/doodle/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(e.notification.data.url);
  }));
});
