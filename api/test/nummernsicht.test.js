// node --test api/test/nummernsicht.test.js — wer sieht echte Telefonnummern (lib/nummernsicht.js)
// Nur erfundene Beispiele.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  darfEchteNummernSehen, nummernKanal, nummernAusgeben, nummernAusBodyEntfernen, interneNummerFinden,
  gleichePerson, istAnlagennummer, interneNummernPruefen, nummernSichtAus, interneNummernLaden,
  interneNummernCacheLeeren,
} = require('../lib/nummernsicht');

const technik = { email: 'tech@example.org', groups: ['technik'] };
const praesident = { email: 'p@example.org', groups: ['Präsident'] };
const bewohner9 = { email: 'ich@example.org', groups: ['r9-bewohner'] };        // STWEG 3 (Haus 9)
const ausschuss5 = { email: 'aus5@example.org', groups: ['stweg5-ausschuss', 'stweg5-eigentuemer'] };
const ohneHaus = { email: 'gast@example.org', groups: [] };

const nachbar9 = { email: 'nachbar@example.org', name: 'Nora Nachbar', stweg: 3 };
const fremd5 = { email: 'fremd@example.org', name: 'Franz Fremd', stweg: 5 };

test('Technik und Praesident sehen alles, auf jedem Weg', () => {
  for (const u of [technik, praesident]) {
    assert.equal(darfEchteNummernSehen(u, fremd5, { kanal: 'verzeichnis' }), true);
    assert.equal(darfEchteNummernSehen(u, {}, { kanal: 'portal' }), true);
  }
});

test('die Person selbst sieht ihre Nummern immer (E-Mail, Gross/klein egal)', () => {
  assert.equal(darfEchteNummernSehen(bewohner9, { email: 'ICH@example.org', stweg: 5 }, { kanal: 'verzeichnis' }), true);
  assert.equal(darfEchteNummernSehen(bewohner9, { emails: ['x@example.org', 'ich@example.org'] }), true);
});

test('Portal: eigenes Haus ja, fremdes Haus nein', () => {
  assert.equal(darfEchteNummernSehen(bewohner9, nachbar9, { kanal: 'portal' }), true);
  assert.equal(darfEchteNummernSehen(bewohner9, fremd5, { kanal: 'portal' }), false);
  assert.equal(darfEchteNummernSehen(ausschuss5, fremd5, { kanal: 'portal' }), true);
  assert.equal(darfEchteNummernSehen(ausschuss5, nachbar9, { kanal: 'portal' }), false);
  assert.equal(darfEchteNummernSehen(ausschuss5, { stwegs: [3, 5] }, { kanal: 'portal' }), true);
});

test('ohne Haus oder ohne Angabe zum Haus: nein', () => {
  assert.equal(darfEchteNummernSehen(ohneHaus, nachbar9, { kanal: 'portal' }), false);
  assert.equal(darfEchteNummernSehen(bewohner9, { email: 'x@example.org' }, { kanal: 'portal' }), false);
  assert.equal(darfEchteNummernSehen(null, nachbar9, { kanal: 'portal' }), false);
});

test('Verzeichnisse (MCP, geteilte Telefone): auch das eigene Haus nur intern; Vorgabe ist streng', () => {
  assert.equal(darfEchteNummernSehen(bewohner9, nachbar9, { kanal: 'verzeichnis' }), false);
  assert.equal(darfEchteNummernSehen(bewohner9, nachbar9), false);
});

test('Kanal: nur Browser-Anmeldung und eigene Apps sind Portal; Kopf kann nur einschraenken', () => {
  assert.equal(nummernKanal({ user: { auth_source: 'authentik' }, headers: {} }), 'portal');
  assert.equal(nummernKanal({ user: { auth_source: 'authentik', auth_client: 'rosenweg-apps' }, headers: {} }), 'portal');
  assert.equal(nummernKanal({ user: {}, pat: { id: 1 }, headers: {} }), 'verzeichnis');
  assert.equal(nummernKanal({ user: {}, anlage: { ext: '2101' }, headers: {} }), 'verzeichnis');
  assert.equal(nummernKanal({ user: {}, appKarte: { id: 1 }, headers: {} }), 'verzeichnis');
  assert.equal(nummernKanal({ user: {}, headers: { 'x-rosenweg-kanal': 'mcp' } }), 'verzeichnis');
  assert.equal(nummernKanal(null), 'verzeichnis');
});

