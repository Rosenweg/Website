// node --test api/test/handwerker-stweg.test.js — Handwerker je STWEG
// (Klärung Welle 3.3, F1/F5/L1; Entscheid Stefan 28.11.2026): die Verwaltung
// liest/schreibt Verträge, Einsätze, Kosten und Notfall-Zuordnungen nur ihrer
// STWEG, legt Firmen an; „alle STWEG“ und Event-Typen nur Technik/Präsident;
// der Ausschuss liest seine STWEG.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hw = require('../lib/handwerker-rechte');
const { RECHTE_MIGRATIONEN } = require('../lib/rechte-migrationen');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'handwerker.html'), 'utf8');

const tp = hw.handwerkerSicht(['technik']);
const praes = hw.handwerkerSicht(['Präsident']);
const verw3 = hw.handwerkerSicht(['stweg3-verwaltung']);
const aus3 = hw.handwerkerSicht(['stweg3-ausschuss']);
const andere = hw.handwerkerSicht(['r9-bewohner']);

test('Sicht: Technik/Präsident alles, Verwaltung eigene STWEG, Ausschuss nur lesen', () => {
  assert.equal(tp.alle, true);
  assert.equal(praes.alle, true);
  assert.equal(hw.hwSchreiben(tp, null), true, 'alle STWEG: T/P');
  assert.equal(hw.hwSchreiben(praes, 5), true);

  assert.equal(hw.hwLesen(verw3, 3), true);
  assert.equal(hw.hwLesen(verw3, null), true, '„alle STWEG“ sichtbar');
  assert.equal(hw.hwLesen(verw3, 5), false, 'fremde STWEG unsichtbar (Kosten!)');
  assert.equal(hw.hwSchreiben(verw3, 3), true);
  assert.equal(hw.hwSchreiben(verw3, null), false, '„alle STWEG“ nur T/P');
  assert.equal(hw.hwSchreiben(verw3, 5), false);

  assert.equal(hw.hwLesen(aus3, 3), true);
  assert.equal(hw.hwLesen(aus3, 5), false);
  assert.equal(hw.hwSchreiben(aus3, 3), false, 'Ausschuss nur lesen');

  assert.equal(hw.hwLesen(andere, null), true);
  assert.equal(hw.hwLesen(andere, 3), false);
  assert.equal(hw.hwSchreiben(andere, 3), false);
});

test('Firmen: Verwaltung legt für ihre STWEG an, T/P frei, Ausschuss nicht', () => {
  assert.equal(hw.hwFirmaAnlegen(verw3), true);
  assert.equal(hw.hwFirmaAnlegen(aus3), false);
  assert.deepEqual(hw.hwNeueFirmaStweg(verw3, ''), { stweg: 3 });
  assert.deepEqual(hw.hwNeueFirmaStweg(verw3, 3), { stweg: 3 });
  assert.ok(hw.hwNeueFirmaStweg(verw3, 5).fehler);
  assert.deepEqual(hw.hwNeueFirmaStweg(tp, ''), { stweg: null }, 'T/P: gemeinsamer Stamm');
  assert.deepEqual(hw.hwNeueFirmaStweg(tp, 4), { stweg: 4 });
  const zwei = hw.handwerkerSicht(['stweg3-verwaltung', 'stweg5-verwaltung']);
  assert.match(hw.hwNeueFirmaStweg(zwei, null).fehler, /^Bitte/);
  // ÜBERGANG: alte globale Gruppe „Verwaltung“ = alle STWEG, aber nicht „alle STWEG“-Einträge
  const alt = hw.handwerkerSicht(['Verwaltung']);
  assert.equal(hw.hwSchreiben(alt, 7), true);
  assert.equal(hw.hwSchreiben(alt, null), false);
  assert.equal(hw.hwEventTypen(verw3), false);
  assert.equal(hw.hwEventTypen(tp), true);
});

