// Wer sieht die echten Telefonnummern einer Person? (Stefan 27.11.2026)
//
// Seit jede Person eine interne Nummer 3HHWWP hat (pbx/api/nummernvergabe.py),
// stehen in den Verzeichnissen nur noch diese Nummern: wer sie waehlt, erreicht
// die Person auf ihren Geraeten, inklusive ihrer Weiterleitung. Die echten
// Nummern (Handy, Festnetz) sieht:
//
//   - Technik und Praesident             immer, ueberall
//   - die Person selbst                  immer (gleiche E-Mail)
//   - Bewohner/Eigentuemer/Ausschuss     nur auf den Portalseiten und nur fuer
//                                        Personen im eigenen Haus (= eigene
//                                        STWEG, dieselbe Gruppenlogik wie
//                                        ueberall im Portal: lib/groups.js)
//   - Liegenschaftsverwaltung            auf den Portalseiten die STWEGs, die
//     (Gruppe verwaltung)                sie verwaltet (Vertrag in verwaltungen,
//                                        gleiche Wahl wie findVerwaltungForStweg)
//
// Kein Portal sind Zugaenge, bei denen die Daten in einem anderen Verzeichnis
// landen oder auf einem Geraet stehen, an dem sich mehrere anmelden: MCP und
// Zugangstoken (PAT), Apps auf geteilten Telefonen (Anlage-Token), Karten-
// Sitzungen (Karte allein meldet an), das Stationen-Telefonbuch, der
// Nextcloud-Sync. Dort gilt nur die interne Nummer. Rosenweg-Apps mit dem
// eigenen Konto auf dem eigenen Handy zaehlen wie das Portal.
//
// Alles hier ist rein (keine Datenbank), damit es ohne Postgres testbar ist;
// das Laden der internen Nummern bekommt den Pool als Argument.
const { isTechnik, isPraesident, getUserStwegs, verwaltungGruppenStwegs, istVerwaltungUebergang } = require('./groups');

const KANAL_PORTAL = 'portal';
const KANAL_VERZEICHNIS = 'verzeichnis';

/** Persoenliche interne Nummer 3 HH WW P. */
const INTERN_PERSON_RE = /^3\d{5}$/;

function istInternePersonennummer(n) {
  return INTERN_PERSON_RE.test(String(n || '').replace(/\s+/g, ''));
}

/**
 * Nebenstelle/Gruppe/Kurzwahl der Anlage (2–4 Stellen) oder 3HHWWP — keine
 * Nummer, die ausserhalb der Anlage jemandem gehoert.
 */
function istAnlagennummer(n) {
  const s = String(n || '').replace(/[\s\-/]/g, '');
  return /^\d{2,4}$/.test(s) || INTERN_PERSON_RE.test(s);
}

/**
 * Ueber welchen Weg kam die Anfrage? Nur die Browser-Anmeldung am Portal ist
 * 'portal'. Der Kopf X-Rosenweg-Kanal (MCP-Loopback) kann nur einschraenken,
 * nie erweitern — ihn zu faelschen bringt also nichts.
 */
function nummernKanal(req) {
  if (!req) return KANAL_VERZEICHNIS;
  if (req.pat || req.anlage || req.appKarte) return KANAL_VERZEICHNIS;
  // Rosenweg-Apps mit eigenem Konto (Authentik-Client rosenweg-apps) zaehlen wie
  // das Portal: es sind Portal-Funktionen auf dem eigenen Handy.
  if (req.user?.auth_source === 'anlage' || req.user?.messengerDienst) return KANAL_VERZEICHNIS;
  const kopf = req.headers && req.headers['x-rosenweg-kanal'];
  if (kopf) return KANAL_VERZEICHNIS;
  return KANAL_PORTAL;
}

const klein = (s) => String(s || '').trim().toLowerCase();

function istTechnikOderPraesident(user) {
  const g = (user?.groups || []).map(String);
  return isTechnik(g) || isPraesident(g);
}

/**
 * Darf `user` die echten Nummern von `person` sehen?
 * @param {object} user     req.user (email, groups)
 * @param {object} person   { email?, emails?, stweg?, stwegs? } — stweg(s) = Haeuser/STWEGs der Person
 * @param {object} [opt]    { kanal: 'portal' | 'verzeichnis' } (Vorgabe: verzeichnis = streng)
 */
function darfEchteNummernSehen(user, person = {}, { kanal = KANAL_VERZEICHNIS, verwaltet = [] } = {}) {
  if (!user) return false;
  if (istTechnikOderPraesident(user)) return true;
  const ich = klein(user.email);
  if (ich) {
    const mails = [person.email, ...(Array.isArray(person.emails) ? person.emails : [])].map(klein).filter(Boolean);
    if (mails.includes(ich)) return true;
  }
  if (kanal !== KANAL_PORTAL) return false;
  const meine = getUserStwegs((user.groups || []).map(String));
  // Hausverwaltung je STWEG (stwegN-verwaltung): die Gruppe selbst bestimmt die STWEG.
  for (const v of verwaltungGruppenStwegs((user.groups || []).map(String))) meine.add(v);
  // ÜBERGANG: alte globale Gruppe „Verwaltung“ – STWEGs aus dem Vertrag (verwaltungen)
  for (const v of verwaltet || []) meine.add(Number(v));
  if (meine.size === 0) return false;
  const seine = [person.stweg, ...(Array.isArray(person.stwegs) ? person.stwegs : [])]
    .map(Number).filter((s) => Number.isFinite(s) && s > 0);
  return seine.some((s) => meine.has(s));
}

