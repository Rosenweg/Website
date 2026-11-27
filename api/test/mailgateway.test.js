// node --test api/test/mailgateway.test.js — Gateway-User für den Mailversand (lib/mailgateway.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../lib/mailgateway');

const ENV = {
  MAIL_2FA_USER: '2fa@rosenweg4303.ch', MAIL_2FA_PASS: 'a',
  MAIL_NOREPLY_USER: 'noreply@rosenweg4303.ch', MAIL_NOREPLY_PASS: 'b',
};
const GW = g.gatewaysLesen(ENV);
const MAIL_FROM = 'noreply@rosenweg4303.ch';

test('Gateways aus der Umgebung, nur vollständige', () => {
  assert.deepEqual(Object.keys(GW).sort(), ['2fa', 'noreply']);
  const ohnePass = g.gatewaysLesen({ MAIL_2FA_USER: '2fa@x.ch', MAIL_NOREPLY_USER: 'n@x.ch', MAIL_NOREPLY_PASS: 'p' });
  assert.deepEqual(Object.keys(ohnePass), ['noreply']);
  // weitere Gateways per MAIL_GATEWAYS, noreply ist immer dabei
  const mehr = g.gatewaysLesen({ MAIL_GATEWAYS: 'verteiler', MAIL_VERTEILER_USER: 'v@x.ch', MAIL_VERTEILER_PASS: 'p', MAIL_NOREPLY_USER: 'n@x.ch', MAIL_NOREPLY_PASS: 'p' });
  assert.deepEqual(Object.keys(mehr).sort(), ['noreply', 'verteiler']);
});

test('Bestätigungen und Zweitfaktor gehen über 2fa@', () => {
  for (const t of ['karten-bestaetigung', 'karten-admin-quittung', 'otp-login', 'reklamation-code', 'doodle-code',
    'app-karte-neues-geraet', 'app-qr-neues-geraet', 'app-handy-neues-geraet']) {
    assert.equal(g.gatewayWaehlen(t, GW).user, '2fa@rosenweg4303.ch', t);
  }
});

test('alles andere über noreply@, fehlender Gateway fällt auf noreply@ zurück', () => {
  for (const t of ['whatsapp-bot-not-ready', 'verteiler-batch', 'alarmpanel', 'vmq-auslage-neu', undefined]) {
    assert.equal(g.gatewayWaehlen(t, GW).user, 'noreply@rosenweg4303.ch', String(t));
  }
  const nurNoreply = { noreply: GW.noreply };
  assert.equal(g.gatewayWaehlen('otp-login', nurNoreply).user, 'noreply@rosenweg4303.ch');
  assert.equal(g.gatewayWaehlen('otp-login', {}), null);
});

test('Systemabsender wird zur Gateway-Adresse, Anzeigename bleibt bzw. "Rosenweg"', () => {
  const a = g.absenderSetzen({ from: MAIL_FROM, to: 'x@y.ch', subject: 's' }, GW['2fa'], MAIL_FROM);
  assert.deepEqual(a.from, { name: 'Rosenweg', address: '2fa@rosenweg4303.ch' });
  assert.equal(a.envelope, undefined);
  assert.equal(a.sender, undefined);
  const b = g.absenderSetzen({ from: '"Rosenweg Druckserver" <noreply@rosenweg4303.ch>', to: 'x@y.ch' }, GW.noreply, MAIL_FROM);
  assert.deepEqual(b.from, { name: 'Rosenweg Druckserver', address: 'noreply@rosenweg4303.ch' });
  const c = g.absenderSetzen({ to: 'x@y.ch' }, GW.noreply, MAIL_FROM); // ohne from (alarmpanel)
  assert.deepEqual(c.from, { name: 'Rosenweg', address: 'noreply@rosenweg4303.ch' });
});

test('fremder Kopf-Absender (Verteiler) bleibt, Umschlag und Sender = Gateway', () => {
  const opts = { from: '"Anna via Eigentümer" <eigentuemer@rosenweg4303.ch>', to: 'undisclosed-recipients:;', bcc: ['a@x.ch', 'b@y.ch'] };
  const v = g.absenderSetzen(opts, GW.noreply, MAIL_FROM);
  assert.equal(v.from, opts.from);
  assert.equal(v.sender, 'noreply@rosenweg4303.ch');
  assert.deepEqual(v.envelope, { from: 'noreply@rosenweg4303.ch', to: opts.to, cc: undefined, bcc: opts.bcc });
  assert.equal(opts.sender, undefined, 'Original unverändert');
});

test('Adressen zerlegen', () => {
  assert.deepEqual(g.adresseZerlegen('"A B" <a@b.ch>'), { name: 'A B', address: 'a@b.ch' });
  assert.deepEqual(g.adresseZerlegen('a@b.ch'), { name: null, address: 'a@b.ch' });
  assert.deepEqual(g.adresseZerlegen({ name: 'X', address: 'x@y.ch' }), { name: 'X', address: 'x@y.ch' });
});
