// node --test api/test/kartenverwaltung.test.js — Kartenverwaltung in der Haupt-API
// (aus der Telefonanlage umgezogen, Entscheid Stefan 27.11.2026): lib/kartenverwaltung.js
// mit erfundenem UniFi Access, Routen /api/karten/* und offene /api/apps/sitzungen.
// Ohne Datenbank und ohne Netz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const kv = require('../lib/kartenverwaltung');

const W = path.join(__dirname, '..', '..');
const lies = (p) => fs.readFileSync(path.join(W, p), 'utf8');
const UID = '04D4C227C22A81';

/** Erfundenes UniFi Access: eine Karte, zwei Benutzer. */
function access({ besitzer = null, accessBenutzer = true, antwort = { status: 200, body: { code: 'SUCCESS' } } } = {}) {
  const log = [], aufrufe = [];
  const karte = { token: 'tok-1', display_id: '0042', status: besitzer ? 'assigned' : 'unassigned',
    user_id: besitzer, user: besitzer ? { name: besitzer === 'u-erika' ? 'Erika Muster' : 'Max Beispiel' } : null };
  const deps = {
    accessKarteZurUid: async (id) => (id === UID ? karte : null),
    accessKarteImportieren: async () => ({ token: 'tok-neu', display_id: '0099' }),
    karteNachschlagen: async (id) => (id === UID
      ? { found: true, assigned: !!besitzer, status: karte.status, display_id: '0042', access_name: 'Erika Muster',
          person: besitzer ? { user_id: '7', email: 'erika@example.org', name: 'Erika Muster', groups: ['Technik'] } : null, karte }
      : { found: false }),
    unifiUserByEmail: async (e) => (accessBenutzer && e === 'erika@example.org' ? { id: 'u-erika', first_name: 'Erika', last_name: 'Muster' } : null),
    unifiAccessRaw: async (m, p, b) => { aufrufe.push([m, p, b]); return antwort; },
    accessOk: (r) => r.status >= 200 && r.status < 300,
    accessKartenBesitzerId: (k) => k?.user_id || null,
    accessKartenBesitzerName: (k) => k?.user?.name || null,
    accessKartenCacheLeeren: () => {},
    kartenProtokollieren: async (aktion, f) => { log.push({ aktion, ...f }); },
  };
  return { deps, log, aufrufe, v: kv.kartenVerwaltung(deps) };
}

test('UID: wie Tag.getId() als Hex, 4-10 Bytes', () => {
  assert.equal(kv.normNfcId('04:d4:c2:27:c2:2a:81'), UID);
  assert.ok(kv.nfcIdGueltig(UID));
  assert.ok(!kv.nfcIdGueltig('ABC'));
  assert.ok(!kv.nfcIdGueltig('0123456'));
  assert.ok(!kv.nfcIdGueltig('../etc'));
});

test('Info: ohne Gruppen und Website-ID, mit uid, protokolliert', async () => {
  const { v, log } = access({ besitzer: 'u-erika' });
  const { status, body } = await v.info(UID, 'Portal (Max <m@example.org>)');
  assert.equal(status, 200);
  assert.deepEqual(body.person, { name: 'Erika Muster', email: 'erika@example.org' });
  assert.equal(body.uid, UID);
  assert.equal(body.karte, undefined);
  assert.equal(log[0].aktion, 'info');
  assert.equal((await v.info('XYZ', 'x')).status, 400);
  assert.equal((await access().v.info('0102030405060708', 'x')).body.found, false);
});

