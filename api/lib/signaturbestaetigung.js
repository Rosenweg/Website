// Digital signieren mit Karte, QR oder Handy (Entscheid Stefan 28.11.2026, "Beide freigeben")
//
// Mit dem Rosenweg-Konto bestaetigt die Person eine Signatur durch eine frische
// Anmeldung (lib/stufen.js signierenErlaubt; App: mitBestaetigung -> bestaetigen()).
// Wer mit der Karte angemeldet ist — Karten-, QR- oder Handy-Sitzung (rw_app_…)
// oder am geteilten Telefon (Anlage-Token) —, bestaetigt stattdessen DIREKT VOR dem
// Signieren erneut mit einem der zwei Ausweise:
//
//   karte  die eigene Rosenweg-Karte noch einmal ans Telefon halten. Die Karte wird
//          wie bei der Anmeldung live in UniFi Access geprueft (zugewiesen, und der
//          Person dieser Anmeldung) — nicht irgendeine Karte.
//   qr     einen Anmelde-QR (RWAPP1) scannen, den die Person im Portal bzw. in einer
//          App MIT DEM ROSENWEG-KONTO ausgestellt hat (/smartphones, Mein Telefon).
//          Ein QR aus einer Karten-Anmeldung zaehlt nicht (appkarte.qrVomKonto):
//          sonst holte sich, wer an einem fremd angemeldeten geteilten Telefon
//          steht, in Mein Telefon selbst einen QR und "bestaetigte" damit.
//
// Ablauf:
//   1. POST /api/vollmachten/:id/sign-bestaetigung { methode: 'karte', uid } bzw.
//      { methode: 'qr', code } -> { bestaetigung: 'rw_sigb_…', gueltig_s, ablauf }
//   2. POST /api/vollmachten/:id/sign-digital { bestaetigung } innert TTL_S.
// Die Bestaetigung gilt TTL_S Sekunden (Standard 120), genau einmal, nur fuer
// diese Vollmacht und diese Person (atomar verbraucht). Fehlversuche je Person
// sind begrenzt (FEHL_GRENZE in FEHL_FENSTER_MIN). Jede Bestaetigung steht im
// admin_protokoll (Bereich 'vollmachten-signatur') und in der Tabelle
// vollmacht_sign_bestaetigungen; die Signatur traegt Methode, Karte, Zeit und
// Anmeldung im Text auf dem PDF (signed_bestaetigung) und den Verweis
// (signed_bestaetigung_ref) auf die Zeile hier.
//
// Nie mit einem persoenlichen Zugangstoken (PAT) oder ueber MCP.
const crypto = require('crypto');
const ak = require('./appkarte');
const { istKartenSitzung } = require('./stufen');

const zahl = (name, std, min, max) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
};
const TTL_S = zahl('VOLLMACHT_BESTAETIGUNG_S', 120, 30, 300);
const FEHL_GRENZE = 5;
const FEHL_FENSTER_MIN = 15;
const PRAEFIX = 'rw_sigb_';
const TOKEN_RE = /^rw_sigb_[A-Za-z0-9_-]{40,60}$/;

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const neuesToken = () => PRAEFIX + crypto.randomBytes(32).toString('base64url');

/** Darf diese Anmeldung mit Karte bzw. QR bestaetigen? Nur Karten-Sitzungen, nie PAT/MCP. */
function darfMitKarteBestaetigen(req) {
  if (!req || req.pat) return false;
  if (String(req.headers?.['x-rosenweg-kanal'] || '').toLowerCase() === 'mcp') return false;
  return istKartenSitzung(req);
}

/** Body pruefen -> { ok, methode:'karte', uid } | { ok, methode:'qr', token } | { ok:false, fehler } */
function anfragePruefen(body) {
  const b = body && typeof body === 'object' ? body : {};
  const methode = String(b.methode || '');
  if (methode === 'karte') {
    const uid = ak.kartenUid(b.uid);
    return uid ? { ok: true, methode, uid } : { ok: false, fehler: 'Die Karte ließ sich nicht lesen – bitte nochmals hinhalten.' };
  }
  if (methode === 'qr') {
    const roh = String(b.code || '').trim();
    if (roh.startsWith(ak.QR_PRAEFIX_TELEFON)) {
      return { ok: false, fehler: 'Das ist der QR für geteilte Telefone. Bitte im Portal unter /smartphones „App auf eigenem Handy“ wählen.' };
    }
    const token = ak.qrToken(roh);
    return token ? { ok: true, methode, token } : { ok: false, fehler: 'Das ist kein Rosenweg-Anmelde-QR.' };
  }
  return { ok: false, fehler: 'Bitte mit der Karte oder dem Anmelde-QR bestätigen (methode: karte oder qr).' };
}

/** Gehoert die nachgeschlagene Karte (karteNachschlagen) zugewiesen dieser Person? */
function karteGehoertPerson(n, email) {
  const e = String(email || '').toLowerCase().trim();
  return !!(n && n.found && n.assigned && e && String(n.person?.email || '').toLowerCase().trim() === e);
}

const zeitTeile = (ms) => {
  const t = new Date(ms);
  return {
    datum: t.toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }),
    zeit: t.toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }),
  };
};

/** Womit war die Person angemeldet (fuer den Text auf dem PDF)? */
function anmeldungText(art, geraet) {
  return {
    karte: 'angemeldet mit der Rosenweg-Karte',
    qr: 'angemeldet mit einem Anmelde-QR',
    handy: 'angemeldet über „Mit dem Handy anmelden“',
    anlage: `angemeldet am geteilten Telefon${geraet ? ' ' + String(geraet).replace(/^geteiltes Telefon\s*/i, '') : ''}`,
  }[art] || 'angemeldet ohne Rosenweg-Konto';
}

