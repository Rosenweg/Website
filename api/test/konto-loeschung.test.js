// node --test api/test/konto-loeschung.test.js — Konto-Löschung vollständig
// (Klärung Personen F2/F3, Entscheid Stefan 28.11.2026 "Vor dem Bau beheben").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kl = require('../lib/kontoloeschung');
const { RECHTE_MIGRATIONEN } = require('../lib/rechte-migrationen');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'loeschungen.html'), 'utf8');
const abschnitt = (von, bis) => src.slice(src.indexOf(von), src.indexOf(bis, src.indexOf(von) + 1));

// ─── Punkt 1: Frist und Regeln ────────────────────────────────────────────
test('Frist 30 Tage, Erinnerung am Tag 23', () => {
  assert.equal(kl.FRIST_TAGE, 30);
  assert.equal(kl.FRIST_TAGE - kl.ERINNERUNG_TAGE_VORHER, 23);
  assert.match(src, /scheduled_at - INTERVAL '7 days' <= NOW\(\)/);
});

test('Stoppen/Verlaengern: Ausschuss und Verwaltung der STWEGs bekommen loeschungen:write', () => {
  const m = RECHTE_MIGRATIONEN.find(x => x.name === '2026-11-28-loeschungen-ausschuss-verwaltung-write');
  assert.ok(m);
  assert.equal(m.page, 'loeschungen');
  assert.equal(m.access, 'write');
  const erwartet = [1, 2, 3, 4, 5, 6, 7].flatMap(n => [`stweg${n}-ausschuss`, `stweg${n}-verwaltung`]).sort();
  assert.deepEqual([...m.gruppen].sort(), erwartet);
  // Die Sicht bindet an die eigene STWEG (loeschVormerkung)
  assert.match(abschnitt('async function loeschVormerkung', 'const loeschProtokoll'), /stwegSichtLib\.sichtErlaubt\(/);
});

test('Eintrag entfernen: nur Technik', () => {
  assert.equal(kl.darfEntfernen(['technik']), true);
  assert.equal(kl.darfEntfernen(['Präsident']), false);
  assert.equal(kl.darfEntfernen(['stweg3-ausschuss']), false);
  assert.equal(kl.darfEntfernen(['stweg3-verwaltung']), false);
  const route = abschnitt("app.delete('/api/admin/pending-deletions/:id'", 'async function cancelPendingDeletion');
  assert.match(route, /if \(!kontoLoeschung\.darfEntfernen\(req\.user\?\.groups\)\) return res\.status\(403\)/);
  assert.match(html, /DARF_SCHREIBEN && NUR_TECHNIK \? '<option value="remove">/);
});

test('Sofort loeschen: nur Technik/Praesident, nur frisch mit dem Konto', () => {
  const jetzt = Math.floor(Date.now() / 1000);
  const frisch = { stufe: 'frisch', art: 'website', auth_time: jetzt };
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['technik'], auth: frisch }).ok, true);
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['Präsident'], auth: { ...frisch, art: 'app' } }).ok, true);
  // falsche Gruppe
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['stweg3-ausschuss'], auth: frisch }).status, 403);
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['stweg3-verwaltung'], auth: frisch }).ok, false);
  // Karte, QR, Anlage, bestaetigte Karten-Aktion, PAT, MCP, nicht frisch
  for (const art of ['karte', 'qr', 'handy', 'anlage', 'bestaetigt', 'pat', 'otp']) {
    const r = kl.sofortLoeschenPruefen({ groups: ['technik'], auth: { stufe: art === 'karte' ? 'karte' : 'konto', art } });
    assert.equal(r.ok, false, art);
  }
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['technik'], auth: { stufe: 'konto', art: 'website' } }).reauth, true);
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['technik'], auth: frisch, pat: true }).ok, false);
  assert.equal(kl.sofortLoeschenPruefen({ groups: ['technik'], auth: frisch, kanal: 'MCP' }).ok, false);
});

test('Sofort loeschen trifft nie Technik-, Praesident- oder Superuser-Konten', () => {
  assert.equal(kl.sofortGeschuetzt(null), false);
  assert.equal(kl.sofortGeschuetzt({ groups_obj: [{ name: 'stweg3-bewohner' }, { name: 'stweg3-ausschuss' }] }), false);
  assert.equal(kl.sofortGeschuetzt({ groups_obj: [{ name: 'technik' }] }), true);
  assert.equal(kl.sofortGeschuetzt({ groups_obj: [{ name: 'Präsident' }] }), true);
  assert.equal(kl.sofortGeschuetzt({ is_superuser: true, groups_obj: [] }), true);
});

