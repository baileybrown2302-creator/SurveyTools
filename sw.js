const CACHE_NAME = 'survey-tool-v16';
const ASSETS = [
  './',
  './index.html',
  './leveling.html',
  './area.html',
  './hma.html',
  './manifest.json',
  './icon.png',
  './controlpoints.html',
  './csvconverter.html',
  './bidestimate.html'
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
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: HTML + db.js = network-first (always fresh); everything else = cache-first
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  const isHtml = req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/') || url.pathname.endsWith('db.js');
  if (isHtml) {
    // Network-first for HTML so updates are always picked up
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  } else {
    // Cache-first for JS, CSS, images, etc.
    event.respondWith(
      caches.match(req).then(cached => {
        const networkFetch = fetch(req).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
