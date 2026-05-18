/**
 * Phone-Helper — sanftes Auto-Format für CH/INT-Nummern.
 * Verwendung:
 *   <input type="tel" onblur="PhoneHelpers.format(this)">
 *   PhoneHelpers.normalize("079 123 45 67") === "+41 79 123 45 67"
 *   PhoneHelpers.toTelHref("+41 79 …") === "tel:+41791234567"
 */
(function () {
  if (window.PhoneHelpers) return;
  function normalize(val) {
    if (!val) return '';
    let s = String(val).trim();
    // Mischformate ("Mobil: X / Festnetz: Y") nicht anfassen
    if (/[a-zA-ZäöüÄÖÜ:]/.test(s)) return s;
    s = s.replace(/[^\d+]/g, '');
    if (!s) return '';
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (s.startsWith('0') && !s.startsWith('00')) s = '+41' + s.slice(1);
    if (s.startsWith('41') && !s.startsWith('+')) s = '+' + s;
    // CH: +41 XX XXX XX XX
    const ch = s.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
    if (ch) return `+41 ${ch[1]} ${ch[2]} ${ch[3]} ${ch[4]}`;
    // International: +CC XXX XXX XX XX (gruppiert per 3)
    const intl = s.match(/^\+(\d{1,3})(\d+)$/);
    if (intl) {
      const tail = intl[2].replace(/(\d{3})(?=\d)/g, '$1 ');
      return `+${intl[1]} ${tail}`;
    }
    return s;
  }
  function format(input) {
    if (!input || typeof input.value === 'undefined') return;
    const normed = normalize(input.value);
    if (normed && normed !== input.value) input.value = normed;
  }
  function toTelHref(val) {
    if (!val) return '';
    const digits = String(val).replace(/[^\d+]/g, '');
    return digits ? 'tel:' + digits : '';
  }
  window.PhoneHelpers = { normalize, format, toTelHref };
  // Auto-bind: alle input[type=tel] mit data-phone-format
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[type=tel][data-phone-format]').forEach(el => {
      if (!el._phoneBound) { el._phoneBound = true; el.addEventListener('blur', () => format(el)); }
    });
  });
})();
