// Telefonbuch für die Stationen.
//
// Zusammengetragen aus den Tabellen, in denen ohnehin Nummern stehen — es
// wird nichts doppelt gepflegt. Wer was sieht, richtet sich nach den Gruppen
// der angemeldeten Person, nach denselben Regeln wie auf der Website:
//
//   Verwaltung, Handwerker, Nebenstellen   jede angemeldete Person
//   Ansprechpartner je STWEG               nur die eigenen STWEG
//   Bewohner und Eigentümer                nur die eigenen STWEG, und nur
//                                          für Ausschuss, Verwaltung,
//                                          Technik und Präsidium
//
// Die letzte Zeile ist eine Abwägung und keine technische Notwendigkeit:
// eine Station steht im Treppenhaus, und private Nummern gehören nicht auf
// ein Gerät, an dem sich der Reihe nach mehrere Leute anmelden. Wer sie im
// Alltag braucht — Ausschuss und Verwaltung — bekommt sie.
const { pool } = require('./db');
const { isTechnik, isPraesident, isAusschussForAny, getUserStwegs } = require('./groups');

function eintrag(kategorie, name, nummer, zusatz) {
  const sauber = String(nummer || '').replace(/[^\d+]/g, '');
  if (sauber.length < 3) return null;
  return { kategorie, name: String(name || '').trim() || sauber, nummer: sauber, zusatz: zusatz || '' };
}

function darfBewohnerSehen(groups) {
  return isTechnik(groups) || isPraesident(groups) || isAusschussForAny(groups)
    || groups.some((g) => ['verwaltung', 'wohnungsverwaltung', 'bewohner-verwaltung'].includes(g.toLowerCase()));
}

/**
 * @param {string[]} groups Gruppen der angemeldeten Person (aus dem AD)
 */
async function telefonbuch(groups) {
  const eintraege = [];
  const stwegs = [...getUserStwegs(groups || [])];
  const alleStwegs = isTechnik(groups) || isPraesident(groups);

  const dazu = (...args) => { const e = eintrag(...args); if (e) eintraege.push(e); };

  // --- Verwaltung ----------------------------------------------------------
  const verw = await pool.query(
    'SELECT firma_name, telefon, stweg FROM verwaltungen WHERE aktiv IS NOT FALSE');
  for (const r of verw.rows) dazu('Verwaltung', r.firma_name, r.telefon, `STWEG ${r.stweg ?? '–'}`);

  const verwK = await pool.query(`
    SELECT k.name, k.telefon, k.funktion, v.firma_name
      FROM verwaltungs_kontakte k JOIN verwaltungen v ON v.id = k.verwaltung_id`);
  for (const r of verwK.rows) dazu('Verwaltung', r.name, r.telefon, [r.funktion, r.firma_name].filter(Boolean).join(' · '));

  // --- Handwerker ----------------------------------------------------------
  const hw = await pool.query(
    'SELECT firma, kategorie, telefon, mobile FROM handwerker WHERE archiviert IS NOT TRUE');
  for (const r of hw.rows) {
    dazu('Handwerker', r.firma, r.telefon, r.kategorie);
    dazu('Handwerker', r.firma, r.mobile, [r.kategorie, 'mobil'].filter(Boolean).join(' · '));
  }

  const hwP = await pool.query(`
    SELECT p.name, p.telefon, p.mobile, p.rolle, h.firma
      FROM handwerker_personen p JOIN handwerker h ON h.id = p.handwerker_id
     WHERE h.archiviert IS NOT TRUE`);
  for (const r of hwP.rows) {
    dazu('Handwerker', r.name, r.telefon, [r.rolle, r.firma].filter(Boolean).join(' · '));
    dazu('Handwerker', r.name, r.mobile, [r.rolle, r.firma, 'mobil'].filter(Boolean).join(' · '));
  }

  // --- Nebenstellen --------------------------------------------------------
  const ring = await pool.query(
    'SELECT name, phone, notiz FROM pbx_ring_members WHERE enabled IS NOT FALSE');
  for (const r of ring.rows) dazu('Intern', r.name, r.phone, r.notiz);

  // --- Ansprechpartner je STWEG -------------------------------------------
  if (alleStwegs || stwegs.length) {
    const k = await pool.query(
      alleStwegs ? 'SELECT name, telefon, funktion, wohnung, stweg FROM kontakte'
                 : 'SELECT name, telefon, funktion, wohnung, stweg FROM kontakte WHERE stweg = ANY($1)',
      alleStwegs ? [] : [stwegs]);
    for (const r of k.rows) {
      dazu('Ansprechpartner', r.name, r.telefon,
        [r.funktion, r.wohnung && `Wohnung ${r.wohnung}`, `STWEG ${r.stweg}`].filter(Boolean).join(' · '));
    }
  }

  // --- Bewohner und Eigentümer --------------------------------------------
  if (darfBewohnerSehen(groups || [])) {
    const w = await pool.query(
      alleStwegs
        ? `SELECT bezeichnung, stweg, eigentuemer_name, eigentuemer_telefon,
                  mieter_name, mieter_telefon FROM wohnungen WHERE deleted_at IS NULL`
        : `SELECT bezeichnung, stweg, eigentuemer_name, eigentuemer_telefon,
                  mieter_name, mieter_telefon FROM wohnungen
            WHERE deleted_at IS NULL AND stweg = ANY($1)`,
      alleStwegs ? [] : [stwegs]);
    for (const r of w.rows) {
      const ort = [r.bezeichnung, `STWEG ${r.stweg}`].filter(Boolean).join(' · ');
      dazu('Eigentümer', r.eigentuemer_name, r.eigentuemer_telefon, ort);
      dazu('Bewohner', r.mieter_name, r.mieter_telefon, ort);
    }

    const wk = await pool.query(
      alleStwegs
        ? `SELECT k.name, k.telefon, k.mobile, k.rolle, w.bezeichnung, w.stweg
             FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
            WHERE k.deleted_at IS NULL AND k.archiviert_am IS NULL`
        : `SELECT k.name, k.telefon, k.mobile, k.rolle, w.bezeichnung, w.stweg
             FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
            WHERE k.deleted_at IS NULL AND k.archiviert_am IS NULL AND w.stweg = ANY($1)`,
      alleStwegs ? [] : [stwegs]);
    for (const r of wk.rows) {
      const ort = [r.rolle, r.bezeichnung, `STWEG ${r.stweg}`].filter(Boolean).join(' · ');
      dazu('Bewohner', r.name, r.telefon, ort);
      dazu('Bewohner', r.name, r.mobile, `${ort} · mobil`);
    }
  }

  // Doppelte Nummern zusammenfassen: dieselbe Person steht oft in mehreren
  // Tabellen, und eine Liste mit drei gleichen Zeilen hilft niemandem.
  const gesehen = new Map();
  for (const e of eintraege) {
    const schluessel = `${e.nummer}|${e.name.toLowerCase()}`;
    if (!gesehen.has(schluessel)) gesehen.set(schluessel, e);
  }

  return [...gesehen.values()].sort((a, b) =>
    a.kategorie.localeCompare(b.kategorie, 'de') || a.name.localeCompare(b.name, 'de'));
}

module.exports = { telefonbuch };
