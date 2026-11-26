// ═══════════════════════════════════════════════════════════════════
// KIOSK-FERNSEHER (Rosenweg/rosenweg-tv-kiosk) — Entscheidungen ohne Datenbank
//
// Ein Kiosk ist ein Google-TV-Gerät mit der App „Rosenweg Kiosk" als
// Startseite: Diashow vorn, alles andere hinter einer PIN. Für Technik ist er
// eine Station wie die anderen (role 'kiosk', routes/stations.js): eigenes
// Token, Lebenszeichen, Sperren, Entfernen, Anschluss-Wächter.
//
// Hier liegt, was sich ohne Datenbank prüfen lässt (api/test/kiosk.test.js):
//   - Kopplungscode erzeugen und lesen
//   - PIN-Hash, derselbe wie in der App (PBKDF2-HMAC-SHA256, 60 000 Runden)
//   - PIN reversibel verschlüsseln (AES-256-GCM, Schlüssel aus STATION_PIN_KEY)
//   - das Lebenszeichen auf bekannte Felder zurechtstutzen
//   - „neueste Änderung gewinnt"
//   - die Antwort an den Fernseher
// ═══════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// ─── Kopplungscode ──────────────────────────────────────────────────
//
// Acht Zeichen ohne Verwechsler (kein I/1, O/0), angezeigt als ABCD-EFGH.
// 32^8 = 2^40 Möglichkeiten. Raten bringt trotzdem nichts: bestätigen kann
// nur Technik, angemeldet auf /stationen — der Code sagt nur, WELCHER
// wartende Fernseher gemeint ist.
const CODE_ZEICHEN = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LAENGE = 8;

function codeErzeugen() {
  const b = crypto.randomBytes(CODE_LAENGE);
  let c = '';
  for (let i = 0; i < CODE_LAENGE; i += 1) c += CODE_ZEICHEN[b[i] % CODE_ZEICHEN.length];
  return c;
}

/** Wie getippt (klein, mit Bindestrich, Leerzeichen) → ABCDEFGH oder null. */
function codeNormal(eingabe) {
  const c = String(eingabe || '').toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LAENGE) return null;
  for (const z of c) if (!CODE_ZEICHEN.includes(z)) return null;
  return c;
}

const codeAnzeige = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

// Das Token erzeugt der FERNSEHER und schickt bei der Kopplung nur seinen
// sha256. Damit steht das Token nie im Klartext in der Datenbank — auch nicht
// die paar Minuten zwischen Bestätigen und Abholen.
const TOKEN_HASH_MUSTER = /^[0-9a-f]{64}$/;

// ─── PIN ────────────────────────────────────────────────────────────

const PIN_RUNDEN = 60_000;
const pinGueltig = (pin) => typeof pin === 'string' && /^[0-9]{4,8}$/.test(pin);

/**
 * Derselbe Hash wie KioskSpeicher.pinSetzen in der App: PBKDF2WithHmacSHA256,
 * 16 Byte Salz, 256 Bit, Hex. Der Fernseher bekommt nur das — nie die PIN.
 */
function pinHash(pin, salzHex = crypto.randomBytes(16).toString('hex'), runden = PIN_RUNDEN) {
  if (!pinGueltig(pin)) throw new Error('PIN: 4 bis 8 Ziffern');
  const hash = crypto.pbkdf2Sync(pin, Buffer.from(salzHex, 'hex'), runden, 32, 'sha256').toString('hex');
  return { hash, salz: salzHex, runden };
}

function pinPruefen(pin, h) {
  if (!pinGueltig(pin) || !h?.hash || !h?.salz) return false;
  const neu = Buffer.from(pinHash(pin, h.salz, Number(h.runden) || PIN_RUNDEN).hash, 'hex');
  const alt = Buffer.from(String(h.hash), 'hex');
  return neu.length === alt.length && crypto.timingSafeEqual(neu, alt);
}

// Verschlüsselt, nicht gehasht: Technik soll die gültige PIN auf /stationen
// sehen können (Stefan, 26.11.2026). Der Schlüssel kommt aus STATION_PIN_KEY
// (beliebige Zeichenkette, mindestens 32 Zeichen; abgeleitet per HKDF), die
// Stations-Kennung ist Zusatzdaten — ein Wert lässt sich nicht in eine andere
// Zeile umkopieren. Ohne Schlüssel gibt es keine PIN-Anzeige; der Hash für
// den Fernseher geht trotzdem.
const PIN_ENV = 'STATION_PIN_KEY';

