// =========================================================
// modules/return-export.js
// Three ways to get a return's report out of the system:
//   1. Excel (.xlsx)               — via SheetJS (loaded globally as XLSX)
//   2. Image (.png)                — via html2canvas, renders an
//                                     off-screen report and captures it
//   3. Thermal receipt print view  — a narrow (80mm) print-only page
//                                     for cashier thermal printers
// All three respect the same column-visibility choices, picked once
// in the export modal (e.g. hide cost columns before handing a copy
// to a driver).
// =========================================================
import { fmtMoney, fmtInt, fmtDate, escapeHtml, openModal, toast, qs, qsa } from '../core/utils.js';
import { getSetting } from '../core/db.js';

const COLUMNS = [
  { key: 'supplierName', label: 'اسم الصنف عند المورد' },
  { key: 'erpName', label: 'صنف النظام ERP' },
  { key: 'qty', label: 'الكمية' },
  { key: 'cost', label: 'تكلفة المورد' },
  { key: 'total', label: 'الإجمالي' },
];

function cellValue(line, key) {
  switch (key) {
    case 'supplierName': return line.supplierItemName;
    case 'erpName': return line.erpItemName || 'غير مرتبط';
    case 'qty': return line.qty;
    case 'cost': return line.unitCost;
    case 'total': return line.total;
    default: return '';
  }
}

export function openExportOptionsModal(ret, lines, supplier) {
  if (!lines.length) { toast('لا توجد أصناف في هذه المرتجعة بعد', 'error'); return; }
  const { node } = openModal({
    title: `تصدير تقرير ${ret.returnNumber}`,
    bodyHtml: `
      <div class="field">
        <label>الأعمدة الظاهرة في التصدير</label>
        <div id="export-columns">
          ${COLUMNS.map(c => `
            <label class="export-col-toggle">
              <input type="checkbox" class="col-toggle" value="${c.key}" checked> ${escapeHtml(c.label)}
            </label>
          `).join('')}
        </div>
        <div class="hint">أخفِ أي عمود (مثل التكلفة) قبل تصدير نسخة تُشارك مع طرف خارجي.</div>
      </div>
      <div class="export-actions">
        <button class="btn btn-primary" id="btn-exp-excel">⬇ تصدير Excel</button>
        <button class="btn btn-ghost" id="btn-exp-image">🖼 تنزيل كصورة</button>
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

function buildReportElement(shopName, ret, supplier, lines, keys, { compact = false } = {}) {
  const cols = COLUMNS.filter(c => keys.includes(c.key));
  const total = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const wrap = document.createElement('div');
  wrap.style.cssText = `direction:rtl;background:#fff;padding:${compact ? '14px' : '28px'};font-family:'Tajawal',system-ui,sans-serif;color:#161C2E;width:${compact ? '300px' : '640px'};`;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1F2A44;padding-bottom:12px;margin-bottom:14px;">
      <div>
        ${shopName ? `<div style="font-weight:900;font-size:${compact ? '12px' : '14px'};color:#5B6479;margin-bottom:2px;">${escapeHtml(shopName)}</div>` : ''}
        <div style="font-weight:900;font-size:${compact ? '15px' : '18px'};">مرتجعة ${escapeHtml(ret.returnNumber)}</div>
        <div style="font-size:${compact ? '11px' : '13px'};color:#5B6479;margin-top:4px;font-weight:600;">${escapeHtml(supplier?.name || '—')}</div>
      </div>
      <div style="font-size:${compact ? '10px' : '12px'};color:#5B6479;text-align:left;font-weight:600;">${fmtDate(ret.createdAt, true)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:${compact ? '10.5px' : '13px'};">
      <thead>
        <tr>${cols.map(c => `<th style="text-align:right;padding:6px 8px;border-bottom:1px solid #CBD1DE;color:#5B6479;font-size:${compact ? '9.5px' : '11px'};font-weight:700;">${escapeHtml(c.label)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${lines.map(l => `<tr>${cols.map(c => `<td style="padding:6px 8px;border-bottom:1px solid #E3E6EC;font-weight:${c.key === 'supplierName' ? 700 : 600};">${c.key === 'cost' || c.key === 'total' ? fmtMoney(cellValue(l, c.key)) : c.key === 'qty' ? fmtInt(cellValue(l, c.key)) : escapeHtml(String(cellValue(l, c.key)))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:14px;padding-top:10px;border-top:2px solid #1F2A44;font-weight:900;font-size:${compact ? '12px' : '15px'};">
      ${keys.includes('qty') ? `<span>إجمالي الكمية: ${fmtInt(totalQty)}</span>` : '<span></span>'}
      ${keys.includes('total') ? `<span>الإجمالي: ${fmtMoney(total)} جنيه</span>` : ''}
    </div>
  `;
  return wrap;
}

export async function exportToImage(ret, supplier, lines, keys) {
  if (typeof html2canvas === 'undefined') { toast('تعذّر تحميل مكتبة تصدير الصور، تحقق من الاتصال بالإنترنت', 'error'); return; }
  const shopName = await getSetting('shopName', '');
  const el = buildReportElement(shopName, ret, supplier, lines, keys);
  el.style.position = 'fixed';
  el.style.top = '0';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  try {
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
    canvas.toBlob((blob) => {
      if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${ret.returnNumber}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('تم تنزيل الصورة', 'success');
    }, 'image/png');
  } catch (err) {
    console.error(err);
    toast('حدث خطأ أثناء إنشاء الصورة', 'error');
  } finally {
    el.remove();
  }
}

// ---------- 3. Thermal receipt print ----------

export async function openThermalPrintView(ret, supplier, lines, keys) {
  const shopName = await getSetting('shopName', '');
  const total = lines.reduce((s, l) => s + (Number(l.total) || 0), 0);
  const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const win = window.open('', '_blank', 'width=380,height=640');
  if (!win) { toast('المتصفح منع فتح نافذة الطباعة، اسمح بالنوافذ المنبثقة وحاول مجددًا', 'error'); return; }

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
    return `
    <div class="tp-item">
      <div class="tp-item-name">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="tp-item-sub">${escapeHtml(subtitle)}</div>` : ''}
      ${(keys.includes('qty') || keys.includes('cost') || keys.includes('total')) ? `
      <table class="tp-row"><tr>
        ${keys.includes('qty') ? `<td>الكمية: ${fmtInt(l.qty)}</td>` : ''}
        ${keys.includes('cost') ? `<td>السعر: ${fmtMoney(l.unitCost)}</td>` : ''}
        ${keys.includes('total') ? `<td>الإجمالي: ${fmtMoney(l.total)}</td>` : ''}
      </tr></table>` : ''}
    </div>
  `;
  }).join('');

  win.document.write(`
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
      .tp-print-btn { display: block; width: 100%; margin-top: 14px; padding: 10px; font-size: 13px; }
      @media print { .tp-print-btn { display: none; } }
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
      <button class="tp-print-btn" onclick="window.print()">🖨 طباعة</button>
    </body></html>
  `);
  win.document.close();
  win.onload = () => { try { win.focus(); win.print(); } catch (e) {} };
}
