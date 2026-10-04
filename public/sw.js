const CACHE = 'relay-desk-shell-v1';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/icon.svg', '/manifest.webmanifest']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // 凭据、报告、会话及所有 API 永远只走网络。
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icon') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request).then(response => { if (response.ok) cache.put(event.request, response.clone()); return response; })));
  }
});
