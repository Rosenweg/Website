// node --test api/test/wasch-admin.test.js — W10: Die Waschküchen-Verwaltung
// richtet sich nach dem Recht „waschküche-admin“ und der STWEG der Räume.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waschAdminErlaubt, waschRaumAenderbar } = require('../lib/wasch-admin');

test('Technik und Präsident immer', () => {
  assert.equal(waschAdminErlaubt(['technik'], 'none', 'write', [3]).ok, true);
  assert.equal(waschAdminErlaubt(['praesident'], 'none', 'write', [3]).ok, true);
});

test('Recht nötig, write für Änderungen', () => {
  assert.equal(waschAdminErlaubt(['stweg3-ausschuss'], 'none', 'read', [3]).ok, false);
  assert.equal(waschAdminErlaubt(['stweg3-ausschuss'], 'read', 'read', [3]).ok, true);
  assert.equal(waschAdminErlaubt(['stweg3-ausschuss'], 'read', 'write', [3]).ok, false);
  assert.equal(waschAdminErlaubt(['stweg3-ausschuss'], 'write', 'write', [3]).ok, true);
});

test('Nur wer alle STWEGs mit Waschküche betreut', () => {
  assert.equal(waschAdminErlaubt(['stweg3-verwaltung'], 'read', 'read', [3]).ok, true);
  assert.equal(waschAdminErlaubt(['stweg5-verwaltung'], 'read', 'read', [3]).ok, false);
  assert.equal(waschAdminErlaubt(['stweg5-ausschuss'], 'write', 'read', [3]).ok, false);
  assert.equal(waschAdminErlaubt(['stweg3-ausschuss'], 'write', 'read', [3, 5]).ok, false);
  assert.equal(waschAdminErlaubt(['r9-bewohner'], 'write', 'read', [3]).ok, false);
});

test('Raum nur der eigenen STWEG', () => {
  assert.equal(waschRaumAenderbar(['technik'], null), true);
  assert.equal(waschRaumAenderbar(['stweg3-ausschuss'], 3), true);
  assert.equal(waschRaumAenderbar(['stweg3-ausschuss'], 5), false);
  assert.equal(waschRaumAenderbar(['stweg3-ausschuss'], null), false);
});

test('Routen nutzen waschAdmin, Türen bleiben adminOnly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const r of ["get('/api/wasch/admin/stats'", "get('/api/wasch/admin/sessions'", "get('/api/wasch/admin/costs'", "get('/api/wasch/admin/billing'"]) {
    assert.ok(src.includes(`app.${r}, authMiddleware, waschAdmin('read')`), r);
  }
  for (const r of ["post('/api/wasch/rooms'", "put('/api/wasch/rooms/:id'", "put('/api/wasch/settings'", "post('/api/wasch/admin/billing/run'"]) {
    assert.ok(src.includes(`app.${r}, authMiddleware, waschAdmin('write')`), r);
  }
  assert.ok(src.includes("app.post('/api/wasch/admin/doors/:roomId/unlock', authMiddleware, adminOnly"));
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'stweg3', 'pages', 'waschkueche-admin.html'), 'utf8');
  assert.doesNotMatch(html, /Nur Mitglieder der Technik-Gruppe/);
  assert.match(html, /hasPermission\('waschküche-admin', 'read'\)/);
  assert.match(html, /DARF_SCHREIBEN = AuthentikAuth\.hasPermission\('waschküche-admin', 'write'\)/);
});
