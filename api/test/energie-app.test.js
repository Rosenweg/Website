// node --test api/test/energie-app.test.js — Server-Seite der App „Rosenweg Energie“
// (Lücken L1–L11 aus der Klärung vom 28.11.2026): MQTT-Sicht wie HTTP, Solar
// offen, Token widerrufen, Tarife je Haus/ElCom, Rechte in /api/auth/me,
// Anlagen, Warndienst, Zeitreihe, Übersicht. Ohne Datenbank und ohne Collector:
// express, Anmeldung und fetch werden durch Attrappen ersetzt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const WURZEL = path.join(__dirname, '..', '..');
const logik = require('../../energy-collector/energie-logik');
const energieTarif = require('../lib/energie-tarif');
const { zaehlerTechnikZugang } = require('../lib/zaehler-technik');

// ─── Attrappen fuer routes/energie-lesen.js ──────────────────────────
const routen = [];
const RECHTE = {
  // Gruppe -> { seite: stufe } (Tabelle permissions)
  'stweg3-ausschuss': { 'energie-monitor': 'read' },
  'stweg3-verwaltung': { 'energie-monitor': 'read' },
  konfig: { 'energie-config': 'read' },
  konfigschreib: { 'energie-config': 'write' },
};
const STUFE = { read: 1, write: 2 };
const KONTEN = {
  'Bearer anna': { email: 'anna@example.org', groups: ['r9-bewohner'] },
};
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'express') {
    const r = () => {};
    r.Router = () => ({
      get(p, ...h) { routen.push({ p, h }); },
      use() {},
    });
    return r;
  }
  if (req.endsWith('middleware/auth')) {
    return {
      authMiddleware(req, res, next) {
        const k = KONTEN[req.headers?.authorization];
        if (!k) return res.status(401).json({ error: 'Nicht authentifiziert' });
        req.user = { ...k };
        return next();
      },
      requirePermission(seite, stufe) {
        return (req, res, next) => {
          const g = (req.user?.groups || []).map(x => String(x).toLowerCase());
          if (g.includes('technik') || g.includes('praesident')) return next();
          const ok = g.some(x => STUFE[(RECHTE[x] || {})[seite]] >= STUFE[stufe]);
          return ok ? next() : res.status(403).json({ error: 'Keine Berechtigung' });
        };
      },
    };
  }
  return orig.call(this, req, ...rest);
};
const energieLesen = require('../routes/energie-lesen');
Module._load = orig;

