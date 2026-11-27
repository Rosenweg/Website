// App-Kennung im Protokoll (Flutter-Plan 4.2.8).
//
// rosenweg_basis schickt bei jeder Anfrage
//   X-Rosenweg-App: <paket>/<version>     z. B. ch.rosenweg4303.salz/1.9.0
// authMiddleware liest den Kopf (req.rosenwegApp), schreibt ihn in den
// Audit-Kontext (lib/db.js setzt app.client neben app.user_email) und merkt
// sich je Person, App und Version den letzten Zeitpunkt (Tabelle
// app_kennungen, höchstens ein Schreibzugriff je Kombination und Stunde).
// GET /api/apps/kennungen zeigt der Technik, welche Fassungen unterwegs sind —
// Grundlage für eine spätere Mindestversion (426 → Updater).
//
// Der Kopf ist eine Selbstauskunft der App, kein Ausweis: er entscheidet
// nichts über Rechte. Ungültige Werte werden still übergangen.
const { PAKET_RE, nachPaket } = require('./appregister');

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;

/** Kopf -> { paket, version, bekannt, text } oder null. */
function appKennung(roh) {
  const s = String(Array.isArray(roh) ? roh[0] : roh || '').trim();
  if (!s || s.length > 140) return null;
  const i = s.lastIndexOf('/');
  if (i <= 0) return null;
  const paket = s.slice(0, i).toLowerCase();
  const version = s.slice(i + 1);
  if (!PAKET_RE.test(paket) || !VERSION_RE.test(version)) return null;
  return { paket, version, bekannt: !!nachPaket(paket), text: `${paket}/${version}` };
}

// ─── Merken (gedrosselt) ────────────────────────────────────────────────────
const zuletzt = new Map(); // email|paket|version -> ms
const DROSSEL_MS = 60 * 60 * 1000;
let tabelle = null;

function tabelleAnlegen(pool) {
  if (!tabelle) {
    tabelle = pool.query(`CREATE TABLE IF NOT EXISTS app_kennungen (
        email TEXT NOT NULL, paket TEXT NOT NULL, version TEXT NOT NULL,
        ausweis TEXT, erst_gesehen TIMESTAMP DEFAULT NOW(), zuletzt_gesehen TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (email, paket, version))`).catch((e) => { tabelle = null; throw e; });
  }
  return tabelle;
}

/** Nicht blockierend; Fehler nur ins Log. ausweis: Art der Anmeldung (Karte, Konto …). */
function merken(pool, email, kennung, ausweis = '', jetzt = Date.now()) {
  if (!kennung || !email) return false;
  const k = `${String(email).toLowerCase()}|${kennung.paket}|${kennung.version}`;
  if (jetzt - (zuletzt.get(k) || 0) < DROSSEL_MS) return false;
  if (zuletzt.size > 20000) zuletzt.clear();
  zuletzt.set(k, jetzt);
  tabelleAnlegen(pool).then(() => pool.query(
    `INSERT INTO app_kennungen (email, paket, version, ausweis) VALUES (LOWER($1), $2, $3, $4)
     ON CONFLICT (email, paket, version) DO UPDATE SET zuletzt_gesehen = NOW(), ausweis = EXCLUDED.ausweis`,
    [email, kennung.paket, kennung.version, String(ausweis || '').slice(0, 20)],
  )).catch((e) => console.error('[app-kennung]', e.message));
  return true;
}

module.exports = { appKennung, merken, tabelleAnlegen, VERSION_RE };
