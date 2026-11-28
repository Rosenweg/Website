// node --test api/test/zaehler-technik-gruppe.test.js — W19: Zähler-Technik
// (Rosenweg 9) prüfte die Gruppe stweg3-eigentuemer; sie heisst r9-eigentuemer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STWEG_GROUPS } = require('../lib/groups');

test('requireZaehlerTechnik nimmt die Eigentümergruppe aus STWEG_GROUPS[3]', () => {
  assert.equal(STWEG_GROUPS[3].eigentuemer, 'r9-eigentuemer');
  // Regel liegt seit der Energie-App in lib/zaehler-technik.js (auch fuer /api/auth/me)
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zaehler-technik.js'), 'utf8');
  assert.match(lib, /gl\.includes\(STWEG_GROUPS\[3\]\.eigentuemer\.toLowerCase\(\)\)/);
  assert.doesNotMatch(lib.split('\n').filter(z => !/^\s*\/\//.test(z)).join('\n'), /'stweg3-eigentuemer'/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf('function requireZaehlerTechnik(');
  const teil = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(teil, /zaehlerTechnikZugang\(req\.user\?\.groups \|\| \[\]\)/);
  const { zaehlerTechnikZugang } = require('../lib/zaehler-technik');
  assert.equal(zaehlerTechnikZugang(['r9-eigentuemer']), true);
  assert.equal(zaehlerTechnikZugang(['stweg3-eigentuemer']), false);
});
