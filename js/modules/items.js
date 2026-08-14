// =========================================================
// modules/items.js — قاعدة أصناف ERP
// The base item catalog. Item identity is the generated `id`
// (never the name) so renames never break links from suppliers.
// =========================================================
import { getAll, getById, put, remove, getByIndex } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtInt, escapeHtml, debounce, fuzzyIncludes,
         openModal, confirmDialog, toast, paginate, renderPagination, el, qs } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { navigate } from '../core/router.js';
import { autosaveField } from '../core/autosave.js';
import { listErpSupplierRelations, unlinkAllSuppliersFromErpItem } from './item-links.js';

const state = { page: 1, pageSize: 50, query: '', category: '', linked: '' };

export async function getErpItemsCount() {
  return (await getAll('erpItems')).length;
}

export async function renderItemsList(container) {
  const all = await getAll('erpItems');
  const supplierLinks = await getAll('supplierItems');
  const linkCountByErp = {};
  supplierLinks.forEach(si => { if (si.erpItemId) linkCountByErp[si.erpItemId] = (linkCountByErp[si.erpItemId] || 0) + 1; });

  const categories = [...new Set(all.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));

  const filtered = all
    .filter(i => fuzzyIncludes(i.name, state.query) || fuzzyIncludes(i.barcode || '', state.query))
    .filter(i => !state.category || i.category === state.category)
    .filter(i => !state.linked || (state.linked === 'linked' ? !!linkCountByErp[i.id] : !linkCountByErp[i.id]))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));

  const hasActiveFilters = !!(state.category || state.linked);

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="items-search" placeholder="🔎 بحث بالاسم أو الباركود" style="max-width:280px;" value="${escapeHtml(state.query)}">
        <div class="spacer"></div>
        <a href="#/items/import" class="btn btn-ghost">⇪ استيراد من Excel</a>
        <button class="btn btn-primary" id="btn-add-item">+ إضافة صنف</button>
      </div>
      <div class="filter-bar">
        ${categories.length ? `
        <label>القسم</label>
        <select id="items-category-filter">
          <option value="">كل الأقسام</option>
          ${categories.map(c => `<option value="${escapeHtml(c)}" ${state.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>` : ''}
        <label>الربط بالموردين</label>
        <select id="items-linked-filter">
          <option value="">الكل</option>
          <option value="linked" ${state.linked === 'linked' ? 'selected' : ''}>مرتبط بمورد واحد على الأقل</option>
          <option value="unlinked" ${state.linked === 'unlinked' ? 'selected' : ''}>غير مرتبط بأي مورد</option>
        </select>
        ${hasActiveFilters ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلاتر</button>` : ''}
      </div>
      ${filtered.length ? `
      <div class="table-wrap" style="border:none;border-radius:0;">
        <table class="data-table">
          <thead><tr>
            <th>اسم الصنف</th><th>الباركود</th><th class="num">التكلفة الأساسية</th><th class="num">عدد الموردين المرتبطين</th><th></th>
          </tr></thead>
          <tbody id="items-tbody"></tbody>
        </table>
      </div>` : `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <div class="empty-title">لا توجد أصناف مطابقة</div>
        <div class="empty-hint">${hasActiveFilters ? 'جرّب توسيع نطاق الفلاتر' : 'أضف صنفًا يدويًا أو استورد قائمة من Excel'}</div>
      </div>`}
      <div id="items-pagination"></div>
    </div>
  `;

  const { slice, totalPages, page, total } = paginate(filtered, state.page, state.pageSize);
  const tbody = qs('#items-tbody', container);
  if (tbody) {
    tbody.innerHTML = slice.map(i => `
      <tr class="row-link" data-id="${i.id}">
        <td data-label="اسم الصنف"><b>${escapeHtml(i.name)}</b>${i.category ? `<div class="small text-dim">${escapeHtml(i.category)}</div>` : ''}</td>
        <td class="num text-dim" data-label="الباركود">${escapeHtml(i.barcode || '—')}</td>
        <td class="num" data-label="التكلفة الأساسية">${fmtMoney(i.baseCost)}</td>
        <td class="num" data-label="عدد الموردين">
          ${linkCountByErp[i.id]
            ? `<button class="btn btn-sm btn-ghost btn-relations" data-id="${i.id}" data-name="${escapeHtml(i.name)}">${fmtInt(linkCountByErp[i.id])} مورد ↗</button>`
            : `<span class="text-dim">0</span>`}
        </td>
        <td><button class="btn btn-sm btn-ghost btn-edit-item" data-id="${i.id}">تعديل</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr.row-link').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-edit-item') || e.target.closest('.btn-relations')) return;
        openItemForm(container, row.dataset.id);
      });
    });
    tbody.querySelectorAll('.btn-edit-item').forEach(b => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openItemForm(container, b.dataset.id); });
    });
    tbody.querySelectorAll('.btn-relations').forEach(b => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openRelationsModal(b.dataset.id, b.dataset.name); });
    });
  }

  const pagWrap = qs('#items-pagination', container);
  if (pagWrap && total > 0) {
    pagWrap.appendChild(renderPagination({
      page, totalPages, total, pageSize: state.pageSize,
      onPage: (p) => { state.page = p; renderItemsList(container); },
      onPageSize: (s) => { state.pageSize = s; state.page = 1; renderItemsList(container); },
    }));
  }

  qs('#items-search', container).addEventListener('input', debounce((e) => {
    state.query = e.target.value; state.page = 1; renderItemsList(container);
  }, 200));

  const catFilter = qs('#items-category-filter', container);
  if (catFilter) catFilter.addEventListener('change', () => { state.category = catFilter.value; state.page = 1; renderItemsList(container); });
  qs('#items-linked-filter', container).addEventListener('change', (e) => { state.linked = e.target.value; state.page = 1; renderItemsList(container); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => {
    state.category = ''; state.linked = ''; state.page = 1;
    renderItemsList(container);
  });

  qs('#btn-add-item', container).addEventListener('click', () => openItemForm(container, null));
}

