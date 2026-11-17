// Einmal-Codes per E-Mail — gemeinsame Ausstellung und Prüfung für Portal-Login,
// Reparatur-Meldung und Terminumfrage.
//
// Hintergrund (17.11.2026): /api/reklamationen/oeffentlich prüfte den Code ohne
// jedes Versuchslimit; in einer Nacht wurden 3,6 Mio. Codes durchprobiert und
// Meldungen im Namen von Bewohnern angelegt. Die anderen Wege zählten nur im
// Arbeitsspeicher und teilten sich dieselben Codes.
//
// Regeln, die hier an EINER Stelle gelten:
//  - Ein Code gehört zu genau einem Zweck (Spalte zweck). Ein Reparatur-Code
//    ist kein Login-Code.
//  - Die Versuche werden in der Datenbank am Code gezählt. Nach MAX_VERSUCHE
//    ist der Code verbraucht — egal über welche Route geprüft wurde, und auch
//    nach einem Neustart der API.
//  - Je Adresse gibt es höchstens 3 Codes in 10 Minuten und 12 am Tag.
//  - 8 Stellen statt 6: mit 5 Versuchen je Code ist Raten aussichtslos.
const crypto = require('crypto');
const { pool } = require('./db');

const MAX_VERSUCHE = 5;
const GUELTIG_MS = 10 * 60 * 1000;
const ZWECKE = new Set(['login', 'reklamation', 'doodle']);

function neuerCode() {
  return String(crypto.randomInt(0, 100000000)).padStart(8, '0');
}

// E-Mail aus beliebiger Eingabe: nie werfen, immer String.
function normEmail(v) {
  return typeof v === 'string' ? v.toLowerCase().trim().slice(0, 255) : '';
}

// Ausstell-Limit je Adresse, im Speicher (Zähler am Code liegt in der DB).
const ausgestellt = new Map(); // "zweck:email" -> [timestamps]
setInterval(() => {
  const grenze = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, arr] of ausgestellt) {
    const rest = arr.filter(t => t > grenze);
    if (rest.length) ausgestellt.set(k, rest); else ausgestellt.delete(k);
  }
}, 10 * 60 * 1000).unref();

// true = darf noch einen Code bekommen (und zählt diese Anfrage).
function ausstellenErlaubt(email, zweck) {
  const key = zweck + ':' + email;
  const now = Date.now();
  const arr = (ausgestellt.get(key) || []).filter(t => now - t < 24 * 60 * 60 * 1000);
  const letzte10min = arr.filter(t => now - t < GUELTIG_MS).length;
  if (letzte10min >= 3 || arr.length >= 12) { ausgestellt.set(key, arr); return false; }
  // Speicher deckeln: bei sehr vielen verschiedenen Adressen nichts Neues mehr merken,
  // sondern ablehnen (schützt vor Speicher-Aufblähen durch erfundene Adressen).
  if (!ausgestellt.has(key) && ausgestellt.size > 20000) return false;
  arr.push(now); ausgestellt.set(key, arr);
  return true;
}

async function otpAusstellen(emailRoh, zweck) {
  const email = normEmail(emailRoh);
  if (!email || !ZWECKE.has(zweck)) throw new Error('otpAusstellen: ungültige Eingabe');
  const code = neuerCode();
  await pool.query('UPDATE otp_codes SET used = true WHERE email = $1 AND zweck = $2 AND used = false', [email, zweck]);
  await pool.query('INSERT INTO otp_codes (email, code, zweck, expires_at) VALUES ($1, $2, $3, $4)',
    [email, code, zweck, new Date(Date.now() + GUELTIG_MS)]);
  return code;
}

// Prüft und verbraucht einen Code. Ergebnis: { ok: true } oder
// { ok: false, grund: 'kein' | 'abgelaufen' | 'falsch' | 'gesperrt' }.
async function otpPruefen(emailRoh, codeRoh, zweck) {
  const email = normEmail(emailRoh);
  const code = typeof codeRoh === 'string' || typeof codeRoh === 'number' ? String(codeRoh).trim() : '';
  if (!email || !code || !ZWECKE.has(zweck)) return { ok: false, grund: 'kein' };
  // Zählen und Lesen in EINER Anweisung — parallele Anfragen können den Zähler nicht umgehen.
  const r = await pool.query(
    `UPDATE otp_codes SET versuche = versuche + 1
      WHERE id = (SELECT id FROM otp_codes
                   WHERE email = $1 AND zweck = $2 AND used = false
                   ORDER BY created_at DESC, id DESC LIMIT 1)
      RETURNING id, code, expires_at, versuche`, [email, zweck]);
  const row = r.rows[0];
  if (!row) return { ok: false, grund: 'kein' };
  const verbrauchen = () => pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [row.id]);
  if (row.versuche > MAX_VERSUCHE) { await verbrauchen(); return { ok: false, grund: 'gesperrt' }; }
  if (new Date() > new Date(row.expires_at)) { await verbrauchen(); return { ok: false, grund: 'abgelaufen' }; }
  const a = Buffer.from(String(row.code)), b = Buffer.from(code);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    if (row.versuche >= MAX_VERSUCHE) { await verbrauchen(); return { ok: false, grund: 'gesperrt' }; }
    return { ok: false, grund: 'falsch' };
  }
  // Einmalig: nur wer den Code als Erster verbraucht, gewinnt.
  const u = await pool.query('UPDATE otp_codes SET used = true WHERE id = $1 AND used = false RETURNING id', [row.id]);
  if (u.rows.length === 0) return { ok: false, grund: 'kein' };
  return { ok: true };
}

const OTP_FEHLER = {
  kein: 'Kein gültiger Code vorhanden. Bitte einen neuen anfordern.',
  abgelaufen: 'Der Code ist abgelaufen. Bitte einen neuen anfordern.',
  falsch: 'Ungültiger Code',
  gesperrt: 'Zu viele Fehlversuche. Bitte einen neuen Code anfordern.',
};

// Schema-Ergänzung; wird aus initDB() nach dem Anlegen von otp_codes aufgerufen.
const OTP_SCHEMA_SQL = `
  ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS zweck VARCHAR(20) NOT NULL DEFAULT 'login';
  ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS versuche INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE otp_codes ALTER COLUMN code TYPE VARCHAR(12);
`;

module.exports = { otpAusstellen, otpPruefen, ausstellenErlaubt, normEmail, OTP_FEHLER, OTP_SCHEMA_SQL, MAX_VERSUCHE };
