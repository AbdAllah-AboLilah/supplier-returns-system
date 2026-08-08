# نظام إدارة مرتجعات الموردين

تطبيق ويب (HTML + JavaScript، PWA) لإدارة مرتجعات الموردين، ربط أصناف الموردين بأصناف نظام ERP، تتبع تكلفة كل مورد وتاريخها، ودورة حياة كاملة للمرتجعة من المسودة حتى تسجيلها على ERP.

## التشغيل محليًا

الكود مبني على ES Modules، فمتصفحك مش هيشغّله بفتح `index.html` مباشرة (file://) — لازم سيرفر محلي بسيط:

```bash
python3 -m http.server 8080
# أو: npx serve
```

وبعدين افتح `http://localhost:8080`.

## الرفع على GitHub Pages

1. ارفع محتويات هذا المجلد لمستودع جديد على GitHub (اسم مقترح: `supplier-returns-system`).
2. من **Settings → Pages**: اختر **Deploy from a branch**، الفرع `main`، والمجلد `/ (root)`.
3. الموقع هيبقى متاح على `https://<username>.github.io/supplier-returns-system/`.

## رقم الإصدار والتحديث التلقائي

- رقم الإصدار الحالي ظاهر أسفل القائمة الجانبية في التطبيق.
- كل مرة تعمل فيها `git push` على `main`، الـ GitHub Action في `.github/workflows/bump-version-and-deploy.yml` بيرفع رقم الإصدار تلقائيًا (patch)، ويعدّل:
  - `js/core/version.js`
  - `version.json`
  - `sw.js` (اسم الكاش، عشان النسخة القديمة تتمسح من متصفح المستخدم)
  - `CHANGELOG.md`
  - ويعمل commit تاني تلقائيًا بنفس الـ push، فمش محتاج تعمل حاجة يدويًا.
- التطبيق نفسه بيفحص `version.json` كل 5 دقائق (وكل مرة ترجع للتبويب)، ولو لقى رقم إصدار مختلف عن اللي شغال عندك، بيظهر رسالة ويعمل تحديث تلقائي (reload) بدون ما تعمل حاجة.
- لو حبيت ترفع رقم إصدار **minor** أو **major** بدل الافتراضي (patch)، شغّل يدويًا قبل الـ push:
  ```bash
  node scripts/bump-version.js minor   # أو major
  ```

## الطباعة على ماكينة الكاشير الحرارية

خيار "طباعة إيصال حراري" في تصدير تقرير المرتجعة بيفتح صفحة طباعة مُجهزة بعرض 80mm (مش ملف Excel — ملفات Excel مش مصممة للطباعة على لفة حرارية ضيقة، فالحل العملي هو تنسيق طباعة مباشر بيتعرف عليه أي طابعة حرارية متصلة كطابعة عادية في نظام التشغيل). لو الطابعة عندك 58mm بدل 80mm، غيّر `size: 80mm auto;` في `openThermalPrintView` بملف `js/modules/return-export.js`.

## بنية المشروع

```
index.html
manifest.json          ← PWA
sw.js                   ← Service Worker (تخزين أوفلاين + كشف تحديثات)
version.json            ← يُقرأ في وقت التشغيل لاكتشاف نسخة أحدث
css/styles.css
js/
  core/                 ← db.js (IndexedDB)، router.js، utils.js، audit.js، version.js، autosave.js
  modules/              ← dashboard، suppliers، items، excel-import، supplier-items، returns، return-export، audit-log
scripts/bump-version.js
.github/workflows/bump-version-and-deploy.yml
CHANGELOG.md
```

الطبقة الوحيدة اللي بتتكلم مباشرة مع قاعدة البيانات هي `js/core/db.js` — ده اللي هيخلي ربط Firebase لاحقًا تعديل في ملف واحد بدل إعادة بناء الشاشات.
