// node --test api/test/email-archiv-rechte.test.js — Mail-Archiv: STWEG-Bindung,
// Seitenrecht, Vier-Augen ueber die Konto-ID, Loeschen leert alles,
// Zugriffsprotokoll, Aufbewahrung, Suche und Export (Entscheide Stefan 28.11.2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../lib/email-archiv-rechte');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Sicht: Technik/Präsident alles, Ausschuss und Verwaltung eigene STWEG + haus', () => {
  assert.equal(r.leseStwegs(['technik']), null);
  assert.equal(r.leseStwegs(['Präsident']), null);
  assert.deepEqual(r.leseStwegs(['stweg3-ausschuss']), ['3', 'haus']);
  assert.deepEqual(r.leseStwegs(['stweg5-verwaltung']), ['5', 'haus']);
  assert.deepEqual(r.leseStwegs(['stweg3-ausschuss', 'meg-ausschuss']), ['3', '8', 'haus']);
  assert.equal(r.leseStwegs(['Verwaltung']).length, 9); // ÜBERGANG: alle STWEGs + haus
  assert.deepEqual(r.leseStwegs(['r9-bewohner', 'stweg3-eigentuemer']), []);
  assert.deepEqual(r.leseStwegs([]), []);
});

test('darfLesen: fremde STWEG nein, haus ja', () => {
  assert.equal(r.darfLesen(['stweg3-ausschuss'], '3'), true);
  assert.equal(r.darfLesen(['stweg3-ausschuss'], '5'), false);
  assert.equal(r.darfLesen(['stweg3-ausschuss'], 'haus'), true);
  assert.equal(r.darfLesen(['stweg3-ausschuss'], null), true); // noch nicht zugeordnet = haus
  assert.equal(r.darfLesen(['technik'], '5'), true);
});

test('Löschweg: Ausschuss und Technik/Präsident, nicht die Verwaltung', () => {
  assert.equal(r.darfLoeschweg(['stweg3-ausschuss']), true);
  assert.equal(r.darfLoeschweg(['technik']), true);
  assert.equal(r.darfLoeschweg(['stweg3-verwaltung']), false);
});

test('Vier-Augen: andere Konto-ID, nicht die Mail-Adresse', () => {
  const antrag = { requested_by_id: 7, requested_by: 'a@example.invalid', antrag_stwegs: ['3'] };
  // gleiche Person mit anderer Adresse: abgelehnt
  assert.deepEqual(r.darfEntscheiden({ id: 7, email: 'anders@example.invalid', groups: ['stweg3-ausschuss'] }, antrag, '3'),
    { ok: false, grund: 'eigener-antrag' });
  // andere Person mit gleicher Adresse (z. B. geteiltes Postfach): zaehlt die ID
  assert.equal(r.darfEntscheiden({ id: 8, email: 'a@example.invalid', groups: ['stweg3-ausschuss'] }, antrag, '3').ok, true);
  // ohne Konto-ID nie
  assert.equal(r.darfEntscheiden({ email: 'x@example.invalid', groups: ['technik'] }, antrag, '3').grund, 'keine-konto-id');
});

test('Vier-Augen: derselben STWEG oder Technik/Präsident', () => {
  const antrag = { requested_by_id: 7, antrag_stwegs: ['3'] };
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['stweg5-ausschuss'] }, antrag, '3').grund, 'andere-stweg');
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['technik'] }, antrag, '3').ok, true);
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['stweg3-verwaltung'] }, antrag, '3').grund, 'kein-recht');
  // haus-Mail: es zaehlt die STWEG des Antrags
  const haus = { requested_by_id: 7, antrag_stwegs: ['3'] };
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['stweg3-ausschuss'] }, haus, 'haus').ok, true);
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['stweg5-ausschuss'] }, haus, 'haus').ok, false);
  // Antrag von Technik auf haus-Mail (keine Ausschuss-STWEG): nur Technik/Präsident
  assert.deepEqual(r.antragStwegs(['technik'], 'haus'), []);
  assert.equal(r.darfEntscheiden({ id: 9, groups: ['stweg5-ausschuss'] }, { requested_by_id: 1, antrag_stwegs: [] }, 'haus').ok, false);
  assert.deepEqual(r.antragStwegs(['stweg3-ausschuss'], '5'), ['5']);
});

