'use strict';
// Benutzernamen fuer Personenkonten: immer vorname.nachname (klein, ae/oe/ue/ss,
// Akzente weg). Der Benutzername ist auf allen Diensten die Kennung (Authentik,
// AD-sAMAccountName ueber ad-sync, Unix-Konto, Home \\dokumente\home\<name>),
// deshalb nie aus dem Mail-Teil vor dem @ bilden: Platzhalter wie
// druckerr9+vorname.nachname@… ergaben sonst "druckerr9vorname.nachname".

// Namenszusaetze, die zum Nachnamen gehoeren ("Nicola Di Meo" -> nicola.dimeo).
const PARTIKEL = new Set(['von', 'van', 'vom', 'zu', 'zum', 'de', 'di', 'da', 'del', 'della', 'dello',
  'dos', 'das', 'do', 'du', 'der', 'den', 'des', 'la', 'le', 'lo', 'ten', 'ter', 'al', 'el', 'st']);

// Firmen und Sammeladressen sind keine Personen -> kein Vorschlag.
const KEINE_PERSON = /\b(ag|gmbh|sa|sagl|s[aà]rl|kg|holding|verwaltung|immobilien|stweg|genossenschaft|erben|erbengemeinschaft)\b/i;

const RESERVIERT = new Set(['root', 'admin', 'administrator', 'akadmin', 'ansible', 'github', 'claude',
  'nobody', 'daemon', 'postmaster', 'www-data', 'backup', 'guest', 'gast']);

// Gleiche Form, die POST /api/admin/users fuer Nicht-Admins verlangt.
const FORM = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

function transliteriere(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae').replace(/[øœ]/g, 'oe').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ı/g, 'i')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Ein Namensteil: nur a-z, 0-9 und innere Bindestriche ("Müller-Eichin" -> mueller-eichin).
function teil(s) {
  return transliteriere(s).replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function zusammensetzen(vor, nach) {
  const v = teil(vor);
  const n = teil(nach);
  if (!v || !n) return null;
  const u = `${v}.${n}`;
  return FORM.test(u) ? u : null;
}

// Aus getrennten Feldern (personen.vorname / personen.nachname). Erster Vorname zaehlt.
function ausVornameNachname(vorname, nachname) {
  const v = String(vorname || '').trim().split(/\s+/)[0];
  const n = String(nachname || '').trim().split(/\s+/).join('');
  return zusammensetzen(v, n);
}

// Aus einem Vollnamen "Vorname [weitere Vornamen] [Partikel] Nachname".
function ausVollname(name) {
  let s = String(name || '').replace(/\bc\/o\b.*$/i, '').replace(/[,;(].*$/, '').trim();
  if (!s || KEINE_PERSON.test(s)) return null;
  const w = s.split(/\s+/).filter(Boolean);
  if (w.length < 2) return null;
  let i = w.length - 1;
  while (i > 1 && PARTIKEL.has(transliteriere(w[i - 1]))) i--;
  return zusammensetzen(w[0], w.slice(i).join(''));
}

// Tag einer Platzhalter-Adresse druckerr<N>+vorname.nachname@… (Post an den Drucker).
// Auch die nackte Druckeradresse (druckerr9@…) ist keine Person: aus ihr entstand
// am 22.4.2026 das Sammelkonto "druckerr9" mit Gruppen aus fuenf STWEG.
const PLATZHALTER = /^drucker(?:r\d+)?\+([^@]+)@/i;
const DRUCKERADRESSE = /^drucker(?:r\d+)?(?:\+[^@]*)?@/i;
function istPlatzhalter(email) {
  return DRUCKERADRESSE.test(String(email || '').trim());
}
function ausPlatzhalter(email) {
  const m = String(email || '').trim().match(PLATZHALTER);
  if (!m) return null;
  const t = m[1].split('.').filter(Boolean);
  return t.length >= 2 ? zusammensetzen(t[0], t[t.length - 1]) : null;
}

// Vorschlag fuer ein neues Konto. Reihenfolge: getrennte Namensfelder, Vollname,
// Platzhalter-Tag. Keine Ableitung aus echten Mailadressen (romjac.smile@… ist
// kein Name). null = kein brauchbarer Name -> Rueckfrage an Technik.
function vorschlag({ vorname, nachname, name, email } = {}) {
  return ausVornameNachname(vorname, nachname) || ausVollname(name) || ausPlatzhalter(email) || null;
}

// Erster freier Name mit Ziffer (vorname.nachname2 …) fuer einen bewussten Entscheid
// im Dialog; automatisch wird bei Kollision nie nummeriert.
async function freierMitZiffer(basis, belegt, max = 20) {
  for (let i = 2; i <= max; i++) {
    const n = `${basis}${i}`;
    if (!RESERVIERT.has(n) && !(await belegt(n))) return n;
  }
  return null;
}

module.exports = { transliteriere, ausVornameNachname, ausVollname, ausPlatzhalter, istPlatzhalter, vorschlag, freierMitZiffer, RESERVIERT, FORM };
