// node --test api/test/konto-anlegen-ausschuss.test.js — Entscheid Stefan
// 27.11.2026 (W2/F3-8): alle Ausschüsse dürfen Konten anlegen, je für die
// Bewohner-/Eigentümergruppen der eigenen STWEG.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STWEG_GROUPS } = require('../lib/groups');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Seed: bewohner-verwaltung write für jede Ausschussgruppe (inkl. MEG)', () => {
  assert.match(src, /for \(const groupName of Object\.values\(STWEG_GROUPS\)\.map\(g => g\.ausschuss\)\.filter\(Boolean\)\) \{\s*await client\.query\(\s*`INSERT INTO permissions \(group_name, page, access\) VALUES \(\$1, 'bewohner-verwaltung', 'write'\)/);
  assert.doesNotMatch(src, /\('stweg6-ausschuss', 'bewohner-verwaltung', 'write'\)/);
  assert.equal(Object.values(STWEG_GROUPS).filter(g => g.ausschuss).length, 8);
});

test('API: Ausschuss vergibt nur Gruppen der eigenen STWEG', () => {
  const i = src.indexOf('function vergebbareGruppen(');
  const teil = src.slice(i, i + 500);
  assert.match(teil, /getAusschussStwegs\(callerGroups/);
  assert.match(teil, /m\?\.bewohner/);
  assert.match(teil, /m\?\.eigentuemer/);
  assert.match(src, /Nur Bewohner-\/Eigentümer-Gruppen der eigenen STWEG vergebbar/);
});
