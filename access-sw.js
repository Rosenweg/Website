// Service Worker für die Access-PWA (access.rosenweg4303.ch).
// Network-first für den App-Shell (damit Updates sofort greifen), API immer live.
const CACHE = 'rw-access-v1';
const SHELL = ['/access.html', '/js/authentik-auth.js?v=2', '/logo-rosenweg-technik.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return; // API nie cachen
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok && u.origin === location.origin) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/access.html')))
  );
});
