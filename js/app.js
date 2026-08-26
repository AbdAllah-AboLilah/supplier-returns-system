// =========================================================
// app.js — application shell & route table.
// This file only wires things together; all real logic lives
// in js/core and js/modules.
// =========================================================
import { registerRoute, initRouter, navigate } from './core/router.js';
import { qs, qsa, toast } from './core/utils.js';
import { APP_VERSION } from './core/version.js';
import { getSyncStatus, onSyncStatusChange } from './core/sync-status.js';

import { renderDashboard } from './modules/dashboard.js';
import { renderSuppliersList, renderSupplierDetail } from './modules/suppliers.js';
import { renderItemsList } from './modules/items.js';
import { renderExcelImportWizard } from './modules/excel-import.js';
import { renderUnlinkedView, renderAllSupplierItemsView } from './modules/supplier-items.js';
import { renderReturnsList, renderReturnDetail } from './modules/returns.js';
import { renderAuditLogView } from './modules/audit-log.js';
import { renderSettingsView } from './modules/settings.js';
import { renderInvoiceReviewsList, renderInvoiceReviewDetail } from './modules/invoice-reviews.js';
import { migrateLocalDataToFirebaseIfNeeded } from './core/migrate-to-firebase.js';

// ---------- Route table ----------

registerRoute('/dashboard', { navKey: 'dashboard', title: 'الرئيسية' }, ({ container }) => renderDashboard(container));

registerRoute('/items', { navKey: 'items', title: 'قاعدة أصناف ERP' }, ({ container }) => renderItemsList(container));
registerRoute('/items/import', { navKey: 'items-import', title: 'استيراد أصناف من Excel' }, ({ container }) => renderExcelImportWizard(container));
registerRoute('/supplier-items/unlinked', { navKey: 'unlinked', title: 'أصناف غير مرتبطة' }, ({ container }) => renderUnlinkedView(container));

registerRoute('/suppliers', { navKey: 'suppliers', title: 'قائمة الموردين' }, ({ container }) => renderSuppliersList(container));
registerRoute('/supplier-items', { navKey: 'supplier-items-all', title: 'أصناف الموردين' }, ({ container }) => renderAllSupplierItemsView(container));
registerRoute('/suppliers/:id', { navKey: 'suppliers', title: 'ملف المورد' }, ({ container, params }) => renderSupplierDetail(container, params.id));

registerRoute('/returns/active', { navKey: 'returns-active', title: 'المرتجعات النشطة' }, ({ container }) => renderReturnsList(container, 'active'));
registerRoute('/returns/sent', { navKey: 'returns-sent', title: 'المرتجعات المرسلة' }, ({ container }) => renderReturnsList(container, 'sent'));
registerRoute('/returns/unregistered', { navKey: 'returns-unregistered', title: 'غير المسجلة على ERP' }, ({ container }) => renderReturnsList(container, 'unregistered'));
registerRoute('/returns/archive', { navKey: 'returns-archive', title: 'الأرشيف' }, ({ container }) => renderReturnsList(container, 'archive'));
registerRoute('/returns/:id', { navKey: 'returns-active', title: 'المرتجعة' }, ({ container, params }) => renderReturnDetail(container, params.id));

registerRoute('/audit', { navKey: 'audit', title: 'سجل العمليات' }, ({ container }) => renderAuditLogView(container));
registerRoute('/settings', { navKey: 'settings', title: 'الإعدادات' }, ({ container }) => renderSettingsView(container));
registerRoute('/invoice-reviews', { navKey: 'invoice-reviews', title: 'مراجعة الفواتير' }, ({ container }) => renderInvoiceReviewsList(container));
registerRoute('/invoice-reviews/:id', { navKey: 'invoice-reviews', title: 'مراجعة فاتورة' }, ({ container, params }) => renderInvoiceReviewDetail(container, params.id));

// ---------- Shell chrome: nav highlighting + topbar title ----------

function onNavigate(meta) {
  qsa('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === meta.navKey));
  qs('#topbar-title').textContent = meta.title || '';
  qs('#app-shell').classList.remove('nav-open');
  qs('#btn-back').style.display = meta.navKey === 'dashboard' ? 'none' : 'flex';
  window.scrollTo(0, 0);
}

// ---------- Boot: migrate any old local data, then start the router ----------
// The dashboard's first render needs migration to have already run
// (otherwise it would flash "no data" while migration is still
// copying things up), so this gates the initial route on it —
// hash navigation after that is unaffected and stays instant.

qs('#app-content').innerHTML = '<div class="empty-state"><div class="empty-icon">⋯</div>جارِ الاتصال بقاعدة البيانات السحابية</div>';

(async () => {
  try {
    const result = await migrateLocalDataToFirebaseIfNeeded();
    if (result.migrated) toast(`تم نقل بياناتك المحلية إلى السحابة (${result.totalRows} سجل)`, 'success');
  } catch (err) {
    console.error('Migration check failed:', err);
    // Not fatal — fall through and let the router attempt to load
    // normally; individual screens will surface their own errors.
  }
  initRouter(qs('#app-content'), onNavigate);
})();

// ---------- Mobile nav toggle ----------

qs('#menu-toggle').addEventListener('click', () => qs('#app-shell').classList.toggle('nav-open'));

qs('#btn-back').addEventListener('click', () => {
  // Hash navigation already pushes a browser history entry on every
  // route change (see core/router.js navigate()), so native back/forward
  // just works — no separate in-app history stack needed. Falling back
  // to the dashboard covers the rare case of landing here with no
  // history at all (e.g. a shared/bookmarked deep link).
  if (window.history.length > 1) window.history.back();
  else navigate('/dashboard');
});

// ---------- Version badge ----------

const versionBadge = document.createElement('div');
versionBadge.id = 'version-badge';
versionBadge.textContent = `الإصدار ${APP_VERSION}`;
qs('.sidebar-footer').prepend(versionBadge);

// ---------- Connectivity status dot ----------

const STATUS_LABELS = { online: 'متصل بالإنترنت', syncing: 'جارِ رفع البيانات...', offline: 'غير متصل — التعديلات محفوظة محليًا' };

const statusEl = document.createElement('div');
statusEl.id = 'sync-status';

function renderStatus(status) {
  statusEl.className = `sync-status ${status}`;
  statusEl.innerHTML = `<span class="sync-dot"></span><span>${STATUS_LABELS[status]}</span>`;
}
renderStatus(getSyncStatus());
onSyncStatusChange(renderStatus);
qs('.sidebar-footer').prepend(statusEl);

// ---------- PWA: register service worker + auto-update ----------

let refreshing = false;
let updateInFlight = false;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline caching is a bonus, never block the app on it */ });
  });
  // When a new service worker takes control, the page underneath it is
  // already stale — reload once so the user is running the new code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A controller going *away* is an unregister, not a new version
    // taking over. Reloading for it only re-registers the worker, which
    // claims the page, which fires this again — a reload loop of its own.
    if (!navigator.serviceWorker.controller) return;
    // And never reload from here while the update path below is already
    // driving one; the two used to race and reload each other.
    if (refreshing || updateInFlight) return;
    refreshing = true;
    window.location.reload();
  });
}

