// =========================================================
// tests/fixtures/fake-db.js
//
// A drop-in replacement for js/core/db.js, backed by a plain
// in-memory store instead of Firestore. The test harness serves
// this file in place of the real one, so the suite exercises every
// screen without touching the live database — and without needing
// network, credentials, or a Firebase emulator.
//
// It exposes exactly the surface core/db.js exposes; if a new
// function is added there, add it here too or the suite will fail
// loudly on the missing import.
//
// Writes are counted on window.__writes so tests can assert on how
// much a screen actually saves (e.g. that tabbing through untouched
// fields saves nothing at all).
// =========================================================
const stores = {};
function store(n) { return (stores[n] = stores[n] || new Map()); }
const KEY_FIELD = { counters: 'name', settings: 'key' };
const keyOf = (n, v) => String(v[KEY_FIELD[n] || 'id']);
const clone = (v) => JSON.parse(JSON.stringify(v));

window.__writes = 0;
window.__resetCounters = () => { window.__writes = 0; };
function countWrites(n) { window.__writes += n; }

export function invalidateCache() { /* no cache in the fixture */ }

export async function getAll(storeName) { return [...store(storeName).values()].map(clone); }
export async function getByIndex(storeName, indexName, value) {
  return [...store(storeName).values()].filter(r => r[indexName] === value).map(clone);
}
export async function getById(storeName, id) {
  if (id === undefined || id === null || id === '') return null;
  const row = store(storeName).get(String(id));
  return row ? clone(row) : null;
}
export async function put(storeName, value) {
  countWrites(1);
  store(storeName).set(keyOf(storeName, value), clone(value));
  return value;
}
export async function bulkPut(storeName, values) {
  countWrites(values.length);
  values.forEach(v => store(storeName).set(keyOf(storeName, v), clone(v)));
  return values;
}
export async function remove(storeName, id) {
  countWrites(1);
  store(storeName).delete(String(id));
  return true;
}
export async function removeWhere(storeName, indexName, value) {
  [...store(storeName).entries()].forEach(([k, r]) => {
    if (r[indexName] === value) { countWrites(1); store(storeName).delete(k); }
  });
  return true;
}
export async function clearStore(storeName) { store(storeName).clear(); return true; }

export async function nextSequence(counterName) {
  const current = store('counters').get(counterName);
  const next = (current ? current.value : 0) + 1;
  store('counters').set(counterName, { name: counterName, value: next });
  return next;
}
export async function generateReturnNumber() {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`RET-${year}`);
  return `RET-${year}-${String(seq).padStart(5, '0')}`;
}

