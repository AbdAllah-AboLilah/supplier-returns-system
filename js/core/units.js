// =========================================================
// core/units.js
//
// The units a price can be quoted in. A supplier who sells by the dozen
// quotes a dozen price, but everything downstream — return lines, ERP
// cost, the invoice check — works in piece cost, so the multiplier here
// is what converts between the two.
//
// The list is editable from مراجعة الفواتير → إدارة الوحدات, and the
// same list is used wherever a price is typed. It lives under the
// `invoiceUnits` setting key, which is where it was first stored back
// when only the invoice screen used it; renaming the key would strand
// the units people have already added.
// =========================================================
import { getSetting, setSetting } from './db.js';

export const DEFAULT_UNITS = [
  { key: 'piece', label: 'قطعة', multiplier: 1 },
  { key: 'dozen', label: 'دستة', multiplier: 12 },
];

const SETTING_KEY = 'invoiceUnits';

export async function getUnits() {
  const units = await getSetting(SETTING_KEY, null);
  return (units && units.length) ? units : DEFAULT_UNITS;
}

export function saveUnits(units) {
  return setSetting(SETTING_KEY, units);
}

export function unitByKey(units, key) {
  return units.find(u => u.key === key) || units[0] || DEFAULT_UNITS[0];
}

export function multiplierOf(units, key) {
  return Number(unitByKey(units, key)?.multiplier) || 1;
}
