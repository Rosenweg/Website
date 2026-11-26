// ─── Gemeinsame Geraetekennung der Rosenweg-Apps ──────────────────────────
//
// Stefan 26.11.2026: Im Portal (/smartphones, Profil) soll jedes eigene Handy
// genau einmal erscheinen, darunter die Rosenweg-Apps, die darauf angemeldet
// sind (Telefon, Messenger, Karten-Sitzungen der anderen Apps).
//
// Die Apps schicken geraet_kennung = sha256("rosenweg:" + ANDROID_ID) als Hex
// (commons-rosenweg KartenSitzung.geraetKennung; Telefon und Messenger
// rechnen genauso). Seit Android 8 ist ANDROID_ID je Signaturschluessel: alle
// Rosenweg-Apps eines Handys liefern denselben Wert, fremde Apps einen anderen.
//
// Nach aussen (Browser) geht nie die Kennung, nur ein Gruppenschluessel je
// Person: sha256(email | kennung), 16 Hex. Zwei Personen auf demselben Handy
// bekommen so verschiedene Schluessel, und aus dem Schluessel laesst sich das
// Handy nicht wiedererkennen. Dieselbe Formel steht in pbx/api/app.py
// (_geraet_gruppe), damit der Browser beide Quellen zusammenlegen kann.
const crypto = require('crypto');

const KENNUNG_RE = /^[0-9a-f]{64}$/;

/** Kennung aus dem Body pruefen: 64 Hex (klein) oder null. */
function kennung(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return KENNUNG_RE.test(k) ? k : null;
}

/** Gruppenschluessel fuer den Browser oder null (alte Eintraege ohne Kennung). */
function gruppe(email, k) {
  if (!k || !KENNUNG_RE.test(String(k))) return null;
  return crypto.createHash('sha256').update(`${String(email || '').trim().toLowerCase()}|${k}`).digest('hex').slice(0, 16);
}

module.exports = { kennung, gruppe, KENNUNG_RE };
