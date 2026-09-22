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
// numerals (١٩٠٠٫٠٠), whose thousands and decimal marks (٬ ٫) are easy to
// confuse with each other, and which read as a different set of figures
// again next to the ones typed into a field. One numeral system across
// every screen, export and printout — and numberField() below is the
// other half of that, for the figures you type rather than read.
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

// One numeral system, in both directions. Everything the app *prints* is
// already Latin (see NUM_LOCALE), but an Arabic keyboard types ٠١٢٣ and
// those are different characters: searching "١٢" found nothing in "كريب
// سادة 12", a barcode typed that way could never be found again, and the
// number-to-words tool refused the input outright. Folded here so the two
// ways of writing a number mean the same thing wherever one is read.
// Covers Arabic-Indic (٠-٩) and the Extended set (۰-۹) some keyboards
// send, plus the Arabic decimal and thousands marks.
const DIGIT_FOLD = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٫': '.', '٬': '',
};

export function toLatinDigits(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[٠-٩۰-۹٫٬]/g, (ch) => DIGIT_FOLD[ch] ?? ch);
}

// A field you type a number into. Not <input type="number">: that one
// draws its value in the browser's own language, so on an Arabic Chrome
// the 1100 you just typed reads back ١١٠٠ — and ١٦٫٥ with an Arabic
// decimal mark — right beside a total the app itself wrote as 1,100.00.
// Nothing on the page can turn that off; it follows the browser, not the
// page's lang. So the value is ours to draw and it is Latin everywhere,
// the way every printed figure already is.
//
// inputmode="decimal" keeps the numeric keypad on a phone, the filter in
// wireNumericFields() keeps anything that isn't a number out, and the
// spinner the native field used to draw is rebuilt as two buttons — which
// a phone can use too, where the native one never appeared at all.
export function numberField({
  value = '', id = '', cls = '', placeholder = '', min = null, max = null,
  step = 'any', width = '', align = '', title = '', attrs = '',
} = {}) {
  const parts = ['type="text"', 'inputmode="decimal"', 'data-numeric="1"', `data-step="${escapeHtml(String(step))}"`];
  if (min !== null && min !== '') parts.push(`data-min="${escapeHtml(String(min))}"`);
  if (max !== null && max !== '') parts.push(`data-max="${escapeHtml(String(max))}"`);
  if (id) parts.push(`id="${escapeHtml(id)}"`);
  if (cls) parts.push(`class="${escapeHtml(cls.trim())}"`);
  if (placeholder) parts.push(`placeholder="${escapeHtml(placeholder)}"`);
  if (title) parts.push(`title="${escapeHtml(title)}"`);
  if (align) parts.push(`style="text-align:${escapeHtml(align)};"`);
  if (attrs) parts.push(attrs);
  parts.push(`value="${escapeHtml(value === null || value === undefined ? '' : String(value))}"`);
  return `<span class="num-field"${width ? ` style="width:${escapeHtml(width)};"` : ''}>`
    + `<input ${parts.join(' ')}>`
    + '<span class="num-spin">'
    + '<button type="button" class="num-step" data-dir="1" tabindex="-1" aria-label="زيادة">▲</button>'
    + '<button type="button" class="num-step" data-dir="-1" tabindex="-1" aria-label="نقصان">▼</button>'
    + '</span></span>';
}

// Anything that is still a number while it is being typed: "", "12",
// "12.", "12.5", ".5". Kept deliberately loose — a half-typed decimal is
// not an error, it is someone mid-word.
const PARTIAL_NUMBER = /^\d*\.?\d*$/;

function isNumericField(el) {
  return el instanceof HTMLInputElement && el.dataset && el.dataset.numeric !== undefined;
}

