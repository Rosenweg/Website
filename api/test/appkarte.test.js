// node --test api/test/appkarte.test.js — Karten-Anmeldung der Apps (lib/appkarte.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const ak = require('../lib/appkarte');

function schluesselpaar(kurve = 'prime256v1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: kurve });
  return { oeffentlich: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privat: privateKey };
}
const unterschreiben = (privat, text) =>
  crypto.sign('sha256', Buffer.from(text, 'utf8'), { key: privat, dsaEncoding: 'der' }).toString('base64');

const gueltig = (extra = {}) => ({
  uid: '04:d4:c2:27:c2:2a:81', app: 'ch.rosenweg4303.telefon', app_name: 'Rosenweg Telefon',
  geraet: { kennung: 'a'.repeat(64), name: 'Galaxy A15', plattform: 'Android 16' },
  schluessel: schluesselpaar().oeffentlich, ...extra,
});

test('Unterschrift mit dem richtigen Schluessel gilt, mit einem fremden nicht', () => {
  const a = schluesselpaar(), b = schluesselpaar();
  const text = ak.erneuernText('ks_' + '0'.repeat(32), 'herausforderung');
  assert.equal(ak.unterschriftGueltig(a.oeffentlich, text, unterschreiben(a.privat, text)), true);
  assert.equal(ak.unterschriftGueltig(a.oeffentlich, text, unterschreiben(b.privat, text)), false);
  // andere Herausforderung (Wiederholung einer alten Unterschrift)
  assert.equal(ak.unterschriftGueltig(a.oeffentlich, ak.erneuernText('ks_' + '0'.repeat(32), 'andere'),
    unterschreiben(a.privat, text)), false);
  assert.equal(ak.unterschriftGueltig(a.oeffentlich, text, 'kaputt'), false);
});

test('nur EC P-256 als Geraeteschluessel', () => {
  assert.ok(ak.oeffentlicherSchluessel(schluesselpaar().oeffentlich));
  assert.equal(ak.oeffentlicherSchluessel(schluesselpaar('secp384r1').oeffentlich), null);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(ak.oeffentlicherSchluessel(rsa), null);
  assert.equal(ak.oeffentlicherSchluessel('x'.repeat(100)), null);
});

test('Anfrage pruefen: UID normalisiert, Pflichtfelder', () => {
  const p = ak.anmeldungPruefen(gueltig());
  assert.equal(p.ok, true);
  assert.equal(p.werte.uid, '04D4C227C22A81');
  assert.equal(p.werte.geraetName, 'Galaxy A15');
  assert.equal(ak.anmeldungPruefen(gueltig({ uid: '123' })).ok, false);
  assert.equal(ak.anmeldungPruefen(gueltig({ app: 'keine app' })).ok, false);
  assert.equal(ak.anmeldungPruefen(gueltig({ geraet: { kennung: 'kurz' } })).ok, false);
  assert.equal(ak.anmeldungPruefen(gueltig({ schluessel: undefined })).ok, false);
  assert.equal(ak.anmeldungPruefen(null).ok, false);
  // Steuerzeichen/HTML aus Anzeigetexten (landen in Mail und Portal)
  const x = ak.anmeldungPruefen(gueltig({ geraet: { kennung: 'b'.repeat(64), name: 'Evil\n<script>' } }));
  assert.equal(x.werte.geraetName, 'Evil script');
});

test('Ratenbegrenzung je IP, Karte, Geraet und gesamt', () => {
  assert.equal(ak.gebremst({}), null);
  assert.equal(ak.gebremst({ ipFehl: 9 }), null);
  assert.equal(ak.gebremst({ ipFehl: 10 }), 'ip');
  assert.equal(ak.gebremst({ ipAlle: 40 }), 'ip');
  assert.equal(ak.gebremst({ uidFehl: 5 }), 'karte');
  assert.equal(ak.gebremst({ geraetFehl: 10 }), 'geraet');
  assert.equal(ak.gebremst({ globalFehl: 200, ipFehl: 0 }), 'global');
});

test('Obergrenze: die am laengsten unbenutzten weichen', () => {
  const s = (id, tag) => ({ id, zuletzt: new Date(Date.UTC(2026, 10, tag)) });
  const aktiv = [s('c', 20), s('a', 1), s('b', 10)];
  assert.deepEqual(ak.abzuloesen(aktiv, 20), []);
  assert.deepEqual(ak.abzuloesen(aktiv, 3), ['a']);       // Platz fuer die neue
  assert.deepEqual(ak.abzuloesen(aktiv, 2), ['a', 'b']);
  assert.deepEqual(ak.abzuloesen([], 1), []);
  const zwanzig = Array.from({ length: 20 }, (_, i) => s('x' + i, i + 1));
  assert.deepEqual(ak.abzuloesen(zwanzig, 20), ['x0']);
});

test('Token und Sitzungs-Id haben ihr Format', () => {
  assert.match(ak.neuesZugangsToken(), /^rw_app_[A-Za-z0-9_-]{43}$/);
  assert.match(ak.neueSitzungsId(), ak.SITZUNG_RE);
  assert.notEqual(ak.neuesZugangsToken(), ak.neuesZugangsToken());
});
