'use strict';

const staticCache = 'delivery-driver-static-v3';
const staticAssets = ['/driver', '/app.css', '/driver.css', '/loaders.css', '/loaders.js', '/ui-kit.js', '/driver-queue.js', '/driver.js', '/favicon.png', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(staticCache).then((cache) => cache.addAll(staticAssets)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('delivery-driver-static-') && key !== staticCache).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return;
  const isDriverNavigation = event.request.mode === 'navigate' && requestUrl.pathname.startsWith('/driver');
  const isStaticAsset = staticAssets.includes(requestUrl.pathname);
  if (!isDriverNavigation && !isStaticAsset) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && (isStaticAsset || requestUrl.pathname === '/driver')) {
      caches.open(staticCache).then((cache) => cache.put(requestUrl.pathname === '/driver' ? '/driver' : event.request, response.clone()));
    }
    return response;
  }).catch(() => caches.match(isDriverNavigation ? '/driver' : event.request)));
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'delivery-driver-sync') return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => client.postMessage({ type: 'driver-sync-requested' }));
  }));
});

// Notification « nouvelle livraison » : ouvre (ou remet au premier plan) l'appli livreur.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/driver';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((w) => new URL(w.url).pathname.startsWith('/driver'));
    if (existing) return existing.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : w));
    return self.clients.openWindow(url);
  }));
});
