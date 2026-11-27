// node --test api/test/stationprotokoll.test.js — Protokoll v2 (lib/stationprotokoll.js, lib/kerberos.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const P = require('../lib/stationprotokoll');
const kerberos = require('../lib/kerberos');

// Ein Lebenszeichen, wie es rosenweg-agent auf Windows schickt (gekürzt).
const WINDOWS = {
  hostname: 'WIN11-1',
  betriebssystem: { name: 'Windows 11 Pro', version: '24H2', build: '26100.2605' },
  laufzeit_sekunden: 5400,
  personen: [{ name: 'AD\\anna.beispiel', sitzung: 1, zustand: 'aktiv' }, { name: '', zustand: 'aktiv' }],
  netz: [
    { name: 'Ethernet', mac: 'BC-24-11-AA-BB-CC', art: 'kabel', verbunden: true, standard: true, ipv4: ['192.168.9.57'], ipv6: ['2a02:16a:1400::57'] },
    { name: 'vEthernet (WSL)', mac: '00-15-5d-01-02-03', art: 'andere', ipv4: ['172.20.0.1'] },
    { name: 'WLAN', mac: '02:00:00:00:00:00', art: 'wlan' },
  ],
  platten: [{ laufwerk: 'C:', gesamt_bytes: 100e9, frei_bytes: 25e9 }],
  verschluesselung: [{ laufwerk: 'C:', schutz: 'an', zustand: 'FullyEncrypted', prozent: 100 }],
  updates: { zuletzt: '2026-11-20T03:00:00Z', neustart_ausstehend: false, liste: [{ titel: 'KB5044284', datum: '2026-11-20T03:00:00Z', ok: true }] },
  zusatz: { domaene: 'AD', secure_boot: false, '<script>': 'x', liste: [1, 2] },
};

test('Inventar: bekannte Felder bleiben, Unsinn fällt weg', () => {
  const i = P.inventarBereinigen(WINDOWS);
  assert.equal(i.hostname, 'WIN11-1');
  assert.equal(i.betriebssystem.build, '26100.2605');
  assert.equal(i.personen.length, 1, 'Person ohne Namen fällt weg');
  assert.equal(i.netz[0].mac, 'bc:24:11:aa:bb:cc', 'MAC klein, mit Doppelpunkt');
  assert.equal(i.netz[2].mac, null, 'Android-Platzhalter-MAC ist keine');
  assert.equal(i.verschluesselung[0].schutz, 'an');
  assert.deepEqual(Object.keys(i.zusatz).sort(), ['domaene', 'secure_boot'], 'nur flache, harmlose Schlüssel');
  assert.equal(i.updates.liste[0].ok, true);
});

