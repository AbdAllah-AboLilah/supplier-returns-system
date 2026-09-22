// =========================================================
// modules/supplier-items-export.js — the supplier's price list
//
// A supplier's own names, what each one is filed as on ERP, and what
// they cost — as something you can hand over, print on the till roll,
// or keep as a picture. The same four ways out as a return and an
// invoice review, off the same two renderers, so a price list looks
// like everything else the shop prints.
//
// It exports what is on screen: the panel's filters (غير مرتبط فقط /
// بدون تكلفة فقط) narrow the list, and a list narrowed that way is
// usually exactly the list worth sending to someone.
// =========================================================
import { fmtMoney, fmtInt, fmtDate, escapeHtml, toast, qs, qsa, printHtmlDocument, nowIso } from '../core/utils.js';
import { getSetting } from '../core/db.js';
import { drawReport, canvasToBlob } from './report-canvas.js';
import { buildThermalReceipt } from './thermal-receipt.js';

export const SUPPLIER_ITEM_COLUMNS = [
  { key: 'supplierName', label: 'اسم الصنف عند المورد', flex: true, strong: true },
  { key: 'erpName', label: 'صنف النظام ERP', flex: true },
  { key: 'barcode', label: 'الباركود' },
  { key: 'cost', label: 'التكلفة' },
];

export const DEFAULT_SUPPLIER_ITEM_KEYS = SUPPLIER_ITEM_COLUMNS.map(c => c.key);

function cellValue(row, key) {
  switch (key) {
    case 'supplierName': return row.supplierItemName || '—';
    case 'erpName': return row.erpItemName || 'غير مرتبط';
    case 'barcode': return row.erpBarcode || '—';
    // A cost of zero is not a price, it is a price nobody has set yet.
    case 'cost': return Number(row.currentCost) > 0 ? fmtMoney(row.currentCost) : 'لم تُحدَّد';
    default: return '';
  }
}

function priced(rows) {
  return rows.filter(r => Number(r.currentCost) > 0);
}

export function buildSupplierItemsReportSpec(supplier, rows, keys = DEFAULT_SUPPLIER_ITEM_KEYS, shopName = '') {
  const columns = SUPPLIER_ITEM_COLUMNS.filter(c => keys.includes(c.key));
  const withCost = priced(rows);
  return {
    shopName,
    width: 460 + columns.length * 80,
    title: 'أصناف المورد وأسعارها',
    subtitle: supplier?.name || '—',
    dateLabel: `تاريخ التقرير: ${fmtDate(nowIso(), true)}`,
    columns,
    rows: rows.map(r => Object.fromEntries(columns.map(c => [c.key, cellValue(r, c.key)]))),
    footerRight: `${fmtInt(rows.length)} صنف`,
    footerLeft: keys.includes('cost') && withCost.length < rows.length
      ? `${fmtInt(rows.length - withCost.length)} منها بدون تكلفة`
      : '',
  };
}

export function buildSupplierItemsReceipt(supplier, rows, keys = DEFAULT_SUPPLIER_ITEM_KEYS, shopName = '') {
  const on = (key) => keys.includes(key);
  const withCost = priced(rows);
  return buildThermalReceipt({
    shopName,
    tagline: 'نظام إدارة المخزون ومراجعة الفواتير',
    title: 'أصناف المورد وأسعارها',
    documentTitle: `أصناف ${supplier?.name || ''}`.trim(),
    subtitles: [supplier?.name || '—', `تاريخ التقرير: ${fmtDate(nowIso(), true)}`],
    items: rows.map(r => ({
      name: on('supplierName') ? (r.supplierItemName || '—') : (r.erpItemName || 'غير مرتبط'),
      subs: [
        (on('supplierName') && on('erpName')) ? (r.erpItemName || 'غير مرتبط') : '',
        on('barcode') && r.erpBarcode ? `باركود: ${r.erpBarcode}` : '',
      ],
      rows: [[on('cost') ? `التكلفة: ${cellValue(r, 'cost')}` : '']],
    })),
    grand: [
      `${fmtInt(rows.length)} صنف`,
      on('cost') && withCost.length < rows.length ? `${fmtInt(rows.length - withCost.length)} بدون تكلفة` : '',
    ],
  });
}

