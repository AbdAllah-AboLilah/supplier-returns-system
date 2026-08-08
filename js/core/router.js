// =========================================================
// core/router.js — tiny hash router.
// Routes are registered as { pattern: '/returns/:id', handler }.
// No dependency on any framework; the "app shell" module
// wires this to a content container and the nav highlighting.
// =========================================================

const routes = [];
let contentEl = null;
let onNavigate = null; // callback(navKey, title) for shell chrome updates

export function registerRoute(pattern, meta, handler) {
  const paramNames = [];
  const regexStr = pattern
    .split('/')
    .map(seg => {
      if (seg.startsWith(':')) { paramNames.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${regexStr}$`);
  // Static (non-parameterized) routes must win over dynamic ones,
  // e.g. /returns/active must not be swallowed by /returns/:id.
  routes.push({ regex, paramNames, handler, meta });
  routes.sort((a, b) => (a.paramNames.length - b.paramNames.length));
}

export function initRouter(contentContainer, navigateCallback) {
  contentEl = contentContainer;
  onNavigate = navigateCallback;
  window.addEventListener('hashchange', renderCurrentRoute);
  renderCurrentRoute();
}

export function navigate(path) {
  window.location.hash = path;
}

async function renderCurrentRoute() {
  const path = (window.location.hash || '#/dashboard').slice(1) || '/dashboard';
  const clean = path.split('?')[0];

  for (const route of routes) {
    const match = clean.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      if (onNavigate) onNavigate(route.meta || {});
      contentEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⋯</div>جارِ التحميل</div>';
      try {
        await route.handler({ params, container: contentEl });
      } catch (err) {
        console.error(err);
        contentEl.innerHTML = `<div class="card card-pad"><b>حدث خطأ غير متوقع.</b><div class="text-dim small mt-8">${(err && err.message) || err}</div></div>`;
      }
      return;
    }
  }
  contentEl.innerHTML = `<div class="empty-state"><div class="empty-icon">؟</div><div class="empty-title">الصفحة غير موجودة</div></div>`;
}
