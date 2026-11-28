// node --test api/test/stationapps-projekte-dokumente.test.js — Seiten
// „Projekte“ und „Dokumente“ in der Programmliste der Stationen. Auf ihnen
// haengen die Apps Rosenweg Projekte (SEITE=rosenweg-projekte) und Rosenweg
// Unterlagen (SEITE=rosenweg-dokumente).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const salzPfad = require.resolve(path.join(__dirname, '..', 'routes', 'salz.js'));
require.cache[salzPfad] = { id: salzPfad, filename: salzPfad, loaded: true, exports: { buchungsGruppen: async () => [] } };
const { gruppenJeApp } = require('../lib/stationapps');

const finde = async (haus, id) => (await gruppenJeApp(null, { haus })).find(a => a.id === id);

test('Projekte: Kennung, Adresse, nur mit Seitenrecht projekte', async () => {
  const p = await finde(9, 'rosenweg-projekte');
  assert.ok(p, 'rosenweg-projekte fehlt');
  assert.equal(p.url, 'https://www.rosenweg4303.ch/projekte.html');
  assert.equal(p.rechte, 'projekte');
  assert.equal(p.rechte_art, 'seite');
  // ohne Rechtetabelle (pool null): nur, wer ohnehin alles darf – nie fuer alle
  assert.ok(p.gruppen.length > 0);
  assert.ok(!p.gruppen.includes('stweg3-bewohner'));
  assert.ok(await finde(null, 'rosenweg-projekte'), 'auch ohne Haus');
});

test('Dokumente: nur im eigenen Haus, nur Leute dieser STWEG', async () => {
  const d = await finde(9, 'rosenweg-dokumente');
  assert.ok(d, 'rosenweg-dokumente fehlt');
  assert.equal(d.url, 'https://stweg3.rosenweg4303.ch/#dokumente');
  for (const g of ['stweg3-bewohner', 'stweg3-eigentuemer', 'stweg3-ausschuss', 'stweg3-verwaltung', 'technik']) {
    assert.ok(d.gruppen.includes(g), g);
  }
  for (const g of ['stweg1-bewohner', 'stweg1-eigentuemer', 'bewohner', 'eigentuemer']) {
    assert.ok(!d.gruppen.includes(g), g);
  }
  assert.equal(await finde(null, 'rosenweg-dokumente'), undefined, 'ohne Haus keine Dokumente');
});
