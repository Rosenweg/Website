// node --test api/test/stationapps-zutritt.test.js — die Seite „Zutritt“
// (access.rosenweg4303.ch) in der Programmliste der Stationen. Auf ihr hängt
// die App Rosenweg Zutritt (os-stationen, pakete/rosenweg-zutritt,
// SEITE=rosenweg-access): sichtbar nur für Technik und Präsident.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// routes/salz.js braucht die Datenbank; für diese Seite egal.
const salzPfad = require.resolve(path.join(__dirname, '..', 'routes', 'salz.js'));
require.cache[salzPfad] = { id: salzPfad, filename: salzPfad, loaded: true, exports: { buchungsGruppen: async () => [] } };
const { gruppenJeApp } = require('../lib/stationapps');

const zutritt = async (haus) => (await gruppenJeApp(null, { haus })).find(a => a.id === 'rosenweg-access');

test('Zutritt: Kennung rosenweg-access, eigene Adresse', async () => {
  const z = await zutritt(9);
  assert.ok(z, 'rosenweg-access fehlt in der Programmliste');
  assert.equal(z.name, 'Zutritt');
  assert.equal(z.url, 'https://access.rosenweg4303.ch/');
});

test('Zutritt: nur Technik und Präsident', async () => {
  const { gruppen } = await zutritt(9);
  assert.ok(gruppen.includes('technik'));
  assert.ok(gruppen.includes('praesident'));
  for (const g of ['bewohner', 'eigentuemer', 'ausschuss', 'verwaltung', 'r9-bewohner', 'stweg3-bewohner']) {
    assert.ok(!gruppen.includes(g), g);
  }
  assert.deepEqual([...gruppen].sort(), ['praesident', 'präsident', 'technik']);
});

test('Zutritt: auch ohne Haus (Station ohne stations.haus)', async () => {
  assert.ok(await zutritt(null));
});