test('Zuordnungen: fremde bleiben, „alle STWEG“ fest, eigene ersetzt das Formular', () => {
  const bestand = [
    { event_typ_id: 1, prioritaet: 1, stweg: null, hinweis: 'Siedlung' },
    { event_typ_id: 1, prioritaet: 2, stweg: 5, hinweis: null },
    { event_typ_id: 2, prioritaet: 1, stweg: 3, hinweis: 'alt' },
  ];
  // Seite schickt, was die Verwaltung 3 sieht: alle-STWEG unverändert, eigene geändert
  const ok = hw.zuweisungenZusammenfuehren(verw3, bestand, [
    { event_typ_id: '1', prioritaet: '1', stweg: '', hinweis: 'Siedlung' },
    { event_typ_id: '2', prioritaet: '1', stweg: '3', hinweis: 'neu' },
  ]);
  assert.ok(ok.liste, ok.fehler);
  assert.deepEqual(ok.liste.map(z => `${z.event_typ_id}/${z.stweg}/${z.hinweis}`).sort(),
    ['1/5/null', '1/null/Siedlung', '2/3/neu'].sort());
  // „alle STWEG“ entfernen oder neu anlegen: abgelehnt
  assert.ok(hw.zuweisungenZusammenfuehren(verw3, bestand, [{ event_typ_id: 2, prioritaet: 1, stweg: 3 }]).fehler);
  assert.ok(hw.zuweisungenZusammenfuehren(verw3, bestand, [
    { event_typ_id: 1, prioritaet: 1, stweg: null, hinweis: 'Siedlung' }, { event_typ_id: 3, stweg: null }]).fehler);
  // fremde STWEG anlegen: abgelehnt
  assert.ok(hw.zuweisungenZusammenfuehren(verw3, bestand, [
    { event_typ_id: 1, prioritaet: 1, stweg: null, hinweis: 'Siedlung' }, { event_typ_id: 3, stweg: 5 }]).fehler);
  // T/P: Formular gilt ganz
  assert.equal(hw.zuweisungenZusammenfuehren(tp, bestand, []).liste.length, 0);
});

test('Routen: jede schreibende mit Recht, Kartenvermerk und STWEG-Prüfung', () => {
  assert.match(server, /const hwSchreibend = \[requirePermission\('handwerker', 'write'\), kartenAdmin\.mitKarteProtokollieren\];/);
  const schreibend = [
    "app.post('/api/handwerker', authMiddleware, ...hwSchreibend",
    "app.put('/api/handwerker/:id', authMiddleware, ...hwSchreibend",
    "app.put('/api/handwerker/:id/zuweisungen', authMiddleware, ...hwSchreibend",
    "app.delete('/api/handwerker/:id', authMiddleware, ...hwSchreibend",
    "app.post([encodeURI('/api/handwerker/:id/verträge'), '/api/handwerker/:id/vertraege'], authMiddleware, ...hwSchreibend",
    "app.put([encodeURI('/api/handwerker/:id/verträge/:vid'), '/api/handwerker/:id/vertraege/:vid'], authMiddleware, ...hwSchreibend",
    "app.delete([encodeURI('/api/handwerker/:id/verträge/:vid'), '/api/handwerker/:id/vertraege/:vid'], authMiddleware, ...hwSchreibend",
    "app.post([encodeURI('/api/handwerker/:id/aufträge'), '/api/handwerker/:id/auftraege'], authMiddleware, ...hwSchreibend",
    "app.put([encodeURI('/api/handwerker/:id/aufträge/:aid'), '/api/handwerker/:id/auftraege/:aid'], authMiddleware, ...hwSchreibend",
    "app.delete([encodeURI('/api/handwerker/:id/aufträge/:aid'), '/api/handwerker/:id/auftraege/:aid'], authMiddleware, ...hwSchreibend",
  ];
  for (const r of schreibend) assert.ok(server.includes(r), r);
  for (const m of ['post', 'put', 'delete']) {
    assert.match(server, new RegExp(`app\\.${m}\\('/api/handwerker-events[^']*', authMiddleware, \\.\\.\\.hwSchreibend, requireHwEventTypen`), m);
  }
  // Keine schreibende Handwerker-Route mehr ohne hwSchreibend
  assert.doesNotMatch(server, /app\.(post|put|delete)\((\[[^\]]*\/api\/handwerker[^\]]*\]|[^,\[]*\/api\/handwerker[^,]*), authMiddleware, requirePermission\('handwerker', 'write'\)/);
  // Hart löschen: T/P (nicht mehr nur Gruppe technik per Textvergleich)
  assert.match(server, /if \(!sicht\.alle\) return res\.status\(403\)\.json\(\{ error: 'Hartes Löschen nur für Technik und Präsident' \}\)/);
});

