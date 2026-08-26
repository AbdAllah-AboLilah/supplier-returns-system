// =========================================================
// modules/dashboard.js — الرئيسية
// =========================================================
import { getAll } from '../core/db.js';
import { fmtMoney, fmtInt, fmtDate, escapeHtml } from '../core/utils.js';
import { navigate } from '../core/router.js';
import { listReturnsJoined } from './returns.js';
import { listUnlinked } from './supplier-items.js';

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// The dashboard is a snapshot fetched once per visit, not a live
// subscription — so if you leave it open (or come back to an already-
// open tab) after data changed on this or another device, it used to
// just sit there unchanged until you navigated away and back. This
// keeps it refreshing quietly while it's actually the visible screen,
// and cleans itself up the moment you navigate elsewhere so it doesn't
// keep firing (or pile up duplicate timers) in the background.
let refreshTimer = null;
let visibilityHandler = null;
// Each refresh is a handful of whole-collection reads. Coming back to
// the tab already triggers one (see the visibility handler below), so
// the timer only needs to cover the case of sitting on this screen with
// it open — a minute is plenty, and it no longer burns reads in a tab
// nobody is looking at.
const REFRESH_INTERVAL_MS = 60000;

function onDashboard() {
  const hash = window.location.hash || '#/dashboard';
  return hash === '#/dashboard' || hash === '#/' || hash === '';
}

function cleanupDashboardRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null; }
}

