// node --test api/test/handwerker-notfall.test.js — Notfall-Ansicht für Bewohner
// (Klärung Welle 3.3, E3/E4; Entscheid Stefan 28.11.2026): nur Firmenname,
// Priorität und Notfallnummer der Zuordnung, STWEG aus dem Konto.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nf = require('../lib/handwerker-notfall');
const hw = require('../lib/handwerker-rechte');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const events = [
  { id: 1, name: 'Wasserschaden', icon: '💧', beschreibung: 'Rohrbruch' },
  { id: 2, name: 'Stromausfall', icon: '⚡', beschreibung: null },
  { id: 3, name: 'Liftstörung', icon: '🛗', beschreibung: null },
];
const zuw = [
  { event_typ_id: 1, firma: 'Sanitär Muster AG', prioritaet: 2, stweg: 3, notfall_telefon: '061 000 00 02' },
  { event_typ_id: 1, firma: 'Rohr Reserve GmbH', prioritaet: 1, stweg: null, notfall_telefon: '+41 61 000 00 01' },
  { event_typ_id: 1, firma: 'Fremde STWEG AG', prioritaet: 1, stweg: 5, notfall_telefon: '061 000 00 05' },
  { event_typ_id: 2, firma: 'Elektro ohne Nummer', prioritaet: 1, stweg: 3, notfall_telefon: null },
  { event_typ_id: 2, firma: 'Elektro Ungültig', prioritaet: 1, stweg: 3, notfall_telefon: 'rufen Sie Herrn Muster an' },
];

test('Sicht: Bewohner, Eigentümer, Ausschuss, Verwaltung sehen ihre STWEG; T/P alle', () => {
  assert.deepEqual([...nf.notfallSicht(['r9-bewohner']).stwegs], [3]);
  assert.deepEqual([...nf.notfallSicht(['stweg5-eigentuemer']).stwegs], [5]);
  assert.deepEqual([...nf.notfallSicht(['stweg3-ausschuss']).stwegs], [3]);
  assert.ok(nf.notfallSicht(['stweg3-verwaltung']).stwegs.has(3));
  assert.equal(nf.notfallSicht(['technik']).alle, true);
  assert.equal(nf.notfallSicht(['Präsident']).alle, true);
  const ohne = nf.notfallSicht([]);
  assert.equal(ohne.alle, false);
  assert.equal(ohne.stwegs.size, 0);
});

test('Antwort: eigene STWEG und „alle“, nach Priorität, nur mit gültiger Nummer', () => {
  const a = nf.notfallAntwort(nf.notfallSicht(['r9-bewohner']), events, zuw);
  assert.deepEqual(a.stwegs, [3]);
  const wasser = a.arten.find(x => x.id === 1);
  assert.deepEqual(wasser.firmen.map(f => f.firma), ['Rohr Reserve GmbH', 'Sanitär Muster AG'], 'Priorität 1 zuerst, STWEG 5 fehlt');
  assert.equal(wasser.firmen[0].notfall_telefon, '+41 61 000 00 01');
  assert.deepEqual(a.arten.find(x => x.id === 2).firmen, [], 'ohne/ungültige Nummer: nichts anzeigen');
  assert.deepEqual(a.arten.find(x => x.id === 3).firmen, []);
  assert.equal(a.arten.length, 3, 'jede Notfall-Art bleibt, auch leer');
});

test('Antwort enthält nur Firma, Priorität, Notfallnummer (keine Handys, Hinweise, Notizen)', () => {
  const zeile = { ...zuw[0], hinweis: 'Frau Muster privat', h_mobile: '079 111 22 33', notiz: 'teuer', personen: [{ mobile: '079' }], bewertung: 2 };
  const a = nf.notfallAntwort(nf.notfallSicht(['r9-bewohner']), events, [zeile]);
  const f = a.arten[0].firmen[0];
  assert.deepEqual(Object.keys(f).sort(), ['firma', 'notfall_telefon', 'prioritaet']);
  const text = JSON.stringify(a);
  for (const verboten of ['079', 'Frau Muster', 'teuer', 'bewertung', 'personen', 'hinweis']) assert.ok(!text.includes(verboten), verboten);
  assert.deepEqual(Object.keys(a).sort(), ['arten', 'stand', 'stwegs']);
});

