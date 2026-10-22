/* WhatsTime service worker: offline app shell + runtime caching. Plain ES2020, no build step.
 * All URLs are relative to this file, so it works at a domain root and under a sub-path. */

// Bump the version when PRECACHE or the caching logic changes; old caches are removed on activate.
const CACHE_PREFIX = 'whatstime-';
const CACHE = `${CACHE_PREFIX}v1`;
const SHELL = './index.html';
const NAV_TIMEOUT_MS = 3000;
// crossorigin <script>/<link> requests carry an Origin header and some hosts answer with
// `Vary: Origin`, which would make every lookup miss. The app is static, so ignore Vary.
const MATCH = { ignoreVary: true };
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      await cacheShellAssets(cache);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only touch our own caches: other apps may share this origin (e.g. <user>.github.io).
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // Chrome DevTools quirk: this combination makes fetch() throw.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

// Navigations: network first; after NAV_TIMEOUT_MS or on failure, serve the cached app shell.
async function networkFirstNavigation(event) {
  const network = fetchAndCache(event, event.request, isShellUrl(event.request.url) ? SHELL : null);
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS, null));
  const fresh = await Promise.race([network.catch(() => null), timeout]);
  if (fresh) return fresh;

  const cache = await caches.open(CACHE);
  const cached = (await cache.match(SHELL, MATCH)) || (await cache.match('./', MATCH));
  if (!cached) return network;
  // A redirected response cannot answer a navigation; re-wrap it if the host redirected index.html.
  return cached.redirected ? new Response(cached.body, cached) : cached;
}

// Everything else: answer from the cache when possible and refresh it in the background.
async function staleWhileRevalidate(event) {
  const network = fetchAndCache(event, event.request, event.request);
  const cached = await (await caches.open(CACHE)).match(event.request, MATCH);
  return cached || network;
}

// Fetches `request`; stores a copy under `key` when the response is a plain same-origin success.
function fetchAndCache(event, request, key) {
  const response = fetch(request);
  const stored = response.then((res) => {
    if (!key || !res.ok || res.type !== 'basic' || res.redirected) return undefined;
    const copy = res.clone(); // before the page starts reading the body
    return caches.open(CACHE).then((cache) => cache.put(key, copy));
  });
  event.waitUntil(stored.catch(() => undefined));
  return response;
}

function isShellUrl(url) {
  const { pathname } = new URL(url);
  const scope = new URL(self.registration.scope).pathname;
  return pathname === scope || pathname === `${scope}index.html`;
}

// The hashed JS/CSS that index.html references were downloaded before this worker existed, so the
// fetch handler never saw them. Cache them now so the very first offline launch works.
async function cacheShellAssets(cache) {
  const shell = await cache.match(SHELL, MATCH);
  if (!shell) return;
  const html = await shell.text();
  const base = new URL(SHELL, self.location.href);
  const scope = new URL(self.registration.scope).pathname;
  const urls = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], base))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith(scope))
    .map((url) => url.href.split('#')[0]);
  await Promise.allSettled(
    [...new Set(urls)].map(async (url) => {
      if (!(await cache.match(url, MATCH))) await cache.add(url);
    }),
  );
}
