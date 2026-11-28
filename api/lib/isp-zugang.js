// Internet (ISP): wer bekommt Haus-WLAN, Anschluss und VPN? (Entscheid Stefan 28.11.2026)
//
// Nur wer in der Einheit WOHNT, und erst ab dem Einzugsdatum:
//   - Rolle 'mieter' oder 'bewohner' (Mitbewohner), oder
//   - Rolle 'eigentuemer', wenn die Wohnung selbst bewohnt ist (bewohnt_von = 'eigentuemer'),
//   - Kontakt nicht archiviert (archiviert_am leer = nicht ausgezogen bzw. nicht entfernt),
//   - gueltig_ab leer oder erreicht (kuenftige Mieter erst ab Einzug).
// Nicht bewohnende Eigentuemer, Wohnungs-Verwalter ('verwalter') und 'sonstige' bekommen
// kein Haus-WLAN, keinen Anschluss (Ansicht, MAC aendern) und kein VPN ins Hausnetz.
// Technik und Praesident behalten ihren Admin-Zugang (ispIsAdmin in server.js).
//
// Dieselbe Rollenlogik wie die Bewohnergruppen (syncKontakteToAuthentik) und die
// Mieter-Sperre der Unterlagen (lib/dok-stweg-sicht.js), nur ohne den Wohnungs-Verwalter:
// der vertritt den Eigentuemer, wohnt aber nicht dort.
//
// Beim Auszug: VPN-Zugaenge sperren (vpnAbgleichPlan). Gesperrt wird nur, wer seit
// dieser Aenderung einmal als Bewohner gesehen wurde (wohnsitz_gesehen_am). Wer heute
// schon ausgezogen ist oder nie dort gewohnt hat, wird nur gemeldet, bis Stefan
// entscheidet (Liste GET /api/isp/vpn-accounts/wohnsitz).

const WOHNT_ROLLEN = ['mieter', 'bewohner'];

/** SQL-Bedingung "dieser Kontakt k an Wohnung w wohnt heute dort". */
function wohntSql(k = 'k', w = 'w') {
  return `(${k}.archiviert_am IS NULL
      AND (${k}.gueltig_ab IS NULL OR ${k}.gueltig_ab <= CURRENT_DATE)
      AND (${k}.rolle IN ('mieter', 'bewohner')
           OR (${k}.rolle = 'eigentuemer' AND COALESCE(${w}.bewohnt_von, 'eigentuemer') = 'eigentuemer')))`;
}

// Kalendertag YYYY-MM-DD; ein Date in Ortszeit (pg liefert DATE als lokale Mitternacht).
const tag = (d) => {
  if (!d) return null;
  if (d instanceof Date) {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  }
  return String(d).slice(0, 10);
};

/** Gleiche Regel in JS (Tests, Abgleich). kontakt: { rolle, bewohnt_von, gueltig_ab, archiviert_am } */
function wohntDort(kontakt, heute = new Date()) {
  if (!kontakt) return false;
  if (kontakt.archiviert_am) return false;
  const ab = tag(kontakt.gueltig_ab);
  if (ab && ab > tag(heute)) return false;
  const rolle = String(kontakt.rolle || '').toLowerCase();
  if (WOHNT_ROLLEN.includes(rolle)) return true;
  return rolle === 'eigentuemer' && String(kontakt.bewohnt_von || 'eigentuemer') === 'eigentuemer';
}

/**
 * Wie steht eine Person zu den Wohnungen? Fuer die Liste der VPN-Zugaenge ohne Wohnsitz.
 * 'wohnt' | 'kuenftig' (Einzug noch nicht erreicht) | 'eigentuemer' (bewohnt nicht) |
 * 'verwalter' | 'sonstige' | 'ausgezogen' (nur archivierte Kontakte) | 'ohne_wohnung'
 */
function wohnsitzArt(kontakte, heute = new Date()) {
  const liste = Array.isArray(kontakte) ? kontakte : [];
  if (liste.some(k => wohntDort(k, heute))) return 'wohnt';
  const aktiv = liste.filter(k => !k.archiviert_am);
  if (aktiv.some(k => wohntDort({ ...k, gueltig_ab: null }, heute))) return 'kuenftig';
  const rollen = new Set(aktiv.map(k => String(k.rolle || '').toLowerCase()));
  if (rollen.has('eigentuemer')) return 'eigentuemer';
  if (rollen.has('verwalter')) return 'verwalter';
  if (aktiv.length) return 'sonstige';
  return liste.length ? 'ausgezogen' : 'ohne_wohnung';
}