// ── Interne Nummern zu Personen finden ─────────────────────────────────
// Gleiche Regel wie die Anlage (pbx/api/app.py _gleiche_person): Paare teilen
// sich oft eine E-Mail, darum zaehlt die E-Mail nur zusammen mit dem Namen.
function nameTeile(n) {
  return new Set(String(n || '').toLowerCase().split(/[\s-]+/).filter((t) => t.length > 1));
}
const FIRMA = new Set(['ag', 'gmbh', 'sa', 'gemeinde', 'einwohnergemeinde', 'stiftung', 'genossenschaft']);

function gleichePerson(a, b) {
  if (klein(a) && klein(a) === klein(b)) return true;
  const ta = nameTeile(a), tb = nameTeile(b);
  if (ta.size < 2 || tb.size < 2) return false;
  const firmaA = [...ta].some((t) => FIRMA.has(t)), firmaB = [...tb].some((t) => FIRMA.has(t));
  if (firmaA !== firmaB) return false;
  const [kurz, lang] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  return [...kurz].every((t) => lang.has(t));
}

/**
 * @param {Array<{nummer,email,name}>} liste  aktive interne Nummern
 * @param {{email?, emails?, name?}} person
 * @returns {string|null}
 */
function interneNummerFinden(liste, person = {}) {
  if (!Array.isArray(liste) || !person) return null;
  const mails = new Set([person.email, ...(Array.isArray(person.emails) ? person.emails : [])].map(klein).filter(Boolean));
  if (mails.size === 0) return null;
  const treffer = liste.find((r) => mails.has(klein(r.email)) && gleichePerson(r.name, person.name));
  return treffer ? String(treffer.nummer) : null;
}

const NUMMERN_FELDER = ['telefon', 'mobile', 'telefone', 'eigentuemer_telefon', 'mieter_telefon'];

/**
 * Kopie von `obj` fuer die Ausgabe: `interne_nummer` kommt immer dazu; ohne
 * Recht werden die echten Nummern geleert (null bzw. []) und
 * `nummern_verborgen: true` gesetzt. Das Feld `telefon` bekommt dabei NICHT die
 * interne Nummer — Formulare wuerden sie sonst als echte Nummer zurueckschreiben.
 */
function nummernAusgeben(obj, { sichtbar, intern = null, felder = NUMMERN_FELDER } = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  const aus = { ...obj, interne_nummer: intern || null };
  if (sichtbar) return aus;
  let verborgen = false;
  for (const f of felder) {
    if (!(f in aus)) continue;
    const v = aus[f];
    const leer = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (!leer) verborgen = true;
    aus[f] = Array.isArray(v) ? [] : null;
  }
  if (verborgen) aus.nummern_verborgen = true;
  return aus;
}

/**
 * Schreibschutz: Wer die echten Nummern nicht sieht, darf sie auch nicht
 * ueberschreiben (sonst loescht ein Formular mit verborgenen, leeren Feldern
 * beim Speichern die Nummern). Gibt eine Kopie des Bodys ohne Nummernfelder.
 */
function nummernAusBodyEntfernen(body, felder = NUMMERN_FELDER) {
  const b = { ...(body || {}) };
  for (const f of felder) delete b[f];
  return b;
}

// ── Laden (mit kurzem Zwischenspeicher) ────────────────────────────────
let cache = { zeit: 0, liste: null };
const CACHE_MS = 60 * 1000;

async function interneNummernLaden(pool, { frisch = false } = {}) {
  if (!frisch && cache.liste && Date.now() - cache.zeit < CACHE_MS) return cache.liste;
  try {
    const r = await pool.query(
      'SELECT nummer, email, name, wohnung, haus FROM telefon_interne_nummern WHERE aktiv IS NOT FALSE ORDER BY nummer');
    cache = { zeit: Date.now(), liste: r.rows };
  } catch (e) {
    // Tabelle fehlt (erster Start) oder DB-Fehler: lieber keine internen
    // Nummern als ein Fehler — die echten bleiben ja trotzdem verborgen.
    if (!cache.liste) cache = { zeit: Date.now(), liste: [] };
  }
  return cache.liste;
}
function interneNummernCacheLeeren() { cache = { zeit: 0, liste: null }; }

