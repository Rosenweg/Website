// Häuser und ihre STWEGs — eine Quelle für alles, was nach Haus unterscheidet.
//
// Abgeleitet am 6. August 2026 aus den Wohnungsdaten: die Bezeichnungen tragen
// das Haus im Namen ('18.2OG.1', 'RW17-Mansarde'), und daraus liess sich je
// STWEG die Hausliste bilden. Deckt sich mit api/lib/groups.js, wo STWEG 3 die
// r9-Gruppen führt und STWEG 6 die r1-Gruppen.
//
// Hier steht sie fest und nicht als Abfrage zur Laufzeit: eine Zuordnung aus
// Wohnungsbezeichnungen zu erraten ist brüchig — eine umbenannte Wohnung würde
// stillschweigend ein Haus verschieben. Ändert sich die Aufteilung wirklich,
// gehört das hierher, an eine Stelle, die jemand bewusst anfasst.
//
// STWEG 8 ist die MEG (Parkplätze, Hobbyräume) und hat keine eigenen Häuser.

const STWEG_HAEUSER = {
  1: [17, 18],
  2: [13, 14, 16],
  3: [9],
  4: [10, 12],
  5: [5, 6, 8],
  6: [1],
  7: [2, 4],
  8: [],
};

/** Alle Hausnummern, aufsteigend. */
const HAEUSER = [...new Set(Object.values(STWEG_HAEUSER).flat())].sort((a, b) => a - b);

/** Zu welchem STWEG gehört ein Haus? null, wenn unbekannt. */
function stwegVonHaus(haus) {
  const n = Number(haus);
  for (const [stweg, liste] of Object.entries(STWEG_HAEUSER)) {
    if (liste.includes(n)) return Number(stweg);
  }
  return null;
}

/**
 * Eine Auswahl aus STWEGs und Hausnummern zu einer Hausliste machen.
 *
 * Auf der Leitung reist nur die Hausnummer — eine Anzeige weiss, in welchem
 * Haus sie hängt, und muss nichts über STWEGs wissen. Die zweite Achse gibt es
 * nur in der Bedienung, damit man „ganzes STWEG 5" nicht als drei Häkchen
 * setzen muss.
 */
function haeuserAusAuswahl({ stwegs = [], haeuser = [] } = {}) {
  const raus = new Set();
  for (const s of stwegs || []) {
    for (const h of STWEG_HAEUSER[Number(s)] || []) raus.add(h);
  }
  for (const h of haeuser || []) {
    const n = Number(h);
    if (HAEUSER.includes(n)) raus.add(n);
  }
  return [...raus].sort((a, b) => a - b);
}

module.exports = { STWEG_HAEUSER, HAEUSER, stwegVonHaus, haeuserAusAuswahl };
