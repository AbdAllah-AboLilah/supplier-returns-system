// =========================================================
// core/autosave.js
// Wraps an input/textarea so every keystroke (debounced) is
// persisted immediately — no explicit "Save" button, no risk of
// losing work if the tab or app closes unexpectedly. Pass a
// status element to show a small "جارِ الحفظ… / ✓ تم الحفظ"
// indicator next to the field.
// =========================================================

export function autosaveField(inputEl, saveFn, { delay = 600, statusEl = null } = {}) {
  let timer = null;
  let inFlight = null;

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `autosave-status ${cls || ''}`;
  }

  async function commit() {
    const value = inputEl.value;
    setStatus('جارِ الحفظ…', 'saving');
    try {
      inFlight = saveFn(value);
      await inFlight;
      setStatus('✓ تم الحفظ', 'saved');
      setTimeout(() => { if (statusEl && statusEl.textContent === '✓ تم الحفظ') setStatus('', ''); }, 2000);
    } catch (err) {
      console.error(err);
      setStatus('⚠ لم يتم الحفظ', 'error');
    }
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(commit, delay);
  });
  // Also commit immediately on blur so a quick tab-away never waits out the debounce.
  inputEl.addEventListener('blur', () => { clearTimeout(timer); commit(); });

  return { flushNow: commit };
}
