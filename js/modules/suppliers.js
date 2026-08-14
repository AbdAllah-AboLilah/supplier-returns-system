// =========================================================
// modules/suppliers.js — قاعدة الموردين
// =========================================================
import { getAll, getById, put, remove } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtInt, escapeHtml, fuzzyIncludes, debounce,
         openModal, confirmDialog, toast, el, qs } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { navigate } from '../core/router.js';
import { getSupplierStats, renderReturnsList, createDraftReturn } from './returns.js';
import { renderSupplierItemsPanel, listBySupplier, deleteSupplierItem } from './supplier-items.js';
import { autosaveField } from '../core/autosave.js';

const state = { query: '' };

export async function renderSuppliersList(container) {
  const all = await getAll('suppliers');
  const filtered = all.filter(s => fuzzyIncludes(s.name, state.query)).sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="sup-search" placeholder="🔎 بحث باسم المورد" style="max-width:260px;" value="${escapeHtml(state.query)}">
        <div class="spacer"></div>
        <button class="btn btn-primary" id="btn-add-supplier">+ إضافة مورد</button>
      </div>
      ${filtered.length ? `
      <table class="data-table">
        <thead><tr><th>اسم المورد</th><th>جهة الاتصال</th><th></th></tr></thead>
        <tbody id="sup-tbody"></tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">🏢</div>
        <div class="empty-title">لا يوجد موردون بعد</div>
        <div class="empty-hint">أضف أول مورد لتبدأ في تسجيل مرتجعاته</div>
      </div>`}
    </div>
  `;

  const tbody = qs('#sup-tbody', container);
  if (tbody) {
    tbody.innerHTML = filtered.map(s => `
      <tr class="row-link" data-id="${s.id}">
        <td data-label="اسم المورد"><b>${escapeHtml(s.name)}</b></td>
        <td class="text-dim" data-label="جهة الاتصال">${escapeHtml(s.contact || '—')}</td>
        <td><button class="btn btn-sm btn-ghost btn-edit" data-id="${s.id}">تعديل</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-edit')) return;
      navigate(`/suppliers/${row.dataset.id}`);
    }));
    tbody.querySelectorAll('.btn-edit').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openSupplierForm(container, b.dataset.id); }));
  }

  qs('#sup-search', container).addEventListener('input', debounce((e) => { state.query = e.target.value; renderSuppliersList(container); }, 200));
  qs('#btn-add-supplier', container).addEventListener('click', () => openSupplierForm(container, null));
}

