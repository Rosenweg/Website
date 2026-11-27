// Konto geloescht (Loeschungen, processAuthentiKDeletions -> lokalesKontoNachLoeschung):
// persoenliche Daten der Person auch auf der Anlage (pbx-api, CT 220) entfernen.
// POST /api/pbx/person/loeschen (X-PBX-Secret): App-Einstellungen, PIN, offene Anmelde-QR und
// Hintergrundbild der geteilten Telefone.
// Scheitert es, bleibt die Loeschung trotzdem gueltig; es wird nur gewarnt (kein Name im Log).

async function personLoeschen({ url, secret, email, fetchFn = fetch, timeoutMs = 8000 }) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, grund: 'email fehlt' };
  if (!secret || !url) return { ok: false, grund: 'PBX nicht eingerichtet' };
  try {
    const r = await fetchFn(`${String(url).replace(/\/+$/, '')}/api/pbx/person/loeschen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PBX-Secret': secret },
      body: JSON.stringify({ email: e }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, grund: 'HTTP ' + r.status };
    const d = await r.json().catch(() => ({}));
    return { ok: true, hintergrund: !!d.hintergrund };
  } catch (err) {
    return { ok: false, grund: err.name || 'Fehler' };
  }
}

module.exports = { personLoeschen };
