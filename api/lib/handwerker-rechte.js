// Handwerker & Lieferanten: wer sieht und ändert was, je STWEG
// (Befund F1/F5/L1 der Klärung Welle 3, Entscheid Stefan 28.11.2026).
//
// Das Seitenrecht „handwerker“ (read/write) bleibt die erste Hürde
// (requirePermission). Danach bindet diese Datei jeden Eintrag an eine STWEG:
//
//   Technik/Präsident  alles, auch Einträge „alle STWEG“ (stweg NULL),
//                      Event-Typen anlegen/ändern/löschen, Firma hart löschen.
//   Verwaltung STWEG N lesen und schreiben: Verträge, Einsätze (mit Kosten),
//                      Notfall-Zuordnungen mit stweg = N; Firmen anlegen (die
//                      neue Firma gehört dann zu STWEG N) und Firmen mit
//                      stweg = N ändern/archivieren. Einträge „alle STWEG“ und
//                      Firmen des gemeinsamen Stamms (stweg NULL) nur lesen.
//   Ausschuss STWEG N  nur lesen, im selben Umfang (STWEG N und „alle“).
//   andere mit Recht   nur Einträge „alle STWEG“ lesen, nichts schreiben.
//
// Die Spalte handwerker.stweg (NULL = gemeinsamer Stamm, wie bisher alle
// Firmen) legt initDB an; bestehende Firmen bleiben gemeinsam.
// Telefonbuch (lib/telefonbuch.js) und Handynummern bleiben unverändert.
const { isTechnik, isPraesident, getAusschussStwegs, verwaltungStwegs } = require('./groups');

const ohne = (s) => s === null || s === undefined || s === '';
const nr = (s) => (ohne(s) ? null : Number(s));

/** { alle, lesen:Set, schreiben:Set } eines Kontos (aufgelöste Gruppen). */
function handwerkerSicht(groups) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { alle: true, lesen: new Set(), schreiben: new Set() };
  const schreiben = verwaltungStwegs(g);
  const lesen = new Set([...schreiben, ...getAusschussStwegs(g)]);
  return { alle: false, lesen, schreiben };
}

/** Darf einen Eintrag (Firma, Vertrag, Einsatz, Zuordnung) der STWEG stweg sehen? */
function hwLesen(sicht, stweg) {
  if (sicht.alle) return true;
  const n = nr(stweg);
  return n === null || sicht.lesen.has(n);
}

/** Darf einen Eintrag der STWEG stweg anlegen/ändern/löschen? „alle STWEG“ nur T/P. */
function hwSchreiben(sicht, stweg) {
  if (sicht.alle) return true;
  const n = nr(stweg);
  return n !== null && sicht.schreiben.has(n);
}

const hwFirmaAnlegen = (sicht) => sicht.alle || sicht.schreiben.size > 0;
const hwEventTypen = (sicht) => sicht.alle;

/** STWEG einer neuen Firma: T/P frei (leer = gemeinsam); Verwaltung eine ihrer STWEG. */
function hwNeueFirmaStweg(sicht, gewuenscht) {
  const n = nr(gewuenscht);
  if (sicht.alle) return { stweg: Number.isInteger(n) && n >= 1 && n <= 8 ? n : null };
  if (n !== null) {
    return sicht.schreiben.has(n) ? { stweg: n } : { fehler: 'Firmen nur für die eigene STWEG anlegen' };
  }
  if (sicht.schreiben.size === 1) return { stweg: [...sicht.schreiben][0] };
  return { fehler: 'Bitte die STWEG angeben, für die die Firma angelegt wird' };
}

/** SQL-Bedingung „sichtbar“ für eine Spalte (stweg NULL = alle STWEG). */
function hwSichtSql(sicht, spalte, params) {
  if (sicht.alle) return 'TRUE';
  params.push([...sicht.lesen]);
  return `(${spalte} IS NULL OR ${spalte} = ANY($${params.length}::int[]))`;
}

/** Zuordnung aus dem Formular in die gespeicherte Form (oder null). */
function zuweisungNormal(z) {
  if (!z || typeof z !== 'object') return null;
  const eventId = parseInt(z.event_typ_id, 10);
  if (!Number.isFinite(eventId)) return null;
  const prio = parseInt(z.prioritaet, 10);
  const s = ohne(z.stweg) ? null : parseInt(z.stweg, 10);
  const hinweis = z.hinweis == null ? null : (String(z.hinweis).trim() || null);
  return {
    event_typ_id: eventId,
    prioritaet: Number.isFinite(prio) && prio >= 1 ? prio : 1,
    stweg: Number.isFinite(s) && s >= 1 && s <= 8 ? s : null,
    hinweis,
  };
}
const zKey = (z) => `${z.event_typ_id}|${z.prioritaet}|${z.stweg ?? ''}|${z.hinweis ?? ''}`;

/**
 * Notfall-Zuordnungen einer Firma speichern, ohne fremde STWEG anzutasten.
 * bestehende: Zeilen aus der Datenbank; eingehende: Liste aus dem Formular
 * (die Seite schickt, was sie sieht). Ergebnis { liste } = alles, was danach
 * gespeichert sein soll, oder { fehler }.
 *   - unsichtbare Zuordnungen (fremde STWEG) bleiben stehen
 *   - sichtbare, aber nicht schreibbare (alle STWEG) müssen unverändert kommen
 *   - schreibbare (eigene STWEG) ersetzt das Formular
 */
function zuweisungenZusammenfuehren(sicht, bestehende, eingehende) {
  const neu = (Array.isArray(eingehende) ? eingehende : []).map(zuweisungNormal).filter(Boolean);
  if (sicht.alle) return { liste: neu };
  const alt = (bestehende || []).map(zuweisungNormal).filter(Boolean);
  const bleiben = alt.filter(z => !hwLesen(sicht, z.stweg));
  const festAlt = alt.filter(z => hwLesen(sicht, z.stweg) && !hwSchreiben(sicht, z.stweg));
  const festNeu = neu.filter(z => !hwSchreiben(sicht, z.stweg));
  const zaehle = (l) => l.reduce((m, z) => m.set(zKey(z), (m.get(zKey(z)) || 0) + 1), new Map());
  const a = zaehle(festAlt), b = zaehle(festNeu);
  const gleich = a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);
  if (!gleich) {
    return { fehler: 'Zuordnungen für alle STWEG oder eine andere STWEG ändern nur Technik und Präsident' };
  }
  return { liste: [...bleiben, ...festAlt, ...neu.filter(z => hwSchreiben(sicht, z.stweg))] };
}

/** Was die Seite anbieten soll (der Server prüft trotzdem jede Aktion). */
function hwRechte(sicht) {
  return {
    alle: sicht.alle,
    lesen: sicht.alle ? null : [...sicht.lesen].sort((x, y) => x - y),
    schreiben: sicht.alle ? null : [...sicht.schreiben].sort((x, y) => x - y),
    firma_anlegen: hwFirmaAnlegen(sicht),
    event_typen: hwEventTypen(sicht),
    hart_loeschen: sicht.alle,
  };
}

module.exports = {
  handwerkerSicht, hwLesen, hwSchreiben, hwFirmaAnlegen, hwEventTypen, hwNeueFirmaStweg,
  hwSichtSql, zuweisungNormal, zuweisungenZusammenfuehren, hwRechte,
};
