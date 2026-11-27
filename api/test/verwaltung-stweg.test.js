// node --test api/test/verwaltung-stweg.test.js — Hausverwaltung je STWEG
// (stwegN-verwaltung, meg-verwaltung): Verwaltung STWEG 3 sieht nichts von STWEG 5,
// ein Verwalter ist kein Bewohner, die alte Gruppe „Verwaltung“ gilt im Übergang
// als alle STWEGs. Dazu B12/B21 (Reklamationen, Auslagen) und B19 (Vollmachten).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const g = require('../lib/groups');
const { stwegSicht, sichtErlaubt, sichtLeer, sichtSql } = require('../lib/stweg-sicht');
const vr = require('../lib/vollmacht-rechte');
const { darfEchteNummernSehen } = require('../lib/nummernsicht');

const VERW3 = ['stweg3-verwaltung'];
const VERW5 = ['stweg5-verwaltung'];
const MEG = ['meg-verwaltung'];
const ALT = ['Verwaltung'];                       // Übergang
const FIRMA_ALLE = Object.values(g.VERWALTUNG_GROUPS);
const AUSSCHUSS3 = ['stweg3-ausschuss'];
const BEWOHNER5 = ['stweg5-bewohner'];

test('Gruppen: eine je STWEG 1–8, STWEG 8 heisst meg-verwaltung', () => {
  assert.deepEqual(Object.keys(g.VERWALTUNG_GROUPS).map(Number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(g.VERWALTUNG_GROUPS[3], 'stweg3-verwaltung');
  assert.equal(g.VERWALTUNG_GROUPS[8], 'meg-verwaltung');
  // gleiche STWEG-Nummern wie STWEG_GROUPS (dort gibt es auch 8 = MEG)
  assert.deepEqual(Object.keys(g.VERWALTUNG_GROUPS), Object.keys(g.STWEG_GROUPS));
});

test('verwaltungStwegs: nur die eigene STWEG, Gross/Klein egal', () => {
  assert.deepEqual([...g.verwaltungStwegs(VERW3)], [3]);
  assert.deepEqual([...g.verwaltungStwegs(['STWEG5-Verwaltung'])], [5]);
  assert.deepEqual([...g.verwaltungStwegs(MEG)], [8]);
  assert.deepEqual([...g.verwaltungStwegs(['stweg3-verwaltung', 'stweg5-verwaltung'])].sort(), [3, 5]);
  assert.equal(g.verwaltungStwegs(BEWOHNER5).size, 0);
  assert.equal(g.verwaltungStwegs(['bewohner-verwaltung']).size, 0);
  assert.equal(g.isVerwaltungFor(VERW3, 3), true);
  assert.equal(g.isVerwaltungFor(VERW3, 5), false);
  assert.equal(g.isVerwaltungFor(VERW3, null), false);
  assert.equal(g.isVerwaltungForAny(VERW3), true);
  assert.equal(g.isVerwaltungForAny(AUSSCHUSS3), false);
});

test('Übergang: alte Gruppe „Verwaltung“ gilt als alle STWEGs', () => {
  assert.deepEqual([...g.verwaltungStwegs(ALT)].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(g.verwaltetAlleStwegs(ALT), true);
  assert.equal(g.istVerwaltungUebergang(ALT), true);
  assert.equal(g.istVerwaltungUebergang(VERW3), false);
  // ohne Übergang: nur die Gruppen je STWEG
  assert.equal(g.verwaltungGruppenStwegs(ALT).size, 0);
});

test('Firma in allen acht Gruppen verwaltet alle STWEGs, eine Gruppe nicht', () => {
  assert.equal(g.verwaltetAlleStwegs(FIRMA_ALLE), true);
  assert.equal(g.verwaltetAlleStwegs(VERW3), false);
  assert.equal(g.verwaltetAlleStwegs(FIRMA_ALLE.filter(x => x !== 'meg-verwaltung')), false);
});

test('Ein Verwalter ist kein Bewohner: getUserStwegs kennt die Verwaltungsgruppen nicht', () => {
  assert.equal(g.getUserStwegs(VERW3).size, 0);
  assert.equal(g.getUserStwegs(ALT).size, 0);
  assert.deepEqual([...g.getStwegsMitVerwaltung(VERW3)], [3]);
  assert.deepEqual([...g.getStwegsMitVerwaltung([...VERW3, ...BEWOHNER5])].sort(), [3, 5]);
});

test('istVerwaltungsGruppenName', () => {
  for (const n of [...FIRMA_ALLE, 'verwaltung', 'Verwaltung', 'STWEG3-VERWALTUNG']) assert.equal(g.istVerwaltungsGruppenName(n), true, n);
  for (const n of ['bewohner-verwaltung', 'wohnungsverwaltung', 'stweg9-verwaltung', 'stweg3-ausschuss', '']) assert.equal(g.istVerwaltungsGruppenName(n), false, n);
});

// ─── Reklamationen / Auslagen (B12, B21) ─────────────────────────────
test('stwegSicht: Verwaltung STWEG 3 sieht STWEG 3, nicht STWEG 5 und nicht ohne STWEG', () => {
  const s = stwegSicht(VERW3);
  assert.equal(s.alle, false);
  assert.deepEqual(s.stwegs, [3]);
  assert.equal(sichtErlaubt(s, 3), true);
  assert.equal(sichtErlaubt(s, '3'), true);
  assert.equal(sichtErlaubt(s, 5), false);
  assert.equal(sichtErlaubt(s, null), false);
  assert.equal(sichtLeer(s), false);
});

test('stwegSicht: Verwaltung STWEG 5 sieht nichts von STWEG 3', () => {
  const s = stwegSicht(VERW5);
  assert.equal(sichtErlaubt(s, 3), false);
  assert.equal(sichtErlaubt(s, 5), true);
});

test('stwegSicht: Verwaltung aller STWEGs (und Übergang) sieht auch Einträge ohne STWEG', () => {
  for (const grp of [FIRMA_ALLE, ALT]) {
    const s = stwegSicht(grp);
    assert.deepEqual(s.stwegs, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(sichtErlaubt(s, null), true);
    assert.equal(sichtErlaubt(s, 8), true);
  }
});

test('stwegSicht: Ausschuss und Technik wie bisher, Bewohner nur eigene Meldungen', () => {
  const a = stwegSicht(AUSSCHUSS3);
  assert.deepEqual(a.stwegs, [3]);
  assert.equal(sichtErlaubt(a, null), true);        // Ausschuss: ohne STWEG wie bisher
  assert.equal(sichtErlaubt(a, 5), false);
  assert.equal(stwegSicht(['technik']).alle, true);
  assert.equal(stwegSicht(['Präsident']).alle, true);
  assert.equal(sichtLeer(stwegSicht(BEWOHNER5)), true);
  // Ausschuss 3 + Verwaltung 5: beide STWEGs
  assert.deepEqual(stwegSicht([...AUSSCHUSS3, ...VERW5]).stwegs, [3, 5]);
});

test('sichtSql baut die Bedingung samt Parametern', () => {
  let p = [7];
  assert.equal(sichtSql(stwegSicht(VERW3), 'r.stweg', p), '(r.stweg = ANY($2::int[]))');
  assert.deepEqual(p, [7, [3]]);
  p = [];
  assert.equal(sichtSql(stwegSicht(AUSSCHUSS3), 'r.stweg', p), '(r.stweg = ANY($1::int[]) OR r.stweg IS NULL)');
  p = [];
  assert.equal(sichtSql(stwegSicht(['technik']), 'r.stweg', p), 'TRUE');
  assert.deepEqual(p, []);
  assert.equal(sichtSql(stwegSicht(BEWOHNER5), 'r.stweg', []), 'FALSE');
});

// ─── Vollmachten (B19) ───────────────────────────────────────────────
test('Vollmachten: Verwaltung sieht ihre STWEG nur mit Seitenrecht „vollmachten“', () => {
  assert.deepEqual(vr.vmSicht(VERW3, 'read').stwegs, [3]);
  assert.deepEqual(vr.vmSicht(VERW3, 'write').stwegs, [3]);
  assert.deepEqual(vr.vmSicht(VERW3, undefined).stwegs, []);
  assert.equal(vr.vmSichtErlaubt(vr.vmSicht(VERW3, 'read'), 5), false);
  assert.equal(vr.vmSichtErlaubt(vr.vmSicht(VERW3, 'read'), null), false);
  assert.equal(vr.vmSichtErlaubt(vr.vmSicht(ALT, 'read'), null), true);
});

test('Vollmachten: für Dritte erfassen / Papier aktivieren nur mit „schreiben“ und nur eigene STWEG', () => {
  assert.equal(vr.vmDarfVerwalten(VERW3, 'read', 3), false);   // B19: lesen reicht nicht
  assert.equal(vr.vmDarfVerwalten(VERW3, 'write', 3), true);
  assert.equal(vr.vmDarfVerwalten(VERW3, 'write', 5), false);
  assert.equal(vr.vmDarfVerwalten(VERW3, 'write', null), false);
  assert.equal(vr.vmDarfVerwalten(FIRMA_ALLE, 'write', null), true);
  assert.equal(vr.vmDarfVerwalten(ALT, 'read', 3), false);
  assert.equal(vr.vmDarfFuerAndereIrgendwo(VERW3, 'read'), false);
  assert.equal(vr.vmDarfFuerAndereIrgendwo(VERW3, 'write'), true);
});

test('Vollmachten: Technik, Präsident, Ausschuss unverändert', () => {
  assert.equal(vr.vmDarfVerwalten(['technik'], undefined, 5), true);
  assert.equal(vr.vmDarfVerwalten(['Präsident'], undefined, null), true);
  assert.equal(vr.vmSicht(['technik'], undefined).alle, true);
  // Ausschuss sieht seine STWEG ohne Seitenrecht, erfasst aber nicht für Dritte
  assert.deepEqual(vr.vmSicht(AUSSCHUSS3, undefined).stwegs, [3]);
  assert.equal(vr.vmDarfVerwalten(AUSSCHUSS3, 'write', 3), false);
  // Widerrufen bleibt Technik/Präsident/Vollmachtgeber (lib/vollmacht-rechte.js, B11)
  assert.equal(vr.darfWiderrufenRecht(VERW3, false), false);
});

// ─── Kontakte der Verwaltung, Telefonnummern ─────────────────────────
test('Verwaltungs-Kontakte: die Verwaltung sieht ihre eigene, nicht die einer anderen STWEG', () => {
  assert.equal(g.canSeeVerwaltungKontakte(VERW3, 3, 'technik_praesident'), true);
  assert.equal(g.canSeeVerwaltungKontakte(VERW3, 5, 'ausschuss'), false);
  assert.equal(g.canSeeVerwaltungKontakte(VERW3, null, 'ausschuss'), true);
});

test('Telefonnummern: Verwaltung STWEG 3 sieht im Portal echte Nummern nur in STWEG 3', () => {
  const verw = { email: 'sb@verwaltung.example', groups: VERW3 };
  assert.equal(darfEchteNummernSehen(verw, { email: 'a@example.org', stweg: 3 }, { kanal: 'portal' }), true);
  assert.equal(darfEchteNummernSehen(verw, { email: 'b@example.org', stweg: 5 }, { kanal: 'portal' }), false);
  assert.equal(darfEchteNummernSehen(verw, { email: 'a@example.org', stweg: 3 }, { kanal: 'verzeichnis' }), false);
});

// ─── Quelltext: keine globalen Verwaltungs-Prüfungen mehr ────────────
const WURZEL = path.join(__dirname, '..', '..');
const lies = (rel) => fs.readFileSync(path.join(WURZEL, rel), 'utf8');

test('server.js, MCP und Seiten prüfen die Gruppe „verwaltung“ nicht mehr direkt', () => {
  const muster = /(===\s*'verwaltung'|includes\('verwaltung'\)|'verwaltung'\s*\]\.includes)/;
  for (const datei of ['api/server.js', 'api/mcp/index.js', 'api/lib/nummernsicht.js', 'objektverwaltung.html', 'vollmachten.html']) {
    const zeilen = lies(datei).split('\n').filter(z => muster.test(z))
      // Kategorie der Mail-Empfaenger und Bevollmaechtigten-Typ sind keine Gruppen
      .filter(z => !/kategorie|bevollmaechtigter_typ|\btyp\b/.test(z))
      // die gekennzeichnete Übergangs-Prüfung (alte Gruppe = alle STWEGs)
      .filter(z => !/[Uu]ebergang|ÜBERGANG/.test(z));
    assert.deepEqual(zeilen, [], datei);
  }
});

test('Seed: Seitenrechte für alle Verwaltungsgruppen, wie bisher „Verwaltung“', () => {
  const s = lies('api/server.js');
  assert.match(s, /for \(const groupName of Object\.values\(VERWALTUNG_GROUPS\)\)/);
  const block = s.slice(s.indexOf('const VERWALTUNG_SEITENRECHTE'), s.indexOf('for (const groupName of Object.values(VERWALTUNG_GROUPS))'));
  for (const [page, access] of [['objektverwaltung', 'write'], ['wohnungsverwaltung', 'write'], ['reklamationen', 'write'], ['handwerker', 'write'],
    ['vollmachten', 'write'], ['auslagen', 'read'], ['energie-monitor', 'read'], ['projekte', 'write'], ['kontakte', 'read'], // projekte write: anlegen je STWEG (Entscheid 27.11.2026)
    ['verwaltung', 'read'], ['email-verteiler', 'write'], ['bewohner-verwaltung', 'read']]) { // email-verteiler write: senden im Portal (V10)
    assert.ok(block.includes(`['${page}', '${access}']`), `${page}=${access} fehlt`);
  }
  assert.match(s, /ON CONFLICT \(group_name, page\) DO NOTHING`, \[groupName, page, access\]/);
});

test('STWEG-Zugriff und Schreibrecht kennen die Verwaltung der STWEG', () => {
  const s = lies('api/server.js');
  const zugriff = s.slice(s.indexOf('function requireStwegAccess'), s.indexOf('function requireStwegAccess') + 900);
  assert.match(zugriff, /isVerwaltungFor\(groups, stweg\)/);
  const schreib = s.slice(s.indexOf('function stwegSchreibErlaubt'), s.indexOf('function requireStwegWrite'));
  assert.match(schreib, /isVerwaltungFor\(groups, nr\)/);
  assert.doesNotMatch(schreib, /'verwaltung'/);
});

// ─── Verteiler (Rundmails empfangen, nur eigene STWEG beschreiben) ───
const vv = require('../lib/verteiler-verwaltung');

test('Bewohner-Rundmail einer STWEG geht auch an deren Verwaltung', () => {
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 3, group_names: ['r9-bewohner'] }), 'stweg3-verwaltung');
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 5, group_names: ['stweg5-eigentuemer'] }), 'stweg5-verwaltung');
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 8, group_name: 'meg-bewohner' }), 'meg-verwaltung');
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 3, group_names: ['verwaltung:bewohner:stweg=3'] }), 'stweg3-verwaltung');
  // Ausschuss-Verteiler, fremde STWEG-Gruppe, ohne Gruppen: nicht
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 3, group_names: ['stweg3-ausschuss'] }), null);
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 3, group_names: ['stweg5-bewohner'] }), null);
  assert.equal(vv.verwaltungsGruppeFuerVerteiler({ stweg: 3, members: ['a@example.org'] }), null);
});

test('Verwaltung STWEG 3 darf an Verteiler von STWEG 3 senden, nicht an STWEG 5', () => {
  assert.equal(vv.verwaltungsGruppeDarfSenden(['stweg3-verwaltung'], { stweg: 3 }), true);
  assert.equal(vv.verwaltungsGruppeDarfSenden(['stweg3-verwaltung'], { stweg: 5 }), false);
  assert.equal(vv.verwaltungsGruppeDarfSenden(['meg-verwaltung'], { stweg: 8 }), true);
  assert.equal(vv.verwaltungsGruppeDarfSenden(['r9-bewohner'], { stweg: 3 }), false);
});

test('Server: Verwaltungs-Absender nur für die STWEG des Verteilers, Ordner lesen', () => {
  const s = lies('api/server.js');
  assert.match(s, /isActiveVerwaltungEmail\(senderEmailLower, list\.stweg\)/);
  assert.match(s, /\$1::int IS NULL OR v\.stweg IS NULL OR v\.stweg = \$1::int/);
  const doc = s.slice(s.indexOf('function isDocPathAllowed'), s.indexOf('function isDocPathAllowed') + 1200);
  assert.match(doc, /getStwegsMitVerwaltung\(groups\)/);
  const tab = lies('fileserver-lxc/ordnerrechte/tabelle.txt');
  for (const [ordner, gruppe] of [['stweg1', 'stweg1-verwaltung'], ['stweg3', 'stweg3-verwaltung'], ['stweg6', 'stweg6-verwaltung'], ['meg', 'meg-verwaltung'], ['stweg8', 'meg-verwaltung']]) {
    const zeile = tab.split('\n').find(z => z.startsWith(ordner + ' '));
    assert.ok(zeile && zeile.split('|')[1].includes(gruppe), `${ordner}: ${gruppe} fehlt als Leser`);
    assert.ok(!zeile.split('|')[2].includes('verwaltung'), `${ordner}: Verwaltung darf nicht schreiben`);
  }
});

test('Reklamations-Stammdaten und ZEV: Verwaltung der STWEG', () => {
  const s = lies('api/server.js');
  // Regel liegt in lib/rekl-uebersicht.js (stwegSchreibbar), server.js nutzt sie
  assert.match(s, /const reklStwegSchreibbar = require\('\.\/lib\/rekl-uebersicht'\)\.stwegSchreibbar;/);
  const l = lies('api/lib/rekl-uebersicht.js');
  const rekl = l.slice(l.indexOf('function stwegSchreibbar'), l.indexOf('function stwegSchreibbar') + 400);
  assert.match(rekl, /isVerwaltungFor\(g, n\)/);
  assert.match(s, /const zevStwegs = \[\.\.\.new Set\(\[\.\.\.getAusschussStwegs\(g\), \.\.\.verwaltungStwegs\(g\)\]\)\]/);
});
