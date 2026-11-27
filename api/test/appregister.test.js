// node --test api/test/appregister.test.js — App-Register (apps-register.json,
// lib/appregister.js) und App-Kennung (X-Rosenweg-App, lib/appkennung.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const reg = require('../lib/appregister');
const { appKennung, merken } = require('../lib/appkennung');
const ak = require('../lib/appkarte');

const WURZEL = path.join(__dirname, '..', '..');
const DATEI = path.join(WURZEL, 'apps-register.json');
const daten = JSON.parse(fs.readFileSync(DATEI, 'utf8'));

test('apps-register.json ist gueltig und kennt die bisherigen Apps', () => {
  assert.deepEqual(reg.pruefen(daten), []);
  for (const k of ['vm', 'salz', 'kiosk', 'profil', 'zutritt', 'mein-telefon']) assert.ok(daten.apps[k], k);
  assert.equal(daten.apps.salz.paket, 'ch.rosenweg4303.salz');
  assert.equal(Object.keys(daten.katalog).length >= 16, true);
  assert.equal(daten.katalog['ch.rosenweg4303.telefon'].nicht_oeffentlich, true);
  // Rosenweg Karten ist in Rosenweg Zutritt aufgegangen (Stefan 27.11.2026): eigenes Paket,
  // Karten weder unter apps noch im Katalog, sondern unter aufgegeben
  assert.equal(daten.apps.zutritt.paket, 'ch.rosenweg4303.zutritt');
  assert.equal(daten.apps.zutritt.repo, 'Rosenweg/rosenweg-zutritt');
  assert.equal(daten.apps.zutritt.technik, true);
  assert.equal(daten.apps.karten, undefined);
  assert.equal(daten.katalog['ch.rosenweg4303.karten'], undefined);
  assert.equal(daten.aufgegeben['ch.rosenweg4303.karten'].ersetzt_durch, 'ch.rosenweg4303.zutritt');
  assert.ok(fs.existsSync(path.join(WURZEL, daten.apps.zutritt.logo)));
  assert.ok(!fs.existsSync(path.join(WURZEL, 'img', 'apps', 'rosenweg-karten.png')));
});

test('pruefen findet Fehler', () => {
  const kopie = () => JSON.parse(JSON.stringify(daten));
  let d = kopie(); d.apps.neu = { ...d.apps.salz };            // gleiches Paket und Repo
  assert.match(reg.pruefen(d).join('\n'), /paket ch\.rosenweg4303\.salz doppelt/);
  d = kopie(); d.apps.vm.repo = 'fremd/repo';
  assert.match(reg.pruefen(d).join('\n'), /apps\.vm: repo ungültig/);
  d = kopie(); delete d.apps.vm.name;
  assert.match(reg.pruefen(d).join('\n'), /apps\.vm: name fehlt/);
  d = kopie(); d.katalog['Kein Paket'] = { repo: 'Rosenweg/x' };
  assert.match(reg.pruefen(d).join('\n'), /Paketname ungültig/);
  d = kopie(); d.version = 2;
  assert.match(reg.pruefen(d).join('\n'), /version/);
  assert.deepEqual(reg.pruefen(null), ['kein Objekt']);
  d = kopie(); d.aufgegeben['ch.rosenweg4303.salz'] = {};       // aufgegeben und zugleich unter apps
  assert.match(reg.pruefen(d).join('\n'), /paket ch\.rosenweg4303\.salz doppelt/);
  d = kopie(); d.aufgegeben = [];
  assert.match(reg.pruefen(d).join('\n'), /aufgegeben ist kein Objekt/);
  d = kopie(); delete d.aufgegeben;                                // freiwillig
  assert.deepEqual(reg.pruefen(d), []);
});

test('nachPaket und oeffentliche Fassung', () => {
  assert.deepEqual(reg.nachPaket('ch.rosenweg4303.salz', daten), { art: 'app', schluessel: 'salz', name: 'Rosenweg Salz', technik: false });
  assert.equal(reg.nachPaket('ch.rosenweg4303.calendar', daten).art, 'katalog');
  assert.equal(reg.nachPaket('ch.rosenweg4303.gibtsnicht', daten), null);
  const o = reg.oeffentlich(daten);
  assert.equal(o.apps.kiosk._notiz, undefined);
  assert.equal(o.apps.kiosk.name, 'Rosenweg Kiosk');
  assert.equal(o._hinweis, undefined);
  // register() liest dieselbe Datei aus dem Repo
  assert.equal(reg.register().apps.vm.paket, 'ch.rosenweg4303.vm');
});

test('X-Rosenweg-App lesen', () => {
  assert.deepEqual(appKennung('ch.rosenweg4303.salz/1.9.0'),
    { paket: 'ch.rosenweg4303.salz', version: '1.9.0', bekannt: true, text: 'ch.rosenweg4303.salz/1.9.0' });
  assert.equal(appKennung('ch.rosenweg4303.neu/0.1.0+3').bekannt, false);
  assert.equal(appKennung('CH.Rosenweg4303.Salz/2.0').paket, 'ch.rosenweg4303.salz');
  for (const falsch of [undefined, '', 'salz', 'ch.rosenweg4303.salz/', '/1.0', 'ch.rosenweg4303.salz/1 0',
    'ch.rosenweg4303.salz/<b>', 'x'.repeat(200) + '/1.0', 'ch..x/1.0']) {
    assert.equal(appKennung(falsch), null, String(falsch));
  }
  assert.equal(appKennung(['ch.rosenweg4303.vm/1.0', 'x']).paket, 'ch.rosenweg4303.vm');
});

