// node --test api/test/wetter-ersatz.test.js — Ersatzwerte der Wetterstation aus den
// Open Data von MeteoSchweiz (lib/wetter-ersatz.js). Ohne Netz, Datenbank und Broker:
// Abruf, Pool und MQTT sind Attrappen.
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../lib/wetter-ersatz');

const KOPF = 'station_abbr;reference_timestamp;tre200s0;tre005s0;tresurs0;xchills0;ure200s0;tde200s0;pva200s0;prestas0;pp0qnhs0;pp0qffs0;ppz850s0;ppz700s0;fkl010z1;fve010z0;fkl010z0;dkl010z0;wcc006s0;fu3010z0;fkl010z3;fu3010z1;fu3010z3;rre150z0;htoauts0;gre000z0;ods000z0;oli000z0;olo000z0;osr000z0;sre000z0;tso005s0;tso010s0;tso020s0';
const zeile = (abk, zeit, o = {}) => {
  const f = { tre200s0: '3.1', ure200s0: '62.8', prestas0: '988.9', pp0qffs0: '1028.3', dkl010z0: '107', fu3010z0: '7.9', fu3010z1: '16.2', rre150z0: '0.2', gre000z0: '104', sre000z0: '10', ...o };
  const sp = KOPF.split(';');
  return sp.map(k => k === 'station_abbr' ? abk : k === 'reference_timestamp' ? zeit : (f[k] ?? '')).join(';');
};
const csv = (abk, zeiten, o) => [KOPF, ...zeiten.map(z => zeile(abk, z, o))].join('\r\n') + '\r\n';

// 28.11.2026 13:20 UTC
const JETZT = Date.UTC(2026, 10, 28, 13, 20);
const CFG = w.konfig({});
const min = (m) => new Date(JETZT - m * 60000);
const eigen = (m, o = {}) => ({ ts: min(m), outdoortemp: 4.2, outdoorhumidity: 80, windspeed: 3, winddir: 200, pressureabs: 985, solarradiation: 0, rain: 0, uvi: 0, windgustspeed: 5, ...o });
const reihe = (von, bis, o) => { const r = []; for (let m = von; m >= bis; m--) r.push(eigen(m, typeof o === 'function' ? o(m) : o)); return r; };

test('CSV: Zeitstempel ist UTC, Leerwerte werden null, Zuordnung und Einheiten', () => {
  const r = w.ogdLesen(csv('BAS', ['28.11.2026 13:00', '28.11.2026 12:50']));
  assert.equal(r.length, 2);
  assert.equal(r[0].ts, Date.UTC(2026, 10, 28, 12, 50)); // aelteste zuerst
  const v = r[1].werte;
  assert.equal(v.outdoortemp, 3.1);
  assert.equal(v.outdoorhumidity, 62.8);
  assert.equal(v.windspeed, 7.9);
  assert.equal(v.windgustspeed, 16.2);
  assert.equal(v.winddir, 107);
  assert.equal(v.pressureabs, 988.9);     // QFE
  assert.equal(v.pressurerel, 1028.3);    // QFF
  assert.equal(v.solarradiation, Math.round(104 * 126.7)); // Lux wie die eigene Station
  assert.equal(v.rain, 1.2);              // 0.2 mm je 10 min = 1.2 mm/h
  assert.equal(v.uvi, null);
  assert.equal(r[1].sonnenschein_min, 10);
});

test('CSV: Zeilen ohne Temperatur und unplausible Werte fliegen raus', () => {
  const t = csv('STC', ['28.11.2026 13:00'], { tre200s0: '' }) + zeile('BAS', '28.11.2026 13:10', { tre200s0: '99' }) + '\r\n';
  assert.equal(w.ogdLesen(t).length, 0);
});

test('eigene Station: gesund, wenn frisch und beweglich', () => {
  const rows = reihe(90, 0, (m) => ({ outdoortemp: 4 + (m % 7) / 10 }));
  assert.deepEqual(w.bewerteEigene(rows, JETZT, CFG), { ok: true, grund: null, seit: null });
});

