const CACHE_NAME = 'survey-tool-beta-v9';
const ASSETS = [
  './',
  './index.html',
  './slope_stake.html',
  './slope_stake_home.html',
  './slope_stake_model.html',
  './grade.html',
  './leveling_home.html',
  './materials.html',
  './project_manager.html',
  './soilcompaction.html',
  './thinlift.html',
  './leveling.html',
  './area.html',
  './hma.html',
  './manifest.json',
  './icon.png',
  './controlpoints.html',
  './csvconverter.html',
  './bidestimate.html',
  './transfer.html',
  './lib/qrcode.min.js',
  './lib/peerjs.min.js',
  './stationing.html',
  './alignment_photo.html',
  './lib/alignments.js',
  './lib/stationfield.js',
  './lib/stationmap.js',
  './lib/leaflet/leaflet.js',
  './lib/leaflet/leaflet.css',
  './lib/leaflet/images/layers.png',
  './lib/leaflet/images/layers-2x.png',
  './lib/stationing.js',
  './lib/stationing.css',
  './lib/piexif.js',
  './lib/printpdf.js',
  './lib/jspdf.umd.min.js',
  './lib/html2canvas.min.js'
];

// Install: cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => /^survey-tool-beta-v\d+$/.test(k) && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: everything from this site is network-first so updates show up right away.
// If the network is slow (>3 s) or offline, the saved copy is used instead.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // map tiles etc. go straight to the network
  if (req.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const net = fetch(req, { cache: 'no-cache' }).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
    const cached = await cache.match(req, { ignoreSearch: true });
    if (!cached) return net.catch(() => caches.match(req, { ignoreSearch: true }));
    const timeout = new Promise(res => setTimeout(() => res(cached), 3000));
    return Promise.race([net.catch(() => cached), timeout]);
  })());
});
