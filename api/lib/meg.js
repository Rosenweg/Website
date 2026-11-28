// MEG (Tiefeinstellhalle) – reine Helfer fuer die Einstellplatz-Verwaltung
// (kein DB/Netz-Bezug, testbar). Genutzt von routes/meg.js.
const { STWEG_GROUPS, getAusschussStwegs, isTechnik, isPraesident, isVerwaltungFor } = require('./groups');

// M1: Plaetze verwalten (volle Tabelle mit Namen, Speichern) duerfen der
// MEG-Ausschuss (Ausschuss STWEG 8), seit 28.11.2026 auch die MEG-Verwaltung
// (meg-verwaltung, Entscheid Stefan), und Technik/Praesident. Dieselbe Regel
// bekommt die Seite ueber /einstellplaetze/rechte – sie raet nicht mehr am
// Gruppennamen („ausschuss“ irgendeiner STWEG).
function darfMegPlaetzeVerwalten(user) {
  const groups = (user && user.groups) || [];
  return !!(user && user.isAdmin) || isTechnik(groups) || isPraesident(groups)
    || getAusschussStwegs(groups).has(8) || isVerwaltungFor(groups, 8);
}

// Liste der Plaetze (Platz, Typ, Status) sieht nur, wer zur MEG gehoert:
// Mitglieder (meg-eigentuemer, meg-bewohner), MEG-Ausschuss, MEG-Verwaltung,
// Technik, Praesident (Entscheid Stefan 28.11.2026, Fund F7). Oeffentlich
// bleibt nur /einstellplaetze/verfuegbar (zu vermietende Plaetze).
function darfMegPlaetzeSehen(user) {
  if (darfMegPlaetzeVerwalten(user)) return true;
  const groups = ((user && user.groups) || []).map(g => String(g).toLowerCase());
  return Object.values(STWEG_GROUPS[8] || {}).some(name => groups.includes(String(name).toLowerCase()));
}

// M2: PUT fuehrt zusammen – nur Felder, die im Body stehen, werden geaendert.
// Fehlt z. B. zugeordnet_email oder wohnung_id (die Seite kennt sie nicht),
// bleibt der hinterlegte Wert. Leerer Text / null leert das Feld bewusst.
const MEG_FELDER = ['platz_nr', 'typ', 'status', 'zugeordnet_name', 'zugeordnet_email', 'wohnung_id', 'notizen'];
const MEG_PFLICHT = new Set(['platz_nr', 'typ', 'status']); // nie leeren
const MEG_TYPEN = new Set(['auto', 'motorrad']);
const MEG_STATUS = new Set(['frei', 'zu_vermieten', 'vermietet', 'eigengenutzt']);
function megPlatzAenderung(body) {
  const b = body || {};
  const felder = [];
  const werte = [];
  for (const f of MEG_FELDER) {
    if (!Object.prototype.hasOwnProperty.call(b, f)) continue;
    let v = b[f];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (MEG_PFLICHT.has(f) && v == null) continue;
    if (f === 'typ' && !MEG_TYPEN.has(v)) return { error: 'Ungültiger Typ (auto oder motorrad)' };
    if (f === 'status' && !MEG_STATUS.has(v)) return { error: 'Ungültiger Status' };
    if (f === 'wohnung_id' && v != null) {
      v = parseInt(v, 10);
      if (!Number.isFinite(v)) return { error: 'Ungültige Wohnung' };
    }
    if (f === 'platz_nr') v = String(v);
    felder.push(f);
    werte.push(v);
  }
  return { felder, werte };
}

// M3: Platznummern numerisch sortieren (1, 2, …, 10, 100 statt 1, 10, 100, 2),
// erst nach Typ, dann Nummer; Nummern mit Zusatz (z. B. „12a“) nach der Zahl.
function platzNrVergleich(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'de', { numeric: true, sensitivity: 'base' });
}
function sortierePlaetze(rows) {
  return [...(rows || [])].sort((a, b) =>
    String(a.typ || '').localeCompare(String(b.typ || '')) || platzNrVergleich(a.platz_nr, b.platz_nr));
}

module.exports = { darfMegPlaetzeVerwalten, darfMegPlaetzeSehen, megPlatzAenderung, platzNrVergleich, sortierePlaetze };
