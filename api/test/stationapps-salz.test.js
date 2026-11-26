// node --test api/test/stationapps-salz.test.js — wer auf den Stationen den
// Starter „Rosenweg Salz“ sieht (lib/stationapps.js, Seite rosenweg-salz)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const salzPfad = require.resolve(path.join(__dirname, '..', 'routes', 'salz.js'));
let antwort = async () => ['technik', 'praesident', 'Hauswart', 'stweg7-bewohner'];
require.cache[salzPfad] = { id: salzPfad, filename: salzPfad, loaded: true, exports: { buchungsGruppen: () => antwort() } };
const { gruppenJeApp } = require('../lib/stationapps');

const salz = async () => (await gruppenJeApp(null, { haus: 9 })).find(a => a.id === 'rosenweg-salz');

test('Salz: Bewohnergruppen aus nav.js', async () => {
  const s = await salz();
  for (const g of ['technik', 'praesident', 'stweg7-bewohner', 'r9-bewohner', 'stweg4-bewohner']) {
    assert.ok(s.gruppen.includes(g), g);
  }
});

test('Salz: Gruppen aus der Datenbank kommen dazu (klein geschrieben)', async () => {
  assert.ok((await salz()).gruppen.includes('hauswart'));
});

test('Salz: Datenbank weg -> nur nav.js, nicht für alle', async () => {
  antwort = async () => { throw new Error('keine Datenbank'); };
  const s = await salz();
  assert.ok(s.gruppen.length > 0);
  assert.ok(!s.gruppen.includes('hauswart'));
});
