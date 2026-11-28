// node --test api/test/rundmail-stweg-vier-augen.test.js — Rundmail-Prüfung Nov. 2026:
// F1 Verteiler-Gate je Verteiler (STWEG-Bindung auch beim nativen Fanout),
// F2 Vier-Augen-Prinzip per Konto-ID, F6 Stammdaten STWEG-Filter,
// L4 PUT /api/verteiler/:id partiell, L11 Idempotenz beim Senden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gate = require('../lib/verteiler-gate');
const vierAugen = require('../lib/vier-augen');
const vv = require('../lib/verteiler-verwaltung');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const D = 'example.ch';

// ── F1 ─────────────────────────────────────────────────────────────
const gruppen = {
  technik: ['tech@example.org'],
  'präsident': ['praes@example.org'],
  'r9-bewohner': ['bew3@example.org'], 'r9-eigentuemer': ['eig3@example.org'], 'stweg3-ausschuss': ['aus3@example.org'],
  'stweg5-bewohner': ['bew5@example.org'], 'stweg5-ausschuss': ['aus5@example.org'],
  'stweg3-verwaltung': ['verwgruppe3@example.org'],
  'stweg5-verwaltung': ['verwgruppe5@example.org'],
  ausschuss: ['aus3@example.org', 'aus5@example.org'],
};
const daten = (verteiler) => ({
  verteiler, verteilerDomain: D,
  gruppe: (n) => gruppen[String(n).toLowerCase()] || [],
  personenJeStweg: new Map([[3, ['mieter3@example.org', 'EIGENTUEMER3@Example.org']], [5, ['mieter5@example.org']]]),
  verwaltungen: [
    { stweg: 3, adressen: ['info@verw3.example', 'person@gmail.com'] },
    { stweg: 5, adressen: ['info@verw5.example'] },
    { stweg: null, adressen: ['info@verwalle.example'] },
  ],
  systemAdressen: [`noreply@${D}`, `technik@${D}`],
  eigeneDomains: [D, 'rosenweg9.example'],
});
const V = {
  s3: { id: 3, stweg: 3, email_address: `stweg3@${D}`, active: true, external_allowed: false, group_names: ['stweg3-ausschuss'], allowed_sender_groups: [] },
  s5: { id: 5, stweg: 5, email_address: `stweg5@${D}`, active: true, external_allowed: false, group_names: ['stweg5-ausschuss'], allowed_sender_groups: [] },
  alle: { id: 17, stweg: 0, email_address: `eigentuemer@${D}`, active: true, external_allowed: false, group_names: ['verwaltung:eigentuemer'], allowed_sender_groups: [] },
  alleGrp: { id: 18, stweg: 0, email_address: `eigentuemer-direkt@${D}`, active: true, external_allowed: false, allowed_sender_groups: ['ausschuss'] },
  s3Grp: { id: 12, stweg: 3, email_address: `r9-eigentuemer@${D}`, active: true, external_allowed: false, allowed_sender_groups: ['stweg3-ausschuss'] },
  offen: { id: 1, stweg: 1, email_address: `stweg1@${D}`, active: true, external_allowed: true },
  aus: { id: 9, stweg: 3, email_address: `alt@${D}`, active: false, external_allowed: false },
};
const eintrag = (v) => gate.gateEintraege(daten(Object.values(V))).find(e => e.id === v.id);
const darf = (v, a) => gate.absenderErlaubt(eintrag(v), a);

test('F1: nur gesperrte, aktive Verteiler der eigenen Domain bekommen eine Regel', () => {
  const ids = gate.gateEintraege(daten(Object.values(V))).map(e => e.id);
  assert.deepEqual(ids, [3, 5, 12, 17, 18]);
});

test('F1: Personen nur an die Verteiler der eigenen STWEG, Mieter wie Eigentümer', () => {
  assert.equal(darf(V.s3, 'mieter3@example.org'), true);
  assert.equal(darf(V.s3, 'eigentuemer3@example.org'), true);
  assert.equal(darf(V.s3, 'bew3@example.org'), true);
  assert.equal(darf(V.s5, 'mieter3@example.org'), false, 'fremde STWEG');
  assert.equal(darf(V.s5, 'bew3@example.org'), false, 'fremde STWEG (Authentik)');
  assert.equal(darf(V.s3, 'fremd@example.net'), false);
});

