// Reine Rechenregeln des Energy-Collectors (ohne Datenbank, ohne MQTT, ohne
// Netzwerk) — damit api/test sie ohne pg/modbus pruefen kann. collector.js
// ruft sie auf; hier steht nur, WAS gerechnet wird, nicht woher die Zahlen kommen.

// ─── MQTT-Thema eines Zaehlers ───────────────────────────────────────
// Zaehler "r9-2og3" -> energy/r9/2og3 (Hierarchie energy/<haus>/<bereich>).
// Bereich = Rest nach dem ersten "-"; ohne "-" ist der Bereich die ID selbst.
// Die ACL der Portal-API (aclcheck) liest dasselbe Schema zurueck.
function mqttThema(meterId, prefix = 'energy') {
  const teile = String(meterId).split('-');
  const haus = teile.shift();
  const bereich = teile.length ? teile.join('-') : haus;
  return `${prefix}/${haus}/${bereich}`;
}

// ─── Tarife ──────────────────────────────────────────────────────────
const TARIF_ARTEN = ['bezug', 'solar', 'ruecklieferung'];

// Art eines Alt-Tarifs aus dem Namen: Netztarif -> bezug, Solartarif -> solar,
// Rückliefer…/Einspeis… -> ruecklieferung. Unbekannt -> null (zaehlt nirgends).
function tarifArtAusName(name) {
  const n = String(name || '').toLowerCase();
  if (/r(ü|ue|u)ckliefer|einspeis/.test(n)) return 'ruecklieferung';
  if (/solar|eigenverbrauch|pv/.test(n)) return 'solar';
  if (/netz|bezug/.test(n)) return 'bezug';
  return null;
}

// Eingabe aus der Verwaltung pruefen: art muss bekannt sein (oder leer = aus dem
// Namen ableiten), group_id kurz und ohne Sonderzeichen (leer = gilt fuer alle).
function tarifFelder(body) {
  const b = body || {};
  let art = b.art == null || b.art === '' ? tarifArtAusName(b.name) : String(b.art).toLowerCase();
  if (art != null && !TARIF_ARTEN.includes(art)) return { fehler: `art: ${TARIF_ARTEN.join(' | ')}` };
  let group = b.group_id == null ? null : String(b.group_id).trim().toLowerCase();
  if (group === '') group = null;
  if (group != null && !/^[a-z0-9_-]{1,64}$/.test(group)) return { fehler: 'group_id ungueltig' };
  return { art, group_id: group };
}

// ─── Solaranteil einer Gruppe ────────────────────────────────────────
// Eigenverbrauch = Produktion - Einspeisung; Anteil = Eigenverbrauch / (Eigenverbrauch + Netzbezug).
// Gleiche Regel wie Dashboard und Prognose.
function solarAnteil({ production_kwh, export_kwh, import_kwh }) {
  const prod = Number(production_kwh) || 0;
  const exp = Number(export_kwh) || 0;
  const imp = Number(import_kwh) || 0;
  const eigen = Math.max(0, prod - exp);
  const total = eigen + imp;
  return total > 0 ? eigen / total : 0;
}

// Verbrauch eines Wohnungszaehlers nach dem Solaranteil der Gruppe aufteilen.
// anteil null = Gruppe ohne Solar (keine Aufteilung, alles Netz).
function solarAufteilen(kwh, anteil) {
  if (kwh == null || !Number.isFinite(Number(kwh))) return { solar_kwh: null, netz_kwh: null };
  const k = Number(kwh);
  if (anteil == null) return { solar_kwh: null, netz_kwh: null };
  const solar = k * Math.min(1, Math.max(0, anteil));
  return { solar_kwh: runde(solar, 3), netz_kwh: runde(k - solar, 3) };
}

function runde(x, stellen = 2) {
  const f = 10 ** stellen;
  return Math.round(x * f) / f;
}

// ─── Anlagen (Solaranlagen je Haus) ──────────────────────────────────
// Eine Anlage ist jede Gruppe (group_id) mit einem aktiven Produktionszaehler
// oder einer SmartFox. Live (solar-live, energy/<anlage>/solar/*) rechnet der
// Collector heute nur fuer r9 (resolveR9GridProduction) -> LIVE_ANLAGEN.
// r9 ist der Rueckfall, wenn die Zaehlerliste leer ist.
const LIVE_ANLAGEN = new Set(['r9']);

