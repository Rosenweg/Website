// node --test api/test/praesident-angleichen.test.js — W3, W12, W13: Oberfläche
// und API sagen dasselbe, wer darf (keine Knöpfe, die mit 403 enden).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../lib/groups');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('W3 Alarmpanel: Verwaltungsknöpfe nur Technik/Präsident', () => {
  const h = lies('stweg3/pages/alarmpanel.html');
  const i = h.indexOf('function isManager(user)');
  const fn = h.slice(i, h.indexOf('\n        }', i) + 10);
  const sb = {};
  vm.runInNewContext(fn + '\nglobalThis.__f = isManager;', sb);
  assert.equal(sb.__f({ groups: ['stweg3-ausschuss'] }), false);
  assert.equal(sb.__f({ groups: ['Präsident'] }), true);
  assert.equal(sb.__f({ groups: ['technik'] }), true);
});

test('W12 Stationen: Befehle an Windows-Rechner nur für die Gruppe technik', () => {
  const h = lies('stationen.html');
  assert.match(h, /istTechnikGruppe = groups\.includes\('technik'\);/);
  assert.match(h, /if \(istTechnikGruppe\) h \+= e\('Nachricht anzeigen …'/);
  assert.match(h, /if \(istTechnikGruppe\) h \+= e\('Abmelden …'/);
  assert.match(lies('api/routes/stationen-v2.js'), /function nurTechnikGruppe\(req, res, next\) \{\s*if \(!isTechnik\(/);
});

test('W13 ISP-Wartungen: Technik und Präsident schreiben', () => {
  const src = lies('api/server.js');
  const i = src.indexOf('function ispMaintCanWrite(');
  const fn = src.slice(i, src.indexOf('\n}\n', i) + 2);
  const vermerkt = [];
  const sb = { ...groups, kartenAdmin: { vermerken: () => vermerkt.push(1) } };
  vm.runInNewContext(fn + '\nglobalThis.__f = ispMaintCanWrite;', sb);
  assert.equal(sb.__f({ user: { groups: ['Präsident'] } }, {}), true);
  assert.equal(sb.__f({ user: { groups: ['technik'] } }), true);
  assert.equal(sb.__f({ user: { groups: ['stweg3-ausschuss'] } }, {}), false);
  assert.equal(vermerkt.length, 1);
  assert.equal((src.match(/if \(!ispMaintCanWrite\(req, res\)\) return res\.status\(403\)/g) || []).length, 4);
});