// Collector-Daten
const ZAEHLER = [
  { id: 'r9-eg1', name: 'EG links', group_id: 'r9', category: 'consumer', active: true },
  { id: 'r9-eg2', name: 'EG rechts', group_id: 'r9', category: 'consumer', active: true },
  { id: 'r9-allgemein', name: 'Allgemein', group_id: 'r9', category: 'general', active: true },
  { id: 'r9-haupt', name: 'Netz', group_id: 'r9', category: 'grid', active: true },
  { id: 'r9-produktion', name: 'PV', group_id: 'r9', category: 'production', active: true },
  { id: 'r13-haupt', name: 'Haus 13', group_id: 'r13', category: 'grid', active: true },
  { id: 'r13-1og1', name: 'R13 1OG', group_id: 'r13', category: 'consumer', active: true },
];
const ZUORDNUNG = {
  // E-Mail -> { persoenlich: [...], gruppe: { gruppe: [...] } }
  'anna@example.org': { persoenlich: ['r9-eg1'], gruppe: { 'r9-bewohner': ['r9-allgemein'] } },
  'ausschuss@example.org': { persoenlich: [], gruppe: {} },
  'eigner@example.org': { persoenlich: [], gruppe: {} },
  'konfig@example.org': { persoenlich: [], gruppe: {} },
};
const TARIFE = [
  { id: 1, name: 'Netztarif', price_per_kwh: '0.2700', valid_from: '2026-01-01', active: true, art: 'bezug', group_id: null },
  { id: 2, name: 'Solartarif', price_per_kwh: '0.2000', valid_from: '2026-01-01', active: true, art: 'solar', group_id: null },
];
const JETZT = new Date();
const ALERTS = [
  { meter_id: 'r9-eg1', meter_name: 'EG links', art: 'hoch', type: 'high_consumption', seit: '2026-11-28T10:00:00.000Z', wert_w: 4200, schnitt_w: 900 },
  { meter_id: 'r9-eg2', meter_name: 'EG rechts', art: 'hoch', type: 'high_consumption', seit: '2026-11-28T10:00:00.000Z', wert_w: 3000, schnitt_w: 500 },
  { meter_id: 'r9-eg2', meter_name: 'EG rechts', art: 'offline', type: 'offline', seit: '2026-11-28T09:00:00.000Z', wert_w: null, schnitt_w: null },
];
const aufrufe = [];
global.fetch = async (url) => {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/energy/, '');
  aufrufe.push(p + u.search);
  const json = (d, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => d, arrayBuffer: async () => Buffer.from(JSON.stringify(d)) });
  if (p === '/meters') return json(ZAEHLER);
  if (p === '/tariffs/current') return json(TARIFE);
  if (p === '/alerts') return json(ALERTS);
  if (p === '/anlagen') return json(logik.anlagenAusZaehlern(ZAEHLER));
  if (p === '/live') return json({ 'r9-eg1': { power_w: 812, ts: JETZT.toISOString() }, 'r9-allgemein': { power_w: 100, ts: new Date(Date.now() - 600000).toISOString() } });
  if (p === '/heute') {
    const ids = u.searchParams.get('ids').split(',');
    const out = {};
    for (const id of ids) {
      const m = ZAEHLER.find(z => z.id === id);
      out[id] = logik.heuteEintrag(m, new Map([[id, { imp: 10, exp: 0 }]]), [], m.group_id === 'r9' ? 0.4 : null);
    }
    return json(out);
  }
  const um = /^\/user\/([^/]+)\/meters$/.exec(p);
  if (um) {
    const z = ZUORDNUNG[decodeURIComponent(um[1])] || { persoenlich: [], gruppe: {} };
    const gruppen = (u.searchParams.get('groups') || '').split(',').filter(Boolean);
    const ids = new Set(z.persoenlich);
    for (const g of gruppen) for (const id of z.gruppe[g] || []) ids.add(id);
    return json(ZAEHLER.filter(m => ids.has(m.id)));
  }
  if (/^\/(today|projection|reihe)\//.test(p)) {
    if (p.startsWith('/today/')) return json({ consumption_kwh: 10, solar_kwh: 4, netz_kwh: 6, solar_anteil: 0.4 });
    if (p.startsWith('/projection/')) return json({ projected_monthly_kwh: 100, solar_share_percent: 40, projected_monthly_cost: 1, netz_price: 0.1 });
    return json({ zaehler: 'r9-eg1', raster: '5m', wert: 'leistung', einheit: 'W', punkte: [] });
  }
  return json({ error: 'unbekannt ' + p }, 404);
};

