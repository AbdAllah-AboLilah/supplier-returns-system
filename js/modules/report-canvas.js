// =========================================================
// modules/report-canvas.js
//
// Draws a report straight onto a <canvas> with fillText.
//
// This replaces html2canvas for image export. html2canvas does not
// render a page — it re-implements text layout itself, measuring and
// positioning word by word, and on Arabic it dropped the spaces
// between words ("اسم الصنف عند المورد" came out "اسمالصنفعندالمورد").
// fillText hands the string to the browser's own text engine, so
// shaping, bidi and spacing are simply correct. It also means image
// export no longer depends on a CDN being reachable, and works offline.
// =========================================================

const FONT = "'Tajawal', system-ui, -apple-system, 'Segoe UI', sans-serif";
const INK = '#161C2E';
const MUTED = '#5B6479';
const LINE = '#E3E6EC';
const LINE_STRONG = '#CBD1DE';
const RULE = '#1F2A44';

const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

// Google Fonts loads Tajawal asynchronously. Drawing before it arrives
// silently falls back to a system font, so wait for it — but never hang
// the export on it.
async function waitForFont() {
  if (!document.fonts) return;
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`400 14px 'Tajawal'`), document.fonts.load(`700 14px 'Tajawal'`)]),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
  } catch (e) { /* fall back to the system font */ }
}

function wrapText(ctx, text, maxWidth) {
  const value = String(text ?? '');
  if (!value) return [''];
  if (ctx.measureText(value).width <= maxWidth) return [value];

  const words = value.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  // A single word longer than the column still has to fit somehow.
  return lines.flatMap(line => {
    if (ctx.measureText(line).width <= maxWidth) return [line];
    const chunks = [];
    let chunk = '';
    for (const ch of line) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) { chunks.push(chunk); chunk = ch; }
      else chunk += ch;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  });
}

// Column widths from the actual content: measure every cell, then scale
// the flexible (text) columns down proportionally if the total overflows.
function layoutColumns(ctx, columns, rows, available, gap) {
  const natural = columns.map(col => {
    ctx.font = font(11, 700);
    let widest = ctx.measureText(col.label).width;
    ctx.font = font(13, col.strong ? 700 : 600);
    rows.forEach(row => { widest = Math.max(widest, ctx.measureText(String(row[col.key] ?? '')).width); });
    return widest;
  });

  const totalGaps = gap * (columns.length - 1);
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  if (totalNatural + totalGaps <= available) {
    // Spare room goes to the flexible columns so the table fills the width.
    const flexIndexes = columns.map((c, i) => (c.flex ? i : -1)).filter(i => i >= 0);
    const spare = available - totalNatural - totalGaps;
    const share = flexIndexes.length ? spare / flexIndexes.length : 0;
    return natural.map((w, i) => w + (flexIndexes.includes(i) ? share : 0));
  }

  // Overflow: keep the numeric columns intact, squeeze the text ones.
  const fixedTotal = columns.reduce((sum, c, i) => sum + (c.flex ? 0 : natural[i]), 0);
  const flexAvailable = Math.max(60 * columns.filter(c => c.flex).length, available - totalGaps - fixedTotal);
  const flexNatural = columns.reduce((sum, c, i) => sum + (c.flex ? natural[i] : 0), 0) || 1;
  return natural.map((w, i) => (columns[i].flex ? Math.max(60, (w / flexNatural) * flexAvailable) : w));
}

/**
 * Draws a report and returns the canvas.
 * columns: [{ key, label, flex?, strong?, align? }]
 * rows:    [{ [key]: string }]
 */
export async function drawReport({
  shopName = '', title, subtitle = '', dateLabel = '',
  columns, rows, footerLeft = '', footerRight = '',
  width = 640, scale = 2, pad = 28,
}) {
  await waitForFont();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const contentWidth = width - pad * 2;
  const gap = 22; // enough that two right-aligned headers never read as one word

  // Pass 1 — measure, so the canvas is exactly as tall as the content.
  ctx.font = font(13, 600);
  const colWidths = layoutColumns(ctx, columns, rows, contentWidth, gap);
  const rowLines = rows.map(row => columns.map((col, i) => {
    ctx.font = font(13, col.strong ? 700 : 600);
    return wrapText(ctx, row[col.key], colWidths[i]);
  }));

  const lineHeight = 19;
  const rowPadding = 10;
  const rowHeights = rowLines.map(cells => Math.max(...cells.map(l => l.length)) * lineHeight + rowPadding);

  const headerHeight = pad + (shopName ? 20 : 0) + 26 + (subtitle ? 20 : 0) + 16;
  const tableHeaderHeight = 26;
  const footerHeight = (footerLeft || footerRight) ? 46 : 0;
  const height = headerHeight + tableHeaderHeight + rowHeights.reduce((a, b) => a + b, 0) + footerHeight + pad;

  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.style.width = width + 'px';
  ctx.scale(scale, scale);

  // Pass 2 — draw.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // Right-to-left text, drawn from the right edge inward.
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';

  const right = width - pad;
  const left = pad;
  let y = pad;

  if (shopName) {
    ctx.font = font(13, 700); ctx.fillStyle = MUTED;
    ctx.fillText(shopName, right, y + 12);
    y += 20;
  }
  ctx.font = font(18, 700); ctx.fillStyle = INK;
  ctx.fillText(title, right, y + 16);

  if (dateLabel) {
    ctx.font = font(12, 600); ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(dateLabel, left, y + 14);
    ctx.textAlign = 'right';
  }
  y += 26;

  if (subtitle) {
    ctx.font = font(13, 600); ctx.fillStyle = MUTED;
    ctx.fillText(subtitle, right, y + 12);
    y += 20;
  }

  y += 8;
  ctx.strokeStyle = RULE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  y += 8;

  // Column start positions, laid out right to left.
  const colRight = [];
  let cursor = right;
  columns.forEach((col, i) => { colRight.push(cursor); cursor -= colWidths[i] + gap; });

  ctx.font = font(11, 700); ctx.fillStyle = MUTED;
  columns.forEach((col, i) => ctx.fillText(col.label, colRight[i], y + 12));
  y += tableHeaderHeight - 8;
  ctx.strokeStyle = LINE_STRONG; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, y + 0.5); ctx.lineTo(right, y + 0.5); ctx.stroke();
  y += 8;

  rowLines.forEach((cells, rowIndex) => {
    cells.forEach((lines, colIndex) => {
      ctx.font = font(13, columns[colIndex].strong ? 700 : 600);
      ctx.fillStyle = INK;
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, colRight[colIndex], y + 13 + lineIndex * lineHeight);
      });
    });
    y += rowHeights[rowIndex];
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y - 4.5); ctx.lineTo(right, y - 4.5); ctx.stroke();
  });

  if (footerLeft || footerRight) {
    y += 6;
    ctx.strokeStyle = RULE; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    y += 10;
    ctx.font = font(15, 700); ctx.fillStyle = INK;
    if (footerRight) ctx.fillText(footerRight, right, y + 14);
    if (footerLeft) { ctx.textAlign = 'left'; ctx.fillText(footerLeft, left, y + 14); ctx.textAlign = 'right'; }
  }

  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
