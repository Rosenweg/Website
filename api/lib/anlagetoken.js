// Anlage-Portal-Token: Anfragen der Rosenweg-Apps auf GETEILTEN Telefonen.
//
// Auf einem geteilten Telefon meldet sich keine App selbst an. Die App fragt
// Rosenweg Geraet (AnlageProvider, call "portal_anfrage"), Geraet fragt die
// PBX-API auf CT 220 (POST /api/telefon/portal, mit dem Geraetezugang), und die
// PBX-API stellt die Anfrage hier — mit einem Token, das sie fuer genau diese
// eine Anfrage ausstellt:
//
//   HS256, Schluessel PORTAL_ANLAGE_SECRET (nur hier und auf CT 220)
//   iss "rosenweg-anlage", aud "rosenweg-portal"
//   email, sub (users.id laut Sitzung), ext (Nebenstelle des Telefons), paket (App)
//   methode + pfad: genau diese Anfrage (pfad ohne /api/, klein, ohne Abfrage)
//   iat, exp (hoechstens 120 s), jti (nur einmal verwendbar)
//
// Wer die Person ist, sagt die Sitzung der Anlage (Karte am Sperrbildschirm);
// Gruppen und "aktiv" kommen hier frisch aus der users-Tabelle.
const crypto = require('crypto');

const ISS = 'rosenweg-anlage';
const AUD = 'rosenweg-portal';
const MAX_LEBEN_S = 120;
const UHR_TOLERANZ_S = 30;

function geheimnis() {
  return process.env.PORTAL_ANLAGE_SECRET || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlJson(s) {
  try {
    return JSON.parse(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Pfad so, wie ihn authMiddleware vergleicht: ohne /api/, klein, ohne doppelte und End-Schraegstriche. */
function pfadNormal(pfad) {
  return String(pfad || '').split('?')[0].toLowerCase()
    .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
}

/** Sieht aus wie ein Anlage-Token (ohne Signaturpruefung, nur zum Vorsortieren). */
function istAnlageToken(token) {
  const t = String(token || '').split('.');
  if (t.length !== 3 || token.length > 4096) return false;
  const kopf = b64urlJson(t[0]);
  const inhalt = b64urlJson(t[1]);
  return Boolean(kopf && inhalt && kopf.alg === 'HS256' && inhalt.iss === ISS && inhalt.aud === AUD);
}

// Verbrauchte jti bis zu ihrem Ablauf (ein Prozess; die Haupt-API laeuft einmal).
const verbraucht = new Map();
function aufraeumen(jetztS) {
  for (const [k, exp] of verbraucht) if (exp < jetztS) verbraucht.delete(k);
}

/**
 * Prueft Signatur, Frist und Einmaligkeit. -> Inhalt des Tokens oder null.
 * Ohne PORTAL_ANLAGE_SECRET ist der Weg aus (immer null).
 */
function anlageTokenPruefen(token, jetztMs = Date.now()) {
  const g = geheimnis();
  if (!g || !istAnlageToken(token)) return null;
  const [kopf, inhalt, sig] = token.split('.');
  const soll = b64url(crypto.createHmac('sha256', g).update(`${kopf}.${inhalt}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(soll);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const p = b64urlJson(inhalt);
  const jetzt = Math.floor(jetztMs / 1000);
  if (!p || typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
  if (p.exp <= jetzt || p.iat > jetzt + UHR_TOLERANZ_S || p.exp - p.iat > MAX_LEBEN_S) return null;
  if (typeof p.jti !== 'string' || p.jti.length < 16 || p.jti.length > 64) return null;
  if (typeof p.email !== 'string' || !p.email.includes('@')) return null;
  if (typeof p.methode !== 'string' || typeof p.pfad !== 'string') return null;
  aufraeumen(jetzt);
  if (verbraucht.has(p.jti)) return null;
  if (verbraucht.size > 50000) verbraucht.clear();
  verbraucht.set(p.jti, p.exp);
  return p;
}

/** Fuer Tests und Werkzeuge: Token wie die PBX-API ausstellen. */
function anlageTokenAusstellen(daten, g = geheimnis(), jetztMs = Date.now()) {
  const jetzt = Math.floor(jetztMs / 1000);
  const kopf = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const inhalt = b64url(JSON.stringify({
    iss: ISS, aud: AUD, iat: jetzt, exp: jetzt + 60, jti: crypto.randomBytes(16).toString('hex'),
    ...daten,
    pfad: pfadNormal(daten.pfad),
  }));
  const sig = b64url(crypto.createHmac('sha256', g).update(`${kopf}.${inhalt}`).digest());
  return `${kopf}.${inhalt}.${sig}`;
}

module.exports = { istAnlageToken, anlageTokenPruefen, anlageTokenAusstellen, pfadNormal, ISS, AUD, MAX_LEBEN_S };