test('Altbestand ohne Konto-ID: Adressvergleich, Gross/Klein egal', () => {
  const alt = { requested_by_id: null, requested_by: 'A@Example.invalid', antrag_stwegs: null };
  assert.equal(r.darfEntscheiden({ id: 3, email: 'a@example.invalid', groups: ['technik'] }, alt, '3').grund, 'eigener-antrag');
  assert.equal(r.darfEntscheiden({ id: 3, email: 'b@example.invalid', groups: ['technik'] }, alt, '3').ok, true);
});

test('Suche: % und _ gelten wörtlich', () => {
  assert.equal(r.likeMuster('50%'), '%50\\%%');
  assert.equal(r.likeMuster('a_b'), '%a\\_b%');
  assert.equal(r.likeMuster('c:\\x'), '%c:\\\\x%');
  assert.equal(r.likeMuster(''), '%%');
});

test('STWEG aus den Empfängern: genau eine Verteiler-STWEG, sonst haus', () => {
  const v = [{ stweg: 3, email_address: 'r9@example.invalid' }, { stweg: 5, email_address: 'S5@example.invalid' }];
  assert.equal(r.stwegAusAdressen('r9@example.invalid', v), '3');
  assert.equal(r.stwegAusAdressen('Liste <s5@example.invalid>', v), '5');
  assert.equal(r.stwegAusAdressen('r9@example.invalid, s5@example.invalid', v), 'haus');
  assert.equal(r.stwegAusAdressen('xr9@example.invalid', v), 'haus'); // kein Teilstring
  assert.equal(r.stwegAusAdressen('', v), 'haus');
  assert.equal(r.stwegAusAdressen('12 Empfänger (BCC)', v), 'haus');
});

test('Export: die Spalten, die es gibt (L3)', () => {
  const z = r.exportZeile({ id: 1, email_date: '2026-01-02T03:04:05Z', stweg: '3', from_email: 'a@example.invalid', from_name: 'A',
    to_addresses: 'l@example.invalid', subject: 'S', attachments: [{}, {}], deletion_status: 'active', message_id: '<m@x>' });
  assert.deepEqual(Object.keys(z), ['ID', 'Datum', 'STWEG', 'Von', 'Name', 'An', 'Betreff', 'Anhaenge', 'Status', 'Message-ID']);
  assert.equal(z.Datum, '2026-01-02T03:04:05.000Z');
  assert.equal(z.Anhaenge, 2);
  assert.equal(z.An, 'l@example.invalid');
});

test('Zugriffsweg: MCP, Token, Karte, Konto', () => {
  assert.equal(r.zugriffsWeg({ headers: { 'x-rosenweg-kanal': 'mcp' }, pat: { id: 1 } }), 'mcp');
  assert.equal(r.zugriffsWeg({ headers: {}, pat: { id: 1 } }), 'token');
  assert.equal(r.zugriffsWeg({ headers: {}, appKarte: {} }), 'karte');
  assert.equal(r.zugriffsWeg({ headers: {}, auth: { art: 'app' } }), 'app');
  assert.equal(r.zugriffsWeg({ headers: {} }), 'konto');
});