test('?stweg= engt nur ein und nie auf eine fremde STWEG aus', () => {
  const bewohner = nf.notfallSicht(['r9-bewohner']);
  const fremd = nf.notfallAntwort(bewohner, events, zuw, { wunsch: 5 });
  assert.deepEqual(fremd.arten.find(x => x.id === 1).firmen, [], 'STWEG 5 gehört nicht zum Konto');
  const eigene = nf.notfallAntwort(bewohner, events, zuw, { wunsch: 3 });
  assert.equal(eigene.arten.find(x => x.id === 1).firmen.length, 2);
  const tp = nf.notfallAntwort(nf.notfallSicht(['technik']), events, zuw, { wunsch: 5 });
  assert.deepEqual(tp.arten.find(x => x.id === 1).firmen.map(f => f.firma), ['Fremde STWEG AG', 'Rohr Reserve GmbH']);
  assert.equal(nf.notfallAntwort(nf.notfallSicht(['technik']), events, zuw).stwegs, null);
});

test('Ohne STWEG-Gruppe nur Einträge „alle STWEG“', () => {
  const a = nf.notfallAntwort(nf.notfallSicht([]), events, zuw);
  assert.deepEqual(a.arten.find(x => x.id === 1).firmen.map(f => f.firma), ['Rohr Reserve GmbH']);
});

test('Notfallnummer: nur Rufnummern, höchstens 30 Zeichen', () => {
  assert.equal(nf.notfallNummer(' 061  000 00 01 '), '061 000 00 01');
  assert.equal(nf.notfallNummer('+41 (0)61 000 00 01'), '+41 (0)61 000 00 01');
  assert.equal(nf.notfallNummer('117'), '117');
  assert.equal(nf.notfallNummer(''), null);
  assert.equal(nf.notfallNummer(null), null);
  assert.equal(nf.notfallNummer('abc'), null);
  assert.equal(nf.notfallNummer('061 000; DROP TABLE'), null);
  assert.equal(nf.notfallNummer('0'.repeat(31)), null);
});

test('Zuordnung speichert die Notfallnummer; sie zählt bei „feste Zuordnungen“ mit', () => {
  const z = hw.zuweisungNormal({ event_typ_id: 1, prioritaet: 1, stweg: 3, notfall_telefon: '061 000 00 01' });
  assert.equal(z.notfall_telefon, '061 000 00 01');
  assert.equal(hw.zuweisungNormal({ event_typ_id: 1, notfall_telefon: 'x' }).notfall_telefon, null);
  const verw3 = hw.handwerkerSicht(['stweg3-verwaltung']);
  const bestehend = [{ event_typ_id: 1, prioritaet: 1, stweg: null, hinweis: null, notfall_telefon: '061 000 00 01' }];
  // „alle STWEG“ unverändert: ok; Nummer geändert: Fehler (nur T/P)
  assert.ok(hw.zuweisungenZusammenfuehren(verw3, bestehend, bestehend).liste);
  const geaendert = [{ ...bestehend[0], notfall_telefon: '061 999 99 99' }];
  assert.ok(hw.zuweisungenZusammenfuehren(verw3, bestehend, geaendert).fehler);
  // eigene STWEG: Verwaltung darf die Nummer setzen
  const eigene = [{ event_typ_id: 1, prioritaet: 1, stweg: 3, notfall_telefon: '061 000 00 03' }];
  assert.equal(hw.zuweisungenZusammenfuehren(verw3, [], eigene).liste[0].notfall_telefon, '061 000 00 03');
});

test('Route und Schema im Server', () => {
  assert.match(server, /app\.get\('\/api\/handwerker-notfall\/bewohner', authMiddleware, async/, 'ohne Seitenrecht, nur angemeldet');
  assert.doesNotMatch(server, /app\.get\('\/api\/handwerker-notfall\/bewohner', authMiddleware, requirePermission/);
  assert.match(server, /ALTER TABLE handwerker_event_zuweisungen ADD COLUMN IF NOT EXISTS notfall_telefon VARCHAR\(30\)/);
  assert.match(server, /INSERT INTO handwerker_event_zuweisungen \(event_typ_id, handwerker_id, prioritaet, stweg, hinweis, notfall_telefon\)/);
  const route = server.slice(server.indexOf("'/api/handwerker-notfall/bewohner'"), server.indexOf('// Archivieren: wer die Firma ändern darf.'));
  assert.doesNotMatch(route, /handwerker_personen|h\.mobile|h\.telefon|h\.email|bewertung|notiz|hinweis/, 'Route liest nur die schmalen Felder');
  assert.match(route, /no-store/);
});
