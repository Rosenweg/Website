// Regeln des E-Mail-Archivs (Klaerung Mail-Archiv, Entscheide Stefan 28.11.2026).
// Rein funktional, damit Server, Tests und spaeter die App dieselbe Regel nutzen.
//
// STWEG-Bindung (F1/E2): Jede Mail hat eine STWEG ('1' … '8') oder 'haus'
// (keiner oder mehreren STWEGs zuordenbar). Technik und Praesident lesen alles.
// Ausschuss und Verwaltung lesen nur ihre STWEG(s) plus 'haus' – und nur mit
// Seitenrecht „email-archiv“ (F2, prueft die Route mit requirePermission).
//
// Vier-Augen (F3/E3): Bestaetigen oder ablehnen darf nur eine andere Person
// (Vergleich ueber die Konto-ID, nicht die Mail-Adresse) aus derselben STWEG
// wie die Mail oder Technik/Praesident. Bei 'haus' gilt die STWEG des Antrags
// (die STWEG(s), fuer die die antragstellende Person handelte).
const { isTechnik, isPraesident, getAusschussStwegs, verwaltungStwegs } = require('./groups');

const HAUS = 'haus';
const AUFBEWAHRUNG_JAHRE = 10;

const istAdmin = (groups) => isTechnik(groups || []) || isPraesident(groups || []);

/** STWEGs (als Text), fuer die das Konto als Ausschuss oder Verwaltung handelt. */
function eigeneStwegs(groups) {
  const s = new Set();
  for (const n of getAusschussStwegs(groups || [])) s.add(String(n));
  for (const n of verwaltungStwegs(groups || [])) s.add(String(n));
  return s;
}

/**
 * Welche STWEG-Werte darf das Konto lesen?
 *   null       = alles (Technik/Praesident)
 *   [..,'haus'] = die eigenen STWEGs plus 'haus'
 *   []         = nichts (kein Ausschuss, keine Verwaltung)
 * Das Seitenrecht prueft die Route zusaetzlich.
 */
function leseStwegs(groups) {
  if (istAdmin(groups)) return null;
  const s = eigeneStwegs(groups);
  if (!s.size) return [];
  return [...[...s].sort(), HAUS];
}

/** Darf das Konto eine Mail dieser STWEG lesen? */
function darfLesen(groups, mailStweg) {
  const s = leseStwegs(groups);
  if (s === null) return true;
  return s.includes(String(mailStweg || HAUS));
}

/**
 * Loeschantraege stellen und entscheiden: Technik/Praesident und Ausschuss.
 * Die Verwaltung liest nur (sie hatte nie einen Loeschweg).
 */
function darfLoeschweg(groups) {
  return istAdmin(groups) || getAusschussStwegs(groups || []).size > 0;
}

/** STWEG(s) eines neuen Antrags: Mail-STWEG, bei 'haus' die eigenen Ausschuss-STWEGs. */
function antragStwegs(groups, mailStweg) {
  const m = String(mailStweg || HAUS);
  if (m !== HAUS) return [m];
  return [...getAusschussStwegs(groups || [])].map(String).sort();
}

/**
 * Darf diese Person den Antrag entscheiden?
 *   user     { id, email, groups }
 *   antrag   { requested_by_id, requested_by, antrag_stwegs }
 *   mailStweg  STWEG der Mail
 * Liefert { ok, grund }.
 */
function darfEntscheiden(user, antrag, mailStweg) {
  const groups = (user && user.groups) || [];
  if (!darfLoeschweg(groups)) return { ok: false, grund: 'kein-recht' };
  const id = user && user.id != null ? Number(user.id) : null;
  if (id == null || !Number.isFinite(id)) return { ok: false, grund: 'keine-konto-id' };
  if (antrag.requested_by_id != null) {
    if (Number(antrag.requested_by_id) === id) return { ok: false, grund: 'eigener-antrag' };
  } else {
    // Altbestand ohne Konto-ID: dann bleibt nur der Adressvergleich.
    const norm = (e) => String(e || '').trim().toLowerCase();
    if (!norm(user.email) || norm(antrag.requested_by) === norm(user.email)) return { ok: false, grund: 'eigener-antrag' };
  }
  if (istAdmin(groups)) return { ok: true };
  const eigene = new Set([...getAusschussStwegs(groups)].map(String));
  const m = String(mailStweg || HAUS);
  const noetig = m !== HAUS ? [m] : (Array.isArray(antrag.antrag_stwegs) ? antrag.antrag_stwegs.map(String) : []);
  if (noetig.some(s => eigene.has(s))) return { ok: true };
  return { ok: false, grund: 'andere-stweg' };
}

/** Suchtext fuer ILIKE: % _ und \ gelten woertlich (Escape-Zeichen \). */
function likeMuster(text) {
  return '%' + String(text || '').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** Adressliste (Komma/Semikolon) in kleine, getrimmte Adressen. */
function adressen(text) {
  return String(text || '').split(/[,;]/).map(a => {
    const m = a.match(/<([^>]+)>/);
    return (m ? m[1] : a).trim().toLowerCase();
  }).filter(Boolean);
}

/**
 * STWEG einer Mail aus den Empfaengern: genau eine STWEG unter den
 * Verteiler-Adressen = diese STWEG, sonst 'haus'.
 *   verteiler  [{ stweg, email_address }]
 */
function stwegAusAdressen(toAddresses, verteiler) {
  const an = new Set(adressen(toAddresses));
  const treffer = new Set();
  for (const v of verteiler || []) {
    const a = String(v && v.email_address || '').trim().toLowerCase();
    const n = parseInt(v && v.stweg, 10);
    if (a && Number.isFinite(n) && n > 0 && an.has(a)) treffer.add(String(n));
  }
  return treffer.size === 1 ? [...treffer][0] : HAUS;
}

/** Zeile des Excel-Exports (L3: die Spalten, die es wirklich gibt). */
function exportZeile(e) {
  return {
    'ID': e.id,
    'Datum': e.email_date ? new Date(e.email_date).toISOString() : '',
    'STWEG': e.stweg || '',
    'Von': e.from_email || '',
    'Name': e.from_name || '',
    'An': e.to_addresses || '',
    'Betreff': e.subject || '',
    'Anhaenge': Array.isArray(e.attachments) ? e.attachments.length : 0,
    'Status': e.deletion_status || '',
    'Message-ID': e.message_id || '',
  };
}

/** Wie wurde zugegriffen? Fuer das Zugriffsprotokoll (F5). */
function zugriffsWeg(req) {
  const kanal = String((req && req.headers && req.headers['x-rosenweg-kanal']) || '').toLowerCase();
  if (kanal === 'mcp') return 'mcp';
  if (req && req.pat) return 'token';
  if (req && req.anlage) return 'anlage';
  if (req && req.appKarte) return 'karte';
  return String((req && req.auth && req.auth.art) || 'konto').slice(0, 40);
}

module.exports = {
  HAUS, AUFBEWAHRUNG_JAHRE, eigeneStwegs, leseStwegs, darfLesen, darfLoeschweg, antragStwegs,
  darfEntscheiden, likeMuster, adressen, stwegAusAdressen, exportZeile, zugriffsWeg,
};
