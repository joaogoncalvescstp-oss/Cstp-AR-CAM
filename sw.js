// Offline cache for the app shell. Network-first for HTML so updates land
// quickly; cache-first for everything else.
const CACHE = 'cstp-ar-cam-v3';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/ar.js',
  'js/camera.js',
  'js/geo.js',
  'js/landxml.js',
  'js/photos.js',
  'js/plan.js',
  'js/sensors.js',
  'vendor/proj4.js',
  'vendor/piexif.js',
  'vendor/three/three.module.js',
  'vendor/three/three.core.js',
  'vendor/three/addons/lines/Line2.js',
  'vendor/three/addons/lines/LineGeometry.js',
  'vendor/three/addons/lines/LineMaterial.js',
  'vendor/three/addons/lines/LineSegments2.js',
  'vendor/three/addons/lines/LineSegmentsGeometry.js',
  'samples/demo-alignment.xml',
  'samples/saint-paul-ramsey.xml',
  'js/units.js',
  'icons/stpaul-logo.png',
  'icons/favicon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === 'navigate';
  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
