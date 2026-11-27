// Katalog der Windows-Programme (AppLocker): was die Richtlinie
// "Rosenweg-Look Windows" selbst verteilt, muss auf jedem Rechner erlaubt
// sein - auch mit einer Vorgabe, die vor diesen Programmen gespeichert wurde.
const test = require('node:test');
const assert = require('node:assert');
const w = require('../lib/windowsprogramme');

for (const id of ['irfanview', 'vlc']) {
  test(`${id} ist Pflicht und steckt in jeder Liste`, () => {
    const p = w.KATALOG.find((x) => x.id === id);
    assert.ok(p && p.pflicht, `${id} fehlt oder ist nicht Pflicht`);
    // alte gespeicherte Vorgabe ohne das Programm, Rechner ohne Zusatz
    const r = w.fuerRechner({ programme: ['chrome'], freigaben: '', modus: 'durchsetzen' }, {});
    assert.ok(r.programme.some((x) => x.id === id), `${id} fehlt in der Liste des Rechners`);
  });
}

test('Pfadregeln fuer IrfanView und VLC liegen unter Programme', () => {
  const regeln = w.KATALOG.filter((x) => ['irfanview', 'vlc'].includes(x.id)).flatMap((x) => x.regeln);
  assert.deepStrictEqual(regeln.map((r) => r.pfad).sort(),
    ['%PROGRAMFILES%\\IrfanView\\*', '%PROGRAMFILES%\\VideoLAN\\*']);
});

test('Ids im Katalog sind eindeutig', () => {
  const ids = w.KATALOG.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('alte Zusaetze mit vlc bleiben gueltig', () => {
  assert.deepStrictEqual(w.rechnerPruefen({ zusatz: ['vlc'] }), {});
});

test('pGina ist nicht mehr freigegeben', () => {
  const alles = JSON.stringify(w.KATALOG).toLowerCase();
  assert.ok(!alles.includes('pgina'), 'pGina steht noch im Katalog');
});
