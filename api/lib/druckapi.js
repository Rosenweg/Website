// Druck-API auf CT 111 (cups-server, 100.64.2.32:8080) und HTML -> PDF über
// Gotenberg (doc-converter). Ein Weg für alles, was die API ausdruckt: Druck
// per Mail (server.js, druckerr9@/druckerr13@) und der Scanner-Zettel
// (routes/scanner.js).
//
// Die Druck-API nimmt POST /print/<Warteschlange> mit dem Inhalt als Körper,
// `Authorization: Bearer <PRINT_API_SECRET>` und `X-Filename` (nur die Endung
// zählt: .pdf, .txt …), legt ihn in eine Temp-Datei, ruft `lp -d <Drucker>`
// auf und löscht die Datei wieder. Sie kennt nur die Warteschlangen in
// DRUCK_WARTESCHLANGEN (wie PRINTER_OPTIONS in /opt/print-api.py).
//
// Kein Fallback-Geheimnis im Code: ohne PRINT_API_SECRET wird nicht gedruckt.
// Die Werte werden bei jedem Aufruf aus der Umgebung gelesen (Tests).

const DRUCK_WARTESCHLANGEN = ['DruckerR9', 'DruckerR13'];

const druckUrl = () => (process.env.PRINT_API_URL || 'http://100.64.2.32:8080').replace(/\/+$/, '');
const druckToken = () => process.env.PRINT_API_SECRET || '';
const gotenbergUrl = () => (process.env.GOTENBERG_URL || 'http://doc-converter:3000').replace(/\/+$/, '');

/** Ist die Druck-API eingerichtet? (nur ja/nein, nie der Wert) */
function eingerichtet() { return !!druckToken(); }

/**
 * Einen Auftrag an die Druck-API schicken. -> { ok, status, message }
 * Wirft nur, wenn die Druck-API nicht erreichbar ist oder kein Geheimnis da ist.
 * `ok` heisst: CUPS hat den Auftrag angenommen — nicht, dass er schon gedruckt ist.
 */
async function drucken(drucker, inhalt, dateiname, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!DRUCK_WARTESCHLANGEN.includes(drucker)) throw new Error(`Unbekannter Drucker ${drucker}`);
  const token = druckToken();
  if (!token) throw new Error('PRINT_API_SECRET fehlt');
  const r = await fetchImpl(`${druckUrl()}/print/${drucker}`, {
    method: 'POST',
    body: inhalt,
    headers: { Authorization: `Bearer ${token}`, 'X-Filename': dateiname },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let d = null;
  try { d = await r.json(); } catch { d = null; }
  const status = d?.status || (r.ok ? 'ok' : 'error');
  return { ok: r.ok && status === 'ok', status, message: String(d?.message || (r.ok ? '' : `HTTP ${r.status}`)) };
}

/**
 * HTML -> PDF über Gotenberg. -> Buffer. papier: { breite, hoehe, rand } in Zoll
 * (Standard A4, 0.5"). semaphore: gotenbergSemaphore aus server.js (optional).
 */
async function htmlZuPdf(html, { papier = {}, semaphore = null, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const { breite = '8.27', hoehe = '11.7', rand = '0.5' } = papier;
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('paperWidth', String(breite));
  form.append('paperHeight', String(hoehe));
  for (const s of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) form.append(s, String(rand));
  const release = semaphore ? await semaphore() : null;
  let r;
  try {
    r = await fetchImpl(`${gotenbergUrl()}/forms/chromium/convert/html`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
    });
  } finally { if (release) release(); }
  if (!r.ok) throw new Error(`Gotenberg HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { DRUCK_WARTESCHLANGEN, eingerichtet, drucken, htmlZuPdf };
