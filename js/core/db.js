// =========================================================
// core/db.js
// IndexedDB data layer for the Supplier Returns system.
//
// This is the ONLY module that talks to IndexedDB directly.
// Every other module goes through the functions exported here.
// That boundary is what makes swapping/augmenting this with
// Firebase later a matter of rewriting this one file's guts,
// not touching the UI modules.
// =========================================================

const DB_NAME = 'ReturnsSystemDB';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('suppliers')) {
        const s = db.createObjectStore('suppliers', { keyPath: 'id' });
        s.createIndex('name', 'name', { unique: false });
      }

      if (!db.objectStoreNames.contains('erpItems')) {
        const s = db.createObjectStore('erpItems', { keyPath: 'id' });
        s.createIndex('name', 'name', { unique: false });
        s.createIndex('barcode', 'barcode', { unique: false });
      }

      if (!db.objectStoreNames.contains('supplierItems')) {
        // The "mapping" entity: a supplier's own name for an item,
        // linked (optionally) to an ERP item, with its own current cost.
        const s = db.createObjectStore('supplierItems', { keyPath: 'id' });
        s.createIndex('supplierId', 'supplierId', { unique: false });
        s.createIndex('erpItemId', 'erpItemId', { unique: false });
        s.createIndex('supplierItemName', 'supplierItemName', { unique: false });
      }

      if (!db.objectStoreNames.contains('costHistory')) {
        const s = db.createObjectStore('costHistory', { keyPath: 'id' });
        s.createIndex('supplierItemId', 'supplierItemId', { unique: false });
      }

      if (!db.objectStoreNames.contains('returns')) {
        const s = db.createObjectStore('returns', { keyPath: 'id' });
        s.createIndex('supplierId', 'supplierId', { unique: false });
        s.createIndex('status', 'status', { unique: false });
        s.createIndex('returnNumber', 'returnNumber', { unique: true });
      }

      if (!db.objectStoreNames.contains('returnItems')) {
        const s = db.createObjectStore('returnItems', { keyPath: 'id' });
        s.createIndex('returnId', 'returnId', { unique: false });
      }

      if (!db.objectStoreNames.contains('auditLog')) {
        const s = db.createObjectStore('auditLog', { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains('counters')) {
        db.createObjectStore('counters', { keyPath: 'name' });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Generic promise-wrapped store operations ----------

function tx(storeNames, mode) {
  return openDb().then(db => db.transaction(storeNames, mode));
}

export function getAll(storeName) {
  return tx(storeName, 'readonly').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function getByIndex(storeName, indexName, value) {
  return tx(storeName, 'readonly').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function getById(storeName, id) {
  return tx(storeName, 'readonly').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

export function put(storeName, value) {
  return tx(storeName, 'readwrite').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  }));
}

export function bulkPut(storeName, values) {
  return tx(storeName, 'readwrite').then(t => new Promise((resolve, reject) => {
    const store = t.objectStore(storeName);
    values.forEach(v => store.put(v));
    t.oncomplete = () => resolve(values);
    t.onerror = () => reject(t.error);
  }));
}

export function remove(storeName, id) {
  return tx(storeName, 'readwrite').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }));
}

export function removeWhere(storeName, indexName, value) {
  return tx(storeName, 'readwrite').then(t => new Promise((resolve, reject) => {
    const store = t.objectStore(storeName);
    const idx = store.index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(value));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { store.delete(cur.primaryKey); cur.continue(); }
    };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  }));
}

// ---------- Sequential document numbers (e.g. RET-2026-00001) ----------

export function nextSequence(counterName) {
  return tx('counters', 'readwrite').then(t => new Promise((resolve, reject) => {
    const store = t.objectStore('counters');
    const req = store.get(counterName);
    req.onsuccess = () => {
      const current = req.result ? req.result.value : 0;
      const next = current + 1;
      store.put({ name: counterName, value: next });
      resolve(next);
    };
    req.onerror = () => reject(req.error);
  }));
}

export async function generateReturnNumber() {
  const year = new Date().getFullYear();
  const counterName = `RET-${year}`;
  const seq = await nextSequence(counterName);
  return `RET-${year}-${String(seq).padStart(5, '0')}`;
}

// ---------- Settings ----------

export async function getSetting(key, fallback = null) {
  const row = await getById('settings', key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  return put('settings', { key, value });
}

// ---------- Full backup / restore (all stores, one JSON file) ----------

export const ALL_STORES = ['suppliers', 'erpItems', 'supplierItems', 'costHistory', 'returns', 'returnItems', 'auditLog', 'counters', 'settings'];

export function clearStore(storeName) {
  return tx(storeName, 'readwrite').then(t => new Promise((resolve, reject) => {
    const req = t.objectStore(storeName).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }));
}

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
