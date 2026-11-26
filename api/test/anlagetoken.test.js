// node --test api/test/anlagetoken.test.js — Anlage-Portal-Token (lib/anlagetoken.js)
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORTAL_ANLAGE_SECRET = 'test-geheimnis-nur-fuer-den-test';
const { istAnlageToken, anlageTokenPruefen, anlageTokenAusstellen, pfadNormal } = require('../lib/anlagetoken');

const person = { email: 'anna@example.ch', sub: '7', ext: '2098', paket: 'ch.rosenweg4303.salz', methode: 'GET', pfad: '/api/salz/lager' };

test('gueltiges Token wird angenommen, Pfad normalisiert', () => {
  const t = anlageTokenAusstellen(person);
  assert.ok(istAnlageToken(t));
  const p = anlageTokenPruefen(t);
  assert.equal(p.email, 'anna@example.ch');
  assert.equal(p.pfad, 'salz/lager');
  assert.equal(p.methode, 'GET');
});

test('nur einmal verwendbar', () => {
  const t = anlageTokenAusstellen(person);
  assert.ok(anlageTokenPruefen(t));
  assert.equal(anlageTokenPruefen(t), null);
});

test('falscher Schluessel, veraendert, abgelaufen, zu lange gueltig -> null', () => {
  assert.equal(anlageTokenPruefen(anlageTokenAusstellen(person, 'anderes-geheimnis')), null);
  const t = anlageTokenAusstellen(person).split('.');
  const inhalt = JSON.parse(Buffer.from(t[1], 'base64url').toString());
  inhalt.email = 'technik@example.ch';
  assert.equal(anlageTokenPruefen([t[0], Buffer.from(JSON.stringify(inhalt)).toString('base64url'), t[2]].join('.')), null);
  assert.equal(anlageTokenPruefen(anlageTokenAusstellen(person), Date.now() + 61_000), null);
  assert.equal(anlageTokenPruefen(anlageTokenAusstellen({ ...person, exp: Math.floor(Date.now() / 1000) + 3600 })), null);
});

test('ohne Schluessel ist der Weg aus', () => {
  const t = anlageTokenAusstellen(person);
  const alt = process.env.PORTAL_ANLAGE_SECRET;
  process.env.PORTAL_ANLAGE_SECRET = '';
  try {
    assert.equal(anlageTokenPruefen(t), null);
  } finally {
    process.env.PORTAL_ANLAGE_SECRET = alt;
  }
});

test('andere JWTs sind kein Anlage-Token', () => {
  const kopf = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const inhalt = Buffer.from(JSON.stringify({ iss: 'https://authentik.rosenweg4303.ch/', aud: 'rosenweg-apps' })).toString('base64url');
  assert.equal(istAnlageToken(`${kopf}.${inhalt}.x`), false);
  assert.equal(istAnlageToken('rw_pat_abc'), false);
});

test('pfadNormal wie authMiddleware', () => {
  assert.equal(pfadNormal('/api/Salz//sorten/4001?x=1'), 'salz/sorten/4001');
  assert.equal(pfadNormal('/api/auth/me/'), 'auth/me');
});

// Gegenprobe mit einem Token, das die PBX-API (Python, pbx/api/app.py _portal_token) ausstellt
test('Token der PBX-API (Python) wird angenommen', { skip: !process.env.PBX_TOKEN_PROBE }, () => {
  const p = anlageTokenPruefen(process.env.PBX_TOKEN_PROBE);
  assert.ok(p);
  assert.equal(p.pfad, 'salz/lager');
});
