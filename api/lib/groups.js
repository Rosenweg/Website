// STWEG-Gruppen-Mapping + pure Klassifizierer — aus server.js ausgelagert.
// Rein funktional (kein DB/Authentik/Cache-Bezug). Die Authentik-/pool-
// abhaengigen Group-Resolver (resolveAncestorGroups, fetchAuthentikGroupsUsers,
// resolveGroupEmails) bleiben vorerst in server.js und folgen spaeter.

// STWEG group mapping (Authentik group names per STWEG)
const STWEG_GROUPS = {
  1: { bewohner: 'stweg1-bewohner', eigentuemer: 'stweg1-eigentuemer', ausschuss: 'stweg1-ausschuss' },
  2: { bewohner: 'stweg2-bewohner', eigentuemer: 'stweg2-eigentuemer', ausschuss: 'stweg2-ausschuss' },
  3: { bewohner: 'r9-bewohner', eigentuemer: 'r9-eigentuemer', ausschuss: 'stweg3-ausschuss' },
  4: { bewohner: 'stweg4-bewohner', eigentuemer: 'stweg4-eigentuemer', ausschuss: 'stweg4-ausschuss' },
  5: { bewohner: 'stweg5-bewohner', eigentuemer: 'stweg5-eigentuemer', ausschuss: 'stweg5-ausschuss' },
  6: { bewohner: 'r1-bewohner', eigentuemer: 'r1-eigentuemer', ausschuss: 'stweg6-ausschuss' },
  7: { bewohner: 'stweg7-bewohner', eigentuemer: 'stweg7-eigentuemer', ausschuss: 'stweg7-ausschuss' },
  8: { ausschuss: 'meg-ausschuss', eigentuemer: 'meg-eigentuemer', bewohner: 'meg-bewohner' },
};