test('eigene Station: nichts seit mehr als 20 Minuten -> keine-lieferung, seit = letzte Lieferung', () => {
  const rows = reihe(120, 25, (m) => ({ outdoortemp: 4 + (m % 7) / 10 }));
  const b = w.bewerteEigene(rows, JETZT, CFG);
  assert.equal(b.ok, false);
  assert.equal(b.grund, 'keine-lieferung');
  assert.equal(b.seit, JETZT - 25 * 60000);
  // 19 Minuten sind noch in Ordnung
  assert.equal(w.bewerteEigene(reihe(120, 19, (m) => ({ outdoortemp: 4 + (m % 7) / 10 })), JETZT, CFG).ok, true);
  assert.equal(w.bewerteEigene([], JETZT, CFG).grund, 'keine-lieferung');
});

test('eigene Station: Schwelle ist konfigurierbar', () => {
  const cfg = w.konfig({ WETTER_AUSFALL_MIN: '5' });
  assert.equal(w.bewerteEigene(reihe(60, 10, (m) => ({ outdoortemp: m / 10 })), JETZT, cfg).ok, false);
});

test('eigene Station: Temperatur ausserhalb -40..+50 oder fehlend -> unplausibel/keine-werte', () => {
  const heiss = [...reihe(60, 1, (m) => ({ outdoortemp: 4 + m / 100 })), eigen(0, { outdoortemp: 51 })];
  assert.equal(w.bewerteEigene(heiss, JETZT, CFG).grund, 'unplausibel');
  const kalt = [eigen(1, { outdoortemp: -41 }), eigen(0, { outdoortemp: -41.5 })];
  const b = w.bewerteEigene(kalt, JETZT, CFG);
  assert.equal(b.grund, 'unplausibel');
  assert.equal(b.seit, JETZT - 60000);
  assert.equal(w.bewerteEigene([eigen(0, { outdoortemp: null })], JETZT, CFG).grund, 'keine-werte');
  assert.equal(w.bewerteEigene([eigen(0, { outdoortemp: 50 })], JETZT, CFG).ok, true);
  assert.equal(w.bewerteEigene([eigen(0, { outdoortemp: -40 })], JETZT, CFG).ok, true);
});

test('eigene Station: ueber eine Stunde eingefroren -> eingefroren, seit = Beginn der Starre', () => {
  const rows = reihe(200, 0, (m) => (m > 100 ? { outdoortemp: 4 + (m % 5) / 10 } : { outdoortemp: 7.7, outdoorhumidity: 55 }));
  const b = w.bewerteEigene(rows, JETZT, CFG);
  assert.equal(b.ok, false);
  assert.equal(b.grund, 'eingefroren');
  assert.equal(b.seit, JETZT - 100 * 60000);
});

test('eigene Station: nur 40 Minuten gleich ist noch nicht eingefroren; eine Aenderung heilt sofort', () => {
  assert.equal(w.bewerteEigene(reihe(40, 0, {}), JETZT, CFG).ok, true);
  const starr = reihe(90, 1, { outdoortemp: 7.7, outdoorhumidity: 55 });
  assert.equal(w.bewerteEigene(starr, JETZT, CFG).grund, 'eingefroren');
  assert.equal(w.bewerteEigene([...starr, eigen(0, { outdoortemp: 7.8, outdoorhumidity: 55 })], JETZT, CFG).ok, true);
});

// ─── Dienst mit Attrappen ────────────────────────────────────────────

function dienst({ eigeneRows, dateien, env = {}, jetzt = { t: JETZT } }) {
  const abrufe = [], mqtt = [], gespeichert = [];
  const pool = {
    async query(sql, par) {
      if (/SELECT MAX\(ts\)/.test(sql)) return { rows: [{ m: null }] };
      if (/INSERT INTO wetter_history/.test(sql)) { gespeichert.push(par); return { rows: [] }; }
      if (/LIKE 'meteoschweiz-%'/.test(sql)) return { rows: [] };
      if (/FROM wetter_history/.test(sql)) return { rows: eigeneRows() };
      throw new Error('unerwartet: ' + sql);
    },
  };
  const fetchFn = async (url) => {
    abrufe.push(url);
    const abk = /smn_(\w+)_t_now/.exec(url)[1].toUpperCase();
    const d = dateien[abk];
    if (d == null) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => d };
  };
  const d = w.erstelle({ pool, fetchFn, publish: (t, p, o) => mqtt.push({ t, p, o }), jetzt: () => jetzt.t, env, log: { info() {}, warn() {} } });
  return { d, abrufe, mqtt, gespeichert, jetzt };
}
const BAS = csv('BAS', ['28.11.2026 13:10', '28.11.2026 13:00', '28.11.2026 12:50']);
const defekt = () => reihe(240, 30, (m) => ({ outdoortemp: 4 + (m % 7) / 10 })); // seit 30 min nichts

