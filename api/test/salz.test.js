// node --test api/test/salz.test.js — Reichweite und Meldeentscheid (lib/salz.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { verbrauchProWoche, lagerStand, meldeEntscheid, meldungsText } = require('../lib/salz');

const TAG = 24 * 60 * 60 * 1000;
const jetzt = new Date('2026-11-26T10:00:00Z');
const vor = tage => new Date(jetzt.getTime() - tage * TAG);

test('zu wenig Einfuellungen -> kein Verbrauch', () => {
  const v = verbrauchProWoche([{ am: vor(20), kg: 25 }, { am: vor(5), kg: 25 }], jetzt);
  assert.equal(v.kgProWoche, null);
  assert.equal(v.einfuellungen, 2);
});

test('Einfuellungen zu dicht beieinander -> kein Verbrauch', () => {
  const v = verbrauchProWoche([{ am: vor(3), kg: 25 }, { am: vor(2), kg: 25 }, { am: vor(1), kg: 25 }], jetzt);
  assert.equal(v.kgProWoche, null);
});

test('ein Sack pro Woche = 25 kg/Woche; letzter Sack zaehlt nicht', () => {
  const ein = [0, 7, 14, 21, 28].map(t => ({ am: vor(t), kg: 25 }));
  const v = verbrauchProWoche(ein, jetzt);
  assert.equal(v.einfuellungen, 5);
  assert.ok(Math.abs(v.kgProWoche - 25) < 1e-9);
});

test('Reihenfolge egal, aelter als das Fenster faellt weg', () => {
  const ein = [{ am: vor(400), kg: 1000 }, { am: vor(0), kg: 25 }, { am: vor(28), kg: 25 }, { am: vor(14), kg: 25 }];
  const v = verbrauchProWoche(ein, jetzt);
  assert.equal(v.einfuellungen, 3);
  assert.ok(Math.abs(v.kgProWoche - 12.5) < 1e-9); // 2 Saecke (50 kg) in 4 Wochen
});

test('Reichweite: 4 Saecke a 25 kg bei 25 kg/Woche = 4 Wochen, Schwelle 4 -> nicht knapp', () => {
  const s = lagerStand({ bestandSaecke: 4, bestandKg: 100, kgProWoche: 25, schwelleWochen: 4, mindestSaecke: 2 });
  assert.deepEqual(s, { modus: 'reichweite', reichweiteWochen: 4, knapp: false });
  const k = lagerStand({ bestandSaecke: 3, bestandKg: 75, kgProWoche: 25, schwelleWochen: 4, mindestSaecke: 2 });
  assert.equal(k.knapp, true);
  assert.equal(k.reichweiteWochen, 3);
});

test('ohne Verbrauch: Mindestbestand (<=)', () => {
  assert.equal(lagerStand({ bestandSaecke: 5, bestandKg: 125, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4 }).knapp, false);
  const s = lagerStand({ bestandSaecke: 4, bestandKg: 100, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4 });
  assert.equal(s.modus, 'mindestbestand');
  assert.equal(s.knapp, true);
});

test('leeres Lager ist immer knapp', () => {
  assert.equal(lagerStand({ bestandSaecke: 0, bestandKg: 0, kgProWoche: 1, schwelleWochen: 0, mindestSaecke: 0 }).knapp, true);
});

test('Meldung einmal, Erinnerung nach 7 Tagen, Anlieferung schiebt sie', () => {
  const basis = { knapp: true, wiederholungTage: 7, jetzt };
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: null }), 'melden');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(3), meldungZuletzt: vor(3) }), 'nichts');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(8), meldungZuletzt: vor(8) }), 'erinnern');
  assert.equal(meldeEntscheid({ ...basis, meldungSeit: vor(8), meldungZuletzt: vor(8), letzteAnlieferung: vor(2) }), 'nichts');
  assert.equal(meldeEntscheid({ ...basis, wiederholungTage: 0, meldungSeit: vor(30), meldungZuletzt: vor(30) }), 'nichts');
});

test('wieder genug -> entwarnen, sonst nichts', () => {
  assert.equal(meldeEntscheid({ knapp: false, meldungSeit: vor(1), jetzt }), 'entwarnen');
  assert.equal(meldeEntscheid({ knapp: false, meldungSeit: null, jetzt }), 'nichts');
});

test('Mailtext nennt Lager, Bestand, Reichweite', () => {
  const t = meldungsText({ lager: 'Rosenweg 9', stand: { modus: 'reichweite', reichweiteWochen: 2.5 },
    bestandSaecke: 2, bestandKg: 50, kgProWoche: 20, schwelleWochen: 4, mindestSaecke: 4, erinnerung: false });
  assert.match(t, /Rosenweg 9/);
  assert.match(t, /2 Säcke \(50 kg\)/);
  assert.match(t, /Reicht noch: etwa 2\.5 Wochen/);
});

test('Mailtext nennt den Ort, wenn es einen gibt', () => {
  const t = meldungsText({ lager: 'Rosenweg Kooperation', ort: 'Lager im Rosenweg 10', stand: { modus: 'mindestbestand' },
    bestandSaecke: 1, bestandKg: 25, kgProWoche: null, schwelleWochen: 4, mindestSaecke: 4, erinnerung: false });
  assert.match(t, /Rosenweg Kooperation/);
  assert.match(t, /Ort: Lager im Rosenweg 10/);
  assert.match(t, /1 Säcke|1 Sack/);
});

test('Reichweite unter einer Woche heisst nicht "0 Wochen"', () => {
  const { reichtText } = require('../lib/salz');
  assert.equal(reichtText(0.3), 'weniger als 1 Woche');
  assert.equal(reichtText(1), 'etwa 1 Woche');
  assert.equal(reichtText(3.5), 'etwa 3.5 Wochen');
});
