// =========================================================
// modules/settings.js — الإعدادات
// Two things live here for now:
//   1. Shop name — a plain, always-editable setting, not baked
//      into the code, shown in the sidebar and on exported reports.
//   2. Full backup / restore — every collection in one JSON file.
//      Data already syncs across devices through Firestore; this is
//      the offline archive/rollback copy, and the way to move a
//      dataset into a different Firebase project.
// =========================================================
import { getAll, getSetting, setSetting, exportAllData, importAllData } from '../core/db.js';
import { fmtInt, fmtDate, escapeHtml, confirmDialog, toast, qs } from '../core/utils.js';
import { logAction } from '../core/audit.js';
import { autosaveField } from '../core/autosave.js';
import { APP_VERSION, BUILD_DATE } from '../core/version.js';

export async function renderSettingsView(container) {
  const [suppliers, erpItems, returns, shopName, lastBackupAt] = await Promise.all([
    getAll('suppliers'), getAll('erpItems'), getAll('returns'),
    getSetting('shopName', ''), getSetting('lastBackupAt', null),
  ]);

  container.innerHTML = `
    <div class="card card-pad mb-16">
      <div class="section-title">اسم المحل</div>
      <div class="field-label-row"><label style="margin:0;">هيظهر في التقارير المُصدَّرة والمطبوعة</label><span class="autosave-status" id="shop-status"></span></div>
      <input type="text" id="f-shop-name" placeholder="مثال: محل الأمل للأقمشة" value="${escapeHtml(shopName || '')}" style="max-width:360px;">
    </div>

    <div class="card card-pad mb-16">
      <div class="section-title">حالة النظام</div>
      <div class="grid grid-cols-3">
        <div class="stat-card"><div class="stat-label">الموردون</div><div class="stat-value">${fmtInt(suppliers.length)}</div></div>
        <div class="stat-card"><div class="stat-label">أصناف ERP</div><div class="stat-value">${fmtInt(erpItems.length)}</div></div>
        <div class="stat-card"><div class="stat-label">المرتجعات</div><div class="stat-value">${fmtInt(returns.length)}</div></div>
      </div>
      <div class="small text-dim mt-16">الإصدار الحالي: <span class="text-mono">${APP_VERSION}</span> (${BUILD_DATE})</div>
    </div>

    <div class="card card-pad mb-16">
      <div class="section-title">نسخة احتياطية كاملة</div>
      <p class="small text-muted" style="margin:0 0 12px;">تنزيل كل بيانات النظام (الموردين، الأصناف، المرتجعات، الربط والتكاليف، سجل العمليات) في ملف واحد. استخدمها لنقل بياناتك لجهاز تاني أو كأرشيف احتياطي دوري.</p>
      <button class="btn btn-primary" id="btn-backup">⬇ تنزيل نسخة احتياطية كاملة</button>
      <div class="small text-dim mt-8" id="last-backup-info">${lastBackupAt ? `آخر نسخة احتياطية: ${fmtDate(lastBackupAt, true)}` : 'لم يتم عمل نسخة احتياطية بعد'}</div>
    </div>

    <div class="card card-pad">
      <div class="section-title">استعادة من نسخة احتياطية</div>
      <p class="small text-muted" style="margin:0 0 12px;">اختيار ملف نسخة احتياطية سابقة (JSON) هيستبدل <b>كل</b> بيانات هذا الجهاز ببيانات الملف — استخدمها لجعل جهازين متطابقين تمامًا في البيانات.</p>
      <input type="file" id="restore-file" accept="application/json,.json" style="display:none;">
      <button class="btn btn-gold" id="btn-restore">⬆ اختيار ملف واستعادة</button>
    </div>
  `;

  const shopInput = qs('#f-shop-name', container);
  autosaveField(shopInput, async (val) => {
    await setSetting('shopName', val.trim());
  }, { statusEl: qs('#shop-status', container), delay: 500 });

  qs('#btn-backup', container).addEventListener('click', async () => {
    const data = await exportAllData();
    const payload = { exportedAt: new Date().toISOString(), appVersion: APP_VERSION, data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `returns-system-backup-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    await setSetting('lastBackupAt', payload.exportedAt);
    await logAction('تنزيل نسخة احتياطية كاملة', 'system', '-', '');
    toast('تم تنزيل النسخة الاحتياطية', 'success');
    renderSettingsView(container);
  });

  const fileInput = qs('#restore-file', container);
  qs('#btn-restore', container).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    let payload;
    try {
      const text = await file.text();
      payload = JSON.parse(text);
    } catch (err) {
      toast('الملف تالف أو ليس بصيغة JSON صحيحة', 'error');
      fileInput.value = '';
      return;
    }
    if (!payload || typeof payload.data !== 'object') {
      toast('هذا الملف مش نسخة احتياطية صالحة لهذا النظام', 'error');
      fileInput.value = '';
      return;
    }
    const ok = await confirmDialog(
      `سيتم استبدال كل بيانات هذا الجهاز ببيانات النسخة الاحتياطية (بتاريخ ${fmtDate(payload.exportedAt, true)}). هذه الخطوة لا يمكن التراجع عنها. هل أنت متأكد؟`,
      { okLabel: 'استبدال البيانات', danger: true }
    );
    fileInput.value = '';
    if (!ok) return;
    try {
      await importAllData(payload.data);
      await logAction('استعادة نسخة احتياطية', 'system', '-', `من نسخة بتاريخ ${payload.exportedAt}`);
      toast('تمت الاستعادة بنجاح — جارِ إعادة التحميل...', 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      console.error(err);
      toast('حدث خطأ أثناء الاستعادة', 'error');
    }
  });
}