function antwort() {
  const r = { code: 200, body: undefined, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.type = () => r; r.send = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = () => r;
  return r;
}
async function aufrufen(pfad, req) {
  const route = routen.find(x => x.p === pfad);
  assert.ok(route, 'Route fehlt: ' + pfad);
  const res = antwort();
  const anfrage = { query: {}, params: {}, headers: {}, originalUrl: pfad, ...req };
  for (const h of route.h) {
    let weiter = false;
    await h(anfrage, res, () => { weiter = true; });
    if (!weiter) break;
  }
  return res;
}
const person = (email, groups) => ({ user: { email, groups } });

// ─── L1/L2: MQTT-Sicht ───────────────────────────────────────────────
test('L1: MQTT liest eigene und Gemeinschaftszähler wie HTTP, fremde nicht', async () => {
  const anna = { email: 'anna@example.org', groups: ['r9-bewohner'] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/eg1'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/eg1/power_w'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/allgemein'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/eg2'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/+'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/#'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'wetter/r9'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/alerts/r9-eg1'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/alerts/r9-eg2'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/alerts/#'), false);
});

test('L1: Ausschuss mit energie-monitor sieht per MQTT die STWEG-Zähler', async () => {
  const a = { email: 'ausschuss@example.org', groups: ['stweg3-ausschuss'] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(a, 'energy/r9/eg2'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(a, 'energy/r13/1og1'), false); // Haus 13 = STWEG 2
  // ohne vergebenes energie-monitor (Ausschuss STWEG 2): nichts
  const b = { email: 'ausschuss@example.org', groups: ['stweg2-ausschuss'] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(b, 'energy/r13/1og1'), false);
});

test('L1: energie-config:read liest alles unter energy/', async () => {
  const k = { email: 'konfig@example.org', groups: ['konfig'] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(k, 'energy/r13/1og1'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(k, 'energy/#'), true);
});

test('L2: Solarwerte jeder Anlage für alle Angemeldeten, Überschuss nur mit Wohnungszähler', async () => {
  const fremd = { email: 'eigner@example.org', groups: [] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(fremd, 'energy/r9/solar/grid_w'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(fremd, 'energy/r9/solar/#'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(fremd, 'energy/+/solar/#'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(fremd, 'energy/collector/status'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(fremd, 'energy/r9/ueberschuss/eg1/total_w'), false);
  const anna = { email: 'anna@example.org', groups: ['r9-bewohner'] };
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/ueberschuss/eg1/total_w'), true);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/ueberschuss/eg2/total_w'), false);
  assert.equal(await energieLesen.mqttEnergieErlaubt(anna, 'energy/r9/ueberschuss/+/total_w'), false);
});

test('server.js: aclcheck nutzt dieselbe Regel, Service-User unverändert', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/mqtt/aclcheck'");
  const teil = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(teil, /energieLesen\.mqttEnergieErlaubt\(\{ email: u\.email, groups \}, topic\)/);
  assert.doesNotMatch(teil, /collectorZaehlerFuer/);
  assert.match(teil, /mqttAclAllows\(svc\.topic_filter, topic\)/);
});

// ─── L6: Token ───────────────────────────────────────────────────────
test('L6: DELETE /api/mqtt/token und kurze Laufzeit mit der Karte', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  assert.match(src, /app\.delete\('\/api\/mqtt\/token', authMiddleware,/);
  assert.match(src, /res\.json\(\{ ok: true, widerrufen: r\.rowCount \|\| 0 \}\)/);
  assert.match(src, /DELETE FROM mqtt_tokens WHERE token_hash = \$1 AND LOWER\(email\) = \$2/);
  assert.match(src, /MQTT_TOKEN_LAUFZEIT_KARTE_S = 30 \* 60/);
  assert.match(src, /req\.auth\?\.stufe === 'karte'/);
  assert.match(src, /make_interval\(secs => \$6\)/);
});

// ─── L3: Tarife ──────────────────────────────────────────────────────
test('L3: Art aus dem Namen und Prüfung der Eingabe (Collector)', () => {
  assert.equal(logik.tarifArtAusName('Netztarif'), 'bezug');
  assert.equal(logik.tarifArtAusName('Solartarif'), 'solar');
  assert.equal(logik.tarifArtAusName('Rücklieferung AEW'), 'ruecklieferung');
  assert.equal(logik.tarifArtAusName('Ruecklieferverguetung'), 'ruecklieferung');
  assert.equal(logik.tarifArtAusName('Grundgebuehr'), null);
  assert.deepEqual(logik.tarifFelder({ name: 'Netztarif' }), { art: 'bezug', group_id: null });
  assert.deepEqual(logik.tarifFelder({ name: 'x', art: 'solar', group_id: ' R9 ' }), { art: 'solar', group_id: 'r9' });
  assert.ok(logik.tarifFelder({ art: 'gratis' }).fehler);
  assert.ok(logik.tarifFelder({ group_id: 'r9; drop' }).fehler);
});

test('L3: ZEV-Haus nimmt Tariftabelle, Haus-Tarif vor globalem', async () => {
  const t = await energieTarif.tarifFuerHaus({ haus: 'r9', datum: '2026-11-28', tarife: TARIFE, zaehler: ZAEHLER });
  assert.deepEqual(t, {
    haus: 'r9', quelle: 'zev', chf_kwh: { bezug: 0.27, solar: 0.2, ruecklieferung: null },
    gueltig_ab: '2026-01-01', hinweis: 'Geschätzte Kosten, verbindlich ist die ZEV-Rechnung', elcom: null,
  });
  const mitHaus = TARIFE.concat({ id: 3, name: 'Netz R9', price_per_kwh: 0.25, valid_from: '2026-06-01', active: true, art: 'bezug', group_id: 'r9' });
  assert.equal((await energieTarif.tarifFuerHaus({ haus: 'r9', datum: '2026-11-28', tarife: mitHaus, zaehler: ZAEHLER })).chf_kwh.bezug, 0.25);
  // vor Gueltigkeitsbeginn des Haus-Tarifs gilt der globale
  assert.equal((await energieTarif.tarifFuerHaus({ haus: 'r9', datum: '2026-03-01', tarife: mitHaus, zaehler: ZAEHLER })).chf_kwh.bezug, 0.27);
});

test('L3: Haus ohne ZEV -> ElCom (Attrappe), ohne ElCom -> keine Kosten', async () => {
  const gefragt = [];
  const elcomPreis = async (g, j, k) => { gefragt.push([g, j, k]); return { chf_kwh: 0.3123, rp_kwh: { total: 31.23 } }; };
  const t = await energieTarif.tarifFuerHaus({ haus: 'r13', datum: '2026-11-28', tarife: TARIFE, zaehler: ZAEHLER, elcomPreis });
  assert.deepEqual(gefragt, [[4252, 2026, 'H4']]);
  assert.equal(t.quelle, 'elcom');
  assert.deepEqual(t.chf_kwh, { bezug: 0.3123, solar: null, ruecklieferung: null });
  assert.deepEqual(t.elcom, { jahr: 2026, kategorie: 'H4', gemeinde: 4252 });
  const ohne = await energieTarif.tarifFuerHaus({ haus: 'r13', datum: '2026-11-28', tarife: TARIFE, zaehler: ZAEHLER });
  assert.equal(ohne.quelle, null);
  assert.deepEqual(ohne.chf_kwh, { bezug: null, solar: null, ruecklieferung: null });
  const kaputt = await energieTarif.tarifFuerHaus({ haus: 'r13', datum: '2026-11-28', tarife: TARIFE, zaehler: ZAEHLER, elcomPreis: async () => { throw new Error('LINDAS weg'); } });
  assert.equal(kaputt.quelle, null);
  // ZEV ohne Bezugstarif: keine Kosten (nicht ElCom)
  const keinBezug = await energieTarif.tarifFuerHaus({ haus: 'r9', datum: '2026-11-28', tarife: [TARIFE[1]], zaehler: ZAEHLER, elcomPreis });
  assert.equal(keinBezug.quelle, null);
});

test('L3: Kosten = Netz x Bezug + Solar x Solarpreis', () => {
  const tarif = { chf_kwh: { bezug: 0.27, solar: 0.2, ruecklieferung: null } };
  assert.equal(energieTarif.kostenChf({ kwh: 10, solar_kwh: 4, netz_kwh: 6 }, tarif), 2.42);
  assert.equal(energieTarif.kostenChf({ kwh: 10, solar_kwh: null, netz_kwh: null }, tarif), 2.7);
  assert.equal(energieTarif.kostenChf({ kwh: 10 }, { chf_kwh: { bezug: null } }), null);
});

test('L3: GET /tarif offen, ElCom austauschbar, Seiten mit Rückfall', async () => {
  energieLesen.elcomSetzen(async () => ({ chf_kwh: 0.31 }));
  const r9 = await aufrufen('/tarif', { query: { haus: 'r9', datum: '2026-11-28' } });
  assert.equal(r9.body.quelle, 'zev');
  const r13 = await aufrufen('/tarif', { query: { haus: 'r13', datum: '2026-11-28' } });
  assert.equal(r13.body.quelle, 'elcom');
  assert.equal(r13.body.chf_kwh.bezug, 0.31);
  assert.equal((await aufrufen('/tarif', { query: {} })).code, 400);
  assert.equal((await aufrufen('/tarif', { query: { haus: 'r9', datum: 'gestern' } })).code, 400);
  energieLesen.elcomSetzen(null);
  for (const seite of ['pwa/solar/index.html', 'stweg3/pages/solaranlage-live.html']) {
    const html = fs.readFileSync(path.join(WURZEL, seite), 'utf8');
    assert.match(html, /fetch\('\/api\/energy\/tarif\?haus=r9'/, seite);
    assert.match(html, /let RP_INTERN = 0\.20, RP_RUECKLIEFER = 0\.082;/, seite);
    assert.doesNotMatch(html, /const RP_INTERN/, seite);
  }
});

test('L3: /today und /projection rechnen mit dem Tarif des Hauses', async () => {
  const anna = { headers: { authorization: 'Bearer anna' }, user: { email: 'anna@example.org', groups: ['r9-bewohner'] } };
  const t = await aufrufen('/today/:meterId', { ...anna, params: { meterId: 'r9-eg1' }, query: { date: '2026-11-28' } });
  assert.equal(t.code, 200);
  assert.equal(t.body.tarif.quelle, 'zev');
  assert.equal(t.body.kosten_chf, 2.42);
  const p = await aufrufen('/projection/:meterId', { ...anna, params: { meterId: 'r9-eg1' } });
  assert.equal(p.body.netz_price, 0.27);
  assert.equal(p.body.projected_monthly_cost, 24.2);
  assert.equal(p.body.projected_yearly_cost, 290.4);
  const fremd = await aufrufen('/today/:meterId', { ...anna, params: { meterId: 'r9-eg2' } });
  assert.equal(fremd.code, 403);
});

// ─── L4: Rechte ──────────────────────────────────────────────────────
test('L4: energie-Rechte aus denselben Prüfungen', async () => {
  const anna = await energieLesen.energieRechte(person('anna@example.org', ['r9-bewohner']));
  assert.deepEqual(anna, { stweg_sicht: [], technik: null, verwalten: null, anlagen_eigen: ['r9'] });
  const aus = await energieLesen.energieRechte(person('ausschuss@example.org', ['stweg3-ausschuss']));
  assert.deepEqual(aus.stweg_sicht, [3]);
  assert.equal(aus.technik, null);
  const eig = await energieLesen.energieRechte(person('eigner@example.org', ['r9-eigentuemer']));
  assert.deepEqual(eig.stweg_sicht, []);
  assert.equal(eig.technik, 'eingeschraenkt');
  const tech = await energieLesen.energieRechte(person('technik@example.org', ['technik']));
  assert.deepEqual(tech.stweg_sicht, []); // Technik sieht ohnehin alles, keine STWEG-Sicht
  assert.equal(tech.technik, 'voll');
  assert.equal(tech.verwalten, 'write');
  const k = await energieLesen.energieRechte(person('konfig@example.org', ['konfig']));
  assert.equal(k.verwalten, 'read');
  assert.equal(k.technik, null); // energie-config allein oeffnet die Zaehler-Technik nicht
  assert.equal((await energieLesen.energieRechte(person('x@example.org', ['konfigschreib']))).verwalten, 'write');
});

test('L4: Zähler-Technik-Zugang (requireZaehlerTechnik) aus einer Quelle', () => {
  assert.equal(zaehlerTechnikZugang(['Technik']), true);
  assert.equal(zaehlerTechnikZugang(['praesident']), true);
  assert.equal(zaehlerTechnikZugang(['stweg3-verwaltung']), true);
  assert.equal(zaehlerTechnikZugang(['Verwaltung']), true);
  assert.equal(zaehlerTechnikZugang(['r9-eigentuemer']), true);
  assert.equal(zaehlerTechnikZugang(['stweg2-verwaltung']), false);
  assert.equal(zaehlerTechnikZugang(['stweg3-ausschuss']), false);
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  assert.match(src, /if \(zaehlerTechnikZugang\(req\.user\?\.groups \|\| \[\]\)\) return next\(\);/);
  assert.match(src, /return energieLesen\.vollerZugriff\(req\);/);
});

test('L4: /api/auth/me liefert energie und die abgeleiteten Schlüssel, automatisches energie-monitor bleibt', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'api', 'server.js'), 'utf8');
  const i = src.indexOf("app.get('/api/auth/me'");
  const teil = src.slice(i, src.indexOf('\n});\n', i));
  assert.match(teil, /permissions\['energie-monitor'\] = 'read';/);
  assert.match(teil, /energie = await energieLesen\.energieRechte\(req\)/);
  assert.match(teil, /permissions\['energie-stweg'\] = 'read'/);
  assert.match(teil, /permissions\['zaehler-technik'\] = 'read'/);
  assert.match(teil, /\n {6}energie,\n/);
});

// ─── L7: Anlagen ─────────────────────────────────────────────────────
test('L7: Anlagen aus den Zählern, r9 als Rückfall', () => {
  const a = logik.anlagenAusZaehlern(ZAEHLER.concat({ id: 'r9-heizstab', group_id: 'r9', category: 'consumer', type: 'smartfox', active: true }));
  assert.deepEqual(a, [{
    id: 'r9', name: 'Solaranlage Rosenweg 9', haus: 'r9', hat_boiler: true, hat_ueberschuss: true,
    hat_wohnungen: true, mqtt: 'energy/r9/solar', live: '/api/energy/solar-live?anlage=r9',
  }]);
  assert.deepEqual(logik.anlagenAusZaehlern([]).map(x => x.id), ['r9']);
  // weitere Anlage: gelistet, Live erst, wenn der Collector sie rechnet
  const r13 = logik.anlagenAusZaehlern([{ id: 'r13-pv', group_id: 'r13', category: 'production' }]);
  assert.equal(r13[0].name, 'Solaranlage Rosenweg 13');
  assert.equal(r13[0].live, null);
  assert.equal(r13[0].mqtt, null);
});

test('L7: GET /anlagen offen, mit Anmeldung "eigen"', async () => {
  const offen = await aufrufen('/anlagen', {});
  assert.equal(offen.body[0].id, 'r9');
  assert.equal(offen.body[0].stweg, 3);
  assert.equal(offen.body[0].eigen, false);
  const anna = await aufrufen('/anlagen', { headers: { authorization: 'Bearer anna' } });
  assert.equal(anna.body[0].eigen, true);
  const falsch = await aufrufen('/anlagen', { headers: { authorization: 'Bearer falsch' } });
  assert.equal(falsch.code, 200);
  assert.equal(falsch.body[0].eigen, false);
});

test('L7: solar-live nimmt ?anlage an (Collector)', () => {
  const src = fs.readFileSync(path.join(WURZEL, 'energy-collector', 'collector.js'), 'utf8');
  assert.match(src, /if \(!logik\.LIVE_ANLAGEN\.has\(anlage\)\) return res\.status\(404\)/);
  const df = fs.readFileSync(path.join(WURZEL, 'energy-collector', 'Dockerfile'), 'utf8');
  assert.match(df, /COPY collector\.js meter-target\.js energie-logik\.js/);
});

// ─── L5: Warndienst ──────────────────────────────────────────────────
test('L5: hoch erst nach 5 min durchgehend, Ende nach 10 min darunter', () => {
  const R = logik.WARN_REGELN.hoch;
  const t0 = new Date('2026-11-28T10:00:00Z');
  const min = (n) => new Date(t0.getTime() + n * 60000);
  let z = null, e;
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, true, min(0), R, { wert_w: 4000, schnitt_w: 900 }));
  assert.equal(z.aktiv, false); assert.equal(e, null);
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, true, min(4), R));
  assert.equal(z.aktiv, false);
  // Unterbruch setzt die Pruefung zurueck
  ({ zustand: z } = logik.warnSchritt(z, false, min(4.5), R));
  ({ zustand: z } = logik.warnSchritt(z, true, min(5), R));
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, true, min(9), R));
  assert.equal(z.aktiv, false);
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, true, min(10), R, { wert_w: 4200, schnitt_w: 900 }));
  assert.equal(e, 'an'); assert.equal(z.aktiv, true);
  assert.equal(new Date(z.seit).getTime(), min(5).getTime());
  assert.equal(z.wert_w, 4200);
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, false, min(12), R));
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, true, min(13), R));   // kurz wieder hoch
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, false, min(14), R));
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, false, min(23), R));
  assert.equal(z.aktiv, true); assert.equal(e, null);
  ({ zustand: z, ereignis: e } = logik.warnSchritt(z, false, min(24), R));
  assert.equal(e, 'aus'); assert.equal(z.aktiv, false);
});

