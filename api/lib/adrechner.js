// Windows-Rechner aus dem Samba-AD lesen (26.11.2026, Stefan).
//
// Warum: Seit PR #93 lassen sich Windows-Rechner auf /stationen von Hand
// eintragen, damit ihr Anmeldeskript (drucker.ps1) den Standarddrucker
// erfährt. Jeden Rechner, der der Domäne beitritt, zusätzlich von Hand
// abzutippen, vergisst man aber — und ein vergessener Rechner fällt still auf
// DruckerR9 zurück. Das AD kennt ihn ohnehin; also liest die Verwaltung ihn
// dort und teilt ihm bei der Aufnahme EINMAL Haus und Drucker zu.
//
// Nur lesend. Das Konto ist das, mit dem die Stationen der Domäne beitreten
// (STATION_AD_JOIN_USER/-PASSWORD, steht ohnehin in der Umgebung der API):
// Computerobjekte liest im AD jedes angemeldete Konto, ein eigenes
// Lesekonto wäre ein weiteres Geheimnis ohne zusätzlichen Nutzen. Wer doch
// eins will, setzt AD_LESE_USER/AD_LESE_PASSWORD — das gewinnt.
const { neuerClient, AD_DOMAIN, AD_BASE_DN } = require('./adauth');
const { HAEUSER } = require('./haeuser');
const { DRUCKER } = require('./stationconfig');

// userAccountControl-Bits (MS-ADTS 2.2.16)
const UAC_DEAKTIVIERT = 0x2;
const UAC_DC = 0x2000;              // SERVER_TRUST_ACCOUNT: Domain Controller
const UAC_RODC = 0x4000000;         // PARTIAL_SECRETS_ACCOUNT: schreibgeschützter DC
const DC_GRUPPEN = new Set(['516', '521']); // Domain Controllers / Read-only DCs

// ─── Standort aus OU oder Name ──────────────────────────────────────
//
// Heute (26.11.2026) liegen alle Windows-Rechner in OU=Windows, nicht nach
// Haus sortiert. Die OU-Regel steht trotzdem hier und geht VOR dem Namen:
// wer Rechner in eine Haus-OU schiebt, hat das bewusst getan, ein Name
// dagegen ist oft historisch.
//
// Gesucht wird nur am Anfang des Namens — "WIN11-1" ist Windows 11, kein
// Haus 11, und "DESKTOP-R13-…" ist ein Zufallsname, auf den man sich nicht
// verlassen soll. Die Hausnummer muss es geben (lib/haeuser.js), sonst gilt
// der Standort als unbekannt.
//
//   Quelle  Muster (Gross/klein egal)        Beispiel          Haus
//   OU      OU=Rosenweg <n> | OU=Haus <n>    OU=Rosenweg 13    13
//           OU=R<n> | OU=RW<n>               OU=R9             9
//   Name    R<n>-…                           R9-PC1            9
//           RW<n>-…                          RW13-BUERO        13
//           ROSENWEG<n>-…                    ROSENWEG9-PC      9
const STANDORT_REGELN = [
  { quelle: 'ou', muster: /^(?:rosenweg|haus)\s*-?\s*(\d{1,2})$/i, text: 'OU „Rosenweg <n>“ oder „Haus <n>“' },
  { quelle: 'ou', muster: /^rw?(\d{1,2})$/i, text: 'OU „R<n>“ oder „RW<n>“' },
  { quelle: 'name', muster: /^(?:rosenweg|rw|r)(\d{1,2})-/i, text: 'Name beginnt mit R<n>-, RW<n>- oder ROSENWEG<n>-' },
];

/** OU-Namen eines DN, innen nach aussen: 'CN=X,OU=A,OU=B,DC=…' -> ['A','B'] */
function ousVon(dn) {
  return String(dn || '').split(/,(?=\s*[A-Za-z]+=)/)
    .map((t) => /^\s*OU=(.+)$/i.exec(t)?.[1]?.trim())
    .filter(Boolean);
}

/**
 * Haus aus OU und Name ableiten.
 * @returns {{haus:number|null, regel:string|null}}
 */