test('Zuordnen: freie Karte, schon zugeordnet, fremde Karte, kein Access-Benutzer', async () => {
  let a = access();
  let r = await a.v.zuordnen(UID, 'Erika@Example.org', 'Portal');
  assert.equal(r.status, 200);
  assert.equal(r.body.display_id, '0042');
  assert.deepEqual(a.aufrufe[0], ['PUT', '/users/u-erika/nfc_cards', { token: 'tok-1' }]);
  assert.equal(a.log.at(-1).aktion, 'zuordnen');
  assert.equal(a.log.at(-1).erfolg, true);

  r = await access({ besitzer: 'u-erika' }).v.zuordnen(UID, 'erika@example.org', 'Portal');
  assert.equal(r.body.schon, true);

  a = access({ besitzer: 'u-max' });
  r = await a.v.zuordnen(UID, 'erika@example.org', 'Portal');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Max Beispiel/);
  assert.equal(a.aufrufe.length, 0);

  a = access({ accessBenutzer: false });
  r = await a.v.zuordnen(UID, 'erika@example.org', 'Portal');
  assert.equal(r.status, 404);
  assert.equal(a.log[0].detail, 'kein Access-Benutzer');

  assert.equal((await access().v.zuordnen(UID, 'keine-mail', 'x')).status, 400);
});

test('Entziehen und Löschen: Löschen nur ohne Inhaber; Access-Fehler -> 502', async () => {
  let a = access({ besitzer: 'u-erika' });
  assert.equal((await a.v.loeschen(UID, 'x')).status, 409);
  const r = await a.v.entziehen(UID, 'x');
  assert.equal(r.status, 200);
  assert.deepEqual(a.aufrufe[0], ['PUT', '/users/u-erika/nfc_cards/delete', { token: 'tok-1' }]);
  a = access();
  assert.equal((await a.v.loeschen(UID, 'x')).status, 200);
  assert.deepEqual(a.aufrufe[0], ['DELETE', '/credentials/nfc_cards/tokens/tok-1', undefined]);
  assert.equal((await access({ antwort: { status: 0 } }).v.loeschen(UID, 'x')).status, 502);
  assert.equal((await access({ besitzer: 'u-erika', antwort: { status: 500, body: { msg: 'kaputt' } } }).v.entziehen(UID, 'x')).status, 502);
  assert.equal((await access().v.entziehen('0102030405060708', 'x')).status, 404);
});

test('Durch: Telefon, App oder Portal', () => {
  const u = { name: 'Erika Muster', email: 'erika@example.org' };
  assert.equal(kv.durchText({ user: u, anlage: { ext: '2099' } }), 'Telefon 2099 (Erika Muster <erika@example.org>)');
  assert.equal(kv.durchText({ user: u, rosenwegApp: { text: 'ch.rosenweg4303.zutritt/1.0.0' } }),
    'ch.rosenweg4303.zutritt/1.0.0 (Erika Muster <erika@example.org>)');
  assert.equal(kv.durchText({ user: u }), 'Portal (Erika Muster <erika@example.org>)');
});

test('Personenliste: je E-Mail eine Zeile, sortiert, ohne Ungültige', () => {
  assert.deepEqual(kv.personenListe([
    { email: 'MAX@example.org', name: 'Max Beispiel' }, { email: 'erika@example.org', name: 'Erika Muster' },
    { email: 'max@example.org', name: 'Beispiel Max' }, { email: '', name: 'Ohne' }, { email: 'kaputt', name: 'X' },
  ]), [{ name: 'Beispiel Max', email: 'max@example.org' }, { name: 'Erika Muster', email: 'erika@example.org' }]);
});

test('Übernahme aus telefon_log: nur Kartenaktionen, Quelle pbx:<id>, Ziel und Fehler gelesen', () => {
  const z = kv.pbxZeileUebernehmen({ id: 12, ext: '2099', ereignis: 'karte-zu', email: 'erika@example.org', name: 'Erika Muster',
    durch: 'karte:0042->max@example.org:409', zeit: '2026-11-25 08:15:00' });
  assert.equal(z.quelle, 'pbx:12');
  assert.equal(z.aktion, 'telefon-zuordnen');
  assert.equal(z.display_id, '0042');
  assert.equal(z.ziel_email, 'max@example.org');
  assert.equal(z.erfolg, false);
  assert.equal(z.created_at, '2026-11-25T08:15:00.000Z');
  assert.equal(z.durch, 'Telefon 2099 (Erika Muster <erika@example.org>)');
  const app = kv.pbxZeileUebernehmen({ id: 13, ext: 'App', ereignis: 'karte-info', durch: 'karte:04D4C227C22A81', zeit: '2026-11-26 10:00:00' });
  assert.equal(app.erfolg, true);
  assert.match(app.durch, /^Rosenweg Karten/);
  for (const e of ['an', 'ab', 'karte-abgelehnt', 'gefunden']) {
    assert.equal(kv.pbxZeileUebernehmen({ id: 1, ereignis: e, zeit: '2026-11-25 08:15:00' }), null);
  }
  assert.equal(kv.pbxZeileUebernehmen({ id: 'x', ereignis: 'karte-zu', zeit: '2026-11-25 08:15:00' }), null);
});

