// =========================================================
// modules/returns.js — مرتجعات الموردين
// Lifecycle: draft -> sent -> (erpRegistered) -> closed.
// Sending freezes the line items; "editingUnlocked" is a
// deliberate, logged, temporary override — sentAt itself is
// never erased. Unit cost on each line is copied from the
// supplier item at the moment it's added, so later cost
// changes never rewrite past returns.
// =========================================================
import { getAll, getById, getByIndex, put, remove, removeWhere, bulkPut, generateReturnNumber } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtDate, fmtInt, escapeHtml, fuzzyIncludes, debounce,
         openModal, confirmDialog, toast, qs, qsa, paginate, renderPagination,
         renderPickedErp,
         renderPreservingFocus, guarded, closeOnOutsideClick, submitOnce } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { navigate } from '../core/router.js';
import { searchSupplierItems, getOrCreateSupplierItem, updateCost as updateSupplierItemCost, openLinkModal, openErpPicker } from './supplier-items.js';
import { autosaveField } from '../core/autosave.js';
import { openExportOptionsModal } from './return-export.js';

// ---------- Data access ----------

export async function listReturnsRaw() {
  return getAll('returns');
}

// Every mutation below used to assume its record still exists. When it
// didn't — deleted on another device, or a stale button in an old
// render — the handler died on "cannot set property of null" and the
// person just saw a button that did nothing. Now they get told why.
async function loadOrFail(store, id, missingMessage) {
  const row = await getById(store, id);
  if (!row) throw new Error(missingMessage);
  return row;
}
const loadReturn = (id) => loadOrFail('returns', id, 'المرتجعة دي مش موجودة — يمكن تكون اتحذفت من جهاز تاني.');
const loadLine = (id) => loadOrFail('returnItems', id, 'الصنف ده مش موجود في المرتجعة — جرّب تحدّث الصفحة.');

