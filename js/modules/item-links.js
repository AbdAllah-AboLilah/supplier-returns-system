// =========================================================
// modules/item-links.js
//
// Two lookups that inherently cross between the erpItems and
// supplierItems collections:
//   - findErpItems():            search ERP items (used by the
//                                 "link to ERP" picker in supplier-items.js)
//   - listErpSupplierRelations(): for one ERP item, every supplier
//                                 mapped to it (used by the "which
//                                 suppliers carry this" view in items.js)
//
// These used to live inside items.js and supplier-items.js
// respectively, with each module importing the other's — a real
// circular import. It happened to work (both uses are inside
// functions called later, never at module-evaluation time), but
// there's no reason to rely on that. Living here instead, both
// items.js and supplier-items.js depend on this file and never on
// each other.
// =========================================================
import { getAll } from '../core/db.js';
import { fuzzyIncludes } from '../core/utils.js';

export async function findErpItems(query, limit = 8) {
  const items = await getAll('erpItems');
  const filtered = items.filter(i => fuzzyIncludes(i.name, query) || fuzzyIncludes(i.barcode || '', query));
  return filtered.slice(0, limit);
}

export async function listErpSupplierRelations(erpItemId) {
  const all = await getAll('supplierItems');
  const suppliers = await getAll('suppliers');
  const byId = Object.fromEntries(suppliers.map(s => [s.id, s]));
  return all.filter(r => r.erpItemId === erpItemId).map(r => ({ ...r, supplierName: byId[r.supplierId]?.name || '—' }));
}
