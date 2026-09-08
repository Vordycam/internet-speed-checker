/* Service worker: cache the app shell so the page opens instantly and can be
   installed to a phone's home screen.

   Only same-origin files are ever cached. Test traffic to the speed-test
   node must always hit the network, or the test would measure the cache. */

/* Bump on every change to js/, styles.css or index.html, or installed
   phones keep the old files. */
var CACHE = 'isc-v1';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/stats.js',
  './js/engine.js',
  './js/app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Never touch cross-origin requests: that is the speed test itself.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;

  // Stale-while-revalidate for the shell: serve cached, refresh in background.
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request, { ignoreSearch: true }).then(function (cached) {
        var network = fetch(e.request).then(function (resp) {
          if (resp && resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});