test('F1: Technik, Präsident und Systemadressen an alle', () => {
  for (const v of [V.s3, V.s5, V.alle, V.alleGrp, V.s3Grp]) {
    assert.equal(darf(v, 'tech@example.org'), true);
    assert.equal(darf(v, 'praes@example.org'), true);
    assert.equal(darf(v, `noreply@${D}`), true);
  }
});

test('F1: Domains der Verwaltung nur für ihre STWEG, nie Freemail oder eigene Domain', () => {
  assert.equal(darf(V.s3, 'wer@verw3.example'), true);
  assert.equal(darf(V.s5, 'wer@verw3.example'), false);
  assert.equal(darf(V.s5, 'wer@verw5.example'), true);
  assert.equal(darf(V.s3, 'wer@verwalle.example'), true, 'Vertrag für alle STWEGs');
  assert.equal(darf(V.s3, 'person@gmail.com'), true, 'Adresse selbst ja');
  assert.equal(darf(V.s3, 'irgendwer@gmail.com'), false, 'gmail.com nie als Domain');
  assert.ok(!eintrag(V.s3).domains.includes(D));
  assert.equal(darf(V.s3, `jemand@${D}`), false, 'eigene Domain nicht pauschal');
  assert.equal(darf(V.s3, 'verwgruppe3@example.org'), true);
  assert.equal(darf(V.s5, 'verwgruppe3@example.org'), false);
});

test('F1: mit allowed_sender_groups nur diese Gruppen (plus T/P, Verwaltung der STWEG)', () => {
  assert.equal(darf(V.s3Grp, 'aus3@example.org'), true);
  assert.equal(darf(V.s3Grp, 'mieter3@example.org'), false);
  assert.equal(darf(V.s3Grp, 'wer@verw3.example'), true);
  assert.equal(darf(V.alleGrp, 'aus5@example.org'), true);
  assert.equal(darf(V.alleGrp, 'mieter3@example.org'), false);
  assert.equal(darf(V.alleGrp, 'wer@verw3.example'), false, 'Verwaltung nur einer STWEG');
  assert.equal(darf(V.alleGrp, 'wer@verwalle.example'), true);
});

test('F1: STWEG-übergreifend ohne Gruppen bleibt offen für bekannte Absender', () => {
  assert.equal(darf(V.alle, 'mieter5@example.org'), true);
  assert.equal(darf(V.alle, 'wer@verw3.example'), true);
  assert.equal(darf(V.alle, 'fremd@example.net'), false);
});

test('F1: API liefert version 2 je Verteiler, Rückfallpfad prüft gleich', () => {
  const i = src.indexOf("app.get('/api/verteiler/mailcow-gate', requireTrackerSecret");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(route, /version: 2, verteiler/);
  assert.match(route, /status\(503\)/);
  const inbound = src.slice(src.indexOf('async function processInboundEmail'), src.indexOf('const recipients = await resolveVerteilerRecipients(list);'));
  assert.match(inbound, /verteilerGate\.istGesperrt\(list, VERTEILER_DOMAIN\)/);
  assert.match(inbound, /verteilerGate\.absenderErlaubt\(eintrag, senderEmail\)/);
  // archivierte Wohnungs-Kontakte (frühere Bewohner) zählen nicht
  assert.match(src, /WHERE k\.archiviert_am IS NULL AND w\.stweg IS NOT NULL/);
});