/**
 * Fuer eine Anfrage: Funktion (obj, person?) -> Ausgabe-Kopie. `person` sind die
 * Angaben, nach denen entschieden wird ({email, name, stweg|stwegs}); fehlt sie,
 * gilt obj selbst. Die Liste der internen Nummern wird einmal je Anfrage geladen.
 */
function nummernSichtAus(user, kanal, interne, verwaltet = []) {
  return (obj, person = obj) => nummernAusgeben(obj, {
    sichtbar: darfEchteNummernSehen(user, person, { kanal, verwaltet }),
    intern: interneNummerFinden(interne, person),
  });
}

// ÜBERGANG: nur die alte globale Gruppe „Verwaltung“ braucht die Zuordnung ueber
// die Vertraege; stwegN-verwaltung ist schon an die STWEG gebunden. Nach dem
// Umhaengen in Authentik faellt dieser Weg (und VERWALTET_SQL) weg.
function istVerwaltungsGruppe(user) {
  return istVerwaltungUebergang((user?.groups || []).map(String));
}

// Welche STWEGs verwaltet die Liegenschaftsverwaltung, zu der `user` gehoert?
// Je STWEG dieselbe Wahl wie findVerwaltungForStweg (server.js): aktiver Vertrag
// fuer genau diese STWEG vor einem STWEG-uebergreifenden (stweg NULL). Die Person
// gehoert dazu, wenn ihre E-Mail die der Firma oder eines Firmenkontakts ist.
const VERWALTET_SQL = `
  WITH s AS (SELECT generate_series(1, 8) AS stweg),
  gewaehlt AS (
    SELECT DISTINCT ON (s.stweg) s.stweg, v.id
      FROM s JOIN verwaltungen v
        ON v.aktiv = true AND (v.stweg = s.stweg OR v.stweg IS NULL)
       AND (v.vertrag_von IS NULL OR v.vertrag_von <= CURRENT_DATE)
       AND (v.vertrag_bis IS NULL OR v.vertrag_bis >= CURRENT_DATE)
     ORDER BY s.stweg, (v.stweg IS NULL), v.id)
  SELECT g.stweg FROM gewaehlt g JOIN verwaltungen v ON v.id = g.id
   WHERE LOWER(v.email) = LOWER($1)
      OR EXISTS (SELECT 1 FROM verwaltungs_kontakte k WHERE k.verwaltung_id = v.id AND LOWER(k.email) = LOWER($1))
   ORDER BY g.stweg`;

async function verwalteteStwegsLaden(pool, user) {
  if (!istVerwaltungsGruppe(user) || !klein(user?.email)) return [];
  try {
    const r = await pool.query(VERWALTET_SQL, [klein(user.email)]);
    return r.rows.map((x) => Number(x.stweg));
  } catch {
    return [];
  }
}

async function nummernSicht(req, pool) {
  const [interne, verwaltet] = await Promise.all([interneNummernLaden(pool), verwalteteStwegsLaden(pool, req.user)]);
  return nummernSichtAus(req.user, nummernKanal(req), interne, verwaltet);
}

// Von aussen waehlbar ist nur die Amtsnummer: alle eingehenden Anrufe gehen auf
// den Dienst Technik (intern 2000, pbx/asterisk-config/extensions.conf [inbound]),
// eine Durchwahl auf 3HHWWP gibt es nicht.
const AMTSNUMMER = process.env.PBX_AMTSNUMMER || '+41 61 551 01 52';
const DIENST_TECHNIK = '2000';

/** Eingang von der Anlage pruefen: nur 3HHWWP mit E-Mail und Name. */
function interneNummernPruefen(liste) {
  if (!Array.isArray(liste)) return { ok: false, fehler: 'nummern muss eine Liste sein' };
  const aus = [];
  const gesehen = new Set();
  for (const r of liste) {
    const nummer = String(r?.nummer || '').trim();
    const email = klein(r?.email);
    const name = String(r?.name || '').trim().slice(0, 255);
    if (!INTERN_PERSON_RE.test(nummer) || !email || !name || gesehen.has(nummer)) continue;
    gesehen.add(nummer);
    aus.push({
      nummer, email: email.slice(0, 255), name,
      wohnung: r?.wohnung ? String(r.wohnung).slice(0, 255) : null,
      haus: Number.isInteger(Number(r?.haus)) ? Number(r.haus) : null,
      aktiv: r?.aktiv === undefined ? true : !!Number(r.aktiv),
    });
  }
  return { ok: true, nummern: aus };
}

module.exports = {
  KANAL_PORTAL, KANAL_VERZEICHNIS, NUMMERN_FELDER,
  istInternePersonennummer, istAnlagennummer, nummernKanal, istTechnikOderPraesident,
  darfEchteNummernSehen, gleichePerson, interneNummerFinden,
  nummernAusgeben, nummernAusBodyEntfernen,
  interneNummernLaden, interneNummernCacheLeeren, interneNummernPruefen,
  nummernSichtAus, nummernSicht, verwalteteStwegsLaden, istVerwaltungsGruppe,
  AMTSNUMMER, DIENST_TECHNIK,
};
