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

async function renderDashboardContent(container) {
  const [returns, suppliers, erpItems, unlinked] = await Promise.all([
    listReturnsJoined(), getAll('suppliers'), getAll('erpItems'), listUnlinked(),
  ]);

  const todays = returns.filter(r => isToday(r.createdAt));
  const editing = returns.filter(r => r.status === 'sent' && r.editingUnlocked);
  const unregistered = returns.filter(r => r.status === 'sent' && r.hasCreditLines && !r.erpRegistered);
  const completed = returns.filter(r => r.status === 'closed');
  const recent = [...returns].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8);

  container.innerHTML = `
    <div class="card card-pad mb-16">
      <div class="section-title">مرتجعات اليوم</div>
      <div class="flex items-center gap-12" style="flex-wrap:wrap;">
        <div><span class="stat-value" style="font-size:24px;">${fmtInt(todays.length)}</span> <span class="small text-muted">مرتجعة</span></div>
        <div class="text-dim">·</div>
        <div><span class="stat-value" style="font-size:24px;">${fmtMoney(todays.reduce((s, r) => s + r.total, 0))}</span> <span class="small text-muted">جنيه</span></div>
      </div>
    </div>

    <div class="grid grid-cols-4 mb-16">
      <div class="stat-card"><div class="stat-label">الموردون</div><div class="stat-value">${fmtInt(suppliers.length)}</div></div>
      <div class="stat-card"><div class="stat-label">أصناف ERP</div><div class="stat-value">${fmtInt(erpItems.length)}</div></div>
      <div class="stat-card accent-teal"><div class="stat-label">مرتجعات مكتملة</div><div class="stat-value">${fmtInt(completed.length)}</div></div>
      <div class="stat-card accent-amber"><div class="stat-label">أصناف غير مرتبطة</div><div class="stat-value">${fmtInt(unlinked.length)}</div></div>
    </div>

    <div class="grid grid-cols-2 mb-16">
      <div class="card card-pad">
        <div class="section-title">تحتاج إجراء</div>
        <div class="action-item" id="ai-unreg" style="cursor:pointer;"><span class="dot dot-red"></span> مرتجعات لم تُسجل على ERP <span class="count">${fmtInt(unregistered.length)}</span></div>
        <div class="action-item" id="ai-editing" style="cursor:pointer;"><span class="dot dot-amber"></span> مرتجعات قيد التعديل بعد الإرسال <span class="count">${fmtInt(editing.length)}</span></div>
        <div class="action-item" id="ai-unlinked" style="cursor:pointer;"><span class="dot dot-gold"></span> أصناف موردين غير مربوطة <span class="count">${fmtInt(unlinked.length)}</span></div>
        <div class="action-item"><span class="dot dot-teal"></span> مرتجعات مكتملة <span class="count">${fmtInt(completed.length)}</span></div>
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

    <div class="card">
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
              <td data-label="الحالة">${r.status === 'closed' ? '<span class="badge badge-closed">مغلقة</span>' : r.status === 'sent' ? (r.editingUnlocked ? '<span class="badge badge-editing">قيد التعديل</span>' : '<span class="badge badge-sent">تم الإرسال</span>') : '<span class="badge badge-draft">مسودة</span>'}</td>
              <td class="text-dim small" data-label="آخر تعديل">${fmtDate(r.updatedAt, true)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `<div class="empty-state"><div class="empty-icon">↩︎</div><div class="empty-title">لا توجد مرتجعات بعد</div></div>`}
    </div>
  `;

  container.querySelectorAll('tr.row-link').forEach(row => row.addEventListener('click', () => navigate(`/returns/${row.dataset.id}`)));
  container.querySelector('#ai-unreg').addEventListener('click', () => navigate('/returns/unregistered'));
  container.querySelector('#ai-editing').addEventListener('click', () => navigate('/returns/sent'));
  container.querySelector('#ai-unlinked').addEventListener('click', () => navigate('/supplier-items/unlinked'));
  container.querySelector('#qa-new-return').addEventListener('click', () => navigate('/returns/active'));
  container.querySelector('#qa-new-supplier').addEventListener('click', () => navigate('/suppliers'));
}
