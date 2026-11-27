// node --test api/test/stufen.test.js — Anmelde-Stufen (lib/stufen.js, nur Auskunft).
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../lib/stufen');

const jetzt = Date.UTC(2026, 10, 27, 12, 0, 0);
const vor = (min) => Math.floor(jetzt / 1000 - min * 60);

test('Grundstufen je Ausweis', () => {
  for (const art of ['karte', 'qr', 'handy', 'anlage']) assert.equal(st.anmeldung(art, vor(1), jetzt).stufe, 'karte', art);
  for (const art of ['website', 'otp', 'app', 'authentik', 'pat']) assert.equal(st.anmeldung(art, vor(600), jetzt).stufe, 'konto', art);
  assert.equal(st.anmeldung('unbekannt', vor(1), jetzt).stufe, 'karte');
  assert.equal(st.anmeldung(undefined).stufe, 'karte');
});

test('frisch nur mit junger auth_time und nur fuer Konto-Anmeldungen', () => {
  assert.equal(st.anmeldung('website', vor(1), jetzt).stufe, 'frisch');
  assert.equal(st.anmeldung('app', vor(st.FRISCH_MIN - 1), jetzt).stufe, 'frisch');
  assert.equal(st.anmeldung('authentik', vor(2), jetzt).stufe, 'frisch');
  assert.equal(st.anmeldung('app', vor(st.FRISCH_MIN + 1), jetzt).stufe, 'konto');
  assert.equal(st.anmeldung('website', null, jetzt).stufe, 'konto');
  // PAT und OTP sind nie frisch, die Karte erst recht nicht
  assert.equal(st.anmeldung('pat', vor(0), jetzt).stufe, 'konto');
  assert.equal(st.anmeldung('otp', vor(0), jetzt).stufe, 'konto');
  assert.equal(st.anmeldung('karte', vor(0), jetzt).stufe, 'karte');
  // Anmeldezeit weit in der Zukunft: misstrauen
  assert.equal(st.anmeldung('app', vor(-10), jetzt).stufe, 'konto');
  assert.deepEqual(st.anmeldung('app', vor(1), jetzt), { stufe: 'frisch', art: 'app', auth_time: vor(1) });
});

test('auth_time aus einem JWT lesen', () => {
  const jwt = (claims) => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
  assert.equal(st.authTimeAus(st.jwtClaims(jwt({ auth_time: 1764240000 }))), 1764240000);
  assert.equal(st.authTimeAus(st.jwtClaims(jwt({ iat: 1 }))), null);
  assert.equal(st.authTimeAus(st.jwtClaims('kein-jwt')), null);
  assert.equal(st.authTimeAus(st.jwtClaims(jwt({ auth_time: 'gestern' }))), null);
});

test('Rangfolge karte < konto < frisch', () => {
  assert.ok(st.stufeReicht('frisch', 'konto'));
  assert.ok(st.stufeReicht('konto', 'konto'));
  assert.ok(!st.stufeReicht('karte', 'konto'));
  assert.ok(!st.stufeReicht('konto', 'frisch'));
  assert.ok(!st.stufeReicht(undefined, 'konto'));
  assert.ok(!st.stufeReicht('frisch', 'quatsch')); // unbekannte Anforderung: nie erfuellt
});

test('Karten-Arten', () => {
  for (const art of ['karte', 'qr', 'handy', 'anlage']) assert.ok(st.istKartenSitzung({ auth: st.anmeldung(art) }), art);
  for (const art of ['website', 'app', 'pat', 'bestaetigt']) assert.ok(!st.istKartenSitzung({ auth: st.anmeldung(art) }), art);
  assert.ok(!st.istKartenSitzung({}));
  assert.equal(st.anmeldung('bestaetigt').stufe, 'konto');
});
