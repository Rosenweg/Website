// node --test api/test/stationwaechter.test.js — Anschluss-Wächter und doppelte Station (lib/stationwaechter.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../lib/stationwaechter');

const SW = 'aa:00:00:00:00:01';
const SW2 = 'aa:00:00:00:00:02';
const AP1 = 'bb:00:00:00:00:01';
const AP2 = 'bb:00:00:00:00:02';
const devices = [
  { mac: SW, name: 'R9-UG-Switch', port_table: [{ port_idx: 7, name: 'Büro' }, { port_idx: 8, name: 'Port 8' }] },
  { mac: SW2, name: 'R13-Switch', port_table: [] },
  { mac: AP1, name: 'R9-EG-AP' },
  { mac: AP2, name: 'R9-1OG-AP' },
];
const kabel = (port, sw = SW) => w.anschlussAus({ mac: '11:22:33:44:55:66', is_wired: true, sw_mac: sw, sw_port: port }, devices);
const wlan = (ap) => w.anschlussAus({ mac: '11:22:33:44:55:77', is_wired: false, ap_mac: ap }, devices);

test('MACs aus dem Inventar: klein, gültig, ohne Nullen und Doppelte', () => {
  assert.deepEqual(
    w.stationsMacs({ macs: { enp1s0: '11:22:33:44:55:66', wlp2s0: '11:22:33:44:55:77', lo: '00:00:00:00:00:00', x: 'kaputt', y: '11:22:33:44:55:66' } }),
    ['11:22:33:44:55:66', '11:22:33:44:55:77']);
  assert.deepEqual(w.stationsMacs({}), []);
  assert.deepEqual(w.stationsMacs(null), []);
});

test('Client finden: Kabel vor WLAN, sonst der zuletzt gesehene', () => {
  const clients = [
    { mac: '11:22:33:44:55:77', is_wired: false, ap_mac: AP1, last_seen: 200 },
    { mac: '11:22:33:44:55:66', is_wired: true, sw_mac: SW, sw_port: 7, last_seen: 100 },
    { mac: 'ff:ff:ff:ff:ff:ff', is_wired: true, sw_mac: SW, sw_port: 1, last_seen: 300 },
  ];
  assert.equal(w.clientFinden(clients, ['11:22:33:44:55:66', '11:22:33:44:55:77']).is_wired, true);
  assert.equal(w.clientFinden(clients, ['11:22:33:44:55:77']).ap_mac, AP1);
  assert.equal(w.clientFinden(clients, ['00:11:22:33:44:55']), null);
});

test('Anschluss als Text: Switch-Name, Port, Portname nur wenn sprechend', () => {
  assert.equal(w.anschlussText(kabel(7)), 'R9-UG-Switch Port 7 (Büro)');
  assert.equal(w.anschlussText(kabel(8)), 'R9-UG-Switch Port 8');
  assert.equal(w.anschlussText(wlan(AP1)), 'WLAN über R9-EG-AP');
  // Unbekannter Switch: MAC statt Name
  assert.equal(w.anschlussText(kabel(3, 'cc:00:00:00:00:09')), 'cc:00:00:00:00:09 Port 3');
  // Kabel ohne sw_mac sagt nichts
  assert.equal(w.anschlussAus({ mac: '11:22:33:44:55:66', is_wired: true }, devices), null);
});

test('Erstes Lernen ohne Sperre', () => {
  assert.equal(w.anschlussPruefen({ gelernt: null, aktuell: kabel(7) }).aktion, 'lernen');
  assert.equal(w.anschlussPruefen({ gelernt: [], aktuell: kabel(7) }).aktion, 'lernen');
});

test('Nicht im Netz -> nichts zu tun', () => {
  assert.equal(w.anschlussPruefen({ gelernt: [kabel(7)], aktuell: null }).aktion, 'unbekannt');
});

test('Gleicher Anschluss -> gleich (auch wenn der Name im UniFi geändert wurde)', () => {
  const umbenannt = { ...kabel(7), geraet_name: 'Neuer Name' };
  assert.equal(w.anschlussPruefen({ gelernt: [umbenannt], aktuell: kabel(7) }).aktion, 'gleich');
});

test('Anderer Port: erst vormerken, beim zweiten Mal in Folge sperren', () => {
  const e1 = w.anschlussPruefen({ gelernt: [kabel(7)], aktuell: kabel(8) });
  assert.equal(e1.aktion, 'vormerken');
  assert.equal(e1.kandidat.mal, 1);
  const e2 = w.anschlussPruefen({ gelernt: [kabel(7)], kandidat: e1.kandidat, aktuell: kabel(8) });
  assert.equal(e2.aktion, 'sperren');
  assert.equal(e2.grund, 'an anderem Anschluss aufgetaucht: R9-UG-Switch Port 8 statt R9-UG-Switch Port 7 (Büro)');
});

test('Kandidat an einem dritten Port zählt neu', () => {
  const e1 = w.anschlussPruefen({ gelernt: [kabel(7)], aktuell: kabel(8) });
  const e2 = w.anschlussPruefen({ gelernt: [kabel(7)], kandidat: e1.kandidat, aktuell: kabel(3, SW2) });
  assert.equal(e2.aktion, 'vormerken');
  assert.equal(e2.kandidat.mal, 1);
});

