// ─── Karten-Anmeldung der Rosenweg-Apps auf privaten Geräten (reine Logik) ──
//
// Ohne Datenbank und ohne Netz, damit es node --test prüfen kann. Die Route
// steht in routes/app-karte.js; dort auch der Ablauf und die Begründung.
//
// Bindung ans Gerät: die App erzeugt beim Anmelden ein Schlüsselpaar EC P-256
// im Android-Keystore (nicht exportierbar) und schickt nur den öffentlichen
// Schlüssel (SPKI, DER, Base64). Das Zugangs-Token (rw_app_…) lebt 15 Minuten;
// erneuern kann nur, wer eine frische Herausforderung des Servers mit dem
// privaten Schlüssel unterschreibt. Wer nur das Token abgreift, hat höchstens
// 15 Minuten; wer nur die Karten-UID hat, bekommt eine eigene, sichtbare und
// gemeldete Sitzung — nie die des Opfers.
const crypto = require('crypto');
const appregister = require('./appregister');

const TOKEN_PRAEFIX = 'rw_app_';
const SITZUNG_RE = /^ks_[0-9a-f]{32}$/;
const APP_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,6}$/i;   // Paketname / applicationId
const KENNUNG_RE = /^[0-9a-f]{64}$/;                          // sha256(ANDROID_ID) als Hex

