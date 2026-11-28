// node --test api/test/stweg-datenschutz.test.js — Funde der Klaerung
// „Rosenweg STWEG“ (Entscheid Stefan 28.11.2026): F1 Wohnungsliste, F2
// Kontakte erst ab gueltig_ab, F3 Hinweis „öffentlich“, F9 Editor nach
// Server-Recht, Altroute stweg-content entfernt. Erfundene Konten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const so = require('../lib/stweg-oeffentlich');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('F1: Mitglied der STWEG, ihre Verwaltung, T/P sehen die Wohnungsliste', () => {
  assert.equal(so.stwegMitglied(['r9-bewohner'], 3), true);       // Mieter = Mitglied
  assert.equal(so.stwegMitglied(['r9-eigentuemer'], 3), true);
  assert.equal(so.stwegMitglied(['stweg3-ausschuss'], 3), true);
  assert.equal(so.stwegMitglied(['stweg3-verwaltung'], 3), true);
  assert.equal(so.stwegMitglied(['technik'], 5), true);
  assert.equal(so.stwegMitglied(['Präsident'], 5), true);
  assert.equal(so.stwegMitglied(['r9-eigentuemer'], 5), false);   // fremde STWEG
  assert.equal(so.stwegMitglied(['stweg3-verwaltung'], 5), false);
  assert.equal(so.stwegMitglied([], 3), false);
});

test('F1: öffentlich nur Anzahlen, keine Belegung/Besonderheiten/Wertquote', () => {
  const rows = [
    { bezeichnung: 'W1', typ: 'Wohnung', bewohnt_von: 'mieter', besonderheiten: 'x', wertquote_zaehler: 100 },
    { bezeichnung: 'W2', typ: null, bewohnt_von: 'leer' },
    { bezeichnung: 'H', typ: 'Hobbyraum', bewohnt_von: 'eigentuemer' },
  ];
  const o = so.wohnungenOeffentlich(rows);
  assert.deepEqual(o, { anzahl: { wohnungen: 2, andere: { Hobbyraum: 1 } }, wohnungen: [], eingeschraenkt: true });
  assert.doesNotMatch(JSON.stringify(o), /mieter|leer|besonderheiten|wertquote/);
});

test('server.js: Wohnungsliste mit optionaler Anmeldung, Kontakte erst ab gueltig_ab', () => {
  const src = lies('api/server.js');
  const i = src.indexOf("app.get('/api/stweg/:stweg/wohnungen'");
  const teil = src.slice(i, i + 1100);
  assert.match(teil, /req\.headers\.authorization \? authMiddleware\(req, res, next\) : next\(\)/);
  assert.match(teil, /stwegOeffentlich\.stwegMitglied\(req\.user\.groups \|\| \[\], stweg\)/);
  assert.match(teil, /stwegOeffentlich\.wohnungenOeffentlich\(result\.rows\)/);
  assert.equal(so.KONTAKT_GILT_SQL, '(k.gueltig_ab IS NULL OR k.gueltig_ab <= CURRENT_DATE)');
  const k = src.indexOf('async function stwegKontakteLaden');
  assert.match(src.slice(k, k + 1800), /\$\{stwegOeffentlich\.KONTAKT_GILT_SQL\}/);
  // Zugang zur Kontaktliste bleibt: eigene STWEG (auch Mieter), Verwaltung, T/P
  assert.match(src.slice(k, k + 1200), /isVerwaltungFor\(allUserGroups, nr\)/);
});

test('Altroute stweg-content und alte Abschnitte entfernt, Mitteilungen ersetzen sie', () => {
  const src = lies('api/server.js');
  assert.doesNotMatch(src, /app\.(get|post)\('\/api\/stweg-content/);
  assert.doesNotMatch(src, /app\.(get|post)\('\/api\/stweg-sections/);
  assert.match(src, /app\.use\('\/api\/stweg', stwegApp\.router\)/);
  assert.match(lies('api/routes/stweg-app.js'), /schreibGate[\s\S]*kartenAdmin\.vermerken/);
  assert.doesNotMatch(lies('stweg3/index.html'), /stweg-content|stweg-sections\//);
});

test('STWEG-3-Seite: Wohnungsliste mit Anmeldung, sonst nur Anzahl', () => {
  const html = lies('stweg3/index.html');
  assert.match(html, /if \(data\.eingeschraenkt\)/);
  assert.match(html, /holen\(token\)/);
});
