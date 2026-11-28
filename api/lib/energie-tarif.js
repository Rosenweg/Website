// Strompreis je Haus fuer die geschaetzten Kosten (L3, Entscheid E2 c).
//
//   ZEV-Haus     -> Tarife aus der Tariftabelle des Collectors (quelle 'zev'):
//                   zuerst die des Hauses (group_id), sonst die globalen (group_id NULL).
//   kein ZEV     -> Netzbetreiber-Preis aus ElCom (Kaiseraugst, BFS 4252, Kategorie H4,
//                   Jahr aus dem Datum; quelle 'elcom'), Solar/Ruecklieferung null.
//   kein Preis   -> quelle null, alle Preise null (die App zeigt dann keine Kosten).
//
// Welches Haus ist ein ZEV? Eines mit eigenem Tarif (group_id) ODER mit einem aktiven
// Produktionszaehler. Begruendung: Ein Haus mit eigener Solaranlage und Messung ist
// hier praktisch immer ein ZEV (Haus 9); ein ZEV ohne Anlage kann man ueber einen
// Tarif mit group_id ausdruecklich erklaeren. Keine zusaetzliche Liste, die man
// pflegen muesste. Globale Tarife gelten nur fuer ZEV-Haeuser — sonst bekaeme ein
// Haus ohne ZEV den ZEV-Preis von Haus 9.
//
// Rein: Tarife, Zaehler und die ElCom-Abfrage kommen als Argumente (Test ohne Netz).

const HINWEIS_ZEV = 'Geschätzte Kosten, verbindlich ist die ZEV-Rechnung';
const HINWEIS_ELCOM = 'Geschätzte Kosten nach dem ElCom-Tarif des Netzbetreibers';
const HINWEIS_KEIN = 'Kein Strompreis hinterlegt – Kosten werden nicht angezeigt';
const ELCOM = { gemeinde: 4252, kategorie: 'H4' }; // Kaiseraugst, Haushalt H4
const ARTEN = ['bezug', 'solar', 'ruecklieferung'];

function tagText(v) {
  if (v == null || v === '') return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// Die Art setzt der Collector (Spalte art; Altbestand beim Start aus dem Namen
// abgeleitet, energy-collector/energie-logik.js tarifArtAusName) — hier nicht nachbauen.
function artVon(t) {
  return t && t.art ? String(t.art).toLowerCase() : null;
}

function gilt(t, datum) {
  if (t.active === false) return false;
  const von = tagText(t.valid_from), bis = tagText(t.valid_to);
  return (!von || von <= datum) && (!bis || bis >= datum);
}

/** Haeuser (group_id), die als ZEV gelten. */
function zevHaeuser(tarife, zaehler) {
  const s = new Set();
  for (const t of tarife || []) if (t.group_id && t.active !== false) s.add(String(t.group_id).toLowerCase());
  for (const m of zaehler || []) {
    if (m.active !== false && m.category === 'production' && m.group_id) s.add(String(m.group_id).toLowerCase());
  }
  return s;
}

/** Bester Tarif einer Art: Haus-eigener vor globalem, dann der juengste valid_from. */
function tarifWaehlen(tarife, haus, art, datum) {
  const passend = (tarife || []).filter(t => artVon(t) === art && gilt(t, datum));
  const eigen = passend.filter(t => String(t.group_id || '').toLowerCase() === haus);
  const kandidaten = eigen.length ? eigen : passend.filter(t => !t.group_id);
  return kandidaten.sort((a, b) => String(tagText(b.valid_from) || '').localeCompare(String(tagText(a.valid_from) || '')))[0] || null;
}

function preis(t) {
  const n = t ? Number(t.price_per_kwh) : NaN;
  return Number.isFinite(n) ? n : null;
}

function leer(haus) {
  return { haus, quelle: null, chf_kwh: { bezug: null, solar: null, ruecklieferung: null }, gueltig_ab: null, hinweis: HINWEIS_KEIN, elcom: null };
}

async function tarifFuerHaus({ haus, datum, tarife, zaehler, elcomPreis }) {
  const h = String(haus || '').toLowerCase();
  if (zevHaeuser(tarife, zaehler).has(h)) {
    const gewaehlt = Object.fromEntries(ARTEN.map(a => [a, tarifWaehlen(tarife, h, a, datum)]));
    if (preis(gewaehlt.bezug) == null) return leer(h);
    return {
      haus: h,
      quelle: 'zev',
      chf_kwh: Object.fromEntries(ARTEN.map(a => [a, preis(gewaehlt[a])])),
      gueltig_ab: tagText(gewaehlt.bezug.valid_from),
      hinweis: HINWEIS_ZEV,
      elcom: null,
    };
  }
  if (typeof elcomPreis !== 'function') return leer(h);
  const jahr = Number(String(datum).slice(0, 4));
  try {
    const p = await elcomPreis(ELCOM.gemeinde, jahr, ELCOM.kategorie);
    const chf = Number(p?.chf_kwh);
    if (!Number.isFinite(chf) || chf <= 0) return leer(h);
    return {
      haus: h,
      quelle: 'elcom',
      chf_kwh: { bezug: chf, solar: null, ruecklieferung: null },
      gueltig_ab: `${jahr}-01-01`,
      hinweis: HINWEIS_ELCOM,
      elcom: { jahr, kategorie: ELCOM.kategorie, gemeinde: ELCOM.gemeinde },
    };
  } catch {
    return leer(h);
  }
}

/** Kosten in CHF: Netzanteil zum Bezugs-, Solaranteil zum Solarpreis (fehlt er: Bezugspreis). */
function kostenChf({ kwh, solar_kwh, netz_kwh }, tarif) {
  const bezug = tarif?.chf_kwh?.bezug;
  if (bezug == null || kwh == null || !Number.isFinite(Number(kwh))) return null;
  const solarPreis = tarif.chf_kwh.solar ?? bezug;
  const betrag = (solar_kwh != null && netz_kwh != null)
    ? Number(netz_kwh) * bezug + Number(solar_kwh) * solarPreis
    : Number(kwh) * bezug;
  return Math.round(betrag * 100) / 100;
}

module.exports = { tarifFuerHaus, kostenChf, zevHaeuser, tarifWaehlen, artVon, HINWEIS_ZEV, ELCOM };