function zufall(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function neueSitzungsId() {
  return 'ks_' + crypto.randomBytes(16).toString('hex');
}

function neuesZugangsToken() {
  return TOKEN_PRAEFIX + zufall(32);
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** UID der Karte wie in UniFi Access (nfc_id): Hex, gross, 4–10 Byte. null = ungültig. */
function kartenUid(roh) {
  const uid = String(roh || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return /^[0-9A-F]{8,20}$/.test(uid) && uid.length % 2 === 0 ? uid : null;
}

/** Öffentlicher Schlüssel (SPKI/DER Base64) -> KeyObject, nur EC P-256. null = ungültig. */
function oeffentlicherSchluessel(b64) {
  if (typeof b64 !== 'string' || b64.length < 80 || b64.length > 400) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ec') return null;
    if (k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return k;
  } catch { return null; }
}

/** Was die App zum Erneuern unterschreibt (SHA256withECDSA, DER). */
function erneuernText(sitzung, herausforderung) {
  return `rw-app-sitzung-erneuern\n${sitzung}\n${herausforderung}`;
}

function unterschriftGueltig(schluesselB64, text, unterschriftB64) {
  const k = oeffentlicherSchluessel(schluesselB64);
  if (!k || typeof unterschriftB64 !== 'string' || unterschriftB64.length > 200) return false;
  try {
    return crypto.verify('sha256', Buffer.from(text, 'utf8'), { key: k, dsaEncoding: 'der' },
      Buffer.from(unterschriftB64, 'base64'));
  } catch { return false; }
}

/** Gerätename/Plattform/App-Name für Anzeige und Mail: ohne Steuerzeichen, kurz. */
function anzeigeText(s, max = 60) {
  return String(s || '').replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** App, Gerät und Geräteschlüssel (gleich für Karte und QR). -> { ok:true, werte } | { ok:false, fehler } */
function appGeraetPruefen(b) {
  const app = String(b.app || '');
  if (!APP_RE.test(app) || app.length > 100) return { ok: false, fehler: 'App fehlt' };
  const g = b.geraet && typeof b.geraet === 'object' ? b.geraet : {};
  const kennung = String(g.kennung || '').toLowerCase();
  if (!KENNUNG_RE.test(kennung)) return { ok: false, fehler: 'Gerät fehlt' };
  if (!oeffentlicherSchluessel(b.schluessel)) return { ok: false, fehler: 'Geräteschlüssel fehlt' };
  return {
    ok: true,
    werte: {
      app, kennung, schluessel: b.schluessel,
      // Name aus dem App-Register (apps-register.json), wo es die App kennt: die
      // Anfrage kann sich so nicht als andere App ausgeben (Liste, Mail "neues Gerät")
      appName: anzeigeText(appregister.nachPaket(app.toLowerCase())?.name || b.app_name || app, 60),
      geraetName: anzeigeText(g.name || 'Unbekanntes Gerät', 60),
      plattform: anzeigeText(g.plattform || '', 40),
    },
  };
}

/**
 * Anfrage zur Karten-Anmeldung prüfen. -> { ok:true, werte } | { ok:false, fehler }
 * body: { uid, app, app_name?, geraet:{kennung, name?, plattform?}, schluessel }
 */
function anmeldungPruefen(body) {
  const b = body && typeof body === 'object' ? body : {};
  const uid = kartenUid(b.uid);
  if (!uid) return { ok: false, fehler: 'Karte nicht lesbar' };
  const p = appGeraetPruefen(b);
  return p.ok ? { ok: true, werte: { uid, ...p.werte } } : p;
}

// ─── Anmeldung per QR-Code (Stefan 27.11.2026) ──────────────────────────────
// Wie beim Sperrbildschirm der geteilten Telefone, aber für die App auf dem
// EIGENEN Handy: Die Person ist im Portal angemeldet (z. B. am Computer,
// /smartphones → "App auf eigenem Handy"), dort steht ein QR; die App scannt
// ihn mit der Kamera und bekommt ihre eigene Sitzung. Inhalt "RWAPP1:<token>"
// (anderer Präfix als "RWTEL1:" der geteilten Telefone: die beiden Codes sind
// nicht austauschbar) und bewusst keine URL. Einmalig, kurzlebig, je Person
// gilt nur der neueste.
const QR_PRAEFIX = 'RWAPP1:';
const QR_PRAEFIX_TELEFON = 'RWTEL1:';
const QR_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function neuesQrToken() {
  return zufall(24);
}

/** Gescannten Inhalt -> Token oder null (auch der blosse Token ohne Präfix gilt). */
function qrToken(roh) {
  let t = String(roh || '').trim();
  if (t.startsWith(QR_PRAEFIX)) t = t.slice(QR_PRAEFIX.length);
  return QR_TOKEN_RE.test(t) ? t : null;
}

/**
 * Anfrage zur QR-Anmeldung prüfen. -> { ok:true, werte } | { ok:false, fehler }
 * body: { token, app, app_name?, geraet:{kennung, name?, plattform?}, schluessel }
 */
function qrAnmeldungPruefen(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (String(b.token || '').trim().startsWith(QR_PRAEFIX_TELEFON)) {
    return { ok: false, fehler: 'Das ist der QR für geteilte Telefone. Wähle auf rosenweg4303.ch/smartphones „App auf eigenem Handy“.' };
  }
  const token = qrToken(b.token);
  if (!token) return { ok: false, fehler: 'Das ist kein Rosenweg-Anmeldecode' };
  const p = appGeraetPruefen(b);
  return p.ok ? { ok: true, werte: { token, ...p.werte } } : p;
}

// ─── "Mit dem Handy anmelden" (Stefan 27.11.2026) ────────────────────────────
// Umgekehrter QR für Computer ohne Kamera und ohne Kartenleser: die App am
// Computer zeigt einen QR mit der Portal-Adresse /app-anmelden#<code>; die
// Person scannt ihn mit der Kamera ihres Handys (jede Kamera-App genügt), ist im
// Portal angemeldet und bestätigt. Prinzip Geräte-Code (RFC 8628). Der kurze
// Benutzer-Code steht auch lesbar unter dem QR (zum Abtippen).
const HANDY_ZEICHEN = 'BCDFGHJKLMNPQRSTVWXZ23456789';   // ohne 0/O, 1/I, Vokale (keine Wörter)

function neuerBenutzerCode() {
  const b = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += HANDY_ZEICHEN[b[i] % HANDY_ZEICHEN.length];
  return c.slice(0, 4) + '-' + c.slice(4);
}

/** Eingabe/URL-Teil -> "ABCD-EFGH" oder null (Gross/klein, Leer- und Bindestriche egal). */
function benutzerCode(roh) {
  const c = String(roh || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8 || [...c].some(z => !HANDY_ZEICHEN.includes(z))) return null;
  return c.slice(0, 4) + '-' + c.slice(4);
}

/** Anfrage "Code holen" prüfen: App, Gerät, Schlüssel wie bei Karte und QR. */
function handyCodePruefen(body) {
  return appGeraetPruefen(body && typeof body === 'object' ? body : {});
}

// Wer darf einen Anmelde-QR für Apps (RWAPP1) ausstellen? Seit 28.11.2026 (Entscheid
// Stefan, "Karte wie Schlüssel") auch Karten-, QR- und Handy-Sitzungen und geteilte
// Telefone (Anlage-Token) — für das EIGENE Konto, protokolliert. Nie ein
// persönliches Zugangstoken (PAT: Skripte und Agents sollen keine Anmeldungen
// ausstellen) und nie ein per E-Mail bestätigter Einmal-Ausweis (rw_best_).
// req: { pat, kartenBestaetigung, user, auth } -> { ok:true } | { ok:false, status, fehler }
function qrAusstellenErlaubt(req) {
  if (req?.pat) return { ok: false, status: 403, fehler: 'Mit einem Zugangstoken nicht möglich — bitte mit dem Rosenweg-Konto oder der Karte anmelden' };
  if (req?.kartenBestaetigung || req?.auth?.art === 'bestaetigt') return { ok: false, status: 403, fehler: 'Nicht mit einer E-Mail-Bestätigung' };
  const email = String(req?.user?.email || '');
  const id = parseInt(req?.user?.id ?? req?.user?.user_id, 10);
  if (!email || !Number.isInteger(id)) return { ok: false, status: 403, fehler: 'Kein Rosenweg-Konto' };
  return { ok: true };
}

// Anmeldearten, die als Rosenweg-Konto gelten (lib/stufen.js GRUNDSTUFE konto, ohne
// PAT und E-Mail-Bestätigung). Nur ein QR, den eine solche Anmeldung ausgestellt hat,
// bestätigt eine digitale Signatur (lib/signaturbestaetigung.js): sonst könnte, wer
// an einem fremd angemeldeten geteilten Telefon steht, sich in Mein Telefon selbst
// einen QR holen und damit "bestätigen".
const KONTO_ARTEN = new Set(['website', 'otp', 'app', 'authentik']);
function qrVomKonto(ausgestelltArt) {
  return KONTO_ARTEN.has(String(ausgestelltArt || ''));
}

/** Ohne Karte angemeldet (QR oder Handy): beim Erneuern Konto statt Karte prüfen. */
function ohneKarte(art) {
  return art === 'qr' || art === 'handy';
}

/**
 * Ratenbegrenzung aus den gezählten Versuchen. Zählt nur Fehlversuche (ausser
 * "alle" je IP), damit eine Person mit vielen Apps nicht ausgesperrt wird.
 * zahlen: { ipFehl, ipAlle, uidFehl, geraetFehl, globalFehl } (je im Fenster)
 */
const GRENZEN = {
  fensterMin: 15,
  ipFehl: 10,       // falsche/fremde Karten je Absender-IP
  ipAlle: 40,       // alle Versuche je IP (auch erfolgreiche): 20 Apps × 2
  uidFehl: 5,       // je Karte (z. B. gesperrte Karte immer wieder)
  geraetFehl: 10,   // je Gerätekennung
  globalFehl: 200,  // alle zusammen: schützt UniFi Access
};

function gebremst(zahlen, grenzen = GRENZEN) {
  const z = zahlen || {};
  if ((z.globalFehl || 0) >= grenzen.globalFehl) return 'global';
  if ((z.ipFehl || 0) >= grenzen.ipFehl) return 'ip';
  if ((z.ipAlle || 0) >= grenzen.ipAlle) return 'ip';
  if ((z.uidFehl || 0) >= grenzen.uidFehl) return 'karte';
  if ((z.geraetFehl || 0) >= grenzen.geraetFehl) return 'geraet';
  return null;
}

/**
 * Obergrenze je Person (Entscheid Stefan 26.11.2026: 20 Sitzungen von extern).
 * Welche aktiven Sitzungen müssen für eine neue weichen? Die am längsten
 * unbenutzten zuerst (letzte Nutzung, sonst Anlage). sitzungen: [{id, zuletzt}]
 */
function abzuloesen(sitzungen, grenze) {
  const n = Math.max(1, Number(grenze) || 20);
  const liste = [...(sitzungen || [])].sort((a, b) => new Date(a.zuletzt) - new Date(b.zuletzt));
  const zuViel = liste.length - (n - 1);
  return zuViel > 0 ? liste.slice(0, zuViel).map(s => s.id) : [];
}

function istTechnikOderPraesident(groups) {
  return (groups || []).some(g => ['technik', 'präsident', 'praesident'].includes(String(g).toLowerCase()));
}

module.exports = {
  TOKEN_PRAEFIX, SITZUNG_RE, GRENZEN, QR_PRAEFIX, QR_PRAEFIX_TELEFON,
  neueSitzungsId, neuesZugangsToken, neuesQrToken, zufall, hash, kartenUid, qrToken,
  oeffentlicherSchluessel, erneuernText, unterschriftGueltig, anzeigeText,
  anmeldungPruefen, qrAnmeldungPruefen, gebremst, abzuloesen, istTechnikOderPraesident,
  neuerBenutzerCode, benutzerCode, handyCodePruefen, ohneKarte, qrAusstellenErlaubt, qrVomKonto, KONTO_ARTEN,
};
