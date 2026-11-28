// Ersatzwerte fuer die Wetterstation Rosenweg 9: faellt die eigene Station aus
// (nichts geliefert, unplausibel, eingefroren), liefert die API die 10-Minuten-
// Werte einer MeteoSchweiz-Bodenstation (Open Government Data, SwissMetNet,
// Sammlung ch.meteoschweiz.ogd-smn). Schluesselloser, offizieller Endpunkt:
//   https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/<abk>/ogd-smn_<abk>_t_now.csv
// Quelle: MeteoSchweiz (Namensnennung nach den OGD-Nutzungsbedingungen).
//
// Aufbau: reine Funktionen (CSV, Zuordnung, Bewertung der eigenen Station) und
// eine Fabrik `erstelle(...)` mit Datenbank, Abruf und MQTT-Ausgabe als
// Abhaengigkeiten — damit die Tests ohne Netz und ohne Broker laufen.
'use strict';

const FELDER = ['outdoortemp', 'outdoorhumidity', 'windspeed', 'windgustspeed', 'winddir',
  'pressureabs', 'pressurerel', 'solarradiation', 'uvi', 'rain'];
// Spalten von wetter_history (pressurerel gibt es nur live, nicht im Verlauf)
const VERLAUF_FELDER = ['outdoortemp', 'outdoorhumidity', 'windspeed', 'winddir', 'pressureabs',
  'solarradiation', 'rain', 'uvi', 'windgustspeed'];

// Die eigene Station liefert Sonne in Lux; die Apps rechnen mit 126.7 in W/m².
const LUX_JE_WM2 = 126.7;

// Bekannte Stationen rund um Kaiseraugst (Abstand Luftlinie, Stationsmetadaten OGD)
const STATIONEN = {
  BAS: { name: 'Basel / Binningen', abstand_km: 10.3 },
  MOE: { name: 'Möhlin', abstand_km: 12.4 },
  STC: { name: 'St. Chrischona', abstand_km: 4.3 },
  RUE: { name: 'Rünenberg', abstand_km: 16.8 },
};

const MIN = 60000;

