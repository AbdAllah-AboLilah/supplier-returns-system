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
import { getAll, getById, getByIndex, put, bulkPut, remove, removeWhere } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtInt, fmtDate, escapeHtml, fuzzyIncludes, normalizeArabic, debounce,
         openModal, confirmDialog, toast, qs, closeOnOutsideClick, guarded, submitOnce } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { findErpItems } from './item-links.js';
import { getUnits, multiplierOf } from '../core/units.js';

// ---------- Data access ----------

export async function listBySupplier(supplierId) {
  const rows = await getByIndex('supplierItems', 'supplierId', supplierId);
  return rows.sort((a, b) => (a.supplierItemName || '').localeCompare(b.supplierItemName || '', 'ar'));
}

export async function searchSupplierItems(supplierId, query, limit = 8) {
  const rows = await listBySupplier(supplierId);
  const filtered = rows.filter(r => fuzzyIncludes(r.supplierItemName, query)).slice(0, limit);
  // Only the handful of rows about to be shown need their ERP item, so
  // don't pull the whole catalog when nothing matched at all.
  if (!filtered.length) return [];
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

async function createSupplierItem(supplierId, name, erpItemId = null, sharedCost = 0) {
  const record = {
    id: uid(), supplierId, supplierItemName: name.trim(),
    erpItemId: erpItemId || null,
    // A new row under a name that already has a price starts on that
    // price — it is the same thing from the supplier, just filed
    // against a different ERP item.
    currentCost: Number(sharedCost) || 0,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  await put('supplierItems', record);
  logAction('إضافة اسم صنف عند المورد', 'supplierItem', record.id, name).catch(err => console.error('audit log failed:', err));
  return record;
}

// What identifies a supplier's item is the pair (its name, the ERP item it
// maps to) — not the name on its own. One supplier can call a single thing
// by one name while the shop splits it across several ERP items, so the
// same name legitimately appears more than once with different links.
//
// Without an explicit link the name is all there is to go on, so a single
// match is reused and several matches are refused rather than guessed at:
// picking the wrong one would quietly file a return against the wrong ERP
// item. Name matching uses the same normalization as search (diacritics,
// tatweel, alef/ya/ta-marbuta variants, whitespace), which is what
// recognizes "كريبسادة" and "كريب سادة" as one name.
export async function getOrCreateSupplierItem(supplierId, name, { erpItemId = null } = {}) {
  const rows = await listBySupplier(supplierId);
  const target = normalizeArabic(name);
  const sameName = rows.filter(r => normalizeArabic(r.supplierItemName) === target);

  if (erpItemId) {
    const sameLink = sameName.find(r => (r.erpItemId || null) === erpItemId);
    if (sameLink) return sameLink;
    // A row of this name with no link yet is the one being completed,
    // not a different item — the caller links it straight after.
    const unlinked = sameName.find(r => !r.erpItemId);
    if (unlinked) return unlinked;
    const sharedCost = sameName.find(r => Number(r.currentCost) > 0)?.currentCost || 0;
    return createSupplierItem(supplierId, name, erpItemId, sharedCost);
  }

  if (sameName.length > 1) {
    throw new Error(`"${name.trim()}" متسجّل أكتر من مرة عند المورد ده بأصناف ERP مختلفة — اختاره من قائمة الاقتراحات عشان النظام يعرف تقصد أنهي واحد.`);
  }
  if (sameName.length === 1) return sameName[0];
  return createSupplierItem(supplierId, name);
}

export async function linkErpItem(supplierItemId, erpItemId) {
  const row = await getById('supplierItems', supplierItemId);
  if (!row) throw new Error('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.');
  row.erpItemId = erpItemId;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  const erp = await getById('erpItems', erpItemId);
  logAction('ربط صنف مورد بصنف ERP', 'supplierItem', supplierItemId, `${row.supplierItemName} → ${erp?.name || ''}`).catch(err => console.error('audit log failed:', err));
  return row;
}

export async function unlinkErpItem(supplierItemId) {
  const row = await getById('supplierItems', supplierItemId);
  if (!row) throw new Error('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.');
  row.erpItemId = null;
  row.updatedAt = nowIso();
  await put('supplierItems', row);
  logAction('فك ربط صنف مورد', 'supplierItem', supplierItemId, row.supplierItemName).catch(err => console.error('audit log failed:', err));
  return row;
}

// Every row a supplier sells under one name. The name can be linked to
// several ERP items — حجاب سوري filed as أبيض and أسود — but the supplier
// still quotes one price for it, so those rows share a cost.
export async function costSiblings(row) {
  const rows = await listBySupplier(row.supplierId);
  const target = normalizeArabic(row.supplierItemName);
  const matches = rows.filter(r => normalizeArabic(r.supplierItemName) === target);
  return matches.length ? matches : [row];
}

export async function updateCost(supplierItemId, newCost, preloaded = null) {
  // Cost edits happen constantly while filling in a return, so this is
  // the hottest write path in the app — every extra round trip here is
  // felt directly as typing lag. Skip the re-read when the caller
  // already has the record (returns.js does), and don't block on the
  // history/audit-log writes: they matter for the record, not for
  // confirming *this* save succeeded, so let them finish in the background.
  const row = preloaded || await getById('supplierItems', supplierItemId);
  if (!row) throw new Error('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.');
  const oldCost = Number(row.currentCost) || 0;
  const nextCost = Number(newCost) || 0;

  // One name at one supplier is one price: changing it on any of the rows
  // that share the name changes it on all of them.
  const siblings = await costSiblings(row);
  // Saving the same number again is not a price change: it used to still
  // cost a write *and* append a meaningless row to the cost history (so a
  // history could fill up with the same figure repeated).
  const changed = siblings.filter(r => (Number(r.currentCost) || 0) !== nextCost);
  if (!changed.length) return { item: row, updatedCount: 0 };

  const stamp = nowIso();
  const updated = changed.map(r => ({ ...r, currentCost: nextCost, updatedAt: stamp }));
  await bulkPut('supplierItems', updated);
  bulkPut('costHistory', updated.map(r => ({
    id: uid(), supplierItemId: r.id, cost: nextCost, effectiveFrom: stamp, createdAt: stamp,
  }))).catch(err => console.error('cost history write failed:', err));
  logAction('تحديث تكلفة المورد', 'supplierItem', supplierItemId,
    `${row.supplierItemName}: ${fmtMoney(oldCost)} ← ${fmtMoney(nextCost)}${updated.length > 1 ? ` (${updated.length} أصناف بنفس الاسم)` : ''}`)
    .catch(err => console.error('audit log failed:', err));

  return { item: updated.find(r => r.id === row.id) || updated[0], updatedCount: updated.length };
}

export async function getCostHistory(supplierItemId) {
  const rows = await getByIndex('costHistory', 'supplierItemId', supplierItemId);
  return rows.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export async function deleteSupplierItem(supplierItemId) {
  // Independent of each other — waiting for the first before starting
  // the second doubled the wait, which showed up when deleting a
  // supplier that had dozens of items.
  await Promise.all([
    remove('supplierItems', supplierItemId),
    removeWhere('costHistory', 'supplierItemId', supplierItemId),
  ]);
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

  qs('#btn-add-mapping', container).addEventListener('click', guarded(() => openAddMappingModal(supplierId, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-cost').forEach(b => b.addEventListener('click', () => openCostModal(b.dataset.id, () => renderSupplierItemsPanel(container, supplierId))));
  container.querySelectorAll('.btn-hist').forEach(b => b.addEventListener('click', () => openHistoryModal(b.dataset.id)));
  container.querySelectorAll('.btn-del-mapping').forEach(b => b.addEventListener('click', guarded(async () => {
    const ok = await confirmDialog(`سيتم حذف "${b.dataset.name}" وسجل تكلفته نهائيًا من هذا المورد. المرتجعات السابقة اللي استخدمته مش هتتأثر. هل أنت متأكد؟`, { danger: true, okLabel: 'حذف' });
    if (!ok) return;
    await deleteSupplierItem(b.dataset.id);
    await logAction('حذف صنف عند المورد', 'supplierItem', b.dataset.id, b.dataset.name);
    toast('تم الحذف', 'success');
    renderSupplierItemsPanel(container, supplierId);
  })));
}

// Markup for a cost field paired with a unit selector. What is stored is
// always the piece cost; this lets the number be typed in whichever unit
// the supplier actually quotes.
function costUnitFieldsHtml(units, { label = 'التكلفة', costId = 'f-cost', unitId = 'f-cost-unit', value = '' } = {}) {
  return `
    <div class="form-row" style="align-items:flex-end;">
      <div class="field" style="flex:1;">
        <label>${escapeHtml(label)}</label>
        <input type="number" step="0.01" min="0" id="${costId}" value="${value}" placeholder="0.00">
      </div>
      <div class="field" style="flex:0 0 130px;">
        <label>السعر ده بالـ</label>
        <select id="${unitId}">
          ${units.map(u => `<option value="${escapeHtml(u.key)}">${escapeHtml(u.label)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="hint" id="${costId}-preview"></div>
  `;
}

// Keeps the piece cost as the real value behind the pair of controls.
// Switching the unit re-expresses the same cost rather than reinterpreting
// the number already typed — 77.50 بالقطعة becomes 930.00 بالدستة — and the
// hint always spells out what will actually be saved.
function wireCostUnitField(node, units, { costId = 'f-cost', unitId = 'f-cost-unit', initialPieceCost = 0 } = {}) {
  const costInput = qs(`#${costId}`, node);
  const unitSelect = qs(`#${unitId}`, node);
  const preview = qs(`#${costId}-preview`, node);
  let pieceCost = Number(initialPieceCost) || 0;
  let multiplier = multiplierOf(units, unitSelect.value);

  const tidy = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

  function renderPreview() {
    if (!costInput.value) { preview.textContent = ''; return; }
    preview.textContent = multiplier === 1
      ? 'هيتحفظ زي ما هو كسعر القطعة.'
      : `سعر القطعة اللي هيتحفظ: ${fmtMoney(pieceCost)}`;
  }

  costInput.addEventListener('input', () => {
    pieceCost = costInput.value === '' ? 0 : (Number(costInput.value) || 0) / multiplier;
    renderPreview();
  });

  unitSelect.addEventListener('change', () => {
    multiplier = multiplierOf(units, unitSelect.value);
    if (costInput.value !== '') costInput.value = tidy(pieceCost * multiplier);
    renderPreview();
  });

  renderPreview();
  return {
    // '' when nothing was typed, so callers can tell "no cost given" from zero.
    pieceCost: () => (costInput.value === '' ? '' : pieceCost),
  };
}

async function openAddMappingModal(supplierId, onDone) {
  const units = await getUnits();
  const { node, onClose, close } = openModal({
    title: 'إضافة / تعديل صنف عند المورد',
    bodyHtml: `
      <div class="field autocomplete">
        <label>اسم الصنف كما يكتبه المورد *</label>
        <input type="text" id="f-name" placeholder="مثال: كريبسادة لوكس" autocomplete="off">
        <div class="autocomplete-list" id="name-results" style="display:none;"></div>
        <div class="hint">هيظهرلك أصناف مشابهة موجودة بالفعل. اختار واحد منها عشان تعدّل عليه، أو سيب الاسم زي ما هو واربطه بصنف ERP تاني — وقتها هيتسجّل كصنف منفصل.</div>
      </div>
      <div class="field autocomplete">
        <label>ربط بصنف نظام ERP (اختياري)</label>
        <input type="text" id="f-erp-search" placeholder="اكتب اسم الصنف أو الباركود..." autocomplete="off">
        <div class="autocomplete-list" id="erp-results" style="display:none;"></div>
        <div class="small text-dim mt-8" id="erp-selected"></div>
      </div>
      ${costUnitFieldsHtml(units, { label: 'التكلفة عند هذا المورد (اختياري)' })}
    `,
    footerButtons: [
      { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
      {
        label: 'حفظ', className: 'btn-primary',
        onClick: (c) => saveMapping(c),
      },
    ],
  });

  // Name field: suggest existing supplier items as you type, and — if
  // you pick one — quietly switch this into "editing that item" mode
  // (pre-filling its current link/cost) instead of risking a near-duplicate.
  const nameInput = qs('#f-name', node);
  const nameResults = qs('#name-results', node);

  async function saveMapping(close) {
    const name = qs('#f-name', node).value.trim();
    if (!name) { toast('الاسم مطلوب', 'error'); return; }
    const erpItemId = qs('#f-erp-search', node).dataset.selectedId || '';
    // Picking a suggestion means "edit this one" — including relinking it.
    // Typing a name that merely happens to exist means the (name, ERP item)
    // pair decides, so a different link becomes a separate item.
    const pickedId = nameInput.dataset.existingId || '';
    const si = pickedId
      ? await getById('supplierItems', pickedId)
      : await getOrCreateSupplierItem(supplierId, name, { erpItemId });
    if (!si) { toast('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.', 'error'); return; }
    if (erpItemId && (si.erpItemId || null) !== erpItemId) await linkErpItem(si.id, erpItemId);
    const costVal = costField.pieceCost();
    // Re-read inside updateCost after the possible link above — passing the
    // pre-link `si` would silently overwrite that link with the stale copy.
    if (costVal !== '') await updateCost(si.id, costVal);
    close(); onDone();
  }
  const erpSearchInput = qs('#f-erp-search', node);
  const erpSelectedLabel = qs('#erp-selected', node);
  const costInput = qs('#f-cost', node);
  const costField = wireCostUnitField(node, units);

  nameInput.addEventListener('input', () => { nameInput.dataset.existingId = ''; });
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
        nameInput.dataset.existingId = it.dataset.id; // editing this exact row
        // The stored cost is always per piece, so show it that way.
        qs('#f-cost-unit', node).value = units[0]?.key || 'piece';
        costInput.value = Number(it.dataset.cost) || '';
        costInput.dispatchEvent(new Event('input'));
        qs('#f-cost-unit', node).dispatchEvent(new Event('change'));
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
        toast('هتعدّل على الصنف الموجود ده', 'default');
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

  onClose(closeOnOutsideClick([nameResults, qs('#erp-results', node)]));

  const saveButton = qs('.modal-footer .btn-primary', node);
  const guardedSave = submitOnce(saveButton, saveMapping, { busyLabel: 'جارِ الحفظ...' });
  saveButton.addEventListener('click', (e) => { e.stopImmediatePropagation(); guardedSave(close); }, true);

  nameInput.focus();
}

export function openLinkModal(supplierItemId, onDone) {
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
    // fuzzyIncludes() treats an empty needle as "matches everything", so
    // without this an emptied box listed 8 arbitrary items as if they
    // were search results.
    if (!input.value.trim()) { results.style.display = 'none'; return; }
    const matches = await findErpItems(input.value, 8);
    if (!matches.length) { results.innerHTML = `<div class="autocomplete-empty">لا توجد نتائج</div>`; results.style.display = 'block'; return; }
    results.innerHTML = matches.map(m => `<div class="autocomplete-item" data-id="${m.id}"><b>${escapeHtml(m.name)}</b><div class="ac-sub">${escapeHtml(m.barcode || '')}</div></div>`).join('');
    results.style.display = 'block';
    results.querySelectorAll('.autocomplete-item').forEach(it => {
      it.addEventListener('click', guarded(async () => { await linkErpItem(supplierItemId, it.dataset.id); toast('تم الربط', 'success'); close(); onDone(); }));
    });
  }, 200));
  input.focus();
}

function openCostModal(supplierItemId, onDone) {
  getById('supplierItems', supplierItemId).then(async (row) => {
    if (!row) { toast('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.', 'error'); return; }
    const [units, siblings] = await Promise.all([getUnits(), costSiblings(row)]);
    const sharedWith = siblings.length - 1;
    const { node } = openModal({
      title: `تكلفة "${row.supplierItemName}"`,
      bodyHtml: `
        ${costUnitFieldsHtml(units, { label: 'التكلفة الحالية', value: row.currentCost })}
        ${sharedWith > 0 ? `<div class="hint" style="color:var(--gold-dark);font-weight:700;">
          التكلفة دي مشتركة مع ${sharedWith} صنف تاني بنفس الاسم عند المورد (مربوطين بأصناف ERP مختلفة) — التغيير هيطبّق عليهم كلهم.
        </div>` : ''}
        <div class="hint">لو المورد مسعّر بالدستة، اختار "دستة" واكتب سعر الدستة — النظام هيحسب سعر القطعة ويحفظه.</div>
        <div class="hint">تحديث التكلفة يبدأ سريانه من الآن فقط. المرتجعات السابقة تحتفظ بالتكلفة وقت إنشائها ولا تتأثر.</div>
      `,
      footerButtons: [
        { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
        {
          label: 'حفظ', className: 'btn-primary',
          onClick: async (c) => {
            const cost = costField.pieceCost();
            if (cost === '') { toast('اكتب التكلفة أولًا', 'error'); return; }
            const button = qs('.modal-footer .btn-primary', node);
            await submitOnce(button, async () => {
              const { updatedCount } = await updateCost(supplierItemId, cost);
              toast(updatedCount > 1 ? `تم تحديث التكلفة في ${updatedCount} أصناف بنفس الاسم` : 'تم تحديث التكلفة', 'success');
              c(); onDone();
            })();
          },
        },
      ],
    });
    const costField = wireCostUnitField(node, units, { initialPieceCost: row.currentCost });
  });
}

async function openHistoryModal(supplierItemId) {
  const row = await getById('supplierItems', supplierItemId);
  if (!row) { toast('الصنف ده مش موجود — يمكن يكون اتحذف من جهاز تاني.', 'error'); return; }
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

// A shop with a few thousand supplier items used to render every single
// row of every supplier in one pass, which is what made this screen slow
// to open and slow to scroll. Each supplier shows a first page of rows
// and expands on demand.
const GROUP_ROW_CAP = 50;
const allItemsViewState = { query: '', expanded: new Set() };

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

    groupsWrap.innerHTML = groups.map(g => {
      const expanded = allItemsViewState.expanded.has(g.supplier.id);
      const shown = expanded ? g.items : g.items.slice(0, GROUP_ROW_CAP);
      const hidden = g.items.length - shown.length;
      return `
      <div class="card mb-16">
        <div class="card-header">
          <h3><a href="#/suppliers/${g.supplier.id}" style="color:inherit;">${escapeHtml(g.supplier.name)}</a></h3>
          <div class="flex items-center gap-8">
            <span class="small text-dim">${fmtInt(g.items.length)} صنف</span>
            <button class="btn btn-sm btn-primary btn-add-for-supplier" data-supplier-id="${g.supplier.id}">+ إضافة صنف</button>
          </div>
        </div>
        ${g.items.length ? `
        <table class="data-table">
          <thead><tr><th>اسم الصنف عند المورد</th><th>صنف ERP المرتبط</th><th class="num">التكلفة الحالية</th><th></th></tr></thead>
          <tbody>
            ${shown.map(r => `
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
        </table>
        ${hidden > 0 ? `<div class="card-pad" style="border-top:1px solid var(--line);text-align:center;">
          <button class="btn btn-ghost btn-sm btn-expand-group" data-supplier-id="${g.supplier.id}">عرض باقي الأصناف (${fmtInt(hidden)})</button>
        </div>` : ''}` : `<div class="empty-state"><div class="empty-hint">لا توجد أصناف مطابقة</div></div>`}
      </div>
    `;
    }).join('');

    groupsWrap.querySelectorAll('.btn-expand-group').forEach(b => b.addEventListener('click', () => {
      allItemsViewState.expanded.add(b.dataset.supplierId);
      renderGroups();
    }));
    groupsWrap.querySelectorAll('.btn-add-for-supplier').forEach(b => b.addEventListener('click', guarded(() => openAddMappingModal(b.dataset.supplierId, () => renderAllSupplierItemsView(container)))));
    groupsWrap.querySelectorAll('.btn-link').forEach(b => b.addEventListener('click', () => openLinkModal(b.dataset.id, () => renderAllSupplierItemsView(container))));
    groupsWrap.querySelectorAll('.btn-cost').forEach(b => b.addEventListener('click', () => openCostModal(b.dataset.id, () => renderAllSupplierItemsView(container))));
    groupsWrap.querySelectorAll('.btn-hist').forEach(b => b.addEventListener('click', () => openHistoryModal(b.dataset.id)));
    groupsWrap.querySelectorAll('.btn-del-mapping').forEach(b => b.addEventListener('click', guarded(async () => {
      const ok = await confirmDialog(`سيتم حذف "${b.dataset.name}" وسجل تكلفته نهائيًا. المرتجعات السابقة اللي استخدمته مش هتتأثر. هل أنت متأكد؟`, { danger: true, okLabel: 'حذف' });
      if (!ok) return;
      await deleteSupplierItem(b.dataset.id);
      logAction('حذف صنف عند المورد', 'supplierItem', b.dataset.id, b.dataset.name).catch(err => console.error('audit log failed:', err));
      toast('تم الحذف', 'success');
      renderAllSupplierItemsView(container);
    })));
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
