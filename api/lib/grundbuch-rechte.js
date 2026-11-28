// Grundbuch-Erfassung (grundbuch.html, routes/grundbuch.js): wer erfasst, wer
// sieht Namen, wer gibt frei (Klärung Welle 3.1, Funde F1/F7, Entscheid Stefan
// 28.11.2026).
//
//   erfassen/auslesen  Eigentümer, Ausschuss, Technik/Präsident – keine Mieter.
//                      Mit STWEG am Anteil: nur Eigentümer bzw. Ausschuss DIESER
//                      STWEG. Ohne STWEG (noch nicht zugeordnet): jede/r der drei.
//   Namen, Bild, frei- Technik/Präsident; der Ausschuss nur für Anteile seiner
//   geben              STWEG. Anteile ohne STWEG nur Technik/Präsident. Wer den
//                      Anteil selbst reserviert/erfasst hat, sieht seine Angaben.
//   STWEG zuordnen     Technik/Präsident (je Parzelle).
//   KI-Auslese         schickt den Auszug an einen externen Dienst (OpenRouter);
//                      nur auf Knopfdruck mit Bestätigung (bestaetigt_extern),
//                      nie per Zugangstoken/MCP – wie die KI-Prüfung der Vollmachten.
const { STWEG_GROUPS, isTechnik, isPraesident, getAusschussStwegs, isAusschussForAny } = require('./groups');

const tp = (g) => isTechnik(g) || isPraesident(g);
const ohne = (s) => s === null || s === undefined || s === '';
const lower = (g) => (g || []).map(x => String(x).toLowerCase());

/** Eigentümer irgendeiner STWEG (STWEG-Gruppe oder übergeordnete Gruppe „eigentuemer“). */
function istEigentuemer(groups) {
  return lower(groups).some(x => x === 'eigentuemer' || x.endsWith('-eigentuemer'));
}
function eigentuemerVon(groups, stweg) {
  const m = STWEG_GROUPS[Number(stweg)];
  return !!m?.eigentuemer && lower(groups).includes(m.eigentuemer.toLowerCase());
}

/** Darf das Konto überhaupt erfassen (Seite, Knopf „Erfassen“)? */
function gbErfassenDarf(groups) {
  const g = groups || [];
  return tp(g) || isAusschussForAny(g) || istEigentuemer(g);
}

/** Darf einen Anteil der STWEG stweg reservieren, erfassen, auslesen lassen? */
function gbAnteilErfassen(groups, stweg) {
  const g = groups || [];
  if (tp(g)) return true;
  if (ohne(stweg)) return gbErfassenDarf(g);
  return getAusschussStwegs(g).has(Number(stweg)) || eigentuemerVon(g, stweg);
}

/** Sieht Namen, Adressen, Bild aller Anteile dieser STWEG und darf freigeben? */
function gbVollSicht(groups, stweg) {
  const g = groups || [];
  if (tp(g)) return true;
  return !ohne(stweg) && getAusschussStwegs(g).has(Number(stweg));
}

/** Was die Seite anbieten soll. */
function gbRechte(groups) {
  const g = groups || [];
  return {
    erfassen: gbErfassenDarf(g),
    alle: tp(g),
    ausschuss: [...getAusschussStwegs(g)].sort((a, b) => a - b),
    stweg_zuordnen: tp(g),
  };
}

/** Kommt der Aufruf per Zugangstoken oder MCP (dann keine KI-Auslese)? */
function gbMaschinenKanal(req) {
  return !!req.pat || String(req.headers?.['x-rosenweg-kanal'] || '').toLowerCase() === 'mcp';
}

module.exports = { istEigentuemer, eigentuemerVon, gbErfassenDarf, gbAnteilErfassen, gbVollSicht, gbRechte, gbMaschinenKanal };
