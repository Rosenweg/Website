// Verteiler-Gate je Verteiler (Befund F1, Rundmail-Prüfung Nov. 2026).
//
// Mit nativem Fanout (VERTEILER_NATIVE_FANOUT, Standard an) verteilt Mailcow die
// Mails an Verteiler-Adressen selbst; die API sieht sie nicht. Die einzige
// Absenderprüfung ist dann das Rspamd-Gate (mailcow/mailcow-verteiler-gate.py).
// Frueher galt dort EINE globale Liste: jede Adresse aus personen und
// wohnungen_kontakte sowie jede Mailcow- und Verwaltungs-Domain durfte an JEDEN
// gesperrten Verteiler senden, auch an den einer fremden STWEG.
//
// Jetzt bekommt jeder gesperrte Verteiler (external_allowed = false) seine
// eigene Liste erlaubter Absender. Dieselbe Liste prueft die API im Rueckfall
// ohne nativen Fanout (processInboundEmail), damit beide Wege gleich entscheiden.
//
// Regeln je Verteiler (Entscheid Stefan, 28.11.2026):
//   - Technik und Präsident: an alle.
//   - System-/Funktionsadressen (Mailcow-Postfaecher der Verteiler-Domain,
//     Gateway-User der API, STWEG-uebergreifende Verteiler-Adressen wie technik@)
//     und VERTEILER_GATE_ALLE_LISTEN: an alle.
//   - Verteiler einer STWEG N (stweg 1..8):
//       * ohne allowed_sender_groups: Personen dieser STWEG (Eigentuemer, Mieter
//         und weitere Kontakte der Wohnungen, gleichgestellt; Authentik-Gruppen
//         Bewohner/Eigentuemer/Ausschuss von N);
//       * mit allowed_sender_groups: nur Mitglieder dieser Gruppen;
//       * immer: die Hausverwaltung von N (Gruppe stwegN-verwaltung, Übergang
//         „Verwaltung“, Adressen und Domains der Verwaltungen mit Vertrag fuer N
//         oder fuer alle STWEGs).
//   - STWEG-uebergreifende Verteiler (stweg 0/NULL):
//       * ohne allowed_sender_groups: alle bekannten Personen und alle aktiven
//         Verwaltungen (wie bisher; z. B. praesident@ als Kontaktadresse);
//       * mit allowed_sender_groups: nur diese Gruppen und die Verwaltung aller
//         STWEGs (Vertrag ohne STWEG, Übergangsgruppe oder in jeder
//         stwegN-verwaltung). eigentuemer@/eigentuemer-direkt@: Ausschuss +
//         Verwaltung (Entscheid Stefan 28.11.2026, Migration in server.js).
// Freemail- und eigene Domains werden nie als ganze Domain freigegeben, nur als
// einzelne Adresse (sonst duerfte jede gmail.com-Adresse senden).

const { STWEG_GROUPS, VERWALTUNG_GROUPS, VERWALTUNG_UEBERGANG_GLOBAL } = require('./groups');

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'gmx.ch', 'gmx.net', 'gmx.de', 'gmx.at', 'web.de', 't-online.de',
  'bluewin.ch', 'sunrise.ch', 'hispeed.ch', 'swissonline.ch', 'hotmail.com', 'hotmail.ch', 'outlook.com',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com',
  'proton.me', 'pm.me', 'aol.com', 'mail.ch', 'yandex.com',
]);

const norm = (e) => String(e || '').trim().toLowerCase();
const istAdresse = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const domainVon = (e) => { const i = e.lastIndexOf('@'); return i > 0 ? e.slice(i + 1) : ''; };

function stwegNr(v) {
  const n = parseInt(v && v.stweg, 10);
  return Number.isFinite(n) && STWEG_GROUPS[n] ? n : null;
}

/** Ist der Verteiler gesperrt (nur erlaubte Absender)? Nur aktive Adressen der Verteiler-Domain. */
function istGesperrt(v, verteilerDomain) {
  const a = norm(v && v.email_address);
  return !!v && v.active !== false && v.external_allowed !== true && a.endsWith(`@${norm(verteilerDomain)}`);
}

