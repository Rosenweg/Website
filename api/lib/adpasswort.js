// Passwort-API auf dc1 (CT 108, http://100.64.2.30:8446/, /opt/ad-sync/password-api.py).
// POST {username, password} mit `Authorization: Bearer <AD_PASSWORD_API_SECRET>`;
// der Dienst ruft `samba-tool user setpassword` auf und protokolliert nur den
// Benutzernamen. Antwort 200 {status:'ok'} oder 500 {error:<stderr von samba-tool>}.
//
// Aufrufer: Passwortwechsel (/api/change-password), Anfangspasswort beim
// Anlegen (/api/admin/users), Scanner-Konten (routes/scanner.js).
//
// Kein Fallback-Geheimnis im Code: ohne AD_PASSWORD_API_SECRET wird nichts
// gesetzt. Werte bei jedem Aufruf aus der Umgebung (Tests).

const apiUrl = () => process.env.AD_PASSWORD_API_URL || 'http://100.64.2.30:8446/';
const apiSecret = () => process.env.AD_PASSWORD_API_SECRET || '';

function eingerichtet() { return !!apiSecret(); }

/**
 * Passwort im AD setzen. -> { ok, status, fehler, zeitueberschreitung }
 * Wirft nie. `fehler` ist der Text der Passwort-API (samba-tool), höchstens
 * 500 Zeichen; das Passwort selbst wird darin durch *** ersetzt.
 */
async function setzen(username, password, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!apiSecret()) return { ok: false, status: 0, fehler: 'AD_PASSWORD_API_SECRET fehlt' };
  const sauber = (t) => String(t ?? '').split(String(password)).join('***').slice(0, 500);
  try {
    const r = await fetchImpl(apiUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiSecret()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return { ok: true, status: r.status, fehler: '' };
    let text = '';
    try { text = await r.text(); } catch { /* leer */ }
    try { const j = JSON.parse(text); text = j.error || text; } catch { /* kein JSON */ }
    return { ok: false, status: r.status, fehler: sauber(text || `HTTP ${r.status}`) };
  } catch (e) {
    const zeit = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, status: 0, fehler: sauber(e?.message || 'nicht erreichbar'), zeitueberschreitung: zeit };
  }
}

module.exports = { eingerichtet, setzen };
