// Hausverwaltung und STWEG-Mailverteiler (email_verteiler).
//
// Empfangen: Ein Bewohner-/Eigentuemer-Verteiler einer STWEG (Rundmail) geht
// auch an die Hausverwaltung dieser STWEG (Gruppe stwegN-verwaltung bzw.
// meg-verwaltung). Frueher bekam sie die Mails nur, weil ihr Konto zusaetzlich
// in der Bewohnergruppe stand; ein Verwalter ist aber kein Bewohner.
//
// Senden: An einen geschuetzten Verteiler (allowed_sender_groups) darf die
// Verwaltung nur, wenn sie die STWEG des Verteilers verwaltet – nicht mehr an
// jeden Verteiler aller STWEGs.
const { STWEG_GROUPS, VERWALTUNG_GROUPS, verwaltungGruppenStwegs } = require('./groups');

function verteilerStweg(verteiler) {
  const n = parseInt(verteiler && verteiler.stweg, 10);
  return Number.isFinite(n) && VERWALTUNG_GROUPS[n] ? n : null;
}

function gruppenNamen(verteiler) {
  if (!verteiler) return [];
  if (Array.isArray(verteiler.group_names) && verteiler.group_names.length) return verteiler.group_names.map(String);
  return verteiler.group_name ? [String(verteiler.group_name)] : [];
}

// Ist der Verteiler eine Rundmail an Bewohner/Eigentuemer seiner STWEG?
// Ja, wenn er eine Bewohner-/Eigentuemergruppe dieser STWEG aufloest oder eine
// Live-Liste aus der Objektverwaltung (verwaltung:bewohner|eigentuemer|mieter).
function istBewohnerRundmail(verteiler) {
  const nr = verteilerStweg(verteiler);
  if (!nr) return false;
  const m = STWEG_GROUPS[nr] || {};
  const eigene = new Set([m.bewohner, m.eigentuemer].filter(Boolean).map(x => x.toLowerCase()));
  return gruppenNamen(verteiler).some((gn) => {
    const g = gn.toLowerCase();
    if (eigene.has(g)) return true;
    const live = g.match(/^verwaltung:(bewohner|eigentuemer|mieter)(:|$)/);
    return !!live;
  });
}

// Gruppe der Hausverwaltung, die diese Rundmail zusaetzlich bekommt (oder null).
function verwaltungsGruppeFuerVerteiler(verteiler) {
  return istBewohnerRundmail(verteiler) ? VERWALTUNG_GROUPS[verteilerStweg(verteiler)] : null;
}

// Darf ein Absender mit diesen Authentik-Gruppen als Hausverwaltung an den
// Verteiler senden? Nur die Verwaltung DIESER STWEG (ohne Übergangsgruppe: die
// alte Gruppe „Verwaltung“ prueft der Server ueber den Vertrag, siehe
// verwaltungDarfSenden in server.js).
function verwaltungsGruppeDarfSenden(userGroupNames, verteiler) {
  const nr = verteilerStweg(verteiler);
  return !!nr && verwaltungGruppenStwegs(userGroupNames || []).has(nr);
}

module.exports = { istBewohnerRundmail, verwaltungsGruppeFuerVerteiler, verwaltungsGruppeDarfSenden, verteilerStweg };
