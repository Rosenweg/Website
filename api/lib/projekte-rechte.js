// Wer darf Projekte (projekte.html, /api/projects…) lesen und kommentieren?
// Eine Regel fuer die Routen in server.js und die Tests (Befund V1).
//
//   lesen        Technik/Praesident, jede Eigentuemergruppe (wie bisher) und die
//                Hausverwaltung (stwegN-verwaltung, Übergang „Verwaltung“) mit
//                Seitenrecht „projekte“ ab lesen.
//   kommentieren Technik/Praesident und Eigentuemer (unveraendert); die
//                Verwaltung liest nur.
//   bearbeiten   unveraendert Ausschuss/Technik (requireAusschussOrTechnik).
//
// Projekte haben keine STWEG (Projekte der STWEG-Kooperation, Tabelle projects
// ohne Spalte stweg) – sie sieht jede Verwaltung. STWEG-gebunden sind die
// Auslagen eines Projekts: die Verwaltung sieht nur die ihrer STWEG(s)
// (lib/stweg-sicht.js), wie auf auslagen.html.
const { isTechnik, isPraesident, isVerwaltungForAny } = require('./groups');
const { stwegSicht } = require('./stweg-sicht');

const STUFE = { read: 1, write: 2 };

function istEigentuemer(groups) {
  return (groups || []).some(g => String(g).toLowerCase().includes('eigentuemer'));
}

function projekteLesen(groups, perm) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g) || istEigentuemer(g)) return true;
  return isVerwaltungForAny(g) && (STUFE[perm] || 0) >= 1;
}

function projekteKommentieren(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g) || istEigentuemer(g);
}

// Auslagen eines Projekts: null = alle (wie bisher fuer Eigentuemer/Technik),
// sonst eine Sicht aus lib/stweg-sicht.js (nur die eigenen STWEGs).
function projektAuslagenSicht(groups) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g) || istEigentuemer(g)) return null;
  return stwegSicht(g);
}

module.exports = { projekteLesen, projekteKommentieren, projektAuslagenSicht };
