// ZEV / smart-me Strom-Abrechnung — reine Helfer (kein DB/Netz-Bezug, testbar).
// Pro Eigentuemer ein Mailcow-Alias `zev.<name>@<domain>`; der Name wird aus dem
// Eigentuemer-Namen der Wohnung slug-ifiziert (Umlaute -> ae/oe/ue, Leerzeichen
// -> Punkt). Beispiel: "Erika Muster" -> "zev.erika.muster@rosenweg9.ch".

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
    && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(e.trim());
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

// ─── Sicht auf die Online-Rechnungen („Meine ZEV-Rechnungen“) ─────────────
// Bewohnende Partei einer Wohnung: ist ein aktiver Mieter da, sind das Mieter
// und Bewohner (Eigentuemerin vermietet); sonst Bewohner und Eigentuemer
// (selbst bewohnt). Verwalter gehoeren nie dazu.
function zevBewohnendePartei(kontakte) {
  const rollen = new Set((kontakte || []).map(k => k && k.rolle));
  return rollen.has('mieter') ? new Set(['mieter', 'bewohner']) : new Set(['bewohner', 'eigentuemer']);
}

// Darf `email` die Rechnung `rechnung` ({ wohnung_id, bewohner_email }) sehen?
// `kontakte` = aktive Kontakte der Wohnung (nicht archiviert, gueltig_ab <= heute),
// `zevAktiv` = ZEV-Modul der STWEG an, `eigentuemerSiehtMieter` = Schalter der STWEG.
//  1. Eigene Rechnung (Empfaengeradresse = eigene Adresse): immer, auch nach Auszug.
//  2. Schalter an: Eigentuemerin der Wohnung sieht alle Rechnungen der Wohnung.
//  3. Sonst nur die bewohnende Partei, und nur Rechnungen, deren Empfaenger
//     heute selbst zur bewohnenden Partei gehoert (keine Vormieter-Rechnungen,
//     keine Rechnungen der vermietenden Eigentuemerin an die Mieter).
function zevDarfRechnungSehen({ email, rechnung, kontakte, zevAktiv, eigentuemerSiehtMieter }) {
  const me = String(email || '').trim().toLowerCase();
  if (!me || !rechnung) return false;
  const empf = String(rechnung.bewohner_email || '').trim().toLowerCase();
  if (empf && empf === me) return true;
  if (!zevAktiv || rechnung.wohnung_id == null) return false;
  const ks = (kontakte || []).filter(k => k && Number(k.wohnung_id) === Number(rechnung.wohnung_id));
  const meineRollen = ks.filter(k => String(k.email || '').trim().toLowerCase() === me).map(k => k.rolle);
  if (!meineRollen.length) return false;
  if (eigentuemerSiehtMieter === true && meineRollen.includes('eigentuemer')) return true;
  if (!empf) return false;
  const partei = zevBewohnendePartei(ks);
  const empfRollen = ks.filter(k => String(k.email || '').trim().toLowerCase() === empf).map(k => k.rolle);
  return meineRollen.some(r => partei.has(r)) && empfRollen.some(r => partei.has(r));
}

// ─── STWEG einer nicht zugeordneten Rechnung (Z1) ─────────────────────────
// Eine Rechnung ohne Alias-Treffer gehoert trotzdem zu der Anlage, deren
// Adressen sie erreicht hat. Reihenfolge (nur aktive ZEV-Konfigurationen):
//  1. Empfaenger passt auf `prefix.*@domain` genau einer STWEG,
//  2. Empfaenger ist das Archiv-Postfach genau einer STWEG,
//  3. es gibt nur eine aktive ZEV-STWEG (heute STWEG 3 / Haus 9: ein Postfach).
// Sonst null: dann bleibt die Rechnung bei Technik/Praesident.
function zevStwegFuerEmpfaenger(recips, cfgs) {
  const adr = [...new Set((recips || []).map(r => String(r || '').trim().toLowerCase()).filter(Boolean))];
  const aktiv = (cfgs || []).filter(c => c && c.aktiv !== false && Number.isInteger(Number(c.stweg)));
  const eindeutig = (liste) => {
    const set = new Set(liste.map(c => Number(c.stweg)));
    return set.size === 1 ? [...set][0] : null;
  };
  const perAlias = aktiv.filter(c => {
    const p = String(c.alias_prefix || 'zev').toLowerCase();
    const d = String(c.alias_domain || '').toLowerCase();
    if (!ZEV_PREFIX_RE.test(p) || !ZEV_DOMAIN_RE.test(d)) return false;
    return adr.some(a => a.startsWith(p + '.') && a.endsWith('@' + d));
  });
  if (perAlias.length) return eindeutig(perAlias);
  const perArchiv = aktiv.filter(c => c.archiv_mailbox && adr.includes(String(c.archiv_mailbox).trim().toLowerCase()));
  if (perArchiv.length) return eindeutig(perArchiv);
  return eindeutig(aktiv);
}

module.exports = { zevSlug, zevAliasAddress, isValidEmail, zevGotoTargets, zevBewohnendePartei, zevDarfRechnungSehen, zevStwegFuerEmpfaenger };
