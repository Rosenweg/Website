// node --test api/test/verteiler-portal.test.js — Befund V2: die Verwaltung sieht
// im Portal die Verteiler ihrer STWEG(s) (Recht email-verteiler) und sendet an sie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vv = require('../lib/verteiler-verwaltung');

const V3 = { id: 1, stweg: 3, name: 'Bewohner R9', email_address: 'r9@example.invalid', active: true, members: [{ email: 'a@example.invalid' }], resolved_emails: ['a@example.invalid'], member_count: 1, group_names: ['r9-bewohner'] };
const V5 = { id: 2, stweg: 5, name: 'Bewohner STWEG 5', active: true };

test('Sicht: nur mit Recht, nur die eigenen STWEGs', () => {
  assert.deepEqual([...vv.portalVerteilerStwegs(['stweg3-verwaltung'], 'read')], [3]);
  assert.equal(vv.portalVerteilerStwegs(['stweg3-verwaltung'], undefined).size, 0);
  assert.equal(vv.portalVerteilerStwegs(['stweg5-bewohner'], 'read').size, 0);
  assert.equal(vv.portalVerteilerStwegs(['Verwaltung'], 'read').size, 8); // ÜBERGANG
});

test('Senden: nur an aktive Verteiler der eigenen STWEG', () => {
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'read', V3), true);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'read', V5), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'read', { ...V3, active: false }), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], undefined, V3), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'read', { ...V3, stweg: null }), false);
});

test('fuerVerwaltung: keine Mitglieder- oder Gruppenliste', () => {
  const v = vv.fuerVerwaltung(V3);
  assert.deepEqual(Object.keys(v).sort(), ['active', 'email_address', 'id', 'member_count', 'name', 'stweg']);
});

test('server.js: Liste und Versand prüfen die Verwaltung, Verwalten bleibt adminOnly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/api/verteiler', authMiddleware, async"));
  assert.ok(src.includes("app.post('/api/verteiler/send', authMiddleware, async"));
  assert.match(src, /portalDarfSenden\(/);
  assert.ok(src.includes("app.post('/api/verteiler', authMiddleware, adminOnly"));
  assert.ok(src.includes("app.get('/api/email/log', authMiddleware, adminOnly"));
});