function standortAbleiten(name, dn) {
  const ous = ousVon(dn);
  for (const r of STANDORT_REGELN) {
    const kandidaten = r.quelle === 'ou' ? ous : [String(name || '')];
    for (const k of kandidaten) {
      const m = r.muster.exec(k);
      if (m && HAEUSER.includes(Number(m[1]))) {
        return { haus: Number(m[1]), regel: r.quelle === 'ou' ? `OU ${k}` : `Name ${name}` };
      }
    }
  }
  return { haus: null, regel: null };
}

/** Der Drucker des Hauses (stationconfig.DRUCKER, Feld haus) — oder null. */
function druckerVonHaus(haus) {
  return DRUCKER.find((d) => d.haus === haus)?.name || null;
}

// ─── Abfrage ────────────────────────────────────────────────────────

function zugangsdaten() {
  const user = process.env.AD_LESE_USER || process.env.STATION_AD_JOIN_USER || '';
  const passwort = process.env.AD_LESE_PASSWORD || process.env.STATION_AD_JOIN_PASSWORD || '';
  if (!user || !passwort) return null;
  return { upn: user.includes('@') ? user : `${user}@${AD_DOMAIN}`, passwort };
}

/** Lässt sich überhaupt abgleichen? (Für die Verwaltung und den Timer.) */
function adLesbar() {
  return !!zugangsdaten();
}

const erster = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Alle Windows-Computerkonten des AD, ohne Domain Controller — auch die
 * deaktivierten: der Abgleich muss sie sehen, um sie zu markieren.
 *
 * @returns {Promise<Array<{name,guid,dn,ou,betriebssystem,deaktiviert,haus,regel,drucker}>>}
 */
async function windowsRechnerLesen() {
  const z = zugangsdaten();
  if (!z) throw new Error('Kein Konto zum Lesen des AD (STATION_AD_JOIN_USER/-PASSWORD oder AD_LESE_USER/-PASSWORD)');
  const client = neuerClient();
  try {
    await client.bind(z.upn, z.passwort);
    const { searchEntries } = await client.search(AD_BASE_DN, {
      scope: 'sub',
      // Linux-Stationen treten derselben Domäne bei (operatingSystem
      // 'pc-linux-gnu'), Server oft ganz ohne Angabe — beide gehören nicht
      // hierher. Die DCs fallen unten nach Flags heraus: ein Windows-DC
      // hiesse ebenfalls "Windows Server …".
      filter: '(&(objectClass=computer)(operatingSystem=*Windows*))',
      attributes: ['cn', 'distinguishedName', 'objectGUID', 'operatingSystem',
        'operatingSystemVersion', 'userAccountControl', 'primaryGroupID'],
      explicitBufferAttributes: ['objectGUID'],
      paged: { pageSize: 500 },
    });
    return searchEntries.map((e) => {
      const uac = Number(erster(e.userAccountControl) || 0);
      const dn = String(erster(e.distinguishedName) || e.dn || '');
      const name = String(erster(e.cn) || '');
      const guid = Buffer.isBuffer(erster(e.objectGUID)) ? erster(e.objectGUID).toString('hex') : null;
      return {
        name, guid, dn, uac,
        ou: ousVon(dn).join(' / ') || null,
        primaryGroupID: String(erster(e.primaryGroupID) || ''),
        betriebssystem: [erster(e.operatingSystem), erster(e.operatingSystemVersion)].filter(Boolean).join(' ') || null,
        deaktiviert: (uac & UAC_DEAKTIVIERT) !== 0,
      };
    })
      .filter((r) => r.name && r.guid)
      .filter((r) => !(r.uac & (UAC_DC | UAC_RODC)) && !DC_GRUPPEN.has(r.primaryGroupID)
        && !/,OU=Domain Controllers,/i.test(r.dn))
      .map(({ uac, primaryGroupID, ...r }) => {
        const { haus, regel } = standortAbleiten(r.name, r.dn);
        return { ...r, haus, regel, drucker: haus ? druckerVonHaus(haus) : null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.unbind().catch(() => {});
  }
}

module.exports = {
  windowsRechnerLesen, adLesbar, standortAbleiten, druckerVonHaus, STANDORT_REGELN,
};
