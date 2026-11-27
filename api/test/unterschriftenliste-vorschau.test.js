// node --test api/test/unterschriftenliste-vorschau.test.js — V5: die Vorschau
// einer Unterschriftenliste speichert nichts (kein Snapshot, keine Rückläufe, kein PDF).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Vorschau-Schalter aus ?preview=1', () => {
  const i = src.indexOf("app.get('/api/unterschriftenliste/:stweg.pdf'");
  assert.match(src.slice(i, i + 2500), /vorschau: req\.query\.preview === '1'/);
});

test('Snapshot und Rückläufe nur ohne Vorschau, Vorschau ohne Hash', () => {
  const i = src.indexOf('async function buildUnterschriftenlisteHTML(');
  const teil = src.slice(i, src.indexOf('const verifyUrl', i));
  assert.match(teil, /if \(!opts\.vorschau\) try \{\s*await pool\.query\(`\s*INSERT INTO unterschriftenliste_snapshots/);
  assert.match(teil, /if \(!opts\.vorschau\) opts\._hash = hash;/);
  assert.match(teil, /if \(opts\.vorschau\) hash = 'VORSCHAU';/);
  // PDF wird nur mit _hash abgelegt
  assert.match(src, /if \(opts\._hash\) \{\s*try \{\s*const dir = pathModule\.join\(DOCS_PATH, 'allgemein', 'unterschriftenlisten'\)/);
});
