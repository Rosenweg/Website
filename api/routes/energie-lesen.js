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

/** Zaehler der STWEG(s), die das Konto als Ausschuss/Verwaltung mit energie-monitor:read sieht. */
async function stwegZaehler(req) {
  if (req._energieStweg !== undefined) return req._energieStweg;
  let liste = [];
  const sicht = stwegSicht(req.user?.groups || []);
  if (!sicht.alle && sicht.stwegs.length && await monitorRecht(req)) {
    liste = (await alleZaehler()).filter(m => sicht.stwegs.includes(zaehlerStweg(m)));
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

// Routen je Zaehler: nur zugeordnete.
for (const p of ['live', 'history', 'hourly', 'daily', 'today', 'rollup', 'consumption', 'projection', 'export']) {
  router.get(`/${p}/:meterId`, zaehlerErlaubt, async (req, res) => {
    try {
      await durchreichen(res, await collector(`/${p}/${encodeURIComponent(req.params.meterId)}${queryString(req)}`, 30000));
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

router.get('/alerts', async (req, res) => {
  try {
    const alerts = await teuer('/alerts');
    const ids = await erlaubteIds(req);
    res.json(ids ? (Array.isArray(alerts) ? alerts : []).filter(a => ids.has(String(a.meter_id))) : alerts);
  } catch (err) { fehler(res, err, 'alerts'); }
});

// Alles andere (auch Schreibzugriffe -> /api/energie-admin) gibt es hier nicht.
router.use((req, res) => res.status(404).json({ error: 'Unbekannter Energie-Endpunkt' }));

module.exports = router;
module.exports.zaehlerStweg = zaehlerStweg; // fuer api/test
