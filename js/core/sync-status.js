// =========================================================
// core/sync-status.js
// Three states, shown as a small dot + label in the sidebar:
//   'online'   (green)  — connected, nothing pending
//   'syncing'  (yellow) — a write is currently going out
//   'offline'  (red)    — no internet; changes are only local
//
// Today this only tracks real connectivity (navigator.onLine +
// online/offline events), because there is no cloud write yet
// to be "syncing". Once the Firestore layer lands, it will wrap
// its writes in beginSyncOperation()/endSyncOperation() and the
// yellow state will start lighting up for real — nothing else
// about this module needs to change.
// =========================================================

let currentStatus = navigator.onLine ? 'online' : 'offline';
let pendingWrites = 0;
const listeners = [];

export function getSyncStatus() {
  return currentStatus;
}

export function onSyncStatusChange(fn) {
  listeners.push(fn);
}

function setStatus(next) {
  if (currentStatus === next) return;
  currentStatus = next;
  listeners.forEach(fn => fn(next));
}

export function beginSyncOperation() {
  pendingWrites++;
  if (navigator.onLine) setStatus('syncing');
}

export function endSyncOperation() {
  pendingWrites = Math.max(0, pendingWrites - 1);
  if (pendingWrites === 0) setStatus(navigator.onLine ? 'online' : 'offline');
}

window.addEventListener('online', () => { if (pendingWrites === 0) setStatus('online'); });
window.addEventListener('offline', () => setStatus('offline'));
