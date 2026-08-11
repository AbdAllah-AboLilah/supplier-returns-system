// =========================================================
// modules/invoice-reviews.js — مراجعة الفواتير
//
// A standalone side-tool, ported from a small HTML tool the person
// already built and used for exactly this: sitting with a supplier
// and quickly re-checking their invoice math (qty × price, unit
// conversions like dozens) to catch manual writing errors.
//
// It only *reads* the suppliers collection (to link a review to an
// existing supplier, or offer creating a new one) — nothing here
// writes into returns, items, or their stats. Its own data lives in
// two collections (invoiceReviews, invoiceReviewItems) that no other
// module touches.
// =========================================================
import { getAll, getById, put, remove, getByIndex, removeWhere, getSetting, setSetting, nextSequence } from '../core/db.js';
import { uid, nowIso, fmtMoney, fmtInt, fmtDate, escapeHtml, fuzzyIncludes, debounce,
         openModal, confirmDialog, toast, paginate, renderPagination, qs, qsa } from '../core/utils.js';
import { autosaveField } from '../core/autosave.js';
import { navigate } from '../core/router.js';
import { openSupplierForm } from './suppliers.js';

const DEFAULT_UNITS = [
  { key: 'piece', label: 'قطعة', multiplier: 1 },
  { key: 'dozen', label: 'دستة', multiplier: 12 },
];

async function getUnits() {
  const units = await getSetting('invoiceUnits', null);
  return (units && units.length) ? units : DEFAULT_UNITS;
}
function saveUnits(units) {
  return setSetting('invoiceUnits', units);
}

async function generateReviewNumber() {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`INV-${year}`);
  return `INV-${year}-${String(seq).padStart(5, '0')}`;
}

function computeLine(item, units) {
  const unit = units.find(u => u.key === item.unitKey) || units[0] || DEFAULT_UNITS[0];
  const qty = Number(item.qty) || 0;
  const price = Number(item.price) || 0;
  return { unit, qty, price, actualQty: qty * (unit?.multiplier || 1), total: qty * price };
}

// ---------- Arabic number → words (ported as-is from the original tool) ----------

const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const TEENS = ['عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUND = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function u100(n) {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? ONES[o] + ' و' + TENS[t] : TENS[t];
}
function u1000(n) {
  if (n < 100) return u100(n);
  const h = Math.floor(n / 100), r = n % 100;
  return r ? HUND[h] + ' و' + u100(r) : HUND[h];
}
function group(n, s, d, p) {
  if (!n) return '';
  if (n === 1) return s;
  if (n === 2) return d;
  if (n <= 10) return u1000(n) + ' ' + p;
  return u1000(n) + ' ' + s;
}
export function numberToArabicWords(value) {
  value = String(value).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(value)) return 'من فضلك أدخل رقمًا صحيحًا فقط.';
  value = value.replace(/^0+/, '') || '0';
  if (value === '0') return 'صفر';
  if (value.length > 12) return 'الرقم أكبر من الحد المدعوم.';
  const n = Number(value);
  const b = Math.floor(n / 1e9);
  const m = Math.floor((n - b * 1e9) / 1e6);
  const th = Math.floor((n - b * 1e9 - m * 1e6) / 1000);
  const r = n - b * 1e9 - m * 1e6 - th * 1000;
  const out = [];
  if (b) out.push(group(b, 'مليار', 'ملياران', 'مليارات'));
  if (m) out.push(group(m, 'مليون', 'مليونان', 'ملايين'));
  if (th) out.push(group(th, 'ألف', 'ألفان', 'آلاف'));
  if (r) out.push(u1000(r));
  return out.join(' و');
}

export function openNumberConverterModal() {
  const { node } = openModal({
    title: '🔤 تحويل الأرقام إلى كلمات',
    bodyHtml: `
      <div class="field"><label>الرقم</label><input type="text" id="num-input" inputmode="decimal" placeholder="مثال: 33500"></div>
      <div class="field"><label>بالكلمات</label><textarea id="num-result" readonly rows="3"></textarea></div>
      <button class="btn btn-ghost btn-sm" id="num-copy">📋 نسخ</button>
    `,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });
  const input = qs('#num-input', node);
  const result = qs('#num-result', node);
  input.addEventListener('input', () => { result.value = input.value.trim() ? numberToArabicWords(input.value) : ''; });
  qs('#num-copy', node).addEventListener('click', async () => {
    if (!result.value) return;
    try { await navigator.clipboard.writeText(result.value); toast('تم النسخ', 'success'); }
    catch { toast('تعذّر النسخ', 'error'); }
  });
  input.focus();
}

