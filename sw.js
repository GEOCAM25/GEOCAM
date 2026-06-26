/* GeoCam Service Worker — cachea el "app shell" para arranque rápido y uso sin conexión. */
const VERSION = 'geocam-v10';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './Icons/icon-192.png',
  './Icons/icon-512.png',
  './Icons/icon-180.png',
  './Icons/icon-167.png',
  './Icons/icon-152.png'
];

/* Instala y precachea el shell */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

/* Activa y borra cachés antiguas */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Estrategia:
   - Solo intercepta GET del mismo origen (no toca el CDN del mapa ni las teselas).
   - Cache-first con respaldo de red; guarda en caché lo que descarga.
   - Si falla todo y es navegación, devuelve index.html. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN / teselas → red directa

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
