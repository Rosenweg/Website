// node --test api/test/verteiler-portal.test.js — Befund V2: die Verwaltung sieht
// im Portal die Verteiler ihrer STWEG(s) (Recht email-verteiler) und sendet an sie.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vv = require('../lib/verteiler-verwaltung');

const V3 = { id: 1, stweg: 3, name: 'Bewohner R9', email_address: 'r9@example.invalid', active: true, members: [{ email: 'a@example.invalid' }], resolved_emails: ['a@example.invalid'], member_count: 1, group_names: ['r9-bewohner'] };
const V5 = { id: 2, stweg: 5, name: 'Bewohner STWEG 5', active: true };

test('Sicht: nur mit Recht, nur die eigenen STWEGs', () => {
  assert.deepEqual([...vv.portalVerteilerStwegs(['stweg3-verwaltung'], 'read')], [3]);
  assert.equal(vv.portalVerteilerStwegs(['stweg3-verwaltung'], undefined).size, 0);
  assert.equal(vv.portalVerteilerStwegs(['stweg5-bewohner'], 'read').size, 0);
  assert.equal(vv.portalVerteilerStwegs(['Verwaltung'], 'read').size, 8); // ÜBERGANG
});

test('Senden: nur mit Recht schreiben, nur an aktive Verteiler der eigenen STWEG (V10)', () => {
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'write', V3), true);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'read', V3), false); // lesen = nur Liste
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'write', V5), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'write', { ...V3, active: false }), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], undefined, V3), false);
  assert.equal(vv.portalDarfSenden(['stweg3-verwaltung'], 'write', { ...V3, stweg: null }), false);
  assert.equal(vv.portalDarfSendenRecht('read'), false);
  assert.equal(vv.portalDarfSendenRecht('write'), true);
});

test('Absendername (V10): Eingabe, sonst Kontoname; keine Kopfzeilen-Tricks', () => {
  assert.equal(vv.absenderName('  Hausverwaltung Beispiel ', 'Konto Name'), 'Hausverwaltung Beispiel');
  assert.equal(vv.absenderName('', 'Konto Name'), 'Konto Name');
  assert.equal(vv.absenderName(undefined, undefined), 'Rosenweg');
  assert.equal(vv.absenderName('Eva\r\nBcc: x@example.invalid', null), 'Eva Bcc: x@example.invalid');
  assert.equal(vv.absenderName('"Technik" <t@example.invalid>', null), 'Technik t@example.invalid');
  assert.ok(vv.absenderName('x'.repeat(200), null).length <= 80);
});

test('Archiv-Zeile (V10): An = Verteiler-Adresse, nie die Empfängerliste', () => {
  const a = vv.portalRundmailArchiv({ absenderEmail: 'v@example.invalid', absenderName: 'Verwaltung', verteilerAdresse: 'r9@example.invalid',
    anzahl: 12, subject: 'Info', text: 'Hallo', html: 'Hallo', messageId: '<abc@example.invalid>' });
  assert.equal(a.to_addresses, 'r9@example.invalid');
  assert.equal(a.message_id, '<abc@example.invalid>');
  assert.equal(a.from_name, 'Verwaltung');
  const b = vv.portalRundmailArchiv({ absenderEmail: 'v@example.invalid', anzahl: 3, subject: 'x', text: 'y' });
  assert.equal(b.to_addresses, '3 Empfänger (BCC)');
  assert.match(b.message_id, /^<portal-verteiler-/);
});

test('server.js + Seite: Name wirkt, Senden braucht schreiben, Archiv-Eintrag', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/verteiler/send'");
  const block = src.slice(i, src.indexOf('\napp.', i + 10));
  assert.match(block, /portalDarfSendenRecht\(perm\)/);
  assert.match(block, /from: \{ name: absName, address: MAIL_FROM \}/);
  assert.match(block, /INSERT INTO email_archive/);
  assert.match(src, /\['email-verteiler', 'write'\], \['bewohner-verwaltung', 'read'\]/);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'email-verteiler.html'), 'utf8');
  assert.match(html, /id="nurAnsichtHinweis"/);
  assert.match(html, /data\.darf_senden !== false/);
  assert.match(html, /sender_name: senderName\b/);
});

test('fuerVerwaltung: keine Mitglieder- oder Gruppenliste', () => {
  const v = vv.fuerVerwaltung(V3);
  assert.deepEqual(Object.keys(v).sort(), ['active', 'email_address', 'id', 'member_count', 'name', 'stweg']);
});

test('server.js: Liste und Versand prüfen die Verwaltung, Verwalten bleibt adminOnly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("app.get('/api/verteiler', authMiddleware, async"));
  assert.ok(src.includes("app.post('/api/verteiler/send', authMiddleware, async"));
  assert.match(src, /portalDarfSenden\(/);
  assert.ok(src.includes("app.post('/api/verteiler', authMiddleware, adminOnly"));
  assert.ok(src.includes("app.get('/api/email/log', authMiddleware, adminOnly"));
});