test('Kennung merken: hoechstens einmal je Person, App, Version und Stunde', async () => {
  const anfragen = [];
  const pool = { query: async (sql, p) => { anfragen.push([sql.trim().split(/\s+/)[0], p]); return { rows: [] }; } };
  const k = appKennung('ch.rosenweg4303.salz/1.9.0');
  const t = Date.now();
  assert.equal(merken(pool, 'A@example.org', k, 'karte', t), true);
  assert.equal(merken(pool, 'a@example.org', k, 'karte', t + 1000), false);
  assert.equal(merken(pool, 'a@example.org', appKennung('ch.rosenweg4303.salz/1.9.1'), 'app', t + 1000), true);
  assert.equal(merken(pool, 'a@example.org', k, 'karte', t + 61 * 60 * 1000), true);
  assert.equal(merken(pool, '', k, 'karte', t), false);
  assert.equal(merken(pool, 'a@example.org', null, 'karte', t), false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(anfragen.filter(a => a[0] === 'INSERT').length, 3);
});

test('Karten-Sitzung: Anzeigename aus dem Register, nicht aus der Anfrage', () => {
  const geraet = { kennung: 'a'.repeat(64), name: 'Galaxy' };
  const schluessel = require('crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const basis = { uid: '04:d4:c2:27:c2:2a:81', geraet, schluessel };
  let p = ak.anmeldungPruefen({ ...basis, app: 'ch.rosenweg4303.salz', app_name: 'Rosenweg Bank' });
  assert.equal(p.werte.appName, 'Rosenweg Salz');
  p = ak.anmeldungPruefen({ ...basis, app: 'ch.rosenweg4303.calendar', app_name: 'Rosenweg Kalender' });
  assert.equal(p.werte.appName, 'Rosenweg Kalender');    // Katalog ohne Namen: wie bisher
  p = ak.anmeldungPruefen({ ...basis, app: 'ch.example.fremd', app_name: 'Fremd' });
  assert.equal(p.werte.appName, 'Fremd');                // unbekannte App: wie bisher
});

test('PBX: Register nicht mehr im Code, Lader versteht apps-register.json', (t) => {
  const appPy = fs.readFileSync(path.join(WURZEL, 'pbx', 'api', 'app.py'), 'utf8');
  assert.doesNotMatch(appPy, /^APPS_REGISTER = \{\s*\n\s+"/m);
  assert.doesNotMatch(appPy, /^APPS_KATALOG_REPOS = \{\s*\n\s+"/m);
  assert.match(appPy, /def _apps_register_uebernehmen\(d, quelle\)/);
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0) { t.skip('python3 fehlt'); return; }
  // Den Lader aus app.py ohne Flask ausfuehren und das Ergebnis ansehen
  const code = `
import json, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
i = src.index("_APP_SCHLUESSEL = re.compile"); j = src.index("def _apps_register_datei")
class L:
    def warning(self, *a): print("WARN", a, file=sys.stderr)
class A: logger = L()
g = {"re": re, "app": A(), "_APPS_REGISTER_STAND": {"zeit": 0, "quelle": "", "fehler": ""}}
exec(src[i:j], g)
ok = g["_apps_register_uebernehmen"](json.load(open(sys.argv[2], encoding="utf-8")), "test")
kaputt = g["_apps_register_uebernehmen"]({"version": 1, "apps": {"x": {"paket": "kein paket"}}, "katalog": {}}, "kaputt")
print(json.dumps({"ok": ok, "kaputt": kaputt, "register": g["APPS_REGISTER"], "repos": g["APPS_KATALOG_REPOS"],
                  "info": g["APPS_KATALOG_INFO"], "ohne": sorted(g["APPS_OEFFENTLICH_OHNE"]),
                  "aus": sorted(g["APPS_AUFGEGEBEN"])}))
`;
  const r = spawnSync('python3', ['-I', '-c', code, path.join(WURZEL, 'pbx', 'api', 'app.py'), DATEI], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.ok, true);
  assert.equal(e.kaputt, false);                       // ungueltig: alter Stand bleibt
  assert.equal(e.register.salz.repo, 'Rosenweg/rosenweg-salz');
  assert.equal(e.register.zutritt.repo, 'Rosenweg/rosenweg-zutritt');
  assert.equal(e.register.zutritt.technik, true);
  assert.equal(e.register.karten, undefined);
  assert.equal(e.repos['Rosenweg/rosenweg-karten'], undefined);   // keine Releases mehr
  assert.deepEqual(e.aus, ['ch.rosenweg4303.karten']);
  assert.equal(e.repos['Rosenweg/calendar-rosenweg'], 'ch.rosenweg4303.calendar');
  assert.deepEqual(e.ohne, ['ch.rosenweg4303.telefon']);
  assert.equal(e.register.kiosk._notiz, undefined);
});