/** Parse and validate stweg param - returns number or null */
function parseStweg(val) {
  const n = parseInt(val, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
}

/** Get STWEG numbers a user belongs to based on their groups */
function getUserStwegs(groups) {
  const stwegs = new Set();
  for (const [nr, mapping] of Object.entries(STWEG_GROUPS)) {
    const groupNames = Object.values(mapping).map(g => g.toLowerCase());
    if (groups.some(g => groupNames.includes(g.toLowerCase()))) {
      stwegs.add(parseInt(nr));
    }
  }
  return stwegs;
}

// Dokument-/Auslagen-Ordner <-> STWEG-Nummer. STWEG 8 = MEG-Tiefeinstellhalle,
// deren Ordner heisst 'meg' (nicht 'stweg8'). 'stweg8' wird uebergangsweise
// (Fileserver-Move) noch als Alias zu 8 akzeptiert.
function stwegFolderName(nr) {
  const n = parseInt(nr, 10);
  return n === 8 ? 'meg' : `stweg${n}`;
}
function folderStwegNr(folder) {
  if (folder === 'meg' || folder === 'stweg8') return 8;
  const m = String(folder).match(/^stweg(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function isTechnik(groups) {
  return groups.some(g => g.toLowerCase() === 'technik');
}
function isPraesident(groups) {
  return groups.some(g => g.toLowerCase() === 'präsident' || g.toLowerCase() === 'praesident');
}

/** Get STWEG numbers where user is Ausschuss member */
function getAusschussStwegs(groups) {
  const stwegs = new Set();
  for (const [nr, mapping] of Object.entries(STWEG_GROUPS)) {
    if (mapping.ausschuss && groups.some(g => g.toLowerCase() === mapping.ausschuss.toLowerCase())) {
      stwegs.add(parseInt(nr));
    }
  }
  return stwegs;
}

/** Check if user is Ausschuss for any STWEG */
function isAusschussForAny(groups) {
  return getAusschussStwegs(groups).size > 0;
}

// Sichtbarkeits-Level fuer Verwaltungs-Kontakte. Restriktiv -> offen:
// technik_praesident > ausschuss > eigentuemer > bewohner ("diese Rolle + alle
// hoeheren"). technik+praesident sehen alles; ausschuss/eigentuemer/bewohner
// zusaetzlich STWEG-gebunden (Verwaltung mit stweg=null gilt fuer alle STWEGs
// des Users). Erwartet die aufgeloesten (Ancestor-)Gruppen des Users.
function canSeeVerwaltungKontakte(groups, verwaltungStweg, level) {
  groups = groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return true;
  // Die Hausverwaltung sieht die Kontakte ihrer eigenen Verwaltung (je STWEG).
  if (verwaltungStweg == null || verwaltungStweg === '' ? isVerwaltungForAny(groups) : isVerwaltungFor(groups, verwaltungStweg)) return true;
  const lvl = level || 'ausschuss';
  if (lvl === 'technik_praesident') return false;
  const vS = (verwaltungStweg == null || verwaltungStweg === '') ? null : Number(verwaltungStweg);
  const userStwegs = getUserStwegs(groups);
  const stwegsToCheck = vS == null ? [...userStwegs] : (userStwegs.has(vS) ? [vS] : []);
  for (const s of stwegsToCheck) {
    const m = STWEG_GROUPS[s]; if (!m) continue;
    const inRole = (role) => m[role] && groups.some(g => g.toLowerCase() === m[role].toLowerCase());
    if (lvl === 'ausschuss'   && inRole('ausschuss')) return true;
    if (lvl === 'eigentuemer' && (inRole('ausschuss') || inRole('eigentuemer'))) return true;
    if (lvl === 'bewohner'    && (inRole('ausschuss') || inRole('eigentuemer') || inRole('bewohner'))) return true;
  }
  return false;
}

// ─── Hausverwaltung je STWEG ─────────────────────────────────────────
// Die Liegenschaftsverwaltung gilt je STWEG (wie der Ausschuss): Gruppe
// stwegN-verwaltung bzw. meg-verwaltung fuer STWEG 8 (MEG-Tiefeinstellhalle).
// Meist verwaltet dieselbe Firma alle STWEGs; ihr Konto steht dann in allen
// Gruppen. Eine Verwaltungsgruppe macht das Konto NICHT zum Bewohner/Eigentuemer:
// getUserStwegs() kennt sie absichtlich nicht (Mailverteiler, Waschkueche-
// Buchung, Abstimmungen usw. bleiben den Bewohnergruppen vorbehalten). Wo die
// Verwaltung Daten einer STWEG sehen darf, wird verwaltungStwegs() ausdruecklich
// dazugenommen (z. B. getStwegsMitVerwaltung).
const VERWALTUNG_GROUPS = {
  1: 'stweg1-verwaltung', 2: 'stweg2-verwaltung', 3: 'stweg3-verwaltung', 4: 'stweg4-verwaltung',
  5: 'stweg5-verwaltung', 6: 'stweg6-verwaltung', 7: 'stweg7-verwaltung', 8: 'meg-verwaltung',
};
const ALLE_STWEGS = Object.keys(VERWALTUNG_GROUPS).map(Number);

// ÜBERGANG (Umstellung auf Verwaltung je STWEG, Nov. 2026): Die alte globale
// Gruppe „Verwaltung“ gilt weiter als Verwaltung ALLER STWEGs, bis das Konto in
// Authentik in stwegN-verwaltung/meg-verwaltung umgehaengt ist. Entfernen:
// 1. In Authentik pruefen, dass niemand mehr in „Verwaltung“ steht.
// 2. VERWALTUNG_UEBERGANG_GLOBAL und die Zeile in verwaltungStwegs() hier
//    loeschen (Suche nach „ÜBERGANG“ im Repo findet alle Stellen).
// 3. Seed-Zeilen 'Verwaltung' in server.js (initDB) und die Rechte-Zeilen der
//    Gruppe in der Tabelle permissions loeschen.
const VERWALTUNG_UEBERGANG_GLOBAL = 'verwaltung';
function istVerwaltungUebergang(groups) {
  return (groups || []).some(g => String(g).toLowerCase() === VERWALTUNG_UEBERGANG_GLOBAL);
}

/** STWEG-Nummern, die nur ueber die Gruppen stwegN-verwaltung verwaltet werden (ohne Übergang). */
function verwaltungGruppenStwegs(groups) {
  const lower = new Set((groups || []).map(g => String(g).toLowerCase()));
  const stwegs = new Set();
  for (const [nr, name] of Object.entries(VERWALTUNG_GROUPS)) {
    if (lower.has(name)) stwegs.add(Number(nr));
  }
  return stwegs;
}

/** STWEG-Nummern, die das Konto als Hausverwaltung betreut (inkl. Übergang „Verwaltung“ = alle). */
function verwaltungStwegs(groups) {
  if (istVerwaltungUebergang(groups)) return new Set(ALLE_STWEGS); // ÜBERGANG
  return verwaltungGruppenStwegs(groups);
}

/** Ist das Konto Hausverwaltung dieser STWEG? */
function isVerwaltungFor(groups, stweg) {
  const n = Number(stweg);
  return Number.isFinite(n) && verwaltungStwegs(groups).has(n);
}

/** Ist das Konto Hausverwaltung irgendeiner STWEG? */
function isVerwaltungForAny(groups) {
  return verwaltungStwegs(groups).size > 0;
}

/** Verwaltet das Konto alle STWEGs? Nur dann sieht es auch Eintraege ohne STWEG (stweg NULL). */
function verwaltetAlleStwegs(groups) {
  const s = verwaltungStwegs(groups);
  return ALLE_STWEGS.every(n => s.has(n));
}

/** Ist g ein Gruppenname einer Hausverwaltung (je STWEG oder Übergang)? */
function istVerwaltungsGruppenName(g) {
  const n = String(g || '').toLowerCase();
  return n === VERWALTUNG_UEBERGANG_GLOBAL || Object.values(VERWALTUNG_GROUPS).includes(n);
}

/** STWEGs, deren Daten das Konto sieht: als Bewohner/Eigentuemer/Ausschuss oder als Verwaltung. */
function getStwegsMitVerwaltung(groups) {
  const s = getUserStwegs(groups || []);
  for (const n of verwaltungStwegs(groups)) s.add(n);
  return s;
}

module.exports = {
  VERWALTUNG_GROUPS, VERWALTUNG_UEBERGANG_GLOBAL, ALLE_STWEGS, istVerwaltungUebergang,
  verwaltungGruppenStwegs, verwaltungStwegs, isVerwaltungFor, isVerwaltungForAny,
  verwaltetAlleStwegs, istVerwaltungsGruppenName, getStwegsMitVerwaltung,
  STWEG_GROUPS, parseStweg, getUserStwegs, stwegFolderName, folderStwegNr,
  isTechnik, isPraesident, getAusschussStwegs, isAusschussForAny,
  canSeeVerwaltungKontakte,
};
