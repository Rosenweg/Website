// node --test api/test/handwerker-app.test.js — API für Rosenweg Handwerker (Welle 3.3, E7–E13)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ha = require('../lib/handwerker-app');
const hw = require('../lib/handwerker-rechte');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const routen = fs.readFileSync(path.join(__dirname, '..', 'routes', 'handwerker-app.js'), 'utf8');

const tp = hw.handwerkerSicht(['technik']);
const praes = hw.handwerkerSicht(['Präsident']);
const verw3 = hw.handwerkerSicht(['stweg3-verwaltung']);
const aus3 = hw.handwerkerSicht(['stweg3-ausschuss']);
const heute = new Date('2026-11-28T12:00:00Z');

const v = (o) => ({ id: 1, handwerker_id: 9, firma: 'Lift AG', titel: 'Wartung', stweg: 3, naechster_termin: null, endet_am: null, kuendigungsfrist_tage: null, ...o });

test('Tage und Stufen: 30, 7, überfällig', () => {
  assert.equal(ha.tageBis(heute, '2026-12-28'), 30);
  assert.equal(ha.tageBis(heute, '2026-11-28'), 0);
  assert.equal(ha.tageBis(heute, '2026-11-20'), -8);
  assert.equal(ha.tageBis(heute, 'kein Datum'), null);
  assert.equal(ha.stufe(31), null);
  assert.equal(ha.stufe(30), 30);
  assert.equal(ha.stufe(8), 30);
  assert.equal(ha.stufe(7), 7);
  assert.equal(ha.stufe(0), 7);
  assert.equal(ha.stufe(-1), 0);
});

test('Kündigungsfrist: Ende minus Frist', () => {
  assert.equal(ha.kuendigungBis({ endet_am: '2027-01-31', kuendigungsfrist_tage: 90 }), '2026-11-02');
  assert.equal(ha.kuendigungBis({ endet_am: '2027-01-31', kuendigungsfrist_tage: 0 }), '2027-01-31');
  assert.equal(ha.kuendigungBis({ endet_am: null, kuendigungsfrist_tage: 90 }), null);
  assert.equal(ha.kuendigungBis({ endet_am: '2027-01-31', kuendigungsfrist_tage: null }), null);
  assert.equal(ha.kuendigungBis({ endet_am: '2027-01-31', kuendigungsfrist_tage: '' }), null);
});

test('Erinnerungen: Termin und Kündigungsfrist, je Stufe ein Schlüssel', () => {
  const zeilen = [
    v({ id: 1, naechster_termin: '2026-12-20' }),                                 // 22 Tage -> 30
    v({ id: 2, naechster_termin: '2026-12-02' }),                                 // 4 Tage -> 7
    v({ id: 3, naechster_termin: '2026-11-01' }),                                 // überfällig
    v({ id: 4, naechster_termin: '2027-06-01' }),                                 // zu weit weg
    v({ id: 5, endet_am: '2027-02-10', kuendigungsfrist_tage: 75 }),              // Kündigung bis 2026-11-27 -> vorbei: nichts
    v({ id: 6, endet_am: '2027-01-15', kuendigungsfrist_tage: 30 }),              // bis 2026-12-16 -> 18 Tage -> 30
  ];
  const e = ha.erinnerungenFuer(verw3, zeilen, heute);
  assert.deepEqual(e.map(x => [x.vertrag_id, x.art, x.stufe]), [[3, 'termin', 0], [2, 'termin', 7], [6, 'kuendigung', 30], [1, 'termin', 30]], 'nach Tagen sortiert, Überfälliges zuerst')
  const ids = e.map(x => `${x.vertrag_id}:${x.art}:${x.stufe}`).sort();
  assert.deepEqual(ids, ['1:termin:30', '2:termin:7', '3:termin:0', '6:kuendigung:30']);
  assert.equal(e.find(x => x.vertrag_id === 1).schluessel, 'termin-1-2026-12-20-30');
  // dieselbe Erinnerung später in der Stufe 7: neuer Schlüssel -> neue Benachrichtigung
  const spaeter = ha.erinnerungenFuer(verw3, zeilen, new Date('2026-12-15T12:00:00Z'));
  assert.equal(spaeter.find(x => x.vertrag_id === 1).schluessel, 'termin-1-2026-12-20-7');
});