async function openRelationsModal(erpItemId, itemName) {
  const relations = await listErpSupplierRelations(erpItemId);
  openModal({
    title: `الموردون المرتبطون بـ "${itemName}"`,
    wide: true,
    bodyHtml: relations.length ? `
      <table class="data-table">
        <thead><tr><th>المورد</th><th>اسم الصنف عند المورد</th><th class="num">التكلفة</th></tr></thead>
        <tbody>
          ${relations.map(r => `
            <tr>
              <td data-label="المورد">${escapeHtml(r.supplierName)}</td>
              <td data-label="اسم الصنف عند المورد"><b>${escapeHtml(r.supplierItemName)}</b></td>
              <td class="num" data-label="التكلفة">${fmtMoney(r.currentCost)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : `<div class="empty-state"><div class="empty-hint">لا يوجد موردون مرتبطون بهذا الصنف بعد</div></div>`,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });
}

function openItemForm(container, itemId) {
  getById('erpItems', itemId).then((existing) => {
    const isEdit = !!existing;
    const snapshot = existing ? { ...existing } : null;
    let recordId = existing?.id || null;

    const { node } = openModal({
      title: isEdit ? 'تعديل صنف' : 'إضافة صنف جديد',
      bodyHtml: `
        <div class="field">
          <div class="field-label-row"><label style="margin:0;">اسم الصنف *</label><span class="autosave-status" id="item-status"></span></div>
          <input type="text" id="f-name" value="${escapeHtml(existing?.name || '')}">
        </div>
        <div class="form-row">
          <div class="field"><label>الباركود</label><input type="text" id="f-barcode" value="${escapeHtml(existing?.barcode || '')}"></div>
          <div class="field"><label>التكلفة الأساسية</label><input type="number" step="0.01" id="f-cost" value="${existing?.baseCost ?? ''}"></div>
        </div>
        <div class="field"><label>القسم / التصنيف (اختياري)</label><input type="text" id="f-category" value="${escapeHtml(existing?.category || '')}"></div>
        <div class="hint">يتم الحفظ تلقائيًا أثناء الكتابة.</div>
      `,
      footerButtons: [
        ...(isEdit ? [{
          label: 'حذف الصنف', className: 'btn-danger',
          onClick: async (c) => {
            const relations = await listErpSupplierRelations(recordId);
            const message = relations.length
              ? `هذا الصنف مرتبط بـ ${relations.length} ${relations.length === 1 ? 'مورد' : 'موردين'}. حذفه هيفك الربط تلقائيًا وهيبقوا "غير مرتبطين" لحد ما تربطهم بصنف تاني. هل تريد المتابعة؟`
              : `سيتم حذف الصنف "${existing.name}" نهائيًا. هل أنت متأكد؟`;
            const ok = await confirmDialog(message, { danger: true, okLabel: 'حذف الصنف' });
            if (!ok) return;
            if (relations.length) await unlinkAllSuppliersFromErpItem(recordId);
            await remove('erpItems', recordId);
            await logAction('حذف صنف', 'erpItem', recordId, existing.name);
            toast('تم حذف الصنف', 'success');
            c();
            renderItemsList(container);
          },
        }] : []),
        {
          label: 'إلغاء', className: 'btn-ghost',
          onClick: async (c) => {
            if (!isEdit && recordId) { await remove('erpItems', recordId); }
            else if (isEdit && snapshot) { await put('erpItems', snapshot); }
            c();
            renderItemsList(container);
          },
        },
        {
          label: 'تم', className: 'btn-primary',
          onClick: async (c) => {
            await persist();
            if (!recordId) { toast('اسم الصنف مطلوب', 'error'); return; }
            toast(isEdit ? 'تم حفظ التعديلات' : 'تمت إضافة الصنف', 'success');
            c();
            renderItemsList(container);
          },
        },
      ],
    });

    async function persist() {
      const name = qs('#f-name', node).value.trim();
      if (!name) return;
      const record = {
        id: recordId || uid(),
        name,
        barcode: qs('#f-barcode', node).value.trim(),
        baseCost: Number(qs('#f-cost', node).value) || 0,
        category: qs('#f-category', node).value.trim(),
        createdAt: recordId ? (existing?.createdAt || nowIso()) : nowIso(),
        updatedAt: nowIso(),
      };
      await put('erpItems', record);
      if (!recordId) {
        recordId = record.id;
        await logAction('إضافة صنف', 'erpItem', recordId, name);
      }
    }

    const statusEl = qs('#item-status', node);
    ['f-name', 'f-barcode', 'f-cost', 'f-category'].forEach(id => {
      autosaveField(qs('#' + id, node), () => persist(), { statusEl: id === 'f-name' ? statusEl : null, delay: 500 });
    });
  });
}
