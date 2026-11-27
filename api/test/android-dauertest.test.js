// node --test api/test/android-dauertest.test.js — Android-Dauertest (CT 149):
// Eingang prüfen, wann die Technik eine Meldung bekommt, NOC-Ampel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ad = require('../lib/android-dauertest');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const app = (x = {}) => ({ kennung: 'salz', name: 'Rosenweg Salz', paket: 'ch.rosenweg4303.salz', version: '1.0.4', ok: true, dauer_s: 20, ...x });

test('Eingang: gültig, mit Schirmbild', () => {
  const e = ad.eingabePruefen({ apps: [app({ schirmbild_png: PNG })] });
  assert.equal(e.fehler, undefined);
  assert.equal(e.apps[0].schirmbild.length, 11);
  assert.equal(e.apps[0].grund, null);
});

test('Eingang: abgewiesen', () => {
  assert.ok(ad.eingabePruefen({}).fehler);
  assert.ok(ad.eingabePruefen({ apps: [app({ kennung: '../x' })] }).fehler);
  assert.ok(ad.eingabePruefen({ apps: [app({ paket: 'kein paket' })] }).fehler);
  assert.ok(ad.eingabePruefen({ apps: [app({ ok: 'ja' })] }).fehler);
  assert.ok(ad.eingabePruefen({ apps: [app(), app()] }).fehler, 'doppelt');
  assert.ok(ad.eingabePruefen({ apps: [app({ schirmbild_png: Buffer.from('GIF89a').toString('base64') })] }).fehler, 'kein PNG');
});

test('Eingang: rot ohne Grund bekommt einen, Steuerzeichen raus', () => {
  const e = ad.eingabePruefen({ apps: [app({ ok: false, grund: 'a\u0007b' })] });
  assert.equal(e.apps[0].grund, 'a b');
  assert.equal(ad.eingabePruefen({ apps: [app({ ok: false })] }).apps[0].grund, 'ohne Grund');
});

test('Meldung: erstes Rot bei gleicher Version noch nicht, zweites schon, drittes nicht nochmal', () => {
  let v = { version: '1.0.4', rot_in_folge: 0, alarmiert: false };
  let b = ad.bewerten(v, app({ ok: false }));
  assert.equal(b.meldung, null);
  assert.equal(b.rot_in_folge, 1);
  v = { version: b.version, rot_in_folge: b.rot_in_folge, alarmiert: b.alarmiert };
  b = ad.bewerten(v, app({ ok: false }));
  assert.equal(b.meldung, 'rot');
  v = { version: b.version, rot_in_folge: b.rot_in_folge, alarmiert: b.alarmiert };
  b = ad.bewerten(v, app({ ok: false }));
  assert.equal(b.meldung, null);
  assert.equal(b.alarmiert, true);
  v = { version: b.version, rot_in_folge: b.rot_in_folge, alarmiert: b.alarmiert };
  b = ad.bewerten(v, app({ ok: true }));
  assert.equal(b.meldung, 'gruen');
  assert.equal(b.rot_in_folge, 0);
});

test('Meldung: erstes Rot gleich nach neuem Release sofort', () => {
  const b = ad.bewerten({ version: '1.0.3', rot_in_folge: 0, alarmiert: false }, app({ ok: false, version: '1.0.4' }));
  assert.equal(b.meldung, 'rot');
  assert.equal(b.neues_release, true);
  assert.match(ad.meldungText(app({ ok: false, grund: 'Ablauf: x' }), 'rot', { rot_in_folge: 1, neuesRelease: true }), /neuen Release/);
});

test('Meldung: neue App im Test meldet beim ersten Rot nicht, grün ohne vorherige Meldung still', () => {
  assert.equal(ad.bewerten(null, app({ ok: false })).meldung, null);
  assert.equal(ad.bewerten({ version: '1.0.4', rot_in_folge: 1, alarmiert: false }, app()).meldung, null);
});

test('Meldung: Download kaputt (Version leer) zählt nicht als neues Release', () => {
  const b = ad.bewerten({ version: '1.0.4', rot_in_folge: 0, alarmiert: false }, app({ ok: false, version: '' }));
  assert.equal(b.meldung, null);
  assert.equal(b.version, '1.0.4');
});

test('NOC: Ampel grün/rot/grau, rot zuerst, öffentlich ohne Grund', () => {
  const jetzt = Date.parse('2026-11-27T21:00:00Z');
  const z = (x) => ({ kennung: 'a', name: 'A', paket: 'a.b', ok: true, zeit: '2026-11-27T20:30:00Z', hat_schirmbild: true, ...x });
  assert.equal(ad.zusammenfassung([], jetzt).ampel, 'grau');
  assert.equal(ad.zusammenfassung([z()], jetzt).ampel, 'gruen');
  const r = ad.zusammenfassung([z(), z({ kennung: 'b', name: 'B', ok: false, grund: 'kaputt' })], jetzt);
  assert.equal(r.ampel, 'rot');
  assert.equal(r.apps[0].kennung, 'b');
  assert.equal(ad.zusammenfassung([z({ zeit: '2026-11-27T18:00:00Z' })], jetzt).ampel, 'grau', 'Prüfer still');
  const o = ad.oeffentlich(r);
  assert.equal(o.apps[0].grund, 'rot');
  assert.equal(o.apps[0].schirmbild, false);
});

test('server.js: POST mit eigenem Token, Lesen mit NOC-Token oder Technik', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(s, /app\.post\('\/api\/isp\/noc\/android-dauertest', androidDauertest\.annehmen\)/);
  assert.match(s, /app\.get\('\/api\/isp\/noc\/android-dauertest', authMiddleware, requireTechnikOrPraesident/);
  const r = fs.readFileSync(path.join(__dirname, '..', 'routes', 'android-dauertest.js'), 'utf8');
  assert.match(r, /geheimnisGleich\(req\.headers\['x-dauertest-token'\], TOKEN\)/);
});
