/* Trampo's single app-shell and incoming-call worker.
 * Only public, same-origin build files are cached. HTML is network-first and
 * credential-bearing callbacks are NEVER persisted. API/auth/Realtime/WebRTC,
 * shared journeys and map requests always go to the network, never a stale cache.
 * A new worker waits for the user's explicit update action, not an active-call reload.
 */
declare const __TRAMPO_PRECACHE__: string[] | undefined;
declare const __TRAMPO_VERSION__: string | undefined;
type Extendable = Event & { waitUntil(promise: Promise<unknown>): void };
type FetchLike = Extendable & { request: Request; respondWith(response: Response | Promise<Response>): void };
type MessageLike = Extendable & { data?: { type?: string } };
type NotificationLike = Extendable & { notification: Notification };
const sw = globalThis as unknown as {
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled?: boolean }): Promise<ReadonlyArray<{ url: string; focus(): Promise<void> }>>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: Extendable) => void): void;
  addEventListener(type: 'message', listener: (event: MessageLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchLike) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationLike) => void): void;
};
const scope = new URL(sw.registration.scope);
const base = scope.pathname;
const version = typeof __TRAMPO_VERSION__ === 'string' ? __TRAMPO_VERSION__ : 'development';
const prefix = `trampo-${encodeURIComponent(base)}-`;
const shellCache = `${prefix}shell-${version}`;
const fileCache = `${prefix}files-${version}`;
const local = (path: string) => new URL(path, scope).href;
const shellUrl = local('');
const offlineUrl = local('offline.html');
const precache = (typeof __TRAMPO_PRECACHE__ !== 'undefined' ? __TRAMPO_PRECACHE__ : []).map(path => local(path));
const publicFiles = new Set([...precache, local('manifest.webmanifest')]);
const credentials = /(?:^|[?&])(code|token|access_token|refresh_token|token_hash|error|error_description)=/i;

sw.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(shellCache);
    await shell.addAll([shellUrl, offlineUrl].map(url => new Request(url, { cache: 'reload' })));
    if (precache.length) {
      const files = await caches.open(fileCache);
      await files.addAll(precache.map(url => new Request(url, { cache: 'reload' })));
    }
    // Deliberately no skipWaiting here. Existing trip/call windows keep their
    // current bundle until the user chooses “Update and restart”.
  })());
});

sw.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== shellCache && key !== fileCache) await caches.delete(key);
    }
    await sw.clients.claim();
  })());
});

sw.addEventListener('message', event => {
  if (event.data?.type === 'TRAMPO_UPDATE') event.waitUntil(sw.skipWaiting());
});

function inScope(url: URL) {
  return url.origin === scope.origin && (url.pathname === base.replace(/\/$/, '') || url.pathname.startsWith(base));
}
function privateRoute(url: URL) {
  const path = url.pathname.slice(base.length).replace(/^\//, '');
  return /^(api|auth|functions|rest|realtime|share)(\/|$)/.test(path) || credentials.test(url.search) || url.hash.includes('access_token=');
}
async function navigation(request: Request, url: URL) {
  if (privateRoute(url)) return fetch(request);
  try {
    const response = await fetch(request);
    // Don't replace the public shell with a redirect, error page, or personalized HTML.
    if (response.ok && response.type === 'basic' && !response.redirected && !url.search && (url.href === shellUrl || url.pathname === `${base}index.html`) && response.headers.get('content-type')?.includes('text/html')) {
      const cache = await caches.open(shellCache);
      await cache.put(shellUrl, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(shellCache);
    return (await cache.match(offlineUrl)) || (await cache.match(shellUrl)) || new Response('Trampo is offline. Reconnect and try again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
sw.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || !inScope(url) || privateRoute(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request, url));
    return;
  }
  // No opaque tile caching, no runtime API caching, no credentials in CacheStorage.
  if (!publicFiles.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(fileCache);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(url.href, response.clone());
    return response;
  })());
});

sw.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => {
      const url = new URL(client.url);
      return inScope(url) && !privateRoute(url) && !/\/share\//.test(url.pathname);
    });
    if (existing) { await existing.focus(); return; }
    await sw.clients.openWindow(shellUrl);
  })());
});

