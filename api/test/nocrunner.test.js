// node --test api/test/nocrunner.test.js — Runner im NOC: Eingang, Ampel, Warnungen.
const test = require('node:test');
const assert = require('node:assert/strict');
const nr = require('../lib/nocrunner');

const r = (x = {}) => ({ name: 'rosenweg-runner-1', art: 'linux', knoten: 'pve2', online: true, busy: false, soll_an: true, dienst_aktiv: true, ...x });
const jetzt = Date.now();

test('Eingang: gueltig und abgewiesen', () => {
  assert.equal(nr.eingabePruefen({ runner: [r()], wartend: 3 }).bericht.wartend, 3);
  assert.ok(nr.eingabePruefen({}).fehler);
  assert.ok(nr.eingabePruefen({ runner: [r({ name: '../x' })] }).fehler);
});

test('alles ok: gruen, keine Warnung', () => {
  const z = nr.zusammenfassung(nr.eingabePruefen({ runner: [r(), r({ name: 'win-runner', art: 'windows' })] }).bericht, jetzt - 30000, jetzt);
  assert.equal(z.ampel, 'gruen');
  assert.deepEqual(z.warnungen, []);
});

test('Runner soll laufen, ist offline: Warnung, rot', () => {
  const z = nr.zusammenfassung(nr.eingabePruefen({ runner: [r({ online: false })] }).bericht, jetzt, jetzt);
  assert.equal(z.ampel, 'rot');
  assert.match(z.warnungen[0], /offline/);
});

test('ausgeschalteter Runner ist grau, keine Warnung', () => {
  const z = nr.zusammenfassung(nr.eingabePruefen({ runner: [r({ name: 'rosenweg-runner-4', online: false, soll_an: false, dienst_aktiv: false })] }).bericht, jetzt, jetzt);
  assert.equal(z.runner[0].zustand, 'aus');
  assert.equal(z.ampel, 'gruen');
});

test('win-runner offline: Warnung', () => {
  const z = nr.zusammenfassung(nr.eingabePruefen({ runner: [r({ name: 'win-runner', art: 'windows', online: false })] }).bericht, jetzt, jetzt);
  assert.equal(z.ampel, 'rot');
});

test('Waechter still und nie gemeldet', () => {
  const b = nr.eingabePruefen({ runner: [r()] }).bericht;
  assert.equal(nr.zusammenfassung(b, jetzt - 10 * 60000, jetzt).waechter.zustand, 'still');
  assert.equal(nr.zusammenfassung(null, 0, jetzt).ampel, 'grau');
});

test('Job-Angaben: bereinigt, fremde Links verworfen', () => {
  const e = nr.eingabePruefen({ runner: [r({ busy: true, job: { repo: 'x', workflow: 'CI', job: 'build', url: 'https://evil.example/x', prozent: 40, rest_s: 120, pr: 7 } })],
    warteschlange: [{ repo: 'y', job: 'z', url: 'https://github.com/Rosenweg/y/actions/runs/1/job/2', wartezeit_s: 30 }] });
  assert.equal(e.bericht.runner[0].job.url, null);
  assert.equal(e.bericht.runner[0].job.prozent, 40);
  assert.equal(e.bericht.warteschlange[0].wartezeit_s, 30);
});

test('oeffentliche Sicht ohne Repo-Namen', () => {
  const b = nr.eingabePruefen({ runner: [r({ busy: true, job: { repo: 'geheim', job: 'b', prozent: 5 } })] }).bericht;
  const o = nr.oeffentlich(nr.zusammenfassung(b, jetzt, jetzt));
  assert.equal(JSON.stringify(o).includes('geheim'), false);
});

test('Stau: Alarm, hoechstens einer je Stunde, Entwarnung', () => {
  const z = { aktiv: false, gemeldet: false, zuletzt: 0 };
  const t0 = 1_000_000_000_000;
  assert.equal(nr.stauEntscheiden(z, { lange: 5 }, t0), null, 'unter der Grenze');
  assert.equal(nr.stauEntscheiden(z, { lange: 11 }, t0), 'alarm');
  assert.equal(nr.stauEntscheiden(z, { lange: 30 }, t0 + 10 * 60000), null, 'keine zweite Meldung in der Stunde');
  assert.equal(nr.stauEntscheiden(z, { lange: 30 }, t0 + 61 * 60000), 'alarm', 'nach einer Stunde nochmals');
  assert.equal(nr.stauEntscheiden(z, { lange: 2 }, t0 + 70 * 60000), 'entwarnung');
  assert.equal(nr.stauEntscheiden(z, { lange: 2 }, t0 + 80 * 60000), null, 'Entwarnung nur einmal');
});

test('Stau und uebersprungenes Release faerben die Kachel', () => {
  const b = nr.eingabePruefen({ runner: [r()], stau: { wartend: 20, lange: 12, aeltester_s: 3000 },
    release: { aktiv: true, uebersprungen: [{ repo: 'rosenweg-x', tag: 'v1.0.0' }], laeuft: [], wartend: [] } }).bericht;
  const z = nr.zusammenfassung(b, jetzt, jetzt);
  assert.equal(z.ampel, 'rot');
  assert.ok(z.warnungen.some((w) => /Stau/.test(w)));
  assert.ok(z.warnungen.some((w) => /uebersprungen/.test(w)));
});