test('L5: offline sofort nach 10 min ohne Daten, seit = letzter Messwert', () => {
  const jetzt = new Date('2026-11-28T10:00:00Z');
  const meter = { id: 'r9-eg1', category: 'consumer' };
  const letzter = { ts: '2026-11-28T09:45:00Z', power_w: 100 };
  const b = logik.warnBedingungen({ meter, letzter, schnittW: 900, jetzt });
  assert.equal(b.offline, true); assert.equal(b.hoch, false);
  const { zustand, ereignis } = logik.warnSchritt(null, b.offline, jetzt, logik.WARN_REGELN.offline, { seit: letzter.ts });
  assert.equal(ereignis, 'an');
  assert.equal(zustand.seit, letzter.ts);
  const frisch = logik.warnBedingungen({ meter, letzter: { ts: '2026-11-28T09:59:55Z', power_w: -3000 }, schnittW: 900, jetzt });
  assert.deepEqual(frisch, { offline: false, hoch: true, wert_w: 3000, schnitt_w: 900 });
  // nur Verbraucher koennen "hoch" sein; ohne Schnitt nie
  assert.equal(logik.warnBedingungen({ meter: { category: 'grid' }, letzter: { ts: jetzt, power_w: 9000 }, schnittW: 100, jetzt }).hoch, false);
  assert.equal(logik.warnBedingungen({ meter, letzter: { ts: jetzt, power_w: 9000 }, schnittW: 0, jetzt }).hoch, false);
});

