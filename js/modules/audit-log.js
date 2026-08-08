// =========================================================
// modules/audit-log.js — سجل العمليات
// =========================================================
import { getAuditLog } from '../core/audit.js';
import { fmtDate, escapeHtml, fuzzyIncludes, debounce, paginate, renderPagination, qs } from '../core/utils.js';

const state = { page: 1, pageSize: 50, query: '' };

export async function renderAuditLogView(container) {
  const all = await getAuditLog();
  const filtered = state.query
    ? all.filter(a => fuzzyIncludes(a.action, state.query) || fuzzyIncludes(a.details, state.query) || fuzzyIncludes(a.entityType, state.query))
    : all;

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="audit-search" placeholder="🔎 بحث في العمليات" style="max-width:280px;" value="${escapeHtml(state.query)}">
        <div class="spacer"></div>
        <span class="small text-dim">${filtered.length} عملية</span>
      </div>
      <div class="card-pad" id="audit-list"></div>
      <div id="audit-pagination"></div>
    </div>
  `;

  const { slice, totalPages, page, total } = paginate(filtered, state.page, state.pageSize);
  const list = qs('#audit-list', container);
  list.innerHTML = slice.length ? slice.map(a => `
    <div class="audit-item">
      <div class="audit-time">${fmtDate(a.timestamp, true)}</div>
      <div><b>${escapeHtml(a.action)}</b>${a.details ? ` — <span class="text-muted">${escapeHtml(a.details)}</span>` : ''}</div>
    </div>
  `).join('') : `<div class="empty-state"><div class="empty-hint">لا توجد عمليات مسجلة بعد</div></div>`;

  const pagWrap = qs('#audit-pagination', container);
  if (total > 0) {
    pagWrap.appendChild(renderPagination({
      page, totalPages, total, pageSize: state.pageSize,
      onPage: (p) => { state.page = p; renderAuditLogView(container); },
      onPageSize: (s) => { state.pageSize = s; state.page = 1; renderAuditLogView(container); },
    }));
  }

  qs('#audit-search', container).addEventListener('input', debounce((e) => { state.query = e.target.value; state.page = 1; renderAuditLogView(container); }, 200));
}
