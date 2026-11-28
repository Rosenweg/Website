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

test('M1: andere Ausschüsse, fremde Verwaltung und Bewohner nicht; MEG-Verwaltung seit 28.11.2026 ja', () => {
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['stweg3-ausschuss'] }), false);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['meg-verwaltung'] }), true);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['stweg3-verwaltung'] }), false);
  assert.equal(meg.darfMegPlaetzeVerwalten({ groups: ['meg-eigentuemer'] }), false);
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

test('M2: nur mitgeschickte Felder ändern – Mail und Wohnung bleiben', () => {
  const a = meg.megPlatzAenderung({ status: 'vermietet', zugeordnet_name: 'Mia Beispiel', notizen: null });
  assert.deepEqual(a.felder, ['status', 'zugeordnet_name', 'notizen']);
  assert.deepEqual(a.werte, ['vermietet', 'Mia Beispiel', null]);
  assert.ok(!a.felder.includes('zugeordnet_email'));
  assert.ok(!a.felder.includes('wohnung_id'));
});

test('M2: bewusst leeren geht, Pflichtfelder bleiben, Prüfung von Typ/Status/Wohnung', () => {
  assert.deepEqual(meg.megPlatzAenderung({ zugeordnet_email: '' }), { felder: ['zugeordnet_email'], werte: [null] });
  assert.deepEqual(meg.megPlatzAenderung({ typ: '', status: null }), { felder: [], werte: [] });
  assert.deepEqual(meg.megPlatzAenderung({ wohnung_id: '12' }), { felder: ['wohnung_id'], werte: [12] });
  assert.ok(meg.megPlatzAenderung({ typ: 'lkw' }).error);
  assert.ok(meg.megPlatzAenderung({ status: 'weg' }).error);
  assert.ok(meg.megPlatzAenderung({ wohnung_id: 'x' }).error);
  assert.deepEqual(meg.megPlatzAenderung({ unbekannt: 1 }), { felder: [], werte: [] });
});

test('M3: Platznummern numerisch, nach Typ getrennt', () => {
  const rows = ['100', '10', '2', '1', '12a', '12'].map(n => ({ typ: 'auto', platz_nr: n }))
    .concat([{ typ: 'motorrad', platz_nr: '3' }, { typ: 'motorrad', platz_nr: '20' }]);
  const s = meg.sortierePlaetze(rows);
  assert.deepEqual(s.filter(p => p.typ === 'auto').map(p => p.platz_nr), ['1', '2', '10', '12', '12a', '100']);
  assert.deepEqual(s.filter(p => p.typ === 'motorrad').map(p => p.platz_nr), ['3', '20']);
  assert.equal(s[0].typ, 'auto');
  assert.ok(meg.platzNrVergleich('9', '10') < 0);
  assert.match(route, /sortierePlaetze\(r\.rows\)/);
  assert.ok(!/ORDER BY typ, platz_nr/.test(route), 'keine Textsortierung mehr');
});

test('M2: Route und Seite führen zusammen', () => {
  assert.match(route, /megPlatzAenderung\(req\.body\)/);
  assert.ok(!/zugeordnet_email=\$6, wohnung_id=\$7/.test(route), 'altes Überschreiben entfernt');
  assert.match(html, /if \(\(alt\[k\] \?\? null\) !== neu\[k\]\) body\[k\] = neu\[k\]/);
});

test('F7: Platzliste nur für MEG (Mitglieder, Ausschuss, Verwaltung, T/P)', () => {
  for (const g of [['meg-eigentuemer'], ['meg-bewohner'], ['meg-ausschuss'], ['meg-verwaltung'], ['technik'], ['Präsident']]) {
    assert.equal(meg.darfMegPlaetzeSehen({ groups: g }), true, g[0]);
  }
  for (const g of [['stweg3-ausschuss'], ['r9-eigentuemer'], ['stweg5-bewohner'], ['stweg3-verwaltung'], []]) {
    assert.equal(meg.darfMegPlaetzeSehen({ groups: g }), false, g[0] || 'leer');
  }
  assert.equal(meg.darfMegPlaetzeSehen(null), false);
  const i = route.indexOf("router.get('/einstellplaetze', authMiddleware");
  assert.match(route.slice(i, i + 400), /if \(!darfMegPlaetzeSehen\(req\.user\)\) return res\.status\(403\)/);
});
