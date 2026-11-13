/* SensorLab service worker (generated into dist/sw.js by scripts/build.mjs).
 * Precaches the complete app shell. It serves same-origin requests cache-first and never
 * contacts any other origin. Used only when served over HTTP(S); file:// needs no worker. */
const CACHE = __SL_CACHE__;
const ASSETS = __SL_ASSETS__;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sensorlab-') && k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== 'GET') return; // never proxy other origins
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
    );
});
