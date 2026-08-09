// =========================================================
// core/brand.js
// The sidebar always shows the fixed app identity ("مرتجعات
// الموردين") — it's the stable navigation anchor for the app
// itself, not a place for the shop's own name. The shop name
// (set in الإعدادات) is used only where it actually belongs:
// on exported/printed reports (Excel, image, thermal receipt),
// via getSetting('shopName') in return-export.js.
// =========================================================
import { qs } from './utils.js';

export async function applyShopName() {
  const strong = qs('.brand-text strong');
  const small = qs('.brand-text small');
  if (!strong || !small) return;
  strong.textContent = 'مرتجعات الموردين';
  small.textContent = 'نظام إدارة المخزون والمرتجعات';
}

