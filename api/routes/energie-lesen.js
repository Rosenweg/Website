// ═══════════════════════════════════════════════════════════════════
// Energie lesen (Proxy zum Energy-Collector) — D-1/F-2, 17.11.2026
// Bisher leitete nginx /api/energy/* direkt und ohne Anmeldung an den
// Collector weiter: Lastprofile je Wohnung, Zaehler-IPs/Seriennummern und
// Bewohner-Adressen waren aus dem Internet lesbar. Jetzt gehen nur noch die
// bewusst offenen Geraete-/Anzeige-Routen (Shelly, LaMetric, Solar-Anzeige)
// direkt zum Collector; alles andere landet hier: Anmeldung pflicht, und
// gelesen wird nur, was der Person zugeordnet ist. Technik/Praesident und
// Inhaber von energie-config:read sehen alles (Konfigurationsseite).
// Eingehaengt unter /api/energy (gleicher Pfad wie bisher -> Seiten muessen
// nur ihr Token mitschicken).
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { stwegSicht } = require('../lib/stweg-sicht');
const { stwegVonHaus } = require('../lib/haeuser');
const { zaehlerTechnikZugang } = require('../lib/zaehler-technik');
const energieTarif = require('../lib/energie-tarif');

// ElCom-Strompreis (Netzbetreiber, je Gemeinde/Jahr/Kategorie) baut lib/elcom.js —
// hier nur anschliessen, nie die LINDAS-Abfrage nachbauen. Fehlt das Modul, gibt es
// fuer Haeuser ohne ZEV eben keinen Preis. Fuer Tests austauschbar (elcomSetzen).
let elcomPreis = null;
try { ({ elcomPreis } = require('../lib/elcom')); } catch { elcomPreis = null; }
function elcomSetzen(fn) { elcomPreis = fn; tarifCache.clear(); }

const router = express.Router();
const COLLECTOR = (process.env.ENERGY_COLLECTOR_URL || 'http://energy-collector:3001').replace(/\/+$/, '');
const ZAEHLER_ID = /^[A-Za-z0-9._-]{1,64}$/;
// Felder, die nur Technik sehen soll (Netzadresse/Geraetedaten des Zaehlers).
const TECHNIK_FELDER = ['host', 'port', 'unit_id', 'serial', 'shelly_type'];

function queryString(req) {
  const i = req.originalUrl.indexOf('?');
  return i >= 0 ? req.originalUrl.slice(i) : '';
}

