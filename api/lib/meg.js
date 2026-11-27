// MEG (Tiefeinstellhalle) – reine Helfer fuer die Einstellplatz-Verwaltung
// (kein DB/Netz-Bezug, testbar). Genutzt von routes/meg.js.
const { getAusschussStwegs, isTechnik, isPraesident } = require('./groups');

// M1: Plaetze verwalten (volle Tabelle mit Namen, Speichern) duerfen nur der
// MEG-Ausschuss (Ausschuss STWEG 8) und Technik/Praesident. Dieselbe Regel
// bekommt die Seite ueber /einstellplaetze/rechte – sie raet nicht mehr am
// Gruppennamen („ausschuss“ irgendeiner STWEG).
function darfMegPlaetzeVerwalten(user) {
  const groups = (user && user.groups) || [];
  return !!(user && user.isAdmin) || isTechnik(groups) || isPraesident(groups) || getAusschussStwegs(groups).has(8);
}

module.exports = { darfMegPlaetzeVerwalten };
