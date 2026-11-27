// Telefonbuch für die Stationen.
//
// Zusammengetragen aus den Tabellen, in denen ohnehin Nummern stehen — es
// wird nichts doppelt gepflegt. Wer was sieht, richtet sich nach den Gruppen
// der angemeldeten Person, nach denselben Regeln wie auf der Website:
//
//   Verwaltung, Handwerker                jede angemeldete Person
//   Nebenstellen                          jede angemeldete Person, nur Nummern
//                                         der Anlage (2–4 Stellen, 3HHWWP)
//   Ansprechpartner je STWEG              nur die eigenen STWEG
//   Bewohner und Eigentuemer              jede angemeldete Person, aber nur mit
//                                         der internen Nummer 3HHWWP
//
// Echte Nummern von Personen (Handy, Festnetz) gehoeren nicht auf ein Geraet im
// Treppenhaus, an dem sich der Reihe nach mehrere Leute anmelden — und seit es
// die internen Nummern gibt, braucht sie dort niemand: wer 3HHWWP waehlt,
// erreicht die Person auf ihren Geraeten, inklusive Weiterleitung (Stefan
// 27.11.2026, lib/nummernsicht.js). Nur Technik und Praesident sehen die echten
// Nummern weiterhin, wie ueberall.
const { pool } = require('./db');
const { isTechnik, isPraesident, getUserStwegs } = require('./groups');
const { istAnlagennummer, interneNummernLaden } = require('./nummernsicht');

function eintrag(kategorie, name, nummer, zusatz) {
  const sauber = String(nummer || '').replace(/[^\d+]/g, '');
  if (sauber.length < 3) return null;
  return { kategorie, name: String(name || '').trim() || sauber, nummer: sauber, zusatz: zusatz || '' };
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
  // In pbx_ring_members stehen auch echte Handynummern (Technik-Bereitschaft):
  // die nur fuer Technik/Praesident, sonst nur Nummern der Anlage.
  const ring = await pool.query(
    'SELECT name, phone, notiz FROM pbx_ring_members WHERE enabled IS NOT FALSE');
  for (const r of ring.rows) {
    if (alleStwegs || istAnlagennummer(r.phone)) dazu('Intern', r.name, r.phone, r.notiz);
  }

  // --- Ansprechpartner je STWEG -------------------------------------------
  // Mit Wohnung = Bewohner: dann die interne Nummer statt der echten. Ohne
  // Wohnung (Hauswart, Firma) bleibt die Nummer.
  const interne = await interneNummernLaden(pool);
  const internVon = (email) => {
    const e = String(email || '').trim().toLowerCase();
    return e ? interne.filter((n) => String(n.email).toLowerCase() === e) : [];
  };
  if (alleStwegs || stwegs.length) {
    const k = await pool.query(
      alleStwegs ? 'SELECT name, email, telefon, funktion, wohnung, stweg FROM kontakte'
                 : 'SELECT name, email, telefon, funktion, wohnung, stweg FROM kontakte WHERE stweg = ANY($1)',
      alleStwegs ? [] : [stwegs]);
    for (const r of k.rows) {
      const zusatz = [r.funktion, r.wohnung && `Wohnung ${r.wohnung}`, `STWEG ${r.stweg}`].filter(Boolean).join(' · ');
      if (alleStwegs || !String(r.wohnung || '').trim()) dazu('Ansprechpartner', r.name, r.telefon, zusatz);
      if (String(r.wohnung || '').trim()) {
        for (const n of internVon(r.email)) dazu('Ansprechpartner', r.name, n.nummer, `${zusatz} · intern`);
      }
    }
  }

  // --- Bewohner und Eigentuemer: interne Nummern -------------------------
  // Quelle: Abbild der Anlage (telefon_interne_nummern, von der pbx-api).
  for (const n of interne) {
    dazu('Bewohner', n.name, n.nummer, [n.wohnung, 'intern'].filter(Boolean).join(' · '));
  }

  // --- Echte Nummern: nur Technik und Praesident ---------------------------
  if (alleStwegs) {
    const w = await pool.query(
      `SELECT bezeichnung, stweg, eigentuemer_name, eigentuemer_telefon,
              mieter_name, mieter_telefon FROM wohnungen WHERE deleted_at IS NULL`);
    for (const r of w.rows) {
      const ort = [r.bezeichnung, `STWEG ${r.stweg}`].filter(Boolean).join(' · ');
      dazu('Eigentümer', r.eigentuemer_name, r.eigentuemer_telefon, ort);
      dazu('Bewohner', r.mieter_name, r.mieter_telefon, ort);
    }

    const wk = await pool.query(
      `SELECT k.name, k.telefon, k.mobile, k.rolle, w.bezeichnung, w.stweg
         FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
        WHERE k.deleted_at IS NULL AND k.archiviert_am IS NULL`);
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