function anlagenName(gid) {
  const m = /^r(?:w)?(\d+)$/.exec(String(gid));
  return m ? `Solaranlage Rosenweg ${m[1]}` : `Solaranlage ${gid}`;
}

function anlagenAusZaehlern(meters, prefix = 'energy') {
  const gruppen = new Map();
  for (const m of meters || []) {
    if (m.active === false) continue;
    const gid = String(m.group_id || '').trim().toLowerCase();
    if (!gid) continue;
    if (!gruppen.has(gid)) gruppen.set(gid, []);
    gruppen.get(gid).push(m);
  }
  const liste = [];
  for (const [gid, ms] of gruppen) {
    const hatProd = ms.some(m => m.category === 'production');
    const hatSmartfox = ms.some(m => m.type === 'smartfox');
    if (!hatProd && !hatSmartfox) continue;
    liste.push(anlageEintrag(gid, {
      hat_boiler: hatSmartfox || ms.some(m => /heizstab|boiler/i.test(String(m.id))),
      hat_wohnungen: ms.some(m => m.category === 'consumer' && !/heizstab|boiler|allgemein/i.test(String(m.id))),
    }, prefix));
  }
  if (!liste.length) {
    liste.push(anlageEintrag('r9', { hat_boiler: true, hat_wohnungen: true }, prefix));
  }
  return liste.sort((a, b) => a.id.localeCompare(b.id));
}

function anlageEintrag(gid, { hat_boiler, hat_wohnungen }, prefix = 'energy') {
  const live = LIVE_ANLAGEN.has(gid);
  return {
    id: gid,
    name: anlagenName(gid),
    haus: gid,
    hat_boiler: !!hat_boiler,
    // Ueberschuss je Wohnung (energy/r9/ueberschuss/<wohnung>/total_w) abonniert der Collector nur fuer r9
    hat_ueberschuss: gid === 'r9',
    hat_wohnungen: !!hat_wohnungen,
    mqtt: live ? `${prefix}/${gid}/solar` : null,
    live: live ? `/api/energy/solar-live?anlage=${encodeURIComponent(gid)}` : null,
  };
}

// ─── Warnungen (Warndienst) ──────────────────────────────────────────
// Ein Zustand je (Zaehler, Art). bedingung = Regel greift gerade.
//  - anMs:  so lange muss die Bedingung ununterbrochen gelten, bis die Warnung aktiv wird
//  - ausMs: so lange muss sie ununterbrochen NICHT gelten, bis die Warnung endet
// pruef_seit merkt den Beginn der laufenden Pruefphase (an oder aus).
const WARN_REGELN = {
  offline: { anMs: 0, ausMs: 0, offlineMs: 10 * 60 * 1000 },
  hoch: { anMs: 5 * 60 * 1000, ausMs: 10 * 60 * 1000, faktor: 3 },
};

function warnSchritt(alt, bedingung, jetzt, { anMs = 0, ausMs = 0 } = {}, werte = {}) {
  const z = {
    aktiv: !!alt?.aktiv,
    seit: alt?.seit ?? null,
    pruef_seit: alt?.pruef_seit ?? null,
    wert_w: alt?.wert_w ?? null,
    schnitt_w: alt?.schnitt_w ?? null,
  };
  const t = jetzt instanceof Date ? jetzt : new Date(jetzt);
  let ereignis = null;
  if (!z.aktiv) {
    if (bedingung) {
      if (!z.pruef_seit) z.pruef_seit = t;
      if (t - new Date(z.pruef_seit) >= anMs) {
        // seit: Beginn der Pruefphase bzw. (offline) der letzte Messwert, wenn bekannt
        z.aktiv = true; z.seit = werte.seit || z.pruef_seit; z.pruef_seit = null; ereignis = 'an';
      }
    } else {
      z.pruef_seit = null;
    }
  } else if (!bedingung) {
    if (!z.pruef_seit) z.pruef_seit = t;
    if (t - new Date(z.pruef_seit) >= ausMs) {
      z.aktiv = false; z.seit = z.pruef_seit; z.pruef_seit = null; ereignis = 'aus';
    }
  } else {
    z.pruef_seit = null;
  }
  // Messwerte nur nachfuehren, solange die Warnung aktiv ist oder gerade wird
  if (z.aktiv && bedingung) {
    if (werte.wert_w !== undefined) z.wert_w = werte.wert_w;
    if (werte.schnitt_w !== undefined) z.schnitt_w = werte.schnitt_w;
  }
  return { zustand: z, ereignis };
}

