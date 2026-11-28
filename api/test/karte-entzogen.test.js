// node --test api/test/karte-entzogen.test.js — Karte entzogen, gesperrt oder entfernt
// (Entscheid Stefan 28.11.2026): die API meldet alle Sitzungen ab, die ueber diese Karte
// entstanden sind (Karten-Sitzungen und QR-/App-Sitzungen daraus), mit Protokoll und Mail.
// Ohne Datenbank und ohne Netz: Pool, Mail und UniFi Access sind Attrappen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ak = require('../lib/appkarte');
const kv = require('../lib/kartenverwaltung');
const { appKarteRoutes } = require('../routes/app-karte');

const lies = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

test('Bedingung: Token trifft Karten-Sitzung und Herkunft, Anzeige nur Zeilen ohne Token', () => {
  const b = ak.entzugBedingung({ token: 'tok-1', anzeige: '0042' });
  assert.equal(b.where, '(access_karten_token = $1 OR herkunft_karte_token = $1 OR (herkunft_karte_token IS NULL AND herkunft_karte = $2))');
  assert.deepEqual(b.params, ['tok-1', '0042']);
  const nurAnzeige = ak.entzugBedingung({ anzeige: '0042' });
  assert.match(nurAnzeige.where, /herkunft_karte_token IS NULL AND herkunft_karte = \$1/);
  const qr = ak.entzugBedingung({ token: 'tok-1', anzeige: '0042' }, { nurHerkunft: true });
  assert.doesNotMatch(qr.where, /access_karten_token|karte_anzeige/, 'app_qr_ausweise hat keine Karten-Spalten');
  assert.equal(ak.entzugBedingung({}), null);
  assert.equal(ak.entzugBedingung({ token: '', anzeige: null }), null);
});

test('Herkunft aus der Sitzung: Karte selbst, sonst die Herkunft einer QR-Sitzung', () => {
  assert.deepEqual(ak.kartenHerkunftAusSitzung({ karte_token: 'tok-1', karte_besitzer: 'u-1', karte: '0042' }),
    { token: 'tok-1', besitzer: 'u-1', anzeige: '0042' });
  assert.deepEqual(ak.kartenHerkunftAusSitzung({ herkunft_karte_token: 'tok-2', herkunft_karte: '0043' }),
    { token: 'tok-2', besitzer: null, anzeige: '0043' });
  assert.equal(ak.kartenHerkunftAusSitzung({ id: 'ks_1' }), null);
  assert.equal(ak.kartenHerkunftAusSitzung(null), null);
});

