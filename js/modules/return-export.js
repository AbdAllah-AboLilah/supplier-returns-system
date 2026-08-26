// =========================================================
// modules/return-export.js
// Four ways to get a return's report out of the system:
//   1. Excel (.xlsx)               — via SheetJS (loaded globally as XLSX)
//   2. Image (.png)                — drawn directly onto a canvas
//                                     (see report-canvas.js)
//   3. WhatsApp                    — same image, handed to the native
//                                     share sheet (Web Share API)
//   4. Thermal receipt print view  — a narrow (80mm) print-only page
//                                     for cashier thermal printers
// All four respect the same column-visibility choices, picked once
// in the export modal (e.g. hide cost columns before handing a copy
// to a driver).
// =========================================================
import { fmtMoney, fmtInt, fmtDate, escapeHtml, openModal, toast, qs, qsa, printHtmlDocument } from '../core/utils.js';
import { getSetting, getAll } from '../core/db.js';
import { drawReport, canvasToBlob } from './report-canvas.js';

const COLUMNS = [
  { key: 'supplierName', label: 'اسم الصنف عند المورد' },
  { key: 'erpName', label: 'صنف النظام ERP' },
  { key: 'barcode', label: 'الباركود' },
  { key: 'qty', label: 'الكمية' },
  { key: 'cost', label: 'تكلفة المورد' },
  { key: 'total', label: 'الإجمالي' },
];

function cellValue(line, key) {
  switch (key) {
    case 'supplierName': return line.supplierItemName;
    case 'erpName': return line.erpItemName || 'غير مرتبط';
    case 'barcode': return line.erpBarcode || '—';
    case 'qty': return line.qty;
    case 'cost': return line.unitCost;
    case 'total': return line.total;
    default: return '';
  }
}

// A return line stores which ERP item it maps to, not that item's
// barcode — look it up once per export rather than storing a copy that
// would go stale the moment the barcode is corrected.
export async function attachBarcodes(lines) {
  if (!lines.some(l => l.erpItemId)) return lines.map(l => ({ ...l, erpBarcode: '' }));
  const erpItems = await getAll('erpItems');
  const barcodeById = Object.fromEntries(erpItems.map(i => [i.id, i.barcode || '']));
  return lines.map(l => ({ ...l, erpBarcode: l.erpItemId ? (barcodeById[l.erpItemId] || '') : '' }));
}

export async function openExportOptionsModal(ret, rawLines, supplier) {
  if (!rawLines.length) { toast('لا توجد أصناف في هذه المرتجعة بعد', 'error'); return; }
  const lines = await attachBarcodes(rawLines);
  const { node } = openModal({
    title: `تصدير تقرير ${ret.returnNumber}`,
    bodyHtml: `
      <div class="field">
        <label>الأعمدة الظاهرة في التصدير</label>
        <div id="export-columns">
          ${COLUMNS.map(c => `
            <label class="export-col-toggle">
              <input type="checkbox" class="col-toggle" value="${c.key}" ${c.defaultOff ? '' : 'checked'}> ${escapeHtml(c.label)}
            </label>
          `).join('')}
        </div>
        <div class="hint">أخفِ أي عمود (مثل التكلفة) قبل تصدير نسخة تُشارك مع طرف خارجي.</div>
      </div>
      <div class="export-actions">
        <button class="btn btn-primary" id="btn-exp-excel">⬇ تصدير Excel</button>
        <button class="btn btn-ghost" id="btn-exp-image">🖼 تنزيل كصورة</button>
        <button class="btn btn-ghost" id="btn-exp-whatsapp">📱 مشاركة عبر واتساب</button>
        <button class="btn btn-gold" id="btn-exp-thermal">🧾 طباعة إيصال حراري</button>
      </div>
    `,
    footerButtons: [{ label: 'إغلاق', className: 'btn-ghost', onClick: (c) => c() }],
  });

  function selectedKeys() {
    return qsa('.col-toggle', node).filter(cb => cb.checked).map(cb => cb.value);
  }

  qs('#btn-exp-excel', node).addEventListener('click', async () => {
    const keys = selectedKeys();
    if (!keys.length) { toast('اختر عمودًا واحدًا على الأقل', 'error'); return; }
    await exportToExcel(ret, supplier, lines, keys);
  });
  qs('#btn-exp-image', node).addEventListener('click', async () => {
    const keys = selectedKeys();
    if (!keys.length) { toast('اختر عمودًا واحدًا على الأقل', 'error'); return; }
    const btn = qs('#btn-exp-image', node);
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'جارِ التجهيز...';
    try { await exportToImage(ret, supplier, lines, keys); }
    finally { btn.disabled = false; btn.textContent = original; }
  });
  qs('#btn-exp-whatsapp', node).addEventListener('click', async () => {
    const keys = selectedKeys();
    if (!keys.length) { toast('اختر عمودًا واحدًا على الأقل', 'error'); return; }
    const btn = qs('#btn-exp-whatsapp', node);
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'جارِ التجهيز...';
    try { await shareReportImage(ret, supplier, lines, keys); }
    finally { btn.disabled = false; btn.textContent = original; }
  });
  qs('#btn-exp-thermal', node).addEventListener('click', async () => {
    const keys = selectedKeys();
    if (!keys.length) { toast('اختر عمودًا واحدًا على الأقل', 'error'); return; }
    await openThermalPrintView(ret, supplier, lines, keys);
  });
}

