// node --test api/test/castwaechter.test.js — Cast-Wächter (lib/castwaechter.js)
// und Verbindung (lib/castverbindung.js) gegen eine Chromecast-Attrappe.
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../lib/castwaechter');
const cv = require('../lib/castverbindung');
const { CastAttrappe, opensslDa } = require('./castattrappe');

const URL9 = 'https://display.rosenweg4303.ch?haus=9';
const DASH = w.empfaengerWahl('');
const EIGEN = w.empfaengerWahl('ab12cd34');
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-26T10:00:00Z');
const leer = { applications: [{ appId: 'E8C28D3C', displayName: 'Backdrop', isIdleScreen: true }] };
const app = (appId, name, sessionId = 's1') => ({ applications: [{ appId, displayName: name, sessionId, transportId: sessionId }] });

// ─── Entscheidungen ohne Netz ─────────────────────────────────────────

test('Empfänger: ohne App-ID DashCast, mit App-ID der eigene', () => {
  assert.equal(DASH.art, 'dashcast');
  assert.equal(DASH.appId, '84912283');
  assert.deepEqual(EIGEN, { art: 'eigen', appId: 'AB12CD34', namespace: w.EIGEN_NAMESPACE });
  assert.equal(w.empfaengerWahl('kaputt').art, 'dashcast');
});

test('Ladenachricht: DashCast mit force (display verbietet das iframe), eigener mit Neuladen', () => {
  assert.deepEqual(w.ladeNachricht(DASH, URL9, 30), { url: URL9, force: true, reload: false, reload_time: 0 });
  assert.deepEqual(w.ladeNachricht(EIGEN, URL9, 30), { type: 'LADEN', url: URL9, reload_minuten: 30 });
});

test('Gesperrt: nichts tun', () => {
  assert.equal(w.entscheiden({ gesperrt: true, empfaenger: DASH, jetzt: T0 }).aktion, 'aus');
});

test('Nicht erreichbar: merkt sich seit wann, und hört nicht auf zu zählen', () => {
  const e1 = w.entscheiden({ erreichbar: false, empfaenger: DASH, jetzt: T0 });
  assert.equal(e1.aktion, 'unerreichbar');
  assert.equal(e1.zustand.unerreichbar_seit, new Date(T0).toISOString());
  const e2 = w.entscheiden({ erreichbar: false, empfaenger: DASH, zustand: e1.zustand, jetzt: T0 + MIN });
  assert.equal(e2.zustand.unerreichbar_seit, new Date(T0).toISOString());
  const e3 = w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, zustand: e2.zustand, jetzt: T0 + 2 * MIN });
  assert.equal(e3.zustand.unerreichbar_seit, null);
});

test('Leerlauf (Neustart): sofort starten', () => {
  const e = w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, jetzt: T0 });
  assert.equal(e.aktion, 'starten');
});

test('Leerlauf ohne isIdleScreen (ältere Firmware): Backdrop an der Kennung erkannt', () => {
  const e = w.entscheiden({ erreichbar: true, status: { applications: [{ appId: 'E8C28D3C' }] }, empfaenger: DASH, url: URL9, jetzt: T0 });
  assert.equal(e.aktion, 'starten');
});

test('DashCast in unserer Sitzung mit unserer Adresse: gut; fremde DashCast-Sitzung: laden', () => {
  const z = w.gestartet({}, { jetzt: T0, sessionId: 's1', url: URL9 });
  assert.equal(w.entscheiden({ erreichbar: true, status: app(DASH.appId, 'DashCast'), empfaenger: DASH, url: URL9, zustand: z, jetzt: T0 }).aktion, 'gut');
  assert.equal(w.entscheiden({ erreichbar: true, status: app(DASH.appId, 'DashCast', 's2'), empfaenger: DASH, url: URL9, zustand: z, jetzt: T0 }).aktion, 'laden');
  // Haus geändert: andere Adresse, also neu laden
  assert.equal(w.entscheiden({ erreichbar: true, status: app(DASH.appId, 'DashCast'), empfaenger: DASH, url: URL9.replace('9', '13'), zustand: z, jetzt: T0 }).aktion, 'laden');
});

