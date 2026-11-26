// node --test api/test/kiosk.test.js — Kiosk-Fernseher (lib/kiosk.js):
// Kopplungscode, PIN-Hash wie in der App, PIN-Verschlüsselung, Lebenszeichen,
// „neueste Änderung gewinnt", Antwort an den Fernseher.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const k = require('../lib/kiosk');

const SCHLUESSEL = k.pinSchluessel('nur-fuer-tests-0123456789-abcdefghijklmnop');

test('Kopplungscode: acht Zeichen ohne Verwechsler, getippt wie auch immer', () => {
  for (let i = 0; i < 200; i += 1) {
    const c = k.codeErzeugen();
    assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(k.codeNormal(k.codeAnzeige(c).toLowerCase()), c);
  }
  assert.equal(k.codeNormal(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(k.codeNormal('ABCD EFGH'), 'ABCDEFGH');
  assert.equal(k.codeNormal('ABCD-EFG'), null);        // zu kurz
  assert.equal(k.codeNormal('ABCD-EFG0'), null);       // 0 gibt es nicht
  assert.equal(k.codeNormal('ABCD-EFGI'), null);       // I gibt es nicht
  assert.equal(k.codeAnzeige('ABCDEFGH'), 'ABCD-EFGH');
});

test('PIN-Hash: PBKDF2-HMAC-SHA256, 60 000 Runden, 32 Byte — wie KioskSpeicher.kt', () => {
  const salz = '00112233445566778899aabbccddeeff';
  const h = k.pinHash('9999', salz);
  assert.equal(h.runden, 60000);
  assert.equal(h.salz, salz);
  const erwartet = crypto.pbkdf2Sync(Buffer.from('9999'), Buffer.from(salz, 'hex'), 60000, 32, 'sha256').toString('hex');
  assert.equal(h.hash, erwartet);
  assert.equal(h.hash.length, 64);
  assert.ok(k.pinPruefen('9999', h));
  assert.ok(!k.pinPruefen('9998', h));
  assert.ok(!k.pinPruefen('9999', null));
  // jedes Mal ein neues Salz
  assert.notEqual(k.pinHash('9999').salz, k.pinHash('9999').salz);
  assert.throws(() => k.pinHash('123'));
  assert.throws(() => k.pinHash('123456789'));
  assert.throws(() => k.pinHash('12a4'));
});

test('PIN-Verschlüsselung: hin und zurück, an die Station gebunden, Manipulation fällt auf', () => {
  const e = k.pinVerschluesseln('4711', 'kiosk-r9', SCHLUESSEL);
  assert.match(e, /^v1\./);
  assert.ok(!e.includes('4711'));
  assert.equal(k.pinEntschluesseln(e, 'kiosk-r9', SCHLUESSEL), '4711');
  // gleiche PIN, anderer Wert (zufälliges IV)
  assert.notEqual(k.pinVerschluesseln('4711', 'kiosk-r9', SCHLUESSEL), e);
  // in eine andere Zeile kopiert: unlesbar
  assert.throws(() => k.pinEntschluesseln(e, 'kiosk-r2', SCHLUESSEL));
  // anderer Schlüssel: unlesbar
  assert.throws(() => k.pinEntschluesseln(e, 'kiosk-r9', k.pinSchluessel('ein-ganz-anderer-schluessel-0123456789')));
  // ein Zeichen verändert: unlesbar
  const teile = e.split('.');
  teile[3] = (teile[3][0] === 'A' ? 'B' : 'A') + teile[3].slice(1);
  assert.throws(() => k.pinEntschluesseln(teile.join('.'), 'kiosk-r9', SCHLUESSEL));
});

test('PIN-Schlüssel: zu kurz oder fehlend heisst kein Schlüssel', () => {
  assert.equal(k.pinSchluessel(''), null);
  assert.equal(k.pinSchluessel('kurz'), null);
  assert.equal(k.pinSchluessel(undefined), null);
  assert.equal(SCHLUESSEL.length, 32);
  assert.throws(() => k.pinVerschluesseln('4711', 'x', null), /STATION_PIN_KEY/);
});

test('Neueste Änderung gewinnt — eine vorgehende Geräteuhr gewinnt nicht alles', () => {
  const jetzt = Date.parse('2026-11-26T12:00:00Z');
  assert.ok(k.neuerAls('2026-11-26T11:00:00Z', null, jetzt));
  assert.ok(k.neuerAls('2026-11-26T11:00:00Z', '2026-11-26T10:00:00Z', jetzt));
  assert.ok(!k.neuerAls('2026-11-26T10:00:00Z', '2026-11-26T11:00:00Z', jetzt));
  assert.ok(!k.neuerAls('2026-11-26T11:00:00Z', '2026-11-26T11:00:00Z', jetzt));
  assert.ok(!k.neuerAls(null, '2026-11-26T11:00:00Z', jetzt));
  assert.ok(!k.neuerAls('kaputt', null, jetzt));
  // Ein Jahr in der Zukunft zählt als „jetzt": gegen einen Stand von vor einer
  // Minute gewinnt es, gegen einen späteren nicht.
  assert.ok(k.neuerAls('2027-11-26T12:00:00Z', '2026-11-26T11:59:00Z', jetzt));
  assert.ok(!k.neuerAls('2027-11-26T12:00:00Z', '2026-11-26T12:00:01Z', jetzt));
  assert.equal(k.standAus('2027-11-26T12:00:00Z', jetzt), '2026-11-26T12:00:00.000Z');
  assert.equal(k.standAus('2026-11-26T11:00:00Z', jetzt), '2026-11-26T11:00:00.000Z');
});

test('Lebenszeichen: nur bekannte Felder, MACs geprüft, Platzhalter-MAC verworfen', () => {
  const z = k.zustandBereinigen({
    app_version: '1.1.0', version_code: 4, android: '14', sdk: 34, hersteller: 'Google', modell: 'Chromecast',
    diashow_paket: 'sk.mimac.slideshow', diashow_name: 'SlideShow', diashow_vorn: true,
    vorn_paket: 'sk.mimac.slideshow', vorn_quelle: 'nutzungsdaten', ansicht: 'diashow',
    ip: '192.0.2.10', uptime_seconds: 3600, pin_gesetzt: true, pin_stand: '2026-11-26T10:00:00Z',
    macs: { wlan0: 'AA-BB-CC-DD-EE-FF', p2p0: '02:00:00:00:00:00', 'kaputt name': 'aa:bb:cc:dd:ee:01', eth0: 'nix' },
    apps: [{ paket: 'sk.mimac.slideshow', name: 'SlideShow' }, { paket: 'kein paket', name: 'x' }],
    boese: '<script>', root_password_hash: 'x',
  });
  assert.equal(z.art, 'kiosk');
  assert.equal(z.diashow_vorn, true);
  assert.deepEqual(z.macs, { wlan0: 'aa:bb:cc:dd:ee:ff' });
  assert.deepEqual(z.apps, [{ paket: 'sk.mimac.slideshow', name: 'SlideShow' }]);
  assert.equal(z.pin_stand, '2026-11-26T10:00:00.000Z');
  assert.equal(z.boese, undefined);
  assert.equal(z.root_password_hash, undefined);
  assert.equal(z.uptime_seconds, 3600);
  // Unsinn wird leer, nicht übernommen
  const leer = k.zustandBereinigen({ diashow_paket: '../../etc', ansicht: 'hack', uptime_seconds: -5, diashow_vorn: 'ja' });
  assert.equal(leer.diashow_paket, null);
  assert.equal(leer.ansicht, null);
  assert.equal(leer.uptime_seconds, null);
  assert.equal(leer.diashow_vorn, null);
  assert.deepEqual(k.zustandBereinigen(null).macs, {});
});

test('Antwort an den Fernseher: Hash ja, PIN nie; gesperrt heisst nur Sperrhinweis', () => {
  const h = k.pinHash('4711');
  const st = {
    id: 'kiosk-r9', hostname: 'Kiosk R9', haus: 9, standort: 'Heizungsraum', status: 'aktiv',
    kiosk: { diashow: { paket: 'sk.mimac.slideshow', stand: 'a' }, pin_hash: h, pin_stand: '2026-11-26T10:00:00Z', neustart: 'n1' },
    kiosk_pin_enc: 'v1.geheim',
  };
  const a = k.kioskAntwort(st);
  assert.equal(a.gesperrt, false);
  assert.deepEqual(a.pin, { ...h, stand: '2026-11-26T10:00:00Z' });
  assert.equal(a.pin_bekannt, true);
  assert.equal(a.diashow.paket, 'sk.mimac.slideshow');
  assert.equal(a.neustart, 'n1');
  assert.ok(!JSON.stringify(a).includes('4711'));
  assert.ok(!JSON.stringify(a).includes('v1.geheim'));

  const g = k.kioskAntwort({ ...st, status: 'gesperrt', sperr_grund: 'gestohlen' });
  assert.equal(g.gesperrt, true);
  assert.equal(g.sperr_grund, 'gestohlen');
  assert.equal(g.pin, null);
  assert.equal(g.diashow, null);
  assert.equal(g.neustart, null);

  const neu = k.kioskAntwort({ id: 'x', status: 'aktiv' });
  assert.equal(neu.pin, null);
  assert.equal(neu.pin_bekannt, false);
});

test('Für /stationen: kein Hash', () => {
  const v = k.kioskFuerVerwaltung({ pin_hash: k.pinHash('4711'), pin_stand: 's', pin_quelle: 'geraet', diashow: { paket: 'a.b' } }, true);
  assert.equal(v.pin_hash, undefined);
  assert.equal(v.pin_lesbar, true);
  assert.equal(v.pin_quelle, 'geraet');
});

test('QR-Matrix: quadratisch, nur 0/1, mit Suchmustern', () => {
  const q = k.qrMatrix('https://www.rosenweg4303.ch/stationen.html?koppeln=ABCDEFGH');
  assert.ok(q.groesse >= 21);
  assert.equal(q.zeilen.length, q.groesse);
  for (const z of q.zeilen) assert.match(z, new RegExp(`^[01]{${q.groesse}}$`));
  // Suchmuster oben links: 7 dunkle Module in der ersten Zeile
  assert.equal(q.zeilen[0].slice(0, 7), '1111111');
});
