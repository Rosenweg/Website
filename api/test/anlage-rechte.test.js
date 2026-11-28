// node --test api/test/anlage-rechte.test.js
// Geteilte Telefone: alles unter /api/ erreicht die Haupt-API, die Rechte der PERSON gelten
// weiter. Beleg: requirePermission und adminOnly lassen eine Person ohne Recht auch mit
// Anlage-Token nicht durch, Technik/Praesident schon.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Datenbank-Pool ersetzen: keine Zeilen = keine Rechte in der Rechteverwaltung
const dbPfad = require.resolve('../lib/db');
let zeilen = [];
require.cache[dbPfad] = {
  id: dbPfad, filename: dbPfad, loaded: true,
  exports: { pool: { query: async () => ({ rows: zeilen }) }, auditCtx: () => ({}) },
};
// lib/auth.js startet Aufraeum-Timer: sie duerfen den Testlauf nicht offen halten
const setIntervalOrig = global.setInterval;
global.setInterval = (...a) => { const t = setIntervalOrig(...a); if (t && t.unref) t.unref(); return t; };
const { requirePermission, adminOnly } = require('../middleware/auth');
global.setInterval = setIntervalOrig;

function lauf(mw, user) {
  return new Promise((ok) => {
    const req = { user, anlage: { ext: '2098', paket: 'ch.rosenweg4303.zutritt', token: 'x' }, method: 'PUT', headers: {} };
    const res = { status(c) { this.code = c; return this; }, json(b) { ok({ code: this.code, body: b }); return this; }, setHeader() {}, on() {} };
    Promise.resolve(mw(req, res, () => ok({ code: 200 }))).catch((e) => ok({ fehler: e.message }));
  });
}

test('Rechteverwaltung am Telefon: Bewohner ohne Recht bekommt 403', async () => {
  zeilen = [];
  const r = await lauf(requirePermission('rechteverwaltung', 'write'), { id: 7, email: 'a@example.ch', groups: ['stweg3-eigentuemer'], auth_source: 'anlage' });
  assert.equal(r.code, 403);
});

test('Rechteverwaltung am Telefon: Gruppe mit Lese-Recht darf nicht schreiben', async () => {
  zeilen = [{ access: 'read' }];
  const r = await lauf(requirePermission('rechteverwaltung', 'write'), { id: 7, email: 'a@example.ch', groups: ['stweg3-ausschuss'], auth_source: 'anlage' });
  assert.equal(r.code, 403);
});

test('Rechteverwaltung am Telefon: Technik und Praesident duerfen (wie am eigenen Geraet)', async () => {
  zeilen = [];
  for (const g of ['technik', 'Präsident']) {
    const r = await lauf(requirePermission('rechteverwaltung', 'write'), { id: 1, email: 't@example.ch', groups: [g], auth_source: 'anlage' });
    assert.equal(r.code, 200, g);
  }
});

test('Admin-Routen am Telefon: adminOnly verlangt isAdmin der Person', async () => {
  const nein = await lauf(adminOnly, { id: 7, email: 'a@example.ch', groups: ['r9-bewohner'], isAdmin: false, auth_source: 'anlage' });
  assert.equal(nein.code, 403);
});

test('server.js: /api/permissions bleibt hinter requirePermission und Karten-Bestaetigung', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.put('/api/permissions', authMiddleware, requirePermission('rechteverwaltung', 'write')"));
  // Ingest-Wege haben eigene Geheimnisse (nicht die Person)
  assert.ok(src.includes("app.post('/api/wetter/:station/ingest', mqttBrokerGuard"));
});
