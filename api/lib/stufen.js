// Anmelde-Stufen — wie ist die Person hinter einer Anfrage angemeldet?
//
//   karte  < konto  < frisch
//
// karte   Karten-, QR- oder Handy-Sitzung einer Rosenweg-App (rw_app_…) und
//         Anlage-Token der geteilten Telefone.
// konto   Anmeldung mit dem Rosenweg-Konto über Authentik: Website-Sitzung,
//         Access-Token der Apps (rosenweg-apps, PKCE), Authentik-Token des
//         Website-Clients; persönliche Zugangstoken (rw_pat_…); eine per
//         E-Mail bestätigte Karten-Aktion (rw_best_…, lib/kartenadmin.js).
// frisch  konto, und die Anmeldung selbst (auth_time) liegt höchstens
//         STUFE_FRISCH_MIN Minuten zurück (nur Website und Authentik-Tokens).
//
// Entscheid Stefan 27.11.2026: "Die Karte wird wie ein Schlüssel behandelt."
// Die Stufe SPERRT NICHTS. Sie steht in req.auth und in GET /api/auth/me
// (anmeldung) als Auskunft. Was mit der Karte anders ist, regelt
// lib/kartenadmin.js: Admin-Aktionen werden protokolliert und quittiert,
// die zwölf heiklen müssen per E-Mail bestätigt werden.
//
// Rein, ohne Datenbank — damit es in api/test ohne pg prüfbar ist.

const RANG = { karte: 1, konto: 2, frisch: 3 };
const STUFEN = Object.keys(RANG);

function zahlAusEnv(name, standard, min, max) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : standard;
}
// Wie lange eine Konto-Anmeldung als frisch gilt (Minuten).
const FRISCH_MIN = zahlAusEnv('STUFE_FRISCH_MIN', 15, 1, 240);

// Art des Ausweises -> Grundstufe. Unbekannte Arten zählen als karte.
const GRUNDSTUFE = {
  karte: 'karte', qr: 'karte', handy: 'karte', anlage: 'karte',
  website: 'konto', otp: 'konto', app: 'konto', authentik: 'konto', pat: 'konto', bestaetigt: 'konto',
};
// Nur diese Arten tragen eine echte Anmeldezeit von Authentik.
const KANN_FRISCH = new Set(['website', 'app', 'authentik']);
// Arten, die mit der Rosenweg-Karte (bzw. einem davon abgeleiteten Geräte-Ausweis) entstehen
const KARTEN_ARTEN = new Set(['karte', 'qr', 'handy', 'anlage']);

/** Claims eines JWT OHNE Signaturprüfung (nur für Tokens, die Authentik bestätigt hat bzw. die wir selbst geholt haben). */
function jwtClaims(token) {
  try {
    const teil = String(token || '').split('.')[1];
    if (!teil) return null;
    const c = JSON.parse(Buffer.from(teil, 'base64url').toString('utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch { return null; }
}

/** auth_time (Sekunden) aus Claims, sonst null. */
function authTimeAus(claims) {
  const t = Number(claims?.auth_time);
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : null;
}

/** Stufe aus Art und Anmeldezeit (Sekunden seit 1970 oder null). */
function anmeldung(art, authTime = null, jetztMs = Date.now()) {
  const a = String(art || '');
  let stufe = GRUNDSTUFE[a] || 'karte';
  const t = Number.isFinite(Number(authTime)) && Number(authTime) > 0 ? Math.floor(Number(authTime)) : null;
  if (stufe === 'konto' && KANN_FRISCH.has(a) && t) {
    const alter = jetztMs / 1000 - t;
    // höchstens eine Minute in der Zukunft (Uhrabweichung), sonst misstrauen
    if (alter >= -60 && alter <= FRISCH_MIN * 60) stufe = 'frisch';
  }
  return { stufe, art: a || 'unbekannt', auth_time: t };
}

function stufeReicht(ist, noetig) {
  return (RANG[ist] || 0) >= (RANG[noetig] || Infinity); // unbekannte Anforderung: nie erfüllt
}

/** Kommt die Anfrage mit der Karte (Karte, QR, Handy, geteiltes Telefon)? */
function istKartenSitzung(req) {
  return KARTEN_ARTEN.has(req?.auth?.art);
}

/**
 * Darf diese Anmeldung das Passwort wechseln? Nur frisch und nur mit einer
 * Anmeldung, die Authentik gerade bestaetigt hat: Website-Sitzung oder
 * Access-Token der Rosenweg-Apps.
 */
function passwortWechselErlaubt(auth) {
  return auth?.stufe === 'frisch' && (auth.art === 'website' || auth.art === 'app');
}

module.exports = { STUFEN, RANG, FRISCH_MIN, KARTEN_ARTEN, jwtClaims, authTimeAus, anmeldung, stufeReicht, istKartenSitzung, passwortWechselErlaubt };
