// Waschküche: Regeln, die Reservationen, Sperrzeiten, Abrechnung und
// Einstellungen gemeinsam brauchen (Entscheid Stefan 27.11.2026).
//
//   - Sperrzeiten je Raum (von/bis, Grund): Reservieren lehnt sie ab, das
//     Raster zeigt sie grau.
//   - Abrechnung: jeder vergangene Monat, aber nur einmal.
//   - Einstellungen wirken: reservation_max_days (statt 90), reservation_max_per_user
//     (offene Reservationen je Person, statt 120), auto_billing (am 1. um 08:00 den
//     Vormonat abrechnen).

const STANDARD = Object.freeze({
  cost_per_kwh: '0.30',
  reservation_max_days: '90',
  reservation_max_per_user: '120',
  auto_billing: 'true', // bisher lief die Monatsabrechnung immer
});

/** Schluessel, die PUT /api/wasch/settings annimmt, mit Pruefung. */
const FELDER = {
  cost_per_kwh: { art: 'zahl', min: 0, max: 10, text: 'Preis pro kWh' },
  reservation_max_days: { art: 'ganz', min: 1, max: 365, text: 'Tage im Voraus' },
  reservation_max_per_user: { art: 'ganz', min: 1, max: 500, text: 'Offene Reservationen je Person' },
  auto_billing: { art: 'jaNein', text: 'Automatisch abrechnen' },
};

/** Zeilen aus wasch_settings → Werte mit Standard, als Zahlen/Wahrheitswerte. */
function einstellungen(zeilen) {
  const roh = { ...STANDARD };
  for (const z of zeilen || []) if (z && z.key in roh) roh[z.key] = String(z.value);
  const ganz = (v, d) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : d; };
  const preis = parseFloat(roh.cost_per_kwh);
  return {
    preisProKwh: Number.isFinite(preis) && preis >= 0 ? preis : 0.3,
    maxTage: ganz(roh.reservation_max_days, 90),
    maxOffen: ganz(roh.reservation_max_per_user, 120),
    autoAbrechnung: roh.auto_billing === 'true' || roh.auto_billing === '1',
  };
}

/**
 * Koerper von PUT /api/wasch/settings pruefen. Unbekannte Schluessel fallen weg.
 * -> { werte: {key: text}, fehler: null } oder { werte: null, fehler: {feld, text} }
 */
function einstellungenPruefen(body) {
  const werte = {};
  for (const [key, def] of Object.entries(FELDER)) {
    if (!body || !(key in body)) continue;
    const v = body[key];
    if (def.art === 'jaNein') {
      if (v === true || v === 'true' || v === '1' || v === 1) werte[key] = 'true';
      else if (v === false || v === 'false' || v === '0' || v === 0) werte[key] = 'false';
      else return { werte: null, fehler: { feld: key, text: `${def.text}: ja oder nein` } };
      continue;
    }
    const n = def.art === 'ganz' ? Number(String(v).trim()) : parseFloat(String(v).trim().replace(',', '.'));
    if (!Number.isFinite(n) || (def.art === 'ganz' && !Number.isInteger(n)) || n < def.min || n > def.max) {
      return { werte: null, fehler: { feld: key, text: `${def.text}: ${def.art === 'ganz' ? 'ganze Zahl' : 'Zahl'} von ${def.min} bis ${def.max}` } };
    }
    werte[key] = def.art === 'ganz' ? String(n) : String(Math.round(n * 10000) / 10000);
  }
  return { werte, fehler: null };
}

/**
 * Monat fuer die Abrechnung: 'YYYY-MM', muss vergangen sein (vor dem laufenden).
 * Ohne Angabe: Vormonat. -> { ok, monat: 'YYYY-MM', start: 'YYYY-MM-01' } oder { ok: false, fehler }
 */
function abrechnungsMonat(eingabe, jetzt = new Date()) {
  const vor = new Date(jetzt.getFullYear(), jetzt.getMonth() - 1, 1);
  const monat = eingabe == null || eingabe === ''
    ? `${vor.getFullYear()}-${String(vor.getMonth() + 1).padStart(2, '0')}`
    : String(eingabe);
  const m = /^(\d{4})-(\d{2})$/.exec(monat);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return { ok: false, fehler: 'Ungültiger Monat (YYYY-MM)' };
  const laufend = jetzt.getFullYear() * 12 + jetzt.getMonth();
  const gewaehlt = Number(m[1]) * 12 + (Number(m[2]) - 1);
  if (gewaehlt >= laufend) return { ok: false, fehler: 'Abrechnen geht nur für vergangene Monate' };
  if (Number(m[1]) < 2020) return { ok: false, fehler: 'Ungültiger Monat (YYYY-MM)' };
  return { ok: true, monat, start: `${monat}-01` };
}

/** Automatische Abrechnung jetzt faellig? Am 1. zwischen 08:00 und 08:05 (Takt 5 Min.). */
function autoAbrechnungFaellig(jetzt, einst) {
  return !!einst.autoAbrechnung && jetzt.getDate() === 1 && jetzt.getHours() === 8 && jetzt.getMinutes() < 5;
}

/**
 * Sperrzeit pruefen: { room_id, start_time, end_time, grund }.
 * -> { ok, von: Date, bis: Date, grund, raum } oder { ok: false, fehler, feld }
 */
function sperrzeitPruefen(body) {
  const raum = parseInt(body?.room_id, 10);
  if (!Number.isInteger(raum) || raum <= 0) return { ok: false, fehler: 'Raum fehlt', feld: 'room_id' };
  const s = body?.start_time, e = body?.end_time;
  const von = new Date(s), bis = new Date(e);
  if (typeof s !== 'string' || typeof e !== 'string' || isNaN(von) || isNaN(bis)) return { ok: false, fehler: 'Ungültige Zeitangabe', feld: 'start_time' };
  if (bis <= von) return { ok: false, fehler: 'Das Ende muss nach dem Beginn liegen', feld: 'end_time' };
  if (bis - von > 366 * 86400000) return { ok: false, fehler: 'Eine Sperrzeit dauert höchstens ein Jahr', feld: 'end_time' };
  const grund = String(body?.grund ?? '').trim();
  if (!grund) return { ok: false, fehler: 'Bitte einen Grund angeben', feld: 'grund' };
  if (grund.length > 200) return { ok: false, fehler: 'Grund: höchstens 200 Zeichen', feld: 'grund' };
  return { ok: true, raum, von, bis, grund };
}

module.exports = {
  STANDARD, FELDER, einstellungen, einstellungenPruefen, abrechnungsMonat,
  autoAbrechnungFaellig, sperrzeitPruefen,
};
