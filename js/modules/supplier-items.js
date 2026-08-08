// =========================================================
// modules/supplier-items.js
// The heart of the "same item, different supplier name /
// different supplier cost" idea:
//   supplierItems  = a supplier's own name for an item, linked
//                     (optionally) to one erpItems row, holding
//                     that supplier's *current* cost.
//   costHistory    = every cost that supplierItem ever had, so
//                     past returns keep the cost they were made
//                     with even after the price changes.
// =========================================================
import { getAll, getById, getByIndex, put, remove, removeWhere } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtDate, escapeHtml, fuzzyIncludes, debounce,
         openModal, confirmDialog, toast, el, qs, qsa } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { findErpItems } from './items.js';

// ---------- Data access ----------

export async function listBySupplier(supplierId) {
  const rows = await getByIndex('supplierItems', 'supplierId', supplierId);
  return rows.sort((a, b) => (a.supplierItemName || '').localeCompare(b.supplierItemName || '', 'ar'));
}

export async function searchSupplierItems(supplierId, query, limit = 8) {
  const rows = await listBySupplier(supplierId);
  const filtered = rows.filter(r => fuzzyIncludes(r.supplierItemName, query)).slice(0, limit);
  const erpItems = await getAll('erpItems');
  const erpById = Object.fromEntries(erpItems.map(i => [i.id, i]));
  return filtered.map(r => ({ ...r, erpItemName: r.erpItemId ? (erpById[r.erpItemId]?.name || null) : null }));
}