export async function renderDashboard(container) {
  cleanupDashboardRefresh();
  await renderDashboardContent(container);

  refreshTimer = setInterval(() => {
    if (!onDashboard()) { cleanupDashboardRefresh(); return; }
    if (document.visibilityState !== 'visible') return; // hidden tab — nobody is reading these numbers
    renderDashboardContent(container);
  }, REFRESH_INTERVAL_MS);

  visibilityHandler = () => {
    if (document.visibilityState === 'visible' && onDashboard()) renderDashboardContent(container);
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

// Re-rendering identical numbers every minute is pure DOM churn — and a
// visible flicker if you happen to be reading the screen at the time.
let lastSignature = null;

async function renderDashboardContent(container) {
  const [returns, suppliers, erpItems, unlinked] = await Promise.all([
    listReturnsJoined(), getAll('suppliers'), getAll('erpItems'), listUnlinked(),
  ]);

  const todays = returns.filter(r => isToday(r.createdAt));
  const todaysValue = todays.reduce((sum, r) => sum + r.total, 0);
  const editing = returns.filter(r => r.status === 'sent' && r.editingUnlocked);
  const unregistered = returns.filter(r => r.status === 'sent' && r.hasCreditLines && !r.erpRegistered);
  // Sent returns where the supplier still owes replacement goods. The
  // per-line tracking has existed since 1.16.0 but nothing ever surfaced
  // it, so a return could sit waiting on goods with no sign of it here.
  const awaitingReplacements = returns.filter(r => r.status === 'sent' && r.pendingReplacements > 0);
  // status 'closed' is what the archive button sets — every other screen
  // calls these "الأرشيف", so this one no longer calls them "مكتملة".
  const archived = returns.filter(r => r.status === 'closed');
  const recent = [...returns].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8);

  const actions = [
    { id: 'ai-unreg', dot: 'dot-red', label: 'مرتجعات لم تُسجل على ERP', count: unregistered.length, route: '/returns/unregistered' },
    { id: 'ai-replacements', dot: 'dot-teal', label: 'مرتجعات في انتظار استلام البدائل', count: awaitingReplacements.length, route: '/returns/awaiting-replacements' },
    { id: 'ai-editing', dot: 'dot-amber', label: 'مرتجعات قيد التعديل بعد الإرسال', count: editing.length, route: '/returns/editing' },
    { id: 'ai-unlinked', dot: 'dot-gold', label: 'أصناف موردين غير مربوطة', count: unlinked.length, route: '/supplier-items/unlinked' },
  ];
  const needsAction = actions.filter(a => a.count > 0);

  const cards = [
    { label: 'الموردون', value: suppliers.length, route: '/suppliers' },
    { label: 'أصناف ERP', value: erpItems.length, route: '/items' },
    { label: 'مرتجعات مؤرشفة', value: archived.length, route: '/returns/archive', accent: 'accent-teal' },
    { label: 'أصناف غير مرتبطة', value: unlinked.length, route: '/supplier-items/unlinked', accent: 'accent-amber' },
  ];

  const signature = JSON.stringify([
    todays.length, todaysValue, actions.map(a => a.count), cards.map(c => c.value),
    recent.map(r => [r.id, r.updatedAt, r.total, r.status, r.editingUnlocked]),
  ]);
  if (signature === lastSignature && container.querySelector('#dash-recent')) return;
  lastSignature = signature;

  container.innerHTML = `
    <div class="card card-pad mb-16">
      <div class="section-title">مرتجعات اليوم</div>
      <div class="flex items-center gap-12" style="flex-wrap:wrap;">
        <div><span class="stat-value" style="font-size:24px;">${fmtInt(todays.length)}</span> <span class="small text-muted">مرتجعة</span></div>
        <div class="text-dim">·</div>
        <div><span class="stat-value" style="font-size:24px;">${fmtMoney(todaysValue)}</span> <span class="small text-muted">جنيه</span></div>
      </div>
    </div>

    <div class="grid grid-cols-4 mb-16">
      ${cards.map(c => `
        <div class="stat-card clickable ${c.accent || ''}" data-route="${c.route}">
          <div class="stat-label">${c.label}</div>
          <div class="stat-value">${fmtInt(c.value)}</div>
        </div>
      `).join('')}
    </div>

    <div class="grid grid-cols-2 mb-16">
      <div class="card card-pad">
        <div class="section-title">تحتاج إجراء</div>
        ${needsAction.length ? needsAction.map(a => `
          <div class="action-item" id="${a.id}" data-route="${a.route}" style="cursor:pointer;">
            <span class="dot ${a.dot}"></span> ${a.label} <span class="count">${fmtInt(a.count)}</span>
          </div>
        `).join('') : `
          <div class="action-item" style="border-style:dashed;">
            <span class="dot dot-teal"></span> مفيش حاجة محتاجة إجراء دلوقتي ✅
          </div>`}
      </div>

      <div class="card card-pad">
        <div class="section-title">إجراء سريع</div>
        <div class="flex" style="flex-direction:column;gap:8px;">
          <button class="btn btn-primary w-full" id="qa-new-return">+ مرتجعة جديدة</button>
          <button class="btn btn-ghost w-full" id="qa-new-supplier">+ إضافة مورد</button>
          <a class="btn btn-ghost w-full" href="#/items/import" style="justify-content:center;">⇪ استيراد أصناف من Excel</a>
        </div>
      </div>
    </div>

    <div class="card" id="dash-recent">
      <div class="card-header"><h3>آخر تحديث</h3></div>
      ${recent.length ? `
      <table class="data-table">
        <thead><tr><th>رقم المرتجعة</th><th>المورد</th><th class="num">القيمة</th><th>الحالة</th><th>آخر تعديل</th></tr></thead>
        <tbody>
          ${recent.map(r => `
            <tr class="row-link" data-id="${r.id}">
              <td class="text-mono" data-label="رقم المرتجعة">${escapeHtml(r.returnNumber)}</td>
              <td data-label="المورد">${escapeHtml(r.supplierName)}</td>
              <td class="num" data-label="القيمة">${fmtMoney(r.total)}</td>
              <td data-label="الحالة">${r.status === 'closed' ? '<span class="badge badge-closed">مؤرشفة</span>' : r.status === 'sent' ? (r.editingUnlocked ? '<span class="badge badge-editing">قيد التعديل</span>' : '<span class="badge badge-sent">تم الإرسال</span>') : '<span class="badge badge-draft">مسودة</span>'}</td>
              <td class="text-dim small" data-label="آخر تعديل">${fmtDate(r.updatedAt, true)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `<div class="empty-state"><div class="empty-icon">↩︎</div><div class="empty-title">لا توجد مرتجعات بعد</div></div>`}
    </div>
  `;

  // Every number on this screen leads somewhere — the counts used to be
  // half clickable and half not, with no way to tell which.
  container.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.route));
  });
  container.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', () => navigate(`/returns/${row.dataset.id}`)));
  container.querySelector('#qa-new-return').addEventListener('click', () => navigate('/returns/active'));
  container.querySelector('#qa-new-supplier').addEventListener('click', () => navigate('/suppliers'));
}