/**
 * Erlaubte Absender je gesperrtem Verteiler.
 * @param {object} d
 *   verteiler        Zeilen aus email_verteiler
 *   verteilerDomain  z. B. rosenweg4303.ch
 *   gruppe(name)     -> Adressen der Authentik-Gruppe (inkl. Untergruppen)
 *   personenJeStweg  Map<stweg, Adressen> aus Wohnungs-Kontakten (nicht archiviert)
 *   verwaltungen     [{ stweg: Zahl|null, adressen: [...] }] aktive Verwaltungen im Vertrag
 *   systemAdressen   Adressen, die an alle duerfen
 *   eigeneDomains    Domains, die nie als ganze Domain freigegeben werden (Mailcow-Domains)
 * @returns {Array<{id, address, stweg, emails: string[], domains: string[]}>}
 */
function gateEintraege(d) {
  const gruppe = (name) => (d.gruppe(name) || []).map(norm).filter(istAdresse);
  const eigene = new Set([...(d.eigeneDomains || []), d.verteilerDomain].map(norm).filter(Boolean));
  const technikPraesident = [...gruppe('technik'), ...gruppe('Präsident'), ...gruppe('praesident')];
  const system = (d.systemAdressen || []).map(norm).filter(istAdresse);
  const personenVon = (n) => (d.personenJeStweg.get(n) || []).map(norm).filter(istAdresse);
  const stwegGruppen = (n) => Object.values(STWEG_GROUPS[n] || {}).flatMap(gruppe);
  const verwaltungsGruppe = (n) => [...gruppe(VERWALTUNG_GROUPS[n]), ...gruppe(VERWALTUNG_UEBERGANG_GLOBAL)];

  const eintraege = [];
  for (const v of d.verteiler || []) {
    if (!istGesperrt(v, d.verteilerDomain)) continue;
    const n = stwegNr(v);
    const absGruppen = Array.isArray(v.allowed_sender_groups) ? v.allowed_sender_groups.filter(Boolean).map(String) : [];
    const emails = new Set([...technikPraesident, ...system]);
    const verwAdressen = [];

    if (absGruppen.length) absGruppen.flatMap(gruppe).forEach(e => emails.add(e));

    if (n) {
      if (!absGruppen.length) {
        personenVon(n).forEach(e => emails.add(e));
        stwegGruppen(n).forEach(e => emails.add(e));
      }
      verwaltungsGruppe(n).forEach(e => emails.add(e));
      for (const w of d.verwaltungen || []) if (w.stweg == null || Number(w.stweg) === n) verwAdressen.push(...w.adressen);
    } else if (!absGruppen.length) {
      for (const [, liste] of d.personenJeStweg) liste.map(norm).filter(istAdresse).forEach(e => emails.add(e));
      for (const k of Object.keys(STWEG_GROUPS)) stwegGruppen(Number(k)).forEach(e => emails.add(e));
      for (const k of Object.keys(VERWALTUNG_GROUPS)) verwaltungsGruppe(Number(k)).forEach(e => emails.add(e));
      for (const w of d.verwaltungen || []) verwAdressen.push(...w.adressen);
    } else {
      // Verwaltung fuer alle STWEGs: Übergangsgruppe oder in jeder stwegN-verwaltung
      gruppe(VERWALTUNG_UEBERGANG_GLOBAL).forEach(e => emails.add(e));
      const jeStweg = Object.values(VERWALTUNG_GROUPS).map(g => new Set(gruppe(g)));
      [...jeStweg[0]].filter(e => jeStweg.every(m => m.has(e))).forEach(e => emails.add(e));
      for (const w of d.verwaltungen || []) if (w.stweg == null) verwAdressen.push(...w.adressen);
    }

    const domains = new Set();
    for (const a of verwAdressen.map(norm).filter(istAdresse)) {
      emails.add(a);
      const dom = domainVon(a);
      if (dom && !FREEMAIL.has(dom) && !eigene.has(dom)) domains.add(dom);
    }
    eintraege.push({
      id: v.id, address: norm(v.email_address), stweg: n,
      emails: [...emails].sort(), domains: [...domains].sort(),
    });
  }
  return eintraege.sort((a, b) => a.id - b.id);
}

/** Darf diese Absenderadresse an den Verteiler (Eintrag aus gateEintraege)? */
function absenderErlaubt(eintrag, absender) {
  const a = norm(absender);
  if (!eintrag || !istAdresse(a)) return false;
  return eintrag.emails.includes(a) || eintrag.domains.includes(domainVon(a));
}

module.exports = { gateEintraege, absenderErlaubt, istGesperrt, FREEMAIL };
