/* GeoCam Service Worker — arranque rápido, uso sin conexión y ACTUALIZACIÓN fiable.
   Clave para la APK (TWA): la app carga esta web, así que al publicar una versión
   nueva el service worker la detecta y la app se actualiza sola (sin reinstalar). */
const VERSION = 'geocam-v15';

/* Recursos del "app shell". Se precachean para poder abrir sin conexión. */
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

/* El código de la app (para que las actualizaciones se noten de inmediato) va por
   RED PRIMERO; los iconos y demás por CACHÉ PRIMERO (rápido y estable). */
const CORE = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.json'];

/* Instala y precachea el shell */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

/* Activa, borra cachés viejas y toma el control de las pestañas abiertas */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* La app puede pedir activar la versión nueva sin esperar (botón "Actualizar"). */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ¿Es un recurso "core" (código de la app o navegación)? -> red primero. */
function isCore(url, req) {
  if (req.mode === 'navigate') return true;
  return CORE.some((c) => url.pathname.endsWith(c));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN / teselas del mapa → red directa

  // Código de la app y navegaciones: RED PRIMERO con respaldo de caché (offline OK).
  if (isCore(url, req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  // Resto (iconos, imágenes): CACHÉ PRIMERO con respaldo de red.
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
