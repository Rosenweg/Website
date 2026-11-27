// node --test api/test/melde-orte-stweg.test.js — Melde-Orte (QR-Sticker) mit
// STWEG-Grenze wie die Türschilder: Liste nur in der STWEG-Sicht, Auswahl und
// Knöpfe nur für änderbare STWEGs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'melde-orte.html'), 'utf8');

test('Liste mit STWEG-Sicht, Antwort sagt, was änderbar ist', () => {
  const i = src.indexOf("app.get('/api/reklamation-orte'");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(route, /stwegSichtLib\.sichtSql\(sicht, 'stweg', params\)/);
  assert.match(route, /darf_aendern: reklStwegSchreibbar\(g, o\.stweg\)/);
  assert.match(route, /schreib_stwegs: schreibStwegs/);
  for (const m of ['post', 'put', 'delete']) {
    const j = src.indexOf(`app.${m}('/api/reklamation-orte`);
    assert.ok(src.slice(j, j + 1500).includes('reklStwegSchreibbar(req.user.groups'), m);
  }
});

test('Seite bietet nur erlaubte STWEGs an', () => {
  assert.match(html, /if \(withEmpty && alle\)/);
  assert.match(html, /SCHREIB_STWEGS\.includes\(o\.v\)/);
  assert.match(html, /o\.darf_aendern === false \? ''/);
});