// Der Collector verlangt fuer die Zuordnungs-Routen (/user/:email/meters,
// /meters/:id/users) den Admin-Schluessel (#21) -> immer mitschicken; er
// verlaesst das interne Netz nicht.
const ADMIN_KEY = process.env.ENERGY_ADMIN_API_KEY || '';
async function collector(pfad, timeoutMs = 20000) {
  const headers = ADMIN_KEY ? { Authorization: `Bearer ${ADMIN_KEY}` } : {};
  return fetch(`${COLLECTOR}/api/energy${pfad}`, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
}

// Antwort des Collectors durchreichen; Fehlertexte (DB-Meldungen) nicht an den Client.
async function durchreichen(res, upstream) {
  if (upstream.status >= 500) return res.status(502).json({ error: 'Energy-Collector-Fehler' });
  // Als Bytes durchreichen: text() wuerde das BOM der CSV-Ausgabe (Excel) entfernen.
  const body = Buffer.from(await upstream.arrayBuffer());
  const cd = upstream.headers.get('content-disposition');
  if (cd) res.setHeader('Content-Disposition', cd);
  res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
}

function fehler(res, err, wo) {
  console.error('[energie-lesen]', wo, err.message);
  res.status(502).json({ error: 'Energy-Collector nicht erreichbar' });
}

// ─── Offene Routen (Geraete/Anzeigen, keine Personendaten) ───────────
// Normalerweise schickt nginx diese direkt zum Collector; hier nur, damit sie
// auch ueber diesen Pfad funktionieren (z. B. ISP-Host ohne eigenen Block).
// Achtung: Der Collector sieht hier die API als Quelle (intern, mit Schluessel)
// und liefert bei surplus* die Liste "consumers" (Live-Leistung je Wohnung)
// mit. Die darf ueber diesen anonymen Weg nie hinaus -> entfernen. Express
// routet ohne Gross/Klein: /api/energy/Surplus landet ebenfalls hier.
const OFFEN = ['/surplus', '/surplus-available', '/lametric', '/shelly', '/solar-live', '/tariffs', '/tariffs/current'];
const OHNE_VERBRAUCHER = new Set(['/surplus', '/surplus-available']);
for (const p of OFFEN) {
  router.get(p, async (req, res) => {
    try {
      if (!OHNE_VERBRAUCHER.has(p)) return await durchreichen(res, await collector(p + queryString(req), 10000));
      if (String(req.query.field || '').toLowerCase() === 'consumers') return res.status(404).json({ error: 'Feld nicht verfuegbar' });
      const r = await collector(p + queryString(req), 10000);
      const typ = r.headers.get('content-type') || '';
      if (!r.ok || !typ.includes('json')) return await durchreichen(res, r);
      const daten = await r.json();
      if (daten && typeof daten === 'object') delete daten.consumers;
      res.status(r.status).json(daten);
    } catch (err) { fehler(res, err, p); }
  });
}

// ─── Tarif je Haus (L3, offen wie /tariffs) ───────────────────────────
// GET /api/energy/tarif?haus=r9&datum=YYYY-MM-DD -> lib/energie-tarif.js
function heuteText() {
  // Kalendertag in der Schweiz, nicht UTC (kurz nach Mitternacht sonst gestern)
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' }).format(new Date());
}
const HAUS_ID = /^[a-z0-9_-]{1,32}$/;
const tarifCache = new Map();
async function tarifFuerHaus(haus, datum = heuteText()) {
  const h = String(haus || '').toLowerCase();
  const key = `${h}|${datum}`;
  const hit = tarifCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.daten;
  const r = await collector(`/tariffs/current?date=${encodeURIComponent(datum)}`, 8000);
  if (!r.ok) throw new Error(`Collector ${r.status}`);
  const tarife = await r.json();
  const daten = await energieTarif.tarifFuerHaus({
    haus: h, datum, tarife: Array.isArray(tarife) ? tarife : [], zaehler: await alleZaehler(), elcomPreis,
  });
  if (tarifCache.size > 500) tarifCache.clear();
  tarifCache.set(key, { daten, bis: Date.now() + 5 * 60000 });
  return daten;
}

router.get('/tarif', async (req, res) => {
  const haus = String(req.query.haus || '').toLowerCase();
  const datum = req.query.datum == null || req.query.datum === '' ? heuteText() : String(req.query.datum);
  if (!HAUS_ID.test(haus)) return res.status(400).json({ error: 'haus fehlt oder ungueltig (z. B. r9)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || isNaN(new Date(datum).getTime())) return res.status(400).json({ error: 'datum: YYYY-MM-DD' });
  try { res.json(await tarifFuerHaus(haus, datum)); } catch (err) { fehler(res, err, 'tarif'); }
});

// ─── Anlagen (L7, offen; mit Anmeldung zusaetzlich "eigen") ──────────
// Quelle ist der Collector (Gruppen mit Produktionszaehler bzw. SmartFox);
// erreicht man ihn nicht, bleibt Haus 9 als Rueckfall.
const ANLAGE_R9 = {
  id: 'r9', name: 'Solaranlage Rosenweg 9', haus: 'r9', hat_boiler: true, hat_ueberschuss: true,
  hat_wohnungen: true, mqtt: 'energy/r9/solar', live: '/api/energy/solar-live?anlage=r9',
};
let anlagenCache = null;
async function anlagenRoh() {
  if (anlagenCache && anlagenCache.bis > Date.now()) return anlagenCache.liste;
  let liste;
  try {
    const r = await collector('/anlagen', 8000);
    if (!r.ok) throw new Error(`Collector ${r.status}`);
    liste = await r.json();
    if (!Array.isArray(liste) || !liste.length) throw new Error('leer');
  } catch (err) {
    if (anlagenCache) return anlagenCache.liste; // lieber die letzte bekannte Liste
    liste = [ANLAGE_R9];
  }
  anlagenCache = { liste, bis: Date.now() + 60000 };
  return liste;
}

/** Anlagen mit STWEG; eigeneZaehler (oder null) bestimmt "eigen". */
async function anlagenListe(eigeneZaehler) {
  const haeuser = new Set((eigeneZaehler || []).map(m => String(m.group_id || '').toLowerCase()));
  return (await anlagenRoh()).map(a => ({
    ...a,
    stweg: zaehlerStweg({ group_id: a.haus }),
    eigen: haeuser.has(String(a.haus).toLowerCase()),
  }));
}

// Anmeldung freiwillig: mit gueltigem Token wie authMiddleware, sonst ohne.
function freiwilligAngemeldet(req) {
  if (!req.headers.authorization) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ersatz = { status() { return ersatz; }, json() { resolve(false); return ersatz; }, end() { resolve(false); return ersatz; }, set() { return ersatz; }, setHeader() {} };
    Promise.resolve(authMiddleware(req, ersatz, () => resolve(true))).catch(() => resolve(false));
  });
}

router.get('/anlagen', async (req, res) => {
  try {
    let eigene = null;
    if (await freiwilligAngemeldet(req)) {
      try { eigene = await zaehlerDerPerson(req.user, true); } catch { eigene = null; }
    }
    res.json(await anlagenListe(eigene));
  } catch (err) { fehler(res, err, 'anlagen'); }
});

// ─── Ab hier nur mit Anmeldung ───────────────────────────────────────
router.use(authMiddleware);

// requirePermission ist eine Middleware -> mit einer Ersatz-Antwort als
// Ja/Nein-Abfrage benutzen (Technik/Praesident laesst sie immer durch).
function hatRecht(req, seite, stufe) {
  return new Promise((resolve) => {
    const ersatz = { status() { return ersatz; }, json() { resolve(false); return ersatz; } };
    requirePermission(seite, stufe)(req, ersatz, () => resolve(true));
  });
}

// Voller Lesezugriff: Technik/Praesident oder Recht energie-config:read.
function vollerZugriff(req) {
  if (req._energieVoll !== undefined) return Promise.resolve(req._energieVoll);
  if (req.user?.isAdmin) { req._energieVoll = true; return Promise.resolve(true); }
  return hatRecht(req, 'energie-config', 'read').then((ok) => { req._energieVoll = ok; return ok; });
}

// ─── STWEG-Sicht (Befund W11) ─────────────────────────────────────────
// Das Seitenrecht „energie-monitor“ (z. B. der Hausverwaltung) gab bisher keine
// Daten frei: gelesen wurden nur persoenlich zugeordnete Zaehler. Jetzt sehen
// Ausschuss und Hausverwaltung mit energie-monitor:read zusaetzlich die Zaehler
// ihrer STWEG(s) (lib/stweg-sicht.js), ohne Technikfelder. Die STWEG eines
// Zaehlers kommt aus seiner Gruppe (group_id): 'rN' = Haus N (lib/haeuser.js),
// 'stwegN' = STWEG N, 'meg' = STWEG 8; sonst unbekannt (dann nur Technik).
function zaehlerStweg(m) {
  const g = String(m?.group_id || '').trim().toLowerCase();
  let t = g.match(/^r(?:w)?(\d+)$/);
  if (t) return stwegVonHaus(Number(t[1]));
  t = g.match(/^stweg(\d+)$/);
  if (t) return Number(t[1]);
  return g === 'meg' ? 8 : null;
}

let alleZaehlerCache = null;
async function alleZaehler() {
  if (alleZaehlerCache && alleZaehlerCache.bis > Date.now()) return alleZaehlerCache.liste;
  const r = await collector('/meters', 8000);
  if (!r.ok) throw new Error(`Collector ${r.status}`);
  const liste = await r.json();
  if (!Array.isArray(liste)) throw new Error('Collector-Antwort ungueltig');
  alleZaehlerCache = { liste, bis: Date.now() + 60000 };
  return liste;
}

// Die Seiten pollen alle paar Sekunden: das Recht je Konto 60 s merken
const monitorRechtCache = new Map();
async function monitorRecht(req) {
  const key = `${String(req.user?.email || '').toLowerCase()}|${(req.user?.groups || []).join(',')}`;
  const hit = monitorRechtCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.ok;
  const ok = await hatRecht(req, 'energie-monitor', 'read');
  if (monitorRechtCache.size > 2000) monitorRechtCache.clear();
  monitorRechtCache.set(key, { ok, bis: Date.now() + 60000 });
  return ok;
}

/**
 * STWEGs, deren Zaehler das Konto als Ausschuss/Verwaltung mit energie-monitor:read
 * sieht (STWEG-Sicht). Das automatische energie-monitor fuer Zaehler-Inhaber in
 * /api/auth/me zaehlt hier NICHT: monitorRecht fragt die Tabelle permissions.
 * Eine Quelle fuer HTTP (stwegZaehler), MQTT (mqttEnergieErlaubt) und /api/auth/me.
 */
async function stwegSichtAktiv(req) {
  const sicht = stwegSicht(req.user?.groups || []);
  if (sicht.alle || !sicht.stwegs.length) return [];
  return (await monitorRecht(req)) ? sicht.stwegs : [];
}

/** Zaehler der STWEG(s), die das Konto als Ausschuss/Verwaltung mit energie-monitor:read sieht. */
async function stwegZaehler(req) {
  if (req._energieStweg !== undefined) return req._energieStweg;
  let liste = [];
  const stwegs = await stwegSichtAktiv(req);
  if (stwegs.length) {
    liste = (await alleZaehler()).filter(m => stwegs.includes(zaehlerStweg(m)));
  }
  req._energieStweg = liste;
  return liste;
}

/** Eigene Zaehler plus STWEG-Zaehler, ohne Doppelte. */
async function sichtbareZaehler(req, mitGruppen = true) {
  const eigene = await zaehlerDerPerson(req.user, mitGruppen);
  const ids = new Set(eigene.map(m => String(m.id)));
  return eigene.concat((await stwegZaehler(req)).filter(m => !ids.has(String(m.id))));
}

// Zaehler der angemeldeten Person — E-Mail und Gruppen kommen aus der Sitzung,
// nie aus der URL. mitGruppen=false: nur persoenlich zugeordnete (meter_users).
// Kurzer Zwischenspeicher, weil die Seiten alle paar Sekunden pollen.
const zaehlerCache = new Map();
async function zaehlerDerPerson(user, mitGruppen = true) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return [];
  const groups = mitGruppen ? (user.groups || []).map(String).filter(g => !g.includes(',')) : [];
  const key = `${email}|${mitGruppen ? groups.join(',') : '-'}`;
  const hit = zaehlerCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.liste;
  const r = await collector(`/user/${encodeURIComponent(email)}/meters?groups=${encodeURIComponent(groups.join(','))}`, 8000);
  if (!r.ok) throw new Error(`Collector ${r.status}`);
  const liste = await r.json();
  if (!Array.isArray(liste)) throw new Error('Collector-Antwort ungueltig');
  if (zaehlerCache.size > 2000) zaehlerCache.clear();
  zaehlerCache.set(key, { liste, bis: Date.now() + 60000 });
  return liste;
}

