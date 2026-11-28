// node --test api/test/zev-app.test.js — API fuer Rosenweg ZEV (App):
// L6 Admin-Daten nur fuer Ausschuss/Verwaltung GENAU DIESER STWEG und T/P,
// L1 Uebersicht mit Rechten, L2 ISO-Datumsfelder, L3 Statistik auf dem Server,
// L5 PDF fuer Admins nur unzugeordnet/Allgemeinzaehler, L8 Neuigkeiten,
// L9 Wechselmeldungen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const z = require('../lib/zev');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = (kopf) => {
  const i = SRC.indexOf(kopf);
  assert.ok(i > 0, kopf);
  return SRC.slice(i, SRC.indexOf('\napp.', i + 10));
};

// ─── L6 ───────────────────────────────────────────────────────────────────
test('L6: Admin-Daten nur Ausschuss/Verwaltung dieser STWEG, Technik, Präsident', () => {
  assert.equal(z.zevAdminFuerStweg(['stweg3-ausschuss'], 3), true);
  assert.equal(z.zevAdminFuerStweg(['stweg3-verwaltung'], 3), true);
  assert.equal(z.zevAdminFuerStweg(['technik'], 3), true);
  assert.equal(z.zevAdminFuerStweg(['Präsident'], 7), true);
  assert.equal(z.zevAdminFuerStweg(['praesident'], 7), true);
  // Ausschuss einer ANDEREN STWEG, der in Haus 9 wohnt bzw. Eigentum hat
  assert.equal(z.zevAdminFuerStweg(['stweg5-ausschuss', 'r9-bewohner'], 3), false);
  assert.equal(z.zevAdminFuerStweg(['stweg5-ausschuss', 'r9-eigentuemer'], 3), false);
  assert.equal(z.zevAdminFuerStweg(['stweg5-verwaltung', 'r9-bewohner'], 3), false);
  // Bewohner/Eigentümer allein nie
  assert.equal(z.zevAdminFuerStweg(['r9-bewohner'], 3), false);
  assert.equal(z.zevAdminFuerStweg(['r9-eigentuemer'], 3), false);
  assert.equal(z.zevAdminFuerStweg([], 3), false);
  assert.equal(z.zevAdminFuerStweg(['stweg3-ausschuss'], 'x'), false);
});

test('L6: GET config und wohnungen prüfen die Regel (nicht nur requireStwegAccess)', () => {
  for (const kopf of ["app.get('/api/zev/config/:stweg'", "app.get('/api/zev/wohnungen/:stweg'"]) {
    const zeile = route(kopf).split('\n')[0];
    assert.match(zeile, /requirePermission\('wohnungsverwaltung', 'read'\)/, kopf);
    assert.match(zeile, /requireZevAdmin/, kopf);
  }
  const mw = SRC.slice(SRC.indexOf('function requireZevAdmin('), SRC.indexOf('function requireZevAdmin(') + 400);
  assert.match(mw, /zevAdminFuerStweg\(req\.user\?\.groups \|\| \[\], stweg\)/);
  assert.match(mw, /status\(403\)/);
  // Liste zum Umhängen und Wechselmeldungen mit derselben Regel
  assert.match(route("app.get('/api/zev/rechnungen/:stweg'"), /zevAdminFuerStweg\(g, stweg\)/);
  assert.match(route("app.get('/api/zev/wechsel/:stweg'").split('\n')[0], /requireZevAdmin/);
});

// ─── L1 ───────────────────────────────────────────────────────────────────
test('L1: Rechte je STWEG aus Seitenrecht und Gruppe', () => {
  assert.deepEqual(z.zevRechte(['stweg3-ausschuss'], 3, 'write'), { lesen: true, schreiben: true, alias: false });
  assert.deepEqual(z.zevRechte(['stweg3-verwaltung'], 3, 'read'), { lesen: true, schreiben: false, alias: false });
  assert.deepEqual(z.zevRechte(['stweg3-ausschuss'], 3, 'none'), { lesen: false, schreiben: false, alias: false });
  assert.deepEqual(z.zevRechte(['stweg5-ausschuss', 'r9-bewohner'], 3, 'write'), { lesen: false, schreiben: false, alias: false });
  assert.deepEqual(z.zevRechte(['technik'], 3, 'none'), { lesen: true, schreiben: true, alias: true });
  assert.deepEqual(z.zevRechte(['präsident'], 3, undefined), { lesen: true, schreiben: true, alias: true });
});

