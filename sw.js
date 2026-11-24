// Offline cache for the app shell (videos are never cached or uploaded).
const CACHE = 'silence-cutter-v2';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'export.js', 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png',
  'vendor/mediabunny.min.mjs', 'vendor/mediabunny-aac-encoder.min.mjs',
];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));
// network first (so updates land), cache as fallback when offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
