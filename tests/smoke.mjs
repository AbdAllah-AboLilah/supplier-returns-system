// =========================================================
// tests/smoke.mjs — end-to-end smoke suite.
//
// Serves the app from disk, swaps js/core/db.js for the in-memory
// fixture (so the live Firestore project is never touched), drives a
// real browser through every screen, and asserts on the behaviours
// that have broken before.
//
// Run with:  npm test
// =========================================================
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// ---------- static server on a port the OS picks ----------
const server = http.createServer((req, res) => {
  let filePath = decodeURIComponent(req.url.split('?')[0]);
  if (filePath === '/') filePath = '/index.html';
  try {
    const body = readFileSync(path.join(ROOT, filePath));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- results ----------
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? '  ✓' : '  ✗'}  ${name}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
// The app registers a service worker on localhost and reloads the page
// when it takes control — block it so the suite drives a stable page.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

// Data layer -> in-memory fixture. Firebase and the CDN scripts never load.
const fixture = readFileSync(path.join(HERE, 'fixtures/fake-db.js'), 'utf8');
await page.route('**/js/core/db.js', r => r.fulfill({ contentType: 'text/javascript', body: fixture }));
await page.route('**/gstatic.com/**', r => r.abort());
await page.route('**/googleapis.com/**', r => r.abort());
await page.route('**/cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: 'window.XLSX={};window.html2canvas=()=>{};' }));
await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));

const goto = (hash) => page.evaluate(h => { window.location.hash = h; }, hash);

try {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('#app-content .card, #app-content .empty-state', { timeout: 20000 });
  await page.waitForTimeout(500);

  // ---------- every route renders without throwing ----------
  const routes = ['/dashboard', '/items', '/supplier-items/unlinked', '/suppliers', '/supplier-items',
                  '/returns/active', '/returns/sent', '/returns/unregistered', '/returns/archive',
                  '/invoice-reviews', '/audit', '/settings', '/items/import'];
  for (const route of routes) {
    await goto(route);
    await page.waitForTimeout(350);
    const html = await page.$eval('#app-content', el => el.innerHTML);
    const broke = html.includes('حدث خطأ غير متوقع') || html.includes('الصفحة غير موجودة');
    check(`route ${route} renders`, html.length > 200 && !broke, broke ? 'render threw' : '');
  }

  // ---------- returns list is paginated ----------
  await goto('/returns/active');
  await page.waitForTimeout(400);
  const pager = await page.$('#returns-pagination .pagination');
  const rowCount = await page.$$eval('#app-content tbody tr', rs => rs.length);
  check('returns list paginates', !!pager && rowCount <= 50, `rows=${rowCount}`);

  // ---------- typing in a search box keeps focus and caret ----------
  await page.click('#ret-search');
  await page.type('#ret-search', 'RET', { delay: 60 });
  await page.waitForTimeout(450);
  const focus = await page.evaluate(() => ({
    id: document.activeElement?.id, value: document.activeElement?.value, caret: document.activeElement?.selectionStart,
  }));
  check('search keeps focus while typing', focus.id === 'ret-search' && focus.value === 'RET' && focus.caret === 3, JSON.stringify(focus));

  // ---------- a return opens with its lines ----------
  await goto('/returns/r1');
  await page.waitForTimeout(500);
  const lineCount = await page.$$eval('tr[data-line]', rs => rs.length);
  check('return detail renders its lines', lineCount === 3, `lines=${lineCount}`);

  // ---------- suggestions close on an outside click, every time ----------
  await page.click('#add-item-name');
  await page.type('#add-item-name', 'كريب', { delay: 40 });
  await page.waitForTimeout(400);
  const open1 = await page.$eval('#add-item-results', el => el.style.display);
  await page.click('#topbar-title');
  await page.waitForTimeout(120);
  const closed1 = await page.$eval('#add-item-results', el => el.style.display);
  await page.click('#add-item-name');
  await page.fill('#add-item-name', '');
  await page.type('#add-item-name', 'كريب س', { delay: 40 });
  await page.waitForTimeout(400);
  const open2 = await page.$eval('#add-item-results', el => el.style.display);
  await page.click('#topbar-title');
  await page.waitForTimeout(120);
  const closed2 = await page.$eval('#add-item-results', el => el.style.display);
  check('suggestions close on outside click every time',
        open1 === 'block' && closed1 === 'none' && open2 === 'block' && closed2 === 'none',
        `${open1}/${closed1} then ${open2}/${closed2}`);

  // ---------- adding a line ----------
  await page.fill('#add-item-name', 'صنف اختبار جديد');
  await page.fill('#add-item-qty', '5');
  await page.fill('#add-item-cost', '12.5');
  await page.click('#btn-add-item');
  await page.waitForTimeout(700);
  const afterAdd = await page.$$eval('tr[data-line]', rs => rs.length);
  check('adding a line works', afterAdd === 4, `lines=${afterAdd}`);

  // ---------- editing a quantity recalculates ----------
  await page.locator('tr[data-line] .line-qty').first().fill('7');
  await page.waitForTimeout(800);
  const rowTotal = await page.evaluate(() => document.querySelector('tr[data-line] .num.text-mono')?.textContent);
  check('editing a quantity recalculates the row', !!rowTotal && rowTotal !== '0.00', `total=${rowTotal}`);

  // ---------- tabbing through untouched fields must not save ----------
  const fieldCount = await page.$$eval('.line-qty, .line-cost', els => els.length);
  await page.evaluate(() => window.__resetCounters());
  await page.evaluate(() => { document.querySelectorAll('.line-qty, .line-cost').forEach(i => { i.focus(); i.blur(); }); });
  await page.waitForTimeout(900);
  const idleWrites = await page.evaluate(() => window.__writes);
  check('tabbing through unchanged fields writes nothing', idleWrites === 0, `${idleWrites} writes over ${fieldCount} fields`);

  // ---------- ...but a real edit still saves ----------
  await page.evaluate(() => {
    const input = document.querySelector('.line-qty');
    input.focus(); input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await page.waitForTimeout(900);
  const editWrites = await page.evaluate(() => window.__writes);
  check('a real edit still saves', editWrites > 0, `${editWrites} writes`);

  // ---------- a 25-line return still opens ----------
  await goto('/returns/rbig');
  await page.waitForTimeout(1200);
  const bigLines = await page.$$eval('tr[data-line]', rs => rs.length);
  check('a 25-line return opens fully', bigLines === 25, `lines=${bigLines}`);

  // ---------- invoice review keeps its unit word after an edit ----------
  await goto('/invoice-reviews/iv1');
  await page.waitForTimeout(500);
  await page.fill('.ln-qty', '3');
  await page.waitForTimeout(800);
  const actualQty = await page.$eval('#ln-actual-iv1-1', el => el.textContent.trim());
  check('actual-quantity keeps its unit word after editing', actualQty.includes('قطعة'), `"${actualQty}"`);

  // ---------- supplier page renders both panels ----------
  await goto('/suppliers/s1');
  await page.waitForTimeout(1200);
  const supplierPage = await page.evaluate(() => ({
    stats: document.querySelectorAll('.stat-card').length,
    returns: !!document.querySelector('#supplier-returns table, #supplier-returns .empty-state'),
    items: !!document.querySelector('#supplier-items-panel table, #supplier-items-panel .empty-state'),
  }));
  check('supplier page renders stats and both panels',
        supplierPage.stats === 4 && supplierPage.returns && supplierPage.items, JSON.stringify(supplierPage));

  // ---------- all-supplier-items groups by supplier ----------
  await goto('/supplier-items');
  await page.waitForTimeout(600);
  const groupCards = await page.$$eval('#supplier-groups .card', cs => cs.length);
  check('all-supplier-items groups by supplier', groupCards >= 3, `groups=${groupCards}`);

  // ---------- one numeral system across the whole UI ----------
  await goto('/returns/r1');
  await page.waitForTimeout(600);
  const numerals = await page.evaluate(() => {
    const arabicIndic = /[\u0660-\u0669]/;
    const offenders = [];
    document.querySelectorAll('#app-content td, #app-content .stat-value, #app-content .small').forEach(el => {
      if (el.querySelector('input, select')) return;      // inputs always render Latin digits
      if (arabicIndic.test(el.textContent)) offenders.push(el.textContent.trim().slice(0, 40));
    });
    return offenders;
  });
  check('no mixed numerals on screen', numerals.length === 0, numerals.slice(0, 3).join(' | '));

  // ---------- report image draws Arabic with its spaces intact ----------
  const imageCheck = await page.evaluate(async () => {
    const { drawReport } = await import('/js/modules/report-canvas.js');
    const canvas = await drawReport({
      title: 'مرتجعة RET-2026-00012',
      subtitle: 'مصنع سلمي',
      columns: [{ key: 'name', label: 'اسم الصنف عند المورد', flex: true }, { key: 'qty', label: 'الكمية' }],
      rows: [{ name: 'بدي تُل مبطن', qty: '19' }],
    });
    // fillText hands the string to the browser's text engine, so a
    // spaced phrase must measure wider than the same letters unspaced —
    // that difference is exactly what html2canvas used to lose.
    const ctx = canvas.getContext('2d');
    ctx.font = "700 13px 'Tajawal', sans-serif";
    const spaced = ctx.measureText('اسم الصنف عند المورد').width;
    const glued = ctx.measureText('اسمالصنفعندالمورد').width;
    return { ok: canvas.width > 0 && canvas.height > 0 && spaced > glued, spaced, glued, w: canvas.width, h: canvas.height };
  });
  check('report image renders Arabic with spacing', imageCheck.ok, `canvas ${imageCheck.w}x${imageCheck.h}`);

  // ---------- printing needs no popup ----------
  const printCheck = await page.evaluate(async () => {
    const { printHtmlDocument } = await import('/js/core/utils.js');
    let popupOpened = false;
    const realOpen = window.open;
    window.open = () => { popupOpened = true; return null; };
    let threw = false;
    await printHtmlDocument('<!DOCTYPE html><html><body>اختبار الطباعة</body></html>').catch(() => { threw = true; });
    window.open = realOpen;
    return { popupOpened, threw };
  });
  check('printing does not rely on a popup', printCheck.popupOpened === false && !printCheck.threw, JSON.stringify(printCheck));

  // ---------- suggestions inside a modal are not clipped ----------
  await goto('/supplier-items');
  await page.waitForTimeout(700);
  await page.locator('.btn-link').first().click();
  await page.waitForTimeout(400);
  await page.type('#erp-search', 'صنف', { delay: 40 });
  await page.waitForTimeout(500);
  const dropdown = await page.evaluate(() => {
    const list = document.querySelector('.modal-body .autocomplete-list');
    if (!list) return { found: false };
    const body = list.closest('.modal-body').getBoundingClientRect();
    const rect = list.getBoundingClientRect();
    return {
      found: true,
      items: list.querySelectorAll('.autocomplete-item').length,
      height: Math.round(rect.height),
      // nothing of the list may fall outside the scroll container's box
      clipped: rect.bottom > body.bottom + 1,
    };
  });
  check('modal suggestions show several rows unclipped',
        dropdown.found && dropdown.items >= 3 && dropdown.height > 120 && !dropdown.clipped,
        JSON.stringify(dropdown));
  await page.click('.modal-close'); // its backdrop would block every later click
  await page.waitForTimeout(300);

  // ---------- barcode is an opt-in export column ----------
  await goto('/returns/r1');
  await page.waitForTimeout(600);
  await page.click('#btn-export');
  await page.waitForTimeout(600);
  const barcodeToggle = await page.evaluate(() => {
    const box = document.querySelector('.col-toggle[value="barcode"]');
    const others = Array.from(document.querySelectorAll('.col-toggle')).filter(c => c.value !== 'barcode');
    return { exists: !!box, checked: box ? box.checked : null, othersChecked: others.every(c => c.checked), count: others.length + (box ? 1 : 0) };
  });
  check('return export offers a barcode column, unticked by default',
        barcodeToggle.exists && barcodeToggle.checked === false && barcodeToggle.othersChecked,
        JSON.stringify(barcodeToggle));

  // The barcode itself comes from the linked ERP item, not the line.
  const resolved = await page.evaluate(async () => {
    const { attachBarcodes } = await import('/js/modules/return-export.js');
    const db = await import('/js/core/db.js');
    const lines = await attachBarcodes(await db.getByIndex('returnItems', 'returnId', 'r1'));
    return lines.map(l => ({ linked: !!l.erpItemId, barcode: l.erpBarcode }));
  });
  check('barcodes resolve from the linked ERP item',
        resolved.every(l => (l.linked ? /^\d+$/.test(l.barcode) : l.barcode === '')),
        JSON.stringify(resolved));
  await page.click('.modal-close');
  await page.waitForTimeout(300);

  // ---------- the invoice unit decides what the price means ----------
  // iv2, not iv1: an earlier check edits iv1's quantity.
  await goto('/invoice-reviews/iv2');
  await page.waitForTimeout(700);
  const priced = await page.evaluate(() => ({
    unit: document.querySelector('.ln-unit')?.value,
    unitPrice: document.querySelector('.ln-price')?.value,
    piece: document.querySelector('[id^="ln-piece-"]')?.textContent.trim(),
    total: document.querySelector('[id^="ln-total-"]')?.textContent.trim(),
    barcodeBox: (() => { const b = document.querySelector('#exp-barcode'); return b ? b.checked : null; })(),
  }));
  // Seeded as 2 dozen at 50 per dozen: 50 / 12 = 4.17 a piece, 100 in total.
  // The piece price is the assertion that matters — it must not depend on
  // the quantity at all.
  check('a dozen price is divided into a piece price',
        priced.unit === 'dozen' && priced.unitPrice === '50' && priced.piece === '4.17' && priced.total === '100.00',
        JSON.stringify(priced));
  check('invoice export offers a barcode column, unticked by default', priced.barcodeBox === false);

  // Switching the unit to pieces makes the typed price the piece price.
  await page.selectOption('.ln-unit', 'piece');
  await page.waitForTimeout(800);
  const asPieces = await page.evaluate(() => ({
    piece: document.querySelector('[id^="ln-piece-"]')?.textContent.trim(),
    actual: document.querySelector('[id^="ln-actual-"]')?.textContent.trim(),
  }));
  check('switching to pieces makes the typed price the piece price',
        asPieces.piece === '—' && asPieces.actual.startsWith('2'), JSON.stringify(asPieces));

  check('no console or page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('suite ran to completion', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (pageErrors.length) {
  console.log('\nBrowser errors:');
  pageErrors.slice(0, 10).forEach(e => console.log('  ' + e));
}
process.exit(failed ? 1 : 0);
