// node --test api/test/termine.test.js — STWEG-Termine (Rosenweg Termine, STWEG-Seiten):
// Schreiben nur mit Recht 'stweg-termine' UND Ausschuss/Verwaltung genau dieser STWEG,
// Technik/Präsident immer; Formularprüfung; Zusammenführen mehrerer STWEGs;
// Nextcloud-Kalender-Hinweis; Rechte-Migration und MCP-Werkzeug stweg_termin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const t = require('../lib/termine');
const { RECHTE_MIGRATIONEN } = require('../lib/rechte-migrationen');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
// lib/auth.js braucht pg: die Spalte der Rechteverwaltung im Quelltext pruefen
const AUTH = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.js'), 'utf8');

test('Schreiben: Technik/Präsident immer, sonst Recht + eigene STWEG', () => {
  assert.equal(t.termineSchreibErlaubt(['technik'], 3, 'none'), true);
  assert.equal(t.termineSchreibErlaubt(['Präsident'], 8, 'none'), true);
  assert.equal(t.termineSchreibErlaubt([], 3, 'none', true), true, 'alter Weg role=admin');
  // Ausschuss STWEG 3
  assert.equal(t.termineSchreibErlaubt(['stweg3-ausschuss'], 3, 'write'), true);
  assert.equal(t.termineSchreibErlaubt(['stweg3-ausschuss'], 3, 'read'), false, 'ohne Seitenrecht');
  assert.equal(t.termineSchreibErlaubt(['stweg3-ausschuss', 'stweg5-bewohner'], 5, 'write'), false, 'fremde STWEG trotz Mitgliedschaft');
  assert.equal(t.termineSchreibErlaubt(['meg-ausschuss'], 8, 'write'), true);
  // Verwaltung je STWEG
  assert.equal(t.termineSchreibErlaubt(['stweg3-verwaltung'], 3, 'write'), true);
  assert.equal(t.termineSchreibErlaubt(['stweg3-verwaltung'], 5, 'write'), false);
  assert.equal(t.termineSchreibErlaubt(['meg-verwaltung'], 8, 'write'), true);
  // Bewohner/Eigentümer nie, auch mit Recht
  assert.equal(t.termineSchreibErlaubt(['r9-eigentuemer'], 3, 'write'), false);
  assert.equal(t.termineSchreibErlaubt(['technik'], 9, 'write'), false, 'keine STWEG 9');
});

test('Sichtbare STWEGs: eigene (auch als Verwaltung), Technik alle', () => {
  const b = t.termineStwegs(['r9-bewohner', 'stweg5-eigentuemer'], 'none');
  assert.deepEqual(b.map(s => [s.nr, s.eigene, s.schreiben]), [[3, true, false], [5, true, false]]);
  assert.equal(b[0].name, 'STWEG 3');
  const v = t.termineStwegs(['meg-verwaltung'], 'write');
  assert.deepEqual(v.map(s => [s.nr, s.name, s.schreiben]), [[8, 'MEG', true]]);
  const tech = t.termineStwegs(['technik', 'r9-eigentuemer'], 'write');
  assert.equal(tech.length, 8);
  assert.deepEqual(tech.filter(s => s.eigene).map(s => s.nr), [3]);
  assert.ok(tech.every(s => s.schreiben));
  assert.deepEqual(t.termineStwegs(['irgendwer'], 'write'), []);
});

test('Auswahl ?stweg=: Standard eigene, alle, Liste, fremde = 403', () => {
  const s = t.termineStwegs(['technik', 'r9-eigentuemer'], 'write');
  assert.deepEqual(t.termineAuswahl(s, undefined).stwegs, [3]);
  assert.deepEqual(t.termineAuswahl(s, 'alle').stwegs.length, 8);
  assert.deepEqual(t.termineAuswahl(s, '3,5,5').stwegs, [3, 5]);
  assert.deepEqual(t.termineAuswahl(t.termineStwegs(['technik'], 'write'), '').stwegs.length, 8, 'ohne eigene: alle sichtbaren');
  const b = t.termineStwegs(['r9-bewohner'], 'none');
  assert.equal(t.termineAuswahl(b, '5').status, 403);
  assert.equal(t.termineAuswahl(b, 'x').status, 400);
  assert.deepEqual(t.termineAuswahl([], '').stwegs, []);
});