test('Erinnerungen: nur an die Verwaltung der STWEG; „alle STWEG“ an Technik/Präsident; Ausschuss nicht', () => {
  const zeilen = [v({ id: 1, stweg: 3, naechster_termin: '2026-12-02' }), v({ id: 2, stweg: 5, naechster_termin: '2026-12-02' }),
    v({ id: 3, stweg: null, naechster_termin: '2026-12-02' })];
  assert.deepEqual(ha.erinnerungenFuer(verw3, zeilen, heute).map(x => x.vertrag_id), [1]);
  assert.deepEqual(ha.erinnerungenFuer(tp, zeilen, heute).map(x => x.vertrag_id), [3]);
  assert.deepEqual(ha.erinnerungenFuer(praes, zeilen, heute).map(x => x.vertrag_id), [3]);
  assert.deepEqual(ha.erinnerungenFuer(aus3, zeilen, heute), []);
  assert.deepEqual(ha.erinnerungenFuer(hw.handwerkerSicht(['r9-bewohner']), zeilen, heute), []);
});

test('Vertragsdokument: Pfad in Unterlagen, nur ein sichtbarer STWEG-Ordner', () => {
  assert.deepEqual(ha.dokumentPfad('stweg3/Verträge/Lift.pdf', verw3), { pfad: 'stweg3/Verträge/Lift.pdf' });
  assert.deepEqual(ha.dokumentPfad('', verw3), { pfad: null });
  assert.deepEqual(ha.dokumentPfad(null, verw3), { pfad: null });
  assert.ok(ha.dokumentPfad('stweg5/Verträge/Lift.pdf', verw3).fehler, 'fremde STWEG');
  assert.ok(ha.dokumentPfad('../stweg3/x.pdf', verw3).fehler);
  assert.ok(ha.dokumentPfad('stweg3/../stweg5/x.pdf', verw3).fehler);
  assert.ok(ha.dokumentPfad('/stweg3/x.pdf', verw3).fehler);
  assert.ok(ha.dokumentPfad('stweg3', verw3).fehler, 'nur ein Ordner, keine Datei');
  assert.ok(ha.dokumentPfad('privat/x.pdf', verw3).fehler, 'kein STWEG-Ordner');
  assert.deepEqual(ha.dokumentPfad('meg/Halle/x.pdf', hw.handwerkerSicht(['meg-verwaltung'])), { pfad: 'meg/Halle/x.pdf' });
  assert.deepEqual(ha.dokumentPfad('stweg5/x.pdf', tp), { pfad: 'stweg5/x.pdf' });
  assert.ok(ha.dokumentPfad('stweg3/a\u0000b.pdf', verw3).fehler);
});

test('Bewertung je Einsatz: 1–5, Text nur mit Bewertung, kurz', () => {
  assert.deepEqual(ha.bewertungNormal({ bewertung: '4', bewertung_text: ' pünktlich ' }), { bewertung: 4, bewertung_text: 'pünktlich' });
  assert.deepEqual(ha.bewertungNormal({ bewertung: 6, bewertung_text: 'x' }), { bewertung: null, bewertung_text: null });
  assert.deepEqual(ha.bewertungNormal({ bewertung: 0 }), { bewertung: null, bewertung_text: null });
  assert.deepEqual(ha.bewertungNormal({}), { bewertung: null, bewertung_text: null });
  assert.equal(ha.bewertungNormal({ bewertung: 3, bewertung_text: 'a'.repeat(900) }).bewertung_text.length, 500);
});