// ---------- 1. Excel ----------

export async function exportToExcel(ret, supplier, lines, keys) {
  const shopName = await getSetting('shopName', '');
  const cols = COLUMNS.filter(c => keys.includes(c.key));
  const total = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  const aoa = [
    shopName ? [shopName] : null,
    ['تقرير مرتجعة'],
    ['رقم المرتجعة', ret.returnNumber],
    ['المورد', supplier?.name || '—'],
    ['التاريخ', fmtDate(ret.createdAt, true)],
    ['الحالة', ret.status === 'closed' ? 'مغلقة' : ret.status === 'sent' ? 'تم الإرسال' : 'مسودة'],
    [],
    cols.map(c => c.label),
    ...lines.map(l => cols.map(c => cellValue(l, c.key))),
    [],
    keys.includes('qty') ? ['إجمالي الكمية', totalQty] : null,
    ['الإجمالي', ...Array(Math.max(cols.length - 2, 0)).fill(''), keys.includes('total') ? total : ''],
  ].filter(Boolean);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'مرتجعة');
  XLSX.writeFile(wb, `${ret.returnNumber}.xlsx`);
  toast('تم تصدير ملف Excel', 'success');
}

// ---------- 2. Image ----------

// Column definitions the canvas renderer understands. Text columns are
// flexible (they absorb spare width and wrap); numbers stay at their
// natural width so they line up.
const CANVAS_COLUMNS = {
  supplierName: { label: 'اسم الصنف عند المورد', flex: true, strong: true },
  erpName: { label: 'صنف النظام ERP', flex: true },
  barcode: { label: 'الباركود' },
  qty: { label: 'الكمية' },
  cost: { label: 'تكلفة المورد' },
  total: { label: 'الإجمالي' },
};

function reportSpec(shopName, ret, supplier, lines, keys) {
  const columns = Object.entries(CANVAS_COLUMNS)
    .filter(([key]) => keys.includes(key))
    .map(([key, def]) => ({ key, ...def }));
  const total = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  return {
    shopName,
    // Every extra column needs room; a fixed width would start wrapping
    // item names into three lines as soon as the barcode is switched on.
    width: 640 + Math.max(0, columns.length - 5) * 110,
    title: `مرتجعة ${ret.returnNumber}`,
    subtitle: supplier?.name || '—',
    dateLabel: fmtDate(ret.createdAt, true),
    columns,
    rows: lines.map(l => ({
      supplierName: l.supplierItemName,
      erpName: l.erpItemName || 'غير مرتبط',
      barcode: l.erpBarcode || '—',
      qty: fmtInt(l.qty),
      cost: fmtMoney(l.unitCost),
      total: fmtMoney(l.total),
    })),
    footerRight: keys.includes('qty') ? `إجمالي الكمية: ${fmtInt(totalQty)}` : '',
    footerLeft: keys.includes('total') ? `الإجمالي: ${fmtMoney(total)} جنيه` : '',
  };
}

