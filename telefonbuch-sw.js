// Minimal-Service-Worker für PWA-Installation.
// Cached nur die App-Shell (HTML/Manifest/Logo). Daten kommen live aus /api/telefonbuch.
const CACHE = 'rosenweg-tel-v1';
const SHELL = ['/telefonbuch.html', '/telefonbuch.webmanifest', '/logo-rosenweg.png', '/js/authentik-auth.js'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
    self.skipWaiting();
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
    self.clients.claim();
});
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    // API-Calls niemals cachen — immer live
    if (url.pathname.startsWith('/api/')) return;
    // App-Shell: cache-first, network-fallback
    if (SHELL.some(p => url.pathname === p)) {
        e.respondWith(
            caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
                const copy = resp.clone();
                caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
                return resp;
            }))
        );
    }
});
