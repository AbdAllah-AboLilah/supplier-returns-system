// =========================================================
// modules/returns.js — مرتجعات الموردين
// Lifecycle: draft -> sent -> (erpRegistered) -> closed.
// Sending freezes the line items; "editingUnlocked" is a
// deliberate, logged, temporary override — sentAt itself is
// never erased. Unit cost on each line is copied from the
// supplier item at the moment it's added, so later cost
// changes never rewrite past returns.
// =========================================================
import { getAll, getById, getByIndex, put, remove, removeWhere, generateReturnNumber } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtDate, fmtInt, escapeHtml, fuzzyIncludes, debounce,
         openModal, confirmDialog, toast, el, qs, qsa, paginate, renderPagination } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { navigate } from '../core/router.js';
import { searchSupplierItems, getOrCreateSupplierItem } from './supplier-items.js';
import { autosaveField } from '../core/autosave.js';
import { openExportOptionsModal } from './return-export.js';

// ---------- Data access ----------

export async function listReturnsRaw() {
  return getAll('returns');
}

export async function getReturnItems(returnId) {
  return getByIndex('returnItems', 'returnId', returnId);
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
    return { ...r, supplierName: supplierById[r.supplierId]?.name || '—', itemCount: items.length, total };
  });
}

export async function getSupplierStats(supplierId) {
  const all = await listReturnsJoined();
  const mine = all.filter(r => r.supplierId === supplierId);
  const active = mine.filter(r => r.status !== 'closed');
  const sent = mine.filter(r => r.status === 'sent' || (r.status === 'closed' && r.sentAt));
  const unregistered = mine.filter(r => r.status === 'sent' && !r.erpRegistered);
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

export async function addItemLine(returnId, supplierId, supplierItemName, qty) {
  const si = await getOrCreateSupplierItem(supplierId, supplierItemName);
  let erpItemName = null;
  if (si.erpItemId) {
    const erp = await getById('erpItems', si.erpItemId);
    erpItemName = erp ? erp.name : null;
  }
  const unitCost = Number(si.currentCost) || 0;
  const quantity = Number(qty) || 1;
  const line = {
    id: uid(), returnId, supplierItemId: si.id, supplierItemName: si.supplierItemName,
    erpItemId: si.erpItemId || null, erpItemName, qty: quantity, unitCost, total: quantity * unitCost,
  };
  await put('returnItems', line);
  const ret = await getById('returns', returnId);
  await touchReturn(ret);
  await logAction('إضافة صنف للمرتجعة', 'return', returnId, `${si.supplierItemName} × ${quantity}`);
  return line;
}

export async function updateLine(lineId, { qty, unitCost }) {
  const line = await getById('returnItems', lineId);
  if (qty !== undefined) line.qty = Number(qty) || 0;
  if (unitCost !== undefined) line.unitCost = Number(unitCost) || 0;
  line.total = line.qty * line.unitCost;
  await put('returnItems', line);
  const ret = await getById('returns', line.returnId);
  await touchReturn(ret);
  return line;
}

export async function removeLine(lineId) {
  const line = await getById('returnItems', lineId);
  await remove('returnItems', lineId);
  const ret = await getById('returns', line.returnId);
  await touchReturn(ret);
  await logAction('حذف صنف من المرتجعة', 'return', line.returnId, line.supplierItemName);
}

export async function saveNotes(returnId, notes) {
  const ret = await getById('returns', returnId);
  ret.notes = notes;
  await touchReturn(ret);
}

export async function sendReturn(returnId) {
  const ret = await getById('returns', returnId);
  ret.status = 'sent';
  ret.locked = true;
  ret.editingUnlocked = false;
  ret.sentAt = nowIso();
  await touchReturn(ret);
  await logAction('إرسال المرتجعة', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function unlockForEditing(returnId) {
  const ret = await getById('returns', returnId);
  ret.editingUnlocked = true;
  await touchReturn(ret);
  await logAction('فتح المرتجعة للتعديل بعد الإرسال', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function relockAfterEditing(returnId) {
  const ret = await getById('returns', returnId);
  ret.editingUnlocked = false;
  ret.lastPostSendEditAt = nowIso();
  await touchReturn(ret);
  await logAction('إغلاق التعديل بعد الإرسال', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function markErpRegistered(returnId, transactionNumber) {
  const ret = await getById('returns', returnId);
  ret.erpRegistered = true;
  ret.erpRegisteredAt = nowIso();
  ret.erpTransactionNumber = transactionNumber || '';
  await touchReturn(ret);
  await logAction('تسجيل المرتجعة على ERP', 'return', returnId, transactionNumber ? `رقم الحركة: ${transactionNumber}` : '');
  return ret;
}

export async function unmarkErpRegistered(returnId) {
  const ret = await getById('returns', returnId);
  ret.erpRegistered = false;
  ret.erpRegisteredAt = null;
  await touchReturn(ret);
  await logAction('إلغاء تسجيل ERP', 'return', returnId, ret.returnNumber);
  return ret;
}

export async function setClosed(returnId, closed) {
  const ret = await getById('returns', returnId);
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

// ---------- UI: list views ----------

const listState = { page: 1, pageSize: 50, query: '', supplierFilter: '' };

const FILTER_LABELS = {
  active: 'المرتجعات النشطة',
  sent: 'المرتجعات المرسلة',
  unregistered: 'غير المسجلة على ERP',
  archive: 'الأرشيف',
};

function applyFilter(rows, key) {
  switch (key) {
    case 'active': return rows.filter(r => r.status !== 'closed');
    case 'sent': return rows.filter(r => r.status === 'sent');
    case 'unregistered': return rows.filter(r => r.status === 'sent' && !r.erpRegistered);
    case 'archive': return rows.filter(r => r.status === 'closed');
    default: return rows;
  }
}

function statusBadge(r) {
  if (r.status === 'closed') return `<span class="badge badge-closed">مغلقة</span>`;
  if (r.status === 'sent' && r.editingUnlocked) return `<span class="badge badge-editing">✏️ قيد التعديل</span>`;
  if (r.status === 'sent') return `<span class="badge badge-sent">🔒 تم الإرسال</span>`;
  return `<span class="badge badge-draft">مسودة</span>`;
}
function erpBadge(r) {
  if (r.status !== 'sent' && !r.erpRegistered) return `<span class="text-dim small">—</span>`;
  return r.erpRegistered ? `<span class="badge badge-erp-yes">🟢 مسجلة</span>` : `<span class="badge badge-erp-no">🔴 غير مسجلة</span>`;
}

export async function renderReturnsList(container, filterKey, presetSupplierId = null) {
  const all = await listReturnsJoined();
  const suppliers = await getAll('suppliers');
  let rows = applyFilter(all, filterKey);
  if (presetSupplierId) rows = rows.filter(r => r.supplierId === presetSupplierId);
  if (listState.supplierFilter && !presetSupplierId) rows = rows.filter(r => r.supplierId === listState.supplierFilter);
  if (listState.query) rows = rows.filter(r => fuzzyIncludes(r.returnNumber, listState.query) || fuzzyIncludes(r.supplierName, listState.query));
  rows = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="ret-search" placeholder="🔎 رقم المرتجعة أو المورد" style="max-width:240px;" value="${escapeHtml(listState.query)}">
        ${!presetSupplierId ? `
        <select id="ret-supplier-filter" style="max-width:200px;">
          <option value="">كل الموردين</option>
          ${suppliers.map(s => `<option value="${s.id}" ${listState.supplierFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>` : ''}
        <div class="spacer"></div>
        <button class="btn btn-primary" id="btn-new-return">+ مرتجعة جديدة</button>
      </div>
      ${rows.length ? `
      <table class="data-table">
        <thead><tr>
          <th>رقم المرتجعة</th><th>المورد</th><th>التاريخ</th><th class="num">عدد الأصناف</th><th class="num">القيمة</th><th>الحالة</th><th>ERP</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="row-link" data-id="${r.id}">
              <td class="text-mono">${escapeHtml(r.returnNumber)}</td>
              <td>${escapeHtml(r.supplierName)}</td>
              <td class="text-dim">${fmtDate(r.createdAt)}</td>
              <td class="num">${fmtInt(r.itemCount)}</td>
              <td class="num">${fmtMoney(r.total)}</td>
              <td>${statusBadge(r)}</td>
              <td>${erpBadge(r)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">↩︎</div>
        <div class="empty-title">لا توجد مرتجعات في ${escapeHtml(FILTER_LABELS[filterKey] || '')}</div>
        <div class="empty-hint">أنشئ مرتجعة جديدة للبدء</div>
      </div>`}
    </div>
  `;

  container.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', () => navigate(`/returns/${row.dataset.id}`)));
  qs('#ret-search', container).addEventListener('input', debounce((e) => { listState.query = e.target.value; renderReturnsList(container, filterKey, presetSupplierId); }, 200));
  const sf = qs('#ret-supplier-filter', container);
  if (sf) sf.addEventListener('change', () => { listState.supplierFilter = sf.value; renderReturnsList(container, filterKey, presetSupplierId); });
  qs('#btn-new-return', container).addEventListener('click', () => openNewReturnModal(presetSupplierId));
}

async function openNewReturnModal(presetSupplierId) {
  const suppliers = await getAll('suppliers');
  if (!suppliers.length) { toast('أضف موردًا أولًا من صفحة الموردين', 'error'); return; }
  const { close, node } = openModal({
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
        onClick: async (c) => {
          const supplierId = qs('#f-supplier', node).value;
          const ret = await createDraftReturn(supplierId);
          c();
          navigate(`/returns/${ret.id}`);
        },
      },
    ],
  });
}

// ---------- UI: detail / edit screen ----------

export async function renderReturnDetail(container, returnId) {
  const ret = await getById('returns', returnId);
  if (!ret) { container.innerHTML = `<div class="card card-pad">المرتجعة غير موجودة.</div>`; return; }
  const supplier = await getById('suppliers', ret.supplierId);
  const lines = await getReturnItems(returnId);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const totalValue = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const editable = ret.status === 'draft' || ret.editingUnlocked;

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
      <div class="card-header"><h3>الأصناف</h3><span class="small text-dim">${fmtInt(lines.length)} صنف · حفظ تلقائي أثناء الكتابة</span></div>
      ${lines.length ? `
      <table class="data-table">
        <thead><tr>
          <th>اسم الصنف عند المورد</th><th>صنف النظام ERP</th><th class="num">الكمية</th><th class="num">تكلفة المورد</th><th class="num">الإجمالي</th>${editable ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${lines.map(l => `
            <tr data-line="${l.id}">
              <td><b>${escapeHtml(l.supplierItemName)}</b></td>
              <td>${l.erpItemName ? escapeHtml(l.erpItemName) : `<span class="badge badge-warn">⚠️ غير مرتبط</span>`}</td>
              <td class="num">${editable ? `<input type="number" min="0" step="1" class="line-qty" data-id="${l.id}" value="${l.qty}" style="width:80px;text-align:center;">` : fmtInt(l.qty)}</td>
              <td class="num">${editable ? `<input type="number" min="0" step="0.01" class="line-cost" data-id="${l.id}" value="${l.unitCost}" style="width:100px;text-align:center;">` : fmtMoney(l.unitCost)}</td>
              <td class="num text-mono" id="line-total-${l.id}">${fmtMoney(l.total)}</td>
              ${editable ? `<td><button class="btn btn-sm btn-ghost line-remove" data-id="${l.id}">حذف</button></td>` : ''}
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2"><b>الإجمالي</b></td>
            <td class="num text-mono" id="footer-total-qty">${fmtInt(totalQty)}</td>
            <td></td>
            <td class="num text-mono" id="footer-total-value"><b>${fmtMoney(totalValue)}</b></td>
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
          </div>
          <div class="field" style="flex:0 0 100px;"><label>الكمية</label><input type="number" id="add-item-qty" value="1" min="1"></div>
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
        ${ret.status === 'sent' ? `
          ${ret.erpRegistered
            ? `<span class="badge badge-erp-yes">🟢 مسجلة على ERP${ret.erpTransactionNumber ? ` — رقم الحركة: <span class="text-mono">${escapeHtml(ret.erpTransactionNumber)}</span>` : ''}</span>
               <button class="btn btn-sm btn-ghost" id="btn-unerp">إلغاء التسجيل</button>`
            : `<span class="badge badge-erp-no">🔴 لم تُسجل على ERP بعد</span>
               <button class="btn btn-sm btn-gold" id="btn-erp">✓ تم التسجيل على ERP</button>`}
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

function wireDetailEvents(container, ret, lines, supplier) {
  qs('#btn-delete', container)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`سيتم حذف المرتجعة ${ret.returnNumber} نهائيًا. هل أنت متأكد؟`, { danger: true }))) return;
    await deleteReturn(ret.id);
    toast('تم حذف المرتجعة', 'success');
    navigate('/returns/active');
  });

  qs('#btn-unlock', container)?.addEventListener('click', async () => {
    if (!(await confirmDialog('هل تريد فتح المرتجعة للتعديل؟ سيبقى تاريخ الإرسال الأصلي محفوظًا.'))) return;
    await unlockForEditing(ret.id);
    renderReturnDetail(container, ret.id);
  });
  qs('#btn-relock', container)?.addEventListener('click', async () => {
    await relockAfterEditing(ret.id);
    toast('تم إعادة القفل', 'success');
    renderReturnDetail(container, ret.id);
  });

  qsa('.line-qty', container).forEach(inp => autosaveField(inp, async (val) => {
    await updateLine(inp.dataset.id, { qty: val });
    recalcRowAndTotals(container, inp.dataset.id);
  }, { delay: 500 }));
  qsa('.line-cost', container).forEach(inp => autosaveField(inp, async (val) => {
    await updateLine(inp.dataset.id, { unitCost: val });
    recalcRowAndTotals(container, inp.dataset.id);
  }, { delay: 500 }));
  qsa('.line-remove', container).forEach(b => b.addEventListener('click', async () => {
    await removeLine(b.dataset.id);
    renderReturnDetail(container, ret.id);
  }));

  const nameInput = qs('#add-item-name', container);
  const resultsBox = qs('#add-item-results', container);
  if (nameInput) {
    nameInput.addEventListener('input', debounce(async () => {
      const q = nameInput.value.trim();
      if (!q) { resultsBox.style.display = 'none'; return; }
      const matches = await searchSupplierItems(ret.supplierId, q, 8);
      const exact = matches.some(m => m.supplierItemName.trim().toLowerCase() === q.toLowerCase());
      let html = matches.map(m => `
        <div class="autocomplete-item" data-name="${escapeHtml(m.supplierItemName)}">
          <b>${escapeHtml(m.supplierItemName)}</b>
          <div class="ac-sub">${m.erpItemName || (m.erpItemId ? '' : '⚠️ غير مرتبط بعد')} ${m.currentCost ? `· ${fmtMoney(m.currentCost)} ج` : ''}</div>
        </div>
      `).join('');
      if (!exact) html += `<div class="autocomplete-item" data-name="${escapeHtml(q)}" style="color:var(--gold-dark);">+ إضافة "${escapeHtml(q)}" كصنف جديد لهذا المورد</div>`;
      resultsBox.innerHTML = html || `<div class="autocomplete-empty">لا توجد نتائج</div>`;
      resultsBox.style.display = 'block';
      resultsBox.querySelectorAll('.autocomplete-item').forEach(it => {
        it.addEventListener('click', () => { nameInput.value = it.dataset.name; resultsBox.style.display = 'none'; });
      });
    }, 200));
    document.addEventListener('click', (e) => { if (!e.target.closest('.autocomplete')) resultsBox.style.display = 'none'; }, { once: true });
  }

  qs('#btn-add-item', container)?.addEventListener('click', async () => {
    const name = qs('#add-item-name', container).value.trim();
    const qty = qs('#add-item-qty', container).value;
    if (!name) { toast('اكتب اسم الصنف أولًا', 'error'); return; }
    await addItemLine(ret.id, ret.supplierId, name, qty);
    await renderReturnDetail(container, ret.id);
    qs('#add-item-name', container)?.focus();
  });

  const notesInput = qs('#ret-notes', container);
  if (notesInput) autosaveField(notesInput, (val) => saveNotes(ret.id, val), { statusEl: qs('#notes-status', container) });

  qs('#btn-export', container)?.addEventListener('click', () => openExportOptionsModal(ret, lines, supplier));

  qs('#btn-send', container)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`سيتم إرسال المرتجعة ${ret.returnNumber} للمورد وقفل الأصناف. هل أنت متأكد؟`))) return;
    await sendReturn(ret.id);
    toast('تم إرسال المرتجعة', 'success');
    renderReturnDetail(container, ret.id);
  });

  qs('#btn-erp', container)?.addEventListener('click', () => {
    openModal({
      title: 'تسجيل المرتجعة على ERP',
      bodyHtml: `<div class="field"><label>رقم حركة ERP (اختياري)</label><input type="text" id="f-erp-num" placeholder="مثال: ERP-RET-45281"></div>`,
      footerButtons: [
        { label: 'إلغاء', className: 'btn-ghost', onClick: (c) => c() },
        { label: 'تأكيد التسجيل', className: 'btn-gold', onClick: async (c) => {
            await markErpRegistered(ret.id, qs('#f-erp-num').value.trim());
            toast('تم تسجيل المرتجعة على ERP', 'success');
            c(); renderReturnDetail(container, ret.id);
          } },
      ],
    });
  });
  qs('#btn-unerp', container)?.addEventListener('click', async () => {
    if (!(await confirmDialog('هل تريد إلغاء تعليم هذه المرتجعة كمسجلة على ERP؟'))) return;
    await unmarkErpRegistered(ret.id);
    renderReturnDetail(container, ret.id);
  });

  qs('#btn-archive', container)?.addEventListener('click', async () => { await setClosed(ret.id, true); toast('تم نقل المرتجعة للأرشيف', 'success'); renderReturnDetail(container, ret.id); });
  qs('#btn-reopen', container)?.addEventListener('click', async () => { await setClosed(ret.id, false); renderReturnDetail(container, ret.id); });
}
