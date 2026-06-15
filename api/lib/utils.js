// Pure, zustandslose Helfer (kein DB/Env/Timer-Bezug) — aus server.js ausgelagert
// im Zuge des inkrementellen Router-Splits. Verhalten unveraendert.

/** Escape string for safe HTML insertion */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Simple async semaphore to throttle Gotenberg/external converter calls.
// Default max 3 concurrent — high enough for normal load, low enough that
// 20+ parallel print emails don't slam the converter into timeouts.
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    queue.shift()();
  };
  return async function acquire() {
    await new Promise(r => { queue.push(r); next(); });
    return () => { active--; next(); };
  };
}

// Sanftes Telefon-Normalisieren: 079 X → +41 79 X X X, 00CC… → +CC…, sonst belassen.
// Mischformate (mit Buchstaben/Doppelpunkten) werden nicht angefasst.
function normalizePhone(val) {
  if (!val) return null;
  let s = String(val).trim();
  if (!s) return null;
  if (/[a-zA-ZäöüÄÖÜ:]/.test(s)) return s;
  s = s.replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0') && !s.startsWith('00')) s = '+41' + s.slice(1);
  if (s.startsWith('41') && !s.startsWith('+')) s = '+' + s;
  const ch = s.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
  if (ch) return `+41 ${ch[1]} ${ch[2]} ${ch[3]} ${ch[4]}`;
  const intl = s.match(/^\+(\d{1,3})(\d+)$/);
  if (intl) return `+${intl[1]} ${intl[2].replace(/(\d{3})(?=\d)/g, '$1 ')}`;
  return s;
}

/** Slug: lowercase, nur [a-z0-9-], Mehrfach-/Rand-Bindestriche entfernt */
function safeId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }

module.exports = { escapeHtml, createSemaphore, normalizePhone, safeId };