const ART_TEXT = {
  kuenftig: 'Einzug noch nicht erreicht',
  eigentuemer: 'Eigentümer, bewohnt nicht',
  verwalter: 'Wohnungs-Verwalter',
  sonstige: 'Kontakt ohne Wohnrolle',
  ausgezogen: 'ausgezogen (Kontakt archiviert)',
  ohne_wohnung: 'ohne Wohnungskontakt',
  anderes_haus: 'wohnt in einem anderen Haus als das VLAN des Zugangs',
};

/**
 * Abgleich der VPN-Zugaenge mit dem Wohnsitz.
 * konten: [{ id, user_email, gesperrt_am, wohnsitz_gesehen_am }]
 * kontakteJeEmail: Map(email -> [kontakt])
 * Ergebnis: { gesehen: [id], sperren: [{ id, email, art }], melden: [{ id, email, art }] }
 *   gesehen  Person wohnt: Zeitstempel setzen (ab dann wird beim Auszug gesperrt)
 *   sperren  war seit der Aenderung Bewohner, wohnt jetzt nicht mehr -> sperren
 *   melden   wohnt nicht und wurde nie als Bewohner gesehen (Altbestand) -> nur melden
 */
function vpnAbgleichPlan(konten, kontakteJeEmail, heute = new Date()) {
  const plan = { gesehen: [], sperren: [], melden: [] };
  for (const k of konten || []) {
    if (!k || k.gesperrt_am) continue;
    const email = String(k.user_email || '').toLowerCase();
    const kontakte = kontakteJeEmail.get(email) || [];
    let art = wohnsitzArt(kontakte, heute);
    // Umzug in ein anderes Haus: ein Zugang ins Clients-VLAN eines Hauses gilt nur,
    // solange die Person in diesem Haus wohnt (kontakt.vlan = VLAN der Einheit).
    // VLAN 9 (Kooperation/Technik) und eigene Netze sind kein Haus-VLAN.
    const vlan = vlanAusNotiz(k.notizen);
    if (art === 'wohnt' && hausAusVlan(vlan)
        && !kontakte.some(x => wohntDort(x, heute) && Number(x.vlan) === vlan)) art = 'anderes_haus';
    if (art === 'wohnt') plan.gesehen.push(k.id);
    else if (k.wohnsitz_gesehen_am) plan.sperren.push({ id: k.id, email, art });
    else plan.melden.push({ id: k.id, email, art });
  }
  return plan;
}

/** VLAN eines Zugangs aus notizen ('vlan=99 name=…' bzw. 'Station x, VLAN 99'). */
function vlanAusNotiz(notizen) {
  const m = /(?:^|\s)vlan=(\d+)|VLAN (\d+)/.exec(String(notizen || ''));
  return m ? parseInt(m[1] || m[2], 10) : null;
}

/** Oeffentlicher WireGuard-Schluessel: 32 Byte in Base64 (44 Zeichen, endet auf '='). */
function wgPublicKeyGueltig(s) {
  const t = String(s || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(t)) return false;
  return Buffer.from(t, 'base64').length === 32;
}

/** ?nur=meine: auch fuer Technik/Praesident nur die eigenen Eintraege (Apps "Meine …"). */
function nurMeine(query) {
  const v = String(query?.nur ?? query?.nur_meine ?? '').toLowerCase();
  return v === 'meine' || v === '1' || v === 'true' || v === 'ja';
}

/** Haus-Nummer aus dem Client-VLAN (Schema <Haus>*10+9, z. B. 99 -> 9, 139 -> 13). */
function hausAusVlan(vlan) {
  const n = parseInt(vlan, 10);
  if (!Number.isFinite(n) || n % 10 !== 9 || n < 19) return null;
  const haus = (n - 9) / 10;
  return haus >= 1 && haus <= 18 ? haus : null;
}

module.exports = {
  WOHNT_ROLLEN, ART_TEXT, wohntSql, wohntDort, wohnsitzArt, vpnAbgleichPlan, vlanAusNotiz,
  wgPublicKeyGueltig, nurMeine, hausAusVlan,
};