function ohneTechnik(m) {
  const k = { ...m };
  for (const f of TECHNIK_FELDER) delete k[f];
  return k;
}

async function erlaubteIds(req) {
  if (await vollerZugriff(req)) return null; // null = alle
  return new Set((await sichtbareZaehler(req)).map(m => String(m.id)));
}

// Prueft :meterId gegen die zugeordneten Zaehler (403 statt 404, damit man
// fremde Zaehler-IDs nicht durch Ausprobieren unterscheiden kann).
async function zaehlerErlaubt(req, res, next) {
  const id = String(req.params.meterId || '');
  if (!ZAEHLER_ID.test(id)) return res.status(400).json({ error: 'Ungueltige Zaehler-ID' });
  try {
    const ids = await erlaubteIds(req);
    if (ids && !ids.has(id)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Zaehler' });
    next();
  } catch (err) { fehler(res, err, 'zugriff'); }
}

// Eigene Zaehler (ersetzt /user/:email/meters im Browser). ?gemeinschaft=1
// nimmt die Gruppen-Zaehler (meter_groups) dazu.
router.get('/meine-zaehler', async (req, res) => {
  try {
    // ?stweg=1: dazu die Zaehler der STWEG (Ausschuss/Verwaltung mit energie-monitor)
    const liste = req.query.stweg === '1'
      ? await sichtbareZaehler(req, req.query.gemeinschaft === '1')
      : await zaehlerDerPerson(req.user, req.query.gemeinschaft === '1');
    res.json(liste.map(ohneTechnik));
  } catch (err) { fehler(res, err, 'meine-zaehler'); }
});

// Altpfad: E-Mail in der URL und ?groups= werden ignoriert, es zaehlt die Sitzung.
router.get('/user/:email/meters', async (req, res) => {
  try {
    const liste = await zaehlerDerPerson(req.user, req.query.groups !== undefined);
    res.json(liste.map(ohneTechnik));
  } catch (err) { fehler(res, err, 'user-meters'); }
});

// Zaehlerliste: voll (mit IP/Seriennummer) nur fuer Technik/Konfiguration,
// sonst die eigenen Zaehler ohne Technikfelder.
router.get('/meters', async (req, res) => {
  try {
    if (await vollerZugriff(req)) return durchreichen(res, await collector('/meters'));
    res.json((await sichtbareZaehler(req)).map(ohneTechnik));
  } catch (err) { fehler(res, err, 'meters'); }
});

router.get('/meters/by-location', async (req, res) => {
  try {
    const r = await collector('/meters/by-location' + queryString(req));
    if (!r.ok) return durchreichen(res, r);
    const liste = await r.json();
    const ids = await erlaubteIds(req);
    res.json(ids ? liste.filter(m => ids.has(String(m.id))).map(ohneTechnik) : liste);
  } catch (err) { fehler(res, err, 'by-location'); }
});

// Zuordnungen (E-Mail-Adressen, Gruppen) nur fuer die Konfiguration.
router.get('/meters/:meterId/:art(users|groups)', async (req, res) => {
  const id = String(req.params.meterId || '');
  if (!ZAEHLER_ID.test(id)) return res.status(400).json({ error: 'Ungueltige Zaehler-ID' });
  try {
    if (!(await vollerZugriff(req))) return res.status(403).json({ error: 'Keine Berechtigung' });
    await durchreichen(res, await collector(`/meters/${encodeURIComponent(id)}/${req.params.art}`));
  } catch (err) { fehler(res, err, 'zuordnungen'); }
});

// Live-Werte aller Zaehler: ohne vollen Zugriff nur die eigenen.
router.get('/live', async (req, res) => {
  try {
    const r = await collector('/live', 8000);
    if (!r.ok) return durchreichen(res, r);
    const alle = await r.json();
    const ids = await erlaubteIds(req);
    if (!ids) return res.json(alle);
    const out = {};
    for (const [id, v] of Object.entries(alle || {})) if (ids.has(id)) out[id] = v;
    res.json(out);
  } catch (err) { fehler(res, err, 'live'); }
});

// Haus (group_id) und Kategorie eines Zaehlers aus der Zaehlerliste
async function zaehlerInfo(id) {
  return (await alleZaehler()).find(m => String(m.id) === String(id)) || null;
}
const VERBRAUCHER = new Set(['consumer', 'general']);

// /today und /projection: Kosten mit dem Tarif des Hauses des Zaehlers (L3, eine
// Funktion: tarifFuerHaus). Schlaegt der Tarif fehl, bleibt die Collector-Antwort.
const MIT_TARIF = {
  async today(req, daten) {
    const m = await zaehlerInfo(req.params.meterId);
    if (!m || !daten || typeof daten !== 'object') return daten;
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : heuteText();
    const tarif = await tarifFuerHaus(m.group_id, datum);
    const kwh = daten.consumption_kwh == null ? null : Number(daten.consumption_kwh);
    daten.tarif = tarif;
    daten.kosten_chf = VERBRAUCHER.has(m.category || 'consumer')
      ? energieTarif.kostenChf({ kwh, solar_kwh: daten.solar_kwh ?? null, netz_kwh: daten.netz_kwh ?? null }, tarif)
      : null;
    return daten;
  },
  async projection(req, daten) {
    const m = await zaehlerInfo(req.params.meterId);
    if (!m || !daten || typeof daten !== 'object' || daten.projected_monthly_kwh == null) return daten;
    const tarif = await tarifFuerHaus(m.group_id);
    const monat = Number(daten.projected_monthly_kwh) || 0;
    const anteil = (Number(daten.solar_share_percent) || 0) / 100;
    const monatSolar = monat * anteil;
    const kosten = energieTarif.kostenChf({ kwh: monat, solar_kwh: monatSolar, netz_kwh: monat - monatSolar }, tarif);
    daten.tarif = tarif;
    daten.netz_price = tarif.chf_kwh.bezug;
    daten.solar_price = tarif.chf_kwh.solar;
    daten.projected_monthly_cost = kosten;
    daten.projected_yearly_cost = kosten == null ? null : Math.round(kosten * 12 * 100) / 100;
    return daten;
  },
};

// Routen je Zaehler: nur zugeordnete. reihe = Zeitreihe fuer die App-Diagramme (L9).
for (const p of ['live', 'history', 'hourly', 'daily', 'today', 'rollup', 'consumption', 'projection', 'export', 'reihe']) {
  router.get(`/${p}/:meterId`, zaehlerErlaubt, async (req, res) => {
    try {
      const upstream = await collector(`/${p}/${encodeURIComponent(req.params.meterId)}${queryString(req)}`, 30000);
      if (!MIT_TARIF[p] || !upstream.ok) return await durchreichen(res, upstream);
      let daten = await upstream.json();
      try { daten = await MIT_TARIF[p](req, daten); } catch (e) { console.error('[energie-lesen] tarif', p, e.message); }
      res.json(daten);
    } catch (err) { fehler(res, err, p); }
  });
}

router.get('/compare', async (req, res) => {
  const meterIds = String(req.query.meters || '').split(',').filter(Boolean);
  if (meterIds.length === 0 || meterIds.length > 10 || !meterIds.every(id => ZAEHLER_ID.test(id))) {
    return res.status(400).json({ error: 'meters: 1-10 Zaehler-IDs' });
  }
  try {
    const ids = await erlaubteIds(req);
    if (ids && !meterIds.every(id => ids.has(id))) return res.status(403).json({ error: 'Kein Zugriff auf diesen Zaehler' });
    await durchreichen(res, await collector('/compare' + queryString(req), 30000));
  } catch (err) { fehler(res, err, 'compare'); }
});

// Dashboard und Warnungen sind teuer (viele Abfragen je Zaehler) -> 30 s
// zwischenspeichern; ohne vollen Zugriff auf die eigenen Zaehler gefiltert.
const teuerCache = new Map();
async function teuer(pfad) {
  const hit = teuerCache.get(pfad);
  if (hit && hit.bis > Date.now()) return hit.daten;
  const r = await collector(pfad, 30000);
  if (!r.ok) throw new Error(`Collector ${r.status}`);
  const daten = await r.json();
  teuerCache.set(pfad, { daten, bis: Date.now() + 30000 });
  return daten;
}

router.get('/dashboard', async (req, res) => {
  try {
    const gruppen = await teuer('/dashboard');
    const ids = await erlaubteIds(req);
    if (!ids) return res.json(gruppen);
    // Gruppensumme der Wohnungszaehler aus den EIGENEN Zaehlern neu rechnen —
    // die Summe aller Wohnungen verriete (minus eigener Verbrauch) den Nachbarn.
    res.json((Array.isArray(gruppen) ? gruppen : [])
      .map(g => {
        const meters = (g.meters || []).filter(m => ids.has(String(m.id))).map(ohneTechnik);
        const total = meters.filter(m => m.category === 'consumer').reduce((s, m) => s + (Number(m.today_consumption_kwh) || 0), 0);
        return { ...g, meters, total_consumption_kwh: total };
      })
      .filter(g => g.meters.length > 0));
  } catch (err) { fehler(res, err, 'dashboard'); }
});

// ─── Warnungen fuer die App (L5) ─────────────────────────────────────
// Eigene Zaehler (persoenlich oder Gemeinschaft): offline und hoher Verbrauch.
// Mit vollem Zugriff (Technik/energie-config:read) zusaetzlich "offline" aller
// Zaehler (Entscheid E4 b: Technik bekommt offline). Die STWEG-Sicht allein
// meldet nichts (sonst Hinweise auf fremde Wohnungen).
async function warnungenFuer(req) {
  const alerts = await teuer('/alerts');
  const [eigene, voll] = await Promise.all([zaehlerDerPerson(req.user, true), vollerZugriff(req)]);
  const eigenIds = new Set(eigene.map(m => String(m.id)));
  return (Array.isArray(alerts) ? alerts : [])
    .filter(a => a && a.meter_id && ['offline', 'hoch'].includes(a.art))
    .filter(a => eigenIds.has(String(a.meter_id)) || (voll && a.art === 'offline'))
    .map(a => {
      const eigen = eigenIds.has(String(a.meter_id));
      const name = a.meter_name || a.meter_id;
      const text = a.art === 'offline'
        ? `${eigen ? 'Dein Zähler' : 'Zähler'} „${name}“ ist offline`
        : `Hoher Verbrauch: ${Math.round(Number(a.wert_w) || 0)} W (sonst Ø ${Math.round(Number(a.schnitt_w) || 0)} W)`;
      return {
        zaehler: String(a.meter_id), name, art: a.art, seit: a.seit || null, text, eigen,
        wert_w: a.wert_w ?? null, schnitt_w: a.schnitt_w ?? null,
      };
    });
}

router.get('/warnungen', async (req, res) => {
  try { res.json(await warnungenFuer(req)); } catch (err) { fehler(res, err, 'warnungen'); }
});

// ─── Rechte fuer die App (L4) ────────────────────────────────────────
// Eine Quelle mit den Pruefungen: stwegSichtAktiv (STWEG-Sicht), zaehlerTechnikZugang
// (requireZaehlerTechnik) + vollerZugriff (volle Technik-Sicht), requirePermission
// energie-config (Verwaltung), Zaehler der Person (eigene Anlagen).
async function energieRechte(req) {
  const groups = req.user?.groups || [];
  const [stweg_sicht, voll, schreiben, lesen] = await Promise.all([
    stwegSichtAktiv(req), vollerZugriff(req),
    hatRecht(req, 'energie-config', 'write'), hatRecht(req, 'energie-config', 'read'),
  ]);
  // Collector langsam oder weg: /api/auth/me darf daran weder scheitern noch haengen
  const eigeneAnlagen = (async () => (await anlagenListe(await zaehlerDerPerson(req.user, true))).filter(a => a.eigen).map(a => a.id))();
  eigeneAnlagen.catch(() => {});
  const anlagen_eigen = await Promise.race([eigeneAnlagen, new Promise(r => setTimeout(() => r(null), 2000).unref?.())])
    .catch(() => null) || [];
  return {
    stweg_sicht,
    technik: zaehlerTechnikZugang(groups) ? (voll ? 'voll' : 'eingeschraenkt') : null,
    verwalten: schreiben ? 'write' : (lesen ? 'read' : null),
    anlagen_eigen,
  };
}

// ─── Uebersicht fuer den App-Startschirm (L10) ───────────────────────
const LIVE_FRISCH_MS = 30000; // wie Zaehler-Technik: Poll alle 5 s, > 30 s = offline
const heuteCache = new Map();
async function heuteWerte(ids) {
  if (!ids.length) return {};
  const key = ids.slice().sort().join(',');
  const hit = heuteCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.daten;
  const r = await collector(`/heute?ids=${encodeURIComponent(key)}`, 20000);
  if (!r.ok) throw new Error(`Collector ${r.status}`);
  const daten = await r.json();
  if (heuteCache.size > 500) heuteCache.clear();
  heuteCache.set(key, { daten, bis: Date.now() + 30000 });
  return daten;
}

/** Zaehler mit Rolle: eigen (persoenlich) > gemeinschaft (Gruppe) > stweg > alle (voller Zugriff). */
async function zaehlerMitRolle(req) {
  const [persoenlich, mitGruppen, stweg, voll] = await Promise.all([
    zaehlerDerPerson(req.user, false), zaehlerDerPerson(req.user, true), stwegZaehler(req), vollerZugriff(req),
  ]);
  const liste = new Map();
  const dazu = (ms, rolle) => { for (const m of ms) if (m && m.active !== false && !liste.has(String(m.id))) liste.set(String(m.id), { m, rolle }); };
  dazu(persoenlich, 'eigen');
  dazu(mitGruppen, 'gemeinschaft');
  dazu(stweg, 'stweg');
  if (voll) dazu(await alleZaehler(), 'alle');
  return [...liste.values()];
}

router.get('/uebersicht', async (req, res) => {
  try {
    const eintraege = await zaehlerMitRolle(req);
    const ids = eintraege.map(e => String(e.m.id));
    const [liveR, heute, anlagen, warnungen, rechte] = await Promise.all([
      collector('/live', 8000).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
      heuteWerte(ids).catch((e) => { console.error('[uebersicht] heute:', e.message); return {}; }),
      anlagenListe(eintraege.filter(e => e.rolle === 'eigen' || e.rolle === 'gemeinschaft').map(e => e.m)),
      warnungenFuer(req).catch(() => []),
      energieRechte(req),
    ]);
    const haeuser = [...new Set(eintraege.map(e => String(e.m.group_id || '').toLowerCase()).filter(h => HAUS_ID.test(h)))];
    const tarife = {};
    await Promise.all(haeuser.map(async h => { try { tarife[h] = await tarifFuerHaus(h); } catch { tarife[h] = null; } }));
    const jetzt = Date.now();
    const zaehler = eintraege.map(({ m, rolle }) => {
      const id = String(m.id);
      const l = liveR && liveR[id];
      const ts = l?.ts ? new Date(l.ts) : null;
      const h = heute[id] || null;
      const haus = String(m.group_id || '').toLowerCase() || null;
      const kategorie = m.category || 'consumer';
      const kwh = h?.kwh ?? null;
      return {
        id, name: m.name, kategorie, haus, stweg: zaehlerStweg(m), rolle,
        online: !!(ts && jetzt - ts.getTime() < LIVE_FRISCH_MS),
        live: l ? { power_w: l.power_w ?? null, ts: ts ? ts.toISOString() : null } : null,
        heute: {
          kwh,
          solar_kwh: h?.solar_kwh ?? null,
          netz_kwh: h?.netz_kwh ?? null,
          kosten_chf: VERBRAUCHER.has(kategorie) && haus && tarife[haus]
            ? energieTarif.kostenChf({ kwh, solar_kwh: h?.solar_kwh ?? null, netz_kwh: h?.netz_kwh ?? null }, tarife[haus])
            : null,
        },
        mqtt: h?.mqtt || mqttThemaVon(id),
      };
    });
    res.json({ zaehler, anlagen, warnungen, tarife, rechte });
  } catch (err) { fehler(res, err, 'uebersicht'); }
});

// Rueckfall, falls /heute fehlt: gleiche Regel wie der Collector-Publisher
// (energy-collector/energie-logik.js mqttThema). Quelle ist der Collector (/heute.mqtt).
function mqttThemaVon(id) {
  const t = String(id).split('-');
  const haus = t.shift();
  return `energy/${haus}/${t.length ? t.join('-') : haus}`;
}

router.get('/alerts', async (req, res) => {
  try {
    const alerts = await teuer('/alerts');
    const ids = await erlaubteIds(req);
    res.json(ids ? (Array.isArray(alerts) ? alerts : []).filter(a => ids.has(String(a.meter_id))) : alerts);
  } catch (err) { fehler(res, err, 'alerts'); }
});

// Alles andere (auch Schreibzugriffe -> /api/energie-admin) gibt es hier nicht.
router.use((req, res) => res.status(404).json({ error: 'Unbekannter Energie-Endpunkt' }));

// ─── MQTT-Lesen (L1/L2): dieselbe Sicht wie HTTP ─────────────────────
// Aufruf aus server.js /api/mqtt/aclcheck (Technik/Praesident sind dort schon
// Superuser). person = { email, groups } aus mqtt_tokens. Themen:
//   energy/collector/status                  alle Angemeldeten
//   energy/<anlage>/solar[/…]                alle Angemeldeten (Anlagen aus /anlagen)
//   energy/<haus>/<bereich>[/…]              Zaehler <haus>-<bereich> sichtbar (HTTP-Regel)
//   energy/<haus>/ueberschuss/<wohnung>[/…]  Zaehler <haus>-<wohnung> sichtbar
//   energy/alerts/<zaehler>                  Zaehler sichtbar
// Voller Zugriff (energie-config:read) liest alles unter energy/. Wildcards in
// den Zaehler-Ebenen nur mit vollem Zugriff. Ergebnis je Konto 60 s merken.
const mqttSichtCache = new Map();
async function mqttSicht(person) {
  const email = String(person?.email || '').trim().toLowerCase();
  const groups = (person?.groups || []).map(String);
  const key = `${email}|${groups.join(',')}`;
  const hit = mqttSichtCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.ids;
  const req = { user: { email, groups, isAdmin: false }, headers: {} };
  const ids = await erlaubteIds(req); // null = alle
  if (mqttSichtCache.size > 2000) mqttSichtCache.clear();
  mqttSichtCache.set(key, { ids, bis: Date.now() + 60000 });
  return ids;
}

const WILDCARD = (s) => s === '+' || s === '#' || s === undefined || s === '';
async function mqttEnergieErlaubt(person, topic) {
  const t = String(topic || '');
  const teile = t.split('/');
  if (teile[0] !== 'energy' || teile.length < 2) return false;
  if (t === 'energy/collector/status') return true;
  if (teile.length >= 3 && teile[2] === 'solar' && !WILDCARD(teile[1])) {
    if ((await anlagenRoh()).some(a => String(a.id) === teile[1])) return true;
  }
  const ids = await mqttSicht(person);
  if (ids === null) return true;
  let kandidaten;
  if (teile[1] === 'alerts') kandidaten = teile.length === 3 ? [teile[2]] : [];
  else if (teile[2] === 'ueberschuss') kandidaten = teile.length >= 4 && !WILDCARD(teile[3]) ? [`${teile[1]}-${teile[3]}`] : [];
  else if (teile.length >= 3) kandidaten = [`${teile[1]}-${teile[2]}`].concat(teile[1] === teile[2] ? [teile[1]] : []);
  else kandidaten = [];
  if (kandidaten.some(k => k.split('-').some(WILDCARD) || /[+#]/.test(k))) return false;
  return kandidaten.some(k => ids.has(k));
}

module.exports = router;
module.exports.zaehlerStweg = zaehlerStweg; // fuer api/test
module.exports.energieRechte = energieRechte;
module.exports.vollerZugriff = vollerZugriff;
module.exports.mqttEnergieErlaubt = mqttEnergieErlaubt;
module.exports.tarifFuerHaus = tarifFuerHaus;
module.exports.elcomSetzen = elcomSetzen;
module.exports.mqttThemaVon = mqttThemaVon;
