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
import { uid, nowIso, fmtMoney, fmtDate, escapeHtml, fuzzyIncludes, normalizeArabic, debounce,
         openModal, confirmDialog, toast, el, qs, qsa } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { findErpItems } from './item-links.js';

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
  return filtered.map(r => {
    const erp = r.erpItemId ? erpById[r.erpItemId] : null;
    return {
      ...r,
      erpItemName: erp ? erp.name : null,
      erpBaseCost: erp ? Number(erp.baseCost) || 0 : null,
    };
  });
}

export async function getOrCreateSupplierItem(supplierId, name) {
  const rows = await listBySupplier(supplierId);
  // Plain trim+lowercase does nothing useful on Arabic text (no case to
  // fold), so it only caught byte-for-byte identical names. Matching on
  // the same normalization used for search (strips diacritics/tatweel,
  // unifies alef/ya/ta-marbuta variants, collapses whitespace) is what
  // actually recognizes "كريبسادة" and "كريب سادة" as the same item
  // instead of silently creating a second row for it.
  const target = normalizeArabic(name);
  const existing = rows.find(r => normalizeArabic(r.supplierItemName) === target);
  if (existing) return existing;
  const record = {
    id: uid(), supplierId, supplierItemName: name.trim(),
    erpItemId: null, currentCost: 0,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  await put('supplierItems', record);
  logAction('إضافة اسم صنف عند المورد', 'supplierItem', record.id, name).catch(err => console.error('audit log failed:', err));
  return record;
}

export async function linkErpItem(supplierItemId, erpItemId) {
  const row = await getById('supplierItems', supplierItemId);
  row.erpItemId = erpItemId;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  const erp = await getById('erpItems', erpItemId);
  logAction('ربط صنف مورد بصنف ERP', 'supplierItem', supplierItemId, `${row.supplierItemName} → ${erp?.name || ''}`).catch(err => console.error('audit log failed:', err));
  return row;
}

export async function unlinkErpItem(supplierItemId) {
  const row = await getById('supplierItems', supplierItemId);
  row.erpItemId = null;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  logAction('فك ربط صنف مورد', 'supplierItem', supplierItemId, row.supplierItemName).catch(err => console.error('audit log failed:', err));
  return row;
}

export async function updateCost(supplierItemId, newCost, preloaded = null) {
  // Cost edits happen constantly while filling in a return, so this is
  // the hottest write path in the app — every extra round trip here is
  // felt directly as typing lag. Skip the re-read when the caller
  // already has the record (returns.js does), and don't block on the
  // history/audit-log writes: they matter for the record, not for
  // confirming *this* save succeeded, so let them finish in the background.
  const row = preloaded || await getById('supplierItems', supplierItemId);
  const oldCost = row.currentCost;
  row.currentCost = Number(newCost) || 0;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  put('costHistory', { id: uid(), supplierItemId, cost: row.currentCost, effectiveFrom: nowIso(), createdAt: nowIso() }).catch(err => console.error('cost history write failed:', err));
  logAction('تحديث تكلفة المورد', 'supplierItem', supplierItemId, `${row.supplierItemName}: ${fmtMoney(oldCost)} ← ${fmtMoney(row.currentCost)}`).catch(err => console.error('audit log failed:', err));
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

// ---------- UI: mapping panel embedded in supplier detail page ----------

const panelState = { unlinkedOnly: false, noCostOnly: false };

export async function renderSupplierItemsPanel(container, supplierId) {
  const allRows = await listBySupplier(supplierId);
  const erpItems = await getAll('erpItems');
  const erpById = Object.fromEntries(erpItems.map(i => [i.id, i]));

  const rows = allRows
    .filter(r => !panelState.unlinkedOnly || !r.erpItemId)
    .filter(r => !panelState.noCostOnly || !r.currentCost);
  const hasActiveFilters = panelState.unlinkedOnly || panelState.noCostOnly;

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <div class="small text-muted">أسماء أصناف هذا المورد وربطها بأصناف نظام ERP وتكلفة كل صنف</div>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" id="btn-add-mapping">+ إضافة اسم صنف</button>
      </div>
      ${allRows.length ? `
      <div class="filter-bar">
        <label class="flex items-center gap-8" style="cursor:pointer;font-weight:700;font-size:12.5px;">
          <input type="checkbox" id="f-unlinked" ${panelState.unlinkedOnly ? 'checked' : ''}> غير مرتبط فقط
        </label>
        <label class="flex items-center gap-8" style="cursor:pointer;font-weight:700;font-size:12.5px;">
          <input type="checkbox" id="f-nocost" ${panelState.noCostOnly ? 'checked' : ''}> بدون تكلفة فقط
        </label>
        ${hasActiveFilters ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلاتر</button>` : ''}
      </div>` : ''}
      ${rows.length ? `
      <table class="data-table">
        <thead><tr>
          <th>اسم الصنف عند المورد</th><th>صنف ERP المرتبط</th><th class="num">التكلفة الحالية</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td data-label="اسم الصنف عند المورد"><b>${escapeHtml(r.supplierItemName)}</b></td>
              <td data-label="صنف ERP المرتبط">${r.erpItemId && erpById[r.erpItemId]
                  ? `<span class="badge badge-erp-yes">${escapeHtml(erpById[r.erpItemId].name)}</span>`
                  : `<span class="badge badge-warn">⚠️ غير مرتبط</span>`}</td>
              <td class="num" data-label="التكلفة الحالية">${fmtMoney(r.currentCost)}</td>
              <td class="flex gap-8">
                <button class="btn btn-sm btn-ghost btn-link" data-id="${r.id}">${r.erpItemId ? 'تغيير الربط' : 'ربط'}</button>
                <button class="btn btn-sm btn-ghost btn-cost" data-id="${r.id}">التكلفة</button>
                <button class="btn btn-sm btn-ghost btn-hist" data-id="${r.id}">السجل</button>
                <button class="btn btn-sm btn-ghost btn-del-mapping" data-id="${r.id}" data-name="${escapeHtml(r.supplierItemName)}">حذف</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <div class="empty-title">${allRows.length ? 'لا توجد أصناف مطابقة للفلاتر' : 'لا توجد أصناف مسجلة لهذا المورد بعد'}</div>
        <div class="empty-hint">${allRows.length ? 'جرّب مسح الفلاتر' : 'أضفها هنا أو ستُضاف تلقائيًا أول مرة تكتبها داخل مرتجعة'}</div>
      </div>`}
    </div>
  `;

  qs('#f-unlinked', container)?.addEventListener('change', (e) => { panelState.unlinkedOnly = e.target.checked; renderSupplierItemsPanel(container, supplierId); });
  qs('#f-nocost', container)?.addEventListener('change', (e) => { panelState.noCostOnly = e.target.checked; renderSupplierItemsPanel(container, supplierId); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => {
    panelState.unlinkedOnly = false; panelState.noCostOnly = false;
    renderSupplierItemsPanel(container, supplierId);
  });

  qs('#btn-add-mapping', container).addEventListener('click', () => openAddMappingModal(supplierId, () => renderSupplierItemsPanel(container, supplierId)));
  container.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-cost').forEach(b => b.addEventListener('click', () => openCostModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-hist').forEach(b => b.addEventListener('click', () => openHistoryModal(b.dataset.id)));
  container.querySelectorAll('.btn-del-mapping').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog(`سيتم حذف "${b.dataset.name}" وسجل تكلفته نهائيًا من هذا المورد. المرتجعات السابقة اللي استخدمته مش هتتأثر. هل أنت متأكد؟`, { danger: true, okLabel: 'حذف' });
    if (!ok) return;
    await deleteSupplierItem(b.dataset.id);
    await logAction('حذف صنف عند المورد', 'supplierItem', b.dataset.id, b.dataset.name);
    toast('تم الحذف', 'success');
    renderSupplierItemsPanel(container, supplierId);
  }));
}

