// node --test api/test/zev-sicht.test.js — Z3: Wer sieht welche ZEV-Rechnung
// („Meine ZEV-Rechnungen“, PDF, bezahlt)? Schalter „Eigentümer sieht auch die
// Online-Rechnungen vermieteter Wohnungen“ aus: nur die bewohnende Partei;
// an: zusätzlich die Eigentümerin. Erfundene Daten (@beispiel.ch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zevDarfRechnungSehen, zevBewohnendePartei } = require('../lib/zev');

const W = 11;
const EIG = 'eigentuemerin@beispiel.ch';
const MIE = 'mieter@beispiel.ch';
const PARTNER = 'partner@beispiel.ch';
const VORMIETER = 'vormieter@beispiel.ch';
const VERW = 'verwalter@beispiel.ch';

const vermietet = [
  { wohnung_id: W, rolle: 'eigentuemer', email: EIG },
  { wohnung_id: W, rolle: 'mieter', email: MIE },
  { wohnung_id: W, rolle: 'bewohner', email: PARTNER },
  { wohnung_id: W, rolle: 'verwalter', email: VERW },
];
const selbstBewohnt = [
  { wohnung_id: W, rolle: 'eigentuemer', email: EIG },
  { wohnung_id: W, rolle: 'bewohner', email: PARTNER },
];
const rechnungMieter = { wohnung_id: W, bewohner_email: MIE };
const sieht = (email, rechnung, kontakte, schalter) =>
  zevDarfRechnungSehen({ email, rechnung, kontakte, zevAktiv: true, eigentuemerSiehtMieter: schalter });

test('Partei: mit Mieter = Mieter + Bewohner, sonst Bewohner + Eigentümer', () => {
  assert.deepEqual([...zevBewohnendePartei(vermietet)].sort(), ['bewohner', 'mieter']);
  assert.deepEqual([...zevBewohnendePartei(selbstBewohnt)].sort(), ['bewohner', 'eigentuemer']);
});

test('Schalter aus: Eigentümerin sieht die Rechnung der Mieterin NICHT', () => {
  assert.equal(sieht(EIG, rechnungMieter, vermietet, false), false);
  assert.equal(sieht(VERW, rechnungMieter, vermietet, false), false);
});

test('Schalter aus: Mietpartei sieht ihre Rechnungen (auch Mitbewohner)', () => {
  assert.equal(sieht(MIE, rechnungMieter, vermietet, false), true);
  assert.equal(sieht(PARTNER, rechnungMieter, vermietet, false), true);
});

test('Schalter an: Eigentümerin sieht die Rechnung der Mieterin, Verwalter weiterhin nicht', () => {
  assert.equal(sieht(EIG, rechnungMieter, vermietet, true), true);
  assert.equal(sieht(MIE, rechnungMieter, vermietet, true), true);
  assert.equal(sieht(VERW, rechnungMieter, vermietet, true), false);
});

test('Selbst bewohnt: Eigentümerin und Mitbewohner sehen die Rechnungen auch bei Schalter aus', () => {
  assert.equal(sieht(EIG, { wohnung_id: W, bewohner_email: PARTNER }, selbstBewohnt, false), true);
  assert.equal(sieht(PARTNER, { wohnung_id: W, bewohner_email: EIG }, selbstBewohnt, false), true);
});

test('Vormieter-Rechnung: nur der Vormieter selbst, nicht die heutige Partei', () => {
  const r = { wohnung_id: W, bewohner_email: VORMIETER };
  assert.equal(sieht(VORMIETER, r, vermietet, false), true); // eigene, auch nach Auszug
  assert.equal(sieht(MIE, r, vermietet, false), false);
  assert.equal(sieht(EIG, r, vermietet, false), false);
});

test('Alte Rechnung der Eigentümerin (vor der Vermietung): Mieter sehen sie nicht', () => {
  const r = { wohnung_id: W, bewohner_email: EIG };
  assert.equal(sieht(MIE, r, vermietet, false), false);
  assert.equal(sieht(EIG, r, vermietet, false), true);
});

test('Fremde und ZEV aus: keine Sicht über die Wohnung', () => {
  assert.equal(sieht('fremd@beispiel.ch', rechnungMieter, vermietet, true), false);
  assert.equal(zevDarfRechnungSehen({ email: PARTNER, rechnung: rechnungMieter, kontakte: vermietet, zevAktiv: false, eigentuemerSiehtMieter: true }), false);
  assert.equal(sieht('', rechnungMieter, vermietet, true), false);
  assert.equal(sieht(MIE.toUpperCase(), rechnungMieter, vermietet, false), true); // Gross/Klein egal
});

test('Server nutzt den Helfer für Liste, PDF und bezahlt (kein Weg am Schalter vorbei)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!src.includes('getZevOwnerWohnungen'), 'alter Eigentümer-Pfad entfernt');
  for (const pfad of ["'/api/zev/meine-rechnungen'", "'/api/zev/rechnung/:id/pdf'", "'/api/zev/rechnung/:id/bezahlt'"]) {
    const i = src.indexOf(pfad);
    assert.ok(i > 0, pfad);
    const block = src.slice(i, src.indexOf('\napp.', i + 10));
    assert.match(block, /zevSichtbareRechnungen\(/, pfad);
  }
});
