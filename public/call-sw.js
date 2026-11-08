/* Trampo incoming-call notification worker.
 * It only displays/focuses call alerts; it does not cache app traffic or handle push.
 * WebRTC signaling still requires the Trampo page to be open and connected.
 */
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(scope));
    if (existing) {
      if ('focus' in existing) await existing.focus();
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(scope);
  })());
});