test('Router: Seitenrecht, STWEG-Filter, Protokoll, vollständiges Leeren, Mitteilung', () => {
  const s = src('routes/email-archive.js');
  assert.match(s, /requirePermission\('email-archiv', 'read'\)/);
  // Jede Route hinter requireArchiveAccess
  const routen = s.match(/router\.(get|post)\('[^']+', [^)]*\)/g) || [];
  assert.ok(routen.length >= 8);
  for (const z of s.match(/router\.(get|post)\('[^']+',[^\n]*/g)) assert.match(z, /authMiddleware, requireArchiveAccess/, z);
  // Zugriffe protokolliert
  for (const a of ["'suche'", "'export'", "'lesen'", "'anhang'", "'loeschantrag'", "'loeschung-bestaetigt'", "'loeschung-abgelehnt'"]) {
    assert.ok(s.includes(`protokoll(req, ${a}`), a);
  }
  // Loeschen leert Betreff, Absender, Empfaenger
  assert.match(s, /subject = NULL, from_email = NULL, from_name = NULL,\s*to_addresses = NULL, text_body = NULL, html_body = NULL/);
  // Dateifehler nicht mehr verschluckt
  assert.doesNotMatch(s, /catch \{\}/);
  assert.match(s, /offene_dateien/);
  // Mitteilung ohne Betreff
  assert.match(s, /sendToEmails\(\[an\]/);
  assert.match(s, /ESCAPE '\\\\'/);
  // Aufbewahrung 10 Jahre
  assert.equal(r.AUFBEWAHRUNG_JAHRE, 10);
  assert.match(s, /make_interval\(years => \$1::int\)/);
});

test('server.js: Schema, STWEG-Zuordnung nach dem Archivieren, Aufräumlauf, archiv/ gesperrt', () => {
  const s = src('server.js');
  assert.match(s, /require\('\.\/routes\/email-archive'\)\.schemaSicherstellen\(client\)/);
  assert.match(s, /require\('\.\/routes\/email-archive'\)\.aufbewahrungStarten\(activeIntervals\)/);
  const i = s.indexOf('async function archiveEmail(');
  assert.match(s.slice(i, i + 1500), /stwegZuordnen\(\)/);
  // Portal-Rundmail: das Archivieren steht seit dem Vier-Augen-Umbau in der
  // Versand-Funktion vor der Route /api/verteiler/send
  const j = s.indexOf("[verteiler-direct] Archivieren fehlgeschlagen");
  assert.ok(j > 0);
  assert.match(s.slice(j - 800, j), /stwegZuordnen\(\)/);
  // archiv/ nur ueber die Archiv-Route (Protokoll), auch fuer Technik
  const k = s.indexOf('function isDocPathAllowed(');
  const block = s.slice(k, k + 400);
  assert.match(block, /if \(isTechnik\(groups\) \|\| isPraesident\(groups\)\) return !docNurEigeneRoute\(filePath\);/);
  const w = s.indexOf('function canWriteDocPath(');
  const wb = s.slice(w, w + 300);
  assert.ok(wb.indexOf('docNurEigeneRoute(filePath)') < wb.indexOf('isTechnik(groups)'));
});

test('Rechte-Migration: Verwaltung bekommt email-archiv lesen', () => {
  const { RECHTE_MIGRATIONEN } = require('../lib/rechte-migrationen');
  const m = RECHTE_MIGRATIONEN.find(x => x.page === 'email-archiv');
  assert.ok(m);
  assert.equal(m.access, 'read');
  assert.ok(m.gruppen.includes('stweg3-verwaltung'));
  assert.ok(!m.gruppen.some(g => g.endsWith('-ausschuss')));
});

test('Seite: Export über den Server, eigener Antrag vom Server', () => {
  const h = fs.readFileSync(path.join(__dirname, '..', '..', 'email-archiv.html'), 'utf8');
  assert.match(h, /\/api\/email-archive\/export\?search=/);
  assert.doesNotMatch(h, /received_at|verteiler_name/);
  assert.match(h, /isOwnRequest = !!email\.eigener_antrag/);
  assert.match(h, /isOwnRequest = !!r\.eigener_antrag/);
  assert.doesNotMatch(h, /requested_by === currentUser/);
});