test('L5: MQTT-Nachricht energy/alerts/<zaehler>: aktive gewinnt, offline vor hoch', () => {
  const n = logik.warnNachricht([
    { art: 'offline', aktiv: true, seit: '2026-11-28T09:00:00Z', wert_w: null, schnitt_w: null },
    { art: 'hoch', aktiv: true, seit: '2026-11-28T08:00:00Z', wert_w: 4000, schnitt_w: 900 },
  ]);
  assert.deepEqual(n, { art: 'offline', aktiv: true, seit: '2026-11-28T09:00:00.000Z', wert_w: null, schnitt_w: null });
  const aus = logik.warnNachricht([{ art: 'hoch', aktiv: false, seit: '2026-11-28T11:00:00Z', wert_w: 4000, schnitt_w: 900, geaendert: 2 }, undefined]);
  assert.equal(aus.aktiv, false); assert.equal(aus.art, 'hoch');
  assert.equal(logik.warnNachricht([undefined, undefined]), null);
  const src = fs.readFileSync(path.join(WURZEL, 'energy-collector', 'collector.js'), 'utf8');
  assert.match(src, /CREATE TABLE IF NOT EXISTS meter_alerts/);
  assert.match(src, /mqttClient\.publish\(`\$\{MQTT_PREFIX\}\/alerts\/\$\{meterId\}`, JSON\.stringify\(n\), \{ retain: true \}\)/);
  assert.match(src, /setInterval\(warnLauf, 60 \* 1000\)/);
  assert.match(src, /FROM readings_hourly\s+WHERE hour >= NOW\(\) - interval '7 days' GROUP BY meter_id/);
});

