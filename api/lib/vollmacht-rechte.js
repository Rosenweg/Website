// Wer eine Vollmacht widerrufen darf – eine Regel fuer den Server
// (POST /api/vollmachten/:id/revoke) und die Liste (Feld darf_widerrufen,
// danach zeigt vollmachten.html den Knopf „Widerrufen“). Befund B11: Ausschuss
// und Verwaltung sehen „Alle“, duerfen aber nicht widerrufen.
const { isTechnik, isPraesident, getAusschussStwegs, verwaltungStwegs, verwaltetAlleStwegs } = require('./groups');

// Technik und Praesident duerfen jede Vollmacht widerrufen.
function widerrufAdmin(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g);
}

// Ist email eine der Vollmachtgeber-Adressen (Primaer-Adresse oder Liste
// vollmachten_vollmachtgeber)? Gross/Klein egal.
function istVollmachtgeber(email, primaerEmail, listeEmails) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (String(primaerEmail || '').trim().toLowerCase() === e) return true;
  return (listeEmails || []).some(x => String(x || '').trim().toLowerCase() === e);
}

// Recht ohne Status: Admin-Rolle oder Vollmachtgeber.
function darfWiderrufenRecht(groups, istGeber) {
  return widerrufAdmin(groups) || !!istGeber;
}

// Fuer eine Zeile der Liste (v.vollmachtgeber_liste = [{email, …}]): nur aktive
// Vollmachten bekommen den Knopf.
function darfWiderrufen(user, v) {
  if (!v || v.status !== 'aktiv') return false;
  const liste = Array.isArray(v.vollmachtgeber_liste) ? v.vollmachtgeber_liste.map(x => x && x.email) : [];
  return darfWiderrufenRecht(user && user.groups, istVollmachtgeber(user && user.email, v.vollmachtgeber_email, liste));
}

// ─── Hausverwaltung und Seitenrecht „vollmachten“ (Befund B19) ──────────
// Die Verwaltung (stwegN-verwaltung, Übergang: „Verwaltung“) bekommt bei
// Vollmachten nur, was das Seitenrecht „vollmachten“ ihrer Gruppe hergibt,
// und nur fuer ihre STWEG(s):
//   lesen     alle Vollmachten ihrer STWEG(s) sehen, PDF und KI-Pruefung
//   schreiben zusaetzlich fuer Dritte erfassen/bearbeiten und „Papier aktivieren“
// Eigene Vollmachten (als Vollmachtgeber) gehen fuer jedes Konto wie bisher.
// Technik/Praesident (alles) und Ausschuss (Vollmachten der eigenen STWEG
// sehen) bleiben unveraendert und haengen nicht am Seitenrecht.
const STUFE = { read: 1, write: 2 };
function stufe(perm) { return STUFE[perm] || 0; }

// STWEGs, fuer die die Verwaltung mit Seitenrecht >= mindestens handeln darf.
function vmVerwaltungStwegs(groups, perm, mindestens = 'read') {
  if (stufe(perm) < stufe(mindestens)) return new Set();
  return verwaltungStwegs(groups || []);
}

// Wer sieht welche Vollmachten (ausser den eigenen)?
// { alle, stwegs: [..], ohneStweg } — ohneStweg = Vollmachten ohne STWEG.
function vmSicht(groups, perm) {
  const g = groups || [];
  if (widerrufAdmin(g)) return { alle: true, stwegs: [], ohneStweg: true };
  const s = getAusschussStwegs(g);
  for (const n of vmVerwaltungStwegs(g, perm, 'read')) s.add(n);
  const alleVerwaltet = stufe(perm) >= 1 && verwaltetAlleStwegs(g);
  return { alle: false, stwegs: [...s].sort((a, b) => a - b), ohneStweg: alleVerwaltet };
}

// Darf die Sicht die Vollmacht einer STWEG (null = ohne) sehen?
function vmSichtErlaubt(sicht, stweg) {
  if (!sicht) return false;
  if (sicht.alle) return true;
  if (stweg === null || stweg === undefined || stweg === '') return !!sicht.ohneStweg;
  return sicht.stwegs.includes(Number(stweg));
}

// Fuer Dritte erfassen/bearbeiten und „Papier aktivieren“: Technik/Praesident
// immer; die Verwaltung mit Seitenrecht „schreiben“ fuer ihre STWEG(s), ohne
// STWEG nur, wenn sie alle STWEGs verwaltet.
function vmDarfVerwalten(groups, perm, stweg) {
  const g = groups || [];
  if (widerrufAdmin(g)) return true;
  if (stufe(perm) < 2) return false;
  if (stweg === null || stweg === undefined || stweg === '') return verwaltetAlleStwegs(g);
  return vmVerwaltungStwegs(g, perm, 'write').has(Number(stweg));
}

// Darf das Konto ueberhaupt fuer Dritte erfassen (Formular, ohne STWEG-Bezug)?
function vmDarfFuerAndereIrgendwo(groups, perm) {
  return widerrufAdmin(groups || []) || vmVerwaltungStwegs(groups, perm, 'write').size > 0;
}

module.exports = {
  widerrufAdmin, istVollmachtgeber, darfWiderrufenRecht, darfWiderrufen,
  vmVerwaltungStwegs, vmSicht, vmSichtErlaubt, vmDarfVerwalten, vmDarfFuerAndereIrgendwo,
};