test('Inventar: fremde Werte werden gestutzt, nicht übernommen', () => {
  const i = P.inventarBereinigen({
    hostname: 'x'.repeat(500),
    laufzeit_sekunden: -5,
    netz: [{ name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff; rm -rf /', ipv4: ['<img src=x>', '10.0.0.1'], art: 'quanten' }],
    verschluesselung: [{ laufwerk: 'C:', schutz: 'vielleicht' }],
    personen: 'alle',
  });
  assert.equal(i.hostname.length, 63);
  assert.equal(i.laufzeit_sekunden, null);
  assert.equal(i.netz[0].mac, null);
  assert.deepEqual(i.netz[0].ipv4, ['10.0.0.1']);
  assert.equal(i.netz[0].art, 'andere');
  assert.equal(i.verschluesselung[0].schutz, 'unbekannt');
  assert.deepEqual(i.personen, []);
  assert.deepEqual(P.inventarBereinigen(null).netz, []);
});

test('MACs für den Anschluss-Wächter: nur Kabel und WLAN', () => {
  const macs = P.macsAus(P.inventarBereinigen(WINDOWS));
  assert.deepEqual(macs, { Ethernet: 'bc:24:11:aa:bb:cc' });
});

test('v1-Felder: /stationen und Doppel-Erkennung lesen dasselbe wie bei Linux', () => {
  const agent = P.agentBereinigen({ version: '0.1.0', plattform: 'windows' });
  const v1 = P.v1Felder(P.inventarBereinigen(WINDOWS), agent, 'win11-1');
  assert.equal(v1.ip, '192.168.9.57');
  assert.equal(v1.uptime_seconds, 5400);
  assert.equal(v1.disk_percent, 75);
  assert.equal(v1.os_version, 'Windows 11 Pro 24H2 (26100.2605)');
  assert.equal(v1.protokoll, 2);
  assert.equal(v1.station_id, 'win11-1');
});

test('Agent-Angaben: Plattform und Modus nur aus der Liste', () => {
  assert.equal(P.agentBereinigen({ plattform: 'macos' }).plattform, null);
  assert.equal(P.agentBereinigen({ plattform: 'linux', modus: 'parallel' }).modus, 'parallel');
  assert.equal(P.agentBereinigen({ modus: 'irgendwas' }).modus, 'voll');
  assert.equal(P.agentBereinigen({ version: '1.0; drop table' }).version, null);
});

test('Befehle: Art, Plattform und Parameter werden geprüft', () => {
  assert.match(P.befehlPruefen('formatieren', {}, 'windows').fehler, /Unbekannt/);
  assert.match(P.befehlPruefen('nachricht', { text: 'Hallo' }, null).fehler, /kein Agent/);
  assert.match(P.befehlPruefen('netzstart_einmal', {}, 'linux').fehler, /gibt es auf linux nicht/);
  assert.match(P.befehlPruefen('nachricht', { text: '   ' }, 'windows').fehler, /Text fehlt/);
  assert.match(P.befehlPruefen('__proto__', {}, 'windows').fehler, /Unbekannt/);

  const n = P.befehlPruefen('nachricht', { text: 'Bitte um 18 Uhr abmelden', boese: 1 }, 'windows').wert;
  assert.deepEqual(n.parameter, { text: 'Bitte um 18 Uhr abmelden' });
  assert.equal(n.minuten, 60);

  const r = P.befehlPruefen('neustart', {}, 'windows').wert;
  assert.equal(r.parameter.verzoegerung_sekunden, 300, 'Vorgabe: fünf Minuten Vorwarnung');
  assert.match(P.befehlPruefen('neustart', { verzoegerung_sekunden: 5 }, 'windows').fehler, /60 bis 3600/);
  assert.equal(P.befehlPruefen('abmelden', {}, 'linux').wert.parameter.vorwarnung_sekunden, 60);
  assert.equal(P.befehlPruefen('netzstart_einmal', {}, 'windows').wert.parameter.verzoegerung_sekunden, 120);
});

test('Quittungen und Meldungen: nur gültige', () => {
  assert.deepEqual(P.quittungenBereinigen([
    { id: 4, ergebnis: 'ok', text: 'Neustart in 300 s' },
    { id: 'x', ergebnis: 'ok' }, { id: 5, ergebnis: 'vielleicht' }, null,
  ]), [{ id: 4, ergebnis: 'ok', text: 'Neustart in 300 s' }]);
  assert.deepEqual(P.meldungenBereinigen([{ art: 'sperre-an', text: 'ok' }, { art: 'Böse Art' }]),
    [{ art: 'sperre-an', text: 'ok' }]);
});

test('Befehl für den Agenten: Zeit als ISO-Text', () => {
  const b = P.befehlFuerAgent({ id: '7', art: 'nachricht', parameter: { text: 'x' }, gueltig_bis: new Date('2026-11-27T10:00:00Z') });
  assert.deepEqual(b, { id: 7, art: 'nachricht', parameter: { text: 'x' }, gueltig_bis: '2026-11-27T10:00:00.000Z' });
});

test('Kerberos-Name: nur Computerkonten des eigenen Realms', () => {
  const R = 'AD.ROSENWEG4303.CH';
  assert.equal(P.rechnerAusPrincipal('WIN11-1$', 'AD.ROSENWEG4303.CH', R), 'WIN11-1');
  assert.equal(P.rechnerAusPrincipal('R9-PC1$', 'ad.rosenweg4303.ch', R), 'R9-PC1');
  assert.equal(P.rechnerAusPrincipal('anna.beispiel', 'AD.ROSENWEG4303.CH', R), null, 'Person ist kein Rechner');
  assert.equal(P.rechnerAusPrincipal('WIN11-1$', 'ANDERES.REALM', R), null);
  assert.equal(P.rechnerAusPrincipal('host/WIN11-1$', R, R), null);
  assert.equal(P.rechnerAusPrincipal('$', R, R), null);
  assert.equal(P.rechnerAusPrincipal('WIN11-1$', R, ''), null);
});

test('Intervall: Vorgabe, Grenzen, overrides.agent', () => {
  assert.equal(P.intervall({}), 120);
  assert.equal(P.intervall({ agent: { intervall_sekunden: 60 } }), 60);
  assert.equal(P.intervall({ agent: { intervall_sekunden: 5 } }), 120);
});

// ─── lib/kerberos.js mit einer Attrappe statt des Prüfprogramms ─────

function attrappe(ausgabe, fehler = null) {
  const aufrufe = [];
  const ausfuehren = (datei, args, opts, fertig) => {
    const p = new EventEmitter();
    let eingabe = '';
    p.stdin = { end: (t) => { eingabe = t; setImmediate(() => fertig(fehler, ausgabe)); } };
    aufrufe.push({ datei, args, opts, get eingabe() { return eingabe; } });
    return p;
  };
  return { ausfuehren, aufrufe };
}
const tok = (n) => 'YII' + String(n).padStart(20, 'A') + 'Bg==';

test('Kerberos: gültiges Token, Aufruf ohne Umgebung', async () => {
  const a = attrappe('{"ok":true,"principal":"WIN11-1$","realm":"AD.ROSENWEG4303.CH"}\n');
  const e = await kerberos.pruefen(`Negotiate ${tok(1)}`, { ausfuehren: a.ausfuehren, keytab: '/k', spn: 'HTTP/x' });
  assert.deepEqual(e, { ok: true, principal: 'WIN11-1$', realm: 'AD.ROSENWEG4303.CH' });
  assert.deepEqual(a.aufrufe[0].args, ['-keytab', '/k', '-spn', 'HTTP/x']);
  assert.deepEqual(a.aufrufe[0].opts.env, {}, 'keine API-Geheimnisse an den Kindprozess');
  assert.equal(a.aufrufe[0].eingabe, `${tok(1)}\n`, 'Token über stdin, nicht als Argument (ps)');
});

test('Kerberos: abgelehnt, kaputt, wiederholt', async () => {
  const nein = attrappe('{"ok":false,"grund":"abgelehnt: falscher Schlüssel"}\n', new Error('exit 1'));
  assert.deepEqual(await kerberos.pruefen(`Negotiate ${tok(2)}`, { ausfuehren: nein.ausfuehren }),
    { ok: false, grund: 'abgelehnt: falscher Schlüssel' });

  const kaputt = attrappe('Segmentation fault', new Error('exit 139'));
  assert.equal((await kerberos.pruefen(`Negotiate ${tok(3)}`, { ausfuehren: kaputt.ausfuehren })).ok, false);

  // Antwortet das Programm mit ok, aber ohne Namen: abgelehnt.
  const leer = attrappe('{"ok":true}');
  assert.equal((await kerberos.pruefen(`Negotiate ${tok(4)}`, { ausfuehren: leer.ausfuehren })).ok, false);

  const ja = attrappe('{"ok":true,"principal":"WIN11-1$","realm":"R"}');
  assert.equal((await kerberos.pruefen(`Negotiate ${tok(5)}`, { ausfuehren: ja.ausfuehren })).ok, true);
  const zweimal = await kerberos.pruefen(`Negotiate ${tok(5)}`, { ausfuehren: ja.ausfuehren });
  assert.deepEqual(zweimal, { ok: false, grund: 'Token schon einmal benutzt' });
  assert.equal(ja.aufrufe.length, 1, 'die Wiederholung erreicht das Prüfprogramm gar nicht');
});

test('Kerberos: kein Negotiate, kein Aufruf', async () => {
  const a = attrappe('{"ok":true,"principal":"X$","realm":"R"}');
  for (const h of ['', 'Bearer rw_station_x', 'Negotiate', 'Negotiate ;rm -rf', `Basic ${tok(6)}`]) {
    assert.equal((await kerberos.pruefen(h, { ausfuehren: a.ausfuehren })).ok, false, h);
  }
  assert.equal(a.aufrufe.length, 0);
});
