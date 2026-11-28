// node --test api/test/tv-epg.test.js — TV-Programm als JSON (lib/tv-epg.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const e = require('../lib/tv-epg');

const H = 3600 * 1000;
const T0 = Date.parse('2026-11-28T18:00:00Z');
const zeile = (kanal, vonH, bisH, titel, extra = {}) => ({
  channel: { canonical_name: kanal },
  timeslot: { lower: new Date(T0 + vonH * H).toISOString(), upper: new Date(T0 + bisH * H).toISOString() },
  title: titel, sub_title: extra.sub, desc: extra.desc,
});
const zeilen = [
  zeile('srf1', 1, 2, 'Tagesschau'),            // absichtlich ungeordnet
  zeile('srf1', -1, 1, 'Quiz', { sub: 'Folge 4', desc: 'Raten' }),
  zeile('srf1', 2, 3, 'Film'),
  zeile('arte', 3, 4, 'Doku'),                   // beginnt erst spaeter: nur Danach
  zeile('alt', -5, -4, 'Vorbei'),                // zu alt: nicht im Index
  zeile('kaputt', 2, 1, 'Ende vor Start'),
  { channel: {}, timeslot: {}, title: 'ohne Sender' },
];

test('Index: sortiert, ohne Altes und Kaputtes', () => {
  const i = e.indexBauen(zeilen, T0 - 3 * H);
  assert.deepEqual([...i.keys()].sort(), ['arte', 'srf1']);
  assert.deepEqual(i.get('srf1').map(x => x.t), ['Quiz', 'Tagesschau', 'Film']);
});

test('Jetzt und Danach: laufende und naechste Sendung, Luecke nur Danach, Ende nichts', () => {
  const i = e.indexBauen(zeilen, T0 - 3 * H);
  const j = e.jetztUndDanach(i, T0);
  assert.equal(j.srf1.jetzt.titel, 'Quiz');
  assert.equal(j.srf1.jetzt.untertitel, 'Folge 4');
  assert.equal(j.srf1.danach.titel, 'Tagesschau');
  assert.equal(j.srf1.jetzt.beschreibung, undefined, 'Liste ohne Beschreibung');
  assert.equal(j.arte.jetzt, undefined);
  assert.equal(j.arte.danach.titel, 'Doku');
  assert.deepEqual(e.jetztUndDanach(i, T0 + 10 * H), {});
  // genau am Ende einer Sendung gilt schon die naechste
  assert.equal(e.jetztUndDanach(i, T0 + 1 * H).srf1.jetzt.titel, 'Tagesschau');
});

test('Programm: Standard ab jetzt 24 h inklusive laufender Sendung, mit Beschreibung', () => {
  const i = e.indexBauen(zeilen, T0 - 3 * H);
  const p = e.programm(i, 'srf1', undefined, undefined, T0);
  assert.deepEqual(p.sendungen.map(x => x.titel), ['Quiz', 'Tagesschau', 'Film']);
  assert.equal(p.sendungen[0].beschreibung, 'Raten');
  assert.equal(p.von, new Date(T0).toISOString());
});

test('Programm: Zeitraum von/bis, Millisekunden und ISO, Obergrenze', () => {
  const i = e.indexBauen(zeilen, T0 - 3 * H);
  const p = e.programm(i, 'srf1', new Date(T0 + 1.5 * H).toISOString(), String(T0 + 2.5 * H), T0);
  assert.deepEqual(p.sendungen.map(x => x.titel), ['Tagesschau', 'Film']);
  const lang = e.programm(i, 'srf1', T0, T0 + 100 * 24 * H, T0);
  assert.equal(Date.parse(lang.bis) - Date.parse(lang.von), e.MAX_TAGE * 24 * H);
});

test('Programm: Fehler und unbekannter Sender', () => {
  const i = e.indexBauen(zeilen, T0 - 3 * H);
  assert.match(e.programm(i, '', 0, 0).fehler, /kanal/);
  assert.match(e.programm(i, 'srf1', 'gestern').fehler, /von/);
  assert.match(e.programm(i, 'srf1', T0, 'morgen').fehler, /bis/);
  assert.match(e.programm(i, 'srf1', T0 + H, T0).fehler, /nach von/);
  assert.equal(e.programm(i, 'gibtsnicht', T0, T0 + H).unbekannt, true);
});

test('Anbindung: Routen verlangen Anmeldung, channels liefert tvg und udpxy_url', () => {
  const q = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(q, /app\.get\('\/api\/tv\/jetzt', authMiddleware/);
  assert.match(q, /app\.get\('\/api\/tv\/epg', authMiddleware/);
  assert.match(q, /udpxy_url: `\$\{UDPXY_BASE_URL\}\/udp\/\$\{u\[1\]\}:\$\{u\[2\]\}`/);
  assert.match(q, /tvg: e\.tvg \|\| ''/);
});
