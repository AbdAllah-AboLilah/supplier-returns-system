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
const CACHE_NAME = 'returns-system-v1.12.0';
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
  './js/core/brand.js',
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
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
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

  // Same-origin app shell: network-first so updates are seen right
  // away; cache is only a fallback for offline use.
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});

// Let the page ask the waiting worker to activate immediately
// (used together with the client-side version check).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