test('Takt: Station ausgefallen -> Ersatz abrufen, speichern (eigene Quelle), MQTT retained mit quelle und zustand', async () => {
  const { d, abrufe, mqtt, gespeichert } = dienst({ eigeneRows: defekt, dateien: { BAS } });
  const r = await d.takt();
  assert.equal(r.zustand, 'ersatz');
  assert.equal(abrufe.length, 1);
  assert.match(abrufe[0], /^https:\/\/data\.geo\.admin\.ch\/ch\.meteoschweiz\.ogd-smn\/bas\/ogd-smn_bas_t_now\.csv$/);
  assert.ok(gespeichert.length > 0);
  assert.ok(gespeichert.every(p => p[1] === 'meteoschweiz-bas'), 'nie unter der eigenen Station');
  assert.ok(mqtt.every(m => m.o.retain === true));
  const t = Object.fromEntries(mqtt.map(m => [m.t, m.p]));
  assert.equal(t['rosenweg/wetter/zustand'], 'ersatz');
  assert.equal(t['rosenweg/wetter/outdoortemp'], '3.1');
  assert.equal(t['rosenweg/wetter/uvi'], '');  // nicht gemessen -> altes Retained geloescht
  const q = JSON.parse(t['rosenweg/wetter/quelle']);
  assert.equal(q.art, 'meteoschweiz');
  assert.equal(q.station, 'BAS');
  assert.equal(q.stand, '2026-11-28T13:10:00.000Z');
  assert.ok(!mqtt.some(m => m.t.startsWith('wetter/r9')), 'bestehende Topics bleiben unberuehrt');
});

test('aktuell: Ersatz traegt quelle {art, station, stand}; gesund -> eigene Werte', async () => {
  const a = dienst({ eigeneRows: defekt, dateien: { BAS } });
  const r = await a.d.aktuell();
  assert.equal(r.zustand, 'ersatz');
  assert.equal(r.quelle.art, 'meteoschweiz');
  assert.equal(r.quelle.station, 'BAS');
  assert.equal(r.werte.outdoortemp, 3.1);
  assert.equal(r.werte.sonnenschein_min, 10);
  assert.equal(r.ausfall.grund, 'keine-lieferung');
  const g = dienst({ eigeneRows: () => reihe(90, 0, (m) => ({ outdoortemp: 4 + (m % 7) / 10 })), dateien: { BAS } });
  const e = await g.d.aktuell();
  assert.equal(e.zustand, 'eigen');
  assert.equal(e.quelle.art, 'eigen');
  assert.equal(g.abrufe.length, 0, 'gesunde Station: kein Abruf bei MeteoSchweiz');
});

test('Abruf hoechstens alle 10 Minuten, danach wieder', async () => {
  const { d, abrufe, jetzt } = dienst({ eigeneRows: defekt, dateien: { BAS } });
  await d.aktuell(); await d.aktuell(); await d.takt();
  assert.equal(abrufe.length, 1);
  jetzt.t += 9 * 60000; await d.takt();
  assert.equal(abrufe.length, 1);
  jetzt.t += 2 * 60000; await d.takt();
  assert.equal(abrufe.length, 2);
});

test('Ausweichstation, wenn die erste nichts Frisches hat oder ausfaellt', async () => {
  const MOE = csv('MOE', ['28.11.2026 13:10'], { tre200s0: '2.8' });
  const alt = csv('BAS', ['28.11.2026 09:00']); // aelter als 60 min
  const a = dienst({ eigeneRows: defekt, dateien: { BAS: alt, MOE } });
  const r = await a.d.aktuell(); // erster Aufruf wartet auf den Abruf
  assert.equal(r.quelle.station, 'MOE');
  assert.equal(r.werte.outdoortemp, 2.8);
  const b = dienst({ eigeneRows: defekt, dateien: { MOE } }); // BAS: HTTP 503
  assert.equal((await b.d.aktuell()).quelle.station, 'MOE');
});

test('Stationen sind per Env konfigurierbar', async () => {
  const { d, abrufe } = dienst({ eigeneRows: defekt, dateien: { RUE: csv('RUE', ['28.11.2026 13:10']) }, env: { WETTER_ERSATZ_STATION: 'rue', WETTER_ERSATZ_STATION2: 'moe' } });
  assert.equal((await d.aktuell()).quelle.station, 'RUE');
  assert.match(abrufe[0], /\/rue\/ogd-smn_rue_t_now\.csv$/);
});

