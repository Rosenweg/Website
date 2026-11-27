// node --test api/test/zpush-sicht.test.js — Befund F1-7: das Z-Push-Backend
// (zpush/sicht.php) kennt dieselben Gruppen wie api/lib/groups.js, und das
// Verzeichnis aufs Handy folgt der Regel des Portal-Telefonbuchs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const g = require('../lib/groups');

const WURZEL = path.join(__dirname, '..', '..');
const php = fs.readFileSync(path.join(WURZEL, 'zpush', 'sicht.php'), 'utf8');

test('sicht.php: alle STWEG-Gruppen aus groups.js', () => {
  for (const [nr, m] of Object.entries(g.STWEG_GROUPS)) {
    const zeile = php.match(new RegExp(`\\n\\s+${nr} => array\\(([^)]*)\\)`));
    assert.ok(zeile, 'STWEG ' + nr);
    for (const name of [m.bewohner, m.eigentuemer, m.ausschuss]) assert.ok(zeile[1].includes(`'${name}'`), `${nr}: ${name}`);
  }
});

test('sicht.php: Ausschuss- und Verwaltungsgruppen wie groups.js', () => {
  for (const m of Object.values(g.STWEG_GROUPS)) assert.ok(php.includes(`'${m.ausschuss}'`), m.ausschuss);
  for (const [nr, name] of Object.entries(g.VERWALTUNG_GROUPS)) assert.match(php, new RegExp(`${nr} => '${name}'`));
  assert.ok(php.includes(`RW_VERWALTUNG_UEBERGANG = '${g.VERWALTUNG_UEBERGANG_GLOBAL}'`));
});

test('Portal-Telefonbuch: gleiche Gruppen für „alle“', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/telefonbuch'");
  const teil = src.slice(i, i + 1500);
  assert.match(teil, /isTechnik\(g\) \|\| isPraesident\(g\) \|\| isAusschussForAny\(g\) \|\| verwaltetAlleStwegs\(g\)/);
  assert.match(teil, /\['wohnungsverwaltung', 'bewohner-verwaltung'\]/);
  for (const n of ['wohnungsverwaltung', 'bewohner-verwaltung', 'technik', 'praesident']) assert.ok(php.includes(`'${n}'`), n);
});

test('Backend: ohne lesbare Gruppen nur „keine“, nur lesend', () => {
  const be = fs.readFileSync(path.join(WURZEL, 'zpush', 'backend-rosenweg.php'), 'utf8');
  assert.match(be, /private \$rwSicht = 'keine';/);
  assert.match(be, /\$gruppen === null \? 'keine' : rw_sicht_schluessel\(\$gruppen\)/);
  assert.match(be, /public function ChangeMessage\([^)]*\) \{ return false; \}/);
  assert.match(php, /return array\('keine'\);/);
});