test('Formular: Pflichtfelder, Daten, Ende nach Beginn, Art, Längen; PUT teilweise', () => {
  assert.equal(t.terminAusFormular({}).feld, 'title');
  assert.equal(t.terminAusFormular({ title: '  ' }).feld, 'title');
  assert.equal(t.terminAusFormular({ title: 'A' }).feld, 'start_date');
  assert.equal(t.terminAusFormular({ title: 'A', start_date: 'morgen' }).error, 'Beginn ist kein gültiges Datum');
  assert.equal(t.terminAusFormular({ title: 'A', start_date: '2026-12-03T19:00', end_date: '2026-12-03T18:00' }).feld, 'end_date');
  assert.equal(t.terminAusFormular({ title: 'A', start_date: '2026-12-03', category: 'party' }).feld, 'category');
  assert.equal(t.terminAusFormular({ title: 'x'.repeat(256), start_date: '2026-12-03' }).feld, 'title');
  const ok = t.terminAusFormular({ title: ' Versammlung ', start_date: '2026-12-03T19:00:00', all_day: 'ja', location: '', category: 'Versammlung' });
  assert.equal(ok.werte.title, 'Versammlung');
  assert.equal(ok.werte.all_day, false, 'nur true zählt');
  assert.equal(ok.werte.location, null);
  assert.equal(ok.werte.category, 'versammlung');
  assert.equal(ok.werte.end_date, null);
  // Web-Seite (stweg3/index.html) schickt category 'stweg'
  assert.ok(t.terminAusFormular({ title: 'A', start_date: '2026-12-03T09:00:00', all_day: true, category: 'stweg' }).werte);
  // PUT: nur gesendete Felder
  assert.deepEqual(Object.keys(t.terminAusFormular({ location: 'Raum 2' }, { teilweise: true }).werte), ['location']);
  assert.equal(t.terminAusFormular({ title: '' }, { teilweise: true }).feld, 'title');
});

test('Zusammenführen: Kooperation und Wartung ohne STWEG nur einmal, sortiert', () => {
  const koop = { title: 'Hauptversammlung', start: '2027-03-01T18:00:00.000Z', source: 'kooperation' };
  const wart = { id: 'wartung-7', title: 'Lift', start: '2026-12-10', source: 'wartung' };
  const liste = t.termineZusammenfuehren([
    { nr: 3, termine: [{ id: 1, title: 'Sitzung 3', start: '2026-12-05T18:00:00.000Z', source: 'stweg' }, koop, wart] },
    { nr: 5, termine: [{ id: 2, title: 'Sitzung 5', start: '2026-12-04T18:00:00.000Z', source: 'stweg' }, koop, wart] },
  ]);
  assert.deepEqual(liste.map(x => x.title), ['Sitzung 5', 'Sitzung 3', 'Lift', 'Hauptversammlung']);
  assert.deepEqual(liste.find(x => x.source === 'kooperation').stwegs, [3, 5]);
  assert.equal(liste.find(x => x.source === 'kooperation').stweg, null);
  assert.equal(liste.find(x => x.title === 'Sitzung 5').stweg, 5);
  assert.deepEqual(liste.find(x => x.source === 'wartung').stwegs, [3, 5]);
});