test('Schon gesperrt für genau diesen Anschluss -> bleibt (kein zweites Sperren)', () => {
  assert.equal(w.anschlussPruefen({ gelernt: [kabel(7)], abweichung: kabel(8), aktuell: kabel(8) }).aktion, 'bleibt');
});

test('Wechsel Kabel -> WLAN ist ein anderer Anschluss', () => {
  const e1 = w.anschlussPruefen({ gelernt: [kabel(7)], aktuell: wlan(AP1) });
  const e2 = w.anschlussPruefen({ gelernt: [kabel(7)], kandidat: e1.kandidat, aktuell: wlan(AP1) });
  assert.equal(e2.aktion, 'sperren');
  assert.match(e2.grund, /WLAN über R9-EG-AP statt R9-UG-Switch Port 7/);
});

test('Übernehmen: Kabel ersetzt, WLAN sammelt APs, Artwechsel beginnt neu', () => {
  assert.deepEqual(w.uebernehmen([kabel(7)], kabel(8)), [kabel(8)]);
  const zwei = w.uebernehmen([wlan(AP1)], wlan(AP2));
  assert.deepEqual(zwei.map(w.anschlussText), ['WLAN über R9-EG-AP', 'WLAN über R9-1OG-AP']);
  assert.equal(w.anschlussPruefen({ gelernt: zwei, aktuell: wlan(AP1) }).aktion, 'gleich');
  assert.equal(w.uebernehmen(zwei, wlan(AP1)).length, 2);      // kein Doppel
  assert.deepEqual(w.uebernehmen(zwei, kabel(7)), [kabel(7)]);
  assert.deepEqual(w.uebernehmen([kabel(7)], wlan(AP1)), [wlan(AP1)]);
  assert.deepEqual(w.uebernehmen(null, kabel(7)), [kabel(7)]);
});

// ─── Doppelte Station ───────────────────────────────────────────────
const T0 = Date.parse('2026-11-26T10:00:00Z');
const MIN = 60 * 1000;
// Lebenszeichen eines Geräts: Minute m, Adresse, Startzeit (Minuten vor T0)
const lz = (m, ip, bootVorMin, lokal = ip) => ({
  zeit: new Date(T0 + m * MIN), quelle_ip: ip, lokal_ip: lokal,
  boot: bootVorMin == null ? null : new Date(T0 - bootVorMin * MIN + (m % 2) * 2000), // leichtes Zittern
});

test('Ein Gerät, regelmässig -> nichts', () => {
  assert.equal(w.doppelteErkennen([0, 5, 10, 15, 20].map((m) => lz(m, '10.9.0.5', 60))), null);
});

test('Ein Gerät startet neu -> zwei Absender nacheinander, nichts', () => {
  const vorher = [0, 5, 10].map((m) => lz(m, '10.9.0.5', 600));
  const nachher = [12, 17, 22].map((m) => lz(m, '10.9.0.5', -11));
  assert.equal(w.doppelteErkennen([...vorher, ...nachher]), null);
});

test('Ein Gerät bekommt eine neue Adresse -> nichts', () => {
  const a = [0, 5, 10].map((m) => lz(m, '10.9.0.5', 60));
  const b = [15, 20].map((m) => lz(m, '10.9.0.77', 60));
  assert.equal(w.doppelteErkennen([...a, ...b]), null);
});

test('Zwei Geräte mit verschiedenen Adressen im Wechsel -> gemeldet', () => {
  const a = [0, 5, 10, 15].map((m) => lz(m, '10.9.0.5', 60));
  const b = [2, 7, 12].map((m) => lz(m, '10.9.0.77', 3000));
  const f = w.doppelteErkennen([...a, ...b]);
  assert.ok(f);
  assert.equal(f.quellen.length, 2);
  assert.deepEqual(f.quellen.map((q) => q.quelle_ip).sort(), ['10.9.0.5', '10.9.0.77']);
});

test('Zwei Geräte hinter derselben Adresse, verschiedene Startzeit -> gemeldet', () => {
  const a = [0, 5, 10].map((m) => lz(m, '85.1.2.3', 60, '192.168.1.10'));
  const b = [3, 8].map((m) => lz(m, '85.1.2.3', 3000, '192.168.1.10'));
  assert.ok(w.doppelteErkennen([...a, ...b]));
});

test('Ohne Laufzeit (alter Agent) zählt die Adresse allein', () => {
  const a = [0, 5, 10].map((m) => lz(m, '10.9.0.5', null));
  assert.equal(w.doppelteErkennen(a), null);
  const b = [3].map((m) => lz(m, '10.9.0.6', null));
  assert.ok(w.doppelteErkennen([...a, ...b]));
});

test('Einzelnes fremdes Lebenszeichen ausserhalb der Spanne -> nichts', () => {
  const a = [5, 10].map((m) => lz(m, '10.9.0.5', 60));
  const b = [0].map((m) => lz(m, '10.9.0.77', 3000));
  assert.equal(w.doppelteErkennen([...a, ...b]), null);
});

test('Absender als Text', () => {
  assert.equal(w.quelleText({ quelle_ip: '10.9.0.5', lokal_ip: '10.9.0.5' }), '10.9.0.5');
  assert.equal(w.quelleText({ quelle_ip: '85.1.2.3', lokal_ip: '192.168.1.10' }), '192.168.1.10 über 85.1.2.3');
  assert.equal(w.quelleText({}), 'unbekannte Adresse');
});
