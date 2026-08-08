// =========================================================
// core/utils.js — small stateless helpers shared everywhere
// =========================================================

export function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (!withTime) return date;
  const time = d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  return (Number(n) || 0).toLocaleString('ar-EG');
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function normalizeArabic(str) {
  // Loose normalization to make matching/search forgiving of
  // common Arabic typing variants (alef forms, ya/alef-maqsura, ta-marbuta, tatweel, diacritics).
  if (!str) return '';
  return String(str)
    .replace(/[\u064B-\u0652]/g, '')      // diacritics
    .replace(/\u0640/g, '')                // tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function fuzzyIncludes(haystack, needle) {
  if (!needle) return true;
  return normalizeArabic(haystack).includes(normalizeArabic(needle));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

let toastRoot;
export function toast(message, type = 'default') {
  toastRoot = toastRoot || document.getElementById('toast-root');
  const node = el(`<div class="toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}">${escapeHtml(message)}</div>`);
  toastRoot.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .2s'; setTimeout(() => node.remove(), 200); }, 2600);
}

// ---------- Simple modal helper ----------
export function openModal({ title, bodyHtml, wide = false, footerButtons = [], onMount = null }) {
  const root = document.getElementById('modal-root');
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'modal-wide' : ''}">
        <div class="modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button class="modal-close" aria-label="إغلاق">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer"></div>
      </div>
    </div>
  `);
  const footer = backdrop.querySelector('.modal-footer');
  footerButtons.forEach(btn => {
    const b = el(`<button class="btn ${btn.className || ''}">${escapeHtml(btn.label)}</button>`);
    b.addEventListener('click', () => btn.onClick && btn.onClick(close));
    footer.appendChild(b);
  });

  function close() { backdrop.remove(); }
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  root.appendChild(backdrop);
  if (onMount) onMount(backdrop, close);
  return { close, node: backdrop };
}

export function confirmDialog(message, { okLabel = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title: 'تأكيد العملية',
      bodyHtml: `<p style="margin:0;font-size:14px;line-height:1.7;">${escapeHtml(message)}</p>`,
      footerButtons: [
        { label: 'إلغاء', className: 'btn-ghost', onClick: (close) => { close(); resolve(false); } },
        { label: okLabel, className: danger ? 'btn-danger' : 'btn-primary', onClick: (close) => { close(); resolve(true); } },
      ],
    });
  });
}

// ---------- Pagination helper: returns a rendered nav + page slice ----------
export function paginate(items, page, pageSize) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { slice, total, totalPages, page: p, start };
}

export function renderPagination({ page, totalPages, total, pageSize, onPage, onPageSize }) {
  const wrap = el(`<div class="pagination"></div>`);
  const info = el(`<div class="page-info">إجمالي السجلات: <b class="text-mono">${fmtInt(total)}</b></div>`);
  const pagesWrap = el(`<div class="pages"></div>`);

  const maxButtons = 7;
  let pagesToShow = [];
  if (totalPages <= maxButtons) {
    pagesToShow = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pagesToShow = [1, 2, '...', page - 1, page, page + 1, '...', totalPages]
      .filter((v, i, arr) => v !== '...' || arr[i - 1] !== '...')
      .filter(v => v === '...' || (v >= 1 && v <= totalPages));
  }
  pagesToShow.forEach(p => {
    if (p === '...') { pagesWrap.appendChild(el(`<span class="small text-dim" style="padding:0 4px;">…</span>`)); return; }
    const b = el(`<button class="page-btn ${p === page ? 'active' : ''}">${p}</button>`);
    b.addEventListener('click', () => onPage(p));
    pagesWrap.appendChild(b);
  });

  const sizeWrap = el(`
    <select class="page-size-select">
      ${[25, 50, 100].map(s => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} / صفحة</option>`).join('')}
    </select>
  `);
  sizeWrap.addEventListener('change', () => onPageSize(Number(sizeWrap.value)));

  const left = el(`<div class="flex items-center gap-8"></div>`);
  left.append(info, sizeWrap);
  wrap.append(left, pagesWrap);
  return wrap;
}
