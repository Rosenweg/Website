// „Reklamationen dieser STWEG“ (stwegN/pages/reklamationen.html, Befund R2):
// Welche STWEGs zeigt GET /api/reklamationen/uebersicht?
//
// Ohne ?stweg= wie bisher die STWEG(s) des Kontos (Bewohner, Eigentuemer,
// Ausschuss). Mit ?stweg=N (die STWEG-Seite uebergibt ihre Nummer) nur diese
// STWEG – sofern das Konto sie sehen darf: Technik/Praesident jede, sonst
// Bewohner/Eigentuemer/Ausschuss und Hausverwaltung dieser STWEG. Wer nicht
// darf, bekommt 403 mit einer klaren Meldung statt still der eigenen STWEG.
// Meldungen ohne STWEG (uebergreifend) zeigt die Seite immer mit.
const {
  getUserStwegs, getStwegsMitVerwaltung, isTechnik, isPraesident, getAusschussStwegs, isVerwaltungFor,
} = require('./groups');

const ALLE = [1, 2, 3, 4, 5, 6, 7, 8];

function stwegName(n) {
  return n === 8 ? 'MEG' : `STWEG ${n}`;
}

// -> { stwegs: [..] } oder { status, error }
function uebersichtStwegs(groups, angefragt) {
  const g = groups || [];
  if (angefragt === undefined || angefragt === null || angefragt === '') {
    return { stwegs: [...getUserStwegs(g)] };
  }
  const n = parseInt(angefragt, 10);
  if (!Number.isInteger(n) || n < 1 || n > 8 || String(n) !== String(angefragt).trim()) {
    return { status: 400, error: 'Ungültige STWEG-Nummer' };
  }
  if (isTechnik(g) || isPraesident(g) || getStwegsMitVerwaltung(g).has(n)) return { stwegs: [n] };
  return {
    status: 403,
    error: `Die Reklamationen der ${stwegName(n)} sehen nur Bewohner, Eigentümer, Ausschuss und Verwaltung dieser STWEG.`,
  };
}

// STWEG-Trennung fuer Reklamations-Stammdaten (Auto-Zuweisung, Melde-Orte):
// Technik/Praesident alles; sonst nur STWEGs, in deren Ausschuss man sitzt
// oder die man als Hausverwaltung betreut (stwegN-verwaltung).
// stweg 0/NULL gilt fuer alle STWEGs -> nur Technik/Praesident.
function stwegSchreibbar(groups, stweg) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  const n = parseInt(stweg, 10);
  return Number.isFinite(n) && n > 0 && (getAusschussStwegs(g).has(n) || isVerwaltungFor(g, n));
}

// GET /api/reklamationen/rechte (Rosenweg Reparatur): welche STWEGs das Konto
// in der App vorschlagen, ansehen und bei der Auto-Zuweisung aendern darf –
// dieselben Regeln wie uebersichtStwegs und stwegSchreibbar, damit die App
// keine Gruppennamen kennen muss. Sperrt nichts; die Routen pruefen selbst.
function reparaturRechte(groups) {
  const g = groups || [];
  const alle = isTechnik(g) || isPraesident(g);
  const sortiert = (s) => [...s].sort((a, b) => a - b);
  return {
    eigene_stwegs: sortiert(getUserStwegs(g)),
    uebersicht_stwegs: alle ? ALLE : sortiert(getStwegsMitVerwaltung(g)),
    auto_assign_stwegs: alle ? [0, ...ALLE] : ALLE.filter((n) => stwegSchreibbar(g, n)),
  };
}

module.exports = { uebersichtStwegs, stwegSchreibbar, reparaturRechte };
