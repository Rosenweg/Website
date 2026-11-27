// node --test api/test/zev-umhaengen.test.js — Ausschuss und Verwaltung der STWEG
// hängen bereits zugeordnete ZEV-Rechnungen um; jede Änderung wird festgehalten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const i = src.indexOf("app.post('/api/zev/rechnung/:id/zuordnen'");
const zuordnen = src.slice(i, src.indexOf('\napp.', i + 10));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'stweg3', 'pages', 'zev-smartme.html'), 'utf8');

test('keine Sperre mehr für zugeordnete Rechnungen, STWEG-Prüfung bleibt', () => {
  assert.doesNotMatch(zuordnen, /Umhängen nur durch Technik/);
  assert.doesNotMatch(zuordnen, /\$6::boolean OR COALESCE\(zuordnung/);
  assert.match(zuordnen, /altStweg == null \|\| !eigene\.has\(altStweg\)/);
  assert.match(zuordnen, /stweg !== altStweg/);
  assert.match(zuordnen, /for \(const n of verwaltungStwegs\(g\)\) eigene\.add\(n\)/);
});

test('protokolliert mit vorher/nachher, bezahlt beim neuen Empfänger zurück', () => {
  assert.match(zuordnen, /bereich: 'zev', aktion: warZugeordnet \? 'umgehaengt' : 'zugeordnet'/);
  assert.match(zuordnen, /bezahlt = CASE WHEN \$7::boolean THEN false ELSE bezahlt END/);
});

test('Liste zum Umhängen und Seite', () => {
  assert.match(src, /app\.get\('\/api\/zev\/rechnungen\/:stweg', authMiddleware, requirePermission\('wohnungsverwaltung', 'read'\), requireStwegAccess/);
  assert.match(html, /id="zug-section"/);
  assert.match(html, /if \(RECHTE\.schreiben\) loadZugeordnet\(\)/);
  assert.match(html, /\/api\/zev\/rechnungen\/\$\{STWEG\}/);
});