test('Lesen: Liste, Verträge, Einsätze, Anstehend, Notfall, Dashboard nach Sicht', () => {
  const lesend = ["app.get('/api/handwerker', ", "app.get([encodeURI('/api/handwerker/:id/verträge'), '/api/handwerker/:id/vertraege']", "app.get([encodeURI('/api/handwerker/:id/aufträge'), '/api/handwerker/:id/auftraege']",
    "app.get([encodeURI('/api/handwerker-verträge/anstehend'), '/api/handwerker-vertraege/anstehend']", "app.get('/api/handwerker-notfall'", "app.get('/api/handwerker/kategorien'"];
  for (const r of lesend) {
    const i = server.indexOf(r);
    assert.ok(i > 0, r);
    assert.match(server.slice(i, i + 1400), /hwSichtSql|hwFirmaLesbar/, r);
  }
  const d = server.indexOf('4) Anstehende Handwerker-Verträge');
  assert.match(server.slice(d, d + 900), /hwSichtSql\(hwSicht, 'v\.stweg'/);
});

test('Migration: Spalte handwerker.stweg, bestehende Firmen bleiben gemeinsam (NULL)', () => {
  assert.match(server, /ALTER TABLE handwerker ADD COLUMN IF NOT EXISTS stweg INTEGER;/);
  const m = RECHTE_MIGRATIONEN.find(x => x.name === '2026-11-28-handwerker-ausschuss-read');
  assert.ok(m);
  assert.equal(m.page, 'handwerker');
  assert.equal(m.access, 'read');
  assert.ok(m.gruppen.includes('stweg3-ausschuss') && m.gruppen.includes('meg-ausschuss'));
});

test('Telefonbuch bleibt unverändert (alle Firmen und Mitarbeiter)', () => {
  const tb = fs.readFileSync(path.join(__dirname, '..', 'lib', 'telefonbuch.js'), 'utf8');
  assert.doesNotMatch(tb, /handwerker-rechte|hwSicht/);
});

test('Seite: Knöpfe nach den Rechten des Servers', () => {
  assert.match(html, /if \(data\.rechte\) hwRechte = data\.rechte;/);
  assert.match(html, /\$\('btn-manage-events'\)\.classList\.toggle\('hidden', !hwRechte\.event_typen\)/);
  assert.match(html, /\/api\/handwerker\/\$\{id\}\/zuweisungen/);
  assert.match(html, /const fest = z\.event_typ_id != null && !hwDarf\(z\.stweg\);/);
});

test('Stammdaten: Verwaltung auch beim gemeinsamen Stamm, protokolliert; archivieren/löschen nicht', () => {
  assert.equal(hw.hwStammAendern(verw3, null), true, 'gemeinsamer Stamm');
  assert.equal(hw.hwStammAendern(verw3, 3), true);
  assert.equal(hw.hwStammAendern(verw3, 5), false, 'fremde STWEG');
  assert.equal(hw.hwStammAendern(aus3, null), false, 'Ausschuss nur lesen');
  assert.equal(hw.hwStammAendern(andere, null), false);
  assert.equal(hw.hwStammAendern(tp, 5), true);
  assert.equal(hw.hwFirmaArchivieren(verw3, null), false, 'gemeinsamen Stamm archivieren nur T/P');
  assert.equal(hw.hwFirmaArchivieren(verw3, 3), true);
  assert.equal(hw.hwFirmaArchivieren(praes, null), true);
  assert.deepEqual(hw.hwGeaenderteFelder({ firma: 'A', telefon: '1', leistungen: ['x'] }, { firma: 'A', telefon: '2', leistungen: ['x'] }), ['telefon']);
  const put = server.slice(server.indexOf("app.put('/api/handwerker/:id', "), server.indexOf("app.put('/api/handwerker/:id/zuweisungen'"));
  assert.match(put, /hwRechteLib\.hwStammAendern\(sicht, firma\.stweg\)/);
  assert.match(put, /hwRechteLib\.hwFirmaArchivieren\(sicht, firma\.stweg\)/);
  assert.match(put, /objProtokoll\(req, 'handwerker', 'firma-geaendert'/);
  assert.match(server, /objProtokoll\(req, 'handwerker', 'firma-angelegt'/);
  assert.match(server, /objProtokoll\(req, 'handwerker', 'firma-archiviert'/);
  assert.match(server, /objProtokoll\(req, 'handwerker', 'firma-geloescht'/);
  const del = server.slice(server.indexOf("app.delete('/api/handwerker/:id', "));
  assert.match(del.slice(0, 1500), /if \(!hwRechteLib\.hwFirmaArchivieren\(sicht, firma\.stweg\)\)/);
  assert.match(html, /h\.darf_archivieren/);
});