export async function getOrCreateSupplierItem(supplierId, name) {
  const rows = await listBySupplier(supplierId);
  const existing = rows.find(r => r.supplierItemName.trim().toLowerCase() === name.trim().toLowerCase());
  if (existing) return existing;
  const record = {
    id: uid(), supplierId, supplierItemName: name.trim(),
    erpItemId: null, currentCost: 0,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  await put('supplierItems', record);
  await logAction('إضافة اسم صنف عند المورد', 'supplierItem', record.id, name);
  return record;
}

export async function linkErpItem(supplierItemId, erpItemId) {
  const row = await getById('supplierItems', supplierItemId);
  row.erpItemId = erpItemId;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  const erp = await getById('erpItems', erpItemId);
  await logAction('ربط صنف مورد بصنف ERP', 'supplierItem', supplierItemId, `${row.supplierItemName} → ${erp?.name || ''}`);
  return row;
}

export async function unlinkErpItem(supplierItemId) {
  const row = await getById('supplierItems', supplierItemId);
  row.erpItemId = null;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  await logAction('فك ربط صنف مورد', 'supplierItem', supplierItemId, row.supplierItemName);
  return row;
}

export async function updateCost(supplierItemId, newCost) {
  const row = await getById('supplierItems', supplierItemId);
  const oldCost = row.currentCost;
  row.currentCost = Number(newCost) || 0;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  await put('costHistory', {
    id: uid(), supplierItemId, cost: row.currentCost, effectiveFrom: nowIso(), createdAt: nowIso(),
  });
  await logAction('تحديث تكلفة المورد', 'supplierItem', supplierItemId, `${row.supplierItemName}: ${fmtMoney(oldCost)} ← ${fmtMoney(row.currentCost)}`);
  return row;
}

export async function getCostHistory(supplierItemId) {
  const rows = await getByIndex('costHistory', 'supplierItemId', supplierItemId);
  return rows.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export async function deleteSupplierItem(supplierItemId) {
  await remove('supplierItems', supplierItemId);
  await removeWhere('costHistory', 'supplierItemId', supplierItemId);
}

export async function listUnlinked() {
  const all = await getAll('supplierItems');
  const suppliers = await getAll('suppliers');
  const byId = Object.fromEntries(suppliers.map(s => [s.id, s]));
  return all.filter(r => !r.erpItemId).map(r => ({ ...r, supplierName: byId[r.supplierId]?.name || '—' }));
}

export async function listErpSupplierRelations(erpItemId) {
  const all = await getAll('supplierItems');
  const suppliers = await getAll('suppliers');
  const byId = Object.fromEntries(suppliers.map(s => [s.id, s]));
  return all.filter(r => r.erpItemId === erpItemId).map(r => ({ ...r, supplierName: byId[r.supplierId]?.name || '—' }));
}

// ---------- UI: mapping panel embedded in supplier detail page ----------

export async function renderSupplierItemsPanel(container, supplierId) {
  const rows = await listBySupplier(supplierId);
  const erpItems = await getAll('erpItems');
  const erpById = Object.fromEntries(erpItems.map(i => [i.id, i]));

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <div class="small text-muted">أسماء أصناف هذا المورد وربطها بأصناف نظام ERP وتكلفة كل صنف</div>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" id="btn-add-mapping">+ إضافة اسم صنف</button>
      </div>
      ${rows.length ? `
      <table class="data-table">
        <thead><tr>
          <th>اسم الصنف عند المورد</th><th>صنف ERP المرتبط</th><th class="num">التكلفة الحالية</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><b>${escapeHtml(r.supplierItemName)}</b></td>
              <td>${r.erpItemId && erpById[r.erpItemId]
                  ? `<span class="badge badge-erp-yes">${escapeHtml(erpById[r.erpItemId].name)}</span>`
                  : `<span class="badge badge-warn">⚠️ غير مرتبط</span>`}</td>
              <td class="num">${fmtMoney(r.currentCost)}</td>
              <td class="flex gap-8">
                <button class="btn btn-sm btn-ghost btn-link" data-id="${r.id}">${r.erpItemId ? 'تغيير الربط' : 'ربط'}</button>
                <button class="btn btn-sm btn-ghost btn-cost" data-id="${r.id}">التكلفة</button>
                <button class="btn btn-sm btn-ghost btn-hist" data-id="${r.id}">السجل</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <div class="empty-title">لا توجد أصناف مسجلة لهذا المورد بعد</div>
        <div class="empty-hint">أضفها هنا أو ستُضاف تلقائيًا أول مرة تكتبها داخل مرتجعة</div>
      </div>`}
    </div>
  `;

  qs('#btn-add-mapping', container).addEventListener('click', () => openAddMappingModal(supplierId, () => renderSupplierItemsPanel(container, supplierId)));
  container.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-cost').forEach(b => b.addEventListener('click', () => openCostModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-hist').forEach(b => b.addEventListener('click', () => openHistoryModal(b.dataset.id)));
}

function openAddMappingModal(supplierId, onDone) {
  const { close } = openModal({
    title: 'إضافة اسم صنف عند المورد',
    bodyHtml: `<div class="field"><label>اسم الصنف كما يكتبه المورد *</label><input type="text" id="f-name" placeholder="مثال: كريبسادة لوكس"></div>`,
    footerButtons: [
      { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
      {
        label: 'إضافة', className: 'btn-primary',
        onClick: async (c) => {
          const name = qs('#f-name').value.trim();
          if (!name) { toast('الاسم مطلوب', 'error'); return; }
          await getOrCreateSupplierItem(supplierId, name);
          c(); onDone();
        },
      },
    ],
  });
}

function openLinkModal(supplierItemId, onDone) {
  const { close, node } = openModal({
    title: 'ربط بصنف نظام ERP',
    bodyHtml: `
      <div class="field autocomplete">
        <label>ابحث عن صنف ERP</label>
        <input type="text" id="erp-search" placeholder="اكتب اسم الصنف أو الباركود...">
        <div class="autocomplete-list" id="erp-results" style="display:none;"></div>
      </div>
      <div class="hint">لو الصنف غير موجود، أضفه أولًا من صفحة «قاعدة أصناف ERP».</div>
    `,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });
  const input = qs('#erp-search', node);
  const results = qs('#erp-results', node);
  input.addEventListener('input', debounce(async () => {
    const matches = await findErpItems(input.value, 8);
    if (!matches.length) { results.innerHTML = `<div class="autocomplete-empty">لا توجد نتائج</div>`; results.style.display = 'block'; return; }
    results.innerHTML = matches.map(m => `<div class="autocomplete-item" data-id="${m.id}"><b>${escapeHtml(m.name)}</b><div class="ac-sub">${escapeHtml(m.barcode || '')}</div></div>`).join('');
    results.style.display = 'block';
    results.querySelectorAll('.autocomplete-item').forEach(it => {
      it.addEventListener('click', async () => { await linkErpItem(supplierItemId, it.dataset.id); toast('تم الربط', 'success'); close(); onDone(); });
    });
  }, 200));
  input.focus();
}

function openCostModal(supplierItemId, onDone) {
  getById('supplierItems', supplierItemId).then(row => {
    const { close, node } = openModal({
      title: `تكلفة "${row.supplierItemName}"`,
      bodyHtml: `
        <div class="field"><label>التكلفة الحالية</label><input type="number" step="0.01" id="f-cost" value="${row.currentCost}"></div>
        <div class="hint">تحديث التكلفة يبدأ سريانه من الآن فقط. المرتجعات السابقة تحتفظ بالتكلفة وقت إنشائها ولا تتأثر.</div>
      `,
      footerButtons: [
        { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
        {
          label: 'حفظ', className: 'btn-primary',
          onClick: async (c) => { await updateCost(supplierItemId, qs('#f-cost', node).value); toast('تم تحديث التكلفة', 'success'); c(); onDone(); },
        },
      ],
    });
  });
}

async function openHistoryModal(supplierItemId) {
  const row = await getById('supplierItems', supplierItemId);
  const hist = await getCostHistory(supplierItemId);
  openModal({
    title: `سجل تكلفة "${row.supplierItemName}"`,
    bodyHtml: hist.length ? `
      <table class="data-table"><thead><tr><th>التكلفة</th><th>سارية من</th></tr></thead>
      <tbody>${hist.map(h => `<tr><td class="num">${fmtMoney(h.cost)}</td><td class="num text-dim">${fmtDate(h.effectiveFrom, true)}</td></tr>`).join('')}</tbody></table>
    ` : `<div class="empty-state"><div class="empty-hint">لا يوجد سجل تكلفة بعد</div></div>`,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });
}

// ---------- UI: standalone "unlinked items" route ----------

export async function renderUnlinkedView(container) {
  const rows = await listUnlinked();
  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h3>أصناف الموردين غير المرتبطة بنظام ERP</h3><span class="badge badge-warn">${rows.length}</span></div>
      ${rows.length ? `
      <table class="data-table">
        <thead><tr><th>المورد</th><th>اسم الصنف عند المورد</th><th class="num">التكلفة</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.supplierName)}</td>
              <td><b>${escapeHtml(r.supplierItemName)}</b></td>
              <td class="num">${fmtMoney(r.currentCost)}</td>
              <td><button class="btn btn-sm btn-primary btn-link" data-id="${r.id}">ربط الآن</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-title">كل أصناف الموردين مرتبطة</div>
        <div class="empty-hint">لا توجد أصناف تحتاج مراجعة حاليًا</div>
      </div>`}
    </div>
  `;
  container.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderUnlinkedView(container))));
}
