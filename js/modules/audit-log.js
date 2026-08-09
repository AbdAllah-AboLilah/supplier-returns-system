// =========================================================
// modules/audit-log.js — سجل العمليات
// =========================================================
import { getAuditLog } from '../core/audit.js';
import { fmtDate, escapeHtml, fuzzyIncludes, debounce, paginate, renderPagination, qs } from '../core/utils.js';

const ENTITY_LABELS = { supplier: 'مورد', erpItem: 'صنف ERP', supplierItem: 'صنف مورد', return: 'مرتجعة', system: 'نظام' };

const state = { page: 1, pageSize: 50, query: '', entityType: '', dateFrom: '', dateTo: '' };

function hasActiveFilters() {
  return !!(state.entityType || state.dateFrom || state.dateTo);
}

export async function renderAuditLogView(container) {
  const all = await getAuditLog();
  let filtered = all;
  if (state.query) filtered = filtered.filter(a => fuzzyIncludes(a.action, state.query) || fuzzyIncludes(a.details, state.query) || fuzzyIncludes(a.entityType, state.query));
  if (state.entityType) filtered = filtered.filter(a => a.entityType === state.entityType);
  if (state.dateFrom) filtered = filtered.filter(a => a.timestamp >= state.dateFrom);
  if (state.dateTo) filtered = filtered.filter(a => a.timestamp <= state.dateTo + 'T23:59:59');

  container.innerHTML = `
    <div class="card">
      <div class="table-toolbar">
        <input type="search" id="audit-search" placeholder="🔎 بحث في العمليات" style="max-width:280px;" value="${escapeHtml(state.query)}">
        <div class="spacer"></div>
        <span class="small text-dim">${filtered.length} عملية</span>
      </div>
      <div class="filter-bar">
        <label>النوع</label>
        <select id="f-entity">
          <option value="">الكل</option>
          ${Object.entries(ENTITY_LABELS).map(([k, v]) => `<option value="${k}" ${state.entityType === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <label>من</label>
        <input type="date" id="f-from" value="${state.dateFrom}">
        <label>إلى</label>
        <input type="date" id="f-to" value="${state.dateTo}">
        ${hasActiveFilters() ? `<button class="btn btn-sm btn-ghost filter-clear" id="btn-clear-filters">✕ مسح الفلاتر</button>` : ''}
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
  `).join('') : `<div class="empty-state"><div class="empty-hint">لا توجد عمليات مطابقة</div></div>`;

  const pagWrap = qs('#audit-pagination', container);
  if (total > 0) {
    pagWrap.appendChild(renderPagination({
      page, totalPages, total, pageSize: state.pageSize,
      onPage: (p) => { state.page = p; renderAuditLogView(container); },
      onPageSize: (s) => { state.pageSize = s; state.page = 1; renderAuditLogView(container); },
    }));
  }

  qs('#audit-search', container).addEventListener('input', debounce((e) => { state.query = e.target.value; state.page = 1; renderAuditLogView(container); }, 200));
  qs('#f-entity', container).addEventListener('change', (e) => { state.entityType = e.target.value; state.page = 1; renderAuditLogView(container); });
  qs('#f-from', container).addEventListener('change', (e) => { state.dateFrom = e.target.value; state.page = 1; renderAuditLogView(container); });
  qs('#f-to', container).addEventListener('change', (e) => { state.dateTo = e.target.value; state.page = 1; renderAuditLogView(container); });
  qs('#btn-clear-filters', container)?.addEventListener('click', () => {
    state.entityType = ''; state.dateFrom = ''; state.dateTo = ''; state.page = 1;
    renderAuditLogView(container);
  });
}
