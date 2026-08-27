// =========================================================
// sw.js — app-shell caching for offline use.
//
// CACHE_NAME is tied to the app version and is rewritten
// automatically by scripts/bump-version.js on every bump, so a
// new deployment always gets a fresh cache and the old one is
// deleted on activate. Fetch strategy is network-first: when
// online you always get the latest files (which is what makes
// "auto-update" actually work); when offline you fall back to
// whatever was last cached.
// =========================================================
const CACHE_NAME = 'returns-system-v1.17.21';
// A service worker's own fetch() still goes through the browser's HTTP
// cache. GitHub Pages serves this app with max-age, so a "network-first"
// fetch would happily hand back a file the browser cached minutes ago —
// and then store that stale copy under the *new* version's cache name.
// That is what left clients reloading forever on "جارِ التحديث": the
// version check read a fresh version.json while every module it compared
// against came from cache. Same-origin requests are always revalidated
// against the server, so a changed file is always seen as changed.
function fetchFresh(request, mode = 'no-cache') {
  return fetch(new Request(request.url, {
    cache: mode,
    credentials: 'same-origin',
    redirect: 'follow',
  }));
}

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/core/db.js',
  './js/core/utils.js',
  './js/core/audit.js',
  './js/core/router.js',
  './js/core/version.js',
  './js/core/autosave.js',
  './js/core/sync-status.js',
  './js/core/firebase-init.js',
  './js/core/migrate-to-firebase.js',
  './js/modules/dashboard.js',
  './js/modules/suppliers.js',
  './js/modules/items.js',
  './js/modules/item-links.js',
  './js/modules/excel-import.js',
  './js/modules/supplier-items.js',
  './js/modules/returns.js',
  './js/modules/return-export.js',
  './js/modules/audit-log.js',
  './js/modules/settings.js',
  './js/modules/invoice-reviews.js',
  './icons/icon.svg',
];

// Never cached — always fetched fresh so the client can detect updates.
const NEVER_CACHE = ['version.json'];

self.addEventListener('install', (event) => {
  // cache.addAll() reads through the HTTP cache too, so priming a new
  // version's cache used to fill it with the previous version's files.
  // 'reload' bypasses the HTTP cache outright — this runs once per
  // deployment, so the extra cost is paid once.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(APP_SHELL.map(url =>
        fetchFresh(new Request(new URL(url, self.location).href), 'reload')
          .then(res => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null) // one unreachable file must not fail the whole install
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NEVER_CACHE.some(name => url.pathname.endsWith(name))) {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Third-party (CDN) requests: same network-first-with-cache-fallback
  // strategy as same-origin. This matters more now than it used to —
  // the Firebase SDK itself loads from this CDN, so without caching it
  // here the app couldn't even boot offline after the very first visit.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin app shell: revalidate against the server every time, so
  // an updated file is never missed; the cache is only a fallback for
  // when the network is unreachable.
  event.respondWith(
    fetchFresh(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || Promise.reject(new Error('offline and not cached'))))
  );
});

// Let the page ask the waiting worker to activate immediately
// (used together with the client-side version check).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  // Recovery hatch: the page can ask for every cache to be dropped when
  // it detects it is running code older than what is deployed.
  if (event.data === 'PURGE_CACHES') {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});