test('Nextcloud-Kalender aus TERMINE_NEXTCLOUD_KALENDER: nur gültige Einträge, nur https', () => {
  assert.deepEqual(t.nextcloudKalender(undefined), {});
  assert.deepEqual(t.nextcloudKalender('kein json'), {});
  const k = t.nextcloudKalender(JSON.stringify({
    3: { name: 'STWEG 3 – Termine', url: 'https://cloud.example.org/apps/calendar/p/abc' },
    5: { name: 'STWEG 5', url: 'http://unsicher' },
    9: { name: 'gibt es nicht' },
    7: { url: 'https://ohne-name' },
  }));
  assert.deepEqual(k, { 3: { name: 'STWEG 3 – Termine', url: 'https://cloud.example.org/apps/calendar/p/abc' }, 5: { name: 'STWEG 5', url: null } });
});

test('Rechte-Migration: stweg-termine write für alle Ausschüsse und Verwaltungen (Stefan 28.11.2026)', () => {
  const m = RECHTE_MIGRATIONEN.find(x => x.page === 'stweg-termine');
  assert.ok(m);
  assert.equal(m.access, 'write');
  const soll = ['meg-ausschuss', 'meg-verwaltung', ...[1, 2, 3, 4, 5, 6, 7].flatMap(n => [`stweg${n}-verwaltung`])];
  // Ausschüsse heissen in STWEG 3 und 6 auch stweg3-/stweg6-ausschuss
  for (const n of [1, 2, 3, 4, 5, 6, 7]) soll.push(`stweg${n}-ausschuss`);
  assert.deepEqual([...m.gruppen].sort(), soll.sort());
  assert.match(AUTH, /\{ id: 'stweg-termine', label: 'STWEG-Termine' \}/, 'Spalte in der Rechteverwaltung');
});

test('server.js: Schreib-Routen mit requireStwegAccess + requireTermineWrite, nicht mehr adminOnly', () => {
  for (const r of ["app.post('/api/stweg/:stweg/events'", "app.put('/api/stweg/:stweg/events/:id'", "app.delete('/api/stweg/:stweg/events/:id'"]) {
    const i = SERVER.indexOf(r);
    assert.ok(i > 0, r);
    const zeile = SERVER.slice(i, SERVER.indexOf('\n', i));
    assert.match(zeile, /authMiddleware, requireStwegAccess, requireTermineWrite/, r);
    assert.doesNotMatch(zeile, /adminOnly/, r);
  }
  assert.match(SERVER, /app\.get\('\/api\/termine', authMiddleware,/);
});

test('MCP stweg_termin: Ausschuss mit Migrationsrecht darf, Felder passen zum Formular', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'werkzeuge-verwaltung.js'), 'utf8');
  const teil = src.slice(src.indexOf("name: 'stweg_termin'"), src.indexOf("name: 'whatsapp_status'"));
  assert.match(teil, /rolle: 'ausschuss'/);
  const lauf = teil.match(/async lauf\(api, a\) \{([\s\S]*?)\},\n/)[1];
  // eslint-disable-next-line no-new-func
  const fn = new Function('api', 'a', lauf);
  let gesendet;
  await fn((methode, pfad, o) => { gesendet = { methode, pfad, body: o.body }; return {}; },
    { stweg: 3, titel: 'Ausschusssitzung', beginn: '2026-12-08T19:00:00', ort: 'Sitzungszimmer', kategorie: 'sitzung' });
  assert.equal(gesendet.methode, 'POST');
  assert.equal(gesendet.pfad, '/api/stweg/3/events');
  assert.ok(t.terminAusFormular(gesendet.body).werte, 'Formular ok');
  // Ausschuss STWEG 3 nach der Migration (Recht write): erlaubt; in STWEG 5 nicht
  const recht = RECHTE_MIGRATIONEN.find(x => x.page === 'stweg-termine').gruppen.includes('stweg3-ausschuss') ? 'write' : 'none';
  assert.equal(t.termineSchreibErlaubt(['stweg3-ausschuss', 'r9-eigentuemer'], 3, recht), true);
  assert.equal(t.termineSchreibErlaubt(['stweg3-ausschuss', 'r9-eigentuemer'], 5, recht), false);
});
