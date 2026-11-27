// node --test api/test/tageszeit.test.js — W27: Der Tageslauf der Kontolöschung
// läuft nachts (02:00 Schweizer Zeit), nicht 24 h nach dem Prozessstart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { naechsterZeitpunkt } = require('../lib/tageszeit');

const zh = (d) => new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' }).format(d);

test('Winterzeit: nächster 02:00', () => {
  const t = naechsterZeitpunkt(2, 0, new Date('2026-11-27T15:30:00Z')); // 16:30 in Zürich
  assert.equal(t.toISOString(), '2026-11-28T01:00:00.000Z');
  assert.equal(zh(t), '28.11.26, 02:00');
});

test('vor 02:00 am selben Tag', () => {
  const t = naechsterZeitpunkt(2, 0, new Date('2026-11-27T00:10:00Z')); // 01:10 in Zürich
  assert.equal(t.toISOString(), '2026-11-27T01:00:00.000Z');
});

test('Sommerzeit und Umstellungstag', () => {
  assert.equal(naechsterZeitpunkt(3, 0, new Date('2026-07-01T12:00:00Z')).toISOString(), '2026-07-02T01:00:00.000Z');
  // 25.10.2026: 03:00 Sommerzeit wird 02:00 Winterzeit; 03:00 Wanduhr = 02:00 UTC
  assert.equal(naechsterZeitpunkt(3, 0, new Date('2026-10-24T12:00:00Z')).toISOString(), '2026-10-25T02:00:00.000Z');
});

test('server.js plant die Läufe zur Uhrzeit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /deletionInterval = taeglichUm\(2, 0, guardedProcessDeletions/);
  assert.doesNotMatch(src, /setInterval\(guardedProcessDeletions/);
  assert.match(src, /taeglichUm\(3, 0, checkStaleDruckerTags/);
});
