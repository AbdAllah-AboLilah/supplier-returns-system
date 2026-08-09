// =========================================================
// core/migrate-to-firebase.js
//
// This device may still have data sitting in the *old* local
// IndexedDB database from before cloud sync existed. This runs
// once (guarded by a localStorage flag) and, if Firestore is
// still empty, copies that local data up — nothing is deleted,
// nothing is overwritten. If Firestore already has data (this
// device already migrated, or another device seeded it first),
// this does nothing and just marks itself done.
// =========================================================
import { getAll as fsGetAll, bulkPut as fsBulkPut, ALL_STORES } from './db.js';

const OLD_DB_NAME = 'ReturnsSystemDB';
const FLAG_KEY = 'returns-system:migrated-to-firebase';

function openOldDb() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    let found = true;
    const req = indexedDB.open(OLD_DB_NAME);
    req.onupgradeneeded = () => {
      // A fresh database with no prior version means there was
      // never any old data here — don't create one, just bail out.
      found = false;
    };
    req.onsuccess = () => {
      if (!found) { req.result.close(); indexedDB.deleteDatabase(OLD_DB_NAME); resolve(null); return; }
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
}

function getAllFromOldStore(idb, storeName) {
  return new Promise((resolve) => {
    if (!idb.objectStoreNames.contains(storeName)) { resolve([]); return; }
    const tx = idb.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function migrateLocalDataToFirebaseIfNeeded() {
  if (localStorage.getItem(FLAG_KEY) === 'done') return { migrated: false, reason: 'already-done' };

  const idb = await openOldDb();
  if (!idb) {
    localStorage.setItem(FLAG_KEY, 'done');
    return { migrated: false, reason: 'no-old-data' };
  }

  // Never overwrite cloud data that's already there — could belong
  // to another device, or be the result of a migration that already ran.
  const [existingSuppliers, existingItems] = await Promise.all([fsGetAll('suppliers'), fsGetAll('erpItems')]);
  if (existingSuppliers.length || existingItems.length) {
    idb.close();
    localStorage.setItem(FLAG_KEY, 'done');
    return { migrated: false, reason: 'cloud-not-empty' };
  }

  let totalRows = 0;
  for (const storeName of ALL_STORES) {
    const rows = await getAllFromOldStore(idb, storeName);
    if (rows.length) {
      await fsBulkPut(storeName, rows);
      totalRows += rows.length;
    }
  }
  idb.close();
  localStorage.setItem(FLAG_KEY, 'done');
  return { migrated: true, totalRows };
}
