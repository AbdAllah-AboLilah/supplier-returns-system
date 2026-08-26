// =========================================================
// tests/update-recovery.mjs
//
// The app reloads itself when version.json advertises a version newer
// than the one it is running. If a reload comes back running the same
// old code — a stale HTTP cache, a stale service-worker cache — that
// check fires again, and the app spends the rest of its life reloading
// every second and a half. It happened in production.
//
// This drives the worst case on purpose: a server that permanently
// claims a new version but never actually serves one. The app must give
// up after a bounded number of attempts and show a recovery banner
// instead of looping.
//
// Run with:  npm run test:update
// =========================================================
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// The app is served as 1.0.0; version.json is switched to claim 9.9.9
// while js/core/version.js keeps reporting 1.0.0 — the exact mismatch
// that produced the loop.
let advertised = '1.0.0';
const RUNNING = '1.0.0';

// The data layer is swapped out at the server, not with a route
// interceptor: a service worker fetches on its own, outside anything
// page.route() can see, and the service worker is half of what this
// suite exists to test.
const DB_FIXTURE = readFileSync(path.join(HERE, 'fixtures/fake-db.js'));

function bodyFor(p) {
  if (p === '/version.json') return Buffer.from(JSON.stringify({ version: advertised, buildDate: '2026-08-26' }));
  if (p === '/js/core/version.js') return Buffer.from(`export const APP_VERSION = '${RUNNING}';\nexport const BUILD_DATE = '2026-08-26';\n`);
  if (p === '/js/core/db.js') return DB_FIXTURE;
  if (p === '/index.html') {
    // Strip the CDN font and spreadsheet tags. A service worker fetches
    // on its own, past any test interceptor, so on a sandboxed network
    // those requests hang and every boot takes ten seconds — nothing to
    // do with the update logic this suite is measuring.
    return Buffer.from(readFileSync(path.join(ROOT, p), 'utf8')
      .replace(/<script src="https:\/\/cdnjs[^>]*><\/script>\n?/g, '')
      .replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>\n?/g, ''));
  }
  return readFileSync(path.join(ROOT, p));
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let buf;
  try { buf = bodyFor(p); } catch { res.writeHead(404); res.end('not found'); return; }
  const etag = '"' + crypto.createHash('md5').update(buf).digest('hex') + '"';
  // Mirrors what GitHub Pages sends, cache lifetime included.
  const headers = { 'Content-Type': MIME[path.extname(p)] || 'text/plain', 'Cache-Control': 'max-age=600', ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, headers); res.end(buf);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://localhost:${server.address().port}`;

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '  ✓' : '  ✗'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch();
// Service workers stay ON here — they are half of what is being tested.
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

await context.route('**/cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.XLSX={};' }));

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
page.on('requestfailed', r => consoleErrors.push('reqfail: ' + r.url().split('/').pop() + ' ' + (r.failure()?.errorText || '')));

let loads = 0;
page.on('load', () => { loads++; });

try {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('#app-content .card, #app-content .empty-state', { timeout: 20000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  check('app boots with a service worker in control', loads >= 1);

  // Advertise a version that will never actually be served.
  advertised = '9.9.9';
  loads = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  // Long enough for every escalation to play out; an unbounded loop
  // would rack up far more reloads than the cap in the same window.
  await page.waitForTimeout(30000);
  // The last reload has to finish booting before the page can be judged.
  await page.waitForSelector('#app-content .card, #app-content .empty-state', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  if (process.env.DEBUG_UPDATE) {
    console.log('DEBUG url:', page.url());
    console.log('DEBUG failures:', consoleErrors.filter(e => e.startsWith('reqfail') && !/cdnjs|fonts|gstatic/.test(e)));
    console.log('DEBUG pageerrors:', consoleErrors.filter(e => e.startsWith('pageerror')));
    console.log('DEBUG state:', await page.evaluate(() => ({
      attempt: sessionStorage.getItem('returns-system:update-attempt'),
      hasBanner: !!document.querySelector('#update-stuck'),
      content: (document.querySelector('#app-content')?.innerHTML || '').slice(0, 120),
      appContentExists: !!document.querySelector('#app-content'),
      versionBadge: document.querySelector('#version-badge')?.textContent || null,
      bodyLen: document.body.innerHTML.length,
      controller: !!navigator.serviceWorker.controller,
    })));
  }

  check('reloading is bounded, not endless', loads <= 4, `${loads} reloads`);

  const banner = await page.evaluate(() => {
    const el = document.querySelector('#update-stuck');
    return { shown: !!el, hasButton: !!(el && el.querySelector('#btn-force-update')), text: el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : '' };
  });
  check('a recovery banner is shown instead', banner.shown && banner.hasButton, banner.text);

  // The app has to stay usable while it is stuck.
  const usable = await page.evaluate(() => !!document.querySelector('#app-content .card, #app-content .empty-state'));
  check('the app is still usable while stuck', usable);

  // And once the real version does arrive, it must settle silently.
  advertised = RUNNING;
  loads = 0;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(3000);
  check('no further reloads once versions agree', loads === 0, `${loads} reloads`);
} catch (err) {
  check('suite ran to completion', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
