// node --test api/test/meg-zev-ausschuss.test.js — MEG-Einstellplätze und
// ZEV-Zuordnung macht der Ausschuss (Entscheid Stefan 27.11.2026): Prüfung, dass
// die API ihn je STWEG zulässt, und W25 (Seite nur für die, die es dürfen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');

test('MEG-Einstellplätze: MEG-Ausschuss, Technik, Präsident – API und Seite gleich', () => {
  // Eine Regel für API und Seite: lib/meg.js darfMegPlaetzeVerwalten; die Seite
  // fragt /api/meg/einstellplaetze/rechte (M1, Details in meg-plaetze.test.js).
  const lib = lies('api/lib/meg.js');
  assert.match(lib, /function darfMegPlaetzeVerwalten[\s\S]*?isTechnik\(groups\) \|\| isPraesident\(groups\) \|\| getAusschussStwegs\(groups\)\.has\(8\)/);
  const meg = lies('api/routes/meg.js');
  assert.match(meg, /function megManageGate[\s\S]*?darfMegPlaetzeVerwalten\(req\.user\)/);
  const html = lies('meg/pages/einstellplaetze.html');
  assert.match(html, /\/api\/meg\/einstellplaetze\/rechte/);
  assert.doesNotMatch(html, /\/ausschuss\|technik\|präsident\|praesident\/i/);
});

test('ZEV: Ausschuss (wohnungsverwaltung write) ordnet Rechnungen seiner STWEG zu', () => {
  const src = lies('api/server.js');
  const i = src.indexOf("app.post('/api/zev/rechnung/:id/zuordnen'");
  const teil = src.slice(i, i + 2500);
  assert.match(teil, /requirePermission\('wohnungsverwaltung', 'write'\)/);
  assert.match(teil, /const eigene = getAusschussStwegs\(g\);/);
  // Seed: wohnungsverwaltung write für jede Ausschussgruppe
  assert.match(src, /INSERT INTO permissions \(group_name, page, access\) VALUES \(\$1, 'wohnungsverwaltung', 'write'\)/);
  assert.match(src, /app\.put\('\/api\/zev\/config\/:stweg', authMiddleware, requirePermission\('wohnungsverwaltung', 'write'\), requireStwegAccess, requireStwegWrite/);
});
