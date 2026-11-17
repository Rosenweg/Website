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
// Prefix/Domain aus zev_config werden hart geprueft: ungueltige Werte (Altbestand,
// manuelle DB-Aenderung) fallen auf die Vorgabe zurueck, statt beliebige
// Mailcow-Aliase zu erzeugen bzw. zu ueberschreiben.
const ZEV_PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ZEV_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
function zevAliasAddress(name, prefix, domain) {
  const slug = zevSlug(name);
  if (!slug) return null;
  const p = String(prefix || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  return `${ZEV_PREFIX_RE.test(p) ? p : 'zev'}.${slug}@${ZEV_DOMAIN_RE.test(d) ? d : 'rosenweg9.ch'}`;
}

// E-Mail grob validieren (fuer goto-Targets, damit kein Muell in Mailcow landet).
// Keine Kommas/Steuerzeichen: goto ist eine Komma-Liste.
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 254 && !/[,;\x00-\x1f\x7f]/.test(e)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
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
