// Personen (personen.html, /api/personen…): wer ändert, wer sieht welches Feld,
// und was beim Zusammenführen umgehängt wird (Klärung Welle 3.2, Entscheid
// Stefan 28.11.2026).
//
//   ändern/zusammenführen  Technik/Präsident alle; Ausschuss UND Verwaltung
//                          (stwegN-verwaltung) Personen mit Wohnung in ihrer
//                          STWEG, mit denselben Schutzregeln (keine Person mit
//                          eigenem Konto oder mit Wohnung in einer fremden STWEG;
//                          personGeschuetztFuer in server.js).
//   Geburtsdatum           nur Technik/Präsident (Zweck im Portal: keiner).
//   Notiz                  nur Ausschuss und Technik/Präsident (nicht die
//                          Verwaltung: Freitext kann Heikles enthalten).
// Wer ein Feld nicht sieht, überschreibt es auch nicht (die Werte im Body
// werden verworfen, wie verborgene Telefonnummern).
const { isTechnik, isPraesident, getAusschussStwegs, isAusschussForAny, verwaltungStwegs } = require('./groups');

const tp = (g) => isTechnik(g || []) || isPraesident(g || []);

/** STWEG-Nummern, in denen das Konto Personen ändern darf (ohne T/P: die nimmt userCanEditPerson vorweg). */
function personenSchreibStwegs(groups) {
  const g = groups || [];
  return new Set([...getAusschussStwegs(g), ...verwaltungStwegs(g)]);
}

const darfGeburtsdatum = (groups) => tp(groups);
const darfNotiz = (groups) => tp(groups) || isAusschussForAny(groups || []);

/** Welche Felder das Konto bei Personen sieht (für die Seite). */
function personenFelder(groups) {
  return { geburtsdatum: darfGeburtsdatum(groups), notiz: darfNotiz(groups) };
}

/** Person für die Ausgabe: verborgene Felder entfernen. */
function personFuerLeser(groups, p) {
  if (!p || typeof p !== 'object') return p;
  const f = personenFelder(groups);
  const out = { ...p };
  if (!f.geburtsdatum) delete out.geburtsdatum;
  if (!f.notiz) delete out.notiz;
  return out;
}

/** Body ohne die Felder, die das Konto nicht sieht (sonst würde es sie leeren). */
function personBodyFiltern(groups, b) {
  const f = personenFelder(groups);
  const out = { ...(b || {}) };
  if (!f.geburtsdatum) delete out.geburtsdatum;
  if (!f.notiz) delete out.notiz;
  return out;
}

// Alle Verweise auf personen(id). Beim Zusammenführen wandern sie auf die
// bleibende Person, statt durch das Löschen (ON DELETE SET NULL) verloren zu
// gehen. Neue Tabelle mit REFERENCES personen -> hier eintragen (der Test
// test/personen-rechte.test.js vergleicht die Liste mit dem Schema in server.js).
const PERSONEN_VERWEISE = [
  ['wohnungen_kontakte', 'person_id'],
  ['pbx_ring_members', 'person_id'],
  ['whatsapp_messages', 'person_id'],
  ['reklamationen', 'person_id'],
  ['vollmachten', 'vollmachtgeber_person_id'],
  ['vollmachten', 'bevollmaechtigter_person_id'],
  ['vollmachten_vollmachtgeber', 'person_id'],
];

/** Alle Verweise von mergeId auf keepId umhängen. -> { 'tabelle.spalte': anzahl } */
async function verweiseUmhaengen(client, keepId, mergeId) {
  const zahl = {};
  for (const [tabelle, spalte] of PERSONEN_VERWEISE) {
    // Tabelle fehlt (Teilinstallation)? Dann nichts umzuhängen.
    const da = await client.query('SELECT to_regclass($1) AS t', [`public.${tabelle}`]);
    if (!da.rows[0]?.t) continue;
    const r = await client.query(`UPDATE ${tabelle} SET ${spalte} = $1 WHERE ${spalte} = $2`, [keepId, mergeId]);
    zahl[`${tabelle}.${spalte}`] = r.rowCount || 0;
  }
  return zahl;
}

/** Geänderte Felder (Namen, keine Werte) für das Protokoll. */
function geaenderteFelder(alt, neu, felder) {
  const norm = (v) => (v === undefined || v === null ? ''
    : v instanceof Date ? v.toISOString().slice(0, 10)
    : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (felder || []).filter(f => neu && neu[f] !== undefined && norm(alt?.[f]) !== norm(neu[f]));
}

module.exports = {
  personenSchreibStwegs, darfGeburtsdatum, darfNotiz, personenFelder, personFuerLeser,
  personBodyFiltern, PERSONEN_VERWEISE, verweiseUmhaengen, geaenderteFelder,
};
