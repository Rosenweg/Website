// Wer eine Vollmacht widerrufen darf – eine Regel fuer den Server
// (POST /api/vollmachten/:id/revoke) und die Liste (Feld darf_widerrufen,
// danach zeigt vollmachten.html den Knopf „Widerrufen“). Befund B11: Ausschuss
// und Verwaltung sehen „Alle“, duerfen aber nicht widerrufen.
const { isTechnik, isPraesident } = require('./groups');

// Technik und Praesident duerfen jede Vollmacht widerrufen.
function widerrufAdmin(groups) {
  const g = groups || [];
  return isTechnik(g) || isPraesident(g);
}

// Ist email eine der Vollmachtgeber-Adressen (Primaer-Adresse oder Liste
// vollmachten_vollmachtgeber)? Gross/Klein egal.
function istVollmachtgeber(email, primaerEmail, listeEmails) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (String(primaerEmail || '').trim().toLowerCase() === e) return true;
  return (listeEmails || []).some(x => String(x || '').trim().toLowerCase() === e);
}

// Recht ohne Status: Admin-Rolle oder Vollmachtgeber.
function darfWiderrufenRecht(groups, istGeber) {
  return widerrufAdmin(groups) || !!istGeber;
}

// Fuer eine Zeile der Liste (v.vollmachtgeber_liste = [{email, …}]): nur aktive
// Vollmachten bekommen den Knopf.
function darfWiderrufen(user, v) {
  if (!v || v.status !== 'aktiv') return false;
  const liste = Array.isArray(v.vollmachtgeber_liste) ? v.vollmachtgeber_liste.map(x => x && x.email) : [];
  return darfWiderrufenRecht(user && user.groups, istVollmachtgeber(user && user.email, v.vollmachtgeber_email, liste));
}

module.exports = { widerrufAdmin, istVollmachtgeber, darfWiderrufenRecht, darfWiderrufen };