function openAddMappingModal(supplierId, onDone) {
  const { close, node } = openModal({
    title: 'إضافة / تعديل صنف عند المورد',
    bodyHtml: `
      <div class="field autocomplete">
        <label>اسم الصنف كما يكتبه المورد *</label>
        <input type="text" id="f-name" placeholder="مثال: كريبسادة لوكس" autocomplete="off">
        <div class="autocomplete-list" id="name-results" style="display:none;"></div>
        <div class="hint">هيظهرلك أصناف مشابهة موجودة بالفعل عشان تتفادى تكرارها.</div>
      </div>
      <div class="field autocomplete">
        <label>ربط بصنف نظام ERP (اختياري)</label>
        <input type="text" id="f-erp-search" placeholder="اكتب اسم الصنف أو الباركود..." autocomplete="off">
        <div class="autocomplete-list" id="erp-results" style="display:none;"></div>
        <div class="small text-dim mt-8" id="erp-selected"></div>
      </div>
      <div class="field"><label>التكلفة عند هذا المورد (اختياري)</label><input type="number" step="0.01" id="f-cost" placeholder="0.00"></div>
    `,
    footerButtons: [
      { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
      {
        label: 'حفظ', className: 'btn-primary',
        onClick: async (c) => {
          const name = qs('#f-name', node).value.trim();
          if (!name) { toast('الاسم مطلوب', 'error'); return; }
          const si = await getOrCreateSupplierItem(supplierId, name);
          const erpItemId = qs('#f-erp-search', node).dataset.selectedId || '';
          if (erpItemId) await linkErpItem(si.id, erpItemId);
          const costVal = qs('#f-cost', node).value;
          // Re-read after the possible link above — passing the pre-link
          // `si` here would silently overwrite that link with the stale copy.
          if (costVal !== '') await updateCost(si.id, costVal);
          c(); onDone();
        },
      },
    ],
  });

  // Name field: suggest existing supplier items as you type, and — if
  // you pick one — quietly switch this into "editing that item" mode
  // (pre-filling its current link/cost) instead of risking a near-duplicate.
  const nameInput = qs('#f-name', node);
  const nameResults = qs('#name-results', node);
  const erpSearchInput = qs('#f-erp-search', node);
  const erpSelectedLabel = qs('#erp-selected', node);
  const costInput = qs('#f-cost', node);

  nameInput.addEventListener('input', debounce(async () => {
    const q = nameInput.value.trim();
    if (!q) { nameResults.style.display = 'none'; return; }
    const matches = await searchSupplierItems(supplierId, q, 6);
    if (!matches.length) { nameResults.style.display = 'none'; return; }
    nameResults.innerHTML = matches.map(m => `
      <div class="autocomplete-item" data-id="${m.id}" data-name="${escapeHtml(m.supplierItemName)}" data-cost="${m.currentCost || 0}" data-erp-id="${m.erpItemId || ''}" data-erp-name="${escapeHtml(m.erpItemName || '')}">
        <b>${escapeHtml(m.supplierItemName)}</b>
        <div class="ac-sub">موجود بالفعل — ${m.erpItemName ? escapeHtml(m.erpItemName) : 'غير مرتبط'} ${m.currentCost ? `· ${fmtMoney(m.currentCost)} ج` : ''}</div>
      </div>
    `).join('');
    nameResults.style.display = 'block';
    nameResults.querySelectorAll('.autocomplete-item').forEach(it => {
      it.addEventListener('click', () => {
        nameInput.value = it.dataset.name;
        costInput.value = Number(it.dataset.cost) || '';
        if (it.dataset.erpId) {
          erpSearchInput.value = it.dataset.erpName;
          erpSearchInput.dataset.selectedId = it.dataset.erpId;
          erpSelectedLabel.textContent = `✓ مرتبط حاليًا بـ ${it.dataset.erpName}`;
        } else {
          erpSearchInput.value = '';
          erpSearchInput.dataset.selectedId = '';
          erpSelectedLabel.textContent = '';
        }
        nameResults.style.display = 'none';
        toast('هتعدّل على الصنف الموجود بدل ما تضيف نسخة جديدة', 'default');
      });
    });
  }, 200));

  // ERP link field: same search-and-pick pattern as the standalone link modal.
  erpSearchInput.addEventListener('input', debounce(async () => {
    const q = erpSearchInput.value.trim();
    erpSearchInput.dataset.selectedId = ''; // typing invalidates any previous pick
    erpSelectedLabel.textContent = '';
    if (!q) { qs('#erp-results', node).style.display = 'none'; return; }
    const matches = await findErpItems(q, 6);
    const box = qs('#erp-results', node);
    if (!matches.length) { box.innerHTML = `<div class="autocomplete-empty">لا توجد نتائج</div>`; box.style.display = 'block'; return; }
    box.innerHTML = matches.map(m => `<div class="autocomplete-item" data-id="${m.id}" data-name="${escapeHtml(m.name)}"><b>${escapeHtml(m.name)}</b><div class="ac-sub">${escapeHtml(m.barcode || '')}</div></div>`).join('');
    box.style.display = 'block';
    box.querySelectorAll('.autocomplete-item').forEach(it => {
      it.addEventListener('click', () => {
        erpSearchInput.value = it.dataset.name;
        erpSearchInput.dataset.selectedId = it.dataset.id;
        erpSelectedLabel.textContent = `✓ ${it.dataset.name}`;
        box.style.display = 'none';
      });
    });
  }, 200));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete')) { nameResults.style.display = 'none'; qs('#erp-results', node).style.display = 'none'; }
  }, { once: true });

  nameInput.focus();
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
      <tbody>${hist.map(h => `<tr><td class="num" data-label="التكلفة">${fmtMoney(h.cost)}</td><td class="num text-dim" data-label="سارية من">${fmtDate(h.effectiveFrom, true)}</td></tr>`).join('')}</tbody></table>
    ` : `<div class="empty-state"><div class="empty-hint">لا يوجد سجل تكلفة بعد</div></div>`,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });
}

// ---------- UI: all suppliers' items in one screen, grouped by supplier ----------

const allItemsViewState = { query: '' };

export async function renderAllSupplierItemsView(container) {
  const [supplierItems, suppliers, erpItems] = await Promise.all([getAll('supplierItems'), getAll('suppliers'), getAll('erpItems')]);
  const erpById = Object.fromEntries(erpItems.map(i => [i.id, i]));
  const suppliersSorted = [...suppliers].sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="all-items-search" placeholder="🔎 بحث في اسم المورد أو الصنف" style="max-width:320px;" value="${escapeHtml(allItemsViewState.query)}">
        <div class="spacer"></div>
        <span class="small text-dim">${fmtInt(supplierItems.length)} صنف عند ${fmtInt(suppliers.length)} مورد</span>
      </div>
    </div>
    <div id="supplier-groups" class="mt-16"></div>
  `;

  function renderGroups() {
    const q = allItemsViewState.query;
    const groups = suppliersSorted
      .map(s => ({ supplier: s, items: supplierItems.filter(si => si.supplierId === s.id) }))
      .map(g => {
        if (!q || fuzzyIncludes(g.supplier.name, q)) return g; // supplier name matches (or no search) — keep all their items
        // otherwise narrow down to just the items that themselves match
        return { ...g, items: g.items.filter(i => fuzzyIncludes(i.supplierItemName, q) || (i.erpItemId && erpById[i.erpItemId] && fuzzyIncludes(erpById[i.erpItemId].name, q))) };
      })
      .filter(g => q ? (fuzzyIncludes(g.supplier.name, q) || g.items.length > 0) : g.items.length > 0);

    const groupsWrap = qs('#supplier-groups', container);
    if (!groups.length) {
      groupsWrap.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">🔎</div><div class="empty-title">لا توجد نتائج</div></div></div>`;
      return;
    }

    groupsWrap.innerHTML = groups.map(g => `
      <div class="card mb-16">
        <div class="card-header">
          <h3><a href="#/suppliers/${g.supplier.id}" style="color:inherit;">${escapeHtml(g.supplier.name)}</a></h3>
          <span class="small text-dim">${fmtInt(g.items.length)} صنف</span>
        </div>
        ${g.items.length ? `
        <table class="data-table">
          <thead><tr><th>اسم الصنف عند المورد</th><th>صنف ERP المرتبط</th><th class="num">التكلفة الحالية</th><th></th></tr></thead>
          <tbody>
            ${g.items.map(r => `
              <tr>
                <td data-label="اسم الصنف عند المورد"><b>${escapeHtml(r.supplierItemName)}</b></td>
                <td data-label="صنف ERP المرتبط">${r.erpItemId && erpById[r.erpItemId]
                    ? `<span class="badge badge-erp-yes">${escapeHtml(erpById[r.erpItemId].name)}</span>`
                    : `<span class="badge badge-warn">⚠️ غير مرتبط</span>`}</td>
                <td class="num" data-label="التكلفة الحالية">${fmtMoney(r.currentCost)}</td>
                <td class="flex gap-8">
                  <button class="btn btn-sm btn-ghost btn-link" data-id="${r.id}">${r.erpItemId ? 'تغيير الربط' : 'ربط'}</button>
                  <button class="btn btn-sm btn-ghost btn-cost" data-id="${r.id}">التكلفة</button>
                  <button class="btn btn-sm btn-ghost btn-hist" data-id="${r.id}">السجل</button>
                  <button class="btn btn-sm btn-ghost btn-del-mapping" data-id="${r.id}" data-name="${escapeHtml(r.supplierItemName)}">حذف</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : `<div class="empty-state"><div class="empty-hint">لا توجد أصناف مطابقة</div></div>`}
      </div>
    `).join('');

    groupsWrap.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderAllSupplierItemsView(container))));
    groupsWrap.querySelectorAll('.btn-cost').forEach(b => b.addEventListener('click', () => openCostModal(b.dataset.id, () => renderAllSupplierItemsView(container))));
    groupsWrap.querySelectorAll('.btn-hist').forEach(b => b.addEventListener('click', () => openHistoryModal(b.dataset.id)));
    groupsWrap.querySelectorAll('.btn-del-mapping').forEach(b => b.addEventListener('click', async () => {
      const ok = await confirmDialog(`سيتم حذف "${b.dataset.name}" وسجل تكلفته نهائيًا. المرتجعات السابقة اللي استخدمته مش هتتأثر. هل أنت متأكد؟`, { danger: true, okLabel: 'حذف' });
      if (!ok) return;
      await deleteSupplierItem(b.dataset.id);
      logAction('حذف صنف عند المورد', 'supplierItem', b.dataset.id, b.dataset.name).catch(err => console.error('audit log failed:', err));
      toast('تم الحذف', 'success');
      renderAllSupplierItemsView(container);
    }));
  }

  renderGroups();
  qs('#all-items-search', container).addEventListener('input', debounce((e) => { allItemsViewState.query = e.target.value; renderGroups(); }, 200));
}

