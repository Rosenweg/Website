// node --test api/test/verwaltung-admin-seite.test.js — V6: verwaltung-admin.html
// zeigt den Fehlertext des Servers und belegt für den Ausschuss die eigene STWEG vor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'verwaltung-admin.html'), 'utf8');

test('Fehlertext statt nur Status', () => {
  assert.doesNotMatch(html, /alert\('Fehler: ' \+ r\.status\)/);
  assert.equal((html.match(/alert\(await fehlerText\(r\)\)/g) || []).length, 2);
});

test('Ausschuss: nur eigene STWEG(s) wählbar und vorbelegt', () => {
  assert.match(html, /function stwegAuswahl\(groups\)/);
  assert.match(html, /stwegAuswahl\(user\.groups\);/);
  assert.match(html, /v\.stweg \|\| \(EIGENE_STWEGS && EIGENE_STWEGS\.length \? EIGENE_STWEGS\[0\] : ''\)/);
});