export async function getReturnItems(returnId) {
  const rows = await getByIndex('returnItems', 'returnId', returnId);
  // Sort by insertion time, not by whatever order the index cursor
  // happens to return (record ids are random UUIDs, not sortable) —
  // this is what keeps the item you just added at the bottom of the
  // list instead of appearing to jump to a random spot.
  return rows.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

// A supplier item can get linked to an ERP item (or re-linked to a
// different one) *after* it was already added to a return. Rather
// than freezing that link forever, re-check it every time the return
// is opened and quietly correct the line if the mapping has changed
// since — so "غير مرتبط" never lingers after you've actually linked it.
async function syncLineErpLinks(lines, supplierId) {
  if (!lines.length) return;
  // This runs on every single open (and re-open) of a return. Doing it
  // one line at a time meant a 30-line return fired 30+ sequential
  // round trips before the screen could paint — the single biggest
  // reason a return was slow to open. Two lookups now cover every line,
  // and only lines whose mapping actually changed get written back.
  const supplierItems = await getByIndex('supplierItems', 'supplierId', supplierId);
  const siById = Object.fromEntries(supplierItems.map(si => [si.id, si]));

  const changed = lines.filter(line => {
    const si = siById[line.supplierItemId];
    return si && (si.erpItemId || null) !== (line.erpItemId || null);
  });
  if (!changed.length) return;

  const erpById = Object.fromEntries((await getAll('erpItems')).map(i => [i.id, i]));
  changed.forEach(line => {
    const si = siById[line.supplierItemId];
    line.erpItemId = si.erpItemId || null;
    line.erpItemName = line.erpItemId ? (erpById[line.erpItemId]?.name || null) : null;
  });
  await bulkPut('returnItems', changed);
}

export async function computeTotal(returnId) {
  const items = await getReturnItems(returnId);
  return items.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
}

export async function listReturnsJoined() {
  const [returns, suppliers, allItems] = await Promise.all([getAll('returns'), getAll('suppliers'), getAll('returnItems')]);
  const supplierById = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const itemsByReturn = {};
  allItems.forEach(i => { (itemsByReturn[i.returnId] = itemsByReturn[i.returnId] || []).push(i); });
  return returns.map(r => {
    const items = itemsByReturn[r.id] || [];
    const total = items.reduce((s, i) => s + (Number(i.total) || 0), 0);
    const hasCreditLines = items.some(i => i.resolutionType !== 'exchange');
    const hasExchangeLines = items.some(i => i.resolutionType === 'exchange');
    // Exchange lines that are still waiting on the supplier to send the
    // sound goods back. This is real outstanding work, the same way an
    // unregistered credit is, so callers can surface it as one.
    const pendingReplacements = items.filter(i => i.resolutionType === 'exchange' && !i.replacementReceived).length;
    return {
      ...r, supplierName: supplierById[r.supplierId]?.name || '—',
      itemCount: items.length, total, hasCreditLines, hasExchangeLines, pendingReplacements,
    };
  });
}

export async function getSupplierStats(supplierId) {
  const all = await listReturnsJoined();
  const mine = all.filter(r => r.supplierId === supplierId);
  const active = mine.filter(r => r.status !== 'closed');
  const sent = mine.filter(r => r.status === 'sent' || (r.status === 'closed' && r.sentAt));
  const unregistered = mine.filter(r => r.status === 'sent' && r.hasCreditLines && !r.erpRegistered);
  return {
    activeCount: active.length,
    activeValue: active.reduce((s, r) => s + r.total, 0),
    sentCount: sent.length,
    unregisteredCount: unregistered.length,
    totalCount: mine.length,
  };
}

export async function createDraftReturn(supplierId) {
  const returnNumber = await generateReturnNumber();
  const record = {
    id: uid(), returnNumber, supplierId, status: 'draft', locked: false, editingUnlocked: false,
    notes: '', createdAt: nowIso(), updatedAt: nowIso(),
    sentAt: null, lastPostSendEditAt: null,
    erpRegistered: false, erpRegisteredAt: null, erpTransactionNumber: '',
  };
  await put('returns', record);
  await logAction('إنشاء مرتجعة', 'return', record.id, returnNumber);
  return record;
}

async function touchReturn(ret) { ret.updatedAt = nowIso(); await put('returns', ret); }

export async function addItemLine(returnId, supplierId, supplierItemName, qty, costOverride, costIsFallback = false, supplierItemId = null, newErpItemId = null) {
  // A name can now belong to more than one supplier item (same name, a
  // different ERP link), so when one was picked from the suggestions the
  // line is tied to that exact row instead of being matched by name again.
  // newErpItemId is the ERP item chosen in the add card for a name that is
  // not a supplier item yet — it goes in already linked.
  const picked = supplierItemId ? await getById('supplierItems', supplierItemId) : null;
  const si = picked || await getOrCreateSupplierItem(supplierId, supplierItemName, { erpItemId: newErpItemId });
  const quantity = Number(qty) || 1;

  let unitCost = Number(si.currentCost) || 0;
  let isFallback = false;
  if (costOverride !== undefined && costOverride !== '' && costOverride !== null) {
    const newCost = Number(costOverride);
    if (!isNaN(newCost)) {
      unitCost = newCost;
      if (costIsFallback) {
        // This number came from the ERP item's base cost as a stand-in
        // because the supplier never had a cost set — it is NOT a
        // confirmed supplier price, so don't record it as one. The line
        // still uses it (better than showing 0), just flagged red.
        isFallback = true;
      } else if (newCost !== Number(si.currentCost)) {
        // A cost typed/confirmed while adding to a return is, in practice,
        // the freshest known price for this supplier item — record it as
        // the current cost (with history) so it's the default suggestion
        // next time, anywhere in the system. Past returns are untouched.
        await updateSupplierItemCost(si.id, newCost, si);
      }
    }
  }

  let erpItemName = null;
  if (si.erpItemId) {
    const erp = await getById('erpItems', si.erpItemId);
    erpItemName = erp ? erp.name : null;
  }
  const line = {
    id: uid(), returnId, supplierItemId: si.id, supplierItemName: si.supplierItemName,
    erpItemId: si.erpItemId || null, erpItemName, qty: quantity, unitCost, total: quantity * unitCost,
    costIsFallback: isFallback,
    resolutionType: 'credit', // 'credit' (needs ERP registration) or 'exchange' (supplier replaces with sound goods — never goes to ERP)
    replacementReceived: false, replacementReceivedAt: null,
    createdAt: nowIso(),
  };
  await put('returnItems', line);
  // Bumping the parent return's updatedAt and writing the audit-log
  // entry are both "nice to have, not urgent" — don't make the person
  // wait on two more round trips just to see the new line appear.
  getById('returns', returnId).then(ret => { if (ret) touchReturn(ret); }).catch(err => console.error('touchReturn failed:', err));
  logAction('إضافة صنف للمرتجعة', 'return', returnId, `${si.supplierItemName} × ${quantity}`).catch(err => console.error('audit log failed:', err));
  return line;
}

export async function updateLine(lineId, { qty, unitCost }) {
  const line = await loadLine(lineId);
  if (qty !== undefined) line.qty = Number(qty) || 0;
  if (unitCost !== undefined) {
    const newCost = Number(unitCost) || 0;
    line.unitCost = newCost;
    line.costIsFallback = false; // editing it directly is an explicit confirmation
    // Same rule as above: editing the cost on a line is treated as
    // updating the known cost for that supplier item going forward,
    // without rewriting any other return that already used the old cost.
    const si = await getById('supplierItems', line.supplierItemId);
    if (si && newCost !== Number(si.currentCost)) await updateSupplierItemCost(si.id, newCost, si);
  }
  line.total = line.qty * line.unitCost;
  await put('returnItems', line);
  // Same reasoning as addItemLine: don't block the save confirmation on
  // a cosmetic "last modified" timestamp bump on the parent return.
  getById('returns', line.returnId).then(ret => { if (ret) touchReturn(ret); }).catch(err => console.error('touchReturn failed:', err));
  return line;
}

// ---------- Per-line resolution: credit (goes to ERP) vs exchange
// (supplier swaps for sound goods — never touches ERP, just tracked
// until the replacement physically arrives) ----------

export async function setLineResolutionType(lineId, resolutionType) {
  const line = await loadLine(lineId);
  line.resolutionType = resolutionType;
  if (resolutionType !== 'exchange') { line.replacementReceived = false; line.replacementReceivedAt = null; }
  await put('returnItems', line);
  return line;
}

export async function setLineReplacementReceived(lineId, received) {
  const line = await loadLine(lineId);
  line.replacementReceived = received;
  line.replacementReceivedAt = received ? nowIso() : null;
  await put('returnItems', line);
  await logAction(received ? 'استلام بديل صنف' : 'إلغاء استلام بديل صنف', 'return', line.returnId, line.supplierItemName);
  return line;
}

export async function markAllReplacementsReceived(returnId) {
  const lines = await getReturnItems(returnId);
  const toMark = lines.filter(l => l.resolutionType === 'exchange' && !l.replacementReceived);
  if (!toMark.length) return 0;
  // One batched write instead of one round trip per item — "استلمت كل
  // البدائل" on a 40-line return was 40 sequential writes.
  const stamp = nowIso();
  toMark.forEach(l => { l.replacementReceived = true; l.replacementReceivedAt = stamp; });
  await bulkPut('returnItems', toMark);
  await logAction('استلام كل بدائل المرتجعة', 'return', returnId, `${toMark.length} صنف`);
  return toMark.length;
}

export async function removeLine(lineId) {
  const line = await loadLine(lineId);
  await remove('returnItems', lineId);
  getById('returns', line.returnId).then(ret => { if (ret) touchReturn(ret); }).catch(err => console.error('touchReturn failed:', err));
  logAction('حذف صنف من المرتجعة', 'return', line.returnId, line.supplierItemName).catch(err => console.error('audit log failed:', err));
}

export async function saveNotes(returnId, notes) {
  const ret = await loadReturn(returnId);
  ret.notes = notes;
  await touchReturn(ret);
}

export async function sendReturn(returnId) {
  const ret = await loadReturn(returnId);
  ret.status = 'sent';
  ret.locked = true;
  ret.editingUnlocked = false;
  ret.sentAt = nowIso();
  await touchReturn(ret);
  await logAction('إرسال المرتجعة', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function unlockForEditing(returnId) {
  const ret = await loadReturn(returnId);
  ret.editingUnlocked = true;
  await touchReturn(ret);
  await logAction('فتح المرتجعة للتعديل بعد الإرسال', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function relockAfterEditing(returnId) {
  const ret = await loadReturn(returnId);
  ret.editingUnlocked = false;
  ret.lastPostSendEditAt = nowIso();
  await touchReturn(ret);
  await logAction('إغلاق التعديل بعد الإرسال', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function markErpRegistered(returnId, transactionNumber) {
  const ret = await loadReturn(returnId);
  ret.erpRegistered = true;
  ret.erpRegisteredAt = nowIso();
  ret.erpTransactionNumber = transactionNumber || '';
  await touchReturn(ret);
  await logAction('تسجيل المرتجعة على ERP', 'return', returnId, transactionNumber ? `رقم الحركة: ${transactionNumber}` : '');
  return ret;
}

export async function unmarkErpRegistered(returnId) {
  const ret = await loadReturn(returnId);
  ret.erpRegistered = false;
  ret.erpRegisteredAt = null;
  await touchReturn(ret);
  await logAction('إلغاء تسجيل ERP', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function setClosed(returnId, closed) {
  const ret = await loadReturn(returnId);
  ret.status = closed ? 'closed' : (ret.sentAt ? 'sent' : 'draft');
  await touchReturn(ret);
  await logAction(closed ? 'أرشفة المرتجعة' : 'إعادة فتح المرتجعة', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function deleteReturn(returnId) {
  await removeWhere('returnItems', 'returnId', returnId);
  await remove('returns', returnId);
  await logAction('حذف مرتجعة', 'return', returnId, '');
}

// A line's cost is frozen when it is added, so that changing a price later
// never rewrites a return that has already gone out. The flip side is that
// a draft you are still building keeps whatever the price was when you
// typed it — these pull the current supplier cost back onto the lines, on
// demand and only where the return is still editable.
export async function refreshLineCost(lineId) {
  const line = await loadLine(lineId);
  const si = await getById('supplierItems', line.supplierItemId);
  if (!si) throw new Error('الصنف ده مش موجود في أصناف المورد — يمكن يكون اتحذف.');
  const nextCost = Number(si.currentCost) || 0;
  const from = Number(line.unitCost) || 0;
  if (nextCost === from && !line.costIsFallback) return { changed: false, from, to: nextCost };

  line.unitCost = nextCost;
  line.costIsFallback = false; // an explicit refresh is a confirmed price
  line.total = (Number(line.qty) || 0) * nextCost;
  await put('returnItems', line);
  getById('returns', line.returnId).then(ret => { if (ret) touchReturn(ret); }).catch(err => console.error('touchReturn failed:', err));
  logAction('تحديث تكلفة صنف في المرتجعة', 'return', line.returnId, `${line.supplierItemName}: ${fmtMoney(from)} ← ${fmtMoney(nextCost)}`).catch(err => console.error('audit log failed:', err));
  return { changed: true, from, to: nextCost };
}

// How many lines a refresh would actually move, so the confirmation can
// say so — and so a return that is already up to date says nothing changed.
async function currentCostByItemId() {
  // Keyed by the supplier item a line actually points at, not by the
  // return's supplier: the line names its item directly, and reaching for
  // it through a supplier index would quietly skip any line whose item
  // does not appear there.
  const items = await getAll('supplierItems');
  return Object.fromEntries(items.map(si => [si.id, Number(si.currentCost) || 0]));
}

export async function pendingCostRefreshes(returnId) {
  const [lines, costById] = await Promise.all([getReturnItems(returnId), currentCostByItemId()]);
  return lines.filter(l => {
    const current = costById[l.supplierItemId];
    if (current === undefined) return false; // the supplier item is gone; leave the line alone
    return current !== (Number(l.unitCost) || 0) || l.costIsFallback;
  });
}

export async function refreshAllLineCosts(returnId) {
  const [stale, costById] = await Promise.all([pendingCostRefreshes(returnId), currentCostByItemId()]);
  if (!stale.length) return 0;

  const updated = stale.map(l => {
    const nextCost = costById[l.supplierItemId];
    return { ...l, unitCost: nextCost, costIsFallback: false, total: (Number(l.qty) || 0) * nextCost };
  });
  await bulkPut('returnItems', updated);
  getById('returns', returnId).then(ret => { if (ret) touchReturn(ret); }).catch(err => console.error('touchReturn failed:', err));
  logAction('تحديث تكلفة أصناف المرتجعة', 'return', returnId, `${updated.length} صنف`).catch(err => console.error('audit log failed:', err));
  return updated.length;
}

// The detail screen deliberately does NOT re-render when a quantity or
// cost is edited — that was the whole point of making editing fast. So
// the `lines` array a screen was drawn with goes stale the moment you
// type into it, and anything that reports on the return has to read the
// lines back instead of using that copy.
export async function collectExportLines(returnId, supplierId) {
  const lines = await getReturnItems(returnId);
  await syncLineErpLinks(lines, supplierId);
  return lines;
}

// ---------- UI: list views ----------

const listState = { page: 1, pageSize: 50, query: '', supplierFilter: '', dateFrom: '', dateTo: '' };

// Every way of slicing the returns list, in the order they appear in the
// status filter. The four the sidebar links to were the only ones that
// existed; the rest were states the system already tracked with no way to
// list them.
export const RETURN_FILTERS = [
  { key: 'all', label: 'كل المرتجعات', match: () => true },
  { key: 'draft', label: 'مسودة', match: r => r.status === 'draft' },
  { key: 'active', label: 'المرتجعات النشطة', match: r => r.status !== 'closed' },
  { key: 'sent', label: 'المرتجعات المرسلة', match: r => r.status === 'sent' },
  { key: 'editing', label: 'قيد التعديل بعد الإرسال', match: r => r.status === 'sent' && r.editingUnlocked },
  // Only "unregistered" when there is actually a credit portion waiting
  // on ERP — a pure-exchange return will never need registering.
  { key: 'unregistered', label: 'غير المسجلة على ERP', match: r => r.status === 'sent' && r.hasCreditLines && !r.erpRegistered },
  { key: 'awaiting-replacements', label: 'في انتظار استلام البدائل', match: r => r.status === 'sent' && r.pendingReplacements > 0 },
  { key: 'archive', label: 'الأرشيف', match: r => r.status === 'closed' },
];

const FILTER_BY_KEY = Object.fromEntries(RETURN_FILTERS.map(f => [f.key, f]));
const FILTER_LABELS = Object.fromEntries(RETURN_FILTERS.map(f => [f.key, f.label]));

function applyFilter(rows, key) {
  const filter = FILTER_BY_KEY[key];
  return filter ? rows.filter(filter.match) : rows;
}

function statusBadge(r) {
  if (r.status === 'closed') return `<span class="badge badge-closed">مغلقة</span>`;
  if (r.status === 'sent' && r.editingUnlocked) return `<span class="badge badge-editing">✏️ قيد التعديل</span>`;
  if (r.status === 'sent') return `<span class="badge badge-sent">🔒 تم الإرسال</span>`;
  return `<span class="badge badge-draft">مسودة</span>`;
}
function erpBadge(r) {
  if (r.status !== 'sent') return `<span class="text-dim small">—</span>`;
  if (!r.hasCreditLines && r.hasExchangeLines) return `<span class="badge badge-warn">🔄 استبدال</span>`;
  if (!r.hasCreditLines) return `<span class="text-dim small">—</span>`;
  return r.erpRegistered ? `<span class="badge badge-erp-yes">🟢 مسجلة</span>` : `<span class="badge badge-erp-no">🔴 غير مسجلة</span>`;
}

export async function renderReturnsList(container, filterKey, presetSupplierId = null) {
  const all = await listReturnsJoined();
  const suppliers = await getAll('suppliers');
  let rows = applyFilter(all, filterKey);
  if (presetSupplierId) rows = rows.filter(r => r.supplierId === presetSupplierId);
  if (listState.supplierFilter && !presetSupplierId) rows = rows.filter(r => r.supplierId === listState.supplierFilter);
  if (listState.query) rows = rows.filter(r => fuzzyIncludes(r.returnNumber, listState.query) || fuzzyIncludes(r.supplierName, listState.query));
  if (listState.dateFrom) rows = rows.filter(r => r.createdAt >= listState.dateFrom);
  if (listState.dateTo) rows = rows.filter(r => r.createdAt <= listState.dateTo + 'T23:59:59');
  rows = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const hasActiveFilters = !!(listState.dateFrom || listState.dateTo || (listState.supplierFilter && !presetSupplierId));

  // The page/pageSize in listState were declared from the start but never
  // applied — every return ever created was rendered into one table, so
  // this screen got steadily heavier with use.
  const { slice, totalPages, page, total } = paginate(rows, listState.page, listState.pageSize);

  renderPreservingFocus(container, `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="ret-search" placeholder="🔎 رقم المرتجعة أو المورد" style="max-width:240px;" value="${escapeHtml(listState.query)}">
        <div class="spacer"></div>
        <button class="btn btn-primary" id="btn-new-return">+ مرتجعة جديدة</button>
      </div>
      <div class="filter-bar">
        ${!presetSupplierId ? `
        <label>الحالة</label>
        <select id="ret-status-filter">
          ${RETURN_FILTERS.map(f => `<option value="${f.key}" ${f.key === filterKey ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
        </select>` : ''}
        ${!presetSupplierId ? `
        <label>المورد</label>
        <select id="ret-supplier-filter">
          <option value="">كل الموردين</option>
          ${suppliers.map(s => `<option value="${s.id}" ${listState.supplierFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>` : ''}
        <label>من</label>
        <input type="date" id="ret-date-from" value="${listState.dateFrom}">
        <label>إلى</label>
        <input type="date" id="ret-date-to" value="${listState.dateTo}">
        ${hasActiveFilters ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلاتر</button>` : ''}
      </div>
      ${slice.length ? `
      <table class="data-table">
        <thead><tr>
          <th>رقم المرتجعة</th><th>المورد</th><th>التاريخ</th><th class="num">عدد الأصناف</th><th class="num">القيمة</th><th>الحالة</th><th>ERP</th>
        </tr></thead>
        <tbody>
          ${slice.map(r => `
            <tr class="row-link" data-id="${r.id}">
              <td class="text-mono" data-label="رقم المرتجعة">${escapeHtml(r.returnNumber)}</td>
              <td data-label="المورد">${escapeHtml(r.supplierName)}</td>
              <td class="text-dim" data-label="التاريخ">${fmtDate(r.createdAt)}</td>
              <td class="num" data-label="عدد الأصناف">${fmtInt(r.itemCount)}</td>
              <td class="num" data-label="القيمة">${fmtMoney(r.total)}</td>
              <td data-label="الحالة">${statusBadge(r)}</td>
              <td data-label="ERP">${erpBadge(r)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">↩︎</div>
        <div class="empty-title">لا توجد مرتجعات في ${escapeHtml(FILTER_LABELS[filterKey] || '')}</div>
        <div class="empty-hint">${hasActiveFilters ? 'جرّب توسيع نطاق الفلاتر' : 'أنشئ مرتجعة جديدة للبدء'}</div>
      </div>`}
      <div id="returns-pagination"></div>
    </div>
  `);

  const pagWrap = qs('#returns-pagination', container);
  if (pagWrap && total > 0) {
    pagWrap.appendChild(renderPagination({
      page, totalPages, total, pageSize: listState.pageSize,
      onPage: (p) => { listState.page = p; renderReturnsList(container, filterKey, presetSupplierId); },
      onPageSize: (sz) => { listState.pageSize = sz; listState.page = 1; renderReturnsList(container, filterKey, presetSupplierId); },
    }));
  }

  container.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', () => navigate(`/returns/${row.dataset.id}`)));
  qs('#ret-search', container).addEventListener('input', debounce((e) => { listState.query = e.target.value; listState.page = 1; renderReturnsList(container, filterKey, presetSupplierId); }, 200));
  // Switching status is a real navigation, so it keeps its own history
  // entry and the sidebar highlight stays in step with the screen.
  qs('#ret-status-filter', container)?.addEventListener('change', (e) => {
    listState.page = 1;
    navigate(`/returns/${e.target.value}`);
  });
  const sf = qs('#ret-supplier-filter', container);
  if (sf) sf.addEventListener('change', () => { listState.supplierFilter = sf.value; listState.page = 1; renderReturnsList(container, filterKey, presetSupplierId); });
  qs('#ret-date-from', container).addEventListener('change', (e) => { listState.dateFrom = e.target.value; listState.page = 1; renderReturnsList(container, filterKey, presetSupplierId); });
  qs('#ret-date-to', container).addEventListener('change', (e) => { listState.dateTo = e.target.value; listState.page = 1; renderReturnsList(container, filterKey, presetSupplierId); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => {
    listState.supplierFilter = ''; listState.dateFrom = ''; listState.dateTo = ''; listState.page = 1;
    renderReturnsList(container, filterKey, presetSupplierId);
  });
  qs('#btn-new-return', container).addEventListener('click', () => openNewReturnModal(presetSupplierId));
}

async function openNewReturnModal(presetSupplierId) {
  const suppliers = await getAll('suppliers');
  if (!suppliers.length) { toast('أضف موردًا أولًا من صفحة الموردين', 'error'); return; }
  const { node } = openModal({
    title: 'مرتجعة جديدة',
    bodyHtml: `
      <div class="field"><label>المورد *</label>
        <select id="f-supplier">
          ${suppliers.map(s => `<option value="${s.id}" ${s.id === presetSupplierId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
    `,
    footerButtons: [
      { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
      {
        label: 'إنشاء المرتجعة', className: 'btn-primary',
        // Creating a return reserves a sequential number over the
        // network, so it is slow enough to double-click through —
        // which used to burn a number and leave an orphan draft.
        onClick: guarded(async (c) => {
          const btn = qs('.modal-footer .btn-primary', node);
          if (btn.disabled) return;
          btn.disabled = true;
          const originalLabel = btn.textContent;
          btn.textContent = 'جارِ الإنشاء...';
          try {
            const supplierId = qs('#f-supplier', node).value;
            const ret = await createDraftReturn(supplierId);
            c();
            navigate(`/returns/${ret.id}`);
          } catch (err) {
            btn.disabled = false;
            btn.textContent = originalLabel;
            throw err;
          }
        }, 'تعذّر إنشاء المرتجعة — إنشاء رقم جديد محتاج إنترنت.'),
      },
    ],
  });
}

// ---------- UI: detail / edit screen ----------

export async function renderReturnDetail(container, returnId) {
  const ret = await getById('returns', returnId);
  if (!ret) { container.innerHTML = `<div class="card card-pad">المرتجعة غير موجودة.</div>`; return; }
  const [supplier, lines] = await Promise.all([
    getById('suppliers', ret.supplierId),
    getReturnItems(returnId),
  ]);
  await syncLineErpLinks(lines, ret.supplierId);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalValue = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const editable = ret.status === 'draft' || ret.editingUnlocked;
  const exchangeLines = lines.filter(l => l.resolutionType === 'exchange');
  const creditLines = lines.filter(l => l.resolutionType !== 'exchange');
  const exchangeReceivedCount = exchangeLines.filter(l => l.replacementReceived).length;

  container.innerHTML = `
    <div class="flex items-center justify-between mb-16" style="flex-wrap:wrap;gap:10px;">
      <div>
        <div class="flex items-center gap-8">
          <h2 style="margin:0;font-size:19px;" class="text-mono">${escapeHtml(ret.returnNumber)}</h2>
          ${statusBadge(ret)}
        </div>
        <div class="small text-muted mt-8">
          المورد: <a href="#/suppliers/${supplier?.id}" style="color:var(--gold-dark);font-weight:700;">${escapeHtml(supplier?.name || '—')}</a>
          &nbsp;·&nbsp; أُنشئت في ${fmtDate(ret.createdAt, true)}
          &nbsp;·&nbsp; آخر تعديل ${fmtDate(ret.updatedAt, true)}
        </div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-ghost btn-sm" id="btn-export">📤 تصدير التقرير</button>
        ${ret.status === 'draft' ? `<button class="btn btn-danger btn-sm" id="btn-delete">حذف المرتجعة</button>` : ''}
      </div>
    </div>

    ${renderLifecycle(ret)}

    ${ret.locked && !ret.editingUnlocked ? `
      <div class="locked-banner">
        <span>🔒 تم إرسال هذه المرتجعة في ${fmtDate(ret.sentAt, true)} — الأصناف مقفلة عن التعديل.</span>
        <button class="btn btn-sm btn-gold" id="btn-unlock" style="margin-inline-start:auto;">تعديل المرتجعة</button>
      </div>
    ` : ''}
    ${ret.editingUnlocked ? `
      <div class="locked-banner">
        <span>✏️ قيد التعديل بعد الإرسال — تاريخ الإرسال الأصلي (${fmtDate(ret.sentAt, true)}) محفوظ ولن يتغير.</span>
        <button class="btn btn-sm btn-primary" id="btn-relock" style="margin-inline-start:auto;">تم — إعادة القفل</button>
      </div>
    ` : ''}

    <div class="card mb-16">
      <div class="card-header">
        <h3>الأصناف</h3>
        <div class="flex items-center gap-8" style="flex-wrap:wrap;">
          ${editable && lines.length ? `<button class="btn btn-sm btn-ghost" id="btn-refresh-costs" title="يجيب أحدث تكلفة من أصناف المورد لكل الأصناف اللي في المرتجعة دي">↻ تحديث التكلفة</button>` : ''}
          <span class="small text-dim">${fmtInt(lines.length)} صنف · حفظ تلقائي أثناء الكتابة</span>
        </div>
      </div>
      ${lines.length ? `
      <table class="data-table">
        <thead><tr>
          <th>اسم الصنف عند المورد</th><th>صنف النظام ERP</th><th class="num">الكمية</th><th class="num">تكلفة المورد</th><th class="num">الإجمالي</th><th>نوع المعالجة</th>${editable ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${lines.map(l => `
            <tr data-line="${l.id}">
              <td data-label="اسم الصنف عند المورد"><b>${escapeHtml(l.supplierItemName)}</b></td>
              <td data-label="صنف النظام ERP">${l.erpItemName ? escapeHtml(l.erpItemName) : `<span class="badge badge-warn">⚠️ غير مرتبط</span> <button class="btn btn-sm btn-ghost btn-link-erp" data-supplier-item-id="${l.supplierItemId}">ربط</button>`}</td>
              <td class="num" data-label="الكمية">${editable ? `<input type="number" min="0" step="1" class="line-qty" data-id="${l.id}" value="${l.qty}" style="width:80px;text-align:center;">` : fmtInt(l.qty)}</td>
              <td class="num" data-label="تكلفة المورد">${editable
                ? `<span class="cost-cell">
                     <input type="number" min="0" step="0.01" class="line-cost ${l.costIsFallback ? 'cost-fallback' : ''}" data-id="${l.id}" value="${l.unitCost}" title="${l.costIsFallback ? 'تكلفة النظام الافتراضية — لسه محدّدتش تكلفة هذا المورد الفعلية' : ''}" style="width:100px;text-align:center;">
                     <button class="btn btn-sm btn-ghost line-refresh-cost" data-id="${l.id}" title="يجيب أحدث تكلفة للصنف ده من أصناف المورد">↻</button>
                   </span>`
                : `<span class="${l.costIsFallback ? 'cost-fallback-text' : ''}" title="${l.costIsFallback ? 'تكلفة النظام الافتراضية — لسه محدّدتش تكلفة هذا المورد الفعلية' : ''}">${fmtMoney(l.unitCost)}</span>`}</td>
              <td class="num text-mono" id="line-total-${l.id}" data-label="الإجمالي">${fmtMoney(l.total)}</td>
              <td data-label="نوع المعالجة">
                <select class="line-resolution" data-id="${l.id}" ${editable ? '' : 'disabled'}>
                  <option value="credit" ${l.resolutionType !== 'exchange' ? 'selected' : ''}>دائن</option>
                  <option value="exchange" ${l.resolutionType === 'exchange' ? 'selected' : ''}>استبدال</option>
                </select>
                ${l.resolutionType === 'exchange' ? (l.replacementReceived
                    ? `<div class="mt-8"><span class="badge badge-erp-yes">✅ تم الاستلام</span></div>`
                    : `<div class="mt-8"><button class="btn btn-sm btn-ghost line-toggle-received" data-id="${l.id}">⏳ لسه — دوس لما تستلم</button></div>`
                  ) : ''}
              </td>
              ${editable ? `<td><button class="btn btn-sm btn-ghost line-remove" data-id="${l.id}" data-name="${escapeHtml(l.supplierItemName || '')}">حذف</button></td>` : ''}
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          ${lines.some(l => l.costIsFallback) ? `<tr><td colspan="${editable ? 7 : 6}" style="padding-top:6px;"><span class="small" style="color:var(--red);">🔴 التكلفة باللون الأحمر هي تكلفة النظام الافتراضية — راجعها وأكّدها أو عدّلها لو مختلفة عن تكلفة المورد الفعلية.</span></td></tr>` : ''}
          <tr>
            <td colspan="2"><b>الإجمالي</b></td>
            <td class="num text-mono" id="footer-total-qty" data-label="إجمالي الكمية">${fmtInt(totalQty)}</td>
            <td></td>
            <td class="num text-mono" id="footer-total-value" data-label="الإجمالي"><b>${fmtMoney(totalValue)}</b></td>
            <td></td>
            ${editable ? '<td></td>' : ''}
          </tr>
        </tfoot>
      </table>` : `<div class="empty-state"><div class="empty-hint">لا توجد أصناف في هذه المرتجعة بعد</div></div>`}

      ${editable ? `
      <div class="card-pad" style="border-top:1px solid var(--line);">
        <div class="section-title">إضافة صنف</div>
        <div class="form-row" style="align-items:flex-end;">
          <div class="field autocomplete" style="flex:2;">
            <label>اسم الصنف عند المورد</label>
            <input type="text" id="add-item-name" placeholder="ابدأ الكتابة...">
            <div class="autocomplete-list" id="add-item-results" style="display:none;"></div>
            <div class="picked-erp" id="add-item-erp" style="display:none;"></div>
          </div>
          <div class="field" style="flex:0 0 90px;"><label>الكمية</label><input type="number" id="add-item-qty" placeholder="0" min="1"></div>
          <div class="field" style="flex:0 0 60px;"><label title="ق = سعر القطعة، د = سعر الدستة (هيتحول لسعر القطعة تلقائيًا)">الوحدة</label>
            <select id="add-item-unit-type">
              <option value="piece">ق</option>
              <option value="dozen">د</option>
            </select>
          </div>
          <div class="field" style="flex:0 0 110px;"><label>التكلفة</label><input type="number" step="0.01" id="add-item-cost" placeholder="0.00"></div>
          <div class="field" style="flex:0 0 110px;"><label>الإجمالي</label><div class="field-readout" id="add-item-total">0.00</div></div>
          <div class="field" style="flex:0 0 auto;"><button class="btn btn-primary" id="btn-add-item">+ إضافة</button></div>
        </div>
      </div>` : ''}
    </div>

    <div class="card mb-16 card-pad">
      <div class="field-label-row"><div class="section-title" style="margin:0;">ملاحظات</div><span class="autosave-status" id="notes-status"></span></div>
      <textarea id="ret-notes" placeholder="ملاحظات داخلية عن هذه المرتجعة...">${escapeHtml(ret.notes || '')}</textarea>
    </div>

    <div class="card card-pad flex items-center justify-between" style="flex-wrap:wrap;gap:12px;">
      <div class="flex items-center gap-12" style="flex-wrap:wrap;">
        ${ret.status === 'sent' && creditLines.length ? `
          ${ret.erpRegistered
            ? `<span class="badge badge-erp-yes">🟢 مسجلة على ERP${ret.erpTransactionNumber ? ` — رقم الحركة: <span class="text-mono">${escapeHtml(ret.erpTransactionNumber)}</span>` : ''}</span>
               <button class="btn btn-sm btn-ghost" id="btn-unerp">إلغاء التسجيل</button>`
            : `<span class="badge badge-erp-no">🔴 لم تُسجل على ERP بعد</span>
               <button class="btn btn-sm btn-gold" id="btn-erp">✓ تم التسجيل على ERP</button>`}
        ` : ''}
        ${ret.status === 'sent' && exchangeLines.length ? `
          <span class="badge ${exchangeReceivedCount === exchangeLines.length ? 'badge-erp-yes' : 'badge-warn'}">
            🔄 بدائل مستلمة: ${exchangeReceivedCount} / ${exchangeLines.length}
          </span>
          ${exchangeReceivedCount < exchangeLines.length ? `<button class="btn btn-sm btn-gold" id="btn-receive-all">✓ تم استلام كل البدائل</button>` : ''}
        ` : ''}
      </div>
      <div class="flex gap-8">
        ${ret.status === 'draft' ? `<button class="btn btn-primary" id="btn-send" ${lines.length ? '' : 'disabled'}>إرسال المرتجعة →</button>` : ''}
        ${ret.status === 'sent' ? `<button class="btn btn-ghost" id="btn-archive">🗄 أرشفة</button>` : ''}
        ${ret.status === 'closed' ? `<button class="btn btn-ghost" id="btn-reopen">إعادة فتح</button>` : ''}
      </div>
    </div>
  `;

  wireDetailEvents(container, ret, lines, supplier);
}

function renderLifecycle(ret) {
  const stages = [
    { key: 'draft', label: 'مسودة', reached: true },
    { key: 'sent', label: 'تم الإرسال', reached: !!ret.sentAt },
    { key: 'erp', label: 'مسجلة على ERP', reached: !!ret.erpRegistered },
    { key: 'closed', label: 'مغلقة', reached: ret.status === 'closed' },
  ];
  return `
    <div class="lifecycle">
      ${stages.map((s, i) => `
        ${i > 0 ? `<div class="lifecycle-line ${stages[i].reached ? 'active' : ''}"></div>` : ''}
        <div class="lifecycle-node ${s.reached ? 'active' : ''}"><span class="lc-dot"></span><span class="lc-label">${s.label}</span></div>
      `).join('')}
    </div>
  `;
}

function recalcRowAndTotals(container, lineId) {
  const row = container.querySelector(`tr[data-line="${lineId}"]`);
  if (!row) return;
  const qty = Number(row.querySelector('.line-qty')?.value) || 0;
  const cost = Number(row.querySelector('.line-cost')?.value) || 0;
  const totalCell = qs(`#line-total-${lineId}`, container);
  if (totalCell) totalCell.textContent = fmtMoney(qty * cost);

  let totalQty = 0, totalValue = 0;
  qsa('tr[data-line]', container).forEach(tr => {
    const q = Number(tr.querySelector('.line-qty')?.value) || 0;
    const c = Number(tr.querySelector('.line-cost')?.value) || 0;
    totalQty += q; totalValue += q * c;
  });
  const fq = qs('#footer-total-qty', container); if (fq) fq.textContent = fmtInt(totalQty);
  const fv = qs('#footer-total-value', container); if (fv) fv.innerHTML = `<b>${fmtMoney(totalValue)}</b>`;
}

// The return screen re-renders itself after almost every action, so the
// "click outside to close the suggestions" listener has to be replaced,
// not stacked. Keeping the disposer here means at most one is ever live.
let disposeOutsideClick = null;

function wireDetailEvents(container, ret, lines, supplier) {
  if (disposeOutsideClick) { disposeOutsideClick(); disposeOutsideClick = null; }
  qs('#btn-delete', container)?.addEventListener('click', guarded(async () => {
    if (!(await confirmDialog(`سيتم حذف المرتجعة ${ret.returnNumber} نهائيًا. هل أنت متأكد؟`, { danger: true }))) return;
    await deleteReturn(ret.id);
    toast('تم حذف المرتجعة', 'success');
    navigate('/returns/active');
  }));

  // Link straight from the return — no need to leave and go find this
  // item in the supplier's item list just to fix the ERP mapping.
  qsa('.btn-link-erp', container).forEach(b => b.addEventListener('click', () => {
    openLinkModal(b.dataset.supplierItemId, () => renderReturnDetail(container, ret.id));
  }));

  qs('#btn-unlock', container)?.addEventListener('click', guarded(async () => {
    if (!(await confirmDialog('هل تريد فتح المرتجعة للتعديل؟ سيبقى تاريخ الإرسال الأصلي محفوظًا.'))) return;
    await unlockForEditing(ret.id);
    renderReturnDetail(container, ret.id);
  }));
  qs('#btn-relock', container)?.addEventListener('click', guarded(async () => {
    await relockAfterEditing(ret.id);
    toast('تم إعادة القفل', 'success');
    renderReturnDetail(container, ret.id);
  }));

  // Held so the export can wait for a half-typed value to be written
  // before it reads the return back.
  const lineSavers = [];
  qsa('.line-qty', container).forEach(inp => lineSavers.push(autosaveField(inp, async (val) => {
    await updateLine(inp.dataset.id, { qty: val });
    recalcRowAndTotals(container, inp.dataset.id);
  }, { delay: 500 })));
  qsa('.line-cost', container).forEach(inp => lineSavers.push(autosaveField(inp, async (val) => {
    await updateLine(inp.dataset.id, { unitCost: val });
    inp.classList.remove('cost-fallback');
    inp.title = '';
    recalcRowAndTotals(container, inp.dataset.id);
  }, { delay: 500 })));
  qsa('.line-refresh-cost', container).forEach(b => b.addEventListener('click', submitOnce(b, async () => {
    const { changed, from, to } = await refreshLineCost(b.dataset.id);
    toast(changed ? `التكلفة اتحدّثت من ${fmtMoney(from)} لـ ${fmtMoney(to)}` : 'التكلفة محدّثة بالفعل', changed ? 'success' : 'default');
    if (changed) await renderReturnDetail(container, ret.id);
  }, { busyLabel: '…' })));

  const refreshCostsButton = qs('#btn-refresh-costs', container);
  refreshCostsButton?.addEventListener('click', submitOnce(refreshCostsButton, async () => {
    const stale = await pendingCostRefreshes(ret.id);
    if (!stale.length) { toast('كل التكاليف محدّثة بالفعل', 'default'); return; }
    const ok = await confirmDialog(
      `هيتم تحديث تكلفة ${stale.length} صنف في المرتجعة دي من أحدث تكلفة في أصناف المورد. الأصناف اللي تكلفتها محدّثة مش هتتغير.`,
      { okLabel: 'تحديث التكلفة' });
    if (!ok) return;
    const count = await refreshAllLineCosts(ret.id);
    toast(`تم تحديث تكلفة ${count} صنف`, 'success');
    await renderReturnDetail(container, ret.id);
  }, { busyLabel: 'جارِ التحديث...' }));

  // Same single-tap delete as the invoice screen had: confirm first, since
  // a line carries a quantity and a cost that were typed by hand.
  qsa('.line-remove', container).forEach(b => b.addEventListener('click', guarded(async () => {
    const name = b.dataset.name || 'الصنف';
    if (!(await confirmDialog(`هيتشال "${name}" من المرتجعة. تمام؟`, { okLabel: 'حذف', danger: true }))) return;
    await removeLine(b.dataset.id);
    renderReturnDetail(container, ret.id);
  })));
  qsa('.line-resolution', container).forEach(sel => sel.addEventListener('change', guarded(async () => {
    await setLineResolutionType(sel.dataset.id, sel.value);
    renderReturnDetail(container, ret.id);
  })));
  qsa('.line-toggle-received', container).forEach(b => b.addEventListener('click', guarded(async () => {
    await setLineReplacementReceived(b.dataset.id, true);
    toast('تم تسجيل استلام البديل', 'success');
    renderReturnDetail(container, ret.id);
  })));

  const nameInput = qs('#add-item-name', container);
  const resultsBox = qs('#add-item-results', container);
  const costInput = qs('#add-item-cost', container);
  if (nameInput) {
    // Typing again invalidates whichever row was picked from the list.
    const erpLine = qs('#add-item-erp', container);
    nameInput.addEventListener('input', () => {
      nameInput.dataset.supplierItemId = '';
      nameInput.dataset.pendingErpId = '';
      nameInput.dataset.pendingErpName = '';
      renderPickedErp(erpLine, { state: 'none' }); // the pick it described is gone
    });

    // Pick the ERP item from the add card. An existing item with no link is
    // linked on the spot; a name that is not a supplier item yet remembers
    // the pick and goes in already linked when the line is added.
    erpLine?.addEventListener('click', (e) => {
      if (!e.target.closest('.btn-pick-erp')) return;
      e.preventDefault();
      const supplierItemId = nameInput.dataset.supplierItemId;
      if (supplierItemId) {
        openLinkModal(supplierItemId, async () => {
          const si = await getById('supplierItems', supplierItemId);
          const erp = si?.erpItemId ? await getById('erpItems', si.erpItemId) : null;
          renderPickedErp(erpLine, { state: erp ? 'linked' : 'unlinked', erpName: erp?.name || '' });
        });
        return;
      }
      openErpPicker((item) => {
        nameInput.dataset.pendingErpId = item.id;
        nameInput.dataset.pendingErpName = item.name;
        renderPickedErp(erpLine, { state: 'will-link', erpName: item.name });
      });
    });
    nameInput.addEventListener('input', debounce(async () => {
      const q = nameInput.value.trim();
      if (!q) { resultsBox.style.display = 'none'; return; }
      const matches = await searchSupplierItems(ret.supplierId, q, 8);
      const exact = matches.some(m => m.supplierItemName.trim().toLowerCase() === q.toLowerCase());
      let html = matches.map(m => {
        const hasSupplierCost = Number(m.currentCost) > 0;
        const fallbackCost = (!hasSupplierCost && m.erpBaseCost > 0) ? m.erpBaseCost : null;
        const effectiveCost = hasSupplierCost ? m.currentCost : (fallbackCost || 0);
        const costLabel = hasSupplierCost
          ? `· ${fmtMoney(m.currentCost)} ج`
          : (fallbackCost ? `· <span style="color:var(--red);">${fmtMoney(fallbackCost)} ج (تكلفة النظام، مش مؤكدة)</span>` : '');
        return `
        <div class="autocomplete-item" data-supplier-item-id="${m.id}" data-name="${escapeHtml(m.supplierItemName)}" data-erp-name="${escapeHtml(m.erpItemName || '')}" data-cost="${effectiveCost}" data-fallback="${fallbackCost !== null ? '1' : '0'}">
          <b>${escapeHtml(m.supplierItemName)}</b>
          <div class="ac-sub">${m.erpItemName ? escapeHtml(m.erpItemName) : '⚠️ غير مرتبط بعد'} ${costLabel}</div>
        </div>
      `;
      }).join('');
      if (!exact) html += `<div class="autocomplete-item" data-supplier-item-id="" data-name="${escapeHtml(q)}" data-erp-name="" data-cost="" data-fallback="0" style="color:var(--gold-dark);">+ إضافة "${escapeHtml(q)}" كصنف جديد لهذا المورد</div>`;
      resultsBox.innerHTML = html || `<div class="autocomplete-empty">لا توجد نتائج</div>`;
      resultsBox.style.display = 'block';
      resultsBox.querySelectorAll('.autocomplete-item').forEach(it => {
        it.addEventListener('click', () => {
          nameInput.value = it.dataset.name;
          nameInput.dataset.supplierItemId = it.dataset.supplierItemId || '';
          nameInput.dataset.pendingErpId = '';
          nameInput.dataset.pendingErpName = '';
          renderPickedErp(erpLine, {
            state: it.dataset.supplierItemId ? (it.dataset.erpName ? 'linked' : 'unlinked') : 'new',
            erpName: it.dataset.erpName,
          });
          if (costInput && it.dataset.cost) {
            costInput.value = it.dataset.cost;
            const isFallback = it.dataset.fallback === '1';
            costInput.dataset.fallback = isFallback ? '1' : '0';
            costInput.classList.toggle('cost-fallback', isFallback);
            costInput.title = isFallback ? 'تكلفة النظام الافتراضية — لسه محدّدتش تكلفة هذا المورد الفعلية' : '';
            // Suggested costs are always stored per-piece — reset the
            // unit toggle so a leftover "د" selection doesn't silently
            // halve-by-12 a value that's already correct as typed.
            const unitTypeEl = qs('#add-item-unit-type', container);
            if (unitTypeEl) unitTypeEl.value = 'piece';
          }
          syncAddTotal(); // picking fills the cost without firing an input event
          resultsBox.style.display = 'none';
          // The name and (if known) cost are already filled in — the
          // one thing still missing every time is the quantity, so
          // that's where attention should land, not on cost.
          qs('#add-item-qty', container)?.focus();
        });
      });
    }, 200));
    disposeOutsideClick = closeOnOutsideClick(resultsBox);
  }

  // Typing into the cost field yourself counts as taking ownership of
  // the value, whatever it ends up being — clear the "unconfirmed
  // system cost" flag the moment they touch it.
  costInput?.addEventListener('input', () => {
    costInput.dataset.fallback = '0';
    costInput.classList.remove('cost-fallback');
    costInput.title = '';
  });

  // What the line being typed will come to, worked out the same way the
  // line itself is: "د" means the cost typed is per dozen, so the piece
  // cost is a twelfth of it and that is what the quantity multiplies.
  const totalReadout = qs('#add-item-total', container);
  function syncAddTotal() {
    if (!totalReadout) return;
    const qty = Number(qs('#add-item-qty', container)?.value) || 0;
    const typedCost = Number(qs('#add-item-cost', container)?.value) || 0;
    const perPiece = qs('#add-item-unit-type', container)?.value === 'dozen' ? typedCost / 12 : typedCost;
    totalReadout.textContent = fmtMoney(qty * perPiece);
  }
  ['#add-item-qty', '#add-item-cost'].forEach(sel => qs(sel, container)?.addEventListener('input', syncAddTotal));
  qs('#add-item-unit-type', container)?.addEventListener('change', syncAddTotal);
  syncAddTotal();

  const addItemButton = qs('#btn-add-item', container);
  addItemButton?.addEventListener('click', submitOnce(addItemButton, async () => {
    const name = qs('#add-item-name', container).value.trim();
    const qty = qs('#add-item-qty', container).value;
    const costEl = qs('#add-item-cost', container);
    const costIsFallback = costEl?.dataset.fallback === '1';
    let cost = costEl?.value;
    // "د" means the price just typed is per-dozen, not per-piece — convert
    // it once here so everything downstream (the line, cost sync, cost
    // history) keeps working with a single, consistent per-piece price.
    const unitType = qs('#add-item-unit-type', container)?.value || 'piece';
    if (unitType === 'dozen' && cost !== '' && cost !== undefined && cost !== null) {
      cost = String((Number(cost) || 0) / 12);
    }
    if (!name) { toast('اكتب اسم الصنف أولًا', 'error'); return; }
    if (!qty || Number(qty) <= 0) { toast('اكتب الكمية أولًا', 'error'); qs('#add-item-qty', container)?.focus(); return; }

    const pickedId = qs('#add-item-name', container)?.dataset.supplierItemId || null;
    const pendingErpId = qs('#add-item-name', container)?.dataset.pendingErpId || null;
    await addItemLine(ret.id, ret.supplierId, name, qty, cost, costIsFallback, pickedId, pendingErpId);
    await renderReturnDetail(container, ret.id);
    qs('#add-item-name', container)?.focus();
  }, { busyLabel: 'جارِ الإضافة...' }));

  const notesInput = qs('#ret-notes', container);
  const notesSaver = notesInput
    ? autosaveField(notesInput, (val) => saveNotes(ret.id, val), { statusEl: qs('#notes-status', container) })
    : null;

  qs('#btn-export', container)?.addEventListener('click', guarded(async () => {
    // Clicking blurs whichever field was being typed into, which starts a
    // save — wait for that, and for any debounced one, before reading.
    await Promise.all(lineSavers.map(saver => saver.settle()));
    if (notesSaver) await notesSaver.settle();
    // Then export what the return actually holds now, not the copy this
    // screen was drawn with (see collectExportLines). The return record
    // itself is re-read too: the report carries its آخر تعديل date, which
    // the edit that just happened has moved.
    const [freshRet, current] = await Promise.all([
      getById('returns', ret.id),
      collectExportLines(ret.id, ret.supplierId),
    ]);
    await openExportOptionsModal(freshRet || ret, current, supplier);
  }));

  qs('#btn-send', container)?.addEventListener('click', guarded(async () => {
    if (!(await confirmDialog(`سيتم إرسال المرتجعة ${ret.returnNumber} للمورد وقفل الأصناف. هل أنت متأكد؟`))) return;
    await sendReturn(ret.id);
    toast('تم إرسال المرتجعة', 'success');
    renderReturnDetail(container, ret.id);
  }));

  qs('#btn-erp', container)?.addEventListener('click', () => {
    openModal({
      title: 'تسجيل المرتجعة على ERP',
      bodyHtml: `<div class="field"><label>رقم حركة ERP (اختياري)</label><input type="text" id="f-erp-num" placeholder="مثال: ERP-RET-45281"></div>`,
      footerButtons: [
        { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
        { label: 'تأكيد التسجيل', className: 'btn-gold', onClick: guarded(async (c) => {
            await markErpRegistered(ret.id, qs('#f-erp-num').value.trim());
            toast('تم تسجيل المرتجعة على ERP', 'success');
            c(); renderReturnDetail(container, ret.id);
          }) },
      ],
    });
  });
  qs('#btn-unerp', container)?.addEventListener('click', guarded(async () => {
    if (!(await confirmDialog('هل تريد إلغاء تعليم هذه المرتجعة كمسجلة على ERP؟'))) return;
    await unmarkErpRegistered(ret.id);
    renderReturnDetail(container, ret.id);
  }));

  qs('#btn-receive-all', container)?.addEventListener('click', guarded(async () => {
    const n = await markAllReplacementsReceived(ret.id);
    if (n) toast(`تم تسجيل استلام ${n} صنف`, 'success');
    renderReturnDetail(container, ret.id);
  }));

  qs('#btn-archive', container)?.addEventListener('click', guarded(async () => { await setClosed(ret.id, true); toast('تم نقل المرتجعة للأرشيف', 'success'); renderReturnDetail(container, ret.id); }));
  qs('#btn-reopen', container)?.addEventListener('click', guarded(async () => { await setClosed(ret.id, false); renderReturnDetail(container, ret.id); }));
}
