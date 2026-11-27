// „Reklamationen dieser STWEG“ (stwegN/pages/reklamationen.html, Befund R2):
// Welche STWEGs zeigt GET /api/reklamationen/uebersicht?
//
// Ohne ?stweg= wie bisher die STWEG(s) des Kontos (Bewohner, Eigentuemer,
// Ausschuss). Mit ?stweg=N (die STWEG-Seite uebergibt ihre Nummer) nur diese
// STWEG – sofern das Konto sie sehen darf: Technik/Praesident jede, sonst
// Bewohner/Eigentuemer/Ausschuss und Hausverwaltung dieser STWEG. Wer nicht
// darf, bekommt 403 mit einer klaren Meldung statt still der eigenen STWEG.
// Meldungen ohne STWEG (uebergreifend) zeigt die Seite immer mit.
const { getUserStwegs, getStwegsMitVerwaltung, isTechnik, isPraesident } = require('./groups');

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

module.exports = { uebersichtStwegs };