test('beide Ersatzstationen weg: ausgefallen, kein Ersatz, Zustand nach MQTT', async () => {
  const { d, mqtt } = dienst({ eigeneRows: defekt, dateien: {} });
  const r = await d.takt();
  assert.equal(r.zustand, 'ausgefallen');
  assert.deepEqual(mqtt.map(m => [m.t, m.p]), [['rosenweg/wetter/zustand', 'ausgefallen']]);
  const a = await d.aktuell();
  assert.equal(a.zustand, 'ausgefallen');
  assert.equal(a.werte, null);
});

test('zurueck auf eigene Werte: sofort nach dem naechsten Ingest, Zustand eigen', async () => {
  let rows = defekt;
  const { d, mqtt } = dienst({ eigeneRows: () => rows(), dateien: { BAS } });
  await d.takt();
  assert.equal(d.zustand, 'ersatz');
  mqtt.length = 0;
  rows = () => reihe(90, 0, (m) => ({ outdoortemp: 4 + (m % 7) / 10 }));
  await d.nachIngest({ outdoortemp: 4.4, outdoorhumidity: 80, windspeed: 3 });
  assert.equal(d.zustand, 'eigen');
  const t = Object.fromEntries(mqtt.map(m => [m.t, m.p]));
  assert.equal(t['rosenweg/wetter/zustand'], 'eigen');
  assert.equal(t['rosenweg/wetter/outdoortemp'], '4.4');
  assert.equal(JSON.parse(t['rosenweg/wetter/quelle']).art, 'eigen');
});

test('Ingest einer kaputten Station veroeffentlicht nichts', async () => {
  const { d, mqtt } = dienst({ eigeneRows: defekt, dateien: { BAS } });
  await d.nachIngest({ outdoortemp: 99 });
  assert.equal(mqtt.length, 0);
});

test('NOC: gelb mit Text "Station ausgefallen seit …, Ersatz MeteoSchweiz …"', async () => {
  const { d } = dienst({ eigeneRows: defekt, dateien: { BAS } });
  await d.aktuell(); await new Promise(r => setImmediate(r));
  const s = await d.nocStatus();
  assert.equal(s.ampel, 'gelb');
  assert.match(s.text, /^Station ausgefallen seit \d{2}:\d{2}, Ersatz MeteoSchweiz BAS \(Stand \d{2}:\d{2}\)$/);
  const gruen = dienst({ eigeneRows: () => reihe(90, 0, (m) => ({ outdoortemp: 4 + (m % 7) / 10 })), dateien: {} });
  assert.equal((await gruen.d.nocStatus()).ampel, 'gruen');
  const rot = dienst({ eigeneRows: defekt, dateien: {} });
  assert.equal((await rot.d.nocStatus()).ampel, 'rot');
});

test('Verlauf: Ersatzpunkte mit ersatz:true, eigene Punkte im Ersatzzeitraum fallen weg', async () => {
  const ersatzRows = [30, 20, 10].map(m => ({ ts: min(m), station: 'meteoschweiz-bas', outdoortemp: 3 }));
  const pool = { async query() { return { rows: ersatzRows }; } };
  const d = w.erstelle({ pool, fetchFn: async () => { throw new Error('kein Netz'); }, jetzt: () => JETZT, log: { info() {}, warn() {} } });
  const eigene = [eigen(120), eigen(60), eigen(25), eigen(5)].map(p => ({ ...p, ts: p.ts }));
  const m = await d.verlaufMischen('r9', 24, eigene);
  assert.equal(m.points.filter(p => p.ersatz).length, 3);
  assert.ok(m.points.find(p => p.ersatz).ersatz_station === 'BAS');
  assert.equal(m.points.filter(p => !p.ersatz).length, 2); // 120 und 60 min bleiben
  assert.ok(m.ersatz.von && m.ersatz.bis);
  assert.deepEqual((await d.verlaufMischen('anderes', 24, eigene)).points, eigene);
});

test('abgeschaltet (WETTER_ERSATZ=0): kein Abruf, kein MQTT', async () => {
  const { d, abrufe, mqtt } = dienst({ eigeneRows: defekt, dateien: { BAS }, env: { WETTER_ERSATZ: '0' } });
  await d.takt(); await d.nachIngest({});
  assert.equal(abrufe.length + mqtt.length, 0);
});