test('L1: /api/zev/uebersicht für alle Angemeldeten, Admin-Teile nur mit Recht', () => {
  const r = route("app.get('/api/zev/uebersicht'");
  assert.match(r.split('\n')[0], /authMiddleware, async/);
  assert.match(r, /zevRechte\(g, c\.stweg, zugriff\)/);
  assert.match(r, /\.filter\(z => z\.aktiv \|\| z\.rechte\.lesen\)/, 'inaktive nur für Admins');
  assert.match(r, /unzugeordnet: z\.rechte\.lesen \?/);
  assert.match(r, /if \(tp\) ohneStweg = x\.n/);
  assert.match(r, /einrichtbar: tp \?/);
  assert.doesNotMatch(r, /bewohner_email|alias_address/, 'keine Personendaten');
});

// ─── L2 ───────────────────────────────────────────────────────────────────
test('L2: ISO-Datum aus dd.mm.yyyy, alte Felder bleiben', () => {
  assert.equal(z.zevIsoDatum('01.10.2025'), '2025-10-01');
  assert.equal(z.zevIsoDatum('1.2.2026'), '2026-02-01');
  assert.equal(z.zevIsoDatum('2026-03-31'), '2026-03-31');
  assert.equal(z.zevIsoDatum(new Date('2026-04-05T10:00:00Z')), '2026-04-05');
  assert.equal(z.zevIsoDatum('31.02.2026'), null);
  assert.equal(z.zevIsoDatum('irgendwas'), null);
  assert.equal(z.zevIsoDatum(null), null);
  const r = z.zevMitIso({ id: 1, rechnungsdatum: '15.01.2026', zeitraum_von: '01.10.2025', zeitraum_bis: '31.12.2025' });
  assert.equal(r.rechnungsdatum, '15.01.2026');
  assert.equal(r.rechnungsdatum_iso, '2026-01-15');
  assert.equal(r.zeitraum_von_iso, '2025-10-01');
  assert.equal(r.zeitraum_bis_iso, '2025-12-31');
  assert.ok(!('zeitraum_von_iso' in z.zevMitIso({ id: 2 })), 'nur vorhandene Felder');
  for (const kopf of ["app.get('/api/zev/meine-rechnungen'", "app.get('/api/zev/unzugeordnet'", "app.get('/api/zev/rechnungen/:stweg'"]) {
    assert.match(route(kopf), /zevMitIso/, kopf);
  }
});

// ─── L3 ───────────────────────────────────────────────────────────────────
test('L3: Statistik je Jahr, Solar nach Positionsname, Preise gemittelt', () => {
  const s = z.zevStatistik([
    { zeitraum_von: '01.01.2025', betrag_chf: '100.00', positionen: [
      { name: 'Solarstrom', kwh: 300, preis: 0.2, total: 60 },
      { name: 'Netzstrom HT', kwh: 100, preis: 0.3, total: 30 },
      { name: 'Grundgebühr', kwh: null, total: 10 },
    ] },
    { zeitraum_von: '01.07.2025', betrag_chf: 50, positionen: JSON.stringify([{ name: 'SOLAR', kwh: 100, total: 20 }]) },
    { zeitraum_von: null, rechnungsdatum: '10.01.2024', betrag_chf: 20, positionen: [{ name: 'Netz', kwh: 50, total: 15 }] },
    { zeitraum_von: 'kaputt', positionen: [{ name: 'Solar', kwh: 999 }] },
  ]);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { jahr: 2025, anzahl: 2, kwh: 500, solar_kwh: 400, netz_kwh: 100, solar_anteil: 80, chf: 150, rp_kwh_solar: 20, rp_kwh_netz: 30 });
  assert.equal(s[1].jahr, 2024);
  assert.equal(s[1].solar_anteil, 0);
  assert.equal(s[1].rp_kwh_solar, null);
  assert.deepEqual(z.zevStatistik([]), []);
  assert.match(route("app.get('/api/zev/meine-statistik'"), /zevStatistik\(await zevMeineRechnungen\(req\.user\)\)/);
});