test('Eigener Empfänger: gut nur, wenn er unsere Adresse meldet', () => {
  const st = app(EIGEN.appId, 'Rosenweg Anzeige');
  assert.equal(w.entscheiden({ erreichbar: true, status: st, meldung: { url: URL9 }, empfaenger: EIGEN, url: URL9, jetzt: T0 }).aktion, 'gut');
  assert.equal(w.entscheiden({ erreichbar: true, status: st, meldung: { url: 'https://display.rosenweg4303.ch' }, empfaenger: EIGEN, url: URL9, jetzt: T0 }).aktion, 'laden');
  assert.equal(w.entscheiden({ erreichbar: true, status: st, meldung: null, empfaenger: EIGEN, url: URL9, jetzt: T0 }).aktion, 'laden');
});

test('Fremdes Casten: Pause abwarten, dann übernehmen', () => {
  const yt = app('233637DE', 'YouTube', 'f1');
  const e1 = w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, jetzt: T0 });
  assert.equal(e1.aktion, 'warten');
  assert.match(e1.grund, /^YouTube läuft/);
  const e2 = w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, zustand: e1.zustand, jetzt: T0 + 19 * MIN });
  assert.equal(e2.aktion, 'warten');
  const e3 = w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, zustand: e2.zustand, jetzt: T0 + 20 * MIN });
  assert.equal(e3.aktion, 'starten');
  assert.equal(e3.grund, 'YouTube übernommen (Pause abgelaufen)');
});

test('Fremdes Casten: App-Wechsel setzt die Pause nicht zurück', () => {
  const e1 = w.entscheiden({ erreichbar: true, status: app('233637DE', 'YouTube'), empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, jetzt: T0 });
  const e2 = w.entscheiden({ erreichbar: true, status: app('CC32E753', 'Spotify'), empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, zustand: e1.zustand, jetzt: T0 + 20 * MIN });
  assert.equal(e2.aktion, 'starten');
});

test('Fremdes Casten endet: Anzeige sofort zurück, Pause vergessen', () => {
  const e1 = w.entscheiden({ erreichbar: true, status: app('233637DE', 'YouTube'), empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, jetzt: T0 });
  const e2 = w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, zustand: e1.zustand, jetzt: T0 + MIN });
  assert.equal(e2.aktion, 'starten');
  assert.equal(e2.zustand.fremd_seit, null);
});

test('Notfall und „von Hand" übergehen die Pause; Pause 0 heisst sofort', () => {
  const yt = app('233637DE', 'YouTube');
  assert.equal(w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, notfall: true, jetzt: T0 }).grund, 'YouTube übernommen (Notfall)');
  assert.equal(w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 20 * MIN, erzwingen: true, jetzt: T0 }).aktion, 'starten');
  assert.equal(w.entscheiden({ erreichbar: true, status: yt, empfaenger: DASH, url: URL9, pauseMs: 0, jetzt: T0 }).aktion, 'starten');
});

test('Gescheiterter Start: wachsende Pause, höchstens 10 min; Erfolg setzt zurück', () => {
  assert.deepEqual([0, 1, 2, 3, 6, 9].map(w.startpause), [0, 30000, 60000, 120000, 600000, 600000]);
  let z = w.gescheitert({}, { jetzt: T0, fehler: 'NOT_FOUND' });
  z = w.gescheitert(z, { jetzt: T0, fehler: 'NOT_FOUND' });
  assert.equal(z.fehlversuche, 2);
  assert.equal(w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, zustand: z, jetzt: T0 + 59 * 1000 }).aktion, 'warten');
  assert.equal(w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, zustand: z, jetzt: T0 + 60 * 1000 }).aktion, 'starten');
  assert.equal(w.entscheiden({ erreichbar: true, status: leer, empfaenger: DASH, url: URL9, zustand: z, erzwingen: true, jetzt: T0 }).aktion, 'starten');
  const ok = w.gestartet(z, { jetzt: T0, sessionId: 's', url: URL9, wiederherstellung: true });
  assert.equal(ok.fehlversuche, 0);
  assert.equal(ok.wiederherstellungen, 1);
  assert.equal(ok.wiederhergestellt_am, new Date(T0).toISOString());
});

