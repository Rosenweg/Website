// node --test api/test/pbx-person-loeschen.test.js — Konto geloescht: die Anlage entfernt
// das Hintergrundbild der Person (pbx-api POST /api/pbx/person/loeschen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { personLoeschen } = require('../lib/pbxperson');

test('ruft die Anlage mit Geheimnis und kleingeschriebener E-Mail', async () => {
  let gesehen;
  const fetchFn = async (url, opts) => { gesehen = { url, opts }; return { ok: true, json: async () => ({ ok: true, hintergrund: true }) }; };
  const r = await personLoeschen({ url: 'http://pbx:8095/', secret: 's3', email: ' Anna@Example.org ', fetchFn });
  assert.deepEqual(r, { ok: true, hintergrund: true });
  assert.equal(gesehen.url, 'http://pbx:8095/api/pbx/person/loeschen');
  assert.equal(gesehen.opts.method, 'POST');
  assert.equal(gesehen.opts.headers['X-PBX-Secret'], 's3');
  assert.deepEqual(JSON.parse(gesehen.opts.body), { email: 'anna@example.org' });
});

test('Fehler der Anlage brechen die Loeschung nicht ab', async () => {
  assert.equal((await personLoeschen({ url: 'http://pbx', secret: 's', email: 'a@b.ch', fetchFn: async () => ({ ok: false, status: 401 }) })).grund, 'HTTP 401');
  assert.equal((await personLoeschen({ url: 'http://pbx', secret: 's', email: 'a@b.ch', fetchFn: async () => { throw new TypeError('x'); } })).ok, false);
  assert.equal((await personLoeschen({ url: 'http://pbx', secret: '', email: 'a@b.ch', fetchFn: async () => assert.fail() })).ok, false);
  assert.equal((await personLoeschen({ url: 'http://pbx', secret: 's', email: '', fetchFn: async () => assert.fail() })).ok, false);
});

test('lokalesKontoNachLoeschung ruft die Anlage', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const f = src.slice(src.indexOf('async function lokalesKontoNachLoeschung'), src.indexOf('async function nochAktiverKontakt'));
  assert.match(f, /require\('\.\/lib\/pbxperson'\)\.personLoeschen\(\{ url: PBX_API_URL, secret: PBX_SHARED_SECRET, email: e \}\)/);
  // und das wird im Loesch-Lauf nach dem Authentik-DELETE aufgerufen
  assert.match(src, /authentikAPI\('DELETE', `\/core\/users\/\$\{user\.pk\}\/`\);[\s\S]{0,200}await lokalesKontoNachLoeschung\(row\.email\)/);
});
