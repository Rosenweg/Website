// Was darf ein schwacher Ausweis NICHT? — Sperrliste fuer authMiddleware
// (middleware/auth.js), hier rein und ohne Datenbank, damit api/test sie prueft.
//
// Zugangstoken (rw_pat_…), Karten-/QR-/Handy-Sitzungen (rw_app_…) und das
// Anlage-Token der geteilten Telefone duerfen nichts aendern, womit man sich
// anmeldet: Passwort, weitere Token, Passkeys, OAuth-Fluss, MQTT-Zugangsdaten.
// SSH-Schluessel und die Token-Verwaltung sperrt zusaetzlich requireUserLogin
// an der Route.
//
// Ausnahmen fuer die Karte (Entscheid Stefan 28.11.2026, "Karte wie Schluessel"):
//   GET /api/auth/me        wer bin ich (lesen; braucht u. a. die Telefonanlage)
//   PUT /api/auth/profile   eigene Profil-Angaben (Name, Telefon, Adresse, STWEG)
//   PUT /api/auth/avatar    eigenes Profilbild
// Die beiden PUT sind kein Ausweis: sie aendern nicht, womit man sich anmeldet.
// Der Name, unter dem digital signiert wird, kommt nicht aus diesem Feld
// (vmKontoNamen nimmt den selbst geaenderten Namen nicht). Jede Aenderung mit
// der Karte steht im admin_protokoll (Bereich 'profil'). Fuer PATs bleibt alles
// unter /api/auth/ zu.

const PAT_GESPERRT = [
  'change-password',      // Passwort — das eigentliche Loch
  'me/tokens',            // weitere Token
  'me/passkeys',          // Passkeys
  'auth',                 // OAuth-Fluss, Profil-Login
  'mqtt/my-app-passwords',// MQTT-Zugangsdaten
  'mqtt/user-app-passwords',// MQTT-Zugangsdaten anderer (Technik)
];

// Genau diese Anfragen (Methode + Pfad, ohne Unterpfade) sind mit der Karte frei.
const KARTE_FREI = new Set(['GET auth/me', 'PUT auth/profile', 'PUT auth/avatar']);

/** /api/Foo//bar/ -> foo/bar (wie Express routet: Gross/klein und End-Schraegstrich egal). */
function pfadNormal(p) {
  return String(p || '').split('?')[0].toLowerCase()
    .replace(/\/{2,}/g, '/').replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
}

/** Liegt der (normalisierte) Pfad in der Sperrliste? */
function gesperrt(vollerPfad) {
  return PAT_GESPERRT.some(pfx => vollerPfad === pfx || vollerPfad.startsWith(pfx + '/'));
}

/** Persoenliches Zugangstoken: Sperrliste ohne Ausnahme. */
function patGesperrt(vollerPfad) {
  return gesperrt(vollerPfad);
}

/** Karten-, QR-, Handy-Sitzung oder geteiltes Telefon: Sperrliste mit den Ausnahmen KARTE_FREI. */
function karteGesperrt(methode, vollerPfad) {
  if (KARTE_FREI.has(`${String(methode || '').toUpperCase()} ${vollerPfad}`)) return false;
  return gesperrt(vollerPfad);
}

module.exports = { PAT_GESPERRT, KARTE_FREI, pfadNormal, gesperrt, patGesperrt, karteGesperrt };