// ─── L5 ───────────────────────────────────────────────────────────────────
test('L5: PDF für Admins nur unzugeordnet/Allgemeinzähler, Wohnungsrechnungen privat', () => {
  const unz = { stweg: 3, zuordnung: 'unzugeordnet' };
  const allg = { stweg: 3, zuordnung: 'allgemein' };
  const wohn = { stweg: 3, zuordnung: 'wohnung', wohnung_id: 7 };
  assert.equal(z.zevAdminDarfPdf(['stweg3-ausschuss'], unz, 'read'), true);
  assert.equal(z.zevAdminDarfPdf(['stweg3-verwaltung'], allg, 'read'), true);
  assert.equal(z.zevAdminDarfPdf(['stweg3-ausschuss'], { stweg: 3, zuordnung: null }, 'read'), true);
  assert.equal(z.zevAdminDarfPdf(['stweg3-ausschuss'], wohn, 'write'), false, 'Wohnungsrechnung privat');
  assert.equal(z.zevAdminDarfPdf(['technik'], wohn, 'write'), false, 'auch Technik nicht');
  assert.equal(z.zevAdminDarfPdf(['stweg5-ausschuss', 'r9-bewohner'], unz, 'write'), false, 'fremde STWEG');
  assert.equal(z.zevAdminDarfPdf(['stweg3-ausschuss'], unz, 'none'), false, 'ohne Seitenrecht');
  assert.equal(z.zevAdminDarfPdf(['stweg3-ausschuss'], { stweg: null, zuordnung: 'unzugeordnet' }, 'write'), false, 'ohne STWEG nur T/P');
  assert.equal(z.zevAdminDarfPdf(['technik'], { stweg: null, zuordnung: 'unzugeordnet' }), true);
  assert.equal(z.zevAdminDarfPdf(['r9-bewohner'], unz, 'read'), false);
  const r = route("app.get('/api/zev/rechnung/:id/pdf'");
  assert.match(r, /zevSichtbareRechnungen\(req\.user, \[row\]\)/);
  assert.match(r, /zevAdminDarfPdf\(req\.user\?\.groups \|\| \[\], row, await zevZugriff\(req\.user\)\)/);
  assert.match(r, /SELECT stweg, zuordnung, wohnung_id/);
});

// ─── L8 / L9 ──────────────────────────────────────────────────────────────
test('L8: Neuigkeiten klein, eigene über die Sichtregel, unzugeordnete nur Admins', () => {
  const r = route("app.get('/api/zev/neuigkeiten'");
  assert.match(r, /zevMeineRechnungen\(req\.user\)/);
  assert.doesNotMatch(r, /positionen|pdf_data|bewohner_email/);
  assert.match(r, /filter\(n => zevRechte\(g, n, zugriff\)\.lesen\)/);
  assert.match(r, /\$1::boolean OR stweg = ANY\(\$2::int\[\]\)/);
});

test('L9: Wechselmeldungen nur gemeldete (mit Outbox), ohne Baseline', () => {
  const r = route("app.get('/api/zev/wechsel/:stweg'");
  assert.match(r, /p\.outbox_queue_id IS NOT NULL/);
  assert.match(r, /q\.status AS outbox_status/);
});

test('L11: MCP-Werkzeug zev_abgleich heisst ehrlich Aliase/Mailcow', () => {
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'werkzeuge-verwaltung.js'), 'utf8');
  const i = mcp.indexOf("name: 'zev_abgleich'");
  const block = mcp.slice(i, mcp.indexOf('},\n  {', i));
  assert.doesNotMatch(block, /smart-me abgleichen|von smart-me holen/);
  assert.match(block, /Mailcow/);
});