test('Adressen: IPv4 oder Hostname, MAC normiert; erlaubte Anzeige-Hosts', () => {
  assert.equal(w.adressePruefen(' 192.0.2.10 '), '192.0.2.10');
  assert.equal(w.adressePruefen('cc-eingang.lan'), 'cc-eingang.lan');
  assert.equal(w.adressePruefen('192.0.2.10:8009'), null);
  assert.equal(w.adressePruefen('http://x'), null);
  assert.equal(w.adressePruefen('300.1.1.1'), null);
  assert.equal(w.macPruefen('AA-BB-CC-00-11-22'), 'aa:bb:cc:00:11:22');
  assert.equal(w.macPruefen('nix'), null);
  assert.equal(w.adresseErlaubt(URL9, ['display.rosenweg4303.ch']), true);
  assert.equal(w.adresseErlaubt('https://boese.example/', ['display.rosenweg4303.ch']), false);
  assert.equal(w.adresseErlaubt('http://display.rosenweg4303.ch/', ['display.rosenweg4303.ch']), false);
});

test('Chromecast bekommt display-lite.html auf demselben Host, Haus bleibt; voll und fremde Pfade bleiben', () => {
  // display.* ist nur intern auflösbar — der Chromecast bekommt www.*
  assert.equal(w.castAdresse(URL9), 'https://www.rosenweg4303.ch/display-lite.html?haus=9');
  assert.equal(w.castAdresse('https://display.rosenweg4303.ch/?haus=9'), 'https://www.rosenweg4303.ch/display-lite.html?haus=9');
  assert.equal(w.castAdresse('https://www.rosenweg4303.ch/display.html?haus=13&gesperrt=1'),
    'https://www.rosenweg4303.ch/display-lite.html?haus=13&gesperrt=1');
  assert.equal(w.castAdresse('https://display.rosenweg4303.ch'), 'https://www.rosenweg4303.ch/display-lite.html');
  // overrides roles.display.cast_seite = 'voll': display.html bleibt
  assert.equal(w.castAdresse(URL9, 'voll'), URL9);
  // Von Hand überschriebene andere Seite: nicht anfassen
  assert.equal(w.castAdresse('https://display.rosenweg4303.ch/test.html?haus=9'), 'https://display.rosenweg4303.ch/test.html?haus=9');
  assert.equal(w.castAdresse('kaputt'), 'kaputt');
  assert.equal(w.castAdresse(undefined), undefined);
  // Erlaubt mit den Cast-Hosts dazu (so prüft castZiel)
  assert.equal(w.adresseErlaubt(w.castAdresse(URL9), ['display.rosenweg4303.ch', ...w.CAST_ERLAUBT]), true);
  assert.equal(w.adresseErlaubt(w.castAdresse(URL9), ['display.rosenweg4303.ch']), false);
});

test('Chromecast mit Haus 9: aus buildConfig wird die Lite-Adresse, overrides wirken', () => {
  const { buildConfig } = require('../lib/stationconfig');
  const ziel = (st) => {
    const d = buildConfig({ id: 'cc', hostname: 'cc', ...st, role: 'display' }).roles.display;
    return w.castAdresse(d.url, d.cast_seite);
  };
  assert.equal(ziel({ haus: 9 }), 'https://www.rosenweg4303.ch/display-lite.html?haus=9');
  assert.equal(ziel({ haus: 9, overrides: { roles: { display: { cast_seite: 'voll' } } } }), URL9);
  assert.equal(ziel({ haus: 9, overrides: { roles: { display: { url: 'https://display.rosenweg4303.ch/display.html' } } } }),
    'https://www.rosenweg4303.ch/display-lite.html?haus=9');
});

// ─── Gegen die Attrappe ───────────────────────────────────────────────

const mitOpenssl = { skip: opensslDa() ? false : 'openssl fehlt' };

// Die Ladenachricht geht ohne Antwort hinaus; kurz warten, bis die Attrappe sie hat.
const kurz = () => new Promise((ok) => setTimeout(ok, 50));