// Bedingungen eines Zaehlers aus letztem Messwert und Stundenmittel
function warnBedingungen({ meter, letzter, schnittW, jetzt }) {
  const t = jetzt instanceof Date ? jetzt.getTime() : Number(jetzt);
  const tsMs = letzter?.ts ? new Date(letzter.ts).getTime() : null;
  const offline = !tsMs || (t - tsMs > WARN_REGELN.offline.offlineMs);
  const wert = (!offline && letzter && Number.isFinite(Number(letzter.power_w))) ? Math.abs(Number(letzter.power_w)) : null;
  const schnitt = Number(schnittW) || 0;
  const hoch = meter?.category === 'consumer' && !offline && wert != null && schnitt > 0 && wert > schnitt * WARN_REGELN.hoch.faktor;
  return { offline, hoch, wert_w: wert == null ? null : Math.round(wert), schnitt_w: schnitt > 0 ? Math.round(schnitt) : null };
}

// Retained-Nachricht energy/alerts/<zaehler>: aktive Warnung gewinnt (offline vor
// hoch); ist keine aktiv, die zuletzt geaenderte als aktiv:false.
function warnNachricht(zustaende) {
  const z = (zustaende || []).filter(Boolean);
  const aktiv = z.filter(s => s.aktiv).sort((a, b) => (a.art === 'offline' ? -1 : 1) - (b.art === 'offline' ? -1 : 1));
  const s = aktiv[0] || z.slice().sort((a, b) => new Date(b.geaendert || 0) - new Date(a.geaendert || 0))[0];
  if (!s) return null;
  return {
    art: s.art,
    aktiv: !!s.aktiv,
    seit: s.seit ? new Date(s.seit).toISOString() : null,
    wert_w: s.wert_w ?? null,
    schnitt_w: s.schnitt_w ?? null,
  };
}

// ─── Zeitreihen (/reihe) ─────────────────────────────────────────────
const RASTER_S = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
const RASTER_FOLGE = ['1m', '5m', '15m', '1h', '1d'];
const MAX_PUNKTE = 2100; // "~2000": eine Woche im 5-min-Raster (2016) soll noch passen
const ROH_TAGE = 30;

// Raster und Quelle waehlen. Rohdaten gibt es nur ROH_TAGE zurueck; darueber
// mindestens 1h aus readings_hourly. Mehr als MAX_PUNKTE -> naechstgroesseres Raster
// (auch bei fest gewaehltem Raster: die Antwort nennt das tatsaechliche).
function rasterWaehlen({ von, bis, raster = 'auto', jetzt = Date.now() }) {
  const v = new Date(von).getTime(), b = new Date(bis).getTime();
  if (!Number.isFinite(v) || !Number.isFinite(b) || b <= v) return { fehler: 'von/bis ungueltig' };
  if (raster !== 'auto' && !RASTER_S[raster]) return { fehler: `raster: auto | ${RASTER_FOLGE.join(' | ')}` };
  const spanS = (b - v) / 1000;
  const rohMoeglich = v >= Number(jetzt) - ROH_TAGE * 86400000;
  let i = raster === 'auto' ? 0 : RASTER_FOLGE.indexOf(raster);
  if (!rohMoeglich) i = Math.max(i, RASTER_FOLGE.indexOf('1h'));
  while (i < RASTER_FOLGE.length - 1 && spanS / RASTER_S[RASTER_FOLGE[i]] > MAX_PUNKTE) i++;
  if (spanS / RASTER_S[RASTER_FOLGE[i]] > MAX_PUNKTE) return { fehler: 'Zeitraum zu lang' };
  const r = RASTER_FOLGE[i];
  const quelle = RASTER_S[r] < 3600 ? 'roh' : (r === '1h' ? 'stunde' : 'tag');
  return { raster: r, sekunden: RASTER_S[r], quelle };
}

