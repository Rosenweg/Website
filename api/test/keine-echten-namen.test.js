// node --test api/test/keine-echten-namen.test.js — W28, N3, N4: Beispiele und
// Platzhalter ohne echte Namen und Firmen; der Absender der Briefe kommt aus der Umgebung.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('Brief-Tracking: Prompt mit Musternamen, Absender aus BRIEF_ABSENDER', () => {
  const src = lies('api/routes/briefe.js');
  assert.match(src, /const BRIEF_ABSENDER = String\(process\.env\.BRIEF_ABSENDER \|\| ''\)/);
  assert.match(src, /z\.B\. "Max Muster" oder "Anna Beispiel & Beat Beispiel" oder "Muster Immobilien AG"/);
  assert.match(src, /Der Empfänger ist NICHT der Absender/);
});

test('Platzhalter in personen.html und verwaltung-admin.html', () => {
  assert.match(lies('personen.html'), /\(z\.B\. "Anna Muster" vs "Muster Anna"\)/);
  assert.match(lies('verwaltung-admin.html'), /id="m-website" placeholder="beispiel-verwaltung\.ch"/);
});
