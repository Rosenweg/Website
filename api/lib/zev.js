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

// Mail-Felder der ZEV-Konfiguration mit der Beschriftung der Seite (Z6):
// Fehlermeldungen nennen die Beschriftung, nicht den internen Feldnamen.
const ZEV_MAIL_FELDER = [
  ['archiv_mailbox', 'Archiv-Postfach'],
  ['invoice_email', 'Rechnungsadresse Verwaltung'],
  ['axova_email', 'Axova-Mailadresse'],
  ['allgemein_email', 'Allgemeinzähler-Empfänger'],
];

// Liefert null oder die Meldung fuer das erste ungueltige Mail-Feld.
function zevMailFeldFehler(body) {
  const b = body || {};
  for (const [feld, beschriftung] of ZEV_MAIL_FELDER) {
    const v = typeof b[feld] === 'string' ? b[feld].trim() : '';
    if (v && !isValidEmail(v)) return `Ungültige E-Mail-Adresse im Feld „${beschriftung}“`;
  }
  return null;
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

// ─── Alias-Domain/-Prefix aus dem Formular (Z2) ──────────────────────────
// Bestimmen, welche Mailcow-Aliase Sync und Orphan-Cleanup anfassen; aendern
// duerfen sie nur Technik/Praesident. Andere: bisherige Werte bleiben; schicken
// sie abweichende Werte, gibt es eine verstaendliche Meldung statt stillem
// Verwerfen. Rueckgabe { domain, prefix } oder { status, error }.
function zevAliasAusFormular({ darfAlias, prev, body }) {
  const t = v => (typeof v === 'string' && v.trim()) ? v.trim().toLowerCase() : null;
  const alt = { domain: t(prev && prev.alias_domain) || 'rosenweg9.ch', prefix: t(prev && prev.alias_prefix) || 'zev' };
  const b = body || {};
  if (!darfAlias) {
    const geaendert = (t(b.alias_domain) && t(b.alias_domain) !== alt.domain)
      || (t(b.alias_prefix) && t(b.alias_prefix) !== alt.prefix);
    if (geaendert) return { status: 403, error: 'Alias-Domain und Alias-Prefix ändern nur Technik oder Präsident. Die übrigen Felder bitte ohne diese Änderung speichern.' };
    return alt;
  }
  const domain = t(b.alias_domain) || 'rosenweg9.ch';
  const prefix = t(b.alias_prefix) || 'zev';
  if (!ZEV_DOMAIN_RE.test(domain)) return { status: 400, error: 'Ungültige Alias-Domain (Beispiel: rosenweg9.ch)' };
  if (!ZEV_PREFIX_RE.test(prefix)) return { status: 400, error: 'Ungültiger Alias-Prefix (Kleinbuchstaben, Ziffern, Bindestrich; Beispiel: zev)' };
  return { domain, prefix };
}

// ─── Aktueller Bewohner und Wechsel-Meldung (Z4) ─────────────────────────
// Aktueller Bewohner einer Wohnung aus ihren aktiven Kontakten: Mieter >
// Bewohner > Eigentuemer, innerhalb der Rolle nach sort_order, dann id. Nach
// ihm heisst der ZEV-Alias. Gleiche Regel wie resolveZevForStweg.
const ZEV_ROLLEN_RANG = { mieter: 1, bewohner: 2, eigentuemer: 3 };
function zevAktuellerBewohner(kontakte) {
  const ks = (kontakte || []).filter(k => k && ZEV_ROLLEN_RANG[k.rolle]);
  const so = k => (k.sort_order == null ? Infinity : Number(k.sort_order));
  ks.sort((a, b) => (ZEV_ROLLEN_RANG[a.rolle] - ZEV_ROLLEN_RANG[b.rolle]) || (so(a) - so(b)) || (Number(a.id) - Number(b.id)));
  return ks[0] || null;
}

// Muss ein neuer Kontakt `k` dem Messdienst gemeldet werden? Mieter/Bewohner
// wie bisher immer. Eigentuemer nur, wenn er heute der aktuelle Bewohner ist
// (selbst bewohnte Wohnung, Wechsel nur mit Rolle Eigentuemer) – sonst aendert
// sich der Alias nicht (vermietete Wohnung verkauft) und es gibt keine Meldung.
function zevWechselMelden(k, kontakteDerWohnung) {
  if (!k) return false;
  if (k.rolle === 'mieter' || k.rolle === 'bewohner') return true;
  if (k.rolle !== 'eigentuemer') return false;
  const occ = zevAktuellerBewohner(kontakteDerWohnung);
  return !!occ && Number(occ.id) === Number(k.id);
}

// ─── Admin-Rechte je STWEG (L6, Rosenweg ZEV) ─────────────────────────────
// Konfiguration und Wohnungen (Namen und Mails der Bewohner) sehen nur der
// Ausschuss oder die Verwaltung GENAU DIESER STWEG, Technik und Praesident.
// Eine andere Gruppe der STWEG reicht nicht: z. B. der Ausschuss von STWEG 5,
// der in Haus 9 wohnt, ist dort nur Bewohner. Gleiche Regel wie beim Schreiben
// (stwegSchreibErlaubt in server.js) und bei /api/zev/rechnungen/:stweg.
const { isTechnik, isPraesident, getAusschussStwegs, isVerwaltungFor } = require('./groups');

function zevAdminFuerStweg(groups, stweg) {
  const g = groups || [];
  const nr = Number(stweg);
  if (!Number.isInteger(nr) || nr < 1) return false;
  if (isTechnik(g) || isPraesident(g)) return true;
  return getAusschussStwegs(g).has(nr) || isVerwaltungFor(g, nr);
}

const ZUGRIFF_RANG = { none: 0, read: 1, write: 2 };
// Rechte der App je STWEG (L1): lesen/schreiben = Seitenrecht `wohnungsverwaltung`
// UND Ausschuss/Verwaltung dieser STWEG (T/P immer); alias nur T/P.
function zevRechte(groups, stweg, zugriff) {
  const g = groups || [];
  const tp = isTechnik(g) || isPraesident(g);
  const rang = tp ? 2 : (ZUGRIFF_RANG[zugriff] || 0);
  const admin = zevAdminFuerStweg(g, stweg);
  return { lesen: admin && rang >= 1, schreiben: admin && rang >= 2, alias: tp };
}

// PDF fuer Admins (L5, Entscheid Stefan 28.11.2026): Ausschuss und Verwaltung
// der STWEG der Rechnung (T/P immer) duerfen PDFs UNZUGEORDNETER und
// ALLGEMEINZAEHLER-Rechnungen oeffnen, damit sie richtig zuordnen koennen.
// Wohnungsrechnungen bleiben privat. Rechnung ohne STWEG: nur T/P.
function zevAdminDarfPdf(groups, rechnung, zugriff) {
  if (!rechnung) return false;
  const zu = rechnung.zuordnung || 'unzugeordnet';
  if (zu !== 'unzugeordnet' && zu !== 'allgemein') return false;
  const g = groups || [];
  if (isTechnik(g) || isPraesident(g)) return true;
  if (rechnung.stweg == null) return false;
  return zevRechte(g, rechnung.stweg, zugriff).lesen;
}

// ─── Datumsfelder (L2) ────────────────────────────────────────────────────
// smart-me schreibt dd.mm.yyyy; die DB speichert den Text. Die API liefert
// zusaetzlich *_iso (yyyy-mm-dd), die alten Felder bleiben.
function zevIsoDatum(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  let j, mo, d;
  if (m) { d = +m[1]; mo = +m[2]; j = +m[3]; }
  else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) { j = +m[1]; mo = +m[2]; d = +m[3]; }
  else return null;
  const dt = new Date(Date.UTC(j, mo - 1, d));
  if (dt.getUTCFullYear() !== j || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${j}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const ZEV_DATUMSFELDER = ['rechnungsdatum', 'zeitraum_von', 'zeitraum_bis'];
function zevMitIso(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of ZEV_DATUMSFELDER) if (f in row) out[`${f}_iso`] = zevIsoDatum(row[f]);
  return out;
}

// ─── Verbrauchsstatistik (L3) ─────────────────────────────────────────────
// Bisher im Browser (zev-meine-rechnungen.html): je Jahr Summe der kWh aller
// Positionen, Solar = Positionsname enthaelt „solar“. Jetzt hier, damit Web
// und App dieselbe Regel nutzen. Jahr = Beginn des Abrechnungszeitraums, sonst
// Rechnungsdatum, sonst Empfang. Preise in Rp./kWh als gewichtetes Mittel.
const istSolar = name => /solar/i.test(String(name || ''));
const rund = (n, st = 1) => Math.round(n * 10 ** st) / 10 ** st;

function zevJahr(r) {
  const iso = zevIsoDatum(r.zeitraum_von) || zevIsoDatum(r.rechnungsdatum) || zevIsoDatum(r.empfangen_am);
  return iso ? Number(iso.slice(0, 4)) : null;
}

function zevStatistik(rechnungen) {
  const jahre = new Map();
  for (const r of rechnungen || []) {
    const jahr = zevJahr(r);
    if (!jahr) continue;
    const j = jahre.get(jahr) || { jahr, anzahl: 0, kwh: 0, solar_kwh: 0, netz_kwh: 0, chf: 0, _solarChf: 0, _netzChf: 0, _solarKwhPreis: 0, _netzKwhPreis: 0 };
    j.anzahl++;
    if (Number.isFinite(Number(r.betrag_chf)) && r.betrag_chf != null) j.chf += Number(r.betrag_chf);
    let pos = r.positionen;
    if (typeof pos === 'string') { try { pos = JSON.parse(pos); } catch { pos = []; } }
    for (const p of Array.isArray(pos) ? pos : []) {
      const kwh = Number(p && p.kwh);
      if (p == null || p.kwh == null || !Number.isFinite(kwh)) continue;
      j.kwh += kwh;
      const total = Number(p.total);
      if (istSolar(p.name)) {
        j.solar_kwh += kwh;
        if (Number.isFinite(total) && p.total != null) { j._solarChf += total; j._solarKwhPreis += kwh; }
      } else {
        j.netz_kwh += kwh;
        if (Number.isFinite(total) && p.total != null) { j._netzChf += total; j._netzKwhPreis += kwh; }
      }
    }
    jahre.set(jahr, j);
  }
  return [...jahre.values()].sort((a, b) => b.jahr - a.jahr).map(j => ({
    jahr: j.jahr,
    anzahl: j.anzahl,
    kwh: rund(j.kwh),
    solar_kwh: rund(j.solar_kwh),
    netz_kwh: rund(j.netz_kwh),
    solar_anteil: j.kwh > 0 ? Math.round(j.solar_kwh / j.kwh * 100) : 0,
    chf: rund(j.chf, 2),
    rp_kwh_solar: j._solarKwhPreis > 0 ? rund(j._solarChf / j._solarKwhPreis * 100, 2) : null,
    rp_kwh_netz: j._netzKwhPreis > 0 ? rund(j._netzChf / j._netzKwhPreis * 100, 2) : null,
  }));
}

module.exports = { zevSlug, zevAliasAddress, isValidEmail, zevGotoTargets, zevBewohnendePartei, zevDarfRechnungSehen, zevStwegFuerEmpfaenger, zevAliasAusFormular, zevAktuellerBewohner, zevWechselMelden, zevMailFeldFehler, ZEV_MAIL_FELDER,
  zevAdminFuerStweg, zevRechte, zevAdminDarfPdf, zevIsoDatum, zevMitIso, zevStatistik, zevJahr };