// ---------- Data access ----------

export async function listReviews() {
  return getAll('invoiceReviews');
}
export async function getReviewItems(reviewId) {
  const rows = await getByIndex('invoiceReviewItems', 'reviewId', reviewId);
  return rows.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export async function createDraftReview() {
  const reviewNumber = await generateReviewNumber();
  const record = {
    id: uid(), reviewNumber, supplierId: null, supplierName: '', invoiceNumber: '',
    erpEntered: false, erpEnteredAt: null, photo: null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  await put('invoiceReviews', record);
  return record;
}

async function touch(review) { review.updatedAt = nowIso(); await put('invoiceReviews', review); }

export async function updateReviewMeta(reviewId, patch) {
  const review = await getById('invoiceReviews', reviewId);
  Object.assign(review, patch);
  await touch(review);
  return review;
}

export async function toggleErpEntered(reviewId, entered) {
  const review = await getById('invoiceReviews', reviewId);
  review.erpEntered = entered;
  review.erpEnteredAt = entered ? nowIso() : null;
  await touch(review);
  return review;
}

export async function deleteReview(reviewId) {
  await removeWhere('invoiceReviewItems', 'reviewId', reviewId);
  await remove('invoiceReviews', reviewId);
}

export async function addReviewItem(reviewId, { qty, unitKey, price }) {
  const line = { id: uid(), reviewId, qty: Number(qty) || 0, unitKey, price: Number(price) || 0, createdAt: nowIso() };
  await put('invoiceReviewItems', line);
  getById('invoiceReviews', reviewId).then(r => { if (r) touch(r); });
  return line;
}

export async function updateReviewItem(lineId, patch) {
  const line = await getById('invoiceReviewItems', lineId);
  Object.assign(line, patch);
  await put('invoiceReviewItems', line);
  return line;
}

export async function removeReviewItem(lineId) {
  const line = await getById('invoiceReviewItems', lineId);
  await remove('invoiceReviewItems', lineId);
  getById('invoiceReviews', line.reviewId).then(r => { if (r) touch(r); });
}

// ---------- Photo capture (compressed, stored inline — no separate storage service needed) ----------

function compressImage(file, maxWidth = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- UI: list ----------

const listState = { page: 1, pageSize: 50, query: '', erpFilter: '', supplierFilter: '' };

export async function renderInvoiceReviewsList(container) {
  const [reviews, suppliers, allItems, units] = await Promise.all([
    listReviews(), getAll('suppliers'), getAll('invoiceReviewItems'), getUnits(),
  ]);
  const supplierById = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const itemsByReview = {};
  allItems.forEach(i => { (itemsByReview[i.reviewId] = itemsByReview[i.reviewId] || []).push(i); });

  let rows = reviews.map(r => {
    const items = itemsByReview[r.id] || [];
    const total = items.reduce((s, i) => s + computeLine(i, units).total, 0);
    const supplierDisplayName = r.supplierId ? (supplierById[r.supplierId]?.name || r.supplierName) : (r.supplierName || '—');
    return { ...r, itemCount: items.length, total, supplierDisplayName };
  });

  if (listState.query) rows = rows.filter(r => fuzzyIncludes(r.reviewNumber, listState.query) || fuzzyIncludes(r.invoiceNumber, listState.query) || fuzzyIncludes(r.supplierDisplayName, listState.query));
  if (listState.erpFilter) rows = rows.filter(r => (listState.erpFilter === 'yes') === !!r.erpEntered);
  if (listState.supplierFilter) rows = rows.filter(r => r.supplierId === listState.supplierFilter);
  rows = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const hasActiveFilters = !!(listState.erpFilter || listState.supplierFilter);

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="inv-search" placeholder="🔎 رقم المراجعة، رقم الفاتورة، أو المورد" style="max-width:280px;" value="${escapeHtml(listState.query)}">
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="btn-num-converter">🔤 محول الأرقام</button>
        <button class="btn btn-primary" id="btn-new-review">+ مراجعة جديدة</button>
      </div>
      <div class="filter-bar">
        <label>المورد</label>
        <select id="inv-supplier-filter">
          <option value="">كل الموردين</option>
          ${suppliers.map(s => `<option value="${s.id}" ${listState.supplierFilter === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <label>حالة ERP</label>
        <select id="inv-erp-filter">
          <option value="">الكل</option>
          <option value="yes" ${listState.erpFilter === 'yes' ? 'selected' : ''}>مسجلة</option>
          <option value="no" ${listState.erpFilter === 'no' ? 'selected' : ''}>غير مسجلة</option>
        </select>
        ${hasActiveFilters ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلاتر</button>` : ''}
      </div>
      ${rows.length ? `
      <table class="data-table">
        <thead><tr>
          <th>رقم المراجعة</th><th>رقم الفاتورة</th><th>المورد</th><th class="num">عدد الأصناف</th><th class="num">الإجمالي</th><th>ERP</th><th>التاريخ</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="row-link" data-id="${r.id}">
              <td class="text-mono" data-label="رقم المراجعة">${escapeHtml(r.reviewNumber)}</td>
              <td class="text-dim" data-label="رقم الفاتورة">${escapeHtml(r.invoiceNumber || '—')}</td>
              <td data-label="المورد">${escapeHtml(r.supplierDisplayName)}</td>
              <td class="num" data-label="عدد الأصناف">${fmtInt(r.itemCount)}</td>
              <td class="num" data-label="الإجمالي">${fmtMoney(r.total)}</td>
              <td data-label="ERP">${r.erpEntered ? '<span class="badge badge-erp-yes">🟢 مسجلة</span>' : '<span class="badge badge-erp-no">🔴 غير مسجلة</span>'}</td>
              <td class="text-dim small" data-label="التاريخ">${fmtDate(r.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state">
        <div class="empty-icon">🧾</div>
        <div class="empty-title">لا توجد مراجعات فواتير بعد</div>
        <div class="empty-hint">${hasActiveFilters ? 'جرّب توسيع نطاق الفلاتر' : 'ابدأ مراجعة جديدة لحظة ما تكون مع المورد'}</div>
      </div>`}
    </div>
  `;

  container.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', () => navigate(`/invoice-reviews/${row.dataset.id}`)));
  qs('#inv-search', container).addEventListener('input', debounce((e) => { listState.query = e.target.value; renderInvoiceReviewsList(container); }, 200));
  qs('#inv-supplier-filter', container).addEventListener('change', (e) => { listState.supplierFilter = e.target.value; renderInvoiceReviewsList(container); });
  qs('#inv-erp-filter', container).addEventListener('change', (e) => { listState.erpFilter = e.target.value; renderInvoiceReviewsList(container); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => { listState.erpFilter = ''; listState.supplierFilter = ''; renderInvoiceReviewsList(container); });
  qs('#btn-num-converter', container).addEventListener('click', () => openNumberConverterModal());
  qs('#btn-new-review', container).addEventListener('click', async () => {
    const review = await createDraftReview();
    navigate(`/invoice-reviews/${review.id}`);
  });
}

// ---------- UI: detail ----------

export async function renderInvoiceReviewDetail(container, reviewId) {
  const review = await getById('invoiceReviews', reviewId);
  if (!review) { container.innerHTML = `<div class="card card-pad">المراجعة غير موجودة.</div>`; return; }
  const [items, suppliers, units] = await Promise.all([getReviewItems(reviewId), getAll('suppliers'), getUnits()]);
  const totalQty = items.reduce((s, i) => s + computeLine(i, units).actualQty, 0);
  const totalValue = items.reduce((s, i) => s + computeLine(i, units).total, 0);

  container.innerHTML = `
    <div class="flex items-center justify-between mb-16" style="flex-wrap:wrap;gap:10px;">
      <div>
        <h2 style="margin:0;font-size:19px;" class="text-mono">${escapeHtml(review.reviewNumber)}</h2>
        <div class="small text-muted mt-8">أُنشئت في ${fmtDate(review.createdAt, true)}</div>
      </div>
      <button class="btn btn-danger btn-sm" id="btn-delete-review">حذف المراجعة</button>
    </div>

    <div class="card card-pad mb-16">
      <div class="grid grid-cols-2">
        <div class="field">
          <label>المورد</label>
          <select id="f-supplier">
            <option value="">— بدون ربط —</option>
            ${suppliers.map(s => `<option value="${s.id}" ${review.supplierId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <div class="hint"><a href="#" id="btn-new-supplier">+ المورد ده مش موجود، إضافته كمورد جديد</a></div>
        </div>
        <div class="field">
          <div class="field-label-row"><label style="margin:0;">رقم الفاتورة</label><span class="autosave-status" id="inv-status"></span></div>
          <input type="text" id="f-invoice-number" value="${escapeHtml(review.invoiceNumber || '')}" placeholder="رقم الفاتورة عند المورد">
        </div>
      </div>

      <div class="field mt-8">
        <label>صورة الفاتورة</label>
        <div id="photo-area"></div>
        <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none;">
      </div>

      <div class="mt-16">
        ${review.erpEntered
          ? `<span class="badge badge-erp-yes">🟢 مسجلة على ERP${review.erpEnteredAt ? ` — ${fmtDate(review.erpEnteredAt, true)}` : ''}</span> <button class="btn btn-sm btn-ghost" id="btn-erp-toggle">إلغاء التسجيل</button>`
          : `<span class="badge badge-erp-no">🔴 لسه ما دخلتش ERP</span> <button class="btn btn-sm btn-gold" id="btn-erp-toggle">✓ تم الإدخال على ERP</button>`}
      </div>
    </div>

    <div class="card mb-16">
      <div class="card-header"><h3>أصناف الفاتورة</h3><span class="small text-dim">${fmtInt(items.length)} صنف · حفظ تلقائي أثناء الكتابة</span></div>
      ${items.length ? `
      <table class="data-table">
        <thead><tr><th class="num">الكمية</th><th>الوحدة</th><th class="num">السعر</th><th class="num">الكمية الفعلية</th><th class="num">الإجمالي</th><th></th></tr></thead>
        <tbody>
          ${items.map(i => {
            const c = computeLine(i, units);
            return `
            <tr data-line="${i.id}">
              <td class="num" data-label="الكمية"><input type="number" min="0" step="any" class="ln-qty" data-id="${i.id}" value="${i.qty}" style="width:80px;text-align:center;"></td>
              <td data-label="الوحدة">
                <select class="ln-unit" data-id="${i.id}">
                  ${units.map(u => `<option value="${u.key}" ${i.unitKey === u.key ? 'selected' : ''}>${escapeHtml(u.label)}</option>`).join('')}
                </select>
              </td>
              <td class="num" data-label="السعر"><input type="number" min="0" step="0.01" class="ln-price" data-id="${i.id}" value="${i.price}" style="width:90px;text-align:center;"></td>
              <td class="num text-dim" id="ln-actual-${i.id}" data-label="الكمية الفعلية">${fmtInt(c.actualQty)}</td>
              <td class="num text-mono" id="ln-total-${i.id}" data-label="الإجمالي">${fmtMoney(c.total)}</td>
              <td><button class="btn btn-sm btn-ghost ln-remove" data-id="${i.id}">حذف</button></td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3"><b>الإجمالي</b></td>
            <td class="num text-mono" id="footer-qty">${fmtInt(totalQty)}</td>
            <td class="num text-mono" id="footer-total"><b>${fmtMoney(totalValue)}</b></td>
            <td></td>
          </tr>
        </tfoot>
      </table>` : `<div class="empty-state"><div class="empty-hint">لسه معملتش إضافة أصناف</div></div>`}

      <div class="card-pad" style="border-top:1px solid var(--line);">
        <div class="section-title">إضافة صنف</div>
        <div class="form-row" style="align-items:flex-end;">
          <div class="field" style="flex:0 0 100px;"><label>الكمية</label><input type="number" id="add-qty" min="0" step="any" value="1"></div>
          <div class="field" style="flex:0 0 120px;">
            <div class="field-label-row"><label style="margin:0;">الوحدة</label><a href="#" id="btn-manage-units" class="small">إدارة الوحدات</a></div>
            <select id="add-unit">${units.map(u => `<option value="${u.key}">${escapeHtml(u.label)}</option>`).join('')}</select>
          </div>
          <div class="field" style="flex:0 0 110px;"><label>السعر</label><input type="number" id="add-price" min="0" step="0.01" placeholder="0.00"></div>
          <div class="field" style="flex:0 0 auto;"><button class="btn btn-primary" id="btn-add-line">+ إضافة</button></div>
        </div>
      </div>
    </div>

    <div class="card card-pad flex gap-8" style="flex-wrap:wrap;">
      <button class="btn btn-ghost" id="btn-copy">📋 نسخ كنص</button>
      <button class="btn btn-ghost" id="btn-img">🖼 تنزيل كصورة</button>
      <button class="btn btn-ghost" id="btn-whatsapp">📱 واتساب</button>
      <button class="btn btn-ghost" id="btn-print">🖨 طباعة</button>
    </div>
  `;

  renderPhotoArea(container, review);
  wireDetailEvents(container, review, items, units, suppliers);
}

function renderPhotoArea(container, review) {
  const area = qs('#photo-area', container);
  if (review.photo) {
    area.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <img src="${review.photo}" alt="صورة الفاتورة" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--line);">
        <div class="flex gap-8">
          <button class="btn btn-sm btn-ghost" id="btn-change-photo">تغيير الصورة</button>
          <button class="btn btn-sm btn-ghost" id="btn-remove-photo">حذف الصورة</button>
        </div>
      </div>
    `;
  } else {
    area.innerHTML = `<button class="btn btn-ghost btn-sm" id="btn-change-photo">📷 تصوير / اختيار صورة الفاتورة</button>`;
  }
  qs('#btn-change-photo', area)?.addEventListener('click', () => qs('#photo-input', container).click());
  qs('#btn-remove-photo', area)?.addEventListener('click', async () => {
    await updateReviewMeta(review.id, { photo: null });
    review.photo = null;
    renderPhotoArea(container, review);
    toast('تم حذف الصورة', 'success');
  });
}

function wireDetailEvents(container, review, items, units, suppliers) {
  qs('#btn-delete-review', container).addEventListener('click', async () => {
    if (!(await confirmDialog(`سيتم حذف المراجعة ${review.reviewNumber} نهائيًا. هل أنت متأكد؟`, { danger: true }))) return;
    await deleteReview(review.id);
    toast('تم الحذف', 'success');
    navigate('/invoice-reviews');
  });

  const supplierSelect = qs('#f-supplier', container);
  supplierSelect.addEventListener('change', async () => {
    const supplierId = supplierSelect.value || null;
    const supplierName = supplierId ? (suppliers.find(s => s.id === supplierId)?.name || '') : '';
    await updateReviewMeta(review.id, { supplierId, supplierName });
    toast('تم الحفظ', 'success');
  });
  qs('#btn-new-supplier', container).addEventListener('click', (e) => {
    e.preventDefault();
    openSupplierForm(container, null, async (savedSupplier) => {
      await renderInvoiceReviewDetail(container, review.id);
      if (savedSupplier?.id) {
        const sel = qs('#f-supplier', container);
        if (sel) { sel.value = savedSupplier.id; await updateReviewMeta(review.id, { supplierId: savedSupplier.id, supplierName: savedSupplier.name }); }
      }
    });
  });

  const invNumberInput = qs('#f-invoice-number', container);
  autosaveField(invNumberInput, (val) => updateReviewMeta(review.id, { invoiceNumber: val.trim() }), { statusEl: qs('#inv-status', container), delay: 500 });

  qs('#photo-input', container).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast('جارِ تجهيز الصورة...', 'default');
    try {
      const dataUrl = await compressImage(file);
      await updateReviewMeta(review.id, { photo: dataUrl });
      review.photo = dataUrl;
      renderPhotoArea(container, review);
      toast('تم حفظ الصورة', 'success');
    } catch (err) {
      console.error(err);
      toast('تعذّر معالجة الصورة', 'error');
    }
    e.target.value = '';
  });

  qs('#btn-erp-toggle', container).addEventListener('click', async () => {
    await toggleErpEntered(review.id, !review.erpEntered);
    renderInvoiceReviewDetail(container, review.id);
  });

  qsa('.ln-qty', container).forEach(inp => autosaveField(inp, async (val) => {
    await updateReviewItem(inp.dataset.id, { qty: Number(val) || 0 });
    recalcLine(container, inp.dataset.id, units);
  }, { delay: 500 }));
  qsa('.ln-price', container).forEach(inp => autosaveField(inp, async (val) => {
    await updateReviewItem(inp.dataset.id, { price: Number(val) || 0 });
    recalcLine(container, inp.dataset.id, units);
  }, { delay: 500 }));
  qsa('.ln-unit', container).forEach(sel => sel.addEventListener('change', async () => {
    await updateReviewItem(sel.dataset.id, { unitKey: sel.value });
    recalcLine(container, sel.dataset.id, units);
  }));
  qsa('.ln-remove', container).forEach(b => b.addEventListener('click', async () => {
    await removeReviewItem(b.dataset.id);
    renderInvoiceReviewDetail(container, review.id);
  }));

  qs('#btn-manage-units', container).addEventListener('click', (e) => { e.preventDefault(); openUnitsManagerModal(() => renderInvoiceReviewDetail(container, review.id)); });

  qs('#btn-add-line', container).addEventListener('click', async () => {
    const qty = qs('#add-qty', container).value;
    const unitKey = qs('#add-unit', container).value;
    const price = qs('#add-price', container).value;
    if (!qty || Number(qty) <= 0) { toast('اكتب الكمية أولًا', 'error'); return; }
    const lastUnit = unitKey; // remember for next row, matches original tool's UX
    await addReviewItem(review.id, { qty, unitKey, price });
    await renderInvoiceReviewDetail(container, review.id);
    qs('#add-unit', container).value = lastUnit;
    qs('#add-qty', container)?.focus();
  });

  qs('#btn-copy', container).addEventListener('click', () => copyReviewText(review, items, units, suppliers));
  qs('#btn-img', container).addEventListener('click', () => downloadReviewImage(review, items, units, suppliers));
  qs('#btn-whatsapp', container).addEventListener('click', () => shareReviewImage(review, items, units, suppliers));
  qs('#btn-print', container).addEventListener('click', () => printReview(review, items, units, suppliers));
}

function recalcLine(container, lineId, units) {
  const row = container.querySelector(`tr[data-line="${lineId}"]`);
  if (!row) return;
  const qty = Number(row.querySelector('.ln-qty')?.value) || 0;
  const price = Number(row.querySelector('.ln-price')?.value) || 0;
  const unitKey = row.querySelector('.ln-unit')?.value;
  const unit = units.find(u => u.key === unitKey) || units[0];
  const actualQty = qty * (unit?.multiplier || 1);
  const total = qty * price;
  const actualCell = qs(`#ln-actual-${lineId}`, container);
  if (actualCell) actualCell.textContent = fmtInt(actualQty);
  const totalCell = qs(`#ln-total-${lineId}`, container);
  if (totalCell) totalCell.textContent = fmtMoney(total);

  let totalQty = 0, totalValue = 0;
  qsa('tr[data-line]', container).forEach(tr => {
    const q = Number(tr.querySelector('.ln-qty')?.value) || 0;
    const p = Number(tr.querySelector('.ln-price')?.value) || 0;
    const uk = tr.querySelector('.ln-unit')?.value;
    const u = units.find(x => x.key === uk) || units[0];
    totalQty += q * (u?.multiplier || 1);
    totalValue += q * p;
  });
  const fq = qs('#footer-qty', container); if (fq) fq.textContent = fmtInt(totalQty);
  const fv = qs('#footer-total', container); if (fv) fv.innerHTML = `<b>${fmtMoney(totalValue)}</b>`;
}

// ---------- Units manager ----------

function openUnitsManagerModal(onDone) {
  getUnits().then((units) => {
    const { node } = openModal({
      title: 'إدارة الوحدات',
      bodyHtml: `
        <table class="data-table" id="units-table">
          <thead><tr><th>الاسم</th><th class="num">مضاعف القطعة</th><th></th></tr></thead>
          <tbody>
            ${units.map(u => `
              <tr data-key="${u.key}">
                <td>${escapeHtml(u.label)}</td>
                <td class="num text-mono">${u.multiplier}</td>
                <td><button class="btn btn-sm btn-ghost btn-del-unit" data-key="${u.key}">حذف</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div class="form-row mt-16" style="align-items:flex-end;">
          <div class="field" style="flex:2;"><label>اسم الوحدة الجديدة</label><input type="text" id="f-unit-label" placeholder="مثال: كرتونة"></div>
          <div class="field" style="flex:0 0 120px;"><label>= كام قطعة</label><input type="number" id="f-unit-mult" min="1" step="1" value="1"></div>
          <div class="field" style="flex:0 0 auto;"><button class="btn btn-primary" id="btn-add-unit">+ إضافة</button></div>
        </div>
      `,
      footerButtons: [{ label: 'تم', className: 'btn-primary', onClick: (c) => { c(); onDone(); } }],
    });

    async function refresh() {
      const current = await getUnits();
      node.querySelector('#units-table tbody').innerHTML = current.map(u => `
        <tr data-key="${u.key}">
          <td>${escapeHtml(u.label)}</td>
          <td class="num text-mono">${u.multiplier}</td>
          <td><button class="btn btn-sm btn-ghost btn-del-unit" data-key="${u.key}">حذف</button></td>
        </tr>
      `).join('');
      wireDelButtons();
    }
    function wireDelButtons() {
      node.querySelectorAll('.btn-del-unit').forEach(b => b.addEventListener('click', async () => {
        const current = await getUnits();
        if (current.length <= 1) { toast('لازم تفضل وحدة واحدة على الأقل', 'error'); return; }
        await saveUnits(current.filter(u => u.key !== b.dataset.key));
        refresh();
      }));
    }
    wireDelButtons();

    qs('#btn-add-unit', node).addEventListener('click', async () => {
      const label = qs('#f-unit-label', node).value.trim();
      const multiplier = Number(qs('#f-unit-mult', node).value) || 1;
      if (!label) { toast('اكتب اسم الوحدة', 'error'); return; }
      const current = await getUnits();
      current.push({ key: uid(), label, multiplier });
      await saveUnits(current);
      qs('#f-unit-label', node).value = '';
      qs('#f-unit-mult', node).value = '1';
      refresh();
    });
  });
}

// ---------- Export: copy / image / WhatsApp / print ----------

function reviewSummaryText(review, items, units, suppliers) {
  const supplierName = review.supplierId ? (suppliers.find(s => s.id === review.supplierId)?.name || review.supplierName) : (review.supplierName || '—');
  const lines = [`مراجعة فاتورة ${review.reviewNumber}`, `المورد: ${supplierName}`];
  if (review.invoiceNumber) lines.push(`رقم الفاتورة: ${review.invoiceNumber}`);
  lines.push('');
  items.forEach((i, idx) => {
    const c = computeLine(i, units);
    lines.push(`${idx + 1}. ${fmtInt(c.qty)} ${c.unit.label} × ${fmtMoney(c.price)} = ${fmtMoney(c.total)}`);
  });
  const totalValue = items.reduce((s, i) => s + computeLine(i, units).total, 0);
  lines.push('', `الإجمالي: ${fmtMoney(totalValue)}`);
  return lines.join('\n');
}

async function copyReviewText(review, items, units, suppliers) {
  try {
    await navigator.clipboard.writeText(reviewSummaryText(review, items, units, suppliers));
    toast('تم نسخ المراجعة', 'success');
  } catch (err) {
    console.error(err);
    toast('تعذّر النسخ', 'error');
  }
}

function buildReviewReportElement(review, items, units, suppliers) {
  const supplierName = review.supplierId ? (suppliers.find(s => s.id === review.supplierId)?.name || review.supplierName) : (review.supplierName || '—');
  const totalValue = items.reduce((s, i) => s + computeLine(i, units).total, 0);
  const wrap = document.createElement('div');
  wrap.style.cssText = `direction:rtl;background:#fff;padding:24px;font-family:'Tajawal',system-ui,sans-serif;color:#161C2E;width:560px;`;
  wrap.innerHTML = `
    <div style="border-bottom:2px solid #1F2A44;padding-bottom:10px;margin-bottom:12px;">
      <div style="font-weight:900;font-size:16px;">مراجعة فاتورة ${escapeHtml(review.reviewNumber)}</div>
      <div style="font-size:12px;color:#5B6479;margin-top:3px;">${escapeHtml(supplierName)}${review.invoiceNumber ? ` · فاتورة رقم ${escapeHtml(review.invoiceNumber)}` : ''}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
      <thead><tr>
        <th style="text-align:right;padding:5px;border-bottom:1px solid #CBD1DE;color:#5B6479;font-size:10.5px;">الكمية</th>
        <th style="text-align:right;padding:5px;border-bottom:1px solid #CBD1DE;color:#5B6479;font-size:10.5px;">الوحدة</th>
        <th style="text-align:right;padding:5px;border-bottom:1px solid #CBD1DE;color:#5B6479;font-size:10.5px;">السعر</th>
        <th style="text-align:right;padding:5px;border-bottom:1px solid #CBD1DE;color:#5B6479;font-size:10.5px;">الإجمالي</th>
      </tr></thead>
      <tbody>
        ${items.map(i => {
          const c = computeLine(i, units);
          return `<tr>
            <td style="padding:5px;border-bottom:1px solid #E3E6EC;font-weight:600;">${fmtInt(c.qty)}</td>
            <td style="padding:5px;border-bottom:1px solid #E3E6EC;font-weight:600;">${escapeHtml(c.unit.label)}</td>
            <td style="padding:5px;border-bottom:1px solid #E3E6EC;font-weight:600;">${fmtMoney(c.price)}</td>
            <td style="padding:5px;border-bottom:1px solid #E3E6EC;font-weight:700;">${fmtMoney(c.total)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:8px;border-top:2px solid #1F2A44;font-weight:900;font-size:14px;">
      <span>الإجمالي</span><span>${fmtMoney(totalValue)} جنيه</span>
    </div>
  `;
  return wrap;
}

async function renderReviewToBlob(review, items, units, suppliers) {
  if (typeof html2canvas === 'undefined') throw new Error('html2canvas not loaded');
  const el = buildReviewReportElement(review, items, units, suppliers);
  el.style.position = 'fixed'; el.style.top = '0'; el.style.left = '-9999px';
  document.body.appendChild(el);
  try {
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    el.remove();
  }
}

async function downloadReviewImage(review, items, units, suppliers) {
  if (typeof html2canvas === 'undefined') { toast('تعذّر تحميل مكتبة الصور، تحقق من الاتصال بالإنترنت', 'error'); return; }
  try {
    const blob = await renderReviewToBlob(review, items, units, suppliers);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${review.reviewNumber}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('تم تنزيل الصورة', 'success');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء إنشاء الصورة', 'error');
  }
}

async function shareReviewImage(review, items, units, suppliers) {
  if (typeof html2canvas === 'undefined') { toast('تعذّر تحميل مكتبة الصور، تحقق من الاتصال بالإنترنت', 'error'); return; }
  try {
    const blob = await renderReviewToBlob(review, items, units, suppliers);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
    const fileName = `${review.reviewNumber}.png`;
    const file = new File([blob], fileName, { type: 'image/png' });
    const shareText = `مراجعة فاتورة ${review.reviewNumber}`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: shareText, text: shareText }); }
      catch (err) { if (err.name !== 'AbortError') throw err; }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText + '\n📎 الصورة اتنزلت — أرفقها يدويًا.')}`, '_blank');
    toast('اتنزلت الصورة — أرفقها في واتساب يدويًا', 'success');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء المشاركة', 'error');
  }
}

function printReview(review, items, units, suppliers) {
  const text = reviewSummaryText(review, items, units, suppliers);
  const win = window.open('', '_blank', 'width=420,height=640');
  if (!win) { toast('المتصفح منع فتح نافذة الطباعة', 'error'); return; }
  win.document.write(`
    <!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${escapeHtml(review.reviewNumber)}</title>
    <style>body{font-family:Tahoma,Arial,sans-serif;padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.6;}</style>
    </head><body>${escapeHtml(text)}<script>window.onload=()=>window.print();</script></body></html>
  `);
  win.document.close();
}
