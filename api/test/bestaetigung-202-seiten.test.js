// node --test api/test/bestaetigung-202-seiten.test.js — W17/N5: Antwort 202
// (Aktion wartet auf Bestätigung per Mail, lib/kartenadmin.js) darf keine
// Seite als Erfolg melden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('jede Seite mit bestätigungspflichtigen Aktionen prüft 202', () => {
  const erwartet = {
    'ssh-zugriffsmatrix.html': 2,
    'rechteverwaltung.html': 1,
    'personen.html': 1,
    'profil.html': 3,
  };
  for (const [p, n] of Object.entries(erwartet)) {
    const anzahl = (lies(p).match(/\.status === 202/g) || []).length;
    assert.ok(anzahl >= n, `${p}: ${anzahl} statt ${n}`);
  }
  for (const p of ['stationen.html', 'proxmox-verwaltung.html']) {
    const h = lies(p);
    assert.match(h, /if \(res\.status === 202 && d && d\.bestaetigung\) d\._wartet = true;/, p);
    assert.match(h, /_wartet\)/, p);
  }
});

test('Text der Bestätigung aus authentik-auth.js', () => {
  assert.match(lies('js/authentik-auth.js'), /bestaetigungsText\(data\) \{/);
  assert.doesNotMatch(lies('personen.html'), /Merge erfolgreich: \$\{data\.reassigned_kontakte\}/);
});
