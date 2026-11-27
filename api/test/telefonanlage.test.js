// node --test api/test/telefonanlage.test.js — Rosenweg Mein Telefon auf geteilten Telefonen:
// /api/telefonanlage/* reicht an die Telefonanlage weiter (routes/telefonanlage.js).
// Ohne Datenbank und ohne Netz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { telefonanlageRoutes, zielPfad, personKopf } = require('../routes/telefonanlage');

const W = path.join(__dirname, '..', '..');

/** Express-Ersatz: nimmt die eine Route auf und ruft sie mit erfundener Anfrage. */
function aufbauen({ geheimnis = 'pbx-geheim', antwort = { status: 200, text: '{"ok":true}' }, wirft = null } = {}) {
  const routen = [];
  const app = { all: (muster, ...h) => routen.push({ muster, h }) };
  const aufrufe = [];
  const fetchFn = async (url, opt) => {
    aufrufe.push({ url, ...opt });
    if (wirft) throw wirft;
    return { status: antwort.status, text: async () => antwort.text };
  };
  const authMiddleware = (req, _res, next) => next();
  telefonanlageRoutes(app, { authMiddleware, pbxUrl: 'http://pbx:8095', pbxGeheimnis: () => geheimnis, fetchFn });
  assert.equal(routen.length, 1);
  assert.equal(routen[0].muster, '/api/telefonanlage/*');
  const rufen = async (methode, pfad, { anlage = { ext: '2041', paket: 'ch.rosenweg4303.meintelefon' }, body } = {}) => {
    const req = {
      method: methode, path: pfad, baseUrl: '', body, anlage,
      user: { id: 7, email: 'erika.muster@example.org', name: 'Erika Müster', groups: ['Bewohner', 'Technik'] },
    };
    const res = {
      code: 200, daten: null, kopf: {},
      status(c) { this.code = c; return this; },
      json(d) { this.daten = d; return this; },
      set(k, v) { this.kopf[k] = v; return this; },
    };
    const [mw, handler] = routen[0].h;
    await new Promise((weiter) => mw(req, res, weiter));
    await handler(req, res);
    return res;
  };
  return { rufen, aufrufe };
}

test('zielPfad: nur die Pfade von Mein Telefon, mit der richtigen Methode', () => {
  assert.equal(zielPfad('GET', '/api/telefonanlage/ich'), '/api/telefon/ich');
  assert.equal(zielPfad('PUT', '/api/telefonanlage/ich/erreichbarkeit'), '/api/telefon/ich/erreichbarkeit');
  assert.equal(zielPfad('GET', '/api/telefonanlage/meine'), '/api/telefon/meine');
  assert.equal(zielPfad('POST', '/api/telefonanlage/ausweis'), '/api/telefon/ausweis');
  assert.equal(zielPfad('DELETE', '/api/telefonanlage/privat/12'), '/api/telefon/privat/12');
  assert.equal(zielPfad('POST', '/api/telefonanlage/2041/abmelden'), '/api/telefon/2041/abmelden');
  assert.equal(zielPfad('GET', '/api/telefonanlage/2041/suchen'), '/api/telefon/2041/suchen');
  assert.equal(zielPfad('POST', '/api/telefonanlage/2041/suchen'), '/api/telefon/2041/suchen');
  // falsche Methode, andere Pfade der Anlage, Umwege
  assert.equal(zielPfad('DELETE', '/api/telefonanlage/ich'), null);
  assert.equal(zielPfad('PUT', '/api/telefonanlage/ich'), null);
  assert.equal(zielPfad('GET', '/api/telefonanlage/portal'), null);
  assert.equal(zielPfad('POST', '/api/telefonanlage/einloesen'), null);
  assert.equal(zielPfad('GET', '/api/telefonanlage/karten/personen'), null);
  assert.equal(zielPfad('DELETE', '/api/telefonanlage/privat/1/../../pbx/sip-privat/1'), null);
  assert.equal(zielPfad('DELETE', '/api/telefonanlage/privat/abc'), null);
  assert.equal(zielPfad('POST', '/api/telefonanlage/2041/fernwartung'), null);
  assert.equal(zielPfad('GET', '/api/telefon/ich'), null);
});

