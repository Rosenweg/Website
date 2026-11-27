// node --test api/test/rechte-protokoll.test.js — W15: Rechteverwaltung mit
// Leserecht nur ansehen; jede Änderung eines Rechts wird festgehalten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ap = require('../lib/admin-protokoll');

test('nur echte Änderungen zählen', () => {
  const alt = [
    { group_name: 'stweg3-ausschuss', page: 'auslagen', access: 'read' },
    { group_name: 'stweg3-ausschuss', page: 'zähler', access: 'write' },
  ];
  const neu = [
    { group_name: 'stweg3-ausschuss', page: 'auslagen', access: 'write' }, // geändert
    { group_name: 'stweg3-ausschuss', page: 'zähler', access: 'write' },   // gleich
    { group_name: 'stweg3-ausschuss', page: 'projekte', access: 'none' },  // war none
    { group_name: 'stweg3-ausschuss', page: 'kontakte', access: 'read' },  // neu
    { group_name: 'x', page: 'y', access: 'admin' },                       // ungültig
  ];
  assert.deepEqual(ap.rechteAenderungen(alt, neu), [
    { group_name: 'stweg3-ausschuss', page: 'auslagen', alt: 'read', neu: 'write' },
    { group_name: 'stweg3-ausschuss', page: 'kontakte', alt: 'none', neu: 'read' },
  ]);
});

test('eintragen schreibt wer und was', async () => {
  const q = [];
  const pool = { query: async (sql, p) => { q.push([sql, p]); return { rows: [] }; } };
  const req = { user: { email: 'Erika@Example.CH', name: 'Erika Muster' }, auth: { art: 'karte' } };
  const n = await ap.eintragen(pool, null, req, [{ bereich: 'rechte', aktion: 'geaendert', ziel: 'g · p', alt: 'none', neu: 'read' }]);
  assert.equal(n, 1);
  const ins = q.find(([sql]) => sql.includes('INSERT INTO admin_protokoll'));
  assert.deepEqual(ins[1].slice(0, 5), ['rechte', 'geaendert', 'g · p', 'none', 'read']);
  assert.deepEqual(ins[1].slice(6), ['erika@example.ch', 'Erika Muster', 'karte']);
});

test('Server protokolliert, Seite zeigt Speichern nur mit write', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /adminProtokoll\.rechteAenderungen\(vorher\.rows, permissions\)/);
  assert.match(src, /app\.get\('\/api\/permissions\/protokoll', authMiddleware, requirePermission\('rechteverwaltung', 'read'\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'rechteverwaltung.html'), 'utf8');
  assert.match(html, /DARF_SCHREIBEN = AuthentikAuth\.hasPermission\('rechteverwaltung', 'write'\)/);
  assert.match(html, /\['add-group-row', 'save-row', 'hilfe-schreiben'\]/);
  assert.match(html, /if \(!b \|\| !DARF_SCHREIBEN\) return;/);
  assert.match(html, /\/api\/permissions\/protokoll/);
});
