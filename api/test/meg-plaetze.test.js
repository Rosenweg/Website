// node --test api/test/meg-plaetze.test.js — MEG-Einstellplätze: Verwaltung nur
// MEG-Ausschuss/Technik/Präsident (M1). Erfundene Konten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const meg = require('../lib/meg');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'meg', 'pages', 'einstellplaetze.html'), 'utf8');
const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'meg.js'), 'utf8');

test('M1: verwalten dürfen MEG-Ausschuss, Technik, Präsident', () => {
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['meg-ausschuss'] }), true);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['Technik'] }), true);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['praesident'] }), true);
  assert.equal(meg.darfMegPlaetzeVerwalten({ isAdmin: true, groups: [] }), true);
});

test('M1: andere Ausschüsse, Verwaltung und Bewohner nicht', () => {
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['stweg3-ausschuss'] }), false);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['meg-verwaltung'] }), false);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['stweg5-bewohner'] }), false);
  assert.equal(meg.darfMegPlaetzeVerwalten(null), false);
});

test('M1: Seite fragt den Server statt Gruppennamen zu raten', () => {
  assert.ok(!/ausschuss\|technik\|präsident/.test(html), 'kein Gruppennamen-Muster mehr');
  assert.match(html, /\/api\/meg\/einstellplaetze\/rechte/);
  assert.match(html, /rechte\.verwalten === true/);
  assert.match(route, /router\.get\('\/einstellplaetze\/rechte', authMiddleware/);
  assert.match(route, /darfMegPlaetzeVerwalten\(req\.user\)/);
});

test('Anmelde-Hinweis nur ohne Anmeldung (führt sonst nicht zum Ziel)', () => {
  assert.match(html, /AuthentikAuth\.init\(\{ requireAuth: false \}\)/);
  const i = html.indexOf('if (!user) {');
  assert.ok(i > 0);
  assert.match(html.slice(i, i + 200), /login-hint/);
});
