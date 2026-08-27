// =========================================================
// modules/thermal-receipt.js — the 80mm receipt, one design
//
// Both the return and the invoice review print on the same roll,
// on the same machine, for the same people — so they are the same
// document with different contents rather than two lookalikes that
// drift apart. The invoice review used to print a wall of plain
// text; it now goes through here.
//
// Deliberately simple markup: no flexbox, no fixed mm widths, no
// margin set in two places at once. Thermal receipt drivers vary a
// lot in what they render correctly — a fluid width with a single
// padding source and small *tables* (not flex) for the value rows
// are the combination least likely to clip or drop text. Numbers
// are bold throughout: thin strokes print faint on most thermal
// heads. If your paper is 58mm instead of 80mm, change "size"
// in RECEIPT_CSS to "58mm auto".
// =========================================================
import { escapeHtml } from '../core/utils.js';

// Whoever built the system, on every receipt it prints.
const AUTHOR = 'عبدالله <Abo-Lilah>';

const RECEIPT_CSS = `
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
`;

// One item: a bold title, any number of small lines under it (the ERP
// name, a barcode), then rows of figures laid out as evenly spaced cells.
// Empty cells and empty rows are dropped rather than printed as gaps.
function itemHtml({ name, subs = [], rows = [] }) {
  const subsHtml = subs.filter(Boolean)
    .map(s => `<div class="tp-item-sub">${escapeHtml(s)}</div>`).join('');
  const rowsHtml = rows
    .map(cells => cells.filter(Boolean))
    .filter(cells => cells.length)
    .map(cells => `<table class="tp-row"><tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr></table>`)
    .join('');
  return `
    <div class="tp-item">
      <div class="tp-item-name">${escapeHtml(name)}</div>
      ${subsHtml}
      ${rowsHtml}
    </div>`;
}

export function buildThermalReceipt({
  shopName = '',
  tagline,
  title,
  documentTitle = title,
  subtitles = [],
  items = [],
  grand = [],
}) {
  const grandCells = grand.filter(Boolean);
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<title>${escapeHtml(documentTitle)}</title>
<style>${RECEIPT_CSS}</style></head>
<body>
  <table class="tp-letterhead"><tr>
    <td>${shopName ? `<div class="tp-shop">${escapeHtml(shopName)}</div>` : ''}</td>
    <td>${escapeHtml(AUTHOR)}</td>
  </tr></table>
  <div class="tp-tagline">${escapeHtml(tagline)}</div>
  <div class="tp-divider"></div>
  <div class="tp-center">
    <div class="tp-title">${escapeHtml(title)}</div>
    ${subtitles.filter(Boolean).map(s => `<div class="tp-sub">${escapeHtml(s)}</div>`).join('')}
  </div>
  <div class="tp-divider"></div>
  ${items.map(itemHtml).join('')}
  ${grandCells.length
    ? `<table class="tp-grand-row"><tr>${grandCells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr></table>`
    : ''}
</body></html>`;
}