/**
 * Text fuer signed_bestaetigung (steht auf dem PDF). Nur aus Server-Daten:
 * methode, karte (Anzeige-ID), art der Anmeldung, geraet, zeitMs der Bestaetigung.
 */
function bestaetigungText({ methode, karte, art, geraet, zeitMs }) {
  const { datum, zeit } = zeitTeile(zeitMs || Date.now());
  const wie = methode === 'karte'
    ? `Rosenweg-Karte${karte ? ' ' + karte : ''} erneut vorgelegt`
    : 'Anmelde-QR aus dem Rosenweg-Konto gescannt';
  return `${wie} am ${datum} um ${zeit} Uhr (${anmeldungText(art, geraet)})`;
}

// ─── Speicher (PostgreSQL) ──────────────────────────────────────────────────
const SQL_TABELLE = `
  CREATE TABLE IF NOT EXISTS vollmacht_sign_bestaetigungen (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, vollmacht_id INTEGER NOT NULL,
    email TEXT NOT NULL, user_id INTEGER, methode TEXT NOT NULL, karte TEXT, qr_id TEXT,
    art TEXT, sitzung TEXT, app TEXT, geraet TEXT, ip TEXT, text TEXT,
    erfolg BOOLEAN NOT NULL, grund TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS idx_vsb_email_zeit ON vollmacht_sign_bestaetigungen (LOWER(email), created_at);`;

const bereitJe = new WeakMap();
function bereit(pool) {
  if (!bereitJe.has(pool)) bereitJe.set(pool, pool.query(SQL_TABELLE).catch((e) => { bereitJe.delete(pool); throw e; }));
  return bereitJe.get(pool);
}

/** Fehlversuche der Person im Fenster (Bremse gegen Durchprobieren). */
async function fehlversuche(pool, email) {
  await bereit(pool);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM vollmacht_sign_bestaetigungen
      WHERE LOWER(email) = LOWER($1) AND NOT erfolg AND created_at > NOW() - make_interval(mins => $2::int)`,
    [email, String(FEHL_FENSTER_MIN)]);
  return r.rows[0]?.n || 0;
}

/** Eintrag anlegen (Erfolg mit Token, oder Fehlversuch ohne). -> { id, token? , ablauf? } */
async function eintragen(pool, e) {
  await bereit(pool);
  const id = 'vsb_' + crypto.randomBytes(12).toString('hex');
  const token = e.erfolg ? neuesToken() : null;
  const ablauf = e.erfolg ? new Date(Date.now() + TTL_S * 1000) : null;
  await pool.query(
    `INSERT INTO vollmacht_sign_bestaetigungen (id, token_hash, vollmacht_id, email, user_id, methode, karte, qr_id,
        art, sitzung, app, geraet, ip, text, erfolg, grund, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, token ? hash(token) : null, e.vollmachtId, String(e.email || '').toLowerCase(), e.userId || null, e.methode,
      e.karte || null, e.qrId || null, e.art || null, e.sitzung || null, e.app || null, e.geraet || null, e.ip || null,
      e.text || null, !!e.erfolg, e.grund || null, ablauf]);
  return { id, token, ablauf };
}

/**
 * Anmelde-QR fuer die Bestaetigung verbrauchen: nur ein QR derselben Person, vom
 * Rosenweg-Konto ausgestellt, nicht abgelaufen, noch nie benutzt (atomar).
 * Ein QR einer anderen Person oder aus einer Karten-Anmeldung bleibt unberuehrt.
 * -> { id } | null
 */
async function qrVerbrauchen(pool, { token, email, vollmachtId, geraet, ip }) {
  const r = await pool.query(
    `UPDATE app_qr_ausweise SET eingeloest_at = NOW(), eingeloest_ip = $3, app_name = $4, geraet_name = $5,
            sitzung_id = $6
      WHERE token_hash = $1 AND eingeloest_at IS NULL AND expires_at > NOW()
        AND LOWER(email) = LOWER($2) AND ausgestellt_art = ANY($7::text[])
      RETURNING id`,
    [ak.hash(token), email, ip || null, 'Vollmacht signieren (Bestätigung)', String(geraet || '').slice(0, 120) || null,
      'vollmacht:' + vollmachtId, [...ak.KONTO_ARTEN]]);
  return r.rows[0] || null;
}

/**
 * Bestaetigung beim Signieren einloesen: genau einmal, nicht abgelaufen, diese
 * Vollmacht, diese Person. -> Zeile | null
 */
async function einloesen(pool, { token, vollmachtId, email }) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  await bereit(pool);
  const r = await pool.query(
    `UPDATE vollmacht_sign_bestaetigungen SET used_at = NOW()
      WHERE token_hash = $1 AND erfolg AND used_at IS NULL AND expires_at > NOW()
        AND vollmacht_id = $2 AND LOWER(email) = LOWER($3)
      RETURNING id, methode, karte, qr_id, art, geraet, text, created_at`,
    [hash(token), vollmachtId, email]);
  return r.rows[0] || null;
}

module.exports = {
  TTL_S, FEHL_GRENZE, FEHL_FENSTER_MIN, PRAEFIX, TOKEN_RE, SQL_TABELLE,
  darfMitKarteBestaetigen, anfragePruefen, karteGehoertPerson, anmeldungText, bestaetigungText,
  bereit, fehlversuche, eintragen, qrVerbrauchen, einloesen, hash,
};