test('Routen: /api/karten/* mit Technik/Präsident, alter Protokollpfad bleibt, Übernahme nur mit PBX-Geheimnis', () => {
  const src = lies('api/routes/karten.js');
  assert.ok(src.includes("app.post('/api/karten/info', authMiddleware, nurLesen, requireTechnikOrPraesident,"));
  for (const r of ["get('/api/karten/personen'", "post('/api/karten/zuordnen'",
    "post('/api/karten/entziehen'", "post('/api/karten/loeschen'", "get('/api/karten/protokoll'", "get('/api/karten-protokoll'"]) {
    assert.ok(src.includes(`app.${r}, ...nurTechnik`), r);
  }
  assert.match(src, /const nurTechnik = \[authMiddleware, requireTechnikOrPraesident\]/);
  assert.match(src, /app\.post\('\/api\/pbx\/karten-protokoll\/uebernahme', requirePbxSecret/);
  assert.match(src, /ON CONFLICT \(quelle\)/);
  const server = lies('api/server.js');
  assert.match(server, /require\('\.\/routes\/karten'\)\.kartenRoutes\(app, \{/);
  // Nur einmal registriert: die alte Route in server.js ist weg
  assert.equal((server.match(/'\/api\/karten-protokoll'/g) || []).length, 0);
  // requireTechnikOrPraesident vermerkt Admin-Aktionen mit der Karte
  assert.match(server, /function requireTechnikOrPraesident\(req, res, next\) \{[\s\S]{0,300}kartenAdmin\.vermerken\(req, res\)/);
});

test('Anmeldungen der Apps: mit Karte ansehen und abmelden (protokolliert), Zugangstoken nicht', () => {
  const src = lies('api/routes/app-karte.js');
  for (const r of ["app.get('/api/apps/sitzungen'", "app.delete('/api/apps/sitzungen/:id'", "app.post('/api/apps/sitzungen/alle-abmelden'"]) {
    assert.ok(src.includes(`${r}, authMiddleware, kontoOderKarte,`), r);
  }
  assert.match(src, /const kontoOderKarte = \(req, res, next\) => \{\s*if \(req\.pat\) return res\.status\(403\)/);
  assert.match(src, /kartenAdmin\.vermerken\(req, res\)/);
  assert.match(src, /ansehenVermerken\(req, alle\)/);
  // QR-Ausweis seit 28.11.2026 auch mit der Karte (nie PAT, schluessel-freigaben.test.js);
  // Handy-Code bestätigen bleibt beim Konto
  assert.ok(src.includes("app.post('/api/apps/qr-ausweis', authMiddleware, qrAusstellen,"));
  assert.ok(src.includes("app.post('/api/apps/handy-code/:code/:wahl(bestaetigen|ablehnen)', authMiddleware, requireUserLogin,"));
});

test('Quittung nennt Kartenaktionen verständlich', () => {
  const ka = require('../lib/kartenadmin');
  assert.equal(ka.aktionText('POST', '/api/karten/zuordnen'), 'Rosenweg-Karten: Karte zugeordnet');
  assert.equal(ka.aktionText('POST', '/api/karten/loeschen'), 'Rosenweg-Karten: Karte gelöscht');
  assert.equal(ka.aktionText('DELETE', '/api/apps/sitzungen/abc'), 'Anmeldungen der Apps: gelöscht');
});
