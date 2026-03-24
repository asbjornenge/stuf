const CACHE_NAME = 'stuf-v1';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/noto-sans-latin-ext.woff2',
];

// Install: cache app shell + all JS/CSS assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(APP_SHELL);
      // Cache the actual page to get references to hashed assets
      const response = await fetch('/');
      const html = await response.text();
      const assetUrls = [...html.matchAll(/\/assets\/[^"']+/g)].map(m => m[0]);
      if (assetUrls.length > 0) {
        await cache.addAll(assetUrls);
      }
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, fall back to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only cache same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // Skip API requests
  if (url.pathname.startsWith('/api')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'stuf reminder';
  const options = {
    body: data.body || 'A task needs your attention',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.taskId || 'stuf-reminder',
    data: { taskId: data.taskId },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      if (windowClients.length > 0) {
        return windowClients[0].focus();
      }
      return clients.openWindow('/');
    })
  );
});
