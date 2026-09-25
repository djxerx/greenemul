// ─── Service worker — BATTLEZONE emulator ───────────────────────────────
// Makes the emulator work offline once it has been opened online, the same
// way as the video poker app, adapted for an app made of many small files.
//
// Strategy: NETWORK-FIRST WITH TIMEOUT for every same-origin file. Online,
// each request goes to the server so the page and all its ES modules come
// from the same (newest) build -- serving a stale module next to a fresh one
// could break the imports between them. If the server hasn't answered within
// NET_TIMEOUT_MS (weak Wi-Fi, the computer asleep, the iPad waking up) or
// can't be reached at all, the cached copy is served instead. The network
// request is never aborted, so a late answer still refreshes the cache.
//
// What gets cached: the page shell below at install, then every file the page
// actually loaded -- js/pwa.js posts that list once this worker is in control
// -- so there is no hand-kept file list to fall out of date.
//
// The ROM images the emulator loads at start are cached like everything else.
const CACHE_NAME     = 'bz-emu-v1';
const NET_TIMEOUT_MS = 3500;
const SHELL = ['/', '/index.html', '/manifest.json',
               '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png'];
const NEVER_CACHE = [];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// purge caches from older versions, take control of open pages now
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page's list of everything it loaded: fetch and store each one. A few at
// a time, each retried up to 3 times -- a simple server (the emulator's Python
// dev server, a phone on weak Wi-Fi) can drop one of a burst of requests, and
// a file silently missing from the cache would break the app offline.
const fetchAndStore = async (cache, path) => {
  for (let tries = 0; tries < 3; tries++) {
    try {
      const r = await fetch(path, { cache: 'reload' });
      if (r && r.ok) { await cache.put(path, r); return; }
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 300 * (tries + 1)));
  }
};
self.addEventListener('message', event => {
  const m = event.data;
  if (!m || m.t !== 'cache' || !Array.isArray(m.urls)) return;
  const paths = [...new Set(m.urls.map(u => new URL(u, self.location.origin))
    .filter(u => u.origin === self.location.origin && !NEVER_CACHE.includes(u.pathname))
    .map(u => u.pathname))];
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    const queue = paths.slice();
    const worker = async () => { while (queue.length) await fetchAndStore(cache, queue.shift()); };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || NEVER_CACHE.includes(url.pathname)) return;
  const isPage = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const key = isPage ? '/index.html' : url.pathname;

  const network = fetch(event.request, { cache: 'no-cache' }).then(response => {
    if (response && response.status === 200) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => {
        cache.put(key, copy.clone());
        if (isPage) cache.put('/', copy);
      });
    }
    return response;
  });
  const cached  = () => caches.match(key).then(c => c || (isPage ? caches.match('/') : null));
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), NET_TIMEOUT_MS));

  event.respondWith(
    Promise.race([network.catch(() => null), timeout]).then(response => {
      if (response) return response;                 // the server answered in time
      return cached().then(c => c || network);       // offline / slow: the cached copy
    })
  );
});