async function lauf(cc, empfaenger, zustand, extra = {}) {
  const e = await cv.abgleichen({
    geraet: { adresse: '127.0.0.1', port: cc.port }, url: URL9, reloadMinuten: 30, empfaenger, zustand,
    pauseMs: 20 * MIN, jetzt: T0, ...extra,
  });
  await kurz();
  return e;
}

test('Attrappe, DashCast: Leerlauf → gestartet und geladen; danach gut, Neustart → wiederhergestellt', mitOpenssl, async (t) => {
  const cc = await new CastAttrappe().starten();
  t.after(() => { cv.alleSchliessen(); cc.stoppen(); });

  const e1 = await lauf(cc, DASH, {});
  assert.equal(e1.aktion, 'starten');
  assert.equal(e1.wiederhergestellt, true);
  assert.equal(cc.starts, 1);
  assert.deepEqual(cc.geladen.at(-1), { url: URL9, force: true, reload: false, reload_time: 0 });

  const e2 = await lauf(cc, DASH, e1.zustand);
  assert.equal(e2.aktion, 'gut');
  assert.equal(cc.starts, 1);

  cc.neustart();
  const e3 = await lauf(cc, DASH, e2.zustand);
  assert.equal(e3.aktion, 'starten');
  assert.equal(e3.zustand.wiederherstellungen, 2);
  assert.equal(cc.starts, 2);
});

test('Attrappe: jemand castet — erst warten, nach der Pause übernehmen', mitOpenssl, async (t) => {
  const cc = await new CastAttrappe().starten();
  t.after(() => { cv.alleSchliessen(); cc.stoppen(); });
  const e1 = await lauf(cc, DASH, {});
  cc.fremdCasten('YouTube');
  const e2 = await lauf(cc, DASH, e1.zustand);
  assert.equal(e2.aktion, 'warten');
  assert.equal(e2.zustand.fremd_app, 'YouTube');
  assert.equal(cc.starts, 1);
  const e3 = await lauf(cc, DASH, e2.zustand, { jetzt: T0 + 21 * MIN });
  assert.equal(e3.aktion, 'starten');
  assert.equal(cc.starts, 2);
  assert.equal(cc.apps[0].appId, DASH.appId);
});

test('Attrappe, eigener Empfänger: fragt nach, lädt bei falscher Adresse neu', mitOpenssl, async (t) => {
  const cc = await new CastAttrappe().starten();
  t.after(() => { cv.alleSchliessen(); cc.stoppen(); });
  const e1 = await lauf(cc, EIGEN, {});
  assert.equal(e1.aktion, 'starten');
  assert.deepEqual(cc.geladen.at(-1), { type: 'LADEN', url: URL9, reload_minuten: 30 });
  const e2 = await lauf(cc, EIGEN, e1.zustand);
  assert.equal(e2.aktion, 'gut');
  cc.inhalt = 'https://display.rosenweg4303.ch';
  const e3 = await lauf(cc, EIGEN, e2.zustand);
  assert.equal(e3.aktion, 'laden');
  assert.equal(e3.wiederhergestellt, false);
  assert.equal(cc.inhalt, URL9);
  assert.equal(cc.starts, 1);
});

test('Attrappe: verweigerter Start wird als Fehlversuch gezählt', mitOpenssl, async (t) => {
  const cc = await new CastAttrappe({ startVerweigern: true }).starten();
  t.after(() => { cv.alleSchliessen(); cc.stoppen(); });
  const e = await lauf(cc, EIGEN, {});
  assert.equal(e.aktion, 'gescheitert');
  assert.equal(e.zustand.fehlversuche, 1);
  assert.match(e.zustand.fehler, /NOT_FOUND/);
});

test('Kein Gerät an der Adresse: unerreichbar, kein Wurf', async () => {
  const net = require('net');
  const frei = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const e = await cv.abgleichen({
    geraet: { adresse: '127.0.0.1', port: frei }, url: URL9, empfaenger: DASH, zustand: {}, jetzt: T0,
    verbindungsOpts: { zeitlimitMs: 2000 },
  });
  assert.equal(e.aktion, 'unerreichbar');
  assert.equal(e.zustand.erreichbar, false);
  assert.ok(e.zustand.fehler);
});