function fieldBound(el, key) {
  const raw = el.dataset[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(toLatinDigits(raw));
  return Number.isFinite(n) ? n : null;
}

// One press of an arrow, one notch of the wheel, one tap of the spinner.
// step="any" (a quantity) moves by one; a price moves by its own step, so
// the figures stay on the same precision instead of drifting into
// 1100.0000000000002.
function stepNumericField(el, dir) {
  const declared = Number(toLatinDigits(el.dataset.step || ''));
  const step = Number.isFinite(declared) && declared > 0 ? declared : 1;
  const current = Number(toLatinDigits(el.value));
  const from = Number.isFinite(current) ? current : 0;
  const decimals = (String(step).split('.')[1] || '').length;
  let next = Number((from + dir * step).toFixed(decimals));
  const min = fieldBound(el, 'min');
  const max = fieldBound(el, 'max');
  if (min !== null && next < min) next = min;
  if (max !== null && next > max) next = max;
  const text = String(next);
  if (text === el.value) return;
  el.value = text;
  // What a native number field fires when its arrows are used: the first
  // drives the running totals and the autosave debounce, the second is
  // what pushes a price out as the supplier's cost.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// One numeral system at the keyboard, too. An Arabic keyboard sends ٠١٢٣
// and those are different characters: they used to vanish on the way into
// a number field, which read as the app ignoring what was typed. They are
// rewritten to Latin as they arrive, so either keyboard types the same
// number — and since the field is a text field now, the filter here is
// also what keeps letters out of it.
export function wireNumericFields(root = document) {
  root.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (!isNumericField(el)) return;
    const incoming = e.data !== null && e.data !== undefined
      ? e.data
      : (e.dataTransfer ? e.dataTransfer.getData('text') : '');
    if (!incoming) return;                       // backspace, delete, cut — nothing to vet
    const cleaned = toLatinDigits(incoming).replace(/[^\d.]/g, '');
    const start = el.selectionStart === null ? el.value.length : el.selectionStart;
    const end = el.selectionEnd === null ? el.value.length : el.selectionEnd;
    const next = el.value.slice(0, start) + cleaned + el.value.slice(end);
    const ok = PARTIAL_NUMBER.test(next);
    if (cleaned === incoming && ok) return;      // plain Latin, still a number — leave it alone
    e.preventDefault();
    if (!cleaned || !ok) return;                 // a letter, a second decimal point — dropped
    el.value = next;
    const caret = start + cleaned.length;
    try { el.setSelectionRange(caret, caret); } catch { /* field not selectable */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  root.addEventListener('keydown', (e) => {
    if (!isNumericField(e.target)) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    stepNumericField(e.target, e.key === 'ArrowUp' ? 1 : -1);
  });

  // Only while the field has focus, exactly like the native one — the
  // wheel over a table you are scrolling must stay a scroll.
  root.addEventListener('wheel', (e) => {
    const el = e.target;
    if (!isNumericField(el) || !e.deltaY) return;
    if (el.ownerDocument.activeElement !== el) return;
    e.preventDefault();
    stepNumericField(el, e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // A value the person typed reaches 'change' on blur by itself. One we
  // wrote into the field for them — a folded Arabic digit, a filtered
  // keystroke — does not: Chrome drops its own "edited" mark the moment a
  // script touches the value, so a price typed on an Arabic keyboard blurred
  // without ever firing the event that pushes it out as the supplier's
  // cost. The field remembers what it last committed and says it itself,
  // once, and never on top of the browser's own.
  root.addEventListener('focus', (e) => {
    if (isNumericField(e.target)) e.target.dataset.numWas = e.target.value;
  }, true);
  root.addEventListener('change', (e) => {
    if (isNumericField(e.target)) e.target.dataset.numWas = e.target.value;
  }, true);
  root.addEventListener('blur', (e) => {
    const el = e.target;
    if (!isNumericField(el)) return;
    // "12." and ".5" are half-typed, not wrong — tidied on the way out so
    // what stays on screen reads like the number that was saved.
    if (el.value.endsWith('.') || el.value.startsWith('.')) {
      const n = Number(el.value);
      el.value = Number.isFinite(n) ? String(n) : '';
    }
    const was = el.dataset.numWas;
    delete el.dataset.numWas;
    if (was === undefined) return;
    // By what it means, not by how it is written: tidying "12." to "12" is
    // not a change to announce on top of the one the browser just made.
    const sameNumber = Number(was || 0) === Number(el.value || 0) && (was === '') === (el.value === '');
    if (!sameNumber) el.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);

  root.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.num-step') : null;
    if (!btn) return;
    const el = btn.closest('.num-field')?.querySelector('input[data-numeric]');
    if (!el) return;
    e.preventDefault();
    el.focus();
    stepNumericField(el, btn.dataset.dir === '-1' ? -1 : 1);
  });
}

export function normalizeArabic(str) {
  // Loose normalization to make matching/search forgiving of
  // common Arabic typing variants (alef forms, ya/alef-maqsura, ta-marbuta, tatweel, diacritics).
  if (!str) return '';
  return toLatinDigits(str)
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
