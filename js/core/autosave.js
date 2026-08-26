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
  // What is already persisted. Blur fires whether or not anything was
  // typed, so without this every tab-through of a row of quantity/cost
  // fields sent a cloud write per field — pure cost and latency for a
  // value that never changed.
  let lastSaved = inputEl.value;

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `autosave-status ${cls || ''}`;
  }

  // The save currently on its way to the cloud, so callers can wait for it.
  let inFlight = Promise.resolve();

  function commit({ force = false } = {}) {
    const value = inputEl.value;
    if (!force && value === lastSaved) return inFlight;
    const previous = lastSaved;
    lastSaved = value; // claim it up front so a blur landing mid-save doesn't repeat the write
    setStatus('جارِ الحفظ…', 'saving');
    inFlight = (async () => {
      try {
        await saveFn(value);
        setStatus('✓ تم الحفظ', 'saved');
        setTimeout(() => { if (statusEl && statusEl.textContent === '✓ تم الحفظ') setStatus('', ''); }, 2000);
      } catch (err) {
        console.error(err);
        lastSaved = previous; // failed — let the next keystroke or blur retry it
        setStatus('⚠ لم يتم الحفظ', 'error');
      }
    })();
    return inFlight;
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => commit(), delay);
  });
  // Also commit immediately on blur so a quick tab-away never waits out the debounce.
  inputEl.addEventListener('blur', () => { clearTimeout(timer); commit(); });

  return {
    flushNow: () => commit({ force: true }),
    // Resolves once this field has nothing left to save: drops the
    // debounce, writes the current value if it differs, and waits for any
    // write already on its way. Anything that reads the stored record back
    // — exporting, printing — awaits this first, otherwise it can read the
    // value from just before the last keystroke.
    settle: async () => {
      clearTimeout(timer);
      await commit();
      await inFlight;
    },
  };
}