function konfig(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  const abk = (v, d) => String(v || d).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  return {
    an: env.WETTER_ERSATZ !== '0',
    station: String(env.WETTER_STATION || 'r9').slice(0, 16),
    ausfallMin: n('WETTER_AUSFALL_MIN', 20),
    eingefrorenMin: n('WETTER_EINGEFROREN_MIN', 60),
    ersatz1: abk(env.WETTER_ERSATZ_STATION, 'BAS'),
    ersatz2: abk(env.WETTER_ERSATZ_STATION2, 'MOE'),
    abstandMin: n('WETTER_ERSATZ_ABSTAND_MIN', 10),
    maxAlterMin: n('WETTER_ERSATZ_MAXALTER_MIN', 60),
    abrufTimeoutMs: n('WETTER_ERSATZ_TIMEOUT_MS', 8000),
    basis: String(env.WETTER_OGD_URL || 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn').replace(/\/+$/, ''),
    mqttPrefix: String(env.WETTER_MQTT_PREFIX || 'rosenweg/wetter').replace(/\/+$/, ''),
  };
}

// ─── MeteoSchweiz: CSV lesen und auf unsere Felder abbilden ──────────────

function zahl(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "28.11.2026 13:00" (UTC) -> ms; sonst null. */
function zeitLesen(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
}

/** CSV (Semikolon, Kopfzeile) -> Zeilen als { spalte: text }. */
function csvLesen(text) {
  const zeilen = String(text || '').split(/\r?\n/).filter(z => z.trim() !== '');
  if (zeilen.length < 2) return [];
  const kopf = zeilen[0].replace(/^﻿/, '').split(';').map(s => s.trim());
  return zeilen.slice(1).map(z => {
    const t = z.split(';');
    const o = {};
    kopf.forEach((k, i) => { o[k] = t[i]; });
    return o;
  });
}

function imBereich(v, lo, hi) { return v != null && v >= lo && v <= hi ? v : null; }

/**
 * Eine OGD-Zeile -> Werte in der Form der eigenen Station.
 *  tre200s0 Temperatur 2 m (°C)            -> outdoortemp
 *  ure200s0 relative Feuchte (%)           -> outdoorhumidity
 *  fu3010z0 Wind, 10-min-Mittel (km/h)     -> windspeed
 *  fu3010z1 Boeenspitze, Sekundenboe (km/h)-> windgustspeed
 *  dkl010z0 Windrichtung (°)               -> winddir
 *  prestas0 Luftdruck QFE (hPa)            -> pressureabs   (Stationsdruck, nicht auf Kaiseraugst umgerechnet)
 *  pp0qffs0 Luftdruck QFF (hPa)            -> pressurerel   (auf Meereshoehe)
 *  gre000z0 Globalstrahlung (W/m²)         -> solarradiation (in Lux wie die eigene Station: x 126.7)
 *  rre150z0 Niederschlag 10-min-Summe (mm) -> rain (mm/h: x 6)
 *  sre000z0 Sonnenscheindauer 10 min (min) -> sonnenschein_min (nur API, kein MQTT)
 * Ein UV-Index wird nicht gemessen -> null.
 */
function abbilden(zeile) {
  const ts = zeitLesen(zeile.reference_timestamp);
  if (ts == null) return null;
  const glob = imBereich(zahl(zeile.gre000z0), 0, 1500);
  const regen = imBereich(zahl(zeile.rre150z0), 0, 200);
  const werte = {
    outdoortemp: imBereich(zahl(zeile.tre200s0), -40, 50),
    outdoorhumidity: imBereich(zahl(zeile.ure200s0), 0, 100),
    windspeed: imBereich(zahl(zeile.fu3010z0), 0, 300),
    windgustspeed: imBereich(zahl(zeile.fu3010z1), 0, 400),
    winddir: imBereich(zahl(zeile.dkl010z0), 0, 360),
    pressureabs: imBereich(zahl(zeile.prestas0), 500, 1100),
    pressurerel: imBereich(zahl(zeile.pp0qffs0), 850, 1100),
    solarradiation: glob == null ? null : Math.round(glob * LUX_JE_WM2),
    uvi: null,
    rain: regen == null ? null : Math.round(regen * 6 * 10) / 10,
  };
  return { ts, werte, sonnenschein_min: imBereich(zahl(zeile.sre000z0), 0, 10) };
}

/** Gesamte Datei -> abgebildete Zeilen, aelteste zuerst, nur mit Temperatur. */
function ogdLesen(text) {
  return csvLesen(text).map(abbilden).filter(r => r && r.werte.outdoortemp != null).sort((a, b) => a.ts - b.ts);
}

// ─── Bewertung der eigenen Station ───────────────────────────────────────

function ms(ts) { return ts instanceof Date ? ts.getTime() : Date.parse(ts); }

/** Ist ein Messwert physikalisch unmoeglich? (nur die vorhandenen werden geprueft) */
function unplausibel(r) {
  const t = r.outdoortemp, h = r.outdoorhumidity, w = r.windspeed, p = r.pressureabs;
  if (t != null && (t < -40 || t > 50)) return true;
  if (h != null && (h < 0 || h > 100)) return true;
  if (w != null && (w < 0 || w > 300)) return true;
  if (p != null && (p < 500 || p > 1100)) return true;
  return false;
}

/**
 * rows: Zeilen der eigenen Station, aelteste zuerst ({ ts, outdoortemp, ... }).
 * Gibt { ok, grund, seit } zurueck. grund: keine-lieferung | keine-werte |
 * unplausibel | eingefroren. seit (ms) = Beginn des Ausfalls, soweit bekannt.
 */
function bewerteEigene(rows, jetzt, cfg) {
  const last = rows[rows.length - 1];
  if (!last) return { ok: false, grund: 'keine-lieferung', seit: null };
  const lastMs = ms(last.ts);
  if (jetzt - lastMs > cfg.ausfallMin * MIN) return { ok: false, grund: 'keine-lieferung', seit: lastMs };

  const kaputt = (r) => r.outdoortemp == null || unplausibel(r);
  if (kaputt(last)) {
    let i = rows.length - 1;
    while (i > 0 && kaputt(rows[i - 1])) i--;
    return { ok: false, grund: last.outdoortemp == null ? 'keine-werte' : 'unplausibel', seit: ms(rows[i].ts) };
  }

  // eingefroren: ueber die letzte Stunde weder Temperatur noch Feuchte veraendert
  const von = jetzt - cfg.eingefrorenMin * MIN;
  const fenster = rows.filter(r => ms(r.ts) >= von);
  if (fenster.length >= 5 && ms(fenster[0].ts) - von <= 5 * MIN
      && fenster.every(r => r.outdoortemp === last.outdoortemp && r.outdoorhumidity === last.outdoorhumidity)) {
    let i = rows.length - 1;
    while (i > 0 && rows[i - 1].outdoortemp === last.outdoortemp && rows[i - 1].outdoorhumidity === last.outdoorhumidity) i--;
    return { ok: false, grund: 'eingefroren', seit: ms(rows[i].ts) };
  }
  return { ok: true, grund: null, seit: null };
}

function hhmm(msWert) {
  return new Date(msWert).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });
}