// ---------- UI: standalone "unlinked items" route ----------

const unlinkedState = { supplierFilter: '' };

export async function renderUnlinkedView(container) {
  const all = await listUnlinked();
  const suppliers = [...new Map(all.map(r => [r.supplierId, r.supplierName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ar'));
  const rows = unlinkedState.supplierFilter ? all.filter(r => r.supplierId === unlinkedState.supplierFilter) : all;

  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h3>أصناف الموردين غير المرتبطة بنظام ERP</h3><span class="badge badge-warn">${rows.length}</span></div>
      ${suppliers.length ? `
      <div class="filter-bar">
        <label>المورد</label>
        <select id="unlinked-supplier-filter">
          <option value="">كل الموردين</option>
          ${suppliers.map(([id, name]) => `<option value="${id}" ${unlinkedState.supplierFilter === id ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
        </select>
        ${unlinkedState.supplierFilter ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلتر</button>` : ''}
      </div>` : ''}
      ${rows.length ? `
      <table class="data-table">
        <thead><tr><th>المورد</th><th>اسم الصنف عند المورد</th><th class="num">التكلفة</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td data-label="المورد">${escapeHtml(r.supplierName)}</td>
              <td data-label="اسم الصنف عند المورد"><b>${escapeHtml(r.supplierItemName)}</b></td>
              <td class="num" data-label="التكلفة">${fmtMoney(r.currentCost)}</td>
              <td><button class="btn btn-sm btn-primary btn-link" data-id="${r.id}">ربط الآن</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-title">${unlinkedState.supplierFilter ? 'لا توجد أصناف غير مرتبطة لهذا المورد' : 'كل أصناف الموردين مرتبطة'}</div>
        <div class="empty-hint">لا توجد أصناف تحتاج مراجعة حاليًا</div>
      </div>`}
    </div>
  `;
  container.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderUnlinkedView(container))));
  qs('#unlinked-supplier-filter', container)?.addEventListener('change', (e) => { unlinkedState.supplierFilter = e.target.value; renderUnlinkedView(container); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => { unlinkedState.supplierFilter = ''; renderUnlinkedView(container); });
}
