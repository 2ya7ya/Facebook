const VERSION = 'facebook-pwa-v287';
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  // Keep authenticated/API/media requests network-controlled. No private data is cached here.
});
