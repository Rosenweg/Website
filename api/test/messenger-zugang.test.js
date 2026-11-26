// node --test api/test/messenger-zugang.test.js — Zugang je Handy (lib/messenger-zugang.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mz = require('../lib/messenger-zugang');

test('Obergrenze: Standard 20, Einstellung MESSENGER_PRIVAT_MAX', () => {
  assert.equal(mz.maxJePerson({}), 20);
  assert.equal(mz.maxJePerson({ MESSENGER_PRIVAT_MAX: '7' }), 7);
  assert.equal(mz.maxJePerson({ MESSENGER_PRIVAT_MAX: '0' }), 20);
  assert.equal(mz.maxJePerson({ MESSENGER_PRIVAT_MAX: 'viele' }), 20);
});

test('Schluessel: eigenes Geheimnis vor abgeleitetem, abgeleitet != Dienst-Geheimnis', () => {
  assert.equal(mz.signierSchluessel({}), null);
  const abg = mz.signierSchluessel({ MESSENGER_SERVICE_SECRET: 'dienst' });
  assert.ok(Buffer.isBuffer(abg));
  assert.notEqual(abg.toString(), 'dienst');
  assert.equal(mz.signierSchluessel({ MESSENGER_PRIVAT_SECRET: 'x', MESSENGER_SERVICE_SECRET: 'dienst' }).toString(), 'x');
});

test('Token: HS256, Claims, Signatur pruefbar', () => {
  const k = Buffer.from('geheim');
  const { token, gueltigBis } = mz.signiereToken({ userId: 42, email: 'a@b.ch', name: 'A', groups: ['bewohner'], zugangId: 5 }, k, 1000);
  const [h, p, s] = token.split('.');
  assert.equal(s, crypto.createHmac('sha256', k).update(`${h}.${p}`).digest('base64url'));
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual([c.iss, c.aud, c.sub, c.mz, c.exp, gueltigBis], ['rosenweg-app', 'rosenweg-messenger', '42', '5', 1000 + 3600, 1000 + 3600]);
  assert.deepEqual(c.groups, ['bewohner']);
});

test('Geheimnis: nur der Hash wird gespeichert, Vergleich exakt', () => {
  const g = mz.neuesGeheimnis();
  assert.ok(g.geheimnis.length >= 40);
  assert.notEqual(g.hash, g.geheimnis);
  assert.equal(mz.geheimnisPasst(g.geheimnis, g.hash), true);
  assert.equal(mz.geheimnisPasst(g.geheimnis + 'x', g.hash), false);
  assert.equal(mz.geheimnisPasst('', g.hash), false);
  assert.equal(mz.geheimnisPasst(undefined, g.hash), false);
});

test('Zugangs-ID und Geraetename', () => {
  assert.equal(mz.zugangId('12'), 12);
  assert.equal(mz.zugangId(12), 12);
  for (const x of ['0', '-1', '1e3', 'z5', '', null, '1234567890']) assert.equal(mz.zugangId(x), null);
  assert.equal(mz.geraeteName('Pixel\n8\u0000'), 'Pixel 8');
  assert.equal(mz.geraeteName('x'.repeat(100)).length, 60);
});

test('Broker-Benutzername: geteiltes Telefon msg-<sub>, eigenes Handy msg-<sub>-z<mz>', () => {
  assert.equal(mz.brokerBenutzername({ sub: '42' }), 'msg-42');
  assert.equal(mz.brokerBenutzername({ sub: 42, mz: '5' }), 'msg-42-z5');
  assert.equal(mz.brokerBenutzername({ sub: '42', mz: 'x' }), null);
  assert.equal(mz.brokerBenutzername({}), null);
});