test('Sofort-Route: Pruefung vor allem anderen, Protokoll, Nachlauf', () => {
  const route = abschnitt("app.post('/api/admin/pending-deletions/:id/sofort'", "app.get('/api/admin/pending-deletions/nachlauf'");
  assert.match(route, /authMiddleware, \.\.\.loeschungenSchreiben/);
  assert.ok(route.indexOf('sofortLoeschenPruefen') < route.indexOf('loeschVormerkung'));
  assert.match(route, /sofortGeschuetzt\(user\)/);
  assert.match(route, /loeschProtokoll\(req, 'sofort-geloescht'/);
  assert.match(route, /await lokalesKontoNachLoeschung\(row\.email, \{ name: row\.name, stweg: row\.stweg \}\)/);
  assert.match(html, /\/api\/admin\/pending-deletions\/\$\{id\}\/sofort/);
  assert.match(html, /AuthentikAuth\.login\('\/loeschungen\.html', \{ reauth: true \}\)/);
});

test('Konten mit weiteren Gruppen: Liste „manuell zu pruefen“, nie automatisch', () => {
  const track = abschnitt('async function trackRemovedKontakte', '// ─── Admin-API für Pending Deletions');
  assert.match(track, /if \(!kontoAutoLoeschbar\(konto, stweg\)\) \{[\s\S]{0,200}manuell = true;/);
  assert.doesNotMatch(track, /if \(!kontoAutoLoeschbar\(konto, stweg\)\) \{[^}]*continue;/);
  assert.match(track, /manuell_pruefen, grund\)/);
  const lauf = abschnitt('async function processAuthentiKDeletions', 'let isDeletionRunning');
  assert.equal((lauf.match(/AND NOT manuell_pruefen/g) || []).length, 2, 'Erinnerung und Loeschung lassen sie aus');
  assert.match(lauf, /SET manuell_pruefen = true, grund = 'Konto hat weitere Gruppen'/);
  assert.match(kl.SQL_TABELLEN, /ADD COLUMN IF NOT EXISTS manuell_pruefen BOOLEAN NOT NULL DEFAULT false/);
  assert.match(html, /id="tbody-manuell"/);
});

// ─── Punkte 2 und 4: Nachlauf mit Wiederholung ────────────────────────────
test('Nachlauf je Bereich; Anlage inkl. Nextcloud-Konto', () => {
  assert.deepEqual(kl.BEREICHE, ['anlage', 'mailbox', 'karten']);
  assert.ok(kl.ANLAGE_SCHRITTE.includes('nextcloud_konto'));
  assert.ok(kl.ANLAGE_SCHRITTE.indexOf('nextcloud') < kl.ANLAGE_SCHRITTE.indexOf('nextcloud_konto'), 'erst widerrufen, dann Konto');
});

test('Backoff: 15 min, verdoppelt, hoechstens 24 h', () => {
  assert.equal(kl.backoffMs(1), 15 * 60e3);
  assert.equal(kl.backoffMs(2), 30 * 60e3);
  assert.equal(kl.backoffMs(3), 60 * 60e3);
  assert.equal(kl.backoffMs(9), 24 * 3600e3);
  assert.equal(kl.backoffMs(500), 24 * 3600e3);
  assert.equal(kl.backoffMs(0), 15 * 60e3);
});

test('Antwort der Anlage: offene und nicht gemeldete Schritte, Nummern', () => {
  const a = kl.anlageAuswerten({
    nummern: ['300112'],
    schritte: { sitzungen: { ok: true }, nextcloud: { ok: false, fehler: 'Widerruf fehlgeschlagen: 2002' }, nummern: { ok: true, nummern: ['300113'] } },
  }, ['sitzungen', 'nextcloud', 'nextcloud_konto', 'nummern']);
  assert.equal(a.ok, false);
  assert.deepEqual(a.offen, ['nextcloud', 'nextcloud_konto']);
  assert.deepEqual(a.nummern, ['300112', '300113']);
  assert.match(a.fehler, /nextcloud_konto: von der Anlage nicht gemeldet/);
  assert.equal(kl.anlageAuswerten({ schritte: { sip: { ok: true } } }, ['sip']).ok, true);
});

test('Nachlauf Anlage: Wiederholung nur der offenen Schritte, Nummern bleiben', async () => {
  const aufrufe = [];
  const deps = {
    anlage: async (a) => {
      aufrufe.push(a);
      const schritte = Object.fromEntries(a.schritte.map(s => [s, { ok: s !== 'anrufe' || aufrufe.length > 1 }]));
      if (schritte.nummern) schritte.nummern.nummern = ['300112'];
      return { ok: false, antwort: { schritte, nummern: aufrufe.length === 1 ? ['300112'] : [] } };
    },
  };
  let row = { id: 1, email: 'anna@example.org', bereich: 'anlage', offen: kl.ANLAGE_SCHRITTE, kontext: {}, versuche: 0 };
  const e1 = await kl.nachlaufAusfuehren(row, deps);
  assert.equal(e1.ok, false);
  assert.deepEqual(e1.offen, ['anrufe']);
  const z1 = kl.naechsterZustand(row, e1, 0);
  assert.equal(z1.versuche, 1);
  assert.equal(z1.naechster_versuch.getTime(), 15 * 60e3);
  assert.equal(z1.erledigt_at, null);
  row = { ...row, offen: z1.offen, kontext: z1.kontext, versuche: z1.versuche };
  const e2 = await kl.nachlaufAusfuehren(row, deps);
  assert.deepEqual(aufrufe[1], { email: 'anna@example.org', schritte: ['anrufe'], nummern: ['300112'] });
  assert.equal(e2.ok, true);
  const z2 = kl.naechsterZustand(row, e2, 1000);
  assert.equal(z2.erledigt_at.getTime(), 1000);
  assert.equal(z2.naechster_versuch, null);
});

test('Nachlauf: Anlage nicht erreichbar -> alle Schritte bleiben offen', async () => {
  const row = { email: 'a@example.org', bereich: 'anlage', offen: ['sip', 'daten'], kontext: {}, versuche: 2 };
  const e = await kl.nachlaufAusfuehren(row, { anlage: async () => ({ ok: false, grund: 'HTTP 502' }) });
  assert.equal(e.ok, false);
  assert.deepEqual(e.offen, ['sip', 'daten']);
  assert.match(e.fehler, /HTTP 502/);
  const z = kl.naechsterZustand(row, e, 0);
  assert.equal(z.versuche, 3);
  const t = kl.protokollText(row, e, z);
  assert.equal(t.aktion, 'nachlauf-anlage');
  assert.match(t.neu, /fehlgeschlagen/);
  assert.match(t.neu, kl.NACHLAUF_SICHTBAR_AB <= 3 ? /sichtbar/ : /./);
});

test('Nachlauf Mailbox und Karten: Fehler werden wiederholt, Erfolg protokolliert', async () => {
  const fehl = await kl.nachlaufAusfuehren({ email: 'a@example.org', bereich: 'mailbox', versuche: 0 },
    { mailbox: async () => { throw new Error('Mailcow 500: x'); } });
  assert.equal(fehl.ok, false);
  assert.match(fehl.fehler, /Mailcow 500/);
  const ok = await kl.nachlaufAusfuehren({ email: 'a@example.org', bereich: 'karten', versuche: 1 },
    { karten: async () => ({ entzogen: 2, aliase: 1 }) });
  assert.equal(ok.ok, true);
  const t = kl.protokollText({ bereich: 'karten' }, ok, kl.naechsterZustand({ versuche: 1 }, ok));
  assert.match(t.neu, /Karten: erledigt \(2 Karte\(n\), 1 Zusatzadresse\(n\)\)/);
});

test('server.js: Nachlauf nur ohne weiteres Konto, mit Protokoll, Wiederholung und Anzeige', () => {
  const f = abschnitt('async function lokalesKontoNachLoeschung', '// ─── Nachlauf nach der Konto-Loeschung');
  assert.match(f, /if \(!nochKonto\) await nachlaufAnlegen\(e, \{ name, stweg \}\)/);
  const n = abschnitt('// ─── Nachlauf nach der Konto-Loeschung', 'async function nochAktiverKontakt');
  assert.match(n, /bereich: 'loeschungen', aktion: t\.aktion, ziel: row\.email/);
  assert.match(n, /setInterval\(nachlaufFaellige, 15 \* 60 \* 1000\)/);
  assert.match(n, /mailboxAnfrageLoeschen\(mr, 'Konto-Löschung'\)/);
  assert.match(n, /unifiUserByEmail\(email, \{ streng: true \}\)/);
  assert.match(n, /nfc_cards\/delete/);
  assert.match(n, /DELETE FROM person_email_alias WHERE LOWER\(haupt_email\) = \$1/);
  // Mailbox: nur persoenlich zugeordnete, aktive
  assert.match(n, /LOWER\(mr\.assigned_user_email\) = \$1 AND mr\.status = 'approved'/);
  // Anzeige ab X Fehlversuchen, STWEG-Sicht
  const g = abschnitt("app.get('/api/admin/pending-deletions/nachlauf'", "app.post('/api/admin/pending-deletions/nachlauf/:id/jetzt'");
  assert.match(g, /n\.versuche >= \$1/);
  assert.match(g, /sichtSql\(/);
  assert.match(html, /\/api\/admin\/pending-deletions\/nachlauf/);
  // Der Mailcow-Fehler in der Konto-Loeschung wird nicht verschluckt
  const m = abschnitt('async function mailboxAnfrageLoeschen', '// DELETE: Mailbox löschen.');
  assert.match(m, /if \(!mailcowFehlerIgnorieren\) throw mcErr;/);
});

// ─── Punkt 3: Aufräumlauf ─────────────────────────────────────────────────
test('Aufraeumen: 3 Monate, nur ohne aktiven Kontakt, aktives Konto oder offene Vormerkung', () => {
  assert.equal(kl.AUFBEWAHRUNG_MONATE, 3);
  for (const sql of [kl.SQL_PERSONEN_FAELLIG, kl.SQL_KONTAKTE_ANONYMISIEREN]) {
    assert.match(sql, /archiviert_am IS NULL/);
    assert.match(sql, /FROM users u WHERE u\.active/);
    assert.match(sql, /authentik_pending_deletions d WHERE NOT d\.cancelled/);
    assert.match(sql, /make_interval\(months => \$1::int\)/);
  }
  // nie verknuepfte Personen bleiben (Anker noetig)
  assert.match(kl.SQL_PERSONEN_FAELLIG, /WHERE anker IS NOT NULL/);
  // Muster der Anlage: Zeile bleibt, Name „gelöscht“, persoenliche Felder leer
  assert.match(kl.SQL_KONTAKTE_ANONYMISIEREN, /SET name = 'gelöscht', email = NULL, telefon = NULL, mobile = NULL, adresse = NULL, person_id = NULL/);
  assert.match(kl.SQL_NACHLAUF_ANONYMISIEREN, /erledigt_at IS NOT NULL/);
  assert.match(src, /taeglichUm\(2, 30, personenAufraeumen/);
});

function attrappenPool({ faellig, verwendet }) {
  const log = [];
  const antwort = (sql, p) => {
    log.push({ sql, p });
    if (sql === kl.SQL_PERSONEN_VERWEISE) return { rows: [{ tabelle: 'whatsapp_messages', spalte: 'person_id' }, { tabelle: 'x; DROP', spalte: 'id' }] };
    if (sql === kl.SQL_PERSONEN_FAELLIG) return { rows: faellig };
    if (/^SELECT 1 FROM whatsapp_messages/.test(sql)) return { rows: verwendet.has(p[0]) ? [{}] : [] };
    if (sql === kl.SQL_KONTAKTE_ANONYMISIEREN) return { rows: [], rowCount: 4 };
    if (sql === kl.SQL_NACHLAUF_ANONYMISIEREN) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: async (sql, p) => antwort(sql, p),
    connect: async () => ({ query: async (sql, p) => antwort(sql, p), release() {} }),
  };
  return { pool, log };
}

test('Aufraeumen: unbenutzte Personen loeschen, verwendete anonymisieren, ohne Trigger', async () => {
  const { pool, log } = attrappenPool({ faellig: [{ id: 7, email: 'a@example.org' }, { id: 8, email: '' }], verwendet: new Set([8]) });
  const r = await kl.aufraeumen(pool);
  assert.deepEqual(r, { personen_geloescht: 1, personen_anonymisiert: 1, kontakte: 4, nachlauf: 1 });
  const sqls = log.map(x => x.sql);
  assert.ok(log.some(x => x.sql === 'DELETE FROM personen WHERE id = $1' && x.p[0] === 7));
  const anon = log.find(x => /^\s*UPDATE personen SET name = \$2/.test(x.sql));
  assert.deepEqual(anon.p, [8, 'gelöscht #8']);
  assert.match(anon.sql, /geburtsdatum = NULL/);
  assert.ok(sqls.filter(s => /set_config\('rosenweg\.person_sync', 'on', true\)/.test(s)).length >= 3);
  // ungueltige Bezeichner aus dem Katalog werden nie in SQL eingesetzt
  assert.ok(!sqls.some(s => s.includes('DROP')));
});