test('L5: GET /warnungen nur sichtbare, hoch nur eigene', async () => {
  const anna = await aufrufen('/warnungen', { headers: { authorization: 'Bearer anna' }, user: { email: 'anna@example.org', groups: ['r9-bewohner'] } });
  assert.deepEqual(anna.body, [{
    zaehler: 'r9-eg1', name: 'EG links', art: 'hoch', seit: '2026-11-28T10:00:00.000Z',
    text: 'Hoher Verbrauch: 4200 W (sonst Ø 900 W)', eigen: true, wert_w: 4200, schnitt_w: 900,
  }]);
  const tech = await aufrufen('/warnungen', { user: { email: 'technik@example.org', groups: ['technik'] } });
  assert.deepEqual(tech.body.map(w => [w.zaehler, w.art, w.eigen, w.text]), [['r9-eg2', 'offline', false, 'Zähler „EG rechts“ ist offline']]);
  const aus = await aufrufen('/warnungen', { user: { email: 'ausschuss@example.org', groups: ['stweg3-ausschuss'] } });
  assert.deepEqual(aus.body, []);
});

// ─── L9: Zeitreihe ───────────────────────────────────────────────────
test('L9: Raster wählen (Rohdaten <= 30 Tage, höchstens 2000 Punkte)', () => {
  const jetzt = Date.parse('2026-11-28T12:00:00Z');
  const vor = (h) => new Date(jetzt - h * 3600000).toISOString();
  const bis = new Date(jetzt).toISOString();
  assert.deepEqual(logik.rasterWaehlen({ von: vor(24), bis, jetzt }), { raster: '1m', sekunden: 60, quelle: 'roh' });
  assert.equal(logik.rasterWaehlen({ von: vor(24 * 7), bis, jetzt }).raster, '5m');
  assert.equal(logik.rasterWaehlen({ von: vor(24 * 20), bis, jetzt }).raster, '15m');
  assert.deepEqual(logik.rasterWaehlen({ von: vor(24 * 40), bis, jetzt }), { raster: '1h', sekunden: 3600, quelle: 'stunde' });
  assert.deepEqual(logik.rasterWaehlen({ von: vor(24 * 365), bis, jetzt }), { raster: '1d', sekunden: 86400, quelle: 'tag' });
  // festes Raster: aelter als 30 Tage -> mindestens 1h; zu viele Punkte -> groesser
  assert.equal(logik.rasterWaehlen({ von: vor(24 * 40), bis, raster: '5m', jetzt }).raster, '1h');
  assert.equal(logik.rasterWaehlen({ von: vor(24 * 10), bis, raster: '1m', jetzt }).raster, '15m');
  assert.equal(logik.rasterWaehlen({ von: vor(24), bis, raster: '1d', jetzt }).raster, '1d');
  assert.ok(logik.rasterWaehlen({ von: bis, bis: vor(1), jetzt }).fehler);
  assert.ok(logik.rasterWaehlen({ von: vor(1), bis, raster: '2m', jetzt }).fehler);
});

