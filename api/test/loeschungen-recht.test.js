// node --test api/test/loeschungen-recht.test.js — W16: Konto-Löschungen nach
// dem Recht „loeschungen“ (wie das Menü); jede Aktion steht im Verlauf.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'loeschungen.html'), 'utf8');

test('Routen prüfen das Recht loeschungen', () => {
  assert.match(src, /const loeschungenLesen = \[requirePermission\('loeschungen', 'read'\)\]/);
  assert.match(src, /const loeschungenSchreiben = \[requirePermission\('loeschungen', 'write'\), kartenAdmin\.mitKarteProtokollieren\]/);
  assert.match(src, /app\.get\('\/api\/admin\/pending-deletions', authMiddleware, \.\.\.loeschungenLesen/);
  for (const r of ["put('/api/admin/pending-deletions/:id/cancel'", "put('/api/admin/pending-deletions/:id/reactivate'", "delete('/api/admin/pending-deletions/:id'"]) {
    assert.ok(src.includes(`app.${r}, authMiddleware, ...loeschungenSchreiben`), r);
  }
  assert.doesNotMatch(src, /pending-deletions[^\n]*requireTechnikOrPraesident/);
});

test('Aktionen werden protokolliert', () => {
  for (const a of ["'gestoppt'", "'timer-30-tage'", "'entfernt'"]) {
    assert.ok(src.includes(`loeschProtokoll(req, ${a}`), a);
  }
  assert.match(src, /bereich: 'loeschungen'/);
});

test('Seite: ohne write nur ansehen, Verlauf sichtbar', () => {
  assert.match(html, /DARF_SCHREIBEN = AuthentikAuth\.hasPermission\('loeschungen', 'write'\)/);
  assert.match(html, /\/api\/admin\/pending-deletions\/protokoll/);
  assert.match(html, /\$\{TECHNIK \? '<option value="chain">/);
});
