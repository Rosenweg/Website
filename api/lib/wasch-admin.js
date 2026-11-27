// Waschküchen-Verwaltung: wer darf was (Befund W10).
//
// Vorher liessen die Routen /api/wasch/admin/*, Räume und Einstellungen nur
// Technik/Präsident zu (adminOnly); das Seitenrecht „waschküche-admin“ aus der
// Rechteverwaltung wirkte nirgends. Jetzt:
//
//   Technik, Präsident    immer (lesen und schreiben)
//   sonst                 Seitenrecht „waschküche-admin“ (read: Übersicht,
//                         Sessions, Abrechnung ansehen; write: Räume,
//                         Einstellungen, Abrechnung auslösen) UND Ausschuss
//                         oder Hausverwaltung JEDER STWEG, die eine aktive
//                         Waschküche hat (heute nur STWEG 3). Übersicht,
//                         Sessions und Abrechnung sind nicht je STWEG getrennt
//                         – darum muss die Person alle betroffenen STWEGs
//                         betreuen, sonst sähe sie fremde Daten.
//
// Türen (UniFi Access) bleiben Technik/Präsident.
const { isTechnik, isPraesident } = require('./groups');
const { stwegSicht, sichtErlaubt } = require('./stweg-sicht');

const STUFE = { none: 0, read: 1, write: 2 };

/**
 * groups: Gruppen des Kontos; recht: 'none'|'read'|'write' (Seitenrecht
 * waschküche-admin); stufe: 'read'|'write'; raumStwegs: STWEG-Nummern der
 * aktiven Räume (null = Raum ohne STWEG).
 * -> { ok, grund }
 */
function waschAdminErlaubt(groups, recht, stufe, raumStwegs) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { ok: true };
  if ((STUFE[recht] || 0) < (STUFE[stufe] || 1)) {
    return { ok: false, grund: stufe === 'write' ? 'Nur ansehen: Ändern braucht das Recht „Waschküche-Admin“ mit Schreibrecht' : 'Kein Recht „Waschküche-Admin“' };
  }
  const sicht = stwegSicht(g);
  const liste = [...(raumStwegs || [])];
  if (!liste.length) return sicht.stwegs.length ? { ok: true } : { ok: false, grund: 'Nur für Ausschuss oder Verwaltung der STWEG mit Waschküche' };
  const fehlt = liste.filter(s => !sichtErlaubt(sicht, s));
  if (fehlt.length) return { ok: false, grund: `Nur für Ausschuss oder Verwaltung der STWEG ${fehlt.filter(s => s != null).join(', ') || 'mit Waschküche'}` };
  return { ok: true };
}

/** Darf das Konto einen Raum dieser STWEG anlegen/ändern? */
function waschRaumAenderbar(groups, stweg) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  return stweg != null && stweg !== '' && sichtErlaubt(stwegSicht(g), Number(stweg));
}

module.exports = { waschAdminErlaubt, waschRaumAenderbar };