test('Mail nennt Karte und jede abgemeldete Anmeldung', () => {
  const m = ak.entzugMail({ name: 'Erika Muster', anzeige: '0042', portal: 'https://portal.example',
    sitzungen: [{ app_name: 'Rosenweg Profil', geraet_name: 'Pixel', art: 'karte' }, { app_name: 'Rosenweg Telefon', geraet_name: 'Galaxy', art: 'qr' }] });
  assert.match(m.subject, /Karte entzogen/);
  assert.match(m.text, /Rosenweg-Karte 0042 wurde entzogen/);
  assert.match(m.text, /Rosenweg Profil auf Pixel\n/);
  assert.match(m.text, /Rosenweg Telefon auf Galaxy \(aus einem Anmelde-QR\)/);
  assert.match(m.text, /https:\/\/portal\.example\/profil\.html#app-sitzungen/);
});

/** appKarteRoutes mit Attrappen; liefert karteEntzogen und die Aufzeichnungen. */
function dienst(zeilen) {
  const anfragen = [], mails = [], protokoll = [];
  const pool = {
    async query(sql, params) {
      anfragen.push({ sql, params });
      if (/UPDATE app_karten_sitzungen SET revoked_at/.test(sql) && /RETURNING id, email/.test(sql)) return { rows: zeilen, rowCount: zeilen.length };
      return { rows: [], rowCount: 0 };
    },
  };
  const app = { get() {}, post() {}, put() {}, delete() {} };
  const d = appKarteRoutes(app, {
    pool, authMiddleware: () => {}, requireUserLogin: () => {}, absenderIp: () => '198.51.100.1',
    loggedSendMail: async (m, trigger) => { mails.push({ ...m, trigger }); },
    MAIL_FROM: 'portal@example.org', karteNachschlagen: async () => ({}), accessKarteLive: async () => null,
    accessKartenBesitzerId: () => null, kartenPerson: async () => null,
    kartenProtokollieren: async (aktion, f) => { protokoll.push({ aktion, ...f }); },
    authentikUserByEmail: async () => null, karteZurAnzeige: async () => null,
  });
  return { d, anfragen, mails, protokoll };
}

test('karteEntzogen: meldet ab, verwirft offene QR, beendet Signatur-Bestaetigungen, protokolliert, mailt je Person', async () => {
  const zeilen = [
    { id: 'ks_a', email: 'erika@example.org', name: 'Erika Muster', app_name: 'Rosenweg Profil', geraet_name: 'Pixel', art: 'karte', karte_anzeige: '0042' },
    { id: 'ks_b', email: 'erika@example.org', name: 'Erika Muster', app_name: 'Rosenweg Telefon', geraet_name: 'Galaxy', art: 'qr', karte_anzeige: null },
  ];
  const { d, anfragen, mails, protokoll } = dienst(zeilen);
  const n = await d.karteEntzogen({ token: 'tok-1', anzeige: '0042' }, { durch: 'tina@example.org', grund: 'karte entzogen (Kartenverwaltung)' });
  assert.equal(n, 2);
  const ab = anfragen.find(a => /UPDATE app_karten_sitzungen SET revoked_at/.test(a.sql));
  assert.match(ab.sql, /WHERE revoked_at IS NULL AND \(access_karten_token = \$1 OR herkunft_karte_token = \$1/);
  assert.deepEqual(ab.params, ['tok-1', '0042', 'tina@example.org', 'karte entzogen (Kartenverwaltung)']);
  const qr = anfragen.find(a => /DELETE FROM app_qr_ausweise/.test(a.sql));
  assert.match(qr.sql, /eingeloest_at IS NULL AND \(herkunft_karte_token = \$1/);
  assert.ok(anfragen.some(a => /UPDATE vollmacht_sign_bestaetigungen SET expires_at = NOW\(\)/.test(a.sql) && a.params[0] === '0042'));
  await new Promise(r => setImmediate(r));
  assert.equal(mails.length, 1, 'eine Mail je Person');
  assert.equal(mails[0].to, 'erika@example.org');
  assert.equal(mails[0].trigger, 'app-karte-entzogen');
  assert.match(mails[0].text, /Rosenweg Telefon auf Galaxy \(aus einem Anmelde-QR\)/);
  assert.equal(protokoll.length, 1);
  assert.equal(protokoll[0].aktion, 'app-abmeldung');
  assert.match(protokoll[0].detail, /2 Sitzung\(en\) abgemeldet/);
  assert.ok(anfragen.some(a => /INSERT INTO admin_protokoll/.test(a.sql) && a.params[1] === 'karte-entzogen-abgemeldet'));
});

test('karteEntzogen: nichts offen -> keine Mail; ohne Token und Anzeige -> nichts', async () => {
  const { d, mails, anfragen } = dienst([]);
  assert.equal(await d.karteEntzogen({ token: 'tok-9' }), 0);
  assert.equal(mails.length, 0);
  const vorher = anfragen.length;
  assert.equal(await d.karteEntzogen({}), 0);
  assert.equal(anfragen.length, vorher);
});

function verwaltung({ besitzer = 'u-erika' } = {}) {
  const entzug = [];
  const karte = { token: 'tok-1', display_id: '0042', status: besitzer ? 'assigned' : 'unassigned', user_id: besitzer, user: { name: 'Erika Muster' } };
  const v = kv.kartenVerwaltung({
    accessKarteZurUid: async () => karte, unifiAccessRaw: async () => ({ status: 200, body: { code: 'SUCCESS' } }),
    accessOk: (r) => r.status >= 200 && r.status < 300, accessKartenBesitzerId: (k) => k?.user_id || null,
    accessKartenBesitzerName: (k) => k?.user?.name || null, accessKartenCacheLeeren: () => {},
    kartenProtokollieren: async () => {}, nachEntzug: async (k, durch, grund) => { entzug.push({ k, durch, grund }); },
  });
  return { v, entzug };
}

test('Kartenverwaltung: entziehen und loeschen melden die Sitzungen ab (auch "schon entzogen")', async () => {
  const UID = '04D4C227C22A81';
  let x = verwaltung();
  assert.equal((await x.v.entziehen(UID, 'tina@example.org')).status, 200);
  assert.deepEqual(x.entzug, [{ k: { token: 'tok-1', anzeige: '0042' }, durch: 'tina@example.org', grund: 'karte entzogen (Kartenverwaltung)' }]);
  x = verwaltung({ besitzer: null });
  assert.equal((await x.v.entziehen(UID, 'tina@example.org')).body.schon, true);
  assert.equal(x.entzug.length, 1, 'schon ohne Inhaber: trotzdem abmelden');
  x = verwaltung({ besitzer: null });
  assert.equal((await x.v.loeschen(UID, 'tina@example.org')).status, 200);
  assert.equal(x.entzug[0].grund, 'karte geloescht (Kartenverwaltung)');
});

test('Ausloeser im Server: Access-Routen, Konto-Loeschung, beide Kartenverwaltungen, Dienst verdrahtet', () => {
  const s = lies('api/server.js');
  assert.match(s, /app\.delete\('\/api\/access\/users\/:id\/nfc\/:token'[\s\S]{0,400}karteEntzogenMelden\(\{ token: req\.params\.token \}/);
  assert.match(s, /app\.delete\('\/api\/access\/me\/nfc\/:token'[\s\S]{0,500}karteEntzogenMelden\(\{ token: req\.params\.token \}/);
  assert.match(s, /async function nachlaufKarten[\s\S]*?if \(gut\) await karteEntzogenMelden\(\{ token, anzeige: c\.display_id \|\| null \}/);
  assert.equal((s.match(/nachEntzug: \(karte, durch, grund\) => karteEntzogenMelden\(karte, durch, grund\)/g) || []).length, 2);
  assert.match(s, /appKarteDienst = require\('\.\/routes\/app-karte'\)\.appKarteRoutes\(app, \{/);
  assert.match(s, /async function karteZurAnzeige\(anzeige, email\)[\s\S]*?treffer\.length !== 1[\s\S]*?person\?\.email/);
});

test('Erneuern: Karte entzogen -> alle Sitzungen dieser Karte; QR-Sitzung aus Karte prueft die Karte live', () => {
  const r = lies('api/routes/app-karte.js');
  const erneuern = r.slice(r.indexOf("app.post('/api/apps/sitzung/erneuern'"), r.indexOf('// ── Abmelden aus der App'));
  assert.match(erneuern, /if \(s\.herkunft_karte_token\) \{[\s\S]*?accessKarteLive\(s\.herkunft_karte_token\)[\s\S]*?await karteEntzogen\(\{ token: s\.herkunft_karte_token/);
  assert.match(erneuern, /await karteEntzogen\(\{ token: s\.access_karten_token, anzeige: s\.karte_anzeige \}/);
  // QR-Ausgabe merkt die Karte, Einloesen gibt sie an die Sitzung weiter
  assert.match(r, /const hk = await kartenHerkunft\(req\);/);
  assert.match(r, /herkunftKarte: ausKarte && \(a\.herkunft_karte_token \|\| a\.herkunft_karte\)/);
  assert.match(r, /return \{ tabellen, karteEntzogen \};/);
});

test('Anlage-Token traegt die Anzeige-ID der Karte (PBX), geprueft', () => {
  const a = lies('api/middleware/auth.js');
  assert.match(a, /typeof p\.karte === 'string' && \/\^\[A-Za-z0-9_-\]\{1,40\}\$\/\.test\(p\.karte\)/);
  const py = lies('pbx/api/app.py');
  assert.match(py, /INSERT INTO telefon_sitzungen \(ext, user_id, email, name, gruppen, karte\)/);
  assert.match(py, /daten\["karte"\] = str\(karte\)/);
});
