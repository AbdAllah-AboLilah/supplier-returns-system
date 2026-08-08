// =========================================================
// modules/excel-import.js — معالج استيراد الأصناف من Excel
// A step wizard, not a single "upload" button: pick the sheet,
// pick the header row (never assumed to be row 1), confirm the
// auto-detected column mapping, review a validated preview, then
// choose how to handle items that already exist before executing.
// =========================================================
import { getAll, bulkPut } from '../core/db.js';
import { uid, nowIso, fmtInt, fmtMoney, escapeHtml, fuzzyIncludes, normalizeArabic,
         toast, paginate, renderPagination, qs, qsa, confirmDialog } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { navigate } from '../core/router.js';

const FIELD_DEFS = [
  { key: 'name', label: 'اسم الصنف', required: true, aliases: ['name', 'item', 'product', 'title', 'اسم', 'صنف', 'الصنف', 'المنتج'] },
  { key: 'barcode', label: 'الباركود', required: false, aliases: ['barcode', 'code', 'sku', 'ean', 'باركود', 'الباركود', 'كود'] },
  { key: 'cost', label: 'التكلفة', required: false, aliases: ['cost', 'price', 'unitcost', 'تكلفة', 'التكلفة', 'سعر', 'السعر'] },
  { key: 'category', label: 'القسم / التصنيف', required: false, aliases: ['category', 'dept', 'department', 'قسم', 'القسم', 'تصنيف', 'التصنيف'] },
];

const STEPS = [
  { key: 'upload', label: 'الملف' },
  { key: 'sheet', label: 'الورقة' },
  { key: 'header', label: 'صف العناوين' },
  { key: 'mapping', label: 'مطابقة الأعمدة' },
  { key: 'preview', label: 'المعاينة والتحقق' },
  { key: 'import', label: 'التنفيذ' },
];

export async function renderExcelImportWizard(container) {
  const wiz = {
    step: 0,
    fileName: '',
    workbook: null,
    sheetName: null,
    rawRows: [],        // all rows of chosen sheet, as arrays
    headerRowIndex: null,
    columnMap: {},       // fieldKey -> column index
    parsedRows: [],       // { name, barcode, cost, category, status, reason }
    importMode: 'update', // 'update' | 'skip' | 'duplicate'
    previewPage: 1,
    previewPageSize: 50,
  };
  render(container, wiz);
}

function render(container, wiz) {
  container.innerHTML = `
    <div class="card card-pad">
      ${renderStepper(wiz.step)}
      <div id="wizard-body"></div>
    </div>
  `;
  const body = qs('#wizard-body', container);
  const key = STEPS[wiz.step].key;
  if (key === 'upload') renderUploadStep(body, container, wiz);
  else if (key === 'sheet') renderSheetStep(body, container, wiz);
  else if (key === 'header') renderHeaderStep(body, container, wiz);
  else if (key === 'mapping') renderMappingStep(body, container, wiz);
  else if (key === 'preview') renderPreviewStep(body, container, wiz);
  else if (key === 'import') renderImportStep(body, container, wiz);
}

