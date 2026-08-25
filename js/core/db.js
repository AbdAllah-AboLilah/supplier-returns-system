// =========================================================
// core/db.js
// Cloud data layer (Firestore) — this is the ONLY module that
// talks to Firestore directly. Every other module still calls
// getAll/getById/put/... exactly as before; this file is the
// single place that changed to move the app from local-only
// IndexedDB to shared cloud storage. Offline support comes from
// Firestore's own persistent local cache (see firebase-init.js),
// which is why nothing else in the app needed to change.
// =========================================================
import { db, authReady } from './firebase-init.js';
import { beginSyncOperation, endSyncOperation } from './sync-status.js';
import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  query, where, writeBatch, runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

// IndexedDB let every store declare its own keyPath; Firestore
// documents just need a plain id string, so this is the one place
// that has to know which field plays that role per collection.
const KEY_FIELD = {
  suppliers: 'id', erpItems: 'id', supplierItems: 'id', costHistory: 'id',
  returns: 'id', returnItems: 'id', auditLog: 'id',
  counters: 'name', settings: 'key',
};
const BATCH_SIZE = 400; // Firestore batches cap at 500 writes; stay comfortably under it.

// ---------- Short-lived read cache ----------
// Every screen builds itself from whole-collection reads, and each one
// of those is a network round trip: typing a single letter into the
// item search used to re-download the entire ERP catalog, and opening a
// supplier page pulled returns + suppliers + returnItems several times
// over. Collection reads are cached for a few seconds and dropped the
// moment anything writes to that collection, so a local edit is always
// visible immediately and another device's change shows up within the
// window. Rows are handed out as copies — callers sort and mutate what
// they get back, and that must never reach into the cache.

const CACHE_TTL_MS = 15000;
const readCache = new Map(); // cacheKey -> { at, rows }

function cacheGet(key) {
  const hit = readCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { readCache.delete(key); return null; }
  return hit.rows.map(r => ({ ...r }));
}

function cacheSet(key, rows) {
  readCache.set(key, { at: Date.now(), rows });
  return rows.map(r => ({ ...r }));
}

// Any write to a collection drops every cached read of it (the whole
// collection and every index query over it).
export function invalidateCache(storeName) {
  if (!storeName) { readCache.clear(); return; }
  const prefix = `${storeName}::`;
  for (const key of readCache.keys()) {
    if (key === storeName || key.startsWith(prefix)) readCache.delete(key);
  }
}

async function ready() {
  try {
    await authReady;
  } catch (err) {
    throw new Error('تعذّر الاتصال بقاعدة البيانات السحابية — تحقق من الإنترنت وحاول تاني.');
  }
  return db;
}

async function withSync(fn) {
  beginSyncOperation();
  try { return await fn(); }
  finally { endSyncOperation(); }
}

// ---------- Generic collection operations ----------

export async function getAll(storeName) {
  await ready();
  const cached = cacheGet(storeName);
  if (cached) return cached;
  const snap = await getDocs(collection(db, storeName));
  return cacheSet(storeName, snap.docs.map(d => d.data()));
}

export async function getByIndex(storeName, indexName, value) {
  await ready();
  const key = `${storeName}::${indexName}::${value}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const q = query(collection(db, storeName), where(indexName, '==', value));
  const snap = await getDocs(q);
  return cacheSet(key, snap.docs.map(d => d.data()));
}

export async function getById(storeName, id) {
  await ready();
  if (id === undefined || id === null || id === '') return null;
  const snap = await getDoc(doc(db, storeName, String(id)));
  return snap.exists() ? snap.data() : null;
}

export function put(storeName, value) {
  return withSync(async () => {
    await ready();
    const key = value[KEY_FIELD[storeName] || 'id'];
    await setDoc(doc(db, storeName, String(key)), value);
    invalidateCache(storeName);
    return value;
  });
}

export function bulkPut(storeName, values) {
  return withSync(async () => {
    await ready();
    const keyField = KEY_FIELD[storeName] || 'id';
    for (let i = 0; i < values.length; i += BATCH_SIZE) {
      const chunk = values.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      chunk.forEach(v => batch.set(doc(db, storeName, String(v[keyField])), v));
      await batch.commit();
    }
    invalidateCache(storeName);
    return values;
  });
}

export function remove(storeName, id) {
  return withSync(async () => {
    await ready();
    await deleteDoc(doc(db, storeName, String(id)));
    invalidateCache(storeName);
    return true;
  });
}

export function removeWhere(storeName, indexName, value) {
  return withSync(async () => {
    await ready();
    const q = query(collection(db, storeName), where(indexName, '==', value));
    const snap = await getDocs(q);
    for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    invalidateCache(storeName);
    return true;
  });
}

export function clearStore(storeName) {
  return withSync(async () => {
    await ready();
    const snap = await getDocs(collection(db, storeName));
    for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    invalidateCache(storeName);
    return true;
  });
}

// ---------- Sequential document numbers (e.g. RET-2026-00001) ----------
// Uses a Firestore transaction so two devices creating a return at
// the same moment can never collide on the same number. Note: unlike
// everything else in this file, a transaction needs a live network
// round-trip — generating a *new* return number will fail while
// fully offline (existing returns still open/edit/print fine offline).

export function nextSequence(counterName) {
  return withSync(async () => {
    await ready();
    return runTransaction(db, async (tx) => {
      const ref = doc(db, 'counters', counterName);
      const snap = await tx.get(ref);
      const current = snap.exists() ? snap.data().value : 0;
      const next = current + 1;
      tx.set(ref, { name: counterName, value: next });
      invalidateCache('counters');
      return next;
    });
  });
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

// ---------- Full backup / restore (all collections, one JSON file) ----------

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
