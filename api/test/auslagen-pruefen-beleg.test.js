// node --test api/test/auslagen-pruefen-beleg.test.js — Befund V3: das
// Prüffenster der Auslagen meldete „kein Beleg“, obwohl Belege da waren. Es
// fragte nur die alte Spalte beleg_path ab; neue Belege liegen in
// auslagen_belege (Mehrfach-Upload) und zaehlen in belege_count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'auslagen.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function openReviewQuelle() {
  const a = html.indexOf('function openReview(');
  const b = html.indexOf('function closeReview(');
  assert.ok(a > 0 && b > a);
  return html.slice(a, b);
}

test('openReview entscheidet nach belege_count, nicht nach beleg_path', () => {
  const q = openReviewQuelle();
  assert.match(q, /belege_count/);
  assert.doesNotMatch(q, /const beleg = a\.beleg_path/);
  assert.match(q, /reviewBelegeLaden\(a\)/);
});

test('Belege im Prüffenster kommen aus /api/auslagen/:id/belege', () => {
  const q = openReviewQuelle();
  assert.match(q, /\/api\/auslagen\/\$\{a\.id\}\/belege`/);
  assert.match(q, /\/api\/auslagen\/\$\{a\.id\}\/belege\/\$\{b\.id\}/);
});

test('die Liste liefert belege_count inkl. Mehrfach-Belege', () => {
  assert.match(src, /SELECT COUNT\(\*\) FROM auslagen_belege WHERE auslage_id = a\.id\),\s*CASE WHEN a\.beleg_path IS NOT NULL THEN 1 ELSE 0 END\) AS belege_count/);
});
