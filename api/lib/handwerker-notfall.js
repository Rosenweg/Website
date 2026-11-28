// Notfall-Ansicht für Bewohner (Klärung Welle 3.3, E3/E4/E5; Entscheid Stefan 28.11.2026).
//
// Schmale Antwort für ALLE angemeldeten Personen einer STWEG (Bewohner,
// Eigentümer, Mieter, Ausschuss, Verwaltung): je Notfall-Art die zuständigen
// Firmen mit Priorität und der Notfallnummer der Zuordnung
// (handwerker_event_zuweisungen.notfall_telefon, die Bereitschaftsnummer der
// Firma). Bewusst NICHT enthalten: Mitarbeiter, private Handynummern, Hinweis,
// Notizen, Bewertung, Kosten, Verträge, E-Mail, Adresse. Die Route
// /api/handwerker-notfall (Seitenrecht handwerker) bleibt davon getrennt.
const { isTechnik, isPraesident, getUserStwegs, getAusschussStwegs, verwaltungStwegs } = require('./groups');

const ohne = (s) => s === null || s === undefined || s === '';

/** STWEG, für die das Konto die Notfallnummern sieht (aus den Gruppen, nie aus einem Parameter). */
function notfallSicht(groups) {
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return { alle: true, stwegs: new Set() };
  const s = new Set([...getUserStwegs(g), ...getAusschussStwegs(g), ...verwaltungStwegs(g)]);
  return { alle: false, stwegs: s };
}

/** Eine Zuordnung dieser Sicht zeigen? stweg NULL = gilt für alle STWEG. */
function notfallZeigen(sicht, stweg, wunsch) {
  const n = ohne(stweg) ? null : Number(stweg);
  if (wunsch !== null && wunsch !== undefined) {
    // ?stweg= engt nur ein (und nur auf eine sichtbare STWEG)
    if (!sicht.alle && !sicht.stwegs.has(wunsch)) return false;
    return n === null || n === wunsch;
  }
  return sicht.alle || n === null || sicht.stwegs.has(n);
}

/** Notfallnummer bereinigen: Ziffern, +, Leerzeichen, ( ) / - . ; höchstens 30 Zeichen. null = ungültig/leer. */
function notfallNummer(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.length > 30 || !/^[+0-9][0-9 ()/.\-]*$/.test(s)) return null;
  return s.replace(/\s+/g, ' ');
}

/**
 * Antwort bauen. events: handwerker_event_typen-Zeilen; zuweisungen: Zeilen mit
 * firma, prioritaet, stweg, notfall_telefon (ohne archivierte Firmen).
 * Nur Zuordnungen mit Notfallnummer; sortiert nach Priorität, dann Firma.
 */
function notfallAntwort(sicht, events, zuweisungen, { wunsch = null, jetzt = new Date() } = {}) {
  const proEvent = new Map();
  for (const z of zuweisungen || []) {
    const nummer = notfallNummer(z.notfall_telefon);
    if (!nummer || !notfallZeigen(sicht, z.stweg, wunsch)) continue;
    if (!proEvent.has(z.event_typ_id)) proEvent.set(z.event_typ_id, []);
    proEvent.get(z.event_typ_id).push({
      firma: String(z.firma || '').trim(),
      prioritaet: Number.isFinite(Number(z.prioritaet)) ? Number(z.prioritaet) : 1,
      notfall_telefon: nummer,
    });
  }
  const arten = (events || []).map(e => ({
    id: e.id,
    name: e.name,
    icon: e.icon || null,
    beschreibung: e.beschreibung || null,
    firmen: (proEvent.get(e.id) || [])
      .sort((a, b) => a.prioritaet - b.prioritaet || a.firma.localeCompare(b.firma, 'de')),
  }));
  return {
    stand: jetzt.toISOString(),
    stwegs: sicht.alle ? null : [...sicht.stwegs].sort((a, b) => a - b),
    arten,
  };
}

module.exports = { notfallSicht, notfallZeigen, notfallNummer, notfallAntwort };
