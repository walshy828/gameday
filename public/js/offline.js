// public/js/offline.js
// Registers the service worker (public/sw.js) so the app loads with no connection, then tells it which
// resources this page used so they are all saved after the first visit. Failure here is harmless: the app
// simply needs a connection to load, as before.
export function initOffline() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      const reg = await navigator.serviceWorker.ready;
      const urls = ['/', ...performance.getEntriesByType('resource')
        .filter((r) => ['script', 'link', 'css', 'img', 'other'].includes(r.initiatorType) || r.name.endsWith('.js') || r.name.endsWith('.css'))
        .map((r) => r.name)
        .filter((u) => !/\/(api|socket\.io)\//.test(u) && /^https?:/.test(u))].map((u) => (u.startsWith('http') ? u : new URL(u, location.origin).href));
      (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'cache', urls: [...new Set(urls)] });
    } catch (e) { console.warn('Offline support unavailable:', e); }
  });
}
