// node --test api/test/rekl-uebersicht.test.js — Befund R2: „Reklamationen dieser
// STWEG“ zeigt die STWEG der besuchten Seite, nicht die des Kontos; wer sie nicht
// sehen darf, bekommt eine klare Meldung.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { uebersichtStwegs } = require('../lib/rekl-uebersicht');

test('ohne ?stweg: wie bisher die STWEG(s) des Kontos', () => {
  assert.deepEqual(uebersichtStwegs(['r9-bewohner'], undefined), { stwegs: [3] });
  assert.deepEqual(uebersichtStwegs(['stweg5-eigentuemer', 'stweg2-ausschuss'], '').stwegs.sort(), [2, 5]);
});

test('mit ?stweg: nur die Seite, wenn das Konto sie sehen darf', () => {
  assert.deepEqual(uebersichtStwegs(['r9-bewohner'], '3'), { stwegs: [3] });
  assert.deepEqual(uebersichtStwegs(['stweg3-verwaltung'], '3'), { stwegs: [3] });
  assert.deepEqual(uebersichtStwegs(['technik'], '5'), { stwegs: [5] });
  assert.deepEqual(uebersichtStwegs(['praesident'], '8'), { stwegs: [8] });
  // Konto STWEG 3 auf der Seite von STWEG 5: nicht still STWEG 3 zeigen
  const r = uebersichtStwegs(['r9-bewohner'], '5');
  assert.equal(r.status, 403);
  assert.match(r.error, /STWEG 5/);
  assert.match(uebersichtStwegs(['stweg3-ausschuss'], '8').error, /MEG/);
  assert.equal(uebersichtStwegs(['r9-bewohner'], '9').status, 400);
  assert.equal(uebersichtStwegs(['r9-bewohner'], '3x').status, 400);
});

test('Seiten übergeben ihre STWEG und zeigen den Servertext', () => {
  const ordner = { stweg1: 1, stweg2: 2, stweg3: 3, stweg4: 4, stweg5: 5, stweg6: 6, stweg7: 7, meg: 8 };
  for (const [d, n] of Object.entries(ordner)) {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', d, 'pages', 'reklamationen.html'), 'utf8');
    assert.match(html, new RegExp(`const SEITEN_STWEG = ${n};`), d);
    assert.ok(html.includes("'/api/reklamationen/uebersicht?stweg=' + SEITEN_STWEG"), d);
    assert.ok(!html.includes("'Keine Berechtigung (403).'"), d);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /uebersichtStwegs\(req\.user\.groups \|\| \[\], req\.query\.stweg\)/);
});

// Rosenweg Reparatur: GET /api/reklamationen/rechte
const { reparaturRechte, stwegSchreibbar } = require('../lib/rekl-uebersicht');

test('Reparatur-Rechte: Bewohner sieht seine STWEG, aendert keine Auto-Zuweisung', () => {
  assert.deepEqual(reparaturRechte(['r9-bewohner']), { eigene_stwegs: [3], uebersicht_stwegs: [3], auto_assign_stwegs: [] });
});

test('Reparatur-Rechte: Verwaltung nur ihre STWEG, ohne eigene Wohnung', () => {
  assert.deepEqual(reparaturRechte(['stweg5-verwaltung']), { eigene_stwegs: [], uebersicht_stwegs: [5], auto_assign_stwegs: [5] });
  assert.deepEqual(reparaturRechte(['meg-verwaltung']).auto_assign_stwegs, [8]);
});

test('Reparatur-Rechte: Ausschuss aendert seine STWEG; Technik alles inkl. 0 = alle', () => {
  assert.deepEqual(reparaturRechte(['r9-eigentuemer', 'stweg3-ausschuss']).auto_assign_stwegs, [3]);
  const t = reparaturRechte(['technik']);
  assert.deepEqual(t.uebersicht_stwegs, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(t.auto_assign_stwegs, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(stwegSchreibbar(['stweg3-ausschuss'], 0), false);
  assert.equal(stwegSchreibbar(['stweg3-ausschuss'], null), false);
  assert.equal(stwegSchreibbar(['praesident'], 0), true);
});

test('Route /api/reklamationen/rechte ist angemeldet und nutzt die Bibliothek', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/reklamationen\/rechte', authMiddleware,/);
  assert.match(src, /const reklStwegSchreibbar = require\('\.\/lib\/rekl-uebersicht'\)\.stwegSchreibbar;/);
});