test('L9: Verbrauch aus Zählerständen und Kinder-Abzug', () => {
  const zeilen = [
    { t: '2026-11-28T10:00:00Z', min_kwh: 100.0, max_kwh: 100.2 },
    { t: '2026-11-28T10:05:00Z', min_kwh: 100.25, max_kwh: 100.5 },
    { t: '2026-11-28T10:10:00Z', min_kwh: null, max_kwh: null },
    { t: '2026-11-28T10:15:00Z', min_kwh: 100.6, max_kwh: 100.7 },
  ];
  const v = logik.verbrauchAusStaenden(zeilen).map(p => p.v == null ? null : Math.round(p.v * 1000) / 1000);
  assert.deepEqual(v, [0.2, 0.3, null, 0.2]);
  const netto = logik.kinderAbziehen(
    [{ t: '2026-11-28T10:00:00Z', v: 500 }, { t: '2026-11-28T10:05:00Z', v: 100 }, { t: '2026-11-28T10:10:00Z', v: null }],
    [[{ t: '2026-11-28T10:00:00.000Z', v: 200 }, { t: '2026-11-28T10:05:00Z', v: 300 }]]);
  assert.deepEqual(netto.map(p => p.v), [300, 0, null]);
  assert.deepEqual(logik.punkteRunden([{ t: new Date('2026-11-28T10:00:00Z'), v: 1.23456 }], 'leistung'), [{ t: '2026-11-28T10:00:00.000Z', v: 1.2 }]);
});