test('personKopf: base64url-JSON mit E-Mail, Name (Umlaute), Gruppen', () => {
  const d = JSON.parse(Buffer.from(personKopf({ id: 7, email: 'a@example.org', name: 'Jürg', groups: ['Bewohner'] }), 'base64url').toString('utf8'));
  assert.deepEqual(d, { id: 7, email: 'a@example.org', name: 'Jürg', groups: ['Bewohner'] });
});

test('Weiterleitung: Geheimnis, Person im Kopf, Körper, Antwort unverändert', async () => {
  const x = aufbauen({ antwort: { status: 200, text: '{"ok":true,"erreichbarkeit":{"weiterleitung":"aus"}}' } });
  const r = await x.rufen('PUT', '/api/telefonanlage/ich/erreichbarkeit', { body: { weiterleitung: 'aus' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.daten, { ok: true, erreichbarkeit: { weiterleitung: 'aus' } });
  assert.equal(r.kopf['Cache-Control'], 'no-store');
  const a = x.aufrufe[0];
  assert.equal(a.url, 'http://pbx:8095/api/telefon/ich/erreichbarkeit');
  assert.equal(a.method, 'PUT');
  assert.equal(a.headers['X-PBX-Secret'], 'pbx-geheim');
  assert.equal(a.headers['X-Rosenweg-Telefon'], '2041');
  assert.equal(JSON.parse(a.body).weiterleitung, 'aus');
  const person = JSON.parse(Buffer.from(a.headers['X-Rosenweg-Im-Auftrag'], 'base64url').toString('utf8'));
  assert.equal(person.email, 'erika.muster@example.org');
  assert.equal(person.name, 'Erika Müster');
});

test('GET ohne Körper; Fehler der Anlage kommen mit Status und Text an', async () => {
  const x = aufbauen({ antwort: { status: 400, text: '{"error":"Zielnummer ungültig"}' } });
  const r = await x.rufen('GET', '/api/telefonanlage/meine');
  assert.equal(x.aufrufe[0].body, undefined);
  assert.equal(r.code, 400);
  assert.equal(r.daten.error, 'Zielnummer ungültig');
});

test('Nur mit dem Anlage-Token (geteiltes Telefon) – andere Anmeldungen fragen die Anlage selbst', async () => {
  const x = aufbauen();
  const r = await x.rufen('GET', '/api/telefonanlage/ich', { anlage: null });
  assert.equal(r.code, 403);
  assert.equal(x.aufrufe.length, 0);
});

test('Unbekannter Pfad: 404, nichts geht an die Anlage', async () => {
  const x = aufbauen();
  const r = await x.rufen('GET', '/api/telefonanlage/../pbx/sip-privat');
  assert.equal(r.code, 404);
  assert.equal(x.aufrufe.length, 0);
});

test('Ohne PBX-Geheimnis 503; Anlage weg 502; 401 der Anlage wird 502 (die Person bleibt angemeldet)', async () => {
  assert.equal((await aufbauen({ geheimnis: '' }).rufen('GET', '/api/telefonanlage/ich')).code, 503);
  assert.equal((await aufbauen({ wirft: new Error('ECONNREFUSED') }).rufen('GET', '/api/telefonanlage/ich')).code, 502);
  const r = await aufbauen({ antwort: { status: 401, text: '{"error":"Nicht angemeldet"}' } }).rufen('GET', '/api/telefonanlage/ich');
  assert.equal(r.code, 502);
});

test('server.js bindet die Routen mit PBX_API_URL und PBX_SHARED_SECRET ein', () => {
  const s = fs.readFileSync(path.join(W, 'api', 'server.js'), 'utf8');
  assert.match(s, /require\('\.\/routes\/telefonanlage'\)\.telefonanlageRoutes\(app, \{\s*authMiddleware, pbxUrl: PBX_API_URL, pbxGeheimnis: \(\) => PBX_SHARED_SECRET,/);
});

test('Anlage: Portal-Pfade fuer Mein Telefon und Kopf nur mit Geheimnis', () => {
  const py = fs.readFileSync(path.join(W, 'pbx', 'api', 'app.py'), 'utf8');
  assert.match(py, /"ch\.rosenweg4303\.meintelefon": \["\/api\/telefonanlage\/"/);
  assert.match(py, /def _im_auftrag\(\):/);
});
