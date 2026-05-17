/**
 * Modal Helpers — global accessibility & UX improvements.
 * L4: ESC schließt sichtbares Modal (mit id beginnend mit "modal" oder class "fixed inset-0").
 * L7: Polling-Helper pauses on visibilitychange "hidden" tabs.
 */
(function() {
  // ESC schließt sichtbare Modals
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Finde alle sichtbaren Modal-Container (haben class fixed inset-0 + nicht hidden)
    const modals = document.querySelectorAll('.fixed.inset-0:not(.hidden)');
    if (modals.length === 0) return;
    const top = modals[modals.length - 1];
    // Klick auf erste Close-Funktion auslösen (×-Button)
    const closeBtn = top.querySelector('button[aria-label*="schlie"], button[aria-label*="Schlie"], [data-close-modal]')
      || Array.from(top.querySelectorAll('button')).find(b => b.textContent.trim() === '×' || b.textContent.trim() === '✕');
    if (closeBtn) closeBtn.click();
  });

  // Helper: setInterval, der bei "Tab hidden" pausiert (L7)
  window.intervalWhenVisible = function(fn, ms) {
    let timer = null;
    const start = () => { if (!timer && !document.hidden) { fn(); timer = setInterval(fn, ms); } };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
    start();
    return { cancel: stop };
  };
})();