async function renderReportToBlob(shopName, ret, supplier, lines, keys) {
  const canvas = await drawReport(reportSpec(shopName, ret, supplier, lines, keys));
  return canvasToBlob(canvas);
}

export async function exportToImage(ret, supplier, lines, keys) {
  try {
    const shopName = await getSetting('shopName', '');
    const blob = await renderReportToBlob(shopName, ret, supplier, lines, keys);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${ret.returnNumber}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('تم تنزيل الصورة', 'success');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء إنشاء الصورة', 'error');
  }
}

// ---------- WhatsApp ----------
// A website can never pre-select *which* WhatsApp contact something
// goes to — that choice happens inside WhatsApp's own UI, for the same
// privacy reason no site can read your contacts. What we *can* do:
// hand the image straight to the phone's native share sheet (where
// WhatsApp is one tap away, image already attached) via the Web Share
// API. That only works on browsers that support sharing files — mostly
// mobile Chrome/Safari, over HTTPS. Where it isn't available (typically
// desktop), this falls back to downloading the image and opening
// WhatsApp with a reminder to attach it manually.
export async function shareReportImage(ret, supplier, lines, keys) {
  try {
    const shopName = await getSetting('shopName', '');
    const blob = await renderReportToBlob(shopName, ret, supplier, lines, keys);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }

    const fileName = `${ret.returnNumber}.png`;
    const file = new File([blob], fileName, { type: 'image/png' });
    const shareText = `مرتجعة ${ret.returnNumber}${supplier?.name ? ` — ${supplier.name}` : ''}`;

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: shareText, text: shareText });
      } catch (err) {
        if (err.name !== 'AbortError') throw err; // AbortError = person just closed the share sheet, not a failure
      }
      return;
    }

    // Fallback: no file-sharing support in this browser (common on
    // desktop) — download the image, then open WhatsApp with the
    // person prompted to attach the file that just downloaded.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    const text = encodeURIComponent(`${shareText}\n📎 الصورة اتنزلت على جهازك — أرفقها هنا يدويًا.`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
    toast('اتنزلت الصورة — أرفقها في واتساب يدويًا (المشاركة المباشرة للصور مش مدعومة في هذا المتصفح)', 'success');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء المشاركة', 'error');
  }
}

// ---------- 4. Thermal receipt print ----------

