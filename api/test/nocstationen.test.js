// node --test api/test/nocstationen.test.js — NOC-Sicht auf die Stationen (lib/nocstationen.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../lib/nocstationen');

const JETZT = Date.parse('2026-11-27T12:00:00Z');
const vor = (min) => new Date(JETZT - min * 60000).toISOString();
const st = (x) => n.stationFuerNoc({ id: 'r9-test', role: 'desktop', status: 'aktiv', ...x }, JETZT);

test('frisches Lebenszeichen: online und grün', () => {
  const s = st({ last_seen_at: vor(3), haus: 9 });
  assert.equal(s.zustand, 'online');
  assert.equal(s.ampel, 'gruen');
  assert.equal(s.alter_min, 3);
  assert.equal(s.haus, 9);
});

test('Anzeige aus: rot; Arbeitsplatz aus: gelb, nach drei Tagen rot', () => {
  assert.equal(st({ role: 'display', last_seen_at: vor(30) }).ampel, 'rot');
  assert.equal(st({ last_seen_at: vor(30) }).ampel, 'gelb');
  assert.equal(st({ last_seen_at: vor(20 * 60) }).ampel, 'gelb');
  const alt = st({ last_seen_at: vor(4 * 1440) });
  assert.equal(alt.ampel, 'rot');
  assert.equal(alt.zustand, 'still');
});

test('Laptop, Kiosk, Chromecast dürfen aus sein: grau, nie rot', () => {
  for (const role of ['laptop', 'kiosk', 'chromecast']) {
    const s = st({ role, last_seen_at: vor(10 * 1440) });
    assert.equal(s.ampel, 'grau', role);
    assert.equal(s.zustand, 'aus', role);
  }
  // Kiosk meldet jede Minute: nach 10 min schon aus
  assert.equal(st({ role: 'kiosk', last_seen_at: vor(10) }).zustand, 'aus');
  assert.equal(st({ role: 'laptop', last_seen_at: vor(10) }).zustand, 'online');
});

test('Windows ohne Agent: grau, zählt nicht als offline', () => {
  const s = st({ role: 'windows', last_seen_at: null });
  assert.equal(s.zustand, 'ohne-agent');
  assert.equal(s.ampel, 'grau');
  const mit = st({ role: 'windows', agent_protokoll: 2, agent_version: '2.1.0', last_seen_at: vor(1),
    agent_inventar: { betriebssystem: { name: 'Windows 11 Pro', version: '24H2' } } });
  assert.equal(mit.ampel, 'gruen');
  assert.equal(mit.os, 'Windows 11 Pro 24H2');
  assert.equal(mit.agent, 'Agent 2.1.0');
});

test('Anschluss-Abweichung und doppelt: rot, auch wenn online', () => {
  assert.equal(st({ last_seen_at: vor(1), anschluss_abweichung: true }).ampel, 'rot');
  assert.equal(st({ last_seen_at: vor(1), doppelt: { seit: vor(5) } }).ampel, 'rot');
  assert.equal(st({ role: 'laptop', last_seen_at: vor(999), anschluss_abweichung: true }).ampel, 'rot');
});

test('gesperrt: gelb', () => {
  const s = st({ last_seen_at: vor(1), status: 'gesperrt' });
  assert.equal(s.ampel, 'gelb');
  assert.ok(s.hinweise.some((h) => h.text === 'gesperrt'));
});

test('Update angefordert / läuft und SSH-Wartung: blau', () => {
  assert.equal(st({ last_seen_at: vor(1), update_angefordert: vor(2) }).ampel, 'blau');
  const l = st({ last_seen_at: vor(1), ereignisse: [{ art: 'update-abgeholt', erstellt: vor(5) }] });
  assert.equal(l.ampel, 'blau');
  assert.ok(l.hinweise.some((h) => h.text === 'Update läuft'));
  // nach 20 min nicht mehr
  assert.equal(st({ last_seen_at: vor(1), ereignisse: [{ art: 'update-abgeholt', erstellt: vor(40) }] }).ampel, 'gruen');
  assert.equal(st({ last_seen_at: vor(1), ssh_wartung_bis: new Date(JETZT + 3600000).toISOString() }).ampel, 'blau');
  assert.equal(st({ last_seen_at: vor(1), ereignisse: [{ art: 'wartung-dauert-lange', erstellt: vor(3) }] }).ampel, 'gelb');
});

test('keine Personen, keine IPs in der Ausgabe', () => {
  const s = st({ last_seen_at: vor(1), registered_by: 'Erika Muster', last_seen_ip: '100.64.9.9',
    agent_protokoll: 2, agent_inventar: { personen: [{ name: 'Erika Muster' }] }, overrides: { wlan: { psk: 'geheim' } } });
  const text = JSON.stringify(s);
  assert.ok(!text.includes('Erika'));
  assert.ok(!text.includes('100.64.9.9'));
  assert.ok(!text.includes('geheim'));
});

test('Zusammenfassung und Reihenfolge: rot zuerst, entfernte fallen weg', () => {
  const out = n.stationenFuerNoc([
    { id: 'a', role: 'desktop', status: 'aktiv', last_seen_at: vor(1) },
    { id: 'b', role: 'display', status: 'aktiv', last_seen_at: vor(60) },
    { id: 'c', role: 'laptop', status: 'aktiv', last_seen_at: vor(600) },
    { id: 'd', role: 'desktop', status: 'gesperrt', last_seen_at: vor(1) },
    { id: 'e', role: 'windows', status: 'aktiv' },
    { id: 'f', role: 'desktop', status: 'aktiv', last_seen_at: vor(1), revoked_at: vor(100) },
  ], JETZT);
  assert.deepEqual(out.stationen.map((s) => s.id), ['b', 'd', 'a', 'c', 'e']);
  const z = out.zusammenfassung;
  assert.equal(z.gesamt, 5);
  assert.equal(z.online, 2);
  assert.equal(z.offline, 2);
  assert.equal(z.aus_erlaubt, 1);
  assert.equal(z.ohne_agent, 1);
  assert.equal(z.stoerungen, 1);
  assert.equal(z.warnungen, 1);
  assert.equal(z.ampel, 'rot');
});

test('öffentliche Sicht: Kennung und Standort bleiben, Versionen weg', () => {
  const out = n.stationenOeffentlich(n.stationenFuerNoc([
    { id: 'laptop-wohnung-12', role: 'laptop', standort: 'Büro', last_seen_at: vor(1), agent_protokoll: 2, agent_version: '2.0' },
  ], JETZT));
  assert.equal(out.stationen[0].id, 'laptop-wohnung-12');
  assert.equal(out.stationen[0].standort, 'Büro');
  assert.equal(out.stationen[0].agent, null);
  assert.equal(out.zusammenfassung.online, 1);
});