export function supplierItemsText(supplier, rows, keys = DEFAULT_SUPPLIER_ITEM_KEYS) {
  const lines = [`أصناف المورد وأسعارها — ${supplier?.name || '—'}`, `تاريخ التقرير: ${fmtDate(nowIso(), true)}`, ''];
  rows.forEach((r, idx) => {
    const head = keys.includes('supplierName') ? `${cellValue(r, 'supplierName')} — ` : '';
    const parts = SUPPLIER_ITEM_COLUMNS
      .filter(c => c.key !== 'supplierName' && keys.includes(c.key))
      .map(c => `${c.label}: ${cellValue(r, c.key)}`);
    lines.push(`${idx + 1}. ${head}${parts.join(' | ')}`);
  });
  lines.push('', `الإجمالي: ${fmtInt(rows.length)} صنف`);
  return lines.join('\n');
}

// ---------- the card on the supplier's items panel ----------

export function supplierItemsExportHtml(rowCount) {
  if (!rowCount) return '';
  return `
    <div class="card card-pad mt-16" id="si-export">
      <div class="section-title">تقرير أصناف المورد</div>
      <div class="field">
        <label>الأعمدة الظاهرة في التقرير</label>
        <div id="si-export-columns">
          ${SUPPLIER_ITEM_COLUMNS.map(c => `
            <label class="export-col-toggle">
              <input type="checkbox" class="si-col-toggle" value="${c.key}" checked> ${escapeHtml(c.label)}
            </label>
          `).join('')}
        </div>
        <div class="hint">التقرير بيطلع بالأصناف الظاهرة قدامك — لو مفلتر، هيطلع مفلتر.</div>
      </div>
      <div class="flex gap-8" style="flex-wrap:wrap;margin-top:12px;">
        <button class="btn btn-ghost" id="btn-si-copy">📋 نسخ كنص</button>
        <button class="btn btn-ghost" id="btn-si-img">🖼 تنزيل كصورة</button>
        <button class="btn btn-ghost" id="btn-si-whatsapp">📱 واتساب</button>
        <button class="btn btn-gold" id="btn-si-print">🖨 طباعة</button>
      </div>
    </div>`;
}

async function toBlob(supplier, rows, keys, shopName) {
  const canvas = await drawReport(buildSupplierItemsReportSpec(supplier, rows, keys, shopName));
  return canvasToBlob(canvas);
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function wireSupplierItemsExport(container, supplier, rows) {
  const card = qs('#si-export', container);
  if (!card) return;
  const keys = () => qsa('.si-col-toggle', container).filter(cb => cb.checked).map(cb => cb.value);
  const fileName = `أصناف ${supplier?.name || 'المورد'}.png`;
  const title = `أصناف المورد وأسعارها — ${supplier?.name || '—'}`;

  const run = (fn) => async () => {
    const chosen = keys();
    if (!chosen.length) { toast('اختر عمودًا واحدًا على الأقل', 'error'); return; }
    const shopName = await getSetting('shopName', '');
    try { await fn(chosen, shopName); }
    catch (err) { console.error(err); toast('حدث خطأ أثناء تجهيز التقرير', 'error'); }
  };

  qs('#btn-si-copy', container).addEventListener('click', run(async (chosen) => {
    await navigator.clipboard.writeText(supplierItemsText(supplier, rows, chosen));
    toast('تم نسخ التقرير', 'success');
  }));

  qs('#btn-si-img', container).addEventListener('click', run(async (chosen, shopName) => {
    const blob = await toBlob(supplier, rows, chosen, shopName);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
    saveBlob(blob, fileName);
    toast('تم تنزيل الصورة', 'success');
  }));

  qs('#btn-si-whatsapp', container).addEventListener('click', run(async (chosen, shopName) => {
    const blob = await toBlob(supplier, rows, chosen, shopName);
    if (!blob) { toast('تعذّر إنشاء الصورة', 'error'); return; }
    const file = new File([blob], fileName, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title, text: title }); }
      catch (err) { if (err.name !== 'AbortError') throw err; }
      return;
    }
    saveBlob(blob, fileName);
    window.open(`https://wa.me/?text=${encodeURIComponent(title + '\n📎 الصورة اتنزلت — أرفقها يدويًا.')}`, '_blank');
    toast('اتنزلت الصورة — أرفقها في واتساب يدويًا', 'success');
  }));

  qs('#btn-si-print', container).addEventListener('click', run(async (chosen, shopName) => {
    await printHtmlDocument(buildSupplierItemsReceipt(supplier, rows, chosen, shopName));
  }));
}
