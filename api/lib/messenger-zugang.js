// ═══════════════════════════════════════════════════════════════════
// Rosenweg Messenger auf dem eigenen Handy — Zugang je Geraet
// ═══════════════════════════════════════════════════════════════════
//
// Stefan 26.11.2026: der Messenger soll sich auf privaten Telefonen (ohne
// Rosenweg Geraet) selbst mit dem Rosenweg-Konto anmelden, wie Rosenweg
// Telefon (telefon_sip_privat <nummer>-p<id>).
//
// Ablauf:
//   1. App meldet sich bei Authentik an (rosenweg-apps, PKCE) und holt mit dem
//      Access-Token EINMAL einen festen Zugang: POST /api/messenger/zugang
//      -> { zugang: <id>, geheimnis } (Geheimnis nur in dieser Antwort, hier
//      nur sein sha256).
//   2. Mit { zugang, geheimnis } holt die App laufend ein kurzlebiges
//      Messenger-Token (HS256, iss rosenweg-app, 1 h), das der message-store
//      wie das Anlage-Token der geteilten Telefone annimmt.
//   3. Der message-store schreibt die Zugangs-ID als Claim "mz" ins MQTT-JWT;
//      der Broker-Auth (server.js /api/mqtt/*) weist Tokens eines geloeschten
//      Zugangs sofort ab, Benutzername dort msg-<uid>-z<mz>.
//
// Widerruf: App (abmelden), die Person selbst oder Technik (Portal
// /smartphones) loeschen die Zeile. Danach: Token holen -> 401 (die App
// meldet sich ab und loescht ihre Messenger-Daten), Broker -> 403.
//
// Schluessel fuer die Tokens: MESSENGER_PRIVAT_SECRET, sonst abgeleitet aus
// MESSENGER_SERVICE_SECRET (das teilen Website und message-store schon).
// Abgeleitet heisst: HMAC-SHA256(SERVICE_SECRET, KONTEXT) — der Kopf-Zugang
// X-Messenger-Service und die Token-Signatur nutzen so nie denselben Wert.

const crypto = require('crypto');

// Obergrenze Handys je Person (Stefan 26.11.2026: Zugaenge von extern 20 je Person).
// Einstellung MESSENGER_PRIVAT_MAX, Standard 20.
function maxJePerson(env = process.env) {
  const n = parseInt(String(env.MESSENGER_PRIVAT_MAX || ''), 10);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : 20;
}
const TOKEN_SEKUNDEN = 3600;
const ISSUER = 'rosenweg-app';
const AUDIENCE = 'rosenweg-messenger';
const KONTEXT = 'rosenweg-messenger-privat-v1';

/** Signierschluessel (Buffer) oder null, wenn nichts eingerichtet ist. */
function signierSchluessel(env = process.env) {
  if (env.MESSENGER_PRIVAT_SECRET) return Buffer.from(String(env.MESSENGER_PRIVAT_SECRET));
  if (env.MESSENGER_SERVICE_SECRET) {
    return crypto.createHmac('sha256', String(env.MESSENGER_SERVICE_SECRET)).update(KONTEXT).digest();
  }
  return null;
}

const b64u = (x) => Buffer.from(x).toString('base64url');

/** Messenger-Token fuer eine users-Zeile und einen Zugang. */
function signiereToken({ userId, email, name, groups, zugangId }, schluessel, jetztSek = Math.floor(Date.now() / 1000)) {
  const kopf = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const inhalt = b64u(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, sub: String(userId), email: email || '', name: name || '',
    groups: (groups || []).map(String), mz: String(zugangId),
    iat: jetztSek, exp: jetztSek + TOKEN_SEKUNDEN,
  }));
  const sig = crypto.createHmac('sha256', schluessel).update(`${kopf}.${inhalt}`).digest('base64url');
  return { token: `${kopf}.${inhalt}.${sig}`, gueltigBis: jetztSek + TOKEN_SEKUNDEN };
}

/** Neues Geheimnis (Klartext fuer die App) und sein Hash (fuer die DB). */
function neuesGeheimnis() {
  const geheimnis = crypto.randomBytes(32).toString('base64url');
  return { geheimnis, hash: geheimnisHash(geheimnis) };
}

function geheimnisHash(g) {
  return crypto.createHash('sha256').update(String(g)).digest('hex');
}

/** Konstante Laufzeit; false bei fehlenden/ungleich langen Werten. */
function geheimnisPasst(geheimnis, hash) {
  if (typeof geheimnis !== 'string' || !geheimnis || geheimnis.length > 200 || typeof hash !== 'string') return false;
  const a = Buffer.from(geheimnisHash(geheimnis));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Zugangs-ID aus dem Body (Zahl oder Text), sonst null. */
function zugangId(x) {
  const s = String(x == null ? '' : x).trim();
  if (!/^[0-9]{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** Geraetename fuer die Anzeige: ohne Steuerzeichen, hoechstens 60 Zeichen. */
function geraeteName(x) {
  return String(x == null ? '' : x).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60);
}

/**
 * Broker-Benutzername zu einem Messenger-JWT: msg-<sub>, fuer das eigene Handy
 * msg-<sub>-z<mz>. Eigener Name je Zugang, weil go-auth bei aclcheck nur den
 * Benutzernamen schickt — sonst ueberschriebe ein (widerrufenes) Handy die
 * gemerkten Claims der anderen Geraete derselben Person.
 */
function brokerBenutzername(claims) {
  if (!claims || claims.sub == null) return null;
  const mz = claims.mz != null ? zugangId(claims.mz) : null;
  if (claims.mz != null && !mz) return null;
  return 'msg-' + String(claims.sub) + (mz ? '-z' + mz : '');
}

module.exports = {
  maxJePerson, TOKEN_SEKUNDEN, ISSUER, AUDIENCE,
  signierSchluessel, signiereToken, neuesGeheimnis, geheimnisHash, geheimnisPasst,
  zugangId, geraeteName, brokerBenutzername,
};
