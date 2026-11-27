// MEG (Tiefeinstellhalle) – reine Helfer fuer die Einstellplatz-Verwaltung
// (kein DB/Netz-Bezug, testbar). Genutzt von routes/meg.js.
const { getAusschussStwegs, isTechnik, isPraesident } = require('./groups');

// M1: Plaetze verwalten (volle Tabelle mit Namen, Speichern) duerfen nur der
// MEG-Ausschuss (Ausschuss STWEG 8) und Technik/Praesident. Dieselbe Regel
// bekommt die Seite ueber /einstellplaetze/rechte – sie raet nicht mehr am
// Gruppennamen („ausschuss“ irgendeiner STWEG).
function darfMegPlaetzeVerwalten(user) {
  const groups = (user && user.groups) || [];
  return !!(user && user.isAdmin) || isTechnik(groups) || isPraesident(groups) || getAusschussStwegs(groups).has(8);
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

module.exports = { darfMegPlaetzeVerwalten, megPlatzAenderung };
