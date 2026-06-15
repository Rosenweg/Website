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

module.exports = {
  STWEG_GROUPS, parseStweg, getUserStwegs, stwegFolderName, folderStwegNr,
  isTechnik, isPraesident, getAusschussStwegs, isAusschussForAny,
};