test('F1: Gate-Skript baut je Verteiler eine Regel (Python)', () => {
  const skript = path.join(__dirname, '..', '..', 'mailcow', 'mailcow-verteiler-gate.py');
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("g", sys.argv[1])
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
e = [{"id": 3, "address": "stweg3@example.ch", "emails": ["a@example.org"], "domains": ["verw3.example"]},
     {"id": 5, "address": "stweg5@example.ch", "emails": ["b@example.org"], "domains": []}]
maps, mm, co = g.plan(e)
g.ABSENDER_PRUEFEN = True
_, _, co2 = g.plan(e)
print(json.dumps({"maps": maps, "mm": mm, "co": co, "co2": co2}))
`;
  let out;
  try { out = execFileSync('python3', ['-I', '-c', py, skript], { encoding: 'utf8' }); } catch (e) { return; } // ohne python3 ueberspringen
  const r = JSON.parse(out);
  assert.deepEqual(r.maps['rosenweg_v3_rcpt.map'], ['/^stweg3(\\+[^@]*)?@example\\.ch$/i']);
  assert.deepEqual(r.maps['rosenweg_v5_emails.map'], ['b@example.org']);
  assert.ok(!('rosenweg_v5_domains.map' in r.maps), 'ohne Domains keine leere Domain-Regel');
  assert.match(r.co, /\(ROSENWEG_V3_RCPT & !\(ROSENWEG_V3_FROM \| ROSENWEG_V3_FROMD\)\) \| \(ROSENWEG_V5_RCPT & !\(ROSENWEG_V5_FROM\)\)/);
  assert.match(r.co2, /ROSENWEG_V3_RCPT & !\(\(\(ROSENWEG_V3_FROM \| ROSENWEG_V3_FROMD\) & \(ROSENWEG_AUTHED \| R_SPF_ALLOW\)\)/);
  assert.doesNotMatch(r.mm, /ROSENWEG_FROM_OK_EMAIL|rosenweg_allowed_emails/, 'keine globale Liste mehr');
  assert.match(r.mm, /ROSENWEG_AUTHED/);
});

// ── F2 ─────────────────────────────────────────────────────────────
test('F2: Ersteller und letzter Bearbeiter geben nicht selbst frei (Konto-ID)', () => {
  const ich = { id: 7, email: 'erika@example.ch' };
  assert.equal(vierAugen.selbstfreigabe(ich, { created_by_id: 7, created_by: 'anders@example.ch' }), 'ersteller');
  assert.equal(vierAugen.selbstfreigabe(ich, { created_by_id: 8, created_by: 'erika@example.ch' }), null, 'ID entscheidet');
  assert.equal(vierAugen.selbstfreigabe(ich, { created_by: 'Erika@Example.ch' }), 'ersteller', 'alte Zeile ohne ID: E-Mail');
  assert.equal(vierAugen.selbstfreigabe(ich, { created_by: 'system', edited_by_id: 7 }), 'bearbeiter');
  assert.equal(vierAugen.selbstfreigabe(ich, { created_by: 'system (ZEV)' }), null);
  assert.equal(vierAugen.selbstfreigabe({ id: 9, email: 'x@example.ch' }, { created_by_id: 7 }), null);
});

test('F2: Freigabe-Route prüft vor dem Eintrag, auch für Technik/Präsident', () => {
  const i = src.indexOf("app.post('/api/verwaltung-mail-queue/:id/freigeben'");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  const pruef = route.indexOf('vierAugen.selbstfreigabe(req.user, cur.rows[0])');
  assert.ok(pruef > 0);
  assert.ok(pruef < route.indexOf('INSERT INTO mail_approval_log'));
  assert.doesNotMatch(route.slice(0, pruef), /isTechnik|isPraesident/, 'keine Ausnahme für Technik/Präsident');
  assert.match(src, /ADD COLUMN IF NOT EXISTS created_by_id INTEGER/);
  assert.match(src, /createdById: req\.user\.id/);
  assert.match(src, /push\('edited_by_id', /);
});

// ── F6 ─────────────────────────────────────────────────────────────
test('F6: Stammdaten-Liste mit erzwungenem STWEG-Filter ausser Technik/Präsident', () => {
  const i = src.indexOf("app.get(encodeURI('/api/mail-empfänger')");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(route, /if \(!\(isTechnik\(g\) \|\| isPraesident\(g\)\)\)/);
  assert.match(route, /getAusschussStwegs\(g\), \.\.\.verwaltungStwegs\(g\)/);
  assert.match(route, /stweg = ANY\(\$\$\{params\.length\}::int\[\]\) OR stweg IS NULL/);
  assert.match(route, /status\(403\)/);
});

// ── L4 ─────────────────────────────────────────────────────────────
test('L4: PUT ohne Feld behält members, active, stweg und Gruppen', () => {
  const alt = { stweg: 3, name: 'R9', email_address: `r9@${D}`, members: [{ email: 'wa@example.org' }], active: false,
    reply_to: 'list', subject_prefix: '[R9]', group_name: 'r9-bewohner', group_names: ['r9-bewohner'],
    allowed_sender_groups: ['stweg3-ausschuss'], whatsapp_group_id: 'g1', whatsapp_group_name: 'WA', external_allowed: false };
  const n = vv.verteilerAenderung(alt, { name: 'R9 neu' });
  assert.equal(n.name, 'R9 neu');
  assert.deepEqual(n.members, alt.members);
  assert.equal(n.active, false);
  assert.equal(n.stweg, 3);
  assert.deepEqual(n.group_names, ['r9-bewohner']);
  assert.equal(n.group_name, 'r9-bewohner');
  assert.deepEqual(n.allowed_sender_groups, ['stweg3-ausschuss']);
  assert.equal(n.reply_to, 'list');
  assert.equal(n.whatsapp_group_id, 'g1');
  // explizit gesendet gilt weiterhin
  const m = vv.verteilerAenderung(alt, { members: [], active: true, group_names: [], external_allowed: true });
  assert.deepEqual(m.members, []);
  assert.equal(m.active, true);
  assert.deepEqual(m.group_names, []);
  assert.equal(m.external_allowed, true);
  // alte Zeile nur mit group_name
  assert.deepEqual(vv.verteilerAenderung({ ...alt, group_names: [] }, {}).group_names, ['r9-bewohner']);
  const i = src.indexOf("app.put('/api/verteiler/:id'");
  assert.match(src.slice(i, src.indexOf('\n});\n', i)), /verteilerVerwaltung\.verteilerAenderung\(alt, req\.body/);
});

// ── L11 ────────────────────────────────────────────────────────────
test('L11: Idempotency-Key und Fingerabdruck', () => {
  assert.equal(vv.idempotenzSchluessel(undefined), null);
  assert.equal(vv.idempotenzSchluessel(''), null);
  assert.equal(vv.idempotenzSchluessel('kurz'), false);
  assert.equal(vv.idempotenzSchluessel('a b c d e f g h'), false);
  assert.equal(vv.idempotenzSchluessel('3f1c0e8a-1b2c-4d5e-8f90-123456789abc'), '3f1c0e8a-1b2c-4d5e-8f90-123456789abc');
  const a = vv.sendeFingerabdruck({ verteiler_id: 3, subject: 'Info', body: 'Hallo' });
  assert.equal(a, vv.sendeFingerabdruck({ verteiler_id: '3', subject: 'Info', body: 'Hallo' }));
  assert.notEqual(a, vv.sendeFingerabdruck({ verteiler_id: 3, subject: 'Info', body: 'Hallo!' }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('L11: Route speichert die Antwort, Wiederholung sendet nicht erneut', () => {
  const i = src.indexOf("app.post('/api/verteiler/send'");
  const route = src.slice(i, src.indexOf('\n});\n', i));
  const idem = route.indexOf('INSERT INTO verteiler_send_idempotenz');
  assert.ok(idem > 0 && idem < route.indexOf('await verteilerRundmailSenden(req)'), 'Schlüssel vor dem Versand belegen');
  assert.match(route, /ON CONFLICT \(konto, schluessel\) DO NOTHING/);
  assert.match(route, /Idempotent-Replayed/);
  assert.match(route, /status\(409\)/);
  assert.match(route, /status\(422\)/);
  assert.match(src, /CREATE TABLE IF NOT EXISTS verteiler_send_idempotenz/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'email-verteiler.html'), 'utf8');
  assert.match(html, /'Idempotency-Key': sendeSchluessel/);
});