test('Vorschläge aus Reparatur: Einsatz und Mail ohne Namen der meldenden Person', () => {
  const rekl = { id: 42, kategorie: 'aufzug', beschreibung: 'Aufzug Haus 9 steckt im 2. Stock', stweg: 3, erledigt_am: '2026-11-27T10:00:00Z', person_name: 'Erika Muster' };
  const e = ha.einsatzVorschlag(rekl);
  assert.equal(e.datum, '2026-11-27');
  assert.match(e.beschreibung, /Meldung #42 \(Aufzug\): Aufzug Haus 9/);
  const m = ha.auftragsMailText(rekl, { name: 'Verwaltung Muster AG', email: 'verwaltung@example.org' });
  assert.match(m.betreff, /STWEG 3.*Aufzug/);
  assert.match(m.text, /Aufzug Haus 9 steckt/);
  assert.match(m.text, /verwaltung@example\.org/);
  assert.doesNotMatch(m.text, /Erika|Muster(?! AG)/);
  assert.equal(ha.mailOk('a@b.ch'), true);
  assert.equal(ha.mailOk('a b@c.ch'), false);
  assert.equal(ha.mailOk('a@b.ch, c@d.ch'), false, 'genau eine Adresse');
});

test('Server: Schema, ASCII-Pfade, Hooks, Kandidat aus der Firmenliste', () => {
  for (const sp of ['reklamation_id INTEGER', 'bewertung INTEGER CHECK', 'bewertung_text TEXT', 'vertragsdokument_pfad TEXT', 'handwerker_id INTEGER REFERENCES handwerker(id) ON DELETE SET NULL']) {
    assert.ok(server.includes(sp), sp);
  }
  assert.match(server, /'\/api\/handwerker\/:id\/vertraege'/);
  assert.match(server, /'\/api\/handwerker\/:id\/auftraege\/:aid'/);
  assert.match(server, /'\/api\/handwerker-vertraege\/anstehend'/);
  assert.match(server, /vorschlagAnlegen\(pool, 'benachrichtigung', updated\)/);
  assert.match(server, /vorschlagAnlegen\(pool, 'einsatz', updated\)/);
  assert.match(server, /projektKandidatAusFirma\(req, res, req\.body/);
  assert.match(server, /hwRechteLib\.hwLesen\(hwSichtVon\(req\), h\.stweg\)/, 'Kandidat nur aus sichtbaren Firmen');
  assert.match(server, /AVG\(bewertung\)/);
  assert.match(server, /hwAppRoutes\.handwerkerAppRoutes\(app,/);
});

test('Routen: STWEG-Bindung, Bestätigung der Verwaltung, Protokoll', () => {
  // der Mailversand hängt an „übernehmen“ (Bestätigung), nie am Anlegen des Vorschlags
  const anlegen = routen.slice(routen.indexOf('async function vorschlagAnlegen'), routen.indexOf('function handwerkerAppRoutes'));
  assert.doesNotMatch(anlegen, /loggedSendMail|mailSenden/);
  assert.match(routen, /app\.post\('\/api\/handwerker-vorschlaege\/:id\/uebernehmen', authMiddleware, \.\.\.hwSchreibend/);
  assert.match(routen, /hwRechte\.hwSchreiben\(sicht, p\.stweg \?\? null\)/);
  assert.match(routen, /app\.delete\('\/api\/handwerker\/:id\/personen\/:pid', authMiddleware, \.\.\.hwSchreibend/);
  assert.match(routen, /hwStammAendern\(hwSichtVon\(req\), firma\.stweg\)/);
  assert.match(routen, /'mitarbeiter-geloescht'/);
  assert.doesNotMatch(routen.slice(routen.indexOf("'mitarbeiter-geloescht'") - 80, routen.indexOf("'mitarbeiter-geloescht'") + 200), /\.name/, 'Name der Person nicht ins Protokoll');
  assert.match(routen, /objProtokoll\(req, 'handwerker', 'export'/);
  assert.match(routen, /Export nur für die eigene STWEG/);
});

test('Hartes Löschen: Technik und Präsident (Entscheid E12)', () => {
  assert.equal(hw.hwRechte(tp).hart_loeschen, true);
  assert.equal(hw.hwRechte(praes).hart_loeschen, true);
  assert.equal(hw.hwRechte(verw3).hart_loeschen, false);
  assert.equal(hw.hwRechte(aus3).hart_loeschen, false);
});
