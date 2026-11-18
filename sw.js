/* Offline shell for the appraiser visit app. Bump VERSION on every release. */
const VERSION = 'bikur-shamai-v1';
const FONTS = ['heebo-hebrew-500', 'heebo-latin-500', 'heebo-hebrew-700', 'heebo-latin-700', 'heebo-hebrew-800', 'heebo-latin-800',
  'assistant-hebrew-400', 'assistant-latin-400', 'assistant-hebrew-600', 'assistant-latin-600', 'assistant-hebrew-700', 'assistant-latin-700']
  .map((f) => `fonts/${f}-normal.woff2`);
/* paths are relative to this file, so the app works from any folder or host */
const SHELL = ['./', 'app.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'favicon.png', 'fonts/fonts.css', ...FONTS]
  .map((p) => new URL(p, self.location).href);
const HOME = new URL('./', self.location).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bikur-shamai-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive when online), cache as the offline fallback.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match(HOME)))
  );
});
