// node --test api/test/projekte-rechte.test.js — Befund V1: die Verwaltung liest
// Projekte mit Recht „projekte“, Auslagen eines Projekts nur ihrer STWEG(s).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pr = require('../lib/projekte-rechte');
const { sichtErlaubt } = require('../lib/stweg-sicht');

test('lesen: Eigentümer und T/P wie bisher, Verwaltung nur mit Recht', () => {
  assert.equal(pr.projekteLesen(['stweg5-eigentuemer'], undefined), true);
  assert.equal(pr.projekteLesen(['technik'], undefined), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], 'read'), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], 'write'), true);
  assert.equal(pr.projekteLesen(['stweg3-verwaltung'], undefined), false);
  assert.equal(pr.projekteLesen(['Verwaltung'], 'read'), true); // ÜBERGANG
  assert.equal(pr.projekteLesen(['stweg5-bewohner'], 'read'), false); // Recht allein reicht nicht
});

test('kommentieren: nur Eigentümer und T/P, die Verwaltung liest nur', () => {
  assert.equal(pr.projekteKommentieren(['stweg5-eigentuemer']), true);
  assert.equal(pr.projekteKommentieren(['praesident']), true);
  assert.equal(pr.projekteKommentieren(['stweg3-verwaltung']), false);
});

test('Auslagen eines Projekts: Verwaltung STWEG 3 sieht nur STWEG 3', () => {
  assert.equal(pr.projektAuslagenSicht(['stweg5-eigentuemer']), null);
  assert.equal(pr.projektAuslagenSicht(['technik']), null);
  const s = pr.projektAuslagenSicht(['stweg3-verwaltung']);
  assert.equal(sichtErlaubt(s, 3), true);
  assert.equal(sichtErlaubt(s, 5), false);
  assert.equal(sichtErlaubt(s, null), false);
});

test('server.js: Lese-Routen nutzen requireProjekteLesen, Kommentieren bleibt Eigentümer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/api/projects', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.get('/api/projects/:slug', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.get('/api/projects/:slug/auslagen', authMiddleware, requireProjekteLesen,"));
  assert.ok(src.includes("app.post('/api/projects/:slug/comments', authMiddleware, requireEigentuemer,"));
});

test('projekte.html: ohne Kommentarrecht kein Kommentarfeld', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'projekte.html'), 'utf8');
  assert.match(html, /p\.darf_kommentieren === false/);
});
