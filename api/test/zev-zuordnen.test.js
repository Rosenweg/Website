// node --test api/test/zev-zuordnen.test.js — Z5: Zuordnen nicht zugeordneter
// ZEV-Rechnungen: Empfänger nur aus heute gültigen Kontakten (gueltig_ab),
// Allgemeinzähler wählbar, Status „kein Bewohnername“ statt „kein Eigentümer-Name“.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { zevAktuellerBewohner } = require('../lib/zev');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const i = src.indexOf("app.post('/api/zev/rechnung/:id/zuordnen'");
const zuordnen = src.slice(i, src.indexOf('\napp.', i + 10));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'stweg3', 'pages', 'zev-smartme.html'), 'utf8');

test('Vorgabe-Empfänger wie der Alias: Mieter > Bewohner > Eigentümer', () => {
  const ks = [
    { id: 1, rolle: 'eigentuemer', email: 'eig@beispiel.ch' },
    { id: 2, rolle: 'bewohner', email: 'bew@beispiel.ch' },
  ];
  assert.equal(zevAktuellerBewohner(ks).email, 'bew@beispiel.ch');
});

test('Zuordnen liest nur heute gültige Kontakte (künftige Mieter nicht)', () => {
  assert.match(zuordnen, /archiviert_am IS NULL\s*\n\s*AND \(gueltig_ab IS NULL OR gueltig_ab <= CURRENT_DATE\)/);
  assert.match(zuordnen, /zevAktuellerBewohner\(ak\.rows\)/);
  assert.ok(!/ORDER BY CASE rolle WHEN 'mieter'/.test(zuordnen), 'alte Abfrage ohne gueltig_ab entfernt');
});

test('Allgemeinzähler: Auswahl auf der Seite und eigener Weg im Server', () => {
  assert.match(html, /<option value="allgemein">Allgemeinzähler/);
  assert.match(html, /wohnung_id: 'allgemein', stweg: STWEG/);
  assert.match(zuordnen, /b\.wohnung_id === 'allgemein'/);
  assert.match(zuordnen, /allgemein \? 'allgemein' : 'wohnung'/);
});

test('Status heisst „kein Bewohnername“ (Alias trägt den Bewohnernamen)', () => {
  assert.ok(!html.includes('kein Eigentümer-Name'));
  assert.ok(!src.includes("'kein Eigentuemer-Name'"));
  assert.match(html, /'kein Bewohnername'/);
  assert.match(src, /'kein Bewohnername'/);
});