/** Text fuer NOC und Hinweise: "Station ausgefallen seit …, Ersatz MeteoSchweiz …". */
function nocText(zustand, seit, ersatz) {
  if (zustand === 'eigen') return 'Station liefert';
  const seitText = seit ? `seit ${hhmm(seit)}` : 'seit unbekannt';
  if (zustand === 'ersatz' && ersatz) {
    return `Station ausgefallen ${seitText}, Ersatz MeteoSchweiz ${ersatz.station} (Stand ${hhmm(ersatz.stand)})`;
  }
  return `Station ausgefallen ${seitText}, kein Ersatz verfügbar`;
}

// ─── Dienst ──────────────────────────────────────────────────────────────

function erstelle({ pool, fetchFn = globalThis.fetch, publish = () => {}, jetzt = Date.now, env = process.env, log = console }) {
  const cfg = konfig(env);
  const cache = new Map();            // abk -> { t, rows, fehler, laeuft }
  let lageCache = null;               // { t, lage }
  let zustand = 'eigen';              // zuletzt gemeldeter Zustand
  let letzterSeit = null;
  let letzteAusgabe = { json: '', t: 0 };

  const verlaufStation = (abk) => 'meteoschweiz-' + abk.toLowerCase();

  async function eigeneZeilen() {
    const von = new Date(jetzt() - 6 * 60 * MIN);
    const r = await pool.query(
      `SELECT ts, ${VERLAUF_FELDER.join(', ')} FROM wetter_history WHERE station = $1 AND ts > $2 ORDER BY ts ASC`,
      [cfg.station, von]);
    return r.rows;
  }

  /** Lage der eigenen Station (20 s zwischengespeichert, damit /aktuell die DB schont). */
  async function eigeneLage(neu = false) {
    if (!neu && lageCache && jetzt() - lageCache.t < 20000) return lageCache.lage;
    const rows = await eigeneZeilen();
    const lage = { ...bewerteEigene(rows, jetzt(), cfg), letzte: rows[rows.length - 1] || null };
    lageCache = { t: jetzt(), lage };
    return lage;
  }

  // ── MeteoSchweiz abrufen: hoechstens alle abstandMin Minuten je Station ──
  async function abrufen(abk) {
    const url = `${cfg.basis}/${abk.toLowerCase()}/ogd-smn_${abk.toLowerCase()}_t_now.csv`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.abrufTimeoutMs);
    try {
      const r = await fetchFn(url, { signal: ac.signal, headers: { 'User-Agent': 'rosenweg-api (Wetter-Ersatz)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return ogdLesen(await r.text());
    } finally { clearTimeout(timer); }
  }

  /** Zeilen einer Station aus dem Zwischenspeicher; frischer Abruf nur, wenn faellig. */
  function stationZeilen(abk, warten) {
    let e = cache.get(abk);
    const faellig = !e || (jetzt() - e.t >= cfg.abstandMin * MIN && !e.laeuft);
    if (faellig) {
      e = { t: jetzt(), rows: e ? e.rows : null, fehler: null, laeuft: null };
      cache.set(abk, e);
      e.laeuft = abrufen(abk)
        .then(rows => { e.rows = rows; })
        .catch(err => { e.fehler = err.message; log.warn?.(`[wetter-ersatz] ${abk}: ${err.message}`); })
        .finally(() => { e.laeuft = null; });
    }
    if (warten && !e.rows && e.laeuft) return e.laeuft.then(() => e.rows);
    return Promise.resolve(e.rows);
  }

  /** Beste Ersatzstation: erste mit frischem Wert (Haupt-, dann Ausweichstation). */
  async function ersatzLesen(warten = true) {
    const abks = [...new Set([cfg.ersatz1, cfg.ersatz2].filter(Boolean))];
    for (const abk of abks) {
      const rows = await stationZeilen(abk, warten);
      const last = rows && rows[rows.length - 1];
      if (!last || jetzt() - last.ts > cfg.maxAlterMin * MIN) continue;
      const info = STATIONEN[abk] || { name: abk, abstand_km: null };
      return { station: abk, name: info.name, abstand_km: info.abstand_km, stand: last.ts,
        werte: last.werte, sonnenschein_min: last.sonnenschein_min, rows };
    }
    return null;
  }

  function quelleEigen(lage) {
    return { art: 'eigen', station: cfg.station, stand: lage.letzte ? new Date(ms(lage.letzte.ts)).toISOString() : null };
  }
  function quelleErsatz(e) {
    return { art: 'meteoschweiz', station: e.station, name: e.name, abstand_km: e.abstand_km,
      stand: new Date(e.stand).toISOString(), hinweis: 'Quelle: MeteoSchweiz (Open Government Data, SwissMetNet)' };
  }

  /** Eigene Werte der letzten Zeile in der Form des Live-Topics (Lux, mm/h …). */
  function eigeneWerte(letzte) {
    const w = {};
    for (const f of FELDER) w[f] = letzte && letzte[f] != null ? Number(letzte[f]) : null;
    return w;
  }

  // ── MQTT: rosenweg/wetter/<feld>, /quelle, /zustand (alle retained) ──
  function ausgeben(werte, quelle, neuerZustand, erzwingen) {
    const json = JSON.stringify([werte, quelle.art, quelle.station, neuerZustand]);
    if (!erzwingen && json === letzteAusgabe.json && jetzt() - letzteAusgabe.t < 10 * MIN) return false;
    const opt = { retain: true, qos: 0 };
    for (const f of FELDER) publish(`${cfg.mqttPrefix}/${f}`, werte[f] == null ? '' : String(werte[f]), opt);
    publish(`${cfg.mqttPrefix}/quelle`, JSON.stringify({ ...quelle, zustand: neuerZustand }), opt);
    publish(`${cfg.mqttPrefix}/zustand`, neuerZustand, opt);
    letzteAusgabe = { json, t: jetzt() };
    return true;
  }

  async function ersatzSpeichern(e, seit) {
    const st = verlaufStation(e.station);
    const r = await pool.query('SELECT MAX(ts) AS m FROM wetter_history WHERE station = $1', [st]);
    const max = r.rows[0]?.m ? ms(r.rows[0].m) : 0;
    const ab = Math.max(max, (seit || 0) - 1, jetzt() - 6 * 60 * MIN);
    let n = 0;
    for (const z of e.rows) {
      if (z.ts <= ab) continue;
      const w = z.werte;
      await pool.query(
        `INSERT INTO wetter_history (ts, station, outdoortemp, outdoorhumidity, windspeed, winddir, pressureabs, solarradiation, rain, uvi, windgustspeed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [new Date(z.ts), st, w.outdoortemp, w.outdoorhumidity, w.windspeed, w.winddir, w.pressureabs, w.solarradiation, w.rain, w.uvi, w.windgustspeed]);
      n++;
    }
    return n;
  }

  /**
   * Takt (alle 10 Minuten): eigene Station bewerten. Faellt sie aus, Ersatz holen,
   * im Verlauf speichern und nach MQTT geben; sonst nur den Zustand nachfuehren.
   */
  async function takt() {
    if (!cfg.an) return { zustand: 'eigen' };
    const lage = await eigeneLage(true);
    if (lage.ok) {
      wechsel('eigen', null);
      if (lage.letzte) ausgeben(eigeneWerte(lage.letzte), quelleEigen(lage), 'eigen', false);
      return { zustand: 'eigen' };
    }
    const e = await ersatzLesen(true);
    if (!e) {
      wechsel('ausgefallen', lage.seit);
      publish(`${cfg.mqttPrefix}/zustand`, 'ausgefallen', { retain: true, qos: 0 });
      return { zustand: 'ausgefallen', grund: lage.grund };
    }
    wechsel('ersatz', lage.seit);
    const gespeichert = await ersatzSpeichern(e, lage.seit);
    ausgeben(e.werte, quelleErsatz(e), 'ersatz', true);
    return { zustand: 'ersatz', grund: lage.grund, station: e.station, gespeichert };
  }

  function wechsel(neu, seit) {
    if (neu !== zustand) log.info?.(`[wetter-ersatz] Zustand ${zustand} -> ${neu}`);
    zustand = neu;
    letzterSeit = seit;
  }

  /** Nach jedem Ingest der eigenen Station: wieder gesund -> sofort ihre Werte. */
  async function nachIngest(werte) {
    if (!cfg.an) return;
    const lage = await eigeneLage(true);
    if (!lage.ok) return;
    const vorher = zustand;
    wechsel('eigen', null);
    const w = {};
    for (const f of FELDER) w[f] = werte && werte[f] != null ? Number(werte[f]) : null;
    ausgeben(w, quelleEigen(lage), 'eigen', vorher !== 'eigen');
  }

  /** GET /api/wetter/:station/aktuell */
  async function aktuell() {
    if (!cfg.an) return { station: cfg.station, zustand: 'eigen', ersatz_aus: true };
    const lage = await eigeneLage();
    if (lage.ok) {
      return { station: cfg.station, zustand: 'eigen', ts: new Date(ms(lage.letzte.ts)).toISOString(),
        werte: eigeneWerte(lage.letzte), quelle: quelleEigen(lage) };
    }
    const e = await ersatzLesen(true);
    const ausfall = { seit: lage.seit ? new Date(lage.seit).toISOString() : null, grund: lage.grund };
    if (!e) return { station: cfg.station, zustand: 'ausgefallen', werte: null, quelle: null, ausfall };
    return { station: cfg.station, zustand: 'ersatz', ts: new Date(e.stand).toISOString(),
      werte: { ...e.werte, sonnenschein_min: e.sonnenschein_min }, quelle: quelleErsatz(e), ausfall };
  }

  /**
   * Verlauf: eigene Punkte ausser dort, wo Ersatz lief, dazu die Ersatzpunkte
   * (mit ersatz:true und der MeteoSchweiz-Station). Aufbau der Punkte unveraendert.
   */
  async function verlaufMischen(st, hours, eigene) {
    if (!cfg.an || st !== cfg.station) return { points: eigene, ersatz: null };
    const r = await pool.query(
      `SELECT ts, station, ${VERLAUF_FELDER.join(', ')} FROM wetter_history
        WHERE station LIKE 'meteoschweiz-%' AND ts > NOW() - ($1 * INTERVAL '1 hour') ORDER BY ts ASC`,
      [hours]);
    if (!r.rows.length) return { points: eigene, ersatz: null };
    // Ersatz-Abschnitte: Punkte im Abstand bis 25 Minuten gehoeren zusammen (10-min-Takt)
    const abschnitte = [];
    for (const z of r.rows) {
      const t = ms(z.ts), a = abschnitte[abschnitte.length - 1];
      if (a && t - a.bis <= 25 * MIN) a.bis = t; else abschnitte.push({ von: t, bis: t });
    }
    const ersatzPunkte = r.rows.map(z => ({ ...z, station: undefined, ersatz: true, ersatz_station: z.station.slice('meteoschweiz-'.length).toUpperCase() }));
    const eigeneRest = eigene.filter(p => { const t = ms(p.ts); return !abschnitte.some(a => t >= a.von - 10 * MIN && t <= a.bis + 10 * MIN); });
    const points = [...eigeneRest, ...ersatzPunkte].sort((x, y) => ms(x.ts) - ms(y.ts));
    return { points, ersatz: { von: new Date(abschnitte[0].von).toISOString(), bis: new Date(abschnitte[abschnitte.length - 1].bis).toISOString() } };
  }

  /** NOC: Zustand fuer die Kachel (gruen / gelb / rot). */
  async function nocStatus() {
    if (!cfg.an) return { zustand: 'eigen', ampel: 'gruen', text: 'Ersatzwerte abgeschaltet' };
    const lage = await eigeneLage();
    if (lage.ok) return { zustand: 'eigen', ampel: 'gruen', text: nocText('eigen'), station: cfg.station };
    const e = await ersatzLesen(true);
    const ersatz = e ? { station: e.station, stand: e.stand } : null;
    const z = e ? 'ersatz' : 'ausgefallen';
    return { zustand: z, ampel: e ? 'gelb' : 'rot', text: nocText(z, lage.seit, ersatz), station: cfg.station,
      grund: lage.grund, seit: lage.seit ? new Date(lage.seit).toISOString() : null,
      ersatz: e ? { station: e.station, name: e.name, stand: new Date(e.stand).toISOString() } : null };
  }

  return { cfg, takt, nachIngest, aktuell, verlaufMischen, nocStatus, eigeneLage, ersatzLesen,
    get zustand() { return zustand; }, get seit() { return letzterSeit; } };
}

module.exports = { erstelle, konfig, csvLesen, zeitLesen, abbilden, ogdLesen, bewerteEigene, nocText,
  FELDER, STATIONEN, LUX_JE_WM2 };
