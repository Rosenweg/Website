// ZEV / smart-me Strom-Abrechnung — reine Helfer (kein DB/Netz-Bezug, testbar).
// Pro Eigentuemer ein Mailcow-Alias `zev.<name>@<domain>`; der Name wird aus dem
// Eigentuemer-Namen der Wohnung slug-ifiziert (Umlaute -> ae/oe/ue, Leerzeichen
// -> Punkt). Beispiel: "Stefan Mueller" -> "zev.stefan.mueller@rosenweg9.ch".

// Slug fuer den Alias-Local-Part: kleinschreiben, Umlaute/Akzente entschaerfen,
// alles Nicht-Alphanumerische zu Punkten, Mehrfach-/Rand-Punkte weg.
function zevSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[àáâã]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíî]/g, 'i')
    .replace(/[òóôõ]/g, 'o').replace(/[ùúû]/g, 'u').replace(/ç/g, 'c').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}

// Vollstaendige Alias-Adresse aus Name + Prefix + Domain. Null, wenn kein Name.
function zevAliasAddress(name, prefix, domain) {
  const slug = zevSlug(name);
  if (!slug) return null;
  return `${(prefix || 'zev')}.${slug}@${(domain || 'rosenweg9.ch')}`;
}

// E-Mail grob validieren (fuer goto-Targets, damit kein Muell in Mailcow landet).
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// Baut die goto-Empfaengerliste (dedupliziert, lowercase): aktueller Bewohner +
// Archiv-Postfach + Immosense-Rechnungsadresse. Leere/ungueltige werden verworfen.
function zevGotoTargets({ bewohnerEmail, archivMailbox, invoiceEmail }) {
  const set = new Set();
  for (const e of [bewohnerEmail, archivMailbox, invoiceEmail]) {
    if (isValidEmail(e)) set.add(String(e).trim().toLowerCase());
  }
  return [...set];
}

module.exports = { zevSlug, zevAliasAddress, isValidEmail, zevGotoTargets };