// Verbrauch je Raster aus Zaehlerstaenden: Differenz der Hoechststaende
// aufeinanderfolgender Raster (so geht der Schritt zwischen zwei Rastern nicht
// verloren); das erste Raster misst max - min in sich. Nie negativ.
function verbrauchAusStaenden(zeilen) {
  const out = [];
  let vorher = null;
  for (const z of zeilen || []) {
    const max = z.max_kwh == null ? null : Number(z.max_kwh);
    const min = z.min_kwh == null ? null : Number(z.min_kwh);
    let v = null;
    if (max != null) v = Math.max(0, max - (vorher != null ? vorher : (min != null ? min : max)));
    if (max != null) vorher = max;
    out.push({ t: z.t, v });
  }
  return out;
}

// Kinder-Abzug (z. B. Heizstab unter Allgemein): je Zeitpunkt abziehen, nie unter 0.
function kinderAbziehen(punkte, kinderReihen) {
  if (!kinderReihen || !kinderReihen.length) return punkte;
  const karten = kinderReihen.map(r => new Map((r || []).map(p => [new Date(p.t).getTime(), p.v])));
  return punkte.map(p => {
    if (p.v == null) return p;
    let v = p.v;
    const k = new Date(p.t).getTime();
    for (const m of karten) { const c = m.get(k); if (typeof c === 'number' && Number.isFinite(c)) v -= c; }
    return { t: p.t, v: Math.max(0, v) };
  });
}

function punkteRunden(punkte, wert) {
  const st = wert === 'verbrauch' ? 4 : 1;
  return punkte.map(p => ({ t: new Date(p.t).toISOString(), v: p.v == null ? null : runde(Number(p.v), st) }));
}

module.exports = {
  mqttThema,
  TARIF_ARTEN, tarifArtAusName, tarifFelder,
  solarAnteil, solarAufteilen, runde,
  LIVE_ANLAGEN, anlagenName, anlagenAusZaehlern, anlageEintrag,
  WARN_REGELN, warnSchritt, warnBedingungen, warnNachricht,
  RASTER_S, RASTER_FOLGE, MAX_PUNKTE, ROH_TAGE, rasterWaehlen, verbrauchAusStaenden, kinderAbziehen, punkteRunden,
};

// ─── Tageswerte je Zaehler (/heute, /today) ──────────────────────────
// deltas: Map id -> { imp, exp } (Zaehlerstand-Differenz seit Tagesbeginn).
// Produktion: erzeugte kWh (Export); sonst Bezug minus Kinder (Heizstab unter
// Allgemein), nie negativ. Aufteilung Solar/Netz nur fuer Verbraucher
// (consumer/general) nach dem Solaranteil der Gruppe (anteil null = keine Anlage).
function heuteEintrag(meter, deltas, kinder, anteil, prefix = 'energy') {
  const x = deltas.get(meter.id);
  let kwh = null;
  if (x) {
    if (meter.category === 'production') kwh = x.exp;
    else if (x.imp != null) {
      kwh = x.imp;
      for (const k of kinder || []) { const c = deltas.get(k); if (c && c.imp != null) kwh -= c.imp; }
      kwh = Math.max(0, kwh);
    }
  }
  const verbraucher = meter.category === 'consumer' || meter.category === 'general';
  const a = verbraucher && anteil != null ? anteil : null;
  const teil = verbraucher ? solarAufteilen(kwh, a) : { solar_kwh: null, netz_kwh: null };
  return {
    kwh: kwh == null ? null : runde(Number(kwh), 3),
    ...teil,
    solar_anteil: a == null ? null : runde(a, 4),
    category: meter.category || null,
    group_id: meter.group_id || null,
    mqtt: mqttThema(meter.id, prefix),
  };
}

module.exports.heuteEintrag = heuteEintrag;
