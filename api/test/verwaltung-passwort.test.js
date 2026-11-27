// node --test api/test/verwaltung-passwort.test.js — W9: Das Plattform-Passwort
// einer Hausverwaltung sieht nur, wer den Eintrag auch ändern darf.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stueck = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const sb = { ...groups };
vm.runInNewContext(['verwaltungAenderbar', 'verwaltungFuerLeser'].map(stueck).join('\n')
  + '\nglobalThis.__f = verwaltungFuerLeser;', sb);
const leser = sb.__f;
const v = (stweg) => ({ id: 1, stweg, plattform_user: 'x', plattform_pass: 'geheim' });

test('Technik und Präsident sehen alles', () => {
  assert.equal(leser(['technik'], v(null)).plattform_pass, 'geheim');
  assert.equal(leser(['praesident'], v(3)).plattform_pass, 'geheim');
});

test('Ausschuss: eigene STWEG mit, übergreifend ohne Passwort', () => {
  assert.equal(leser(['stweg3-ausschuss'], v(3)).plattform_pass, 'geheim');
  const r = leser(['stweg3-ausschuss'], v(null));
  assert.equal(r.plattform_pass, null);
  assert.equal(r.plattform_pass_verborgen, true);
  assert.equal(r.darf_aendern, false);
});

test('GET nutzt die Regel, Seite nennt sie richtig', () => {
  assert.match(src, /filter\(v => verwaltungLesbar\(g, v\.stweg\)\)\.map\(v => verwaltungFuerLeser\(g, v\)\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'verwaltung-admin.html'), 'utf8');
  assert.doesNotMatch(html, /nur Admin-sichtbar/);
  assert.match(html, /plattform_pass_verborgen/);
});
