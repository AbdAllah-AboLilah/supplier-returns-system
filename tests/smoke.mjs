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

  // ---------- the picked item names the ERP item behind it ----------
  // The suggestion list carries the ERP name, but only while it is open —
  // after picking, nothing said which ERP item the line would be filed
  // against, so picking the wrong row showed up only once it was added.
  await page.click('#add-item-name');
  await page.fill('#add-item-name', '');
  await page.type('#add-item-name', 'كريب', { delay: 40 });
  await page.waitForTimeout(500);
  const firstPick = await page.$eval('#add-item-results .autocomplete-item',
    el => ({ id: el.dataset.supplierItemId, erpName: el.dataset.erpName }));
  await page.locator('#add-item-results .autocomplete-item').first().click();
  await page.waitForTimeout(300);
  const pickedErp = await page.evaluate(() => {
    const n = document.querySelector('#add-item-erp');
    return { shown: n.style.display !== 'none', text: n.textContent.replace(/\s+/g, ' ').trim() };
  });
  check('picking an item on a return names its ERP item',
        pickedErp.shown && (firstPick.erpName
          ? pickedErp.text.includes(firstPick.erpName)
          : pickedErp.text.includes('مش مربوط')),
        `${JSON.stringify(pickedErp)} expected=${firstPick.erpName || '(unlinked)'}`);

  await page.type('#add-item-name', 'ي', { delay: 40 });
  await page.waitForTimeout(350);
  const erpAfterTyping = await page.$eval('#add-item-erp', el => el.style.display);
  check('and it goes once the name is typed over', erpAfterTyping === 'none', erpAfterTyping);
  await page.click('#topbar-title'); // close the suggestion list it reopened
  await page.waitForTimeout(150);

  // ---------- adding a line ----------
  await page.fill('#add-item-name', 'صنف اختبار جديد');
  await page.fill('#add-item-qty', '5');
  await page.fill('#add-item-cost', '12.5');
  // What the line will come to, before it is added.
  await page.waitForTimeout(200);
  const totalAsPiece = await page.$eval('#add-item-total', el => el.textContent.trim());
  await page.selectOption('#add-item-unit-type', 'dozen');
  await page.waitForTimeout(200);
  const totalAsDozen = await page.$eval('#add-item-total', el => el.textContent.trim());
  await page.selectOption('#add-item-unit-type', 'piece');
  await page.waitForTimeout(200);
  check('the add card works out the line total as it is typed',
        totalAsPiece === '62.50' && totalAsDozen === '5.21',
        `piece=${totalAsPiece} dozen=${totalAsDozen}`);

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

  // ---------- printing needs no popup, and hands over a real document ----------
  // The thermal receipt came out blank twice over: the frame carrying the
  // document had no height, so it laid out in a zero-height viewport, and
  // it was torn down two seconds later while a phone's print preview was
  // still rendering it.
  const printCheck = await page.evaluate(async () => {
    const { printHtmlDocument } = await import('/js/core/utils.js');
    let popupOpened = false;
    const realOpen = window.open;
    window.open = () => { popupOpened = true; return null; };
    let threw = false;
    const before = document.querySelectorAll('iframe').length;
    await printHtmlDocument(
      '<!DOCTYPE html><html><body><div style="height:400px">اختبار الطباعة</div></body></html>'
    ).catch(() => { threw = true; });
    window.open = realOpen;
    const frames = Array.from(document.querySelectorAll('iframe'));
    const frame = frames.length > before ? frames[frames.length - 1] : null;
    const doc = frame ? frame.contentDocument : null;
    return {
      popupOpened, threw,
      height: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
      text: doc ? doc.body.textContent.trim() : '',
    };
  });
  check('printing does not rely on a popup', printCheck.popupOpened === false && !printCheck.threw, JSON.stringify(printCheck));
  check('the document handed to the printer is laid out, not zero-height',
        printCheck.height > 0 && printCheck.text.includes('اختبار الطباعة'),
        JSON.stringify(printCheck));

  // Still there well after the old two-second teardown.
  await page.waitForTimeout(3000);
  const printFrameAlive = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).some(f => (f.contentDocument?.body.textContent || '').includes('اختبار الطباعة')));
  check('and it outlives the print dialog instead of being pulled away', printFrameAlive, `alive=${printFrameAlive}`);

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
  check('return export offers a barcode column, ticked by default',
        barcodeToggle.exists && barcodeToggle.checked === true && barcodeToggle.othersChecked,
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
    columnToggles: Array.from(document.querySelectorAll('#export-columns .col-toggle'))
      .map(cb => ({ key: cb.value, checked: cb.checked })),
  }));
  // Seeded as 2 dozen at 50 per dozen: 50 / 12 = 4.17 a piece, 100 in total.
  // The piece price is the assertion that matters — it must not depend on
  // the quantity at all.
  check('a dozen price is divided into a piece price',
        priced.unit === 'dozen' && priced.unitPrice === '50' && priced.piece === '4.17' && priced.total === '100.00',
        JSON.stringify(priced));
  check('the invoice export can show or hide every column, all on by default',
        priced.columnToggles.length === 9
        && priced.columnToggles.every(t => t.checked)
        && priced.columnToggles.some(t => t.key === 'erpName')
        && priced.columnToggles.some(t => t.key === 'barcode'),
        JSON.stringify(priced.columnToggles.map(t => t.key)));

  // Switching the unit re-expresses the price rather than reinterpreting
  // it, so what the line costs per piece does not move: 50 a dozen shown
  // as pieces is 4.1667 each, still 4.17 in the piece column. The quantity
  // follows the new unit — 2 pieces, not 2 dozen.
  await page.selectOption('.ln-unit', 'piece');
  await page.waitForTimeout(800);
  const asPieces = await page.evaluate(() => ({
    piece: document.querySelector('[id^="ln-piece-"]')?.textContent.trim(),
    actual: document.querySelector('[id^="ln-actual-"]')?.textContent.trim(),
    unitPrice: document.querySelector('.ln-price')?.value,
  }));
  check('switching a line to pieces keeps what it costs per piece',
        asPieces.piece === '4.17' && asPieces.unitPrice === '4.1667' && asPieces.actual === '2 قطعة',
        JSON.stringify(asPieces));

  // ---------- the printed review is the same receipt as the return ----------
  const receipt = await page.evaluate(async () => {
    const { buildReviewReceipt } = await import('/js/modules/invoice-reviews.js');
    const units = [{ key: 'piece', label: 'قطعة', multiplier: 1 }, { key: 'dozen', label: 'دستة', multiplier: 12 }];
    const review = {
      reviewNumber: 'INV-2026-00002', supplierId: 's1', supplierName: 'مورد الأمل',
      invoiceNumber: 'F2', createdAt: '2026-08-01T08:00:00.000Z', updatedAt: '2026-08-05T08:00:00.000Z',
    };
    const rows = [{ itemName: 'كريب سادة', erpBarcode: '62000001', qty: 2, unitKey: 'dozen', price: 50 }];
    const html = buildReviewReceipt(review, rows, units, [{ id: 's1', name: 'مورد الأمل' }], undefined, 'محل الاختبار');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      hasStyle: /80mm auto/.test(html),
      author: doc.querySelector('.tp-letterhead td:last-child')?.textContent.trim(),
      shop: doc.querySelector('.tp-shop')?.textContent.trim(),
      tagline: doc.querySelector('.tp-tagline')?.textContent.trim(),
      title: doc.querySelector('.tp-title')?.textContent.trim(),
      subs: Array.from(doc.querySelectorAll('.tp-sub')).map(e => e.textContent.trim()),
      itemName: doc.querySelector('.tp-item-name')?.textContent.trim(),
      itemSubs: Array.from(doc.querySelectorAll('.tp-item-sub')).map(e => e.textContent.trim()),
      cells: Array.from(doc.querySelectorAll('.tp-item .tp-row td')).map(e => e.textContent.trim()),
      grand: Array.from(doc.querySelectorAll('.tp-grand-row td')).map(e => e.textContent.trim()),
    };
  });
  check('the printed review uses the receipt layout, not plain text',
        receipt.hasStyle && receipt.title === 'مراجعة فاتورة' && !!receipt.itemName,
        JSON.stringify({ title: receipt.title, item: receipt.itemName }));
  check('it carries the shop, the author and its own tagline',
        receipt.shop === 'محل الاختبار'
        && receipt.author === 'عبدالله <Abo-Lilah>'
        && receipt.tagline === 'نظام إدارة المخزون ومراجعة الفواتير',
        JSON.stringify({ shop: receipt.shop, author: receipt.author, tagline: receipt.tagline }));
  check('and the invoice figures, with a dozen line spelled out in pieces',
        receipt.subs.some(s => s.includes('INV-2026-00002'))
        && receipt.subs.some(s => s.includes('فاتورة رقم: F2'))
        && receipt.subs.some(s => s.startsWith('آخر تعديل'))
        && receipt.itemSubs.includes('باركود: 62000001')
        && receipt.cells.includes('الكمية: 2 دستة = 24 قطعة')
        && receipt.cells.includes('سعر الدستة: 50.00')
        && receipt.cells.includes('سعر القطعة: 4.17')
        && receipt.grand.join(' ').includes('24 قطعة'),
        JSON.stringify({ subs: receipt.subs, cells: receipt.cells, grand: receipt.grand }));

  // ---------- the ERP name, and leaving a column out ----------
  // Reported: the ERP name was nowhere in the printed review. It was not
  // in the data either — only the barcode was resolved from the ERP item.
  const columnControl = await page.evaluate(async () => {
    const iv = await import('/js/modules/invoice-reviews.js');
    const units = [{ key: 'piece', label: 'قطعة', multiplier: 1 }, { key: 'dozen', label: 'دستة', multiplier: 12 }];
    const review = { reviewNumber: 'INV-3', supplierId: null, supplierName: 'مورد', createdAt: '2026-08-26', updatedAt: '2026-08-26' };
    const rows = [{ itemName: 'كريب سادة', erpItemName: 'صنف ERP رقم 9', erpBarcode: '62000009', qty: 2, unitKey: 'dozen', price: 50 }];

    const full = iv.buildReviewReceipt(review, rows, units, []);
    const doc = new DOMParser().parseFromString(full, 'text/html');
    // Hand a driver a copy with no prices on it.
    const noPrices = iv.DEFAULT_REVIEW_KEYS.filter(k => !['price', 'piecePrice', 'total'].includes(k));
    const priceless = new DOMParser().parseFromString(
      iv.buildReviewReceipt(review, rows, units, [], noPrices), 'text/html');
    const spec = iv.buildReviewReportSpec(review, rows, units, [], ['itemName', 'erpName', 'qty']);
    // And the line the item was loaded with, since the name has to be
    // resolved from the ERP item before anything can print it.
    const db = await import('/js/core/db.js');
    const loaded = await iv.loadReviewItemsWithBarcodes('iv1');
    return {
      erpSub: Array.from(doc.querySelectorAll('.tp-item-sub')).map(e => e.textContent.trim()),
      pricelessCells: Array.from(priceless.querySelectorAll('.tp-item .tp-row td, .tp-grand-row td')).map(e => e.textContent.trim()),
      specColumns: spec.columns.map(c => c.key),
      specRow: spec.rows[0],
      loadedName: loaded[0]?.erpItemName,
      erpExists: !!(await db.getById('erpItems', 'e1')),
    };
  });
  check('the receipt names the ERP item under the supplier name',
        columnControl.erpSub.includes('صنف ERP رقم 9'), JSON.stringify(columnControl.erpSub));
  check('a review line carries its ERP name, not just its barcode',
        columnControl.erpExists && !!columnControl.loadedName, `name=${columnControl.loadedName}`);
  check('unticking the price columns takes them out of the receipt',
        !columnControl.pricelessCells.some(c => c.includes('سعر') || c.includes('الإجمالي'))
        && columnControl.pricelessCells.some(c => c.includes('الكمية')),
        JSON.stringify(columnControl.pricelessCells));
  check('and out of the report image',
        columnControl.specColumns.join(',') === 'itemName,erpName,qty'
        && columnControl.specRow.erpName === 'صنف ERP رقم 9'
        && columnControl.specRow.total === undefined,
        JSON.stringify({ cols: columnControl.specColumns, row: columnControl.specRow }));

  // ---------- which price column carries the dash ----------
  const spec = await page.evaluate(async () => {
    const { buildReviewReportSpec } = await import('/js/modules/invoice-reviews.js');
    const units = [{ key: 'piece', label: 'قطعة', multiplier: 1 }, { key: 'dozen', label: 'دستة', multiplier: 12 }];
    const items = [
      { id: 'a', itemName: 'بالدستة', erpBarcode: '111', qty: 2, unitKey: 'dozen', price: 930 },
      { id: 'b', itemName: 'بالقطعة', erpBarcode: '222', qty: 5, unitKey: 'piece', price: 210 },
    ];
    return buildReviewReportSpec({ reviewNumber: 'INV-1', supplierId: null, supplierName: 'مورد', createdAt: '2026-08-26' }, items, units, []);
  });
  const bulkCol = spec.columns.find(c => c.key === 'price');
  check('the bulk column is named after the unit in use', bulkCol.label === 'سعر الدستة', bulkCol.label);
  check('a piece line dashes the bulk price, never the piece price',
        spec.rows[1].price === '—' && spec.rows[1].piecePrice === '210.00', JSON.stringify(spec.rows[1]));
  check('a dozen line carries both prices',
        spec.rows[0].price === '930.00' && spec.rows[0].piecePrice === '77.50', JSON.stringify(spec.rows[0]));
  check('the barcode column is in the report by default',
        spec.columns.some(c => c.key === 'barcode') && spec.rows[0].barcode === '111');

  // ---------- dashboard numbers agree with the screens they name ----------
  await goto('/dashboard');
  await page.waitForTimeout(900);
  const dash = await page.evaluate(() => {
    const cards = {};
    document.querySelectorAll('.stat-card').forEach(c => {
      cards[c.querySelector('.stat-label').textContent.trim()] = Number(c.querySelector('.stat-value').textContent.replace(/[^\d]/g, ''));
    });
    const actions = Array.from(document.querySelectorAll('.action-item')).map(a => ({
      label: a.textContent.replace(/\s+/g, ' ').trim(),
      count: a.querySelector('.count') ? Number(a.querySelector('.count').textContent.replace(/[^\d]/g, '')) : null,
      route: a.dataset.route || null,
    }));
    return { cards, actions, html: document.querySelector('#app-content').textContent };
  });

  // "closed" is what the archive button sets, so the card has to say archive.
  check('the archive count is not labelled "completed"',
        !dash.html.includes('مرتجعات مكتملة') && 'مرتجعات مؤرشفة' in dash.cards,
        Object.keys(dash.cards).join(' | '));

  const readTotal = async (route) => {
    await goto(route);
    await page.waitForTimeout(700);
    return page.evaluate(() => Number((document.querySelector('.page-info b')?.textContent || '0').replace(/[^\d]/g, '')));
  };
  const archivedOnList = await readTotal('/returns/archive');
  check('archived card matches the archive screen', dash.cards['مرتجعات مؤرشفة'] === archivedOnList,
        `dashboard=${dash.cards['مرتجعات مؤرشفة']} list=${archivedOnList}`);

  const unregOnList = await readTotal('/returns/unregistered');
  const unregAction = dash.actions.find(a => a.label.includes('لم تُسجل على ERP'));
  check('the ERP action count matches the unregistered screen', unregAction && unregAction.count === unregOnList,
        `dashboard=${unregAction?.count} list=${unregOnList}`);

  // Waiting on replacement goods is real outstanding work and had no home here.
  const replacementAction = dash.actions.find(a => a.label.includes('البدائل'));
  const expectedWaiting = await page.evaluate(async () => {
    const { listReturnsJoined } = await import('/js/modules/returns.js');
    return (await listReturnsJoined()).filter(r => r.status === 'sent' && r.pendingReplacements > 0).length;
  });
  check('pending replacements are surfaced and counted right',
        replacementAction && replacementAction.count === expectedWaiting && expectedWaiting > 0,
        `shown=${replacementAction?.count} expected=${expectedWaiting}`);

  // "Needs action" must only list things that actually need action.
  check('every action row is non-zero and leads somewhere',
        dash.actions.every(a => a.count === null || (a.count > 0 && a.route)),
        JSON.stringify(dash.actions.map(a => [a.count, a.route])));

  // Repeated renders with unchanged data must not churn the DOM.
  await goto('/dashboard');
  await page.waitForTimeout(800);
  const stable = await page.evaluate(async () => {
    const node = document.querySelector('#dash-recent');
    const { renderDashboard } = await import('/js/modules/dashboard.js');
    await renderDashboard(document.querySelector('#app-content'));
    return document.querySelector('#dash-recent') === node;
  });
  check('an unchanged dashboard is not re-rendered', stable);

  // ---------- invoice review: picking a photo, and the quantity default ----------
  await goto('/invoice-reviews/iv3');
  await page.waitForTimeout(700);
  const inputs = await page.evaluate(() => {
    const photo = document.querySelector('#photo-input');
    const qty = document.querySelector('#add-qty');
    return {
      // capture="environment" would send a phone straight to the camera
      // and hide the gallery, so an existing photo could not be picked.
      forcesCamera: photo ? photo.hasAttribute('capture') : null,
      acceptsImages: photo ? photo.getAttribute('accept') : null,
      qtyValue: qty ? qty.value : null,
      qtyPlaceholder: qty ? qty.getAttribute('placeholder') : null,
    };
  });
  check('an invoice photo can come from the device, not just the camera',
        inputs.forcesCamera === false && inputs.acceptsImages === 'image/*', JSON.stringify(inputs));
  check('the quantity starts empty rather than at 1',
        inputs.qtyValue === '' && inputs.qtyPlaceholder === '0', JSON.stringify(inputs));

  // An empty quantity must be refused rather than saved as a zero line.
  const linesBeforeBlankAdd = await page.$$eval('tr[data-line]', rs => rs.length);
  await page.click('#btn-add-line');
  await page.waitForTimeout(600);
  const linesAfterBlankAdd = await page.$$eval('tr[data-line]', rs => rs.length);
  check('adding without a quantity is refused',
        linesAfterBlankAdd === linesBeforeBlankAdd, `${linesBeforeBlankAdd} -> ${linesAfterBlankAdd}`);

  // ---------- an edit made a moment ago must reach the export ----------
  // Editing a quantity deliberately does not re-render the screen, so the
  // array it was drawn with goes stale; exporting has to read the return
  // back. Typing and exporting immediately also races the debounced save.
  await goto('/returns/r4');
  await page.waitForTimeout(700);
  const editedQty = await page.evaluate(() => {
    const input = document.querySelector('.line-qty');
    input.focus();
    input.value = '77';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.dataset.id;
  });
  // No wait at all — click straight away, exactly as a person would.
  await page.click('#btn-export');
  await page.waitForSelector('.modal .export-actions', { timeout: 10000 });
  const exported = await page.evaluate(async (lineId) => {
    const { collectExportLines } = await import('/js/modules/returns.js');
    const db = await import('/js/core/db.js');
    const ret = await db.getById('returns', 'r4');
    const lines = await collectExportLines('r4', ret.supplierId);
    const stored = await db.getById('returnItems', lineId);
    return { exportedQty: lines.find(l => l.id === lineId)?.qty, storedQty: stored.qty };
  }, editedQty);
  check('an edit made a moment before exporting is in the export',
        exported.exportedQty === 77 && exported.storedQty === 77, JSON.stringify(exported));
  await page.click('.modal-close');
  await page.waitForTimeout(300);

  // settle() must not resolve before the value is actually stored.
  const settled = await page.evaluate(async () => {
    const { autosaveField } = await import('/js/core/autosave.js');
    const input = document.createElement('input');
    document.body.appendChild(input);
    let saved = null;
    const saver = autosaveField(input, async (value) => {
      await new Promise(r => setTimeout(r, 120)); // a slow cloud write
      saved = value;
    }, { delay: 500 });
    input.value = 'جديد';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await saver.settle(); // before the 500ms debounce would have fired
    const afterSettle = saved;
    input.remove();
    return { afterSettle };
  });
  check('settle() waits for the value to be stored', settled.afterSettle === 'جديد', JSON.stringify(settled));

  // ---------- status filter on the returns list ----------
  await goto('/returns/active');
  await page.waitForTimeout(700);
  const statusFilter = await page.evaluate(() => {
    const sel = document.querySelector('#ret-status-filter');
    return sel ? { exists: true, value: sel.value, options: Array.from(sel.options).map(o => o.value) } : { exists: false };
  });
  check('the returns list has a status filter set to the current view',
        statusFilter.exists && statusFilter.value === 'active' && statusFilter.options.includes('draft') && statusFilter.options.includes('awaiting-replacements'),
        JSON.stringify(statusFilter.options));

  await page.selectOption('#ret-status-filter', 'draft');
  await page.waitForTimeout(800);
  const afterFilter = await page.evaluate(() => ({
    hash: window.location.hash,
    title: document.querySelector('#topbar-title')?.textContent,
    allDrafts: Array.from(document.querySelectorAll('#app-content tbody tr'))
      .every(tr => tr.textContent.includes('مسودة')),
  }));
  check('choosing a status shows only that status',
        afterFilter.hash === '#/returns/draft' && afterFilter.title === 'مسودة' && afterFilter.allDrafts,
        JSON.stringify(afterFilter));

  // ---------- the drawer, on a phone ----------
  const drawer = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const shell = document.querySelector('#app-shell');
    window.location.hash = '#/items';
    await wait(400);

    document.querySelector('#menu-toggle').click();
    await wait(100);
    const opened = shell.classList.contains('nav-open');

    // The system back button: it must close the drawer, not leave the screen.
    const hashWhileOpen = window.location.hash;
    window.history.back();
    await wait(400);
    const afterBack = { open: shell.classList.contains('nav-open'), hash: window.location.hash };

    // Tapping the screen you are already on must close the drawer.
    document.querySelector('#menu-toggle').click();
    await wait(100);
    document.querySelector('.nav-link[data-nav="items"]').click();
    await wait(400);
    const afterSameLink = { open: shell.classList.contains('nav-open'), hash: window.location.hash };

    return { opened, hashWhileOpen, afterBack, afterSameLink };
  });
  check('the back button closes the drawer instead of leaving the screen',
        drawer.opened && drawer.afterBack.open === false && drawer.afterBack.hash === drawer.hashWhileOpen,
        JSON.stringify(drawer.afterBack));
  check('tapping the screen you are already on closes the drawer',
        drawer.afterSameLink.open === false && drawer.afterSameLink.hash === '#/items',
        JSON.stringify(drawer.afterSameLink));

  // ---------- which date a report carries ----------
  const dates = await page.evaluate(async () => {
    const { buildReturnReportSpec } = await import('/js/modules/return-export.js');
    const keys = ['supplierName', 'qty'];
    const draft = buildReturnReportSpec('', { returnNumber: 'R1', status: 'draft', sentAt: null,
      createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-08-20T10:00:00Z' }, null, [], keys);
    const sent = buildReturnReportSpec('', { returnNumber: 'R2', status: 'sent', sentAt: '2026-08-22T10:00:00Z',
      createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-08-25T10:00:00Z' }, null, [], keys);
    return { draft: draft.dateLabel, sent: sent.dateLabel };
  });
  check('a draft report carries its last-edited date',
        dates.draft.startsWith('آخر تعديل:') && dates.draft.includes('2026') && !dates.draft.includes('01/01'),
        dates.draft);
  check('a sent report carries the send date instead',
        dates.sent.startsWith('تاريخ الإرسال:') && dates.sent.includes('22'), dates.sent);

  // ---------- typing a supplier cost per dozen ----------
  await goto('/suppliers/s1');
  await page.waitForTimeout(1400);
  await page.locator('.btn-cost').first().click();
  await page.waitForSelector('#f-cost-unit', { timeout: 10000 });

  const costStart = await page.evaluate(() => ({
    unit: document.querySelector('#f-cost-unit').value,
    units: Array.from(document.querySelector('#f-cost-unit').options).map(o => o.value),
    value: document.querySelector('#f-cost').value,
  }));
  check('the cost dialog offers the configured units, piece first',
        costStart.unit === 'piece' && costStart.units.includes('dozen'), JSON.stringify(costStart));

  // Switching the unit re-expresses the same cost rather than reinterpreting it.
  await page.selectOption('#f-cost-unit', 'dozen');
  await page.waitForTimeout(250);
  const reExpressed = await page.evaluate(() => ({
    value: document.querySelector('#f-cost').value,
    hint: document.querySelector('#f-cost-preview').textContent,
  }));
  check('switching to dozen re-expresses the same cost',
        Number(reExpressed.value) === Number(costStart.value) * 12, JSON.stringify(reExpressed));

  // Typing a dozen price stores the piece price.
  await page.fill('#f-cost', '930');
  await page.dispatchEvent('#f-cost', 'input');
  await page.waitForTimeout(250);
  const hint = await page.$eval('#f-cost-preview', el => el.textContent);
  check('the dialog says which piece price will be saved', hint.includes('77.50'), hint);

  const savedItemId = await page.evaluate(() => document.querySelector('.btn-cost')?.dataset.id);
  await page.locator('.modal-footer .btn-primary').click();
  await page.waitForTimeout(1200);
  const stored = await page.evaluate(async (id) => {
    const db = await import('/js/core/db.js');
    return (await db.getById('supplierItems', id)).currentCost;
  }, savedItemId);
  check('a dozen price is stored as the piece cost', Math.abs(stored - 77.5) < 0.001, `stored=${stored}`);

  // ---------- the same supplier name, two different ERP items ----------
  const identity = await page.evaluate(async () => {
    const { getOrCreateSupplierItem } = await import('/js/modules/supplier-items.js');
    const db = await import('/js/core/db.js');
    const name = 'بدي تُل مبطن';

    // First time: created and linked.
    const first = await getOrCreateSupplierItem('s3', name, { erpItemId: 'e10' });
    // Same name, same ERP item: the same row, not a copy.
    const again = await getOrCreateSupplierItem('s3', name, { erpItemId: 'e10' });
    // Same name, a different ERP item: a separate row, because the supplier
    // calls one thing what the shop splits across two items.
    const other = await getOrCreateSupplierItem('s3', name, { erpItemId: 'e11' });

    const rows = (await db.getByIndex('supplierItems', 'supplierId', 's3'))
      .filter(r => r.supplierItemName === name);

    // With no link to go on, two matches must be refused rather than guessed.
    let refused = null;
    try { await getOrCreateSupplierItem('s3', name); refused = false; }
    catch (err) { refused = err.message; }

    return { sameRow: first.id === again.id, separateRow: other.id !== first.id, rowCount: rows.length, refused };
  });
  check('the same name with the same ERP item is one row', identity.sameRow);
  check('the same name with a different ERP item is a separate row',
        identity.separateRow && identity.rowCount === 2, JSON.stringify(identity));
  check('an ambiguous name is refused, not guessed at',
        typeof identity.refused === 'string' && identity.refused.includes('اختاره من قائمة'), String(identity.refused).slice(0, 60));

  // A line picked from the suggestions is tied to that exact row.
  const tied = await page.evaluate(async () => {
    const { addItemLine } = await import('/js/modules/returns.js');
    const db = await import('/js/core/db.js');
    const rows = (await db.getByIndex('supplierItems', 'supplierId', 's3'))
      .filter(r => r.supplierItemName === 'بدي تُل مبطن');
    const target = rows.find(r => r.erpItemId === 'e11');
    const line = await addItemLine('r3', 's3', 'بدي تُل مبطن', 1, 5, false, target.id);
    return { usedPicked: line.supplierItemId === target.id, erp: line.erpItemId };
  });
  check('a line uses the supplier item that was picked, not the first name match',
        tied.usedPicked && tied.erp === 'e11', JSON.stringify(tied));

  // ---------- clicking add twice must add one line ----------
  const doubleClicks = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const results = {};

    window.location.hash = '#/invoice-reviews/iv7';
    await wait(900);
    const invBefore = document.querySelectorAll('tr[data-line]').length;
    document.querySelector('#add-item-name').value = 'صنف الضغط المزدوج على الفاتورة';
    document.querySelector('#add-qty').value = '3';
    document.querySelector('#add-price').value = '10';
    const invBtn = document.querySelector('#btn-add-line');
    invBtn.click(); invBtn.click();
    await wait(2500);
    results.invoice = document.querySelectorAll('tr[data-line]').length - invBefore;

    window.location.hash = '#/returns/r10';
    await wait(900);
    const retBefore = document.querySelectorAll('tr[data-line]').length;
    document.querySelector('#add-item-name').value = 'صنف الضغط المزدوج';
    document.querySelector('#add-item-qty').value = '2';
    const retBtn = document.querySelector('#btn-add-item');
    retBtn.click(); retBtn.click();
    await wait(2500);
    results.return = document.querySelectorAll('tr[data-line]').length - retBefore;
    return results;
  });
  check('clicking add twice on an invoice adds one line', doubleClicks.invoice === 1, `added ${doubleClicks.invoice}`);
  check('clicking add twice on a return adds one line', doubleClicks.return === 1, `added ${doubleClicks.return}`);

  // ---------- one name at a supplier is one price ----------
  const sharedCost = await page.evaluate(async () => {
    const { getOrCreateSupplierItem, updateCost } = await import('/js/modules/supplier-items.js');
    const db = await import('/js/core/db.js');
    const name = 'حجاب سوري';
    const white = await getOrCreateSupplierItem('s1', name, { erpItemId: 'e20' });
    const black = await getOrCreateSupplierItem('s1', name, { erpItemId: 'e21' });

    // Change it on one; the other has to follow, because the supplier
    // quotes one price for the name whatever the shop files it under.
    const { updatedCount } = await updateCost(white.id, 40);
    const after = await Promise.all([db.getById('supplierItems', white.id), db.getById('supplierItems', black.id)]);

    // A row added later under the same name starts on that same price.
    const third = await getOrCreateSupplierItem('s1', name, { erpItemId: 'e22' });
    return {
      separate: white.id !== black.id,
      costs: after.map(r => r.currentCost),
      updatedCount,
      newRowCost: third.currentCost,
    };
  });
  check('two ERP links under one supplier name share a price',
        sharedCost.separate && sharedCost.costs.every(c => c === 40) && sharedCost.updatedCount === 2,
        JSON.stringify(sharedCost));
  check('a row added later inherits that price', sharedCost.newRowCost === 40, `cost=${sharedCost.newRowCost}`);

  // ---------- pulling a new supplier cost onto a draft's lines ----------
  const refresh = await page.evaluate(async () => {
    const { pendingCostRefreshes, refreshAllLineCosts, refreshLineCost } = await import('/js/modules/returns.js');
    const db = await import('/js/core/db.js');
    const lines = await db.getByIndex('returnItems', 'returnId', 'r13');
    for (const line of lines) {
      const si = await db.getById('supplierItems', line.supplierItemId);
      await db.put('supplierItems', { ...si, currentCost: 250 });
    }

    const stale = await pendingCostRefreshes('r13');
    // One line first, to prove the per-line button moves only its own row.
    const one = await refreshLineCost(lines[0].id);
    const afterOne = await db.getByIndex('returnItems', 'returnId', 'r13');
    const movedByOne = afterOne.filter(l => Number(l.unitCost) === 250).length;

    const count = await refreshAllLineCosts('r13');
    const after = await db.getByIndex('returnItems', 'returnId', 'r13');
    const nothingLeft = await pendingCostRefreshes('r13');

    return {
      staleCount: stale.length,
      one,
      movedByOne,
      count,
      costs: after.map(l => Number(l.unitCost)),
      totals: after.map(l => Number(l.total) === Number(l.qty) * 250),
      nothingLeft: nothingLeft.length,
    };
  });
  check('refreshing one line moves only that line',
        refresh.one.changed && refresh.movedByOne === 1, JSON.stringify({ one: refresh.one, moved: refresh.movedByOne }));
  check('refreshing all lines pulls every cost from the supplier item',
        refresh.costs.every(c => c === 250) && refresh.totals.every(Boolean) && refresh.count === refresh.staleCount - 1,
        JSON.stringify(refresh));
  check('a return already up to date has nothing to refresh', refresh.nothingLeft === 0);

  // The buttons only exist while the return can still be edited.
  await goto('/returns/r13');
  await page.waitForTimeout(900);
  const draftButtons = await page.evaluate(() => ({
    bulk: !!document.querySelector('#btn-refresh-costs'),
    perLine: document.querySelectorAll('.line-refresh-cost').length,
  }));
  await goto('/returns/r14'); // sent, so locked
  await page.waitForTimeout(900);
  const sentButtons = await page.evaluate(() => ({
    bulk: !!document.querySelector('#btn-refresh-costs'),
    perLine: document.querySelectorAll('.line-refresh-cost').length,
  }));
  check('the refresh buttons are on an editable return and off a sent one',
        draftButtons.bulk && draftButtons.perLine === 3 && !sentButtons.bulk && sentButtons.perLine === 0,
        `draft=${JSON.stringify(draftButtons)} sent=${JSON.stringify(sentButtons)}`);

  // ---------- an invoice review works off the supplier's items ----------
  await goto('/invoice-reviews/iv11');
  await page.waitForTimeout(900);
  await page.click('#add-item-name');
  await page.type('#add-item-name', 'كريب', { delay: 50 });
  await page.waitForTimeout(700);
  const suggestions = await page.evaluate(() => ({
    label: document.querySelector('label[for], .field.autocomplete label')?.textContent.trim(),
    items: Array.from(document.querySelectorAll('#add-item-erp-results .autocomplete-item'))
      .map(el => ({ hasSupplierItem: !!el.dataset.supplierItemId, text: el.textContent.replace(/\s+/g, ' ').trim() })),
  }));
  const addNew = suggestions.items[suggestions.items.length - 1];
  check('the invoice item field suggests the supplier\'s own items',
        suggestions.items.length > 1 && suggestions.items[0].hasSupplierItem && addNew.text.includes('كصنف جديد لهذا المورد'),
        suggestions.items[0]?.text);

  // Picking one fills in that item's piece price.
  await page.locator('#add-item-erp-results .autocomplete-item').first().click();
  await page.waitForTimeout(300);
  const picked = await page.evaluate(() => ({
    name: document.querySelector('#add-item-name').value,
    price: document.querySelector('#add-price').value,
    linked: !!document.querySelector('#add-item-name').dataset.supplierItemId,
  }));
  check('picking a supplier item fills its piece price', picked.linked && Number(picked.price) > 0, JSON.stringify(picked));

  // A name that is new to the supplier is created there, and the price
  // typed on the invoice becomes that item's cost — per piece.
  await page.fill('#add-item-name', 'صنف اتعرف من الفاتورة');
  await page.waitForTimeout(400);
  await page.fill('#add-qty', '2');
  // Unit first, then its price — switching the unit now re-expresses
  // whatever is already in the field rather than reinterpreting it.
  await page.selectOption('#add-unit', 'dozen');
  await page.fill('#add-price', '60');
  await page.click('#btn-add-line');
  await page.waitForTimeout(2500);
  const crossed = await page.evaluate(async () => {
    const db = await import('/js/core/db.js');
    const review = await db.getById('invoiceReviews', 'iv11');
    const items = await db.getByIndex('supplierItems', 'supplierId', review.supplierId);
    const created = items.find(i => i.supplierItemName === 'صنف اتعرف من الفاتورة');
    const lines = await db.getByIndex('invoiceReviewItems', 'reviewId', 'iv11');
    const line = lines.find(l => l.itemName === 'صنف اتعرف من الفاتورة');
    return { created: !!created, cost: created?.currentCost, linked: line?.supplierItemId === created?.id };
  });
  check('a name new to the supplier is added to their items', crossed.created && crossed.linked, JSON.stringify(crossed));
  check('a dozen price on the invoice becomes the piece cost', crossed.cost === 5, `cost=${crossed.cost}`);

  // ---------- the item field has to follow the supplier picked on screen ----------
  // Reported: choosing a supplier left "اسم الصنف عند المورد" dead, so an
  // item could not be added without leaving the review and coming back.
  await goto('/invoice-reviews/ivnew');
  await page.waitForTimeout(900);
  const readState = () => page.evaluate(() => ({
    disabled: document.querySelector('#add-item-name').disabled,
    hinted: document.querySelector('#add-item-supplier-hint')?.style.display !== 'none',
  }));
  const noSupplier = await readState();
  check('a review with no supplier keeps the item field shut',
        noSupplier.disabled && noSupplier.hinted, JSON.stringify(noSupplier));

  await page.selectOption('#f-supplier', 's2');
  await page.waitForTimeout(800);
  const withSupplier = await readState();
  check('picking a supplier opens the item field there and then',
        !withSupplier.disabled && !withSupplier.hinted, JSON.stringify(withSupplier));

  await page.click('#add-item-name');
  await page.type('#add-item-name', 'كريب', { delay: 40 });
  await page.waitForTimeout(700);
  const liveCount = await page.$$eval('#add-item-erp-results .autocomplete-item', els => els.length);
  check('and it searches that supplier without a reload', liveCount > 1, `${liveCount} suggestions`);

  // The same line on the invoice screen, where a wrong pick also decides
  // which ERP item the price is checked against.
  await page.fill('#add-item-name', 'كريب سادة 19');
  await page.waitForTimeout(700);
  await page.locator('#add-item-erp-results .autocomplete-item').first().click();
  await page.waitForTimeout(300);
  const invPickedErp = await page.evaluate(() => {
    const n = document.querySelector('#add-item-erp');
    return { shown: n.style.display !== 'none', text: n.textContent.replace(/\s+/g, ' ').trim() };
  });
  check('picking an item on an invoice names its ERP item',
        invPickedErp.shown && invPickedErp.text.includes('صنف ERP رقم 19'),
        JSON.stringify(invPickedErp));

  // A name the supplier has never had says it will be created instead.
  await page.fill('#add-item-name', 'اسم لسه مش موجود عند المورد');
  await page.waitForTimeout(700);
  await page.locator('#add-item-erp-results .autocomplete-item').last().click();
  await page.waitForTimeout(300);
  const newItemLine = await page.$eval('#add-item-erp', el => el.textContent.replace(/\s+/g, ' ').trim());
  check('a name new to the supplier says it will be created',
        newItemLine.includes('صنف جديد'), newItemLine);

  // ---------- the price follows the unit it is labelled with ----------
  // Reported: picking an item filled a piece price, then switching to دستة
  // left the number alone under a "سعر دستة" label — so adding the line
  // would have stored a twelfth of the real cost.
  await page.fill('#add-item-name', 'كريب سادة 19');
  await page.waitForTimeout(700);
  await page.locator('#add-item-erp-results .autocomplete-item').first().click();
  await page.waitForTimeout(300);
  const piecePrice = await page.$eval('#add-price', el => el.value);
  await page.selectOption('#add-unit', 'dozen');
  await page.waitForTimeout(250);
  const dozen = await page.evaluate(() => ({
    price: document.querySelector('#add-price').value,
    label: document.querySelector('#add-price-label').textContent.trim(),
  }));
  check('switching the unit re-expresses the price',
        Number(piecePrice) > 0 && Number(dozen.price) === Number(piecePrice) * 12 && dozen.label.includes('دستة'),
        `${piecePrice} -> ${JSON.stringify(dozen)}`);

  await page.selectOption('#add-unit', 'piece');
  await page.waitForTimeout(250);
  const backToPiece = await page.$eval('#add-price', el => el.value);
  check('and switching back lands on the same figure',
        Number(backToPiece) === Number(piecePrice), `${piecePrice} -> ${dozen.price} -> ${backToPiece}`);

  // ---------- deleting a line asks first ----------
  // Reported: an item added to a review turned up deleted. The delete
  // button sits beside the price on a cramped phone row and took the line
  // away on a single tap, with nothing to undo it.
  await goto('/invoice-reviews/iv1');
  await page.waitForTimeout(900);
  const linesBefore = await page.$$eval('.ln-remove', els => els.length);
  await page.locator('.ln-remove').first().click();
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    return modal ? modal.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  check('deleting an invoice line asks before it goes', asked.includes('هيتشال'), asked.slice(0, 60));

  await page.locator('.modal-footer .btn-ghost').first().click(); // إلغاء
  await page.waitForTimeout(400);
  const afterCancel = await page.$$eval('.ln-remove', els => els.length);
  check('saying no keeps the line', afterCancel === linesBefore, `${linesBefore} -> ${afterCancel}`);

  await page.locator('.ln-remove').first().click();
  await page.waitForTimeout(400);
  await page.locator('.modal-footer .btn-danger').first().click();
  await page.waitForTimeout(900);
  const afterConfirm = await page.$$eval('.ln-remove', els => els.length);
  check('saying yes removes it', afterConfirm === linesBefore - 1, `${linesBefore} -> ${afterConfirm}`);

  // The return screen deleted a line on one tap too.
  await goto('/returns/r1');
  await page.waitForTimeout(1200);
  const retLinesBefore = await page.$$eval('.line-remove', els => els.length);
  await page.locator('.line-remove').first().click();
  await page.waitForTimeout(400);
  const retAsked = await page.evaluate(() => {
    const modal = document.querySelector('.modal');
    return modal ? modal.textContent.replace(/\s+/g, ' ').trim() : '';
  });
  await page.locator('.modal-footer .btn-ghost').first().click();
  await page.waitForTimeout(600);
  const retAfterCancel = await page.$$eval('.line-remove', els => els.length);
  check('a return line asks too, and survives a no',
        retAsked.includes('هيتشال') && retAfterCancel === retLinesBefore,
        `${retAsked.slice(0, 40)} | ${retLinesBefore} -> ${retAfterCancel}`);

  // ---------- a line's own unit and price, on the table rows ----------
  await goto('/invoice-reviews/ivunit');
  await page.waitForTimeout(900);
  const costOf = () => page.evaluate(async () => {
    const db = await import('/js/core/db.js');
    return (await db.getById('supplierItems', 'siunit')).currentCost;
  });

  // A price is saved as you type, but pushing it out as the supplier's
  // cost waits for the field to be done with — a pause halfway through a
  // number used to file the half of it that had been typed.
  await page.locator('.ln-price').first().fill('');
  await page.click('.ln-price');
  await page.keyboard.type('11', { delay: 60 });
  await page.waitForTimeout(1000); // well past the 500ms autosave debounce
  const midTyping = await costOf();
  const savedPrice = await page.$eval('.ln-price', el => el.value);
  check('a half-typed price is saved without reaching the supplier cost',
        midTyping === 38 && savedPrice === '11', `cost=${midTyping} price=${savedPrice}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(900);
  const afterBlur = await costOf();
  check('and reaches it once the field is finished with', afterBlur === 11, `cost=${afterBlur}`);

  // Switching a row's unit re-expresses its price, so the cost it stands
  // for does not move. It used to keep the number and push a twelfth of
  // the real cost out to the supplier.
  const headBefore = await page.$eval('#bulk-price-head', el => el.textContent.trim());
  await page.selectOption('.ln-unit', 'dozen');
  await page.waitForTimeout(900);
  const afterUnit = await page.evaluate(() => ({
    price: document.querySelector('.ln-price').value,
    piece: document.querySelector('[id^="ln-piece-"]').textContent.trim(),
    head: document.querySelector('#bulk-price-head').textContent.trim(),
  }));
  const costAfterUnit = await costOf();
  check('switching a line to dozen re-expresses its price',
        Number(afterUnit.price) === 132 && costAfterUnit === 11,
        `${JSON.stringify(afterUnit)} cost=${costAfterUnit}`);
  check('and the bulk price column is renamed after the unit in use',
        headBefore === 'سعر الوحدة' && afterUnit.head === 'سعر الدستة',
        `${headBefore} -> ${afterUnit.head}`);

  // A unit a line is filed under cannot be deleted out from under it: an
  // unknown unit key falls back to the first unit, which would silently
  // turn "2 دستة" into "2 قطعة" and change that invoice's total.
  await page.click('#btn-manage-units');
  await page.waitForSelector('#units-table', { timeout: 10000 });
  const unitRowsBefore = await page.$$eval('#units-table tbody tr', els => els.length);
  // Toasts linger for 2.6s and this step follows one, so clear them first
  // and read them all — otherwise the assertion can pick up the previous
  // step's message instead of this one's.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  await page.locator('#units-table tbody tr[data-key="dozen"] .btn-del-unit').click();
  await page.waitForTimeout(700);
  const unitGuard = await page.evaluate(() => ({
    rows: document.querySelectorAll('#units-table tbody tr').length,
    toast: Array.from(document.querySelectorAll('.toast')).map(t => t.textContent.trim()).join(' | '),
  }));
  check('a unit that invoice lines are using cannot be deleted',
        unitGuard.rows === unitRowsBefore && unitGuard.toast.includes('مستخدمة'),
        `${unitRowsBefore} -> ${unitGuard.rows} | ${unitGuard.toast}`);
  await page.click('.modal-footer .btn-primary');
  await page.waitForTimeout(700);

  // The exported report is dated by what happened last, the same rule the
  // return report follows — it used to always carry the creation date.
  const reviewDates = await page.evaluate(async () => {
    const { buildReviewReportSpec } = await import('/js/modules/invoice-reviews.js');
    const units = [{ key: 'piece', label: 'قطعة', multiplier: 1 }];
    const base = {
      reviewNumber: 'INV-2026-09999', supplierId: null, supplierName: 'مورد',
      createdAt: '2026-01-01T08:00:00.000Z', updatedAt: '2026-08-05T08:00:00.000Z',
    };
    return {
      edited: buildReviewReportSpec({ ...base }, [], units, []).dateLabel,
      editedLater: buildReviewReportSpec({ ...base, updatedAt: '2026-03-03T08:00:00.000Z' }, [], units, []).dateLabel,
      onErp: buildReviewReportSpec({ ...base, erpEntered: true, erpEnteredAt: '2026-08-09T08:00:00.000Z' }, [], units, []).dateLabel,
    };
  });
  check('the review report is dated by what happened last',
        reviewDates.edited.startsWith('آخر تعديل')
        && reviewDates.edited !== reviewDates.editedLater
        && reviewDates.onErp.startsWith('تاريخ الإدخال على ERP'),
        JSON.stringify(reviewDates));

  // A line with no name exports as a dash and is not a supplier item.
  // The invoice add card works out its total the way the table does:
  // quantity times the price of whichever unit is selected.
  await page.fill('#add-qty', '2');
  await page.fill('#add-price', '38');
  await page.waitForTimeout(200);
  const invAddTotal = await page.$eval('#add-total', el => el.textContent.trim());
  check('the invoice add card works out the line total too', invAddTotal === '76.00', invAddTotal);
  await page.fill('#add-qty', '');
  await page.fill('#add-price', '');

  const rowsBeforeAdd = await page.$$eval('tr[data-line]', els => els.length);
  await page.fill('#add-qty', '3');
  await page.click('#btn-add-line');
  await page.waitForTimeout(900);
  const rowsAfterAdd = await page.$$eval('tr[data-line]', els => els.length);
  check('adding without an item name is refused', rowsAfterAdd === rowsBeforeAdd,
        `${rowsBeforeAdd} -> ${rowsAfterAdd}`);

  // ---------- adding a second ERP link under one supplier name ----------
  await goto('/suppliers/s2');
  await page.waitForTimeout(1400);
  await page.click('#btn-add-mapping');
  await page.waitForSelector('#f-name', { timeout: 10000 });

  const beforePick = await page.$eval('#mapping-mode', el => el.style.display);
  await page.type('#f-name', 'كريب سادة 19', { delay: 40 });
  await page.waitForTimeout(700);
  await page.locator('#name-results .autocomplete-item').first().click();
  await page.waitForTimeout(400);
  const editMode = await page.evaluate(() => ({
    shown: document.querySelector('#mapping-mode').style.display !== 'none',
    text: document.querySelector('#mapping-mode').textContent.replace(/\s+/g, ' ').trim(),
    hasButton: !!document.querySelector('#btn-mode-add-link'),
    cost: document.querySelector('#f-cost').value,
  }));
  check('picking an existing item says so, and offers the second link',
        beforePick === 'none' && editMode.shown && editMode.hasButton && editMode.text.includes('بتعدّل على صنف موجود'),
        editMode.text.slice(0, 60));

  await page.click('#btn-mode-add-link');
  await page.waitForTimeout(400);
  const addMode = await page.evaluate(() => ({
    text: document.querySelector('#mapping-mode').textContent.replace(/\s+/g, ' ').trim(),
    erpValue: document.querySelector('#f-erp-search').value,
    erpPicked: document.querySelector('#f-erp-search').dataset.selectedId || '',
    name: document.querySelector('#f-name').value,
    cost: document.querySelector('#f-cost').value,
  }));
  check('the second-link button keeps the name and cost and clears the ERP pick',
        addMode.text.includes('ربط ERP تاني') && addMode.erpValue === '' && addMode.erpPicked === ''
        && addMode.name === 'كريب سادة 19' && addMode.cost === editMode.cost,
        JSON.stringify(addMode));

  // Saving without choosing the new ERP item must be refused, not guessed.
  const rowsBefore = await page.evaluate(async () => {
    const db = await import('/js/core/db.js');
    return (await db.getByIndex('supplierItems', 'supplierId', 's2')).filter(r => r.supplierItemName === 'كريب سادة 19').length;
  });
  await page.locator('.modal-footer .btn-primary').click();
  await page.waitForTimeout(1200);
  const stillOpen = await page.$('#f-erp-search') !== null;
  check('adding a second link without an ERP item is refused', stillOpen);

  await page.type('#f-erp-search', 'صنف ERP رقم 44', { delay: 30 });
  await page.waitForTimeout(700);
  await page.locator('#erp-results .autocomplete-item').first().click();
  await page.waitForTimeout(300);
  await page.locator('.modal-footer .btn-primary').click();
  await page.waitForTimeout(2500);
  const secondLink = await page.evaluate(async () => {
    const db = await import('/js/core/db.js');
    const rows = (await db.getByIndex('supplierItems', 'supplierId', 's2')).filter(r => r.supplierItemName === 'كريب سادة 19');
    return { count: rows.length, links: rows.map(r => r.erpItemId), costs: rows.map(r => r.currentCost) };
  });
  check('a second row is created under the same name with its own link',
        secondLink.count === rowsBefore + 1 && new Set(secondLink.links).size === secondLink.count,
        JSON.stringify(secondLink));
  check('the second row carries the shared cost',
        new Set(secondLink.costs).size === 1, JSON.stringify(secondLink.costs));

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
