// Service worker: guarda la guía en el móvil para usarla sin cobertura.
// La lista de ficheros y la versión las escribe tools/build.py: no editar a mano
// entre las marcas BUILD.
// BUILD:START
const VERSION = '2026.11.08-0929';
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "data/routes.json",
  "data/acher/route.json",
  "data/acher/track.gpx",
  "data/acherito/route.json",
  "data/acherito/track.gpx",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2",
  "fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "fonts/barlow-condensed-latin-600-normal.woff2",
  "fonts/barlow-condensed-latin-700-normal.woff2",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "js/app.js",
  "js/geo.js",
  "js/version.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/images/layers-2x.png",
  "vendor/leaflet/images/layers.png",
  "vendor/leaflet/images/marker-icon-2x.png",
  "vendor/leaflet/images/marker-icon.png",
  "vendor/leaflet/images/marker-shadow.png",
  "tiles/index.json"
];
// BUILD:END

const APP_CACHE = `app-${VERSION}`;
const TILE_CACHE = 'tiles-v1'; // los mapas se conservan entre versiones

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Primera instalación: activar ya. En actualizaciones se espera a que el usuario pulse "Actualizar".
    if (!self.registration.active) self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // enlaces externos: navegador normal

  if (url.pathname.includes('/tiles/') && url.pathname.endsWith('.jpg')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const key = req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return new Response('Sin conexión y sin copia guardada de este fichero.', { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
