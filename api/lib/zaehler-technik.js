// Zähler-Technik Rosenweg 9 (stweg3/pages/zaehler-technik.html, /api/zaehler-technik):
// wer darf die Statusseite öffnen? Eine Quelle für requireZaehlerTechnik (server.js)
// und das Feld energie.technik in GET /api/auth/me (routes/energie-lesen.js).
//
// Technik und Präsident (wie überall gleich Technik), die Verwaltung von STWEG 3
// (Übergang: „Verwaltung“) und die Eigentümergruppe von STWEG 3 (r9-eigentuemer,
// lib/groups.js STWEG_GROUPS; Befund W19: vorher stweg3-eigentuemer).
// Wie viel jemand dort sieht (voll oder eingeschränkt), entscheidet vollerZugriff
// in routes/energie-lesen.js (Technik/Präsident oder energie-config:read).
const { isTechnik, isPraesident, isVerwaltungFor, STWEG_GROUPS } = require('./groups');

function zaehlerTechnikZugang(groups) {
  const g = groups || [];
  const gl = g.map(x => String(x).toLowerCase());
  return isTechnik(g) || isPraesident(g)
    || isVerwaltungFor(g, 3)
    || gl.includes(STWEG_GROUPS[3].eigentuemer.toLowerCase());
}

module.exports = { zaehlerTechnikZugang };
