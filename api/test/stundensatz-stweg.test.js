// node --test api/test/stundensatz-stweg.test.js — W4: der Ausschuss ändert nur
// den Stundensatz der eigenen STWEG; den Satz für alle nur Technik/Präsident.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const i = src.indexOf('function darfStundensatz(');
const fn = src.slice(i, src.indexOf('\n}\n', i) + 2);
const sb = { ...groups };
vm.runInNewContext(fn + '\nglobalThis.__f = darfStundensatz;', sb);
const darf = sb.__f;

test('Regel', () => {
  assert.equal(darf(['technik'], null), true);
  assert.equal(darf(['praesident'], 5), true);
  assert.equal(darf(['stweg3-ausschuss'], 3), true);
  assert.equal(darf(['stweg3-ausschuss'], 5), false);
  assert.equal(darf(['stweg3-ausschuss'], null), false);
  assert.equal(darf(['meg-ausschuss'], 8), true);
  assert.equal(darf(['stweg3-verwaltung'], 3), false);
});

test('PUT und DELETE prüfen die Regel, die Seite zeigt nur Erlaubtes', () => {
  assert.equal((src.match(/darfStundensatz\(req\.user\?\.groups/g) || []).length, 2);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'auslagen-stundensatz.html'), 'utf8');
  assert.match(html, /function rechteSetzen\(groups\)/);
  assert.match(html, /\$\{darf\(s\.stweg\) \?/);
});
