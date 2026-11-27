// Türschilder & Aushänge (routes/raum-qr.js): zu welcher STWEG gehoert ein Raum,
// und wer darf ihn sehen und aendern? (Befund V4)
//
// Der Raum traegt den Kurznamen des Hauses (raum_orte.kurz, z. B. „r9“ oder
// „r13“); daraus folgt die STWEG (lib/haeuser.js). „meg“/„tg“ = MEG-Tiefgarage
// (STWEG 8). Alles andere hat keine STWEG.
//
// Sicht wie bei den Reklamationen (lib/stweg-sicht.js): Technik/Praesident alles;
// Ausschuss und Hausverwaltung nur Raeume ihrer STWEG(s); Raeume ohne STWEG
// Ausschuss irgendeiner STWEG und eine Verwaltung aller STWEGs. Die Vorgabe je
// Raumtyp (ebene 'typ') wirkt in allen Haeusern – die darf nur, wer auch
// STWEG-lose Raeume aendern darf. Das Seitenrecht „reklamationen“ prueft die
// Route weiterhin vorab (requirePermission).
const { stwegVonHaus } = require('./haeuser');
const { stwegSicht, sichtErlaubt } = require('./stweg-sicht');

function stwegVonKurz(kurz) {
  const k = String(kurz || '').trim().toLowerCase();
  if (k === 'meg' || k === 'tg') return 8;
  const m = k.match(/^r(\d{1,2})$/);
  return m ? stwegVonHaus(Number(m[1])) : null;
}

function raumErlaubt(groups, ort) {
  return !!ort && sichtErlaubt(stwegSicht(groups || []), stwegVonKurz(ort.kurz));
}

function typVorgabeErlaubt(groups) {
  const s = stwegSicht(groups || []);
  return !!(s.alle || s.ohneStweg);
}

module.exports = { stwegVonKurz, raumErlaubt, typVorgabeErlaubt };