test('Ausgabe ohne Recht: echte Felder leer, interne Nummer dazu, telefon bekommt sie NICHT', () => {
  const p = { name: 'Franz Fremd', telefon: '+41 79 000 00 00', mobile: '', telefone: [{ nummer: '+41 61 000 00 00' }] };
  const a = nummernAusgeben(p, { sichtbar: false, intern: '305011' });
  assert.equal(a.telefon, null);
  assert.equal(a.mobile, null);
  assert.deepEqual(a.telefone, []);
  assert.equal(a.interne_nummer, '305011');
  assert.equal(a.nummern_verborgen, true);
  assert.equal(p.telefon, '+41 79 000 00 00', 'Original bleibt unveraendert');
  const b = nummernAusgeben(p, { sichtbar: true, intern: '305011' });
  assert.equal(b.telefon, '+41 79 000 00 00');
  assert.equal(b.nummern_verborgen, undefined);
  assert.equal(nummernAusgeben({ name: 'X' }, { sichtbar: false }).nummern_verborgen, undefined);
});

test('Wohnungsfelder eigentuemer_/mieter_telefon werden auch geleert', () => {
  const a = nummernAusgeben({ eigentuemer_telefon: '061 000 00 00', mieter_telefon: '079 000 00 00' }, { sichtbar: false });
  assert.equal(a.eigentuemer_telefon, null);
  assert.equal(a.mieter_telefon, null);
});

test('Schreibschutz: Nummernfelder fallen aus dem Body', () => {
  const b = nummernAusBodyEntfernen({ name: 'N', telefon: '', mobile: null, telefone: [], notiz: 'x' });
  assert.deepEqual(b, { name: 'N', notiz: 'x' });
});

test('interne Nummer: E-Mail und Name muessen passen (Paare teilen E-Mails)', () => {
  const liste = [
    { nummer: '309011', email: 'familie@example.org', name: 'Anna Beispiel' },
    { nummer: '309012', email: 'familie@example.org', name: 'Bruno Beispiel' },
  ];
  assert.equal(interneNummerFinden(liste, { email: 'Familie@example.org', name: 'Beispiel Bruno' }), '309012');
  assert.equal(interneNummerFinden(liste, { email: 'familie@example.org', name: 'Anna Maria Beispiel' }), '309011');
  assert.equal(interneNummerFinden(liste, { email: 'familie@example.org', name: 'Carla Fremd' }), null);
  assert.equal(interneNummerFinden(liste, { name: 'Anna Beispiel' }), null);
});

test('gleichePerson wie die Anlage', () => {
  assert.equal(gleichePerson('Anna Beispiel', 'Beispiel Anna'), true);
  assert.equal(gleichePerson('Anna Beispiel AG', 'Anna Beispiel'), false);
  assert.equal(gleichePerson('Anna', 'Anna'), true);
  assert.equal(gleichePerson('Anna', 'Anna Beispiel'), false);
});

test('Anlagennummern: Nebenstellen und 3HHWWP ja, echte Nummern nein', () => {
  for (const n of ['2000', '2101', '4001', '309011', '30 90 11']) assert.equal(istAnlagennummer(n), true, n);
  for (const n of ['+41790000000', '0610000000', '', null]) assert.equal(istAnlagennummer(n), false, String(n));
});

test('Eingang von der Anlage: nur gueltige 3HHWWP, keine Doppelten', () => {
  const r = interneNummernPruefen([
    { nummer: '309011', email: 'A@example.org', name: 'Anna Beispiel', wohnung: 'RW9-01', haus: 9, aktiv: 1 },
    { nummer: '309011', email: 'b@example.org', name: 'Doppelt' },
    { nummer: '+41790000000', email: 'c@example.org', name: 'Echt' },
    { nummer: '309013', email: '', name: 'Ohne Mail' },
    { nummer: '309014', email: 'd@example.org', name: 'Inaktiv', aktiv: 0 },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.nummern.map(n => n.nummer), ['309011', '309014']);
  assert.equal(r.nummern[0].email, 'a@example.org');
  assert.equal(r.nummern[1].aktiv, false);
  assert.equal(interneNummernPruefen('x').ok, false);
});

test('nummernSichtAus: je Zeile entschieden, interne Nummer immer dabei', () => {
  const interne = [{ nummer: '305011', email: 'fremd@example.org', name: 'Franz Fremd' }];
  const sicht = nummernSichtAus(bewohner9, 'portal', interne);
  const fremd = sicht({ name: 'Franz Fremd', email: 'fremd@example.org', telefon: '079 000 00 00' }, fremd5);
  assert.equal(fremd.telefon, null);
  assert.equal(fremd.interne_nummer, '305011');
  const nachbar = sicht({ name: 'Nora Nachbar', email: 'nachbar@example.org', telefon: '061 000 00 00' }, nachbar9);
  assert.equal(nachbar.telefon, '061 000 00 00');
});

test('Laden: fehlende Tabelle ergibt leere Liste statt Fehler', async () => {
  interneNummernCacheLeeren();
  const kaputt = { query: async () => { throw new Error('relation does not exist'); } };
  assert.deepEqual(await interneNummernLaden(kaputt), []);
  interneNummernCacheLeeren();
  const gut = { query: async () => ({ rows: [{ nummer: '309011', email: 'a@example.org', name: 'A B' }] }) };
  assert.equal((await interneNummernLaden(gut)).length, 1);
  interneNummernCacheLeeren();
});