function pinSchluessel(geheim = process.env[PIN_ENV]) {
  if (!geheim || String(geheim).length < 32) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(geheim)), Buffer.alloc(0),
    Buffer.from('rosenweg-kiosk-pin-v1'), 32));
}

function pinVerschluesseln(pin, stationId, schluessel = pinSchluessel()) {
  if (!schluessel) throw new Error(`${PIN_ENV} fehlt`);
  if (!pinGueltig(pin)) throw new Error('PIN: 4 bis 8 Ziffern');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel, iv);
  c.setAAD(Buffer.from(String(stationId)));
  const daten = Buffer.concat([c.update(pin, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), daten].map((t) => (typeof t === 'string' ? t : t.toString('base64url'))).join('.');
}

function pinEntschluesseln(wert, stationId, schluessel = pinSchluessel()) {
  if (!schluessel) throw new Error(`${PIN_ENV} fehlt`);
  const [v, iv, tag, daten] = String(wert || '').split('.');
  if (v !== 'v1' || !iv || !tag || daten === undefined) throw new Error('PIN-Eintrag unlesbar');
  const d = crypto.createDecipheriv('aes-256-gcm', schluessel, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(stationId)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(daten, 'base64url')), d.final()]).toString('utf8');
}

// ─── Zeit: neueste Änderung gewinnt ─────────────────────────────────

