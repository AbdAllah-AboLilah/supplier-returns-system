// =========================================================
// app.js — application shell & route table.
// This file only wires things together; all real logic lives
// in js/core and js/modules.
// =========================================================
import { registerRoute, initRouter } from './core/router.js';
import { qs, qsa, toast } from './core/utils.js';
import { APP_VERSION } from './core/version.js';
import { getSyncStatus, onSyncStatusChange } from './core/sync-status.js';

import { renderDashboard } from './modules/dashboard.js';
import { renderSuppliersList, renderSupplierDetail } from './modules/suppliers.js';
import { renderItemsList } from './modules/items.js';
import { renderExcelImportWizard } from './modules/excel-import.js';
import { renderUnlinkedView } from './modules/supplier-items.js';
import { renderReturnsList, renderReturnDetail } from './modules/returns.js';
import { renderAuditLogView } from './modules/audit-log.js';
import { renderSettingsView } from './modules/settings.js';
import { applyShopName } from './core/brand.js';
import { migrateLocalDataToFirebaseIfNeeded } from './core/migrate-to-firebase.js';

// ---------- Route table ----------

registerRoute('/dashboard', { navKey: 'dashboard', title: 'الرئيسية' }, ({ container }) => renderDashboard(container));

registerRoute('/items', { navKey: 'items', title: 'قاعدة أصناف ERP' }, ({ container }) => renderItemsList(container));
registerRoute('/items/import', { navKey: 'items-import', title: 'استيراد أصناف من Excel' }, ({ container }) => renderExcelImportWizard(container));
registerRoute('/supplier-items/unlinked', { navKey: 'unlinked', title: 'أصناف غير مرتبطة' }, ({ container }) => renderUnlinkedView(container));

registerRoute('/suppliers', { navKey: 'suppliers', title: 'قائمة الموردين' }, ({ container }) => renderSuppliersList(container));
registerRoute('/suppliers/:id', { navKey: 'suppliers', title: 'ملف المورد' }, ({ container, params }) => renderSupplierDetail(container, params.id));

registerRoute('/returns/active', { navKey: 'returns-active', title: 'المرتجعات النشطة' }, ({ container }) => renderReturnsList(container, 'active'));
registerRoute('/returns/sent', { navKey: 'returns-sent', title: 'المرتجعات المرسلة' }, ({ container }) => renderReturnsList(container, 'sent'));
registerRoute('/returns/unregistered', { navKey: 'returns-unregistered', title: 'غير المسجلة على ERP' }, ({ container }) => renderReturnsList(container, 'unregistered'));
registerRoute('/returns/archive', { navKey: 'returns-archive', title: 'الأرشيف' }, ({ container }) => renderReturnsList(container, 'archive'));
registerRoute('/returns/:id', { navKey: 'returns-active', title: 'المرتجعة' }, ({ container, params }) => renderReturnDetail(container, params.id));

registerRoute('/audit', { navKey: 'audit', title: 'سجل العمليات' }, ({ container }) => renderAuditLogView(container));
registerRoute('/settings', { navKey: 'settings', title: 'الإعدادات' }, ({ container }) => renderSettingsView(container));

// ---------- Shell chrome: nav highlighting + topbar title ----------

function onNavigate(meta) {
  qsa('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.nav === meta.navKey));
  qs('#topbar-title').textContent = meta.title || '';
  qs('#app-shell').classList.remove('nav-open');
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
  applyShopName();
})();

// ---------- Mobile nav toggle ----------

qs('#menu-toggle').addEventListener('click', () => qs('#app-shell').classList.toggle('nav-open'));

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

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline caching is a bonus, never block the app on it */ });
  });
  // When a new service worker takes control, the page underneath it is
  // already stale — reload once so the user is running the new code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// version.json is fetched with no-store so this always sees the file
// as it currently sits on the server (GitHub Pages, in production),
// regardless of any HTTP or service-worker caching. If it disagrees
// with the version baked into this loaded copy of the app, a newer
// deployment exists — tell the person and reload automatically.
async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) {
      toast(`يوجد إصدار جديد (${data.version}) — جارِ التحديث...`, 'success');
      setTimeout(() => window.location.reload(), 1500);
    }
  } catch (e) { /* offline, or not deployed yet — ignore silently */ }
}

checkForUpdate();
setInterval(checkForUpdate, 5 * 60 * 1000); // every 5 minutes
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