function renderStepper(currentIndex) {
  return `
    <div class="stitch-stepper">
      ${STEPS.map((s, i) => `
        ${i > 0 ? `<div class="stitch-connector"></div>` : ''}
        <div class="stitch-step ${i < currentIndex ? 'done' : i === currentIndex ? 'current' : ''}">
          <div class="stitch-dot">${i < currentIndex ? '✓' : i + 1}</div>
          <div class="stitch-label">${s.label}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function goTo(container, wiz, stepIndex) { wiz.step = stepIndex; render(container, wiz); }

// ---------- Step 1: upload ----------

function renderUploadStep(body, container, wiz) {
  body.innerHTML = `
    <div class="upload-drop" id="drop-zone">
      <div class="up-icon">📁</div>
      <div><b>اسحب ملف Excel هنا أو اضغط للاختيار</b></div>
      <div class="small text-dim mt-8">صيغ مدعومة: xlsx, xls, csv</div>
      <input type="file" id="file-input" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>
  `;
  const zone = qs('#drop-zone', body);
  const input = qs('#file-input', body);
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = 'var(--gold)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.style.borderColor = ''; if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });

  async function handleFile(file) {
    try {
      zone.innerHTML = `<div class="up-icon">⋯</div><div>جارِ قراءة الملف...</div>`;
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array' });
      wiz.fileName = file.name;
      wiz.workbook = workbook;
      wiz.sheetName = workbook.SheetNames[0] || null;
      goTo(container, wiz, 1);
    } catch (err) {
      toast('تعذّرت قراءة الملف، تأكد من أنه بصيغة Excel صالحة', 'error');
      zone.innerHTML = `<div class="up-icon">📁</div><div><b>اسحب ملف Excel هنا أو اضغط للاختيار</b></div>`;
    }
  }
}

// ---------- Step 2: sheet selection ----------

function renderSheetStep(body, container, wiz) {
  const names = wiz.workbook.SheetNames;
  body.innerHTML = `
    <div class="field"><label>الملف يحتوي على ${names.length} ${names.length === 1 ? 'ورقة' : 'أوراق'}. اختر الورقة المطلوبة:</label></div>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:420px;">
      ${names.map(n => `
        <label class="flex items-center gap-8" style="border:1px solid var(--line-strong);border-radius:8px;padding:10px 14px;cursor:pointer;">
          <input type="radio" name="sheet" value="${escapeHtml(n)}" ${n === wiz.sheetName ? 'checked' : ''}>
          <span>${escapeHtml(n)}</span>
        </label>
      `).join('')}
    </div>
    <div class="flex justify-between mt-24">
      <button class="btn btn-ghost" id="btn-back">→ رجوع</button>
      <button class="btn btn-primary" id="btn-next">التالي ←</button>
    </div>
  `;
  qs('#btn-back', body).addEventListener('click', () => goTo(container, wiz, 0));
  qs('#btn-next', body).addEventListener('click', () => {
    const chosen = body.querySelector('input[name=sheet]:checked');
    wiz.sheetName = chosen.value;
    const sheet = wiz.workbook.Sheets[wiz.sheetName];
    wiz.rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    wiz.headerRowIndex = 0;
    goTo(container, wiz, 2);
  });
}

// ---------- Step 3: header row ----------

function renderHeaderStep(body, container, wiz) {
  const preview = wiz.rawRows.slice(0, 12);
  body.innerHTML = `
    <div class="field"><label>اختر الصف الذي يحتوي على أسماء الأعمدة (رؤوس الجدول):</label></div>
    <div class="table-wrap">
      <table class="data-table">
        <tbody>
          ${preview.map((row, i) => `
            <tr style="cursor:pointer;" class="header-row-option ${i === wiz.headerRowIndex ? 'active-header' : ''}" data-idx="${i}">
              <td style="width:90px;"><label class="flex items-center gap-8"><input type="radio" name="hdr" value="${i}" ${i === wiz.headerRowIndex ? 'checked' : ''}> صف ${i + 1}</label></td>
              <td class="small text-dim">${row.slice(0, 6).map(c => escapeHtml(String(c ?? ''))).join(' | ')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="flex justify-between mt-24">
      <button class="btn btn-ghost" id="btn-back">→ رجوع</button>
      <button class="btn btn-primary" id="btn-next">التالي ←</button>
    </div>
  `;
  body.querySelectorAll('.header-row-option').forEach(tr => tr.addEventListener('click', () => {
    const idx = Number(tr.dataset.idx);
    body.querySelector(`input[name=hdr][value="${idx}"]`).checked = true;
  }));
  qs('#btn-back', body).addEventListener('click', () => goTo(container, wiz, 1));
  qs('#btn-next', body).addEventListener('click', () => {
    wiz.headerRowIndex = Number(body.querySelector('input[name=hdr]:checked').value);
    autoDetectColumns(wiz);
    goTo(container, wiz, 3);
  });
}

function autoDetectColumns(wiz) {
  const headerRow = wiz.rawRows[wiz.headerRowIndex] || [];
  const map = {};
  FIELD_DEFS.forEach(f => {
    let foundIdx = -1;
    headerRow.forEach((cell, idx) => {
      if (foundIdx !== -1) return;
      const cellStr = String(cell || '');
      const matches = f.aliases.some(alias => fuzzyIncludes(cellStr, alias) || cellStr.toLowerCase().includes(alias.toLowerCase()));
      if (matches) foundIdx = idx;
    });
    map[f.key] = foundIdx;
  });
  wiz.columnMap = map;
}

// ---------- Step 4: column mapping ----------

function renderMappingStep(body, container, wiz) {
  const headerRow = wiz.rawRows[wiz.headerRowIndex] || [];
  const colOptions = headerRow.map((c, idx) => `<option value="${idx}">عمود ${idx + 1}: ${escapeHtml(String(c || '(بدون عنوان)'))}</option>`).join('');

  body.innerHTML = `
    <div class="field"><label>راجع مطابقة الأعمدة المكتشفة تلقائيًا، وعدّلها عند الحاجة:</label></div>
    <table class="data-table">
      <thead><tr><th>الحقل المطلوب</th><th>العمود في الملف</th><th></th></tr></thead>
      <tbody>
        ${FIELD_DEFS.map(f => `
          <tr>
            <td>${f.label}${f.required ? ' <span style="color:var(--red);">*</span>' : ''}</td>
            <td>
              <select data-field="${f.key}" style="max-width:280px;">
                <option value="-1">— لا يوجد —</option>
                ${colOptions}
              </select>
            </td>
            <td>${wiz.columnMap[f.key] >= 0 ? '<span class="badge badge-erp-yes">✓ تم الاكتشاف</span>' : (f.required ? '<span class="badge badge-erp-no">⚠️ اختر يدويًا</span>' : '<span class="text-dim small">—</span>')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="flex justify-between mt-24">
      <button class="btn btn-ghost" id="btn-back">→ رجوع</button>
      <button class="btn btn-primary" id="btn-next">معاينة البيانات ←</button>
    </div>
  `;
  FIELD_DEFS.forEach(f => {
    const sel = body.querySelector(`select[data-field="${f.key}"]`);
    sel.value = wiz.columnMap[f.key] >= 0 ? wiz.columnMap[f.key] : -1;
  });
  qs('#btn-back', body).addEventListener('click', () => goTo(container, wiz, 2));
  qs('#btn-next', body).addEventListener('click', () => {
    FIELD_DEFS.forEach(f => { wiz.columnMap[f.key] = Number(body.querySelector(`select[data-field="${f.key}"]`).value); });
    if (wiz.columnMap.name < 0) { toast('يجب تحديد عمود اسم الصنف للمتابعة', 'error'); return; }
    buildParsedRows(wiz);
    wiz.previewPage = 1;
    goTo(container, wiz, 4);
  });
}

function buildParsedRows(wiz) {
  const { name: cName, barcode: cBarcode, cost: cCost, category: cCategory } = wiz.columnMap;
  const dataRows = wiz.rawRows.slice(wiz.headerRowIndex + 1);
  const seenBarcodes = new Set();
  const parsed = [];

  dataRows.forEach((row) => {
    const isBlank = row.every(c => String(c ?? '').trim() === '');
    if (isBlank) return;

    const name = cName >= 0 ? String(row[cName] ?? '').trim() : '';
    const barcode = cBarcode >= 0 ? String(row[cBarcode] ?? '').trim() : '';
    const rawCost = cCost >= 0 ? row[cCost] : '';
    const category = cCategory >= 0 ? String(row[cCategory] ?? '').trim() : '';

    let status = 'valid';
    let reason = '';

    if (!name) { status = 'invalid'; reason = 'بدون اسم صنف'; }

    let cost = 0;
    if (status !== 'invalid') {
      const numeric = Number(String(rawCost).toString().replace(/,/g, '').trim());
      if (rawCost === '' || rawCost === undefined) { status = 'review'; reason = 'التكلفة فارغة'; cost = 0; }
      else if (isNaN(numeric)) { status = 'review'; reason = 'التكلفة غير رقمية'; cost = 0; }
      else { cost = numeric; }
    }

    if (status !== 'invalid' && barcode) {
      if (seenBarcodes.has(barcode)) { status = 'review'; reason = reason ? reason + '، باركود مكرر' : 'باركود مكرر داخل الملف'; }
      else seenBarcodes.add(barcode);
    }

    parsed.push({ name, barcode, cost, category, status, reason });
  });

  wiz.parsedRows = parsed;
}

// ---------- Step 5: preview + validation ----------

function renderPreviewStep(body, container, wiz) {
  const rows = wiz.parsedRows;
  const validCount = rows.filter(r => r.status === 'valid').length;
  const reviewCount = rows.filter(r => r.status === 'review').length;
  const invalidCount = rows.filter(r => r.status === 'invalid').length;

  body.innerHTML = `
    <div class="grid grid-cols-3 mb-16">
      <div class="stat-card accent-teal"><div class="stat-label">إجمالي السجلات</div><div class="stat-value">${fmtInt(rows.length)}</div></div>
      <div class="stat-card"><div class="stat-label">✓ صالح</div><div class="stat-value" style="color:var(--teal);">${fmtInt(validCount)}</div></div>
      <div class="stat-card accent-amber"><div class="stat-label">⚠️ يحتاج مراجعة</div><div class="stat-value">${fmtInt(reviewCount)}</div></div>
    </div>
    ${invalidCount ? `<div class="locked-banner">❌ ${fmtInt(invalidCount)} صف بدون اسم صنف سيتم تجاهله عند الاستيراد.</div>` : ''}
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>#</th><th>الصنف</th><th>الباركود</th><th class="num">التكلفة</th><th>القسم</th><th>الحالة</th></tr></thead>
        <tbody id="preview-tbody"></tbody>
      </table>
    </div>
    <div id="preview-pagination"></div>
    <div class="flex justify-between mt-24">
      <button class="btn btn-ghost" id="btn-back">→ رجوع لمطابقة الأعمدة</button>
      <button class="btn btn-primary" id="btn-next" ${validCount + reviewCount === 0 ? 'disabled' : ''}>متابعة إلى خيارات الاستيراد ←</button>
    </div>
  `;

  function renderPage() {
    const { slice, totalPages, page, total } = paginate(rows, wiz.previewPage, wiz.previewPageSize);
    const tbody = qs('#preview-tbody', body);
    tbody.innerHTML = slice.map((r, i) => `
      <tr>
        <td class="num text-dim">${(page - 1) * wiz.previewPageSize + i + 1}</td>
        <td>${escapeHtml(r.name) || '<span class="text-dim">—</span>'}</td>
        <td class="text-dim">${escapeHtml(r.barcode) || '—'}</td>
        <td class="num">${fmtMoney(r.cost)}</td>
        <td class="text-dim">${escapeHtml(r.category) || '—'}</td>
        <td>${r.status === 'valid' ? '<span class="badge badge-erp-yes">✓ صالح</span>' : r.status === 'review' ? `<span class="badge badge-warn" title="${escapeHtml(r.reason)}">⚠️ ${escapeHtml(r.reason)}</span>` : `<span class="badge badge-erp-no" title="${escapeHtml(r.reason)}">❌ ${escapeHtml(r.reason)}</span>`}</td>
      </tr>
    `).join('');
    const pagWrap = qs('#preview-pagination', body);
    pagWrap.innerHTML = '';
    if (total > 0) pagWrap.appendChild(renderPagination({
      page, totalPages, total, pageSize: wiz.previewPageSize,
      onPage: (p) => { wiz.previewPage = p; renderPage(); },
      onPageSize: (s) => { wiz.previewPageSize = s; wiz.previewPage = 1; renderPage(); },
    }));
  }
  renderPage();

  qs('#btn-back', body).addEventListener('click', () => goTo(container, wiz, 3));
  qs('#btn-next', body).addEventListener('click', () => goTo(container, wiz, 5));
}

// ---------- Step 6: import options + execute ----------

async function renderImportStep(body, container, wiz) {
  const existing = await getAll('erpItems');
  const byBarcode = new Map(existing.filter(i => i.barcode).map(i => [i.barcode, i]));
  const byName = new Map(existing.map(i => [normalizeArabic(i.name), i]));

  const importable = wiz.parsedRows.filter(r => r.status !== 'invalid');
  let newCount = 0, matchCount = 0;
  importable.forEach(r => {
    const match = (r.barcode && byBarcode.get(r.barcode)) || byName.get(normalizeArabic(r.name));
    if (match) matchCount++; else newCount++;
  });

  body.innerHTML = `
    <div class="field">
      <label>إذا كان الصنف موجودًا بالفعل في قاعدة ERP (بمطابقة الباركود أو الاسم):</label>
      <div style="display:flex;flex-direction:column;gap:8px;max-width:460px;">
        <label class="flex items-center gap-8"><input type="radio" name="mode" value="update" checked> تحديث بياناته</label>
        <label class="flex items-center gap-8"><input type="radio" name="mode" value="skip"> تجاهل الموجود</label>
        <label class="flex items-center gap-8"><input type="radio" name="mode" value="duplicate"> إضافة كنسخة جديدة</label>
      </div>
    </div>
    <div class="grid grid-cols-3 mt-16 mb-16">
      <div class="stat-card"><div class="stat-label">أصناف جديدة</div><div class="stat-value">${fmtInt(newCount)}</div></div>
      <div class="stat-card accent-amber"><div class="stat-label">أصناف مطابقة لموجود</div><div class="stat-value">${fmtInt(matchCount)}</div></div>
      <div class="stat-card accent-red"><div class="stat-label">سيتم تجاهلها (بدون اسم)</div><div class="stat-value">${fmtInt(wiz.parsedRows.length - importable.length)}</div></div>
    </div>
    <div id="import-result"></div>
    <div class="flex justify-between mt-24">
      <button class="btn btn-ghost" id="btn-back">→ رجوع للمعاينة</button>
      <button class="btn btn-gold" id="btn-execute">تنفيذ الاستيراد ✓</button>
    </div>
  `;

  qs('#btn-back', body).addEventListener('click', () => goTo(container, wiz, 4));
  qs('#btn-execute', body).addEventListener('click', async () => {
    const mode = body.querySelector('input[name=mode]:checked').value;
    const ok = await confirmDialog(`سيتم استيراد ${fmtInt(importable.length)} صنف إلى قاعدة ERP. هل تريد المتابعة؟`);
    if (!ok) return;
    const btn = qs('#btn-execute', body);
    btn.disabled = true; btn.textContent = 'جارِ الاستيراد...';

    const toSave = [];
    let updated = 0, added = 0, duplicated = 0, skipped = 0;
    importable.forEach(r => {
      const match = (r.barcode && byBarcode.get(r.barcode)) || byName.get(normalizeArabic(r.name));
      if (match) {
        if (mode === 'update') {
          toSave.push({ ...match, name: r.name, barcode: r.barcode || match.barcode, baseCost: r.cost || match.baseCost, category: r.category || match.category, updatedAt: nowIso() });
          updated++;
        } else if (mode === 'skip') {
          skipped++;
        } else {
          toSave.push({ id: uid(), name: r.name, barcode: r.barcode, baseCost: r.cost, category: r.category, createdAt: nowIso(), updatedAt: nowIso() });
          duplicated++;
        }
      } else {
        toSave.push({ id: uid(), name: r.name, barcode: r.barcode, baseCost: r.cost, category: r.category, createdAt: nowIso(), updatedAt: nowIso() });
        added++;
      }
    });

    await bulkPut('erpItems', toSave);
    await logAction('استيراد أصناف من Excel', 'erpItem', '-', `${wiz.fileName}: جديد ${added}، تحديث ${updated}، نسخ ${duplicated}، تجاهل ${skipped}`);

    qs('#import-result', body).innerHTML = `
      <div class="card card-pad" style="background:var(--teal-tint);border-color:var(--teal);">
        <b>تم الاستيراد بنجاح ✓</b>
        <div class="small mt-8">أُضيف ${fmtInt(added)} صنف جديد، وتم تحديث ${fmtInt(updated)}، وإضافة ${fmtInt(duplicated)} نسخة، وتجاهل ${fmtInt(skipped)}.</div>
      </div>
    `;
    toast('تم استيراد الأصناف بنجاح', 'success');
    btn.style.display = 'none';
    const goItems = document.createElement('button');
    goItems.className = 'btn btn-primary mt-16';
    goItems.textContent = 'عرض قاعدة الأصناف →';
    goItems.addEventListener('click', () => navigate('/items'));
    qs('#import-result', body).after(goItems);
  });
}
