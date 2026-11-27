// node --test api/test/salz-rueckgaengig.test.js — W23: „Rückgängig“ erscheint
// nur, wo die API es auch zulässt (eigene Buchung innert 24 h, Technik immer).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'salz.js'), 'utf8');
const i = src.indexOf('function darfRueckgaengig(');
const sb = {};
vm.runInNewContext('const STORNO_EIGENE_STUNDEN = 24;\n' + src.slice(i, src.indexOf('\n}\n', i) + 2)
  + '\nglobalThis.darf = darfRueckgaengig;', sb);
const H = 3600 * 1000;
const jetzt = Date.parse('2026-11-27T12:00:00Z');
const b = (stunden, von = 'erika@example.ch', storniert = null) =>
  ({ gebucht_von: von, gebucht_am: new Date(jetzt - stunden * H).toISOString(), storniert_am: storniert });

test('eigene Buchung innert 24 h', () => {
  assert.equal(sb.darf(b(2), 'erika@example.ch', false, jetzt), true);
  assert.equal(sb.darf(b(25), 'erika@example.ch', false, jetzt), false);
  assert.equal(sb.darf(b(2, 'hans@example.ch'), 'erika@example.ch', false, jetzt), false);
});

test('Technik immer, stornierte nie', () => {
  assert.equal(sb.darf(b(500, 'hans@example.ch'), 'tina@example.ch', true, jetzt), true);
  assert.equal(sb.darf(b(1, 'erika@example.ch', '2026-11-27'), 'erika@example.ch', true, jetzt), false);
});

test('Verlauf liefert das Feld, Seite nutzt es, DELETE dieselbe Regel', () => {
  assert.match(src, /rueckgaengig: darfRueckgaengig\(b, ich, verwalter\)/);
  assert.match(src, /if \(!darfRueckgaengig\(b, String\(req\.user\.email/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'salz.html'), 'utf8');
  assert.match(html, /b\.rueckgaengig \?\?/);
});