export function openSupplierForm(container, supplierId, onSaved) {
  const load = supplierId ? getById('suppliers', supplierId) : Promise.resolve(null);
  load.then((existing) => {
    const isEdit = !!existing;
    const snapshot = existing ? { ...existing } : null; // restored if the person explicitly cancels
    let recordId = existing?.id || null;                // set once auto-created on first keystroke

    const { node } = openModal({
      title: isEdit ? 'تعديل بيانات المورد' : 'إضافة مورد جديد',
      bodyHtml: `
        <div class="field">
          <div class="field-label-row"><label style="margin:0;">اسم المورد *</label><span class="autosave-status" id="sup-status"></span></div>
          <input type="text" id="f-name" value="${escapeHtml(existing?.name || '')}">
        </div>
        <div class="field"><label>جهة الاتصال / رقم الهاتف</label><input type="text" id="f-contact" value="${escapeHtml(existing?.contact || '')}"></div>
        <div class="field"><label>ملاحظات</label><textarea id="f-notes">${escapeHtml(existing?.notes || '')}</textarea></div>
        <div class="hint">يتم الحفظ تلقائيًا أثناء الكتابة — لن تفقد البيانات حتى لو أُغلق التطبيق فجأة.</div>
      `,
      footerButtons: [
        {
          label: 'إلغاء', className: 'btn-ghost',
          onClick: async (c) => {
            if (!isEdit && recordId) { await remove('suppliers', recordId); }
            else if (isEdit && snapshot) { await put('suppliers', snapshot); }
            c();
            if (onSaved) onSaved(); else renderSuppliersList(container);
          },
        },
        {
          label: isEdit ? 'تم' : 'تم', className: 'btn-primary',
          onClick: async (c) => {
            await persist();
            if (!recordId) { toast('اسم المورد مطلوب', 'error'); return; }
            toast(isEdit ? 'تم الحفظ' : 'تمت إضافة المورد', 'success');
            c();
            if (onSaved) onSaved(); else renderSuppliersList(container);
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
        contact: qs('#f-contact', node).value.trim(),
        notes: qs('#f-notes', node).value.trim(),
        createdAt: recordId ? (existing?.createdAt || nowIso()) : nowIso(),
        updatedAt: nowIso(),
      };
      await put('suppliers', record);
      if (!recordId) {
        recordId = record.id;
        await logAction('إضافة مورد', 'supplier', recordId, name);
      }
    }

    const statusEl = qs('#sup-status', node);
    ['f-name', 'f-contact', 'f-notes'].forEach(id => {
      autosaveField(qs('#' + id, node), () => persist(), { statusEl: id === 'f-name' ? statusEl : null, delay: 500 });
    });
  });
}

export async function renderSupplierDetail(container, supplierId) {
  const supplier = await getById('suppliers', supplierId);
  if (!supplier) { container.innerHTML = `<div class="card card-pad">المورد غير موجود.</div>`; return; }
  const stats = await getSupplierStats(supplierId);

  container.innerHTML = `
    <div class="flex items-center justify-between mb-16" style="flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="margin:0 0 4px;font-size:19px;">${escapeHtml(supplier.name)}</h2>
        <div class="small text-muted">${escapeHtml(supplier.contact || 'لا توجد بيانات اتصال')}</div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-ghost" id="btn-edit-supplier">تعديل بيانات المورد</button>
        <button class="btn btn-primary" id="btn-new-return-here">+ مرتجعة جديدة</button>
        <button class="btn btn-danger" id="btn-delete-supplier">حذف المورد</button>
      </div>
    </div>

    <div class="grid grid-cols-4 mb-16">
      <div class="stat-card"><div class="stat-label">مرتجعات نشطة</div><div class="stat-value">${fmtInt(stats.activeCount)}</div><div class="stat-sub">${fmtMoney(stats.activeValue)} جنيه</div></div>
      <div class="stat-card accent-teal"><div class="stat-label">تم إرسالها</div><div class="stat-value">${fmtInt(stats.sentCount)}</div></div>
      <div class="stat-card accent-red"><div class="stat-label">غير مسجلة على ERP</div><div class="stat-value">${fmtInt(stats.unregisteredCount)}</div></div>
      <div class="stat-card accent-gold"><div class="stat-label">إجمالي المرتجعات</div><div class="stat-value">${fmtInt(stats.totalCount)}</div></div>
    </div>

    <div class="card mb-16">
      <div class="card-header"><h3>المرتجعات النشطة</h3><a href="#/returns/active" class="small">عرض الكل ↗</a></div>
      <div id="supplier-returns"></div>
    </div>

    <div class="card-header" style="padding:0 0 10px;border:none;"><h3 style="font-size:14px;">أصناف هذا المورد وربطها بنظام ERP</h3></div>
    <div id="supplier-items-panel"></div>

    ${supplier.notes ? `<div class="card card-pad mt-16"><div class="section-title">ملاحظات</div><div class="small">${escapeHtml(supplier.notes)}</div></div>` : ''}
  `;

  const returnsWrap = qs('#supplier-returns', container);
  await renderReturnsList(returnsWrap, 'active', supplierId);
  // strip the redundant "new return" toolbar button on the embedded list; the page has its own
  const embeddedBtn = qs('#btn-new-return', returnsWrap);
  if (embeddedBtn) embeddedBtn.closest('.table-toolbar').style.display = 'none';

  await renderSupplierItemsPanel(qs('#supplier-items-panel', container), supplierId);

  qs('#btn-edit-supplier', container).addEventListener('click', () => openSupplierForm(container, supplierId, () => renderSupplierDetail(container, supplierId)));
  qs('#btn-new-return-here', container).addEventListener('click', async () => {
    const ret = await createDraftReturn(supplierId);
    navigate(`/returns/${ret.id}`);
  });

  qs('#btn-delete-supplier', container).addEventListener('click', async () => {
    if (stats.totalCount > 0) {
      toast(`لا يمكن حذف هذا المورد لأن له ${stats.totalCount} مرتجعة مسجلة (نشطة أو مؤرشفة). لازم تتصرف في المرتجعات دي الأول.`, 'error');
      return;
    }
    const items = await listBySupplier(supplierId);
    const message = items.length
      ? `سيتم حذف المورد "${supplier.name}" وكل أصنافه المرتبطة به (${items.length} ${items.length === 1 ? 'صنف' : 'أصناف'}) نهائيًا. هل أنت متأكد؟`
      : `سيتم حذف المورد "${supplier.name}" نهائيًا. هل أنت متأكد؟`;
    const ok = await confirmDialog(message, { danger: true, okLabel: 'حذف المورد' });
    if (!ok) return;
    for (const item of items) await deleteSupplierItem(item.id);
    await remove('suppliers', supplierId);
    await logAction('حذف مورد', 'supplier', supplierId, supplier.name);
    toast('تم حذف المورد', 'success');
    navigate('/suppliers');
  });
}