test('L9: /reihe nur für sichtbare Zähler, Antwort vom Collector', async () => {
  const anna = { headers: { authorization: 'Bearer anna' }, user: { email: 'anna@example.org', groups: ['r9-bewohner'] } };
  const ok = await aufrufen('/reihe/:meterId', { ...anna, params: { meterId: 'r9-eg1' }, originalUrl: '/api/energy/reihe/r9-eg1?raster=5m' });
  assert.equal(ok.code, 200);
  assert.ok(aufrufe.includes('/reihe/r9-eg1?raster=5m'));
  const nein = await aufrufen('/reihe/:meterId', { ...anna, params: { meterId: 'r9-eg2' } });
  assert.equal(nein.code, 403);
});

// ─── L8/L10: Uebersicht ──────────────────────────────────────────────
test('L8: Solar-/Netzanteil je Wohnungszähler aus dem Gruppenanteil', () => {
  assert.equal(logik.solarAnteil({ production_kwh: 30, export_kwh: 10, import_kwh: 30 }), 0.4);
  assert.equal(logik.solarAnteil({ production_kwh: 0, export_kwh: 0, import_kwh: 0 }), 0);
  const d = new Map([['r9-allgemein', { imp: 12, exp: 0 }], ['r9-heizstab', { imp: 2, exp: 0 }], ['r9-produktion', { imp: 0, exp: 25 }]]);
  assert.deepEqual(logik.heuteEintrag({ id: 'r9-allgemein', group_id: 'r9', category: 'general' }, d, ['r9-heizstab'], 0.5), {
    kwh: 10, solar_kwh: 5, netz_kwh: 5, solar_anteil: 0.5, category: 'general', group_id: 'r9', mqtt: 'energy/r9/allgemein',
  });
  const p = logik.heuteEintrag({ id: 'r9-produktion', group_id: 'r9', category: 'production' }, d, [], 0.5);
  assert.equal(p.kwh, 25); assert.equal(p.solar_kwh, null);
  const ohne = logik.heuteEintrag({ id: 'r13-1og1', group_id: 'r13', category: 'consumer' }, new Map(), [], null);
  assert.equal(ohne.kwh, null); assert.equal(ohne.netz_kwh, null);
});

test('L10: MQTT-Thema wie der Publisher', () => {
  assert.equal(logik.mqttThema('r9-eg1'), 'energy/r9/eg1');
  assert.equal(logik.mqttThema('r9-keller-neziri'), 'energy/r9/keller-neziri');
  assert.equal(logik.mqttThema('labor'), 'energy/labor/labor');
  for (const id of ['r9-eg1', 'r9-keller-neziri', 'labor']) assert.equal(energieLesen.mqttThemaVon(id), logik.mqttThema(id));
  const src = fs.readFileSync(path.join(WURZEL, 'energy-collector', 'collector.js'), 'utf8');
  assert.match(src, /const base = logik\.mqttThema\(meter\.id, MQTT_PREFIX\);/);
});

test('L10: GET /uebersicht bündelt Zähler, Live, heute, Anlagen, Warnungen, Tarife, Rechte', async () => {
  const r = await aufrufen('/uebersicht', { headers: { authorization: 'Bearer anna' }, user: { email: 'anna@example.org', groups: ['r9-bewohner'] } });
  assert.equal(r.code, 200);
  const b = r.body;
  assert.deepEqual(b.zaehler.map(z => [z.id, z.rolle]), [['r9-eg1', 'eigen'], ['r9-allgemein', 'gemeinschaft']]);
  const eg1 = b.zaehler[0];
  assert.deepEqual(eg1, {
    id: 'r9-eg1', name: 'EG links', kategorie: 'consumer', haus: 'r9', stweg: 3, rolle: 'eigen', online: true,
    live: { power_w: 812, ts: JETZT.toISOString() },
    heute: { kwh: 10, solar_kwh: 4, netz_kwh: 6, kosten_chf: 2.42 },
    mqtt: 'energy/r9/eg1',
  });
  assert.equal(b.zaehler[1].online, false);
  assert.equal(b.anlagen[0].eigen, true);
  assert.equal(b.warnungen.length, 1);
  assert.equal(b.tarife.r9.quelle, 'zev');
  assert.deepEqual(b.rechte.anlagen_eigen, ['r9']);
  // Netz-/Produktionszaehler werden dabei nicht herausgegeben
  assert.ok(!b.zaehler.some(z => z.kategorie === 'grid' || z.kategorie === 'production'));
  const stweg = await aufrufen('/uebersicht', { user: { email: 'ausschuss@example.org', groups: ['stweg3-ausschuss'] } });
  assert.ok(stweg.body.zaehler.length >= 5);
  assert.ok(stweg.body.zaehler.every(z => z.rolle === 'stweg' && z.haus === 'r9'));
});
