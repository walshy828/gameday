// public/sw.js
// Lets the app shell load with no connection, so the concession stand can be opened and used offline (sales
// themselves are queued on the phone by concessionsStore.js; this file only keeps the page and its scripts).
//
// - Same-origin pages/scripts/styles: network first (so a new deploy shows up right away when online), falling
//   back to the saved copy if the network is down or slower than 3 seconds.
// - CDN scripts/styles/fonts (Tailwind, Firebase SDK, Socket.IO, fonts): saved copy first, refreshed in the
//   background. They are versioned URLs, so this is safe.
// - Never touched: /api/*, /socket.io/*, and any non-GET or non-asset request (live data always goes to the network).
// The page tells us which resources it loaded (see offline.js) so everything needed is saved after the first visit.
const CACHE = 'gameday-shell-v2';
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gameday-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const ASSET_DEST = ['script', 'style', 'font', 'image'];

function networkFirst(request, key) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = async () => (await caches.match(key || request, { ignoreSearch: false })) || null;
    const timer = setTimeout(async () => {
      const hit = await fallback();
      if (hit && !settled) { settled = true; resolve(hit); }
    }, NETWORK_TIMEOUT_MS);
    // 'no-cache' = always revalidate with the server, so a new deploy isn't hidden behind the 5-minute HTTP cache.
    fetch(request, { cache: 'no-cache' }).then(async (res) => {
      clearTimeout(timer);
      if (res && res.ok) { const c = await caches.open(CACHE); c.put(key || request, res.clone()); }
      if (!settled) { settled = true; resolve(res); }
    }).catch(async () => {
      clearTimeout(timer);
      if (settled) return;
      const hit = await fallback();
      settled = true;
      resolve(hit || Response.error());
    });
  });
}

async function cacheFirst(request) {
  const c = await caches.open(CACHE);
  const hit = await c.match(request);
  const refresh = fetch(request).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(request, res.clone()); return res; });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
    if (req.mode === 'navigate') { event.respondWith(networkFirst(req, '/')); return; }
    event.respondWith(networkFirst(req));
    return;
  }
  if (ASSET_DEST.includes(req.destination)) event.respondWith(cacheFirst(req));
});

// The page lists what it loaded; save any of it we haven't seen (it loaded before this worker took control).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'cache' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(data.urls.map(async (u) => {
      try {
        const url = new URL(u);
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
        const same = url.origin === self.location.origin;
        const key = same && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : u;
        if (await c.match(key)) return;
        const res = await fetch(new Request(u, { mode: same ? 'same-origin' : 'no-cors' }));
        if (res && (res.ok || res.type === 'opaque')) await c.put(key, res);
      } catch (e) { /* best effort */ }
    }));
  })());
});
