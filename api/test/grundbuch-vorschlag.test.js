// node --test api/test/grundbuch-vorschlag.test.js — Vorschlag Parzelle -> STWEG
// (nur Vorschlag, nur T/P, keine Namen; Entscheid Stefan 28.11.2026). Testdaten erfunden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parzellenVorschlag, haeuserAusAdressen } = require('../lib/grundbuch-vorschlag');

const api = fs.readFileSync(path.join(__dirname, '..', 'routes', 'grundbuch.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'grundbuch.html'), 'utf8');

const wohnungen = [
  ...[120, 95, 80, 80].map(z => ({ stweg: 3, wertquote_zaehler: z, wertquote_nenner: 1000 })),
  ...[200, 150, 90].map(z => ({ stweg: 5, wertquote_zaehler: z, wertquote_nenner: 1000 })),
];

test('Wertquoten und Anzahl ergeben einen sicheren Vorschlag', () => {
  const anteile = [120, 95, 80, 80].map((z, i) => ({ parzelle: 101, sub_id: i + 1, anteil_z: z, anteil_n: 1000 }))
    .concat([200, 150, 90].map((z, i) => ({ parzelle: 202, sub_id: i + 1, anteil_z: z, anteil_n: 1000 })));
  const v = parzellenVorschlag(anteile, wohnungen);
  assert.deepEqual(v.map(x => [x.parzelle, x.vorschlag, x.sicherheit]), [[101, 3, 'hoch'], [202, 5, 'hoch']]);
  assert.equal(v[0].gruende.wertquoten, 4);
  assert.equal(v[0].gruende.anzahl_gleich, true);
});

test('Adressen helfen, Gleichstand ergibt keinen Vorschlag', () => {
  assert.deepEqual(haeuserAusAdressen(['Rosenweg 9, 4303 Kaiseraugst', 'Hauptstrasse 1']), [9]);
  const unklar = parzellenVorschlag([{ parzelle: 7, anteil_z: 1, anteil_n: 1 }], wohnungen);
  assert.equal(unklar[0].vorschlag, null);
  assert.equal(unklar[0].sicherheit, 'unklar');
  const adr = parzellenVorschlag([{ parzelle: 8, anteil_z: null, wohnadressen: ['Rosenweg 9, 4303 Kaiseraugst'] }], wohnungen);
  assert.equal(adr[0].vorschlag, 3);
  assert.equal(adr[0].sicherheit, 'mittel');
});

test('Ausgabe ohne Namen und Adressen; bestehende Zuordnung sichtbar', () => {
  const v = parzellenVorschlag([{ parzelle: 101, anteil_z: 120, anteil_n: 1000, stweg: 3, eigentuemer: ['Muster Max'], wohnadressen: ['Rosenweg 9'] }], wohnungen);
  const text = JSON.stringify(v);
  assert.doesNotMatch(text, /Muster|Rosenweg/);
  assert.equal(v[0].aktuell, 3);
});

test('Route: nur T/P, nur lesen; Seite übernimmt erst nach Bestätigung', () => {
  const r = api.slice(api.indexOf("router.get('/parzellen/vorschlag'"), api.indexOf("router.put('/parzellen/:parzelle/stweg'"));
  assert.match(r, /if \(!istTP\(req\)\) return res\.status\(403\)/);
  assert.doesNotMatch(r, /UPDATE|INSERT|DELETE/);
  assert.match(r, /SELECT stweg, wertquote_zaehler, wertquote_nenner FROM wohnungen/);
  assert.doesNotMatch(r, /eigentuemer/, 'keine Namen gelesen');
  assert.match(html, /async function vorschlagUebernehmen\(parzellen\)[\s\S]{0,300}if \(!confirm\(/);
  assert.match(html, /\/api\/grundbuch\/parzellen\/vorschlag/);
});
