// Was eine STWEG-Seite ohne bzw. mit Anmeldung herausgibt (Funde F1/F2 aus der
// Klaerung „Rosenweg STWEG“, Entscheid Stefan 28.11.2026). Rein, ohne DB.
//
//   F1  GET /api/stweg/:n/wohnungen: ohne Anmeldung nur die Anzahl der
//       Wohnungen (und anderer Objekte). Belegung (bewohnt_von), Besonderheiten,
//       Wertquote, Etage, Flaeche je Wohnung nur fuer Mitglieder der STWEG
//       (jede ihrer Gruppen, auch Bewohner), ihre Verwaltung, Technik, Praesident.
//   F2  GET /api/stweg/:n/kontakte: Mieter sind Eigentuemern gleichgestellt
//       (Name, Mail, echte Nummer in IHRER STWEG). Zu beheben war nur: nur die
//       eigene STWEG (pruefte die Route schon) und nur Kontakte, die schon gelten
//       (gueltig_ab <= heute; kuenftige Kaeufer/Mieter nicht vor dem Einzug).
const { STWEG_GROUPS, isTechnik, isPraesident, isVerwaltungFor } = require('./groups');

/** Mitglied der STWEG nr (irgendeine ihrer Gruppen), ihre Verwaltung oder T/P? */
function stwegMitglied(groups, nr) {
  const g = (groups || []).map(x => String(x).toLowerCase());
  if (isTechnik(groups || []) || isPraesident(groups || [])) return true;
  const m = STWEG_GROUPS[Number(nr)];
  if (m && Object.values(m).some(name => g.includes(String(name).toLowerCase()))) return true;
  return isVerwaltungFor(groups || [], Number(nr));
}

/** Oeffentliche Fassung der Wohnungsliste: nur Anzahlen. */
function wohnungenOeffentlich(rows) {
  const liste = rows || [];
  const wohnungen = liste.filter(w => (w.typ || 'Wohnung') === 'Wohnung').length;
  const andere = {};
  for (const w of liste) {
    if ((w.typ || 'Wohnung') === 'Wohnung') continue;
    andere[w.typ] = (andere[w.typ] || 0) + 1;
  }
  return { anzahl: { wohnungen, andere }, wohnungen: [], eingeschraenkt: true };
}

// F2: Kontakte gelten erst ab gueltig_ab (in SQL, Datum der Datenbank):
const KONTAKT_GILT_SQL = '(k.gueltig_ab IS NULL OR k.gueltig_ab <= CURRENT_DATE)';

module.exports = { stwegMitglied, wohnungenOeffentlich, KONTAKT_GILT_SQL };