export async function getSetting(key, fallback = null) {
  const row = await getById('settings', key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) { return put('settings', { key, value }); }

export const ALL_STORES = ['suppliers', 'erpItems', 'supplierItems', 'costHistory', 'returns', 'returnItems', 'auditLog', 'counters', 'settings', 'invoiceReviews', 'invoiceReviewItems'];

export async function exportAllData() {
  const data = {};
  for (const name of ALL_STORES) data[name] = await getAll(name);
  return data;
}
export async function importAllData(data) {
  for (const name of ALL_STORES) {
    if (!Array.isArray(data[name])) continue;
    await clearStore(name);
    if (data[name].length) await bulkPut(name, data[name]);
  }
}

// ---------- Seed ----------
// Sized to be realistic rather than minimal: enough returns to force
// pagination, enough ERP items that an unbatched per-row lookup would
// show up, and one deliberately large return.

const iso = (d) => new Date(d).toISOString();
const SUPPLIERS = ['مورد الأمل', 'مورد النور', 'مورد السلام'];

SUPPLIERS.forEach((name, i) => {
  const id = 's' + (i + 1);
  store('suppliers').set(id, { id, name, contact: '0100000000', notes: '', createdAt: iso('2026-01-01'), updatedAt: iso('2026-01-01') });
});

for (let i = 1; i <= 120; i++) {
  store('erpItems').set('e' + i, {
    id: 'e' + i, name: `صنف ERP رقم ${i}`, barcode: '62' + String(i).padStart(6, '0'),
    baseCost: i * 1.5, category: i % 2 ? 'أقمشة' : 'خردوات',
    createdAt: iso('2026-01-01'), updatedAt: iso('2026-01-01'),
  });
}

for (let i = 1; i <= 60; i++) {
  store('supplierItems').set('si' + i, {
    id: 'si' + i, supplierId: 's' + ((i % 3) + 1), supplierItemName: `كريب سادة ${i}`,
    erpItemId: i % 4 ? ('e' + i) : null, currentCost: i % 5 ? i * 2 : 0,
    createdAt: iso('2026-01-01'), updatedAt: iso('2026-01-01'),
  });
}

for (let i = 1; i <= 70; i++) {
  const id = 'r' + i;
  const supplierId = 's' + ((i % 3) + 1);
  // i % 3 === 1 -> draft (editable), 2 -> sent (locked), 0 -> closed
  const status = i % 3 === 1 ? 'draft' : i % 3 === 2 ? 'sent' : 'closed';
  store('returns').set(id, {
    id, returnNumber: `RET-2026-${String(i).padStart(5, '0')}`, supplierId,
    status, locked: status !== 'draft', editingUnlocked: status === 'sent' && i % 11 === 0,
    notes: '', createdAt: iso(`2026-0${(i % 8) + 1}-15`), updatedAt: iso('2026-08-01'),
    sentAt: status === 'draft' ? null : iso('2026-07-01'), lastPostSendEditAt: null,
    erpRegistered: i % 4 === 0, erpRegisteredAt: null, erpTransactionNumber: '',
  });
  const ownItems = [...store('supplierItems').values()].filter(si => si.supplierId === supplierId);
  for (let j = 1; j <= 3; j++) {
    const lineId = `${id}-l${j}`;
    const own = ownItems[(i + j) % ownItems.length];
    const siIndex = Number(own.id.slice(2));
    store('returnItems').set(lineId, {
      id: lineId, returnId: id, supplierItemId: own.id, supplierItemName: own.supplierItemName,
      erpItemId: 'e' + siIndex, erpItemName: `صنف ERP رقم ${siIndex}`,
      qty: j * 2, unitCost: j * 10, total: j * 2 * j * 10, costIsFallback: j === 3,
      resolutionType: j === 2 ? 'exchange' : 'credit', replacementReceived: false, replacementReceivedAt: null,
      createdAt: iso(`2026-07-0${j}`),
    });
  }
}
store('counters').set('RET-2026', { name: 'RET-2026', value: 70 });

// A realistically large draft: 25 lines, ERP links already correct, so
// opening it is pure read cost with nothing to write back.
store('returns').set('rbig', {
  id: 'rbig', returnNumber: 'RET-2026-00099', supplierId: 's1', status: 'draft',
  locked: false, editingUnlocked: false, notes: '', createdAt: iso('2026-08-01'), updatedAt: iso('2026-08-01'),
  sentAt: null, lastPostSendEditAt: null, erpRegistered: false, erpRegisteredAt: null, erpTransactionNumber: '',
});
const bigSupplierItems = [...store('supplierItems').values()].filter(si => si.supplierId === 's1');
for (let j = 1; j <= 25; j++) {
  const si = bigSupplierItems[j % bigSupplierItems.length];
  store('returnItems').set('rbig-l' + j, {
    id: 'rbig-l' + j, returnId: 'rbig', supplierItemId: si.id, supplierItemName: si.supplierItemName,
    erpItemId: si.erpItemId, erpItemName: si.erpItemId ? `صنف ERP رقم ${si.erpItemId.slice(1)}` : null,
    qty: j, unitCost: j * 3, total: j * j * 3, costIsFallback: false,
    resolutionType: 'credit', replacementReceived: false, replacementReceivedAt: null,
    createdAt: iso(`2026-08-${String((j % 28) + 1).padStart(2, '0')}`),
  });
}

for (let i = 1; i <= 40; i++) {
  store('auditLog').set('a' + i, {
    id: 'a' + i, timestamp: iso(`2026-08-0${(i % 9) + 1}`), user: 'المستخدم',
    action: 'إنشاء مرتجعة', entityType: 'return', entityId: 'r1', details: 'تفاصيل ' + i,
  });
}

for (let i = 1; i <= 30; i++) {
  const id = 'iv' + i;
  store('invoiceReviews').set(id, {
    id, reviewNumber: `INV-2026-${String(i).padStart(5, '0')}`, supplierId: 's1', supplierName: 'مورد الأمل',
    invoiceNumber: 'F' + i, erpEntered: i % 2 === 0, erpEnteredAt: null, photo: null,
    createdAt: iso('2026-08-01'), updatedAt: iso('2026-08-01'),
  });
  store('invoiceReviewItems').set(id + '-1', {
    id: id + '-1', reviewId: id, itemName: 'صنف ' + i, erpItemId: 'e1',
    qty: 2, unitKey: 'dozen', price: 50, createdAt: iso('2026-08-01'),
  });
}
// A supplier item of its own, added after the returns seed so no return
// line points at it: the unit/price tests move its cost around and must
// not disturb what the other suites assert.
store('supplierItems').set('siunit', {
  id: 'siunit', supplierId: 's2', supplierItemName: 'صنف اختبار الوحدة',
  erpItemId: 'e22', currentCost: 38,
  createdAt: iso('2026-01-01'), updatedAt: iso('2026-01-01'),
});
store('invoiceReviews').set('ivunit', {
  id: 'ivunit', reviewNumber: 'INV-2026-00032', supplierId: 's2', supplierName: 'مورد النور',
  invoiceNumber: 'F32', erpEntered: false, erpEnteredAt: null, photo: null,
  createdAt: iso('2026-08-02'), updatedAt: iso('2026-08-02'),
});
store('invoiceReviewItems').set('ivunit-1', {
  id: 'ivunit-1', reviewId: 'ivunit', itemName: 'صنف اختبار الوحدة', erpItemId: 'e22',
  supplierItemId: 'siunit', qty: 2, unitKey: 'piece', price: 38, createdAt: iso('2026-08-02'),
});

// A review as it exists the moment it is created: no supplier yet. This is
// the state in which the item field is drawn disabled, so it is the one
// that proves the field comes alive once a supplier is picked.
store('invoiceReviews').set('ivnew', {
  id: 'ivnew', reviewNumber: 'INV-2026-00031', supplierId: null, supplierName: '',
  invoiceNumber: '', erpEntered: false, erpEnteredAt: null, photo: null,
  createdAt: iso('2026-08-02'), updatedAt: iso('2026-08-02'),
});
store('counters').set('INV-2026', { name: 'INV-2026', value: 30 });
