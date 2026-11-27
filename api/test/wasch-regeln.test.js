// node --test api/test/wasch-regeln.test.js — Waschküche: Sperrzeiten, Abrechnung
// je Monat, wirksame Einstellungen (Entscheid Stefan 27.11.2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const r = require('../lib/wasch-regeln');

test('Einstellungen: Standard, gespeicherte Werte, Unsinn faellt auf Standard', () => {
  assert.deepEqual(r.einstellungen([]), { preisProKwh: 0.3, maxTage: 90, maxOffen: 120, autoAbrechnung: true });
  const e = r.einstellungen([
    { key: 'reservation_max_days', value: '30' },
    { key: 'reservation_max_per_user', value: '8' },
    { key: 'auto_billing', value: 'false' },
    { key: 'cost_per_kwh', value: '0.27' },
    { key: 'unifi_access_token', value: 'geheim' },
  ]);
  assert.deepEqual(e, { preisProKwh: 0.27, maxTage: 30, maxOffen: 8, autoAbrechnung: false });
  assert.equal(r.einstellungen([{ key: 'reservation_max_days', value: 'abc' }]).maxTage, 90);
});

test('Einstellungen pruefen: Bereiche, Komma, ja/nein, Unbekanntes faellt weg', () => {
  assert.deepEqual(r.einstellungenPruefen({ cost_per_kwh: '0,35', reservation_max_days: 60, auto_billing: false, billing_day: 5 }).werte,
    { cost_per_kwh: '0.35', reservation_max_days: '60', auto_billing: 'false' });
  assert.equal(r.einstellungenPruefen({ reservation_max_days: 0 }).fehler.feld, 'reservation_max_days');
  assert.equal(r.einstellungenPruefen({ reservation_max_days: '7.5' }).fehler.feld, 'reservation_max_days');
  assert.equal(r.einstellungenPruefen({ reservation_max_per_user: 9999 }).fehler.feld, 'reservation_max_per_user');
  assert.equal(r.einstellungenPruefen({ cost_per_kwh: 'gratis' }).fehler.feld, 'cost_per_kwh');
  assert.equal(r.einstellungenPruefen({ auto_billing: 'vielleicht' }).fehler.feld, 'auto_billing');
});

test('Abrechnungsmonat: jeder vergangene Monat, ohne Angabe der Vormonat', () => {
  const jetzt = new Date(2026, 10, 27, 12); // 27.11.2026
  assert.deepEqual(r.abrechnungsMonat(undefined, jetzt), { ok: true, monat: '2026-10', start: '2026-10-01' });
  assert.equal(r.abrechnungsMonat('2026-03', jetzt).ok, true);
  assert.equal(r.abrechnungsMonat('2025-12', jetzt).ok, true);
  assert.equal(r.abrechnungsMonat('2026-11', jetzt).ok, false, 'laufender Monat');
  assert.equal(r.abrechnungsMonat('2027-01', jetzt).ok, false, 'Zukunft');
  assert.equal(r.abrechnungsMonat('2026-13', jetzt).ok, false);
  assert.equal(r.abrechnungsMonat('11.2026', jetzt).ok, false);
  // Januar: Vormonat ist Dezember des Vorjahres
  assert.equal(r.abrechnungsMonat(null, new Date(2027, 0, 1, 8)).monat, '2026-12');
});

test('Automatische Abrechnung nur am 1. um 08:00 und nur eingeschaltet', () => {
  const an = { autoAbrechnung: true }, aus = { autoAbrechnung: false };
  assert.equal(r.autoAbrechnungFaellig(new Date(2026, 11, 1, 8, 2), an), true);
  assert.equal(r.autoAbrechnungFaellig(new Date(2026, 11, 1, 8, 2), aus), false);
  assert.equal(r.autoAbrechnungFaellig(new Date(2026, 11, 1, 8, 7), an), false);
  assert.equal(r.autoAbrechnungFaellig(new Date(2026, 11, 2, 8, 2), an), false);
});

test('Sperrzeit pruefen', () => {
  const gut = { room_id: 1, start_time: '2026-12-01T08:00:00', end_time: '2026-12-01T12:00:00', grund: 'Reinigung' };
  const p = r.sperrzeitPruefen(gut);
  assert.equal(p.ok, true);
  assert.equal(p.grund, 'Reinigung');
  assert.equal(r.sperrzeitPruefen({ ...gut, room_id: 'x' }).feld, 'room_id');
  assert.equal(r.sperrzeitPruefen({ ...gut, end_time: gut.start_time }).feld, 'end_time');
  assert.equal(r.sperrzeitPruefen({ ...gut, grund: '  ' }).feld, 'grund');
  assert.equal(r.sperrzeitPruefen({ ...gut, grund: 'x'.repeat(201) }).feld, 'grund');
  assert.equal(r.sperrzeitPruefen({ ...gut, end_time: '2028-01-01T00:00:00' }).feld, 'end_time');
});

test('server.js: Tabelle, Routen, Einstellungen statt fester Grenzen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS wasch_sperrzeiten/);
  assert.ok(src.includes("app.get('/api/wasch/sperrzeiten', authMiddleware,"));
  assert.ok(src.includes("app.post('/api/wasch/sperrzeiten', authMiddleware, waschAdmin('write')"));
  assert.ok(src.includes("app.delete('/api/wasch/sperrzeiten/:id', authMiddleware, waschAdmin('write')"));
  // Reservieren: Sperrzeit lehnt ab, Grenzen aus den Einstellungen
  assert.match(src, /error: `Gesperrt: \$\{sperre\.rows\[0\]\.grund\}`/);
  assert.match(src, /einst\.maxTage \* 86400000/);
  assert.match(src, /offen\.rows\[0\]\.n >= einst\.maxOffen/);
  assert.doesNotMatch(src, /Date\.now\(\) \+ 90 \* 86400000/);
  assert.doesNotMatch(src, /offen\.rows\[0\]\.n >= 120/);
  // Abrechnung: Monat aus der Anfrage, doppelt = 409, Zeitplan nur mit auto_billing
  assert.match(src, /waschRegeln\.abrechnungsMonat\(req\.body\?\.month\)/);
  assert.match(src, /ist schon abgerechnet/);
  assert.match(src, /waschRegeln\.autoAbrechnungFaellig\(now, await waschEinstellungen\(\)\)/);
});
