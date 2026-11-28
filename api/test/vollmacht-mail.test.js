// node --test api/test/vollmacht-mail.test.js — Mails zu Vollmachten (lib/vollmacht-mail.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('../lib/vollmacht-mail');
const g = require('../lib/mailgateway');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// kleine Nachbildung von renderTemplate (server.js) – genug fuer {{x}} und {{#if x}}
function render(t, c) {
  return t.replace(/\{\{#if\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, p, b) => (c[p] ? b : ''))
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, p) => (c[p] === undefined ? '' : String(c[p])));
}

const v = (extra = {}) => ({
  id: 5, status: 'aktiv', stweg: 3, wohnung_id: 7, art: 'spezifisch', doc_hash: 'AB12CD34',
  vollmachtgeber_name: 'Anna Muster', vollmachtgeber_email: 'anna@example.org',
  vollmachtgeber_liste: [{ name: 'Anna Muster', email: 'anna@example.org' }, { name: 'Ben Muster', email: 'ben@example.org' }],
  bevollmaechtigter_name: 'Carl Vertreter', bevollmaechtigter_email: 'Carl@example.org',
  geltungsbereich: 'Versammlung', gueltig_ab: '2026-12-01', gueltig_bis: '2027-01-15',
  wohnung_bezeichnung: '3.OG links', ...extra,
});

test('vier Vorlagen mit Betreff, Text und Notiz; Personen-Mails mit Abmelde-Link', () => {
  const t = Object.fromEntries(vm.VORLAGEN.map((x) => [x.source_type, x]));
  assert.deepEqual(Object.keys(t).sort(), ['vollmacht-ablauf', 'vollmacht-bevollmaechtigt', 'vollmacht-eingegangen', 'vollmacht-miteigentuemer']);
  for (const x of vm.VORLAGEN) { assert.ok(x.subject_template && x.body_template && x.notiz, x.source_type); }
  for (const n of ['vollmacht-bevollmaechtigt', 'vollmacht-miteigentuemer', 'vollmacht-ablauf']) assert.match(t[n].body_template, /\{\{abmelden_url\}\}/, n);
  assert.doesNotMatch(t['vollmacht-eingegangen'].body_template, /abmelden_url/); // Firma: Vorlage abschalten
});

test('Kontext und Wortlaut', () => {
  const c = vm.kontext(v(), { siteUrl: 'https://x.ch', empfaengerName: 'Carl', abmeldenUrl: 'https://x.ch/a?t=1', heute: '2027-01-08' });
  assert.equal(c.vollmachtgeber, 'Anna Muster und Ben Muster');
  assert.equal(c.gueltig_bis, '15.01.2027');
  assert.equal(c.gueltig_bis_datum, '15.01.2027');
  assert.equal(c.tage, 7);
  const m = vm.VORLAGEN.find((x) => x.source_type === 'vollmacht-bevollmaechtigt');
  const text = render(m.body_template, c);
  assert.match(text, /Hallo Carl/);
  assert.match(text, /Anna Muster und Ben Muster hat dich bevollmächtigt/);
  assert.match(text, /Wohnung: 3\.OG links/);
  assert.match(text, /https:\/\/x\.ch\/a\?t=1/);
  assert.equal(render(m.subject_template, c), 'Du wurdest bevollmächtigt: Anna Muster und Ben Muster');
  // ohne Ende: bis auf Widerruf; Weisung steht in keiner Mail
  assert.equal(vm.kontext(v({ gueltig_bis: null }), {}).gueltig_bis, 'bis auf Widerruf');
  for (const x of vm.VORLAGEN) assert.doesNotMatch(x.body_template, /weisung/i);
});

test('Empfänger bei aktiver Vollmacht: Bevollmächtigte, Miteigentümer ohne Geber, ohne Mieter, ohne Doppelte', () => {
  const kontakte = [
    { email: 'anna@example.org', name: 'Anna', rolle: 'eigentuemer' },
    { email: 'dora@example.org', name: 'Dora', rolle: 'eigentuemer' },
    { email: 'DORA@example.org', name: 'Dora', rolle: 'eigentuemer' },
    { email: 'mieter@example.org', name: 'Mia', rolle: 'mieter' },
    { email: 'carl@example.org', name: 'Carl', rolle: 'eigentuemer' },
    { email: '', name: 'ohne', rolle: 'eigentuemer' },
  ];
  const r = vm.empfaengerAktiv(v(), { kontakte });
  assert.deepEqual(r.bevollmaechtigt, [{ email: 'carl@example.org', name: 'Carl Vertreter' }]);
  assert.deepEqual(r.miteigentuemer.map((x) => x.email), ['dora@example.org']);
  // Abgemeldete bekommen nichts
  const aus = new Set(['dora@example.org', 'carl@example.org']);
  const r2 = vm.empfaengerAktiv(v(), { kontakte, aus });
  assert.deepEqual(r2, { bevollmaechtigt: [], miteigentuemer: [] });
  // E-Mail der Person aus dem Stamm, wenn die Zeile keine hat
  assert.equal(vm.empfaengerAktiv(v({ bevollmaechtigter_email: null }), { bevollmaechtigterEmail: 'p@example.org' }).bevollmaechtigt[0].email, 'p@example.org');
});

test('Ablauf: 7 Tage vorher, einmal je Ablaufdatum, nur aktive', () => {
  const heute = '2027-01-08';
  const zeile = (x) => v({ ablauf_gemeldet_fuer: null, ...x });
  assert.equal(vm.ablaufFaellig([zeile({})], heute).length, 1); // 7 Tage
  assert.equal(vm.ablaufFaellig([zeile({ gueltig_bis: '2027-01-16' })], heute).length, 0); // 8 Tage
  assert.equal(vm.ablaufFaellig([zeile({ gueltig_bis: '2027-01-08' })], heute).length, 1); // heute noch gueltig
  assert.equal(vm.ablaufFaellig([zeile({ gueltig_bis: '2027-01-07' })], heute).length, 0); // vorbei
  assert.equal(vm.ablaufFaellig([zeile({ gueltig_bis: null })], heute).length, 0); // bis Widerruf
  assert.equal(vm.ablaufFaellig([zeile({ status: 'widerrufen' })], heute).length, 0);
  assert.equal(vm.ablaufFaellig([zeile({ status: 'entwurf' })], heute).length, 0);
  // schon gemeldet -> nicht nochmal; verlaengert -> wieder faellig
  assert.equal(vm.ablaufFaellig([zeile({ ablauf_gemeldet_fuer: '2027-01-15' })], heute).length, 0);
  assert.equal(vm.ablaufFaellig([zeile({ ablauf_gemeldet_fuer: '2026-12-31' })], heute).length, 1);
  assert.equal(vm.tageBis('2027-03-01', '2027-02-28'), 1);
});

test('Ablauf-Empfänger: Bevollmächtigte und alle Geber, einmal, ohne Abgemeldete', () => {
  const r = vm.empfaengerAblauf(v(), {});
  assert.deepEqual(r.map((x) => x.email), ['carl@example.org', 'anna@example.org', 'ben@example.org']);
  const r2 = vm.empfaengerAblauf(v(), { aus: new Set(['ben@example.org']) });
  assert.deepEqual(r2.map((x) => x.email), ['carl@example.org', 'anna@example.org']);
});

test('Gateway vollmachten@: eigene Regel, Rückfall auf noreply@ ohne Postfach', () => {
  const env = { MAIL_VOLLMACHTEN_USER: 'vollmachten@rosenweg4303.ch', MAIL_VOLLMACHTEN_PASS: 'x', MAIL_NOREPLY_USER: 'noreply@rosenweg4303.ch', MAIL_NOREPLY_PASS: 'y' };
  const gw = g.gatewaysLesen(env);
  for (const t of ['vollmacht-bevollmaechtigt', 'vollmacht-miteigentuemer', 'vollmacht-eingegangen', 'vollmacht-ablauf']) {
    assert.equal(g.gatewayFuerTrigger(t), 'vollmachten', t);
    assert.equal(g.gatewayWaehlen(t, gw).user, 'vollmachten@rosenweg4303.ch', t);
  }
  const ohne = g.gatewaysLesen({ MAIL_NOREPLY_USER: 'noreply@rosenweg4303.ch', MAIL_NOREPLY_PASS: 'y' });
  assert.equal(g.gatewayWaehlen('vollmacht-ablauf', ohne).user, 'noreply@rosenweg4303.ch');
  // Absender: Anzeigename bleibt, Adresse wird die Gateway-Adresse
  const a = g.absenderSetzen({ from: { name: 'Rosenweg Vollmachten', address: 'noreply@rosenweg4303.ch' }, to: 'x@y.ch' }, gw.vollmachten, 'noreply@rosenweg4303.ch');
  assert.deepEqual(a.from, { name: 'Rosenweg Vollmachten', address: 'vollmachten@rosenweg4303.ch' });
});

test('server.js: Vorlagen im Editor, Mails an allen drei Aktivierungen, Ablauf-Zeitplan, Abmelden per POST', () => {
  assert.match(SRC, /\.\.\.vollmachtMail\.VORLAGEN/);
  assert.equal((SRC.match(/vmAktivMails\(id\)/g) || []).length, 3);
  assert.match(SRC, /setInterval\(vmAblaufMails/);
  assert.match(SRC, /app\.post\('\/api\/vollmachten\/mail-abmelden'/);
  // der GET aendert nichts (Mail-Scanner rufen Links ab)
  const i = SRC.indexOf("app.get('/api/vollmachten/mail-abmelden'");
  const get = SRC.slice(i, SRC.indexOf('\napp.post', i));
  assert.doesNotMatch(get, /UPDATE/);
  // die Mail-Routen stehen vor /:id
  assert.ok(SRC.indexOf("'/api/vollmachten/mail-einstellung'") < SRC.indexOf("app.put('/api/vollmachten/:id'"));
});
