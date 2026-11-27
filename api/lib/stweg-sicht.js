// Welche STWEGs sieht ein Konto in Listen mit STWEG-Bezug (Reklamationen,
// Auslagen, Wohnungen …)? Eine Regel fuer Liste, Einzelansicht und Suche.
//
//   alle       Technik/Praesident: alles
//   stwegs     Ausschuss der STWEG oder Hausverwaltung der STWEG (stwegN-verwaltung)
//   ohneStweg  Eintraege ohne STWEG (stweg NULL): Ausschuss irgendeiner STWEG
//              (wie bisher) und eine Verwaltung, die ALLE STWEGs verwaltet.
//              Eine Verwaltung nur fuer STWEG 3 sieht keine STWEG-losen
//              Eintraege – die koennen jede STWEG betreffen.
//
// Die Verwaltung bekommt die STWEGs nur ueber ihre Verwaltungsgruppen, nicht
// mehr ueber eine zusaetzliche Bewohnergruppe (ein Verwalter ist kein Bewohner).
const {
  isTechnik, isPraesident, getAusschussStwegs, isAusschussForAny,
  verwaltungStwegs, verwaltetAlleStwegs,
} = require('./groups');

function stwegSicht(groups, { verwaltung = true } = {}) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { alle: true, stwegs: [], ohneStweg: true, verwaltung: false };
  const s = getAusschussStwegs(g);
  const verw = verwaltung ? verwaltungStwegs(g) : new Set();
  for (const n of verw) s.add(n);
  return {
    alle: false,
    stwegs: [...s].sort((a, b) => a - b),
    ohneStweg: isAusschussForAny(g) || (verwaltung && verwaltetAlleStwegs(g)),
    verwaltung: verw.size > 0,
  };
}

// Darf die Sicht einen Eintrag mit dieser STWEG (null = ohne STWEG) sehen?
function sichtErlaubt(sicht, stweg) {
  if (!sicht) return false;
  if (sicht.alle) return true;
  if (stweg === null || stweg === undefined || stweg === '') return !!sicht.ohneStweg;
  return sicht.stwegs.includes(Number(stweg));
}

// Hat die Sicht ueberhaupt etwas ueber die eigenen Eintraege hinaus?
function sichtLeer(sicht) {
  return !sicht || (!sicht.alle && sicht.stwegs.length === 0 && !sicht.ohneStweg);
}

// SQL-Bedingung fuer die Spalte `spalte`; haengt Parameter an `params` an.
// Liefert 'TRUE', 'FALSE' oder z. B. "(r.stweg = ANY($2::int[]) OR r.stweg IS NULL)".
function sichtSql(sicht, spalte, params) {
  if (!sicht) return 'FALSE';
  if (sicht.alle) return 'TRUE';
  const teile = [];
  if (sicht.stwegs.length) { params.push(sicht.stwegs); teile.push(`${spalte} = ANY($${params.length}::int[])`); }
  if (sicht.ohneStweg) teile.push(`${spalte} IS NULL`);
  return teile.length ? `(${teile.join(' OR ')})` : 'FALSE';
}

module.exports = { stwegSicht, sichtErlaubt, sichtLeer, sichtSql };
