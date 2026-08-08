// =========================================================
// core/brand.js — the "shop name" is a plain setting (stored
// in the settings store, key 'shopName'), never hard-coded.
// Change it anytime from الإعدادات and every screen picks it
// up on next load.
// =========================================================
import { getSetting } from './db.js';
import { qs } from './utils.js';

export async function applyShopName() {
  const name = await getSetting('shopName', '');
  const strong = qs('.brand-text strong');
  const small = qs('.brand-text small');
  if (!strong || !small) return;
  if (name) {
    strong.textContent = name;
    small.textContent = 'نظام إدارة مرتجعات الموردين';
  } else {
    strong.textContent = 'مرتجعات الموردين';
    small.textContent = 'نظام إدارة المخزون والمرتجعات';
  }
}