// version.json is fetched with no-store, so it always reflects what is
// actually deployed. APP_VERSION comes from a module, which travels
// through the HTTP cache and the service-worker cache — the two can
// disagree, and a plain reload can come back just as stale and disagree
// again. Unbounded, that is an endless "جارِ التحديث" loop with the app
// unusable, so each attempt clears more state than the last and the
// whole thing gives up rather than spinning.

const UPDATE_KEY = 'returns-system:update-attempt';
const MIN_ATTEMPT_GAP_MS = 6000; // never spin faster than this, whatever happens
const MAX_ATTEMPTS = 3;

function readUpdateState(version) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(UPDATE_KEY) || 'null');
    if (!saved || saved.version !== version) return { attempt: 0, at: 0 };
    return { attempt: saved.attempt || 0, at: saved.at || 0 };
  } catch (e) { return { attempt: 0, at: 0 }; }
}
function writeUpdateState(version, attempt) {
  try { sessionStorage.setItem(UPDATE_KEY, JSON.stringify({ version, attempt, at: Date.now() })); }
  catch (e) { /* private mode — the attempt cap is lost, the gap check still holds */ }
}
function clearUpdateState() {
  try { sessionStorage.removeItem(UPDATE_KEY); } catch (e) { /* ignore */ }
}

// Drops the copies of the app a reload would otherwise come back to.
// The service worker is deliberately kept: it is the only thing that can
// force a revalidated fetch of every module (see sw.js). Unregistering it
// hands the page back to the plain HTTP cache, which is exactly what
// serves the stale files — so that is a manual last resort, not a step.
async function dropCachedApp() {
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.update().catch(() => {})));
    }
  } catch (err) {
    console.error('cache cleanup failed:', err);
  }
}

// Last resort. The app is running older code than what is deployed and
// clearing every cache did not change that, so stop reloading — an app
// that reboots every second is worse than an old one — say what is
// happening and let the person retry deliberately.
function showStuckUpdateBanner(newVersion) {
  if (qs('#update-stuck')) return;
  const banner = document.createElement('div');
  banner.id = 'update-stuck';
  banner.className = 'update-stuck';
  banner.innerHTML = `
    <div>
      <b>في إصدار أحدث (${newVersion}) مش راضي يتحمّل.</b>
      <div class="small">المتصفح لسه ماسك نسخة قديمة من الملفات. دوس "حاول تاني"، ولو فضلت المشكلة اقفل التطبيق افتحه من جديد.</div>
    </div>
    <button class="btn btn-sm btn-gold" id="btn-force-update">حاول تاني</button>
  `;
  document.body.appendChild(banner);
  qs('#btn-force-update', banner).addEventListener('click', async () => {
    clearUpdateState();
    updateInFlight = true; // keep controllerchange from reloading underneath this
    await dropCachedApp();
    window.location.reload();
  });
}

async function checkForUpdate() {
  if (updateInFlight) return;
  let data;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    data = await res.json();
  } catch (e) {
    return; // offline, or not deployed yet — ignore silently
  }
  if (!data || !data.version) return;

  if (data.version === APP_VERSION) {
    clearUpdateState(); // running what is deployed; forget any past struggle
    return;
  }

  const { attempt, at } = readUpdateState(data.version);
  if (attempt >= MAX_ATTEMPTS) { showStuckUpdateBanner(data.version); return; }

  // A reload lands back here almost immediately. Rather than firing
  // straight away (which is the loop) or waiting out the five-minute
  // poll (which leaves the person on old code for five minutes), hold
  // for the rest of the gap and pick up exactly where it ends.
  const sinceLast = at ? Date.now() - at : Infinity;
  if (sinceLast < MIN_ATTEMPT_GAP_MS) {
    setTimeout(checkForUpdate, MIN_ATTEMPT_GAP_MS - sinceLast + 100);
    return;
  }

  updateInFlight = true;
  writeUpdateState(data.version, attempt + 1);
  toast(`يوجد إصدار جديد (${data.version}) — جارِ التحديث...`, 'success');

  // Escalate: a plain reload first, then clear the caches serving the
  // old files, then drop the service worker itself.
  if (attempt > 0) await dropCachedApp();
  setTimeout(() => window.location.reload(), attempt === 0 ? 1500 : 600);
}

checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000); // every 5 minutes
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
