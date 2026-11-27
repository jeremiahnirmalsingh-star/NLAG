/* ABMDAS service worker — network first, cache as offline fallback.
 * The app is served from a local/office server, so fresh files always win;
 * the cache only exists so the shell still opens if the server is briefly down. */
const CACHE = 'abmdas-shell-v67';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/manifest.webmanifest',
  '/img/favicon.svg',
  '/img/logo.png?v=3',
  '/vendor/qrcode.js',
  '/vendor/jsbarcode.min.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/js/pages/fleet.js',
  '/js/pages/fleet-dashboard.js',
  '/js/pages/fleet-attendance.js',
  '/js/pages/fleet-ops.js',
  '/js/pages/fleet-issues.js',
  '/js/pages/fleet-accidents.js',
  '/js/pages/fleet-reports.js',
  '/js/osm-picker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; /* never cache API */

  /* Network first: always try the live server so code updates show up at once. */
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('/index.html');
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
      )
  );
});