export async function openThermalPrintView(ret, supplier, lines, keys) {
  const shopName = await getSetting('shopName', '');
  const total = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  // Kept deliberately simple: no flexbox, no fixed mm widths, no
  // margin set in two places at once. Thermal receipt drivers vary a
  // lot in what they render correctly — a fluid width with a single
  // padding source and small *tables* (not flex) for the value rows
  // are the combination least likely to clip or drop text. Numbers
  // are bold throughout — thin/regular strokes print faint on most
  // thermal heads. If your paper is 58mm instead of 80mm, change the
  // "size" line below to "58mm auto".
  const rowsHtml = lines.map(l => {
    const showSupplierName = keys.includes('supplierName');
    const showErpName = keys.includes('erpName');
    // Always show *something* as the title — supplier name by default,
    // falling back to the ERP name if supplier name was unchecked.
    const title = showSupplierName ? l.supplierItemName : (showErpName ? (l.erpItemName || 'غير مرتبط') : l.supplierItemName);
    // If both are checked, the ERP name becomes a small line under the title.
    const subtitle = (showSupplierName && showErpName) ? (l.erpItemName || 'غير مرتبط') : null;
    const barcode = keys.includes('barcode') ? (l.erpBarcode || '') : '';
    return `
    <div class="tp-item">
      <div class="tp-item-name">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="tp-item-sub">${escapeHtml(subtitle)}</div>` : ''}
      ${barcode ? `<div class="tp-item-sub">باركود: ${escapeHtml(barcode)}</div>` : ''}
      ${(keys.includes('qty') || keys.includes('cost') || keys.includes('total')) ? `
      <table class="tp-row"><tr>
        ${keys.includes('qty') ? `<td>الكمية: ${fmtInt(l.qty)}</td>` : ''}
        ${keys.includes('cost') ? `<td>السعر: ${fmtMoney(l.unitCost)}</td>` : ''}
        ${keys.includes('total') ? `<td>الإجمالي: ${fmtMoney(l.total)}</td>` : ''}
      </tr></table>` : ''}
    </div>
  `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl"><head><meta charset="UTF-8">
    <title>${escapeHtml(ret.returnNumber)}</title>
    <style>
      @page { size: 80mm auto; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        font-family: 'Tahoma', 'Arial', sans-serif;
        width: 100%;
        padding: 2mm 3mm;
        color: #000;
        font-size: 12px;
        line-height: 1.15;
      }
      .tp-center { text-align: center; }
      .tp-letterhead { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .tp-letterhead td { vertical-align: top; font-size: 10px; font-weight: 700; }
      .tp-letterhead td:first-child { text-align: right; }
      .tp-letterhead td:last-child { text-align: left; }
      .tp-shop { font-size: 13px; font-weight: bold; }
      .tp-tagline { font-size: 9px; font-weight: 700; white-space: nowrap; margin: 1px 0 2px; }
      .tp-title { font-size: 15px; font-weight: bold; margin-bottom: 0; }
      .tp-sub { font-size: 11px; font-weight: 600; color:#000; }
      .tp-divider { border-top: 1px dashed #000; margin: 3px 0; }
      .tp-item { padding: 2px 0; border-bottom: 1px dashed #000; }
      .tp-item-name { font-weight: bold; word-break: break-word; overflow-wrap: break-word; }
      .tp-item-sub { font-size: 11px; font-weight: bold; color: #000; margin-top: 1px; }
      .tp-row { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 1px; }
      .tp-row td { font-size: 12px; font-weight: 700; padding: 0 1px; text-align: center; }
      .tp-grand-row { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 5px; padding-top: 4px; border-top: 1px solid #000; }
      .tp-grand-row td { font-size: 14px; font-weight: 900; text-align: center; padding: 0; }
    </style></head>
    <body>
      <table class="tp-letterhead"><tr>
        <td>${shopName ? `<div class="tp-shop">${escapeHtml(shopName)}</div>` : ''}</td>
        <td>عبدالله &lt;Abo-Lilah&gt;</td>
      </tr></table>
      <div class="tp-tagline">نظام إدارة المخزون والمرتجعات</div>
      <div class="tp-divider"></div>
      <div class="tp-center">
        <div class="tp-title">مرتجعة موردين</div>
        <div class="tp-sub">${escapeHtml(supplier?.name || '—')}</div>
        <div class="tp-sub">${escapeHtml(ret.returnNumber)} · ${fmtDate(ret.createdAt, true)}</div>
      </div>
      <div class="tp-divider"></div>
      ${rowsHtml}
      ${(keys.includes('qty') || keys.includes('total')) ? `
      <table class="tp-grand-row"><tr>
        ${keys.includes('qty') ? `<td>الكمية: ${fmtInt(totalQty)}</td>` : ''}
        ${keys.includes('total') ? `<td>الإجمالي: ${fmtMoney(total)}</td>` : ''}
      </tr></table>` : ''}
    </body></html>
  `;

  try {
    await printHtmlDocument(html);
  } catch (err) {
    console.error(err);
    toast('تعذّر فتح الطباعة على هذا المتصفح', 'error');
  }
}
