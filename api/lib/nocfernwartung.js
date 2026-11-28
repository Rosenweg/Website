// NOC-Sicht auf die Fernwartung der geteilten Telefone (Prüfmodul telefone.fernwartung,
// Plan adb-tunnel-telefone 3.2). Die Daten kommen von der pbx-api auf CT 220
// (GET /api/pbx/fernwartung/noc, X-PBX-Secret), die die Ampel je Telefon schon setzt:
//   gruen  Handshake < 3 min, oder < 20 min und das Telefon ist an der Anlage registriert
//   gelb   länger kein Handshake, Telefon lebt aber; oder neuer Schlüssel wartet auf Bestätigung
//   rot    still und nicht registriert, Not-Aus, oder fremde adb-Rückfrage in 24 h
//   blau   Sitzung läuft (Hinweis, keine Warnung)
//   grau   Fernwartung an diesem Telefon (noch) nicht eingerichtet
// Keine Personennamen, keine Schlüssel, keine Adressen (das NOC hängt an der Wand).

const RANG = { rot: 0, gelb: 1, blau: 2, gruen: 3, grau: 4 };
const AMPELN = new Set(Object.keys(RANG));

function alterText(sek) {
  if (!sek) return 'nie';
  if (sek < 120) return 'jetzt';
  if (sek < 3600) return Math.round(sek / 60) + ' min';
  if (sek < 48 * 3600) return Math.round(sek / 3600) + ' h';
  return Math.round(sek / 86400) + ' T';
}

function telefonFuerNoc(t, jetztSek) {
  let ampel = AMPELN.has(t.ampel) ? t.ampel : 'grau';
  if (t.stand === 'wartet' && ampel === 'grau') ampel = 'gelb';
  const hinweise = [];
  if (t.stand === 'aus') hinweise.push('Not-Aus');
  if (t.stand === 'wartet') hinweise.push('Schlüssel bestätigen');
  if (t.stand === 'keiner' || t.stand === 'neu') hinweise.push('nicht eingerichtet');
  if (t.fremd) hinweise.push('fremde adb-Rückfrage');
  if (t.sitzung) hinweise.push('Sitzung' + (t.sitzung.zweck ? ' (' + String(t.sitzung.zweck).slice(0, 20) + ')' : ''));
  if (t.stand === 'bereit' && !t.registriert) hinweise.push('nicht an der Anlage');
  const hs = Number(t.letzter_handshake) || 0;
  return {
    ext: String(t.ext || '').slice(0, 8),
    name: String(t.name || '').slice(0, 40),
    ampel,
    kontakt: t.stand === 'bereit' ? alterText(hs ? Math.max(0, jetztSek - hs) : 0) : null,
    hinweise,
  };
}

/** Antwort der pbx-api -> { eingerichtet, zentrale, zusammenfassung, telefone } */
function fernwartungFuerNoc(d, jetztMs = Date.now()) {
  const jetzt = Math.floor(jetztMs / 1000);
  const telefone = (d && Array.isArray(d.telefone) ? d.telefone : []).map((t) => telefonFuerNoc(t, jetzt));
  telefone.sort((a, b) => (RANG[a.ampel] - RANG[b.ampel]) || a.ext.localeCompare(b.ext));
  const zahl = (a) => telefone.filter((t) => t.ampel === a).length;
  const zs = {
    gesamt: telefone.length, gruen: zahl('gruen'), gelb: zahl('gelb'), rot: zahl('rot'),
    blau: zahl('blau'), grau: zahl('grau'),
  };
  const eingerichtet = !!(d && d.eingerichtet);
  zs.ampel = !eingerichtet ? 'grau' : (d.zentrale === false || zs.rot) ? 'rot' : zs.gelb ? 'gelb' : zs.blau ? 'blau' : 'gruen';
  return { eingerichtet, zentrale: !!(d && d.zentrale), zusammenfassung: zs, telefone };
}

// Wandbild-Sicht: der Gerätename wie auf /smartphones (z. B. „Rosenweg Smartphone 1“, Entscheid
// Stefan 28.11.2026). Es sind Namen geteilter Telefone, keine Personen; die Zuordnung zur
// Nebenstelle bleibt so fest, auch wenn die Ampel die Reihenfolge ändert.
function fernwartungOeffentlich(out) {
  return { ...out, telefone: (out.telefone || []).map((t) => ({ ...t })) };
}

module.exports = { fernwartungFuerNoc, fernwartungOeffentlich, telefonFuerNoc };
