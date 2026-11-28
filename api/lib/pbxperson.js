// Konto geloescht (Loeschungen, processAuthentiKDeletions -> lokalesKontoNachLoeschung):
// persoenliche Daten der Person auch auf der Anlage (pbx-api, CT 220) entfernen.
// POST /api/pbx/person/loeschen (X-PBX-Secret): abmelden, Nextcloud widerrufen, SIP-Zugaenge,
// Combox, Nummer, Einstellungen/PIN/Hintergrund; Anrufe und Protokoll anonymisiert. Die Anlage
// meldet jeden Schritt; gescheiterte Schritte stehen in fehlgeschlagen.
// Scheitert es, bleibt die Loeschung trotzdem gueltig; der Nachlauf (lib/kontoloeschung.js)
// wiederholt die offenen Schritte. schritte: nur diese ausfuehren (Wiederholung);
// nummern: Nummern aus einem frueheren Versuch (die Anlage hat sie dann schon freigegeben,
// Anrufe muessen trotzdem noch anonymisiert werden). antwort: die ganze Antwort der Anlage.

async function personLoeschen({ url, secret, email, schritte, nummern, fetchFn = fetch, timeoutMs = 120000 }) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return { ok: false, grund: 'email fehlt' };
  if (!secret || !url) return { ok: false, grund: 'PBX nicht eingerichtet' };
  try {
    const r = await fetchFn(`${String(url).replace(/\/+$/, '')}/api/pbx/person/loeschen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PBX-Secret': secret },
      body: JSON.stringify({
        email: e,
        ...(Array.isArray(schritte) && schritte.length ? { schritte } : {}),
        ...(Array.isArray(nummern) && nummern.length ? { nummern } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, grund: 'HTTP ' + r.status };
    const d = await r.json().catch(() => ({}));
    const fehlgeschlagen = Object.entries(d.schritte || {}).filter(([, v]) => v && v.ok === false).map(([k]) => k);
    if (fehlgeschlagen.length) return { ok: false, grund: 'Schritte fehlgeschlagen: ' + fehlgeschlagen.join(', '), fehlgeschlagen, antwort: d };
    return { ok: true, hintergrund: !!d.hintergrund, antwort: d };
  } catch (err) {
    return { ok: false, grund: err.name || 'Fehler' };
  }
}

module.exports = { personLoeschen };
