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

// Arabic locale, Latin digits. Plain 'ar-EG' formats with Arabic-Indic
// numerals (١٩٠٠٫٠٠), but <input type="number"> always shows Latin ones
// whatever the locale — so the same figure appeared as ١٩ in the box you
// type in and ١٩٠٠٫٠٠ in the total beside it, and the Arabic thousands
// and decimal marks (٬ ٫) are easy to confuse with each other. One
// numeral system across every screen, export and printout.
const NUM_LOCALE = 'ar-EG-u-nu-latn';

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(NUM_LOCALE, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (!withTime) return date;
  const time = d.toLocaleTimeString(NUM_LOCALE, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(NUM_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  return (Number(n) || 0).toLocaleString(NUM_LOCALE);
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

// Re-rendering a whole screen replaces every node inside it — including
// the search box the person is currently typing into, which silently
// drops focus and the caret in the middle of a word. This swaps the
// markup in, then puts focus (and the caret position) back where it was.
export function renderPreservingFocus(container, html) {
  const active = document.activeElement;
  const keepId = (active && active.id && container.contains(active)) ? active.id : null;
  let start = null, end = null;
  if (keepId) {
    try { start = active.selectionStart; end = active.selectionEnd; } catch (e) { /* not a text field */ }
  }

  container.innerHTML = html;

  if (!keepId) return;
  const next = container.querySelector(`#${CSS.escape(keepId)}`);
  if (!next) return;
  next.focus();
  if (start !== null && typeof next.setSelectionRange === 'function') {
    try { next.setSelectionRange(start, end); } catch (e) { /* input type without a caret */ }
  }
}

// Event handlers that await a write used to fail silently: the promise
// rejected, the console got a stack trace, and the person just saw a
// button that did nothing. This surfaces the reason as a toast instead.
export function guarded(fn, fallbackMessage = 'حصلت مشكلة، حاول تاني') {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(err);
      toast((err && err.message) || fallbackMessage, 'error');
    }
  };
}

// Wraps a submit handler so its button is disabled while it runs. Adding
// a line means a cloud round trip, which is long enough to click through
// twice — and a second click that gets in before the first finishes adds
// the row a second time. The button is only restored on the way out if it
// is still on the page: a successful add usually re-renders the screen,
// and the button restored then would be a detached one.
export function submitOnce(button, handler, { busyLabel = 'جارِ الحفظ...' } = {}) {
  return async (...args) => {
    if (!button || button.disabled) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await handler(...args);
    } catch (err) {
      console.error(err);
      toast((err && err.message) || 'حصلت مشكلة، حاول تاني', 'error');
    } finally {
      if (button.isConnected) { button.disabled = false; button.textContent = originalLabel; }
    }
  };
}

// Names the ERP item behind the supplier item just picked on an add card.
// The suggestion list carries it, but only while the list is open — after
// picking, the field holds the supplier's name for the thing and nothing
// says which ERP item it will be filed against, so choosing the wrong row
// only showed up once the line was on the return.
//   picked with a link  -> names the ERP item
//   picked without one  -> says so, since it exports and posts unlinked
//   a name being added  -> says it will be created for this supplier
//   nothing picked      -> hidden
export function renderPickedErp(node, { state = 'none', erpName = '' } = {}) {
  if (!node) return;
  if (state === 'none') { node.style.display = 'none'; node.innerHTML = ''; return; }
  node.style.display = '';
  // The button is the same offer in all three unlinked states: pick the ERP
  // item now, here, instead of adding the line and going to find it after.
  const pick = (label) => `<button type="button" class="btn btn-sm btn-ghost btn-pick-erp">${label}</button>`;
  if (state === 'linked') {
    node.innerHTML = `صنف ERP: <b>${escapeHtml(erpName)}</b>`;
  } else if (state === 'will-link') {
    node.innerHTML = `هيتربط بصنف ERP: <b>${escapeHtml(erpName)}</b> ${pick('تغيير')}`;
  } else if (state === 'new') {
    node.innerHTML = `صنف جديد — هيتسجّل عند المورد ${pick('🔗 اربطه بصنف ERP')}`;
  } else {
    node.innerHTML = `<span class="badge badge-warn">⚠️ مش مربوط بصنف ERP</span> ${pick('🔗 ربط')}`;
  }
}

// Closes any open autocomplete dropdown when the click lands outside it.
// Registered per screen render and returned as a disposer — the previous
// version used { once: true }, which meant the very first click anywhere
// (even inside the dropdown itself) consumed the listener and every later
// outside-click left the dropdown stuck open.
export function closeOnOutsideClick(boxes) {
  const list = Array.isArray(boxes) ? boxes : [boxes];
  const handler = (e) => {
    if (e.target.closest('.autocomplete')) return;
    list.forEach(b => { if (b) b.style.display = 'none'; });
  };
  document.addEventListener('click', handler);
  return () => document.removeEventListener('click', handler);
}

// Prints a standalone HTML document without opening a window.
// window.open() is blocked by default on mobile browsers, which is why
// printing a receipt from a phone only ever produced "المتصفح منع فتح
// نافذة الطباعة". An offscreen iframe needs no popup permission and
// prints with the document's own @page rules.
export function printHtmlDocument(html) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    // A real height, not zero: a frame with no height lays its document out
    // in a zero-height viewport and hands the printer nothing.
    frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:80mm;height:800px;border:0;';

    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };

    frame.onload = () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;

      // The frame has to outlive the print dialog. A phone renders its print
      // preview after the dialog opens, while the person is still choosing a
      // printer, so pulling the frame away on a short timer prints blank.
      // It goes when the browser says printing is over — but never in the
      // first few seconds, since some browsers fire that event immediately
      // when no printer is attached.
      let removed = false;
      const openedAt = Date.now();
      const drop = () => {
        if (removed) return;
        const tooSoon = 8000 - (Date.now() - openedAt);
        if (tooSoon > 0) { setTimeout(drop, tooSoon); return; }
        removed = true;
        frame.remove();
      };
      try { win.addEventListener('afterprint', drop, { once: true }); } catch (e) { /* older browsers */ }
      setTimeout(drop, 60000);

      const fontsReady = (doc && doc.fonts && doc.fonts.ready) || Promise.resolve();
      Promise.resolve(fontsReady).catch(() => {}).then(() => {
        try {
          // Sized to what it holds, so a long receipt is not cut off.
          if (doc && doc.documentElement) {
            frame.style.height = `${Math.max(800, doc.documentElement.scrollHeight)}px`;
          }
          win.focus();
          win.print();
          finish();
        } catch (err) {
          removed = true;
          frame.remove();
          finish(err);
        }
      });
    };
    frame.onerror = () => { frame.remove(); finish(new Error('تعذّر تجهيز صفحة الطباعة')); };

    // The content goes on before the frame goes in. An iframe inserted empty
    // gets an about:blank document and fires load for *that* — and that load
    // is what triggered the print, so what reached the printer was a blank
    // page every time, with the receipt arriving in the frame afterwards.
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
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

  // Anything a modal wires up outside its own subtree (a document-level
  // click listener, a timer) registers its teardown here so it dies with
  // the modal instead of piling up every time one is opened.
  const cleanups = [];
  function close() {
    cleanups.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    backdrop.remove();
  }
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  root.appendChild(backdrop);
  if (onMount) onMount(backdrop, close);
  return { close, node: backdrop, onClose: (fn) => cleanups.push(fn) };
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
