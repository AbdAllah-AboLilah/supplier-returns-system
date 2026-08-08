// =========================================================
// core/audit.js — records a trail of every meaningful action.
// A single-user local app for now, so "user" defaults to the
// device owner; wiring real accounts later just means passing
// a real user id into logAction instead of the default.
// =========================================================
import { put, getAll } from './db.js';
import { uid, nowIso } from './utils.js';

const CURRENT_USER_FALLBACK = 'المستخدم';

export async function logAction(action, entityType, entityId, details = '') {
  const entry = {
    id: uid(),
    timestamp: nowIso(),
    user: CURRENT_USER_FALLBACK,
    action,
    entityType,
    entityId,
    details,
  };
  await put('auditLog', entry);
  return entry;
}

export async function getAuditLog() {
  const rows = await getAll('auditLog');
  return rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}