function zeitLesen(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Gilt eine Änderung von `neu` gegenüber dem Stand `alt`? Ohne alten Stand
 * immer. Eine Zeit weiter als 10 min in der Zukunft (falsche Uhr am Gerät)
 * zählt als „jetzt" — sonst gewänne ein Fernseher mit vorgehender Uhr jeden
 * Streit, auch gegen spätere Änderungen auf /stationen.
 */
function neuerAls(neu, alt, jetzt = Date.now()) {
  let n = zeitLesen(neu);
  if (n === null) return false;
  if (n > jetzt + 10 * 60 * 1000) n = jetzt;
  const a = zeitLesen(alt);
  return a === null || n > a;
}

/** Wie neuerAls, gibt aber die Zeit zurück, die gespeichert wird (ISO). */
function standAus(neu, jetzt = Date.now()) {
  let n = zeitLesen(neu);
  if (n === null || n > jetzt + 10 * 60 * 1000) n = jetzt;
  return new Date(n).toISOString();
}

// ─── Lebenszeichen ──────────────────────────────────────────────────

const PAKET_MUSTER = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const paketOk = (p) => typeof p === 'string' && p.length <= 200 && PAKET_MUSTER.test(p);
const ANSICHTEN = ['diashow', 'pin', 'apps', 'einstellungen', 'gesperrt', 'koppeln', 'andere-app', 'leer'];

function normMac(m) {
  const s = String(m || '').trim().toLowerCase().replace(/-/g, ':');
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return null;
  // Android zeigt Apps ohne Berechtigung 02:00:00:00:00:00 statt der echten.
  if (s === '00:00:00:00:00:00' || s === '02:00:00:00:00:00') return null;
  return s;
}

/**
 * Nur bekannte Felder, mit Grenzen. last_state ist das, was /stationen
 * anzeigt — ein Fernseher soll dort keine beliebigen Daten ablegen können.
 */
function zustandBereinigen(roh) {
  const s = roh && typeof roh === 'object' && !Array.isArray(roh) ? roh : {};
  const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const zahl = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const ja = (v) => (typeof v === 'boolean' ? v : null);
  const z = {
    art: 'kiosk',
    app_version: text(s.app_version, 32),
    version_code: zahl(s.version_code),
    android: text(s.android, 16),
    sdk: zahl(s.sdk),
    hersteller: text(s.hersteller, 64),
    modell: text(s.modell, 64),
    diashow_paket: paketOk(s.diashow_paket) ? s.diashow_paket : null,
    diashow_name: text(s.diashow_name, 80),
    diashow_installiert: ja(s.diashow_installiert),
    diashow_vorn: ja(s.diashow_vorn),
    vorn_paket: paketOk(s.vorn_paket) ? s.vorn_paket : null,
    vorn_quelle: ['nutzungsdaten', 'schaetzung'].includes(s.vorn_quelle) ? s.vorn_quelle : null,
    ansicht: ANSICHTEN.includes(s.ansicht) ? s.ansicht : null,
    ip: text(s.ip, 64),
    uptime_seconds: zahl(s.uptime_seconds),
    pin_gesetzt: ja(s.pin_gesetzt),
    pin_stand: zeitLesen(s.pin_stand) ? new Date(zeitLesen(s.pin_stand)).toISOString() : null,
    gesperrt_lokal: ja(s.gesperrt_lokal),
    netz: ['wlan', 'kabel'].includes(s.netz) ? s.netz : null,
  };
  const macs = {};
  if (s.macs && typeof s.macs === 'object' && !Array.isArray(s.macs)) {
    for (const [name, mac] of Object.entries(s.macs).slice(0, 8)) {
      const m = normMac(mac);
      if (m && /^[A-Za-z0-9_.-]{1,16}$/.test(name)) macs[name] = m;
    }
  }
  z.macs = macs;
  z.apps = (Array.isArray(s.apps) ? s.apps : []).slice(0, 100)
    .filter((a) => a && paketOk(a.paket))
    .map((a) => ({ paket: a.paket, name: text(a.name, 80) || a.paket }));
  if (z.uptime_seconds !== null && z.uptime_seconds < 0) z.uptime_seconds = null;
  return z;
}

// ─── Antwort an den Fernseher ───────────────────────────────────────

const ABFRAGE_SEKUNDEN = 60;

/**
 * Was der Fernseher im Lebenszeichen zurückbekommt (und GET /config liefert).
 * Kein Geheimnis ausser dem PIN-Hash — den braucht er, um die PIN zu prüfen.
 * buildConfig() wird für einen Kiosk NIE aufgerufen: dort stünden
 * AD-Join-Passwort, root-Hash und MQTT-Zugang drin.
 */
function kioskAntwort(st) {
  const k = st.kiosk || {};
  const gesperrt = st.status === 'gesperrt';
  return {
    station_id: st.id,
    name: st.hostname || st.id,
    haus: st.haus || null,
    standort: st.standort || null,
    gesperrt,
    sperr_grund: gesperrt ? (st.sperr_grund || null) : null,
    abfrage_sekunden: ABFRAGE_SEKUNDEN,
    // Gesperrt: nichts weiter. Der Fernseher zeigt nur den Sperrhinweis und
    // behält PIN und Diashow-App, bis er entsperrt wird.
    diashow: !gesperrt && k.diashow?.paket ? { paket: k.diashow.paket, stand: k.diashow.stand || null } : null,
    pin: !gesperrt && k.pin_hash?.hash ? { ...k.pin_hash, stand: k.pin_stand || null } : null,
    pin_bekannt: !!k.pin_stand && !!k.pin_hash?.hash,
    neustart: !gesperrt ? (k.neustart || null) : null,
  };
}

/** Was /stationen über die Kiosk-Spalte sehen darf: ohne Hash. */
function kioskFuerVerwaltung(k, hatVerschluesselt) {
  if (!k) return null;
  return {
    diashow: k.diashow || null,
    pin_stand: k.pin_stand || null,
    pin_quelle: k.pin_quelle || null,
    pin_lesbar: !!hatVerschluesselt,
    neustart: k.neustart || null,
    neustart_von: k.neustart_von || null,
    neustart_erledigt: k.neustart_erledigt || null,
  };
}

// ─── QR-Code für den Fernseher ──────────────────────────────────────
//
// Die App hat keine QR-Bibliothek und soll keine bekommen: der Server
// liefert die Matrix (eine Zeile je Modulreihe, '1' = dunkel), die App malt
// sie Pixel für Pixel. qrcode ist ohnehin eine Abhängigkeit der API.
function qrMatrix(text) {
  const qr = require('qrcode').create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const zeilen = [];
  for (let y = 0; y < n; y += 1) {
    let z = '';
    for (let x = 0; x < n; x += 1) z += qr.modules.get(y, x) ? '1' : '0';
    zeilen.push(z);
  }
  return { groesse: n, zeilen };
}

module.exports = {
  CODE_ZEICHEN, CODE_LAENGE, codeErzeugen, codeNormal, codeAnzeige, TOKEN_HASH_MUSTER,
  PIN_RUNDEN, PIN_ENV, pinGueltig, pinHash, pinPruefen, pinSchluessel, pinVerschluesseln, pinEntschluesseln,
  neuerAls, standAus, zeitLesen,
  paketOk, normMac, zustandBereinigen,
  ABFRAGE_SEKUNDEN, kioskAntwort, kioskFuerVerwaltung, qrMatrix,
};
