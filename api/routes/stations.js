// ═══════════════════════════════════════════════════════════════════
// STATIONEN — Registrierung, Konfiguration und Aufsicht
// (Rosenweg/os-stationen)
//
// Ein Installationsmedium ist anonym: keine Kennung, kein Schlüssel, kein
// Passwort. Wer eine Station aufstellt, meldet sich am Gerät mit seinem
// Rosenweg-Konto an; erst dadurch bekommt das Gerät eine Identität.
//
// Aufsetzen darf jeder mit einem gültigen Konto — die Kontrolle passiert
// danach, nicht davor: jede neue Station taucht sofort in der Verwaltung
// auf und lässt sich dort sperren. Eine gesperrte Station bekommt keine
// Konfiguration mehr und fällt beim nächsten Lauf auf.
//
//   Installer (Einrichtungstoken)
//     POST   /api/stations/login          Benutzer + Passwort  -> Token
//     GET    /api/stations/types          Computer-Typen
//     POST   /api/stations/register       anlegen -> Kennung, Token, Config
//
//   Rechner im Haus (ohne Anmeldung, nur aus dem internen Netz)
//     GET    /api/stations/drucker/:rechner   Standarddrucker dieses Rechners
//     GET    /api/stations/programme/:rechner erlaubte Programme (AppLocker)
//     POST   /api/stations/programme/:rechner/probe  was die Liste blockiert hätte
//
//   Station selbst (Stationstoken)
//     GET    /api/stations/:id/config     Konfiguration abholen
//     POST   /api/stations/:id/seen       Lebenszeichen und Zustand melden
//     POST   /api/stations/:id/logs       Journal und Zustand einsenden
//     POST   /api/stations/:id/journal-zertifikat  Client-Zertifikat fuers Journal (CSR)
//     DELETE /api/stations/:id            sich selbst abmelden
//
//   Verwaltung (Anmeldung im Web, Gruppe technik)
//     GET    /api/stations/admin/list     alle Stationen mit Zustand
//     POST   /api/stations/admin/windows  Windows-Rechner von Hand eintragen
//     POST   /api/stations/admin/ad-abgleich  Windows-Rechner jetzt aus dem AD lesen
//     GET/PUT /api/stations/admin/windows-programme  erlaubte Programme für alle Windows-Rechner
//     PATCH  /api/stations/admin/:id      Haus, Standort, Notiz, overrides
//     GET    /api/stations/admin/:id/logs      eingesandte Logs, ohne Inhalt
//     GET    /api/stations/admin/:id/logs/:logId   ein Log im Klartext
//     POST   /api/stations/admin/:id/update   Update anfordern
//     POST   /api/stations/admin/:id/block    sperren
//     POST   /api/stations/admin/:id/unblock  entsperren
//     POST   /api/stations/admin/:id/anschluss-uebernehmen  neuen Anschluss lernen (+ freigeben)
//     POST   /api/stations/admin/:id/anschluss-vergessen    nächsten Anschluss ohne Sperre lernen
//     DELETE /api/stations/admin/:id/doppelt  Meldung "doppelte Station" erledigt
//     POST   /api/stations/admin/:id/ssh-wartung   SSH-Wartung freigeben (2 h)
//     DELETE /api/stations/admin/:id/ssh-wartung   Freigabe vorzeitig beenden
//     GET/POST/DELETE /api/stations/admin/wartungsschluessel[/:sid]
//                                      Schlüssel, die eine Freigabe hereinlässt
//     DELETE /api/stations/admin/:id          endgültig entfernen
//
// Ablauf und Begründung: os-stationen/docs/installer.md
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { authenticateAD } = require('../lib/adauth');
const { windowsRechnerLesen, adLesbar, STANDORT_REGELN } = require('../lib/adrechner');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik, isPraesident } = require('../lib/groups');
const {
  STATION_TYPES, VERWALTUNGS_TYPEN, DRUCKER, buildConfig, missingSecrets, hausWlan,
} = require('../lib/stationconfig');
const { HAEUSER } = require('../lib/haeuser');
const { wlanAufloesen, netznamen, unifiHolen, unifiBereit } = require('../lib/stationwlan');
const waechter = require('../lib/stationwaechter');
const { queueWhatsappMessage, resolveTechnikWhatsappGroupId } = require('../lib/whatsapp');
const { stationApps, gruppenJeApp } = require('../lib/stationapps');
const { telefonbuch } = require('../lib/telefonbuch');
const winprog = require('../lib/windowsprogramme');
const stationos = require('../lib/stationos');
const { schluesselPruefen, alsZeile } = require('../lib/sshkeys');

const router = express.Router();

// Express 4 fängt Fehler aus async-Handlern NICHT ab: eine abgelehnte Promise
// endet als unhandledRejection, die Anfrage bekommt nie eine Antwort, und der
// Aufrufer läuft in seinen Timeout. Genau das passierte beim Registrieren
// einer zuvor abgemeldeten Station. Deshalb jeder Handler durch diesen
// Wrapper — und am Ende ein Fehlerbehandler, der wenigstens sauber 500 sagt.
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SETUP_TTL_MINUTES = 30;
const SETUP_PREFIX = 'rw_setup_';
const STATION_PREFIX = 'rw_station_';
const APP_PREFIX = 'rw_app_';
const APP_TTL_TAGE = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = (prefix) => prefix + crypto.randomBytes(32).toString('hex');

let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id             TEXT PRIMARY KEY,
      role           TEXT NOT NULL,
      hostname       TEXT,
      standort       TEXT,
      notiz          TEXT,
      token_hash     TEXT NOT NULL,
      hardware       JSONB       NOT NULL DEFAULT '{}'::jsonb,
      overrides      JSONB       NOT NULL DEFAULT '{}'::jsonb,
      status         TEXT        NOT NULL DEFAULT 'aktiv',
      sperr_grund    TEXT,
      gesperrt_von   TEXT,
      gesperrt_am    TIMESTAMPTZ,
      registered_by  TEXT,
      registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at   TIMESTAMPTZ,
      last_seen_ip   TEXT,
      last_state     JSONB,
      revoked_at     TIMESTAMPTZ
    );
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'aktiv';
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS sperr_grund  TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS gesperrt_von TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS gesperrt_am  TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS last_seen_ip TEXT;
    -- Verschlüsselte Datenpartition: die Generation geht in die Ableitung des
    -- Schlüssels ein. Hochzählen und neu anlegen heisst neu verschlüsseln.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS persist_key_gen INT NOT NULL DEFAULT 1;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS persist_key_zuletzt TIMESTAMPTZ;
    -- Aufforderung aus der Verwaltung: "aktualisiere dich beim naechsten
    -- Lebenszeichen". Eine Station ist von aussen nicht erreichbar, also kann
    -- man ihr nichts schicken — sie fragt alle paar Minuten selbst nach.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS update_angefordert TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS update_angefordert_von TEXT;
    -- Aufforderung aus der Verwaltung: "loesche deine Identitaet und geh in den
    -- Einrichtungszustand". Wie beim Update holt die Station sie im
    -- Lebenszeichen ab; ein Zuruecksetzen von aussen gibt es nicht.
    --
    -- Das Token wird dabei NICHT vorher entwertet — sonst antwortete die API
    -- dieser Station mit 401 und die Aufforderung erreichte sie nie. Entwertet
    -- wird erst, wenn die Station sich selbst abmeldet.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS zuruecksetzen_angefordert TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS zuruecksetzen_angefordert_von TEXT;
    -- In welchem Haus steht die Station? Bestimmt, welche Ankuendigungen sie
    -- zeigt: die ohne Hausangabe plus die fuer genau dieses Haus. Ohne
    -- Eintrag zeigt sie alles.
    --
    -- Die Hausnummer und nicht das STWEG: aus ihr laesst sich das STWEG
    -- ableiten (api/lib/haeuser.js), umgekehrt nicht — ein STWEG umfasst bis
    -- zu drei Haeuser.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS haus INTEGER;
    -- Welche Programme auf dem Geraet ueberhaupt vorhanden sind. Die Station
    -- meldet das bei jedem Einrichtungslauf; die Verwaltung baut daraus die
    -- Auswahl fuer die Programmliste. Ohne diese Meldung muesste dort jemand
    -- Kennungen wie 'org.gnome.Evince.desktop' abtippen — und ein Tippfehler
    -- faellt erst auf, wenn am Geraet ein Symbol fehlt.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS programme JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS programme_gemeldet_am TIMESTAMPTZ;
    -- Windows-Rechner aus dem AD (26.11.2026). Erkannt wird ein Rechner an
    -- seiner objectGUID, nicht am Namen: ein umbenannter Rechner bleibt
    -- derselbe, und ein auf /stationen entfernter kommt nicht beim nächsten
    -- Abgleich wieder — wohl aber ein neu beigetretener mit gleichem Namen.
    --   ad_zustand: 'vorhanden' | 'deaktiviert' | 'fehlt' (im AD gelöscht)
    --   ad_standort_regel: woraus das Haus bei der Aufnahme abgeleitet wurde
    --     (z. B. 'Name R9-PC1'), leer = nicht erkennbar
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_guid TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_dn TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_zustand TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_betriebssystem TEXT;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_gesehen_am TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_aufgenommen_am TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS ad_standort_regel TEXT;
    -- Anzeigegeraete: Android-Tafeln mit der App SlideShow (sk.mimac.slideshow).
    -- Sie sind KEINE Stationen — kein eigenes OS, kein install.sh, kein Update
    -- ueber uns. Gemeinsam ist nur die Verwaltung: hier steht, welches Geraet
    -- wo haengt und unter welchem Namen es am MQTT-Broker Befehle entgegennimmt.
    --
    -- Das Passwort steht NICHT hier. Es lebt als sha256 in mqtt_service_users
    -- und wird beim Anlegen ein einziges Mal angezeigt; danach ist es weg. Wer
    -- es verliert, legt den Zugang neu an — billiger als ein Klartextpasswort
    -- in einer zweiten Tabelle.
    CREATE TABLE IF NOT EXISTS anzeigegeraete (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      standort      TEXT,
      notiz         TEXT,
      mqtt_thema    TEXT NOT NULL,
      mqtt_benutzer TEXT NOT NULL,
      haus          INTEGER,
      angelegt_von  TEXT,
      angelegt_am   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE anzeigegeraete ADD COLUMN IF NOT EXISTS haus INTEGER;
    -- alarm_playlist gab es einen Vormittag lang: die Nummer der Liste, auf die
    -- bei einem Notfall umgeschaltet wird. Sie ist ueberfluessig, seit die Liste
    -- auf jedem Geraet "Alarm" heisst und "playlistName" den Namen nimmt. Nie
    -- befuellt, darum weg statt ungenutzt stehen zu lassen.
    ALTER TABLE anzeigegeraete DROP COLUMN IF EXISTS alarm_playlist;
    -- In welcher Zone des Bildschirmlayouts der Alarm laufen soll.
    --
    -- Der Name der Wiedergabeliste ist ueberall gleich ("Alarm"), die Zone
    -- nicht: der Fernseher hat nur eine, das Tablet im Eingang drei
    -- (Hauptpanel, R92OG Kamera, R9EG Kamera). Ohne Angabe nimmt die App die
    -- Hauptzone ihres Layouts — beim Tablet ist das nicht die richtige, der
    -- Befehl verpuffte wirkungslos. Leer heisst: ohne Zonenangabe senden.
    ALTER TABLE anzeigegeraete ADD COLUMN IF NOT EXISTS alarm_zone TEXT;
    CREATE TABLE IF NOT EXISTS station_setup_sessions (
      token_hash   TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      display_name TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL
    );
    -- Die Gruppen der Person, die den Einrichtungsdialog bedient. Gebraucht,
    -- damit eine gesperrte Station nur von technik neu zugeordnet werden kann
    -- (siehe /register). Ohne die Spalte stand in der Sitzung nur der Name.
    ALTER TABLE station_setup_sessions ADD COLUMN IF NOT EXISTS groups_json TEXT;
    -- Die Mailadresse der anmeldenden Person. Ueber sie findet die
    -- Objektverwaltung ihre Wohnung — und damit das VLAN, in dem der
    -- WireGuard-Tunnel eines Laptops liegen muss.
    ALTER TABLE station_setup_sessions ADD COLUMN IF NOT EXISTS email TEXT;
    -- Dieselbe Angabe in der App-Sitzung: der Tunnel eines Laptops gehoert der
    -- angemeldeten Person, und ueber ihre Mailadresse findet die
    -- Objektverwaltung die Wohnung und damit das VLAN.
    ALTER TABLE station_app_sessions ADD COLUMN IF NOT EXISTS email TEXT;
    CREATE TABLE IF NOT EXISTS station_app_sessions (
      token_hash   TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      display_name TEXT,
      groups_json  TEXT NOT NULL DEFAULT '[]',
      station_id   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS station_events (
      id         BIGSERIAL PRIMARY KEY,
      station_id TEXT NOT NULL,
      art        TEXT NOT NULL,
      wer        TEXT,
      text       TEXT,
      erstellt   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS station_events_id_idx ON station_events (station_id, erstellt DESC);
    CREATE TABLE IF NOT EXISTS station_logs (
      id         BIGSERIAL PRIMARY KEY,
      station_id TEXT NOT NULL,
      teil       TEXT NOT NULL,
      inhalt     TEXT NOT NULL,
      bytes      INTEGER NOT NULL DEFAULT 0,
      erstellt   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS station_logs_id_idx ON station_logs (station_id, erstellt DESC);
    -- SSH-Wartung: Technik gibt eine Station fuer eine feste Zeit frei, und
    -- in dieser Zeit kommt das Wartungskonto (admin.user, rwadmin) mit den
    -- Schluesseln aus station_wartung_schluessel herein. Jede Freigabe bleibt
    -- als Zeile stehen — wer, wann, bis wann, wer sie beendet hat. Das ist
    -- das Protokoll; geloescht wird hier nichts.
    CREATE TABLE IF NOT EXISTS station_ssh_wartung (
      id          BIGSERIAL PRIMARY KEY,
      station_id  TEXT NOT NULL,
      erteilt_von TEXT NOT NULL,
      erteilt_am  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bis         TIMESTAMPTZ NOT NULL,
      beendet_von TEXT,
      beendet_am  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS station_ssh_wartung_offen_idx
      ON station_ssh_wartung (station_id, bis DESC) WHERE beendet_am IS NULL;
    -- Die Schluessel selbst. Absichtlich eine eigene Liste und nicht die
    -- Profilschluessel der Person, die freigibt: gewartet wird oft von einem
    -- Dienstkonto oder einem Rechner aus, der niemandes Profil gehoert. Nur
    -- oeffentliche Teile — ein Leck hier oeffnet nichts.
    CREATE TABLE IF NOT EXISTS station_wartung_schluessel (
      id          BIGSERIAL PRIMARY KEY,
      typ         TEXT NOT NULL,
      blob_b64    TEXT NOT NULL,
      kommentar   TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      label       TEXT,
      erstellt_von TEXT,
      erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Vorgaben, die fuer alle Rechner einer Art gelten (26.11.2026: die
    -- erlaubten Programme der Windows-Rechner, Schluessel 'windows_programme').
    -- Je Rechner steht der Rest wie gehabt in stations.overrides.
    CREATE TABLE IF NOT EXISTS station_vorgaben (
      schluessel    TEXT PRIMARY KEY,
      wert          JSONB NOT NULL,
      geaendert_von TEXT,
      geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Was die Positivliste auf einem Windows-Rechner blockiert hat oder
    -- blockiert haette (programme.ps1, POST /programme/:rechner/probe).
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS programme_probe JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS programme_probe_am TIMESTAMPTZ;
    -- Anschluss-Wächter (lib/stationwaechter.js): wo die MAC der Station in
    -- UniFi hängt. 'anschluss' ist die gelernte Liste (Kabel: ein Port;
    -- WLAN: die freigegebenen APs), 'anschluss_jetzt' der letzte Stand aus
    -- UniFi, 'anschluss_kandidat' ein fremder Anschluss, der noch einmal
    -- bestätigt werden muss, 'anschluss_abweichung' der fremde Anschluss,
    -- für den gesperrt wurde — ihn übernimmt "Anschluss übernehmen und
    -- freigeben".
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss_gelernt_am TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss_jetzt JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss_jetzt_am TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss_kandidat JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS anschluss_abweichung JSONB;
    -- Doppelte Station: zwei Geräte melden sich mit demselben Token.
    -- {seit, zuletzt, quellen:[…]}; bleibt stehen, bis Technik "Erledigt"
    -- drückt. Gemeldet (WhatsApp Technik) höchstens alle paar Stunden.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS doppelt JSONB;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS doppelt_gemeldet_am TIMESTAMPTZ;
    -- Die letzten Lebenszeichen je Station, nur so lange, wie die Erkennung
    -- sie braucht (zwei Stunden). Adresse, lokale Adresse, Startzeit.
    CREATE TABLE IF NOT EXISTS station_lebenszeichen (
      id         BIGSERIAL PRIMARY KEY,
      station_id TEXT NOT NULL,
      erstellt   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      quelle_ip  TEXT,
      lokal_ip   TEXT,
      boot       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS station_lebenszeichen_id_idx ON station_lebenszeichen (station_id, erstellt DESC);
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function ereignis(stationId, art, wer, text) {
  return pool.query(
    'INSERT INTO station_events (station_id, art, wer, text) VALUES ($1,$2,$3,$4)',
    [stationId, art, wer || null, text || null],
  ).catch((e) => console.error('[stations] Ereignis nicht geschrieben:', e.message));
}

// Der erste Eintrag in X-Forwarded-For ist frei waehlbar: wer am Edge vorbei
// eine Frontend-nginx oder die API direkt erreicht, schreibt "10.0.0.5" hinein
// und gilt als Hausnetz (persist-key). Deshalb von rechts lesen und nur die
// eigenen Proxy-Hops ueberspringen; der erste fremde Eintrag ist der Client.
const PROXY_NETZE = (process.env.STATION_PROXY_NETZE
  || '100.64.2.0/24,172.16.0.0/12,127.0.0.0/8,::1')
  .split(',').map((s) => s.trim()).filter(Boolean);

function clientIp(req) {
  const kette = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const direkt = req.socket?.remoteAddress || req.ip || null;
  if (direkt) kette.push(direkt);
  for (let i = kette.length - 1; i >= 0; i -= 1) {
    if (!PROXY_NETZE.some((netz) => ipInNetz(kette[i], netz))) return kette[i];
  }
  // Nur Proxy-Adressen: die Anfrage kam von innen ohne fremden Hop.
  return kette[0] || null;
}

// ─── Token-Prüfungen ────────────────────────────────────────────────

async function setupSession(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token.startsWith(SETUP_PREFIX)) return res.status(401).json({ error: 'Kein Einrichtungstoken' });
    await ensureSchema();
    await pool.query('DELETE FROM station_setup_sessions WHERE expires_at < NOW()');
    const r = await pool.query(
      'SELECT * FROM station_setup_sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [sha256(token)],
    );
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Einrichtungstoken abgelaufen — bitte neu anmelden' });
    }
    req.setupUser = r.rows[0];
    next();
  } catch (e) { next(e); }
}

async function stationAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token.startsWith(STATION_PREFIX)) return res.status(401).json({ error: 'Kein Stationstoken' });
    await ensureSchema();
    const r = await pool.query(
      'SELECT * FROM stations WHERE token_hash = $1 AND revoked_at IS NULL',
      [sha256(token)],
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Stationstoken ungültig' });
    const station = r.rows[0];

    // Das Token gilt nur für die eigene Station.
    if (req.params.id && req.params.id !== station.id) {
      return res.status(403).json({ error: 'Token gehört zu einer anderen Station' });
    }
    // Gesperrt heisst gesperrt — aber das Lebenszeichen darf durch, sonst
    // sieht die Verwaltung nicht mehr, ob das Gerät noch läuft.
    if (station.status === 'gesperrt' && !req.path.endsWith('/seen')) {
      return res.status(403).json({
        error: `Diese Station ist gesperrt${station.sperr_grund ? ': ' + station.sperr_grund : '.'}`,
        gesperrt: true,
      });
    }
    req.station = station;
    next();
  } catch (e) { next(e); }
}

// Wie nurTechnik, aber fuer die App-Sitzung: dort stehen die Gruppen aus dem
// AD, nicht die eines Web-Logins. publish-os.sh meldet sich so an — es waere
// unsinnig, dafuer einen zweiten Anmeldeweg zu verlangen.
function nurTechnikApp(req, res, next) {
  let groups = [];
  try { groups = JSON.parse(req.appUser?.groups_json || '[]'); } catch { groups = []; }
  if (isTechnik(groups) || isPraesident(groups)) return next();
  return res.status(403).json({ error: 'Nur die Gruppe technik darf Versionen veröffentlichen' });
}

// Wie nurTechnikApp, aber zusätzlich für eine Gruppe, die NUR das darf.
//
// 'technik' ist im Haus der Generalschlüssel: über technik-authentik hängt
// daran unter anderem Administrator auf dem ganzen Proxmox-Cluster. Für einen
// Vorgang, der einen Tarball hochlädt, ist das zu viel — erst recht, wenn das
// Passwort dafür auf einem Rechner liegen muss, damit etwas automatisch
// veröffentlichen kann.
//
// Deshalb: wer in 'os-veroeffentlichen' ist, darf genau diesen einen
// Endpunkt und sonst nichts. Die Gruppe steht in keiner anderen Prüfung.
function darfOsVeroeffentlichen(req, res, next) {
  let groups = [];
  try { groups = JSON.parse(req.appUser?.groups_json || '[]'); } catch { groups = []; }
  if (groups.includes('os-veroeffentlichen')) return next();
  return nurTechnikApp(req, res, next);
}

function nurTechnik(req, res, next) {
  const groups = req.user?.groups || [];
  if (req.user?.isAdmin || isTechnik(groups) || isPraesident(groups)) return next();
  return res.status(403).json({ error: 'Nur Technik darf Stationen verwalten' });
}

// ─── Anmeldung (Installer) ──────────────────────────────────────────

// POST /api/stations/login  { username, password }
//
// Bewusst ohne Gruppenprüfung: eine Station aufsetzen darf jeder mit einem
// gültigen Rosenweg-Konto. Wer es war, steht in registered_by, und jede neue
// Station taucht sofort in der Verwaltung auf.
// Fehlversuche beim AD-Passwort-Login (Stationen + App): ohne Grenze liessen sich
// Passwoerter beliebig oft durchprobieren, auch fuer Technik-Konten.
const AD_FEHL_FENSTER_MS = 15 * 60 * 1000;
// Pro Benutzername 10 Versuche. Dazu eine Grenze je Absender-IP (clientIp, von
// rechts gelesen) gegen das Durchprobieren vieler Namen. Frueher war das eine
// globale Grenze — wer 100 falsche Logins schickte, sperrte alle aus.
const adFehlversuche = new Map(); // 'u:<name>' / 'ip:<adresse>' -> [zeitpunkte]
// Der Zaehler haengt am normalisierten Namen: " Stefan", "stefan@ad.rosenweg4303.ch"
// und "AD\\stefan" sind fuer das AD dasselbe Konto, haetten aber je eigene
// 10 Versuche bekommen. Die IP-Grenze ist hoch genug, dass ein paar
// Tippfehler im Haus (gemeinsame oeffentliche Adresse) niemanden aussperren.
const AD_FEHL_JE_IP = 50;
function adNameKey(username) {
  let n = String(username || '').trim().toLowerCase();
  if (n.includes('\\')) n = n.slice(n.lastIndexOf('\\') + 1);
  if (n.includes('@')) n = n.slice(0, n.indexOf('@'));
  return 'u:' + n.trim();
}
function adIpKey(req) {
  return 'ip:' + (clientIp(req) || 'unbekannt');
}
function adGesperrt(req, username) {
  const jetzt = Date.now();
  const zaehle = (k) => (adFehlversuche.get(k) || []).filter(t => jetzt - t < AD_FEHL_FENSTER_MS).length;
  return zaehle(adNameKey(username)) >= 10 || zaehle(adIpKey(req)) >= AD_FEHL_JE_IP;
}
// Versuch VOR dem AD-Aufruf vormerken: sonst laufen beliebig viele parallele
// Anfragen durch die Pruefung, bevor die erste ihren Fehlschlag eintraegt.
// Bei Erfolg (oder AD nicht erreichbar) wird der Eintrag wieder entfernt.
function adVersuchVormerken(req, username) {
  const jetzt = Date.now();
  const keys = [adNameKey(username), adIpKey(req)];
  for (const k of keys) {
    adFehlversuche.set(k, [...(adFehlversuche.get(k) || []).filter(t => jetzt - t < AD_FEHL_FENSTER_MS), jetzt]);
  }
  return { keys, t: jetzt };
}
function adVersuchZuruecknehmen(v) {
  for (const k of v.keys) {
    const liste = adFehlversuche.get(k);
    if (!liste) continue;
    const i = liste.indexOf(v.t);
    if (i >= 0) liste.splice(i, 1);
    if (!liste.length) adFehlversuche.delete(k);
  }
}
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, v] of adFehlversuche) if (!v.some(t => jetzt - t < AD_FEHL_FENSTER_MS)) adFehlversuche.delete(k);
}, 10 * 60 * 1000).unref();

router.post('/login', a(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzer und Passwort nötig' });
  if (adGesperrt(req, username)) return res.status(429).json({ error: 'Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen' });
  const versuch = adVersuchVormerken(req, username);

  let user;
  try {
    user = await authenticateAD(username, password);
  } catch (e) {
    adVersuchZuruecknehmen(versuch);
    console.error('[stations] AD nicht erreichbar:', e.message);
    return res.status(503).json({ error: 'Verzeichnisdienst nicht erreichbar' });
  }
  if (!user) return res.status(401).json({ error: 'Benutzer oder Passwort stimmt nicht' });
  adVersuchZuruecknehmen(versuch);
  adFehlversuche.delete(adNameKey(username));

  const fehlt = missingSecrets();
  if (fehlt.length) {
    console.error('[stations] Umgebung unvollständig:', fehlt.join(', '));
    return res.status(500).json({ error: `Server unvollständig konfiguriert: ${fehlt.join(', ')}` });
  }

  await ensureSchema();
  const token = newToken(SETUP_PREFIX);
  await pool.query(
    `INSERT INTO station_setup_sessions (token_hash, username, display_name, groups_json, email, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)`,
    [sha256(token), user.username, user.displayName,
      JSON.stringify(user.groups || []), user.email || null, String(SETUP_TTL_MINUTES)],
  );
  res.json({
    token,
    expires_in: SETUP_TTL_MINUTES * 60,
    user: { name: user.displayName, username: user.username },
  });
}));

// GET /api/stations/types
router.get('/types', setupSession, (req, res) => res.json({ types: STATION_TYPES }));

// ─── Standarddrucker je Rechner ─────────────────────────────────────
//
// GET /api/stations/drucker/:rechner
//
// Für das Anmeldeskript der Windows-Rechner (und später jeden anderen
// Rechner, der fragen will): „welcher Drucker ist hier der Standard?"
// Gepflegt wird er in der Verwaltung unter „Einstellen …" der Station.
//
// Ohne Anmeldung, weil ein Anmeldeskript nichts hat, womit es sich
// ausweisen könnte — und ein Geheimnis dafür auf jeden Rechner zu legen,
// schützte eine Antwort, die selbst nichts Geheimes enthält: einen
// Druckernamen, der ohnehin in jedem Druckdialog im Haus steht. Was bleibt,
// ist „nur von innen": draussen soll niemand die Rechnernamen des Hauses
// durchprobieren können.
//
// Das Format ist mit dem Windows-Anmeldeskript vereinbart und darf sich nicht
// ändern:
//   {"rechner":"WIN11-1","bekannt":true,"standard":"DruckerR9"}
//   {"rechner":"WIN11-1","bekannt":true,"standard":null}     keiner gewählt
//   {"rechner":"…","bekannt":false,"standard":null}           unbekannt
// Gesperrte und entfernte Stationen gelten als unbekannt: eine Station, die
// jemand gesperrt hat, soll nicht weiter Einstellungen verteilen.
//
// MUSS vor den /:id-Routen stehen: '/drucker/os' passte sonst auf '/:id/os'.
const RECHNER_MUSTER = /^[A-Za-z0-9-]{1,63}$/;

// Nur aus dem internen Netz. JEDE Adresse der Kette muss innen liegen — die
// eigenen Proxys (Edge, Frontend) sind es, der Client hinter ihnen muss es
// auch sein. Kommt die Anfrage über Cloudflare oder von aussen herein, steht
// dort eine fremde Adresse, und das genügt für ein Nein.
//
// Anders als clientIp() wird hier nicht "der Client" gesucht, sondern
// geprüft, ob irgendwo ein Fremder in der Kette steht. Ein vorgetäuschtes
// "10.0.0.5" hilft damit niemandem: Traefik verwirft eingehende Werte und
// setzt die Adresse, die es sieht — und selbst wenn ein Proxy sie nur
// anhängte, stünde die echte, fremde Adresse dahinter und gäbe das Nein.
// Innen heisst INTERN_NETZE (wie beim Schlüssel der Datenpartition), also mit
// dem IPv6-Präfix des Hauses: ein Rechner, der den Edge über IPv6 erreicht,
// kommt mit seiner öffentlichen, aber eigenen Adresse an.
function nurAusDemHausnetz(req) {
  const kette = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  kette.push(req.socket?.remoteAddress || '');
  return kette.every((ip) => istHausnetz(ip));
}

/** Der in der Verwaltung gewählte Standarddrucker — oder null für „keiner". */
function standardDrucker(station) {
  const wert = station?.overrides?.roles?.[station.role]?.printing?.default;
  return typeof wert === 'string' && wert.trim() ? wert.trim() : null;
}

router.get('/drucker/:rechner', a(async (req, res) => {
  // Vor allem anderen: auch eine Fehlermeldung soll nirgends liegen bleiben.
  res.set('Cache-Control', 'no-store');
  if (!nurAusDemHausnetz(req)) {
    return res.status(403).json({ error: 'Nur aus dem internen Netz' });
  }
  const rechner = String(req.params.rechner || '');
  if (!RECHNER_MUSTER.test(rechner)) {
    return res.status(400).json({ error: 'Ungültiger Rechnername' });
  }
  await ensureSchema();
  // Gross/klein egal: Windows meldet WIN11-1, eine Linux-Station heisst
  // r9-pc1. Gäbe es den Namen doppelt (zwei Linux-Stationen, gleicher
  // Hostname), gewinnt die, die sich zuletzt gemeldet hat — die andere ist
  // vermutlich das alte Gerät.
  const r = await pool.query(
    `SELECT role, overrides FROM stations
      WHERE LOWER(COALESCE(hostname, id)) = LOWER($1)
        AND revoked_at IS NULL AND status = 'aktiv'
      ORDER BY last_seen_at DESC NULLS LAST, registered_at DESC
      LIMIT 1`,
    [rechner],
  );
  if (!r.rows.length) return res.json({ rechner, bekannt: false, standard: null });
  res.json({ rechner, bekannt: true, standard: standardDrucker(r.rows[0]) });
}));

// ─── Erlaubte Programme je Windows-Rechner (AppLocker) ──────────────
//
// GET /api/stations/programme/:rechner
//
// Für programme.ps1 der GPO „Rosenweg-Look Windows": welche Programme hier
// laufen dürfen und ob die Liste nur geprüft ('probe') oder durchgesetzt
// wird. Katalog und Begründung: api/lib/windowsprogramme.js.
//
// Ohne Anmeldung und nur von innen — aus demselben Grund wie beim Drucker:
// das Skript hat nichts, womit es sich ausweisen könnte, und die Antwort ist
// nicht geheim (Programmnamen). Was sie bewirken kann, ist begrenzt: sie
// kann nur ERLAUBEN, und nur unter den Programme-Ordnern; den Grundschutz
// und die Ausnahme für Technik setzt der Rechner selbst.
//
// Ein unbekannter (oder gesperrter) Rechner bekommt die Vorgabe für alle im
// Modus 'probe' — durchgesetzt wird nie etwas, das niemand eingestellt hat.
//
// Format 1 (mit programme.ps1 vereinbart):
//   {"format":1,"rechner":"WIN11-1","bekannt":true,"modus":"probe",
//    "programme":[{"id":"edge","name":"Microsoft Edge","regeln":[{"art":"pfad","pfad":"%PROGRAMFILES%\\…\\*"}]}],
//    "freigaben":[{"art":"paket","herausgeber":"*","paket":"…"}],
//    "sperren":[{"id":"edge","name":"Microsoft Edge","regeln":[{"art":"herausgeber","herausgeber":"O=…","produkt":"MICROSOFT EDGE"}]}],
//    "stand":"<sha256 der Regeln>"}
async function windowsVorgabe() {
  const r = await pool.query("SELECT wert, geaendert_von, geaendert_am FROM station_vorgaben WHERE schluessel = 'windows_programme'");
  return {
    vorgabe: winprog.vorgabeNormal(r.rows[0]?.wert),
    geaendert_von: r.rows[0]?.geaendert_von || null,
    geaendert_am: r.rows[0]?.geaendert_am || null,
  };
}

async function windowsStation(rechner) {
  const r = await pool.query(
    `SELECT id, role, overrides FROM stations
      WHERE LOWER(COALESCE(hostname, id)) = LOWER($1)
        AND revoked_at IS NULL AND status = 'aktiv'
      ORDER BY last_seen_at DESC NULLS LAST, registered_at DESC
      LIMIT 1`,
    [rechner],
  );
  return r.rows[0] || null;
}

router.get('/programme/:rechner', a(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!nurAusDemHausnetz(req)) return res.status(403).json({ error: 'Nur aus dem internen Netz' });
  const rechner = String(req.params.rechner || '');
  if (!RECHNER_MUSTER.test(rechner)) return res.status(400).json({ error: 'Ungültiger Rechnername' });
  await ensureSchema();
  const station = await windowsStation(rechner);
  const { vorgabe } = await windowsVorgabe();
  const eigen = station ? station.overrides?.roles?.[station.role]?.programme : null;
  const liste = winprog.fuerRechner(vorgabe, eigen);
  if (!station) liste.modus = 'probe';
  const stand = sha256(JSON.stringify([liste.modus, liste.programme, liste.freigaben, liste.sperren]));
  res.json({ format: 1, rechner, bekannt: !!station, ...liste, stand });
}));

// POST /api/stations/programme/:rechner/probe
//   {"format":1,"modus":"probe","stand":"…","eintraege":[{"art":"exe","ziel":"%OSDRIVE%\\…\\X.EXE",
//     "herausgeber":"O=…","person":"ROSENWEG\\anna","anzahl":3,"zuletzt":"2026-11-26T15:41:42"}]}
//
// Der Rechner meldet, was die Liste blockiert hat ('durchsetzen') oder
// blockiert hätte ('probe') — gesammelt über die letzten 30 Tage, jedes Mal
// der ganze Stand (kein Anhängen). Ohne Anmeldung wie oben; das Schlimmste,
// was ein Fremder im Haus damit tun kann, ist eine falsche Anzeige auf
// /stationen. Die Regeln selbst ändert diese Meldung nicht.
const PROBE_MAX = 300;
router.post('/programme/:rechner/probe', a(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!nurAusDemHausnetz(req)) return res.status(403).json({ error: 'Nur aus dem internen Netz' });
  const rechner = String(req.params.rechner || '');
  if (!RECHNER_MUSTER.test(rechner)) return res.status(400).json({ error: 'Ungültiger Rechnername' });
  await ensureSchema();
  const station = await windowsStation(rechner);
  if (!station || station.role !== 'windows') return res.status(404).json({ error: 'Rechner nicht eingetragen' });
  const b = req.body || {};
  const text = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));
  const eintraege = (Array.isArray(b.eintraege) ? b.eintraege : []).slice(0, PROBE_MAX).map((e) => ({
    art: ['exe', 'appx', 'skript', 'msi'].includes(e?.art) ? e.art : 'exe',
    ziel: text(e?.ziel, 400) || '?',
    herausgeber: text(e?.herausgeber, 300),
    produkt: text(e?.produkt, 200),
    person: text(e?.person, 120),
    anzahl: Math.max(1, Math.min(1e6, Number.parseInt(e?.anzahl, 10) || 1)),
    zuletzt: text(e?.zuletzt, 40),
  }));
  const probe = {
    modus: winprog.MODI.includes(b.modus) ? b.modus : 'probe',
    stand: text(b.stand, 80),
    seit: text(b.seit, 40),
    eintraege,
    abgeschnitten: Array.isArray(b.eintraege) && b.eintraege.length > PROBE_MAX,
  };
  await pool.query(
    'UPDATE stations SET programme_probe = $2::jsonb, programme_probe_am = NOW() WHERE id = $1',
    [station.id, JSON.stringify(probe)],
  );
  res.json({ ok: true, eintraege: eintraege.length });
}));

// ─── Versionen des Stations-Betriebssystems ─────────────────────────
// MUSS vor den /:id-Routen stehen.

// POST /api/stations/os — neue Version veroeffentlichen (Technik).
// Der Tarball kommt roh im Koerper; Version und Kanal als Kopfzeilen.
// Erst Sitzung und Recht pruefen, dann den Koerper puffern: sonst liest jeder
// Anonyme 64 MB in den Speicher, bevor er mit 401 abgewiesen wird.
router.post('/os', appSession, darfOsVeroeffentlichen, express.raw({ type: '*/*', limit: '64mb' }),
  a(async (req, res) => {
    const version = String(req.headers['x-version'] || '').trim();
    const kanal = String(req.headers['x-kanal'] || 'main').trim();
    // Node liest Kopfzeilen als latin-1 — ein "ü" in der Notiz kam deshalb als
    // "Ã¼" in der Verwaltung an. publish-os.sh schickt sie jetzt prozentkodiert;
    // Aufrufer ohne Kodierung werden hier nachträglich geradegezogen.
    const notiz = req.headers['x-notiz']
      ? (() => {
        const roh = String(req.headers['x-notiz']);
        // Nur wo wirklich Prozentzeichen stehen, wird dekodiert. Sonst liefe ein
        // unkodierter Aufruf durch decodeURIComponent unverändert durch, ohne je
        // beim latin-1-Fallback anzukommen — die Umlaute blieben kaputt.
        if (/%[0-9A-Fa-f]{2}/.test(roh)) {
          try {
            return decodeURIComponent(roh);
          } catch { /* kaputt kodiert — unten als latin-1 versuchen */ }
        }
        return Buffer.from(roh, 'latin1').toString('utf8');
      })()
      : null;

    if (!/^[A-Za-z0-9._-]{4,64}$/.test(version)) {
      return res.status(400).json({ error: 'X-Version fehlt oder ist ungültig' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
      return res.status(400).json({ error: 'Kein Tarball im Körper' });
    }

    const wer = req.appUser?.display_name || req.appUser?.username || 'unbekannt';
    const ergebnis = await stationos.veroeffentlichen({ version, kanal, daten: req.body, notiz, wer });
    console.log(`[stations] OS ${ergebnis.kanal}/${version} veröffentlicht von ${wer} (${ergebnis.groesse} B)`);
    res.status(201).json(ergebnis);
  }));

// GET /api/stations/os — Übersicht (Technik).
router.get('/os', appSession, darfOsVeroeffentlichen, a(async (req, res) => {
  res.json({ versionen: await stationos.liste() });
}));

// ─── Verwaltung ─────────────────────────────────────────────────────
// MUSS vor den /:id-Routen stehen, sonst frisst ':id' das 'admin'.

// GET /api/stations/admin/list
router.get('/admin/list', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(`
    SELECT id, role, hostname, standort, notiz, status, sperr_grund, gesperrt_von,
           zuruecksetzen_angefordert,
           gesperrt_am, hardware, registered_by, registered_at,
           last_seen_at, last_seen_ip, last_state, revoked_at,
           update_angefordert, update_angefordert_von, overrides,
           programme, programme_gemeldet_am, haus, programme_probe, programme_probe_am,
           ad_guid IS NOT NULL AS aus_ad, ad_dn, ad_zustand, ad_betriebssystem,
           ad_gesehen_am, ad_aufgenommen_am, ad_standort_regel,
           anschluss, anschluss_gelernt_am, anschluss_jetzt, anschluss_jetzt_am,
           anschluss_abweichung, doppelt,
           w.bis AS ssh_wartung_bis, w.erteilt_von AS ssh_wartung_von
      FROM stations
      LEFT JOIN LATERAL (
        SELECT bis, erteilt_von FROM station_ssh_wartung
         WHERE station_id = stations.id AND beendet_am IS NULL AND bis > NOW()
         ORDER BY bis DESC LIMIT 1) w ON true
     ORDER BY (revoked_at IS NOT NULL), registered_at DESC`);

  // In den overrides kann ein WLAN-Schlüssel stehen. Der Browser braucht ihn
  // nie: die Verwaltung zeigt nur, DASS einer gesetzt ist, und beim Speichern
  // führt PATCH die Zweige zusammen — ein weggelassenes Passwort bleibt also
  // stehen. Ein Klartextschlüssel in einer Seite, die jemand offen liegen
  // lässt, wäre der unnötigste Weg, ihn zu verlieren.
  res.json({
    stations: r.rows.map((z) => {
      const { sichtbar, geheim } = ohneGeheimnisse(z.overrides);
      return { ...z, overrides: sichtbar, overrides_geheim: geheim };
    }),
    // Mit den Arten, die nur die Verwaltung kennt — sonst stünde in der
    // Typ-Spalte eines Windows-Rechners nur die Kennung 'windows'.
    types: [...STATION_TYPES, ...VERWALTUNGS_TYPEN],
    // Die Auswahl für den Standarddrucker, mit Klartextnamen.
    drucker: DRUCKER,
    // Erlaubte Programme der Windows-Rechner: Katalog und Vorgabe für alle,
    // damit „Einstellen …" eines Rechners zeigt, was ohnehin gilt.
    windows_programme: { katalog: winprog.KATALOG, sperren: winprog.SPERREN, ...(await windowsVorgabe()) },
    // Die Hausvorgabe zum WLAN. Ohne sie sähe die Verwaltung nur die
    // stationseigene Ebene — also ein leeres Feld — und jemand trüge das Netz
    // ein zweites Mal ein, obwohl es längst für alle gilt.
    haus_wlan: hausWlan(),
    // Die Netze aus UniFi, nur die Namen — damit die Verwaltung eine Auswahl
    // anbieten kann statt eines Textfelds, in das jemand einen Schlüssel
    // tippt, den es längst gibt.
    wlan_netze: await netznamen(),
    // Ohne hinterlegten Schluessel liesse eine Freigabe niemanden herein —
    // die Seite sagt es, bevor jemand vergeblich auf den Knopf drueckt.
    wartungsschluessel: Number((await pool.query(
      'SELECT COUNT(*)::int AS n FROM station_wartung_schluessel')).rows[0].n),
    // Stand des AD-Abgleichs, damit die Seite „zuletzt 14:15, 2 Rechner"
    // zeigen kann — und warum er nicht läuft, falls er nicht läuft.
    ad_abgleich: { ...adStand, lesbar: adLesbar(), minuten: AD_ABGLEICH_MINUTEN,
      regeln: STANDORT_REGELN.map((r) => r.text) },
    // Stand des Anschluss-Wächters, wie beim AD-Abgleich.
    anschluss_abgleich: { ...anschlussStand, bereit: unifiBereit(), minuten: ANSCHLUSS_MINUTEN, ohne: ANSCHLUSS_OHNE },
  });
}));

// POST /api/stations/admin/windows  { hostname, haus?, standort?, notiz?, drucker? }
//
// Einen Windows-Rechner von Hand eintragen. Er hat keinen Installer, der ihn
// registrieren könnte, und keinen Agenten — er steht hier nur, damit seine
// Einstellungen (heute: der Standarddrucker) dort gepflegt werden, wo auch
// die der Stationen stehen.
//
// Der Name muss genau der Rechnername im AD sein (WIN11-1, R9-PC1): unter
// ihm fragt das Anmeldeskript nach.
//
// token_hash ist NOT NULL, ein Token gibt es aber nicht. Statt eines
// zufälligen Hashes steht dort ein Wert, den sha256 nie liefern kann
// ('ohne-token:…' ist kein 64-stelliger Hexwert). Damit kann stationAuth
// diese Zeile mit keinem denkbaren Token treffen — nicht nur „mit keinem,
// das jemand kennt". Der Zufallsteil hält die Werte trotzdem verschieden,
// falls die Spalte je einen Index bekommt.
router.post('/admin/windows', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const hostname = String(req.body?.hostname || '').trim();
  if (!RECHNER_MUSTER.test(hostname)) {
    return res.status(400).json({ error: 'Rechnername: nur Buchstaben, Ziffern und Bindestrich, wie im AD (z. B. WIN11-1)' });
  }
  const id = slug(hostname);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    return res.status(400).json({ error: `Aus „${hostname}" lässt sich keine Kennung bilden` });
  }
  const haus = req.body?.haus === null || req.body?.haus === undefined || req.body?.haus === ''
    ? null : (HAEUSER.includes(Number(req.body.haus)) ? Number(req.body.haus) : undefined);
  if (haus === undefined) return res.status(400).json({ error: 'Unbekannte Hausnummer' });
  const drucker = req.body?.drucker ? String(req.body.drucker) : null;
  if (drucker && !DRUCKER.some((d) => d.name === drucker)) {
    return res.status(400).json({ error: `Unbekannter Drucker '${drucker}'` });
  }
  const text = (v) => String(v || '').trim().slice(0, 500) || null;

  // Derselbe Name zweimal hiesse: das Anmeldeskript bekäme je nach Laune die
  // eine oder die andere Einstellung. Also gar nicht erst zulassen.
  const doppelt = await pool.query(
    `SELECT id FROM stations
      WHERE revoked_at IS NULL AND (id = $1 OR LOWER(COALESCE(hostname, id)) = LOWER($2))`,
    [id, hostname],
  );
  if (doppelt.rows.length) {
    return res.status(409).json({ error: `„${hostname}" steht schon in der Liste (als '${doppelt.rows[0].id}')` });
  }

  const overrides = drucker ? { roles: { windows: { printing: { default: drucker } } } } : {};
  // Eine früher entfernte Zeile mit derselben Kennung wird wiederbelebt —
  // wie bei /register: Verlauf und Ereignisse sollen bleiben, und id ist der
  // Primärschlüssel. Die alten Einstellungen dagegen nicht: wer den Rechner
  // neu einträgt, wählt neu.
  const r = await pool.query(
    `INSERT INTO stations (id, role, hostname, standort, notiz, haus, token_hash, overrides,
                           registered_by, status)
     VALUES ($1, 'windows', $2, $3, $4, $5, $6, $7::jsonb, $8, 'aktiv')
     ON CONFLICT (id) DO UPDATE SET
       role = EXCLUDED.role, hostname = EXCLUDED.hostname, standort = EXCLUDED.standort,
       notiz = EXCLUDED.notiz, haus = EXCLUDED.haus, token_hash = EXCLUDED.token_hash,
       overrides = EXCLUDED.overrides, hardware = '{}'::jsonb,
       registered_by = EXCLUDED.registered_by, registered_at = NOW(), revoked_at = NULL,
       status = 'aktiv', sperr_grund = NULL, gesperrt_von = NULL, gesperrt_am = NULL,
       zuruecksetzen_angefordert = NULL, zuruecksetzen_angefordert_von = NULL,
       update_angefordert = NULL, update_angefordert_von = NULL,
       last_seen_at = NULL, last_seen_ip = NULL, last_state = NULL,
       programme = NULL, programme_gemeldet_am = NULL
     WHERE stations.revoked_at IS NOT NULL
     RETURNING id`,
    [id, hostname, text(req.body?.standort), text(req.body?.notiz), haus,
      'ohne-token:' + crypto.randomBytes(16).toString('hex'), JSON.stringify(overrides), wer],
  );
  if (!r.rows.length) return res.status(409).json({ error: `Kennung '${id}' ist schon vergeben` });
  await ereignis(id, 'windows-eingetragen', wer, hostname);
  console.log(`[stations] Windows-Rechner '${hostname}' (${id}) eingetragen von ${wer}`);
  res.status(201).json({ id, hostname });
}));

// ─── Windows-Rechner aus dem AD ─────────────────────────────────────
//
// Stefan, 26.11.2026: „Wieso lesen wir die Windows-Rechner nicht aus dem AD
// und teilen ihnen bei der Aufnahme einmalig den Standort/Drucker zu?"
//
// Alle AD_ABGLEICH_MINUTEN (Vorgabe 15) und auf Knopfdruck liest die
// Verwaltung die Windows-Computerkonten (lib/adrechner.js) und:
//   - nimmt neue als Art 'windows' auf, mit Haus und Drucker aus OU/Namen
//     (Regeln dort, STANDORT_REGELN). Ohne erkennbares Haus bleibt beides
//     leer, die Seite sagt „Standort fehlt".
//   - verknüpft einen schon von Hand eingetragenen Rechner gleichen Namens,
//     OHNE an seinen Einstellungen etwas zu ändern.
//   - schreibt Haus und Drucker NIE wieder. Was danach auf /stationen
//     gewählt wird, gilt — der Abgleich fasst nur die ad_*-Spalten und den
//     Namen an (ein umbenannter Rechner fragt drucker.ps1 unter dem neuen).
//   - markiert Rechner, die im AD deaktiviert oder gelöscht sind, statt sie
//     zu entfernen: ob ein Rechner wirklich weg ist, entscheidet ein Mensch.
//   - holt einen auf /stationen entfernten Rechner nicht zurück, solange er
//     im AD dasselbe Konto (objectGUID) hat. Sonst wäre „Entfernen" für
//     AD-Rechner wirkungslos.
//
// Eine Station mit demselben Namen, die KEIN Windows-Rechner ist (etwa R9-PC1
// nach dem Umbau auf Linux, solange das alte AD-Konto noch steht), wird nicht
// angetastet und nur als Namenskonflikt gemeldet: sonst bekäme drucker.ps1
// je nach Reihenfolge die eine oder die andere Antwort.
const AD_ABGLEICH_MINUTEN = Number(process.env.AD_ABGLEICH_MINUTEN ?? 15);
const AD_ABGLEICH_WER = 'AD-Abgleich';
let adStand = { zuletzt: null, ergebnis: null, fehler: null };
let adLaeuft = null;

async function adAbgleichen(wer = AD_ABGLEICH_WER) {
  // Ein zweiter Klick während eines Laufs wartet auf denselben Lauf, statt
  // parallel dieselben Zeilen anzulegen.
  if (adLaeuft) return adLaeuft;
  adLaeuft = (async () => {
    try {
      const ergebnis = await adAbgleichDurchfuehren(wer);
      adStand = { zuletzt: new Date().toISOString(), ergebnis, fehler: null };
      return ergebnis;
    } catch (e) {
      adStand = { ...adStand, zuletzt: new Date().toISOString(), fehler: e.message };
      throw e;
    } finally {
      adLaeuft = null;
    }
  })();
  return adLaeuft;
}

async function adAbgleichDurchfuehren(wer) {
  await ensureSchema();
  const imAd = await windowsRechnerLesen();

  // Laufen je zwei API-Instanzen, gleicht nur eine ab. Sitzungssperre auf
  // einer eigenen Verbindung; geschrieben wird über pool.query, damit der
  // Audit-Kontext greift wie überall sonst.
  const sperre = await pool.connect();
  try {
    const { rows: [l] } = await sperre.query("SELECT pg_try_advisory_lock(hashtext('stations-ad-abgleich')) AS ok");
    if (!l.ok) return { uebersprungen: 'läuft schon anderswo' };
    try {
      return await adAbgleichSchreiben(imAd, wer);
    } finally {
      await sperre.query("SELECT pg_advisory_unlock(hashtext('stations-ad-abgleich'))").catch(() => {});
    }
  } finally {
    sperre.release();
  }
}

async function adAbgleichSchreiben(imAd, wer) {
  const ergebnis = {
    gefunden: imAd.length, neu: [], verknuepft: [], ohne_standort: [],
    deaktiviert: [], fehlt: [], konflikte: [], entfernt_belassen: [],
  };
  const { rows: alle } = await pool.query(
    'SELECT id, role, hostname, revoked_at, ad_guid, ad_zustand FROM stations');
  const nameGleich = (z, name) => String(z.hostname || z.id).toLowerCase() === name.toLowerCase();

  for (const r of imAd) {
    const zustand = r.deaktiviert ? 'deaktiviert' : 'vorhanden';
    if (r.deaktiviert) ergebnis.deaktiviert.push(r.name);

    // 1. Schon bekannt (am Konto, nicht am Namen)?
    let z = alle.find((x) => x.ad_guid === r.guid && !x.revoked_at);
    if (!z && alle.some((x) => x.ad_guid === r.guid && x.revoked_at)) {
      ergebnis.entfernt_belassen.push(r.name);
      continue;
    }
    // 2. Von Hand eingetragen (oder altes AD-Konto, neu beigetreten)?
    let verknuepfen = false;
    if (!z) {
      const gleich = alle.filter((x) => !x.revoked_at && nameGleich(x, r.name));
      const fremd = gleich.find((x) => x.role !== 'windows');
      if (fremd) { ergebnis.konflikte.push(`${r.name} (schon als ${fremd.role} '${fremd.id}')`); continue; }
      z = gleich[0];
      verknuepfen = !!z;
    }

    if (z) {
      const umbenannt = !nameGleich(z, r.name);
      await pool.query(
        `UPDATE stations SET ad_guid = $2, ad_dn = $3, ad_zustand = $4, ad_betriebssystem = $5,
                ad_gesehen_am = NOW(), hostname = $6
          WHERE id = $1`,
        [z.id, r.guid, r.dn, zustand, r.betriebssystem, r.name],
      );
      if (verknuepfen) {
        ergebnis.verknuepft.push(r.name);
        await ereignis(z.id, 'ad-verknuepft', wer, `${r.dn} — Einstellungen unverändert`);
      } else if (z.ad_zustand !== zustand) {
        await ereignis(z.id, 'ad-zustand', wer, `im AD ${zustand}`);
      }
      if (umbenannt) await ereignis(z.id, 'ad-umbenannt', wer, `${z.hostname || z.id} → ${r.name}`);
      continue;
    }

    // 3. Neu: einmalig Haus und Drucker zuteilen.
    const id = slug(r.name);
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id) || !RECHNER_MUSTER.test(r.name)) {
      ergebnis.konflikte.push(`${r.name} (Name taugt nicht als Kennung)`);
      continue;
    }
    if (alle.some((x) => x.id === id && !x.revoked_at)) {
      ergebnis.konflikte.push(`${r.name} (Kennung '${id}' ist vergeben)`);
      continue;
    }
    const overrides = r.drucker ? { roles: { windows: { printing: { default: r.drucker } } } } : {};
    // Wiederbelebt wird nur eine entfernte Zeile OHNE dieses AD-Konto (siehe
    // oben) — dieselbe Regel wie bei /admin/windows: Verlauf bleibt, die
    // Einstellungen kommen neu.
    const ins = await pool.query(
      `INSERT INTO stations (id, role, hostname, haus, token_hash, overrides, registered_by, status,
                             ad_guid, ad_dn, ad_zustand, ad_betriebssystem, ad_gesehen_am,
                             ad_aufgenommen_am, ad_standort_regel)
       VALUES ($1, 'windows', $2, $3, $4, $5::jsonb, $6, 'aktiv', $7, $8, $9, $10, NOW(), NOW(), $11)
       ON CONFLICT (id) DO UPDATE SET
         role = EXCLUDED.role, hostname = EXCLUDED.hostname, standort = NULL, notiz = NULL,
         haus = EXCLUDED.haus, token_hash = EXCLUDED.token_hash, overrides = EXCLUDED.overrides,
         hardware = '{}'::jsonb, registered_by = EXCLUDED.registered_by, registered_at = NOW(),
         revoked_at = NULL, status = 'aktiv', sperr_grund = NULL, gesperrt_von = NULL, gesperrt_am = NULL,
         zuruecksetzen_angefordert = NULL, zuruecksetzen_angefordert_von = NULL,
         update_angefordert = NULL, update_angefordert_von = NULL,
         last_seen_at = NULL, last_seen_ip = NULL, last_state = NULL,
         programme = NULL, programme_gemeldet_am = NULL,
         ad_guid = EXCLUDED.ad_guid, ad_dn = EXCLUDED.ad_dn, ad_zustand = EXCLUDED.ad_zustand,
         ad_betriebssystem = EXCLUDED.ad_betriebssystem, ad_gesehen_am = NOW(),
         ad_aufgenommen_am = NOW(), ad_standort_regel = EXCLUDED.ad_standort_regel
       WHERE stations.revoked_at IS NOT NULL
       RETURNING id`,
      [id, r.name, r.haus, 'ohne-token:' + crypto.randomBytes(16).toString('hex'),
        JSON.stringify(overrides), AD_ABGLEICH_WER, r.guid, r.dn, zustand, r.betriebssystem, r.regel],
    );
    if (!ins.rows.length) { ergebnis.konflikte.push(`${r.name} (Kennung '${id}' ist vergeben)`); continue; }
    ergebnis.neu.push(r.name);
    if (!r.haus) ergebnis.ohne_standort.push(r.name);
    await ereignis(id, 'ad-aufgenommen', wer, r.haus
      ? `Rosenweg ${r.haus} (aus ${r.regel}), Drucker ${r.drucker || '— (keiner für dieses Haus)'}`
      : 'Standort fehlt — kein Haus aus OU oder Name erkennbar, Drucker leer');
    console.log(`[stations] AD: '${r.name}' aufgenommen (${r.haus ? `Haus ${r.haus}, ${r.drucker || 'ohne Drucker'}` : 'Standort fehlt'})`);
  }

  // 4. Im AD gelöscht. Eine leere Antwort bei bekannten Rechnern ist eher ein
  // Rechte- oder Suchproblem als „alle auf einmal gelöscht" — dann lieber
  // nichts markieren als alles.
  const guids = new Set(imAd.map((r) => r.guid));
  const verschwunden = alle.filter((x) => x.ad_guid && !x.revoked_at && !guids.has(x.ad_guid));
  if (imAd.length === 0 && verschwunden.length) {
    console.warn(`[stations] AD-Abgleich: keine Windows-Rechner gefunden, ${verschwunden.length} bekannte — nichts als fehlend markiert`);
    ergebnis.warnung = 'Das AD lieferte keinen einzigen Windows-Rechner — nichts als fehlend markiert.';
  } else {
    for (const x of verschwunden) {
      ergebnis.fehlt.push(x.hostname || x.id);
      if (x.ad_zustand === 'fehlt') continue;
      await pool.query("UPDATE stations SET ad_zustand = 'fehlt' WHERE id = $1", [x.id]);
      await ereignis(x.id, 'ad-zustand', wer, 'im AD nicht mehr vorhanden');
    }
  }
  return ergebnis;
}

// POST /api/stations/admin/ad-abgleich — „Jetzt abgleichen"
// GET/PUT /api/stations/admin/windows-programme
//   { programme: ['edge', …], freigaben: 'Zeilen', modus: 'probe'|'durchsetzen' }
// Die Vorgabe für alle Windows-Rechner. Je Rechner kommt unter „Einstellen …"
// dazu, was nur dort gilt (overrides.roles.windows.programme).
router.get('/admin/windows-programme', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  res.json({ katalog: winprog.KATALOG, sperren: winprog.SPERREN, ...(await windowsVorgabe()) });
}));

router.put('/admin/windows-programme', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const { wert, fehler } = winprog.vorgabePruefen(req.body);
  if (fehler) return res.status(400).json({ error: fehler });
  const vorher = (await windowsVorgabe()).vorgabe;
  await pool.query(
    `INSERT INTO station_vorgaben (schluessel, wert, geaendert_von, geaendert_am)
     VALUES ('windows_programme', $1::jsonb, $2, NOW())
     ON CONFLICT (schluessel) DO UPDATE SET wert = EXCLUDED.wert,
       geaendert_von = EXCLUDED.geaendert_von, geaendert_am = EXCLUDED.geaendert_am`,
    [JSON.stringify(wert), wer],
  );
  const dazu = wert.programme.filter((id) => !vorher.programme.includes(id));
  const weg = vorher.programme.filter((id) => !wert.programme.includes(id));
  console.log(`[stations] Windows-Programme für alle geändert von ${wer}: Modus ${wert.modus}`
    + `${dazu.length ? `, dazu ${dazu.join(' ')}` : ''}${weg.length ? `, weg ${weg.join(' ')}` : ''}`);
  res.json({ katalog: winprog.KATALOG, sperren: winprog.SPERREN, ...(await windowsVorgabe()) });
}));

router.post('/admin/ad-abgleich', authMiddleware, nurTechnik, a(async (req, res) => {
  if (!adLesbar()) {
    return res.status(503).json({ error: 'Kein Konto zum Lesen des AD (STATION_AD_JOIN_USER/-PASSWORD fehlen)' });
  }
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  try {
    const ergebnis = await adAbgleichen(`${AD_ABGLEICH_WER} (${wer})`);
    res.json({ ...adStand, ergebnis });
  } catch (e) {
    console.error('[stations] AD-Abgleich:', e.message);
    res.status(502).json({ error: `AD nicht lesbar: ${e.message}` });
  }
}));

// Regelmässig. Eine Minute nach dem Start, damit ein Neustart nicht als
// Erstes am DC hängt; unref, damit der Timer keinen Prozess am Leben hält.
if (AD_ABGLEICH_MINUTEN > 0) {
  const lauf = () => {
    if (!adLesbar()) return;
    adAbgleichen().catch((e) => console.error('[stations] AD-Abgleich:', e.message));
  };
  setTimeout(lauf, 60 * 1000).unref();
  setInterval(lauf, AD_ABGLEICH_MINUTEN * 60 * 1000).unref();
}

// ─── Wächter: Anschluss und doppelte Station ────────────────────────
// Entscheidungen in lib/stationwaechter.js; hier Datenbank, Sperre, Meldung.
//
// Meldungen gehen an die WhatsApp-Gruppe Technik — derselbe Weg wie die
// anderen Technik-Meldungen (notifyTechnik in server.js). Wirft nie: eine
// ausgefallene Meldung darf weder Abgleich noch Lebenszeichen aufhalten.
const STATIONEN_URL = 'www.rosenweg4303.ch/stationen.html';
async function technikMelden(text, sourceType) {
  try {
    const gid = await resolveTechnikWhatsappGroupId();
    if (!gid) { console.warn(`[stations] ${sourceType}: keine Technik-Gruppe gefunden`); return; }
    await queueWhatsappMessage({ chatId: gid, body: text.slice(0, 3500), sourceType });
  } catch (e) { console.warn(`[stations] ${sourceType}:`, e.message); }
}

// 1. Anschluss. Periodisch aus UniFi (stat/sta + stat/device), nicht im
// Lebenszeichen: UniFi weiss, wo eine MAC hängt, auch wenn die Station
// selbst nichts sagt — und eine Station, die lügt, soll es nicht selbst
// melden können. Alle paar Minuten genügt; gesperrt wird erst, wenn der
// fremde Anschluss zweimal in Folge gesehen wurde.
const ANSCHLUSS_MINUTEN = Number(process.env.STATION_ANSCHLUSS_MINUTEN ?? 3);
const ANSCHLUSS_WER = 'Anschluss-Wächter';
const ANSCHLUSS_OHNE = ['windows', 'laptop'];   // Rollen ohne festen Anschluss
let anschlussStand = { zuletzt: null, ergebnis: null, fehler: null };
let anschlussLaeuft = null;

async function anschlussAbgleichen() {
  if (anschlussLaeuft) return anschlussLaeuft;
  anschlussLaeuft = (async () => {
    try {
      const ergebnis = await anschlussAbgleichDurchfuehren();
      anschlussStand = { zuletzt: new Date().toISOString(), ergebnis, fehler: null };
      return ergebnis;
    } catch (e) {
      anschlussStand = { ...anschlussStand, zuletzt: new Date().toISOString(), fehler: e.message };
      throw e;
    } finally {
      anschlussLaeuft = null;
    }
  })();
  return anschlussLaeuft;
}

async function anschlussAbgleichDurchfuehren() {
  await ensureSchema();
  const [clients, devices] = await Promise.all([
    unifiHolen('stat/sta', 15000),
    unifiHolen('stat/device', 15000),
  ]);
  // Wie beim AD-Abgleich: bei mehreren API-Instanzen gleicht nur eine ab,
  // sonst zählte jede den Kandidaten einmal hoch und es würde zu früh gesperrt.
  const sperre = await pool.connect();
  try {
    const { rows: [l] } = await sperre.query("SELECT pg_try_advisory_lock(hashtext('stations-anschluss')) AS ok");
    if (!l.ok) return { uebersprungen: 'läuft schon anderswo' };
    try {
      return await anschlussAbgleichSchreiben(clients, devices);
    } finally {
      await sperre.query("SELECT pg_advisory_unlock(hashtext('stations-anschluss'))").catch(() => {});
    }
  } finally {
    sperre.release();
  }
}

async function anschlussAbgleichSchreiben(clients, devices) {
  const ergebnis = { geprueft: 0, im_netz: 0, gelernt: [], gesperrt: [] };
  // Nur, was fest steht. Windows-Rechner haben kein Inventar mit MACs (sie
  // kommen aus dem AD); ein Laptop wandert von Raum zu Raum und nach Hause —
  // an einen Anschluss binden hiesse, ihn bei jedem neuen AP zu sperren.
  const { rows } = await pool.query(
    `SELECT id, status, hardware, anschluss, anschluss_kandidat, anschluss_abweichung, gesperrt_von
       FROM stations WHERE revoked_at IS NULL AND role NOT IN (${ANSCHLUSS_OHNE.map((r) => `'${r}'`).join(',')})`);
  for (const st of rows) {
    const macs = waechter.stationsMacs(st.hardware);
    if (!macs.length) continue;
    ergebnis.geprueft += 1;
    const aktuell = waechter.anschlussAus(waechter.clientFinden(clients, macs), devices);
    if (!aktuell) continue;          // nicht im Netz: nichts zu sagen
    ergebnis.im_netz += 1;
    const e = waechter.anschlussPruefen({
      gelernt: st.anschluss, kandidat: st.anschluss_kandidat, abweichung: st.anschluss_abweichung, aktuell,
    });
    const jetzt = JSON.stringify(aktuell);
    if (e.aktion === 'lernen') {
      await pool.query(
        `UPDATE stations SET anschluss = $2, anschluss_gelernt_am = NOW(), anschluss_kandidat = NULL,
                anschluss_jetzt = $3, anschluss_jetzt_am = NOW() WHERE id = $1`,
        [st.id, JSON.stringify([aktuell]), jetzt]);
      await ereignis(st.id, 'anschluss-gelernt', ANSCHLUSS_WER, waechter.anschlussText(aktuell));
      ergebnis.gelernt.push(st.id);
    } else if (e.aktion === 'gleich') {
      // Zurück am gelernten Anschluss: die offene Abweichung fällt weg, eine
      // Sperre bleibt — aufheben entscheidet Technik ("Entsperren").
      await pool.query(
        `UPDATE stations SET anschluss_kandidat = NULL, anschluss_abweichung = NULL,
                anschluss_jetzt = $2, anschluss_jetzt_am = NOW() WHERE id = $1`, [st.id, jetzt]);
      if (st.anschluss_abweichung) {
        await ereignis(st.id, 'anschluss-zurueck', ANSCHLUSS_WER,
          `wieder am gelernten Anschluss ${waechter.anschlussText(aktuell)}`);
      }
    } else if (e.aktion === 'vormerken') {
      await pool.query(
        `UPDATE stations SET anschluss_kandidat = $2, anschluss_jetzt = $3, anschluss_jetzt_am = NOW() WHERE id = $1`,
        [st.id, JSON.stringify(e.kandidat), jetzt]);
    } else if (e.aktion === 'bleibt') {
      await pool.query(
        'UPDATE stations SET anschluss_jetzt = $2, anschluss_jetzt_am = NOW() WHERE id = $1', [st.id, jetzt]);
    } else if (e.aktion === 'sperren') {
      await pool.query(
        `UPDATE stations SET anschluss_abweichung = $2, anschluss_kandidat = NULL,
                anschluss_jetzt = $2, anschluss_jetzt_am = NOW() WHERE id = $1`, [st.id, jetzt]);
      if (st.status !== 'gesperrt' || st.gesperrt_von === ANSCHLUSS_WER) {
        // Auch eine schon vom Wächter gesperrte Station, die erneut umzieht,
        // bekommt den neuen Grund — sonst stünde dort der alte Port.
        await stationSperren(st.id, e.grund, ANSCHLUSS_WER);
        ergebnis.gesperrt.push(st.id);
        technikMelden(`🔒 Station *${st.id}* gesperrt: ${e.grund}.\n`
          + `Ist das ein Umzug, auf ${STATIONEN_URL} „Anschluss übernehmen und freigeben“.`, 'station-anschluss');
      } else {
        // Schon von Hand gesperrt: der Grund von Technik bleibt stehen.
        await ereignis(st.id, 'anschluss-abweichung', ANSCHLUSS_WER, e.grund);
      }
    }
  }
  return ergebnis;
}

if (ANSCHLUSS_MINUTEN > 0) {
  const lauf = () => {
    if (!unifiBereit()) return;
    anschlussAbgleichen().catch((e) => console.error('[stations] Anschluss-Abgleich:', e.message));
  };
  setTimeout(lauf, 90 * 1000).unref();
  setInterval(lauf, ANSCHLUSS_MINUTEN * 60 * 1000).unref();
}

// POST /api/stations/admin/:id/anschluss-uebernehmen
//
// Der eine Knopf für den Umzug: den Anschluss, an dem die Station jetzt
// hängt, als gelernt übernehmen — und, wenn der Wächter sie deswegen
// gesperrt hat, freigeben. Eine von Hand gesperrte Station bleibt gesperrt.
router.post('/admin/:id/anschluss-uebernehmen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const { rows: [st] } = await pool.query(
    `SELECT id, status, gesperrt_von, anschluss, anschluss_abweichung, anschluss_jetzt
       FROM stations WHERE id = $1 AND revoked_at IS NULL`, [req.params.id]);
  if (!st) return res.status(404).json({ error: 'Station nicht gefunden' });
  const neu = st.anschluss_abweichung || st.anschluss_jetzt;
  if (!neu) return res.status(409).json({ error: 'Noch kein Anschluss aus UniFi bekannt' });
  const liste = waechter.uebernehmen(st.anschluss, neu);
  const freigeben = st.status === 'gesperrt' && st.gesperrt_von === ANSCHLUSS_WER;
  await pool.query(
    `UPDATE stations SET anschluss = $2, anschluss_gelernt_am = NOW(), anschluss_abweichung = NULL,
            anschluss_kandidat = NULL
            ${freigeben ? ", status = 'aktiv', sperr_grund = NULL, gesperrt_von = NULL, gesperrt_am = NULL" : ''}
      WHERE id = $1`, [st.id, JSON.stringify(liste)]);
  await ereignis(st.id, 'anschluss-uebernommen', wer, waechter.anschlussText(neu));
  if (freigeben) await ereignis(st.id, 'entsperrt', wer, 'Anschluss übernommen');
  res.json({ ok: true, anschluss: liste, freigegeben: freigeben });
}));

// POST /api/stations/admin/:id/anschluss-vergessen
//
// Vor einem geplanten Umzug: nichts mehr gelernt, der nächste Anschluss wird
// ohne Sperre übernommen.
router.post('/admin/:id/anschluss-vergessen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET anschluss = NULL, anschluss_gelernt_am = NULL, anschluss_kandidat = NULL,
            anschluss_abweichung = NULL WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'anschluss-vergessen', wer, 'Nächster Anschluss wird ohne Sperre gelernt');
  res.json({ ok: true });
}));

// DELETE /api/stations/admin/:id/doppelt — Meldung "doppelte Station" erledigt.
// Melden sich danach wieder zwei Geräte, kommt eine neue Meldung.
router.delete('/admin/:id/doppelt', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET doppelt = NULL WHERE id = $1 AND doppelt IS NOT NULL RETURNING id`, [req.params.id]);
  if (r.rows.length) {
    // Die alten Lebenszeichen mit wegräumen — sonst erkennte das nächste
    // Lebenszeichen dieselbe Überlappung von vorhin gleich wieder.
    await pool.query('DELETE FROM station_lebenszeichen WHERE station_id = $1', [req.params.id]);
    await ereignis(req.params.id, 'doppelt-erledigt', wer, null);
  }
  res.json({ ok: true });
}));

// 2. Doppelte Station. Im Lebenszeichen, weil nur dort steht, WER sich
// meldet: Quelladresse, die lokale Adresse aus dem Zustand und die Laufzeit
// (daraus die Startzeit). Kein eigener Zyklus nötig.
const DOPPELT_FENSTER_MIN = 30;
const DOPPELT_MELDEN_STUNDEN = 6;

async function lebenszeichenPruefen(station, state, quelleIp) {
  // Nur das regelmässige Lebenszeichen des Agenten zählt (station-agent.sh,
  // mit Laufzeit). Die einmalige Rückmeldung nach der Einrichtung
  // (station-setup-server) hat weder Laufzeit noch lokale Adresse und sähe
  // sonst aus wie ein zweites Gerät.
  const uptime = Number(state?.uptime_seconds);
  if (state?.uptime_seconds == null || !Number.isFinite(uptime) || uptime < 0) return;
  const lokal = typeof state?.ip === 'string' && state.ip && state.ip.length <= 64 ? state.ip : null;
  await pool.query(
    `INSERT INTO station_lebenszeichen (station_id, quelle_ip, lokal_ip, boot)
     VALUES ($1, $2, $3, NOW() - make_interval(secs => $4::float8))`,
    [station.id, quelleIp, lokal, uptime]);
  await pool.query(
    "DELETE FROM station_lebenszeichen WHERE station_id = $1 AND erstellt < NOW() - INTERVAL '2 hours'", [station.id]);
  const { rows } = await pool.query(
    `SELECT erstellt AS zeit, quelle_ip, lokal_ip, boot FROM station_lebenszeichen
      WHERE station_id = $1 AND erstellt > NOW() - make_interval(mins => $2)`, [station.id, DOPPELT_FENSTER_MIN]);
  const fund = waechter.doppelteErkennen(rows);
  if (!fund) return;

  const jetzt = new Date().toISOString();
  const neu = !station.doppelt;
  const doppelt = { seit: station.doppelt?.seit || jetzt, zuletzt: jetzt, quellen: fund.quellen };
  const melden = !station.doppelt_gemeldet_am
    || Date.now() - new Date(station.doppelt_gemeldet_am).getTime() > DOPPELT_MELDEN_STUNDEN * 3600 * 1000;
  await pool.query(
    `UPDATE stations SET doppelt = $2 ${melden ? ', doppelt_gemeldet_am = NOW()' : ''} WHERE id = $1`,
    [station.id, JSON.stringify(doppelt)]);
  const quellen = fund.quellen.map(waechter.quelleText).join(' und ');
  if (neu) await ereignis(station.id, 'doppelt', null, `Zwei Geräte melden sich als diese Station: ${quellen}`);
  if (melden) {
    technikMelden(`⚠️ Station *${station.id}*: zwei Geräte melden sich gleichzeitig mit ihrem Token (${quellen}). `
      + `Nicht gesperrt — bitte auf ${STATIONEN_URL} prüfen; ist eines davon fremd: sperren und neu aufsetzen.`,
    'station-doppelt');
  }
}

// Was es bei einem Windows-Rechner nicht gibt: er hat keinen Agenten, der
// eine Aufforderung abholen würde. Ein Klick darauf täte nichts, ausser
// glauben zu lassen, es sei etwas passiert.
async function nichtFuerWindows(req, res, next) {
  try {
    await ensureSchema();
    const r = await pool.query('SELECT role FROM stations WHERE id = $1', [req.params.id]);
    if (r.rows[0]?.role === 'windows') {
      return res.status(400).json({ error: 'Ein Windows-Rechner hat keinen Agenten — das gibt es dort nicht' });
    }
    next();
  } catch (e) { next(e); }
}

// GET /api/stations/admin/:id/events
router.get('/admin/:id/events', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    'SELECT art, wer, text, erstellt FROM station_events WHERE station_id = $1 ORDER BY erstellt DESC LIMIT 100',
    [req.params.id],
  );
  res.json({ events: r.rows });
}));

// GET /api/stations/admin/:id/logs — was die Station eingesandt hat, ohne
// Inhalt. Der kommt einzeln; sonst zöge die Liste ein paar Megabyte nach sich.
router.get('/admin/:id/logs', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    `SELECT id, teil, bytes, erstellt FROM station_logs
      WHERE station_id = $1 ORDER BY erstellt DESC, teil LIMIT 200`,
    [req.params.id],
  );
  res.json({ logs: r.rows });
}));

// GET /api/stations/admin/:id/logs/:logId — ein Log im Klartext.
router.get('/admin/:id/logs/:logId', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  // Ohne diese Prüfung endet ein 'logs/kaputt' als Datenbankfehler und damit
  // als 500 — die Verwaltung sähe "Unerwarteter Fehler" statt "gibt es nicht".
  if (!/^\d+$/.test(req.params.logId)) return res.status(404).json({ error: 'Log nicht gefunden' });
  const r = await pool.query(
    'SELECT teil, inhalt, erstellt FROM station_logs WHERE id = $1 AND station_id = $2',
    [req.params.logId, req.params.id],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Log nicht gefunden' });
  res.json(r.rows[0]);
}));

// POST /api/stations/admin/:id/update
//
// „Aktualisiere dich." Geschickt werden kann der Station nichts — sie hängt
// hinter der Firewall und hat keinen offenen Port. Also wird die Aufforderung
// hier vermerkt und beim nächsten Lebenszeichen ausgeliefert
// (agent.status_interval_seconds, Vorgabe 300).
router.post('/admin/:id/update', authMiddleware, nurTechnik, nichtFuerWindows, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET update_angefordert = NOW(), update_angefordert_von = $2
      WHERE id = $1 AND revoked_at IS NULL AND status <> 'gesperrt'
      RETURNING id`,
    [req.params.id, wer],
  );
  if (!r.rows.length) {
    return res.status(404).json({ error: 'Station nicht gefunden, entfernt oder gesperrt' });
  }
  await ereignis(req.params.id, 'update-angefordert', wer, null);
  res.json({ ok: true });
}));

// PATCH /api/stations/admin/:id  { standort?, notiz?, overrides? }
//
// Bis zum 3. August gab es das nicht, und damit gab es die ganze Ebene nicht:
// `overrides` wurde genau einmal geschrieben, beim Registrieren, mit `{}`.
// Jede Einstellung, die die Doku als „pro Station" beschrieb — Kanal, WLAN,
// Bildschirmzeiten, Drucker —, war faktisch global. Wer eine Station umstellen
// wollte, musste an die Datenbank.
//
// `overrides` wird ZUSAMMENGEFÜHRT, nicht ersetzt: ein Formular, das nur das
// WLAN kennt, darf nicht den Kanal löschen, den jemand anders gesetzt hat.
// Wer einen Zweig wirklich entfernen will, schickt dort `null`.
// Schlüssel, deren Wert nicht an den Browser gehört. Absichtlich nach Muster
// und nicht nach fester Liste: wer morgen `api_token` ergänzt, soll ihn nicht
// versehentlich ausliefern.
const GEHEIM_MUSTER = /passwor[dt]|secret|token|psk|schluessel/i;

function ohneGeheimnisse(wert, pfad = '') {
  if (!wert || typeof wert !== 'object' || Array.isArray(wert)) {
    return { sichtbar: wert, geheim: [] };
  }
  const sichtbar = {};
  const geheim = [];
  for (const [schluessel, inhalt] of Object.entries(wert)) {
    const voll = pfad ? `${pfad}.${schluessel}` : schluessel;
    if (GEHEIM_MUSTER.test(schluessel)) { geheim.push(voll); continue; }
    const tiefer = ohneGeheimnisse(inhalt, voll);
    sichtbar[schluessel] = tiefer.sichtbar;
    geheim.push(...tiefer.geheim);
  }
  return { sichtbar, geheim };
}

function tiefZusammenfuehren(alt, neu) {
  const ergebnis = { ...(alt || {}) };
  for (const [schluessel, wert] of Object.entries(neu || {})) {
    if (wert === null) { delete ergebnis[schluessel]; continue; }
    if (wert && typeof wert === 'object' && !Array.isArray(wert)) {
      ergebnis[schluessel] = tiefZusammenfuehren(ergebnis[schluessel], wert);
    } else {
      ergebnis[schluessel] = wert;
    }
  }
  return ergebnis;
}

router.patch('/admin/:id', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';

  const vorher = await pool.query(
    'SELECT overrides FROM stations WHERE id = $1 AND revoked_at IS NULL',
    [req.params.id],
  );
  if (!vorher.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });

  const felder = [];
  const werte = [req.params.id];
  const geaendert = [];

  // Das Haus bestimmt, welche Ankündigungen die Station zeigt.
  if ('haus' in (req.body || {})) {
    const haus = req.body.haus === null || req.body.haus === '' ? null
      : (HAEUSER.includes(Number(req.body.haus)) ? Number(req.body.haus) : undefined);
    if (haus === undefined) return res.status(400).json({ error: 'Unbekannte Hausnummer' });
    werte.push(haus);
    felder.push(`haus = $${werte.length}`);
    geaendert.push('haus');
  }

  for (const feld of ['standort', 'notiz']) {
    if (req.body?.[feld] === undefined) continue;
    const wert = String(req.body[feld] || '').trim().slice(0, 500) || null;
    werte.push(wert);
    felder.push(`${feld} = $${werte.length}`);
    geaendert.push(feld);
  }

  if (req.body?.overrides !== undefined) {
    const eingang = req.body.overrides;
    if (!eingang || typeof eingang !== 'object' || Array.isArray(eingang)) {
      return res.status(400).json({ error: 'overrides muss ein Objekt sein' });
    }
    // Der Standarddrucker muss einer sein, den es gibt. Ein Tippfehler im
    // JSON-Kasten fiele sonst erst auf, wenn am Rechner gar nichts passiert.
    for (const [rolle, zweig] of Object.entries(eingang.roles || {})) {
      const wahl = zweig?.printing?.default;
      if (wahl === undefined || wahl === null) continue;
      if (!DRUCKER.some((d) => d.name === wahl)) {
        return res.status(400).json({ error: `Unbekannter Standarddrucker '${wahl}' (roles.${rolle})` });
      }
    }
    // Erlaubte Programme (nur Windows): Katalog-Kennungen, Freigaben unter
    // den Programme-Ordnern, Modus — dieselbe Prüfung wie für die Vorgabe.
    const prog = winprog.rechnerPruefen(eingang.roles?.windows?.programme);
    if (prog.fehler) return res.status(400).json({ error: prog.fehler });
    const zusammen = tiefZusammenfuehren(vorher.rows[0].overrides || {}, eingang);
    werte.push(JSON.stringify(zusammen));
    felder.push(`overrides = $${werte.length}::jsonb`);
    geaendert.push('overrides');
  }

  if (!felder.length) return res.status(400).json({ error: 'Nichts zu ändern' });

  const r = await pool.query(
    `UPDATE stations SET ${felder.join(', ')} WHERE id = $1
      RETURNING id, standort, notiz, overrides`,
    werte,
  );

  // Was geändert wurde, steht im Ereignis — aber ohne die Werte. In den
  // overrides kann ein WLAN-Schlüssel stehen, und der gehört nicht in ein
  // Protokoll, das die halbe Verwaltung lesen darf.
  await ereignis(req.params.id, 'config-geaendert', wer, geaendert.join(', '));
  res.json(r.rows[0]);
}));

// POST /api/stations/admin/:id/block  { grund }
// ─── Anzeigegeräte (SlideShow auf Android) ──────────────────────────
//
// Diese Tafeln richten sich nicht selbst ein — sie haben keinen Installer, an
// dem sich jemand anmeldet. Was sie brauchen, tippt eine Person am Gerät ab:
// Adresse, Benutzer und Passwort des MQTT-Brokers.
//
// Genau dafür ist das hier: einmal drücken, und die Verwaltung legt den Zugang
// an und zeigt den vollständigen Zettel zum Abschreiben. Das Passwort steht
// nur in DIESER Antwort — danach existiert nur noch sein sha256.
//
// Das WLAN steht bewusst nicht auf dem Zettel: die Geräte hängen längst im
// Netz, sonst käme man gar nicht an ihre Oberfläche.

const ANZEIGE_TOPIC_PREFIX = 'SLIDESHOW';

/** Die Felder der App, in ihrer eigenen Beschriftung — und die Schritte dazu. */
function anzeigeZettel({ mqtt_thema, mqtt_benutzer, passwort, haus }) {
  // Die Adresse, die in die .url-Datei des Geräts gehört. Mit Hausnummer,
  // damit es nur die Ankündigungen zeigt, die es betreffen — von Hand
  // abgetippt wäre genau das die Stelle für einen Tippfehler, der erst im
  // Treppenhaus auffällt.
  const anzeigeAdresse = 'https://display.rosenweg4303.ch'
    + (Number.isInteger(Number(haus)) && Number(haus) > 0 ? `?haus=${Number(haus)}` : '');
  return {
    felder: [
      { feld: 'MQTT-Serveradresse', wert: process.env.MQTT_HOST_INTERN || '100.64.2.51' },
      { feld: 'MQTT-Benutzername', wert: mqtt_benutzer },
      { feld: 'MQTT-Passwort', wert: passwort, geheim: true },
      { feld: 'TLS für MQTT erforderlich', wert: 'aus',
        warum: 'Der Broker hört auf 1883 unverschlüsselt; 8883 ist im Haus zu.' },
      { feld: 'Verwenden Sie Websockets für MQTT', wert: 'aus',
        warum: 'Websockets (9001) braucht nur der Browser, die App nicht.' },
      { feld: 'MQTT topic prefix', wert: ANZEIGE_TOPIC_PREFIX },
      { feld: 'Name des MQTT-Themas', wert: mqtt_thema,
        warum: 'Ohne Eintrag nimmt die App die MAC-Adresse — die liest sich schlecht.' },
      { feld: 'Melden Sie Daten über MQTT', wert: 'an',
        warum: 'Damit hier sichtbar wird, ob das Gerät wirklich hängt.' },
    ],
    anzeigeAdresse,
    schritte: [
      'Am Gerät die Weboberfläche öffnen (Port 8080) und anmelden.',
      'Einstellungen → Geräteeinstellungen, dort zum Abschnitt MQTT.',
      'Die Werte oben eintragen.',
      'Zum Speichern den ERSTEN „Speichern"-Knopf nehmen — den direkt unter dem '
      + 'Abschnitt SNMP. Er gehört zu den Geräteeinstellungen und speichert die '
      + 'MQTT-Felder mit. Der zweite, weiter unten, gehört zum HTTPS-Zertifikat '
      + 'und speichert sie NICHT. Noch weiter unten steht „Alle Einstellungen auf '
      + 'Werkseinstellungen zurücksetzen" — den nicht treffen.',
      'Die App neu laden — die MQTT-Felder greifen erst danach. Das sagt die App bei jedem Feld selbst dazu.',
      'Im Datei-Manager einen Ordner „rosenweg" anlegen. Alles von uns liegt '
      + 'darin — auf den Tafeln läuft auch Fremdes, und dessen Dateien fasst niemand an.',
      'Unter Wiedergabelisten eine Liste anlegen, die den Ordner „rosenweg" spielt. '
      + 'Sie muss „Alarm" heissen — genau so, auf jedem Gerät. Bei einem Notfall '
      + 'schaltet die API jede Tafel auf diese Liste, und sie findet sie am Namen. '
      + 'Eine Nummer braucht die Liste nicht.',
      'Zurück in dieser Übersicht prüfen, ob das Gerät sich meldet, und „Datei senden" '
      + 'drücken — dann legt die API die Adresse als rosenweg/alarm.url auf das Gerät.',
    ],
    hinweisAdresse: 'Diese Adresse legt die API selbst als rosenweg/alarm.url auf das Gerät — '
                  + 'abtippen muss sie niemand. Ändert sich das Haus, geht sie neu raus.',
    hinweis: 'Das Passwort steht nur hier. Es wird nirgends gespeichert — nur seine Prüfsumme. '
           + 'Geht es verloren, legen Sie das Gerät neu an.',
    steuerung: {
      thema: `${ANZEIGE_TOPIC_PREFIX}/REQ/${mqtt_thema}/API`,
      antwort: `${ANZEIGE_TOPIC_PREFIX}/RESP/${mqtt_thema}/API`,
      // Am Gerät gemessen: die Parameter gehören in ein eigenes Objekt, und
      // playlist ist die Nummer der Liste. Mit dem Namen antwortet die App
      // NumberFormatException. Ohne zoneName nimmt sie die Hauptzone.
      beispiel: { operation: 'playlist/set', parameters: { playlistName: 'Alarm' } },
    },
  };
}

// GET /api/stations/admin/anzeigen
router.get('/admin/anzeigen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    `SELECT id, name, standort, notiz, mqtt_thema, mqtt_benutzer, haus, alarm_zone,
            angelegt_von, angelegt_am
       FROM anzeigegeraete ORDER BY name`);
  res.json({ anzeigen: r.rows, topic_prefix: ANZEIGE_TOPIC_PREFIX });
}));

// POST /api/stations/admin/anzeigen  { name, standort?, notiz? }
router.post('/admin/anzeigen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name fehlt' });

  // Aus dem Namen eine Kennung: Kleinbuchstaben, Bindestriche, sonst nichts.
  // Sie wird zum MQTT-Thema — und das taucht in Topics auf, wo Leerzeichen und
  // Umlaute nur Ärger machen.
  const id = name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!id) return res.status(400).json({ error: 'Aus dem Namen lässt sich keine Kennung bilden' });

  const vorhanden = await pool.query('SELECT 1 FROM anzeigegeraete WHERE id = $1', [id]);
  if (vorhanden.rows.length) return res.status(409).json({ error: `„${id}" gibt es schon` });

  const mqtt_benutzer = `slideshow-${id}`.slice(0, 64);
  const passwort = 'svc_' + crypto.randomBytes(18).toString('base64url');
  const hash = sha256(passwort);

  // Der Zugang darf genau seinen eigenen Zweig — Befehle lesen, Antworten
  // schreiben. 'display/#' braucht er NICHT: das ist ohnehin für jeden
  // angemeldeten Client lesbar (Sonderregel im aclcheck).
  await pool.query(
    `INSERT INTO mqtt_service_users (username, password_hash, can_write, topic_filter, description)
     VALUES ($1,$2,true,$3,$4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       can_write = EXCLUDED.can_write, topic_filter = EXCLUDED.topic_filter`,
    [mqtt_benutzer, hash, `${ANZEIGE_TOPIC_PREFIX}/#`, `Anzeigegerät ${name}`]);

  const haus = HAEUSER.includes(Number(req.body?.haus)) ? Number(req.body.haus) : null;
  await pool.query(
    `INSERT INTO anzeigegeraete (id, name, standort, notiz, mqtt_thema, mqtt_benutzer, haus, angelegt_von)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, name, String(req.body?.standort || '').slice(0, 200) || null,
     String(req.body?.notiz || '').slice(0, 500) || null, id, mqtt_benutzer, haus,
     req.user?.email || req.user?.name || null]);

  // Gleich synchronisieren: das Gerät soll seine Adresse haben, sobald es
  // angelegt ist. Läuft es noch nicht, verpufft der Befehl folgenlos — dann
  // holt es die Datei beim nächsten Speichern oder von Hand.
  req.app.locals.tafelSynchronisieren?.(id);

  res.json({ id, name, haus, ...anzeigeZettel({ mqtt_thema: id, mqtt_benutzer, passwort, haus }) });
}));

// PATCH /api/stations/admin/anzeigen/:id — Standort, Notiz, Haus ändern.
//
// Bis hierher liess sich ein Gerät nur anlegen und löschen. Zog eine Tafel um
// oder war das Haus falsch getippt, blieb nur beides — mit neuem MQTT-Zugang,
// den man an der Tafel wieder eintippen muss.
router.patch('/admin/anzeigen/:id', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const alt = await pool.query('SELECT haus FROM anzeigegeraete WHERE id = $1', [req.params.id]);
  if (!alt.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });

  const felder = [];
  const werte = [];
  const setze = (spalte, wert) => { werte.push(wert); felder.push(`${spalte} = $${werte.length}`); };

  if (req.body?.standort !== undefined) setze('standort', String(req.body.standort || '').slice(0, 200) || null);
  if (req.body?.notiz !== undefined) setze('notiz', String(req.body.notiz || '').slice(0, 500) || null);

  // Das Haus darf auch geleert werden — ein Testgerät gehört zu keinem.
  let hausNeu;
  if (req.body?.haus !== undefined) {
    hausNeu = HAEUSER.includes(Number(req.body.haus)) ? Number(req.body.haus) : null;
    setze('haus', hausNeu);
  }
  if (req.body?.alarm_zone !== undefined) {
    setze('alarm_zone', String(req.body.alarm_zone || '').trim().slice(0, 80) || null);
  }
  if (!felder.length) return res.status(400).json({ error: 'Nichts zu ändern' });

  werte.push(req.params.id);
  const r = await pool.query(
    `UPDATE anzeigegeraete SET ${felder.join(', ')} WHERE id = $${werte.length}
     RETURNING id, name, standort, notiz, mqtt_thema, mqtt_benutzer, haus`, werte);

  // Nur beim Haus: daran hängt der Inhalt der Datei auf der Tafel.
  if (hausNeu !== undefined && hausNeu !== alt.rows[0].haus) {
    req.app.locals.tafelSynchronisieren?.(req.params.id);
  }
  res.json(r.rows[0]);
}));

// POST /api/stations/admin/anzeigen/:id/synchronisieren — von Hand anstossen.
//
// Die Rückmeldung sagt nur, dass der Befehl den Broker erreicht hat. Ob die
// Tafel ihn befolgt, weiss sie allein — sie antwortet auf ihrem eigenen Kanal.
router.post('/admin/anzeigen/:id/synchronisieren', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query('SELECT 1 FROM anzeigegeraete WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
  const ok = req.app.locals.tafelSynchronisieren?.(req.params.id);
  if (!ok) return res.status(503).json({ error: 'Keine Verbindung zum MQTT-Broker' });
  res.json({ ok: true });
}));

// DELETE /api/stations/admin/anzeigen/:id — Gerät und sein MQTT-Zugang.
router.delete('/admin/anzeigen/:id', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query('DELETE FROM anzeigegeraete WHERE id = $1 RETURNING mqtt_benutzer', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
  await pool.query('DELETE FROM mqtt_service_users WHERE username = $1', [r.rows[0].mqtt_benutzer]);
  res.json({ ok: true });
}));

// ─── SSH-Wartung ─────────────────────────────────────────────────────
// Nach dem Muster der adb-Freigabe auf /smartphones: ein Knopf, eine feste
// Dauer, das Ende steht sichtbar daneben, und vorzeitig beenden geht auch.
//
// Der Weg zur Station ist das Lebenszeichen. Eine Station hat keinen offenen
// Port, also kann man ihr nichts schicken; sie bekommt die Freigabe samt
// Schluesseln in der Antwort auf /seen (station-agent, alle fuenf Minuten)
// und oeffnet dann selbst — sshd, Firewall, Schluesseldatei unter /run.
//
// Warum nicht der AuthorizedKeysCommand aus routes/ssh-zugang.js: der fragt
// mit dem gemeinsamen Host-Token, den Stationen bisher gar nicht bekommen,
// und sein Zwischenspeicher haelt bei einem API-Ausfall den letzten Stand
// sieben Tage lang — genau das, was eine befristete Freigabe nicht darf. Das
// Stationstoken dagegen ist je Geraet und ohnehin da.
//
// Das Ende haengt NICHT an der API. Jede Schluesselzeile traegt auf der
// Station ein expiry-time, die Firewall-Oeffnung ein Timeout, und ein Timer
// raeumt zur Endzeit ab. Faellt die API aus, schliesst die Station trotzdem
// puenktlich. Nur das VORZEITIGE Beenden braucht das naechste Lebenszeichen.
const WARTUNG_STUNDEN = 2;

async function wartungOffen(stationId) {
  const r = await pool.query(
    `SELECT id, bis, erteilt_von FROM station_ssh_wartung
      WHERE station_id = $1 AND beendet_am IS NULL AND bis > NOW()
      ORDER BY bis DESC LIMIT 1`, [stationId]);
  return r.rows[0] || null;
}

const uhrzeit = (d) => new Date(d).toLocaleTimeString('de-CH',
  { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });

// POST /api/stations/admin/:id/ssh-wartung — freigeben oder verlaengern.
// Ein zweiter Druck auf den Knopf verlaengert auf zwei Stunden ab jetzt, statt
// eine zweite Freigabe danebenzustellen.
router.post('/admin/:id/ssh-wartung', authMiddleware, nurTechnik, nichtFuerWindows, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const st = await pool.query(
    `SELECT id, status FROM stations WHERE id = $1 AND revoked_at IS NULL`, [req.params.id]);
  if (!st.rows.length) return res.status(404).json({ error: 'Station nicht gefunden oder entfernt' });
  // Eine gesperrte Station bekommt im Lebenszeichen nichts ausser der Sperre.
  if (st.rows[0].status === 'gesperrt') {
    return res.status(409).json({ error: 'Station ist gesperrt — erst entsperren' });
  }
  const n = Number((await pool.query('SELECT COUNT(*)::int AS n FROM station_wartung_schluessel')).rows[0].n);
  if (!n) return res.status(409).json({ error: 'Keine Wartungsschlüssel hinterlegt — die Freigabe liesse niemanden herein' });

  const offen = await wartungOffen(req.params.id);
  let bis;
  if (offen) {
    bis = (await pool.query(
      `UPDATE station_ssh_wartung SET bis = NOW() + ($2 || ' hours')::interval
        WHERE id = $1 RETURNING bis`, [offen.id, String(WARTUNG_STUNDEN)])).rows[0].bis;
    await ereignis(req.params.id, 'ssh-wartung-verlaengert', wer, `bis ${uhrzeit(bis)}`);
  } else {
    bis = (await pool.query(
      `INSERT INTO station_ssh_wartung (station_id, erteilt_von, bis)
       VALUES ($1, $2, NOW() + ($3 || ' hours')::interval) RETURNING bis`,
      [req.params.id, wer, String(WARTUNG_STUNDEN)])).rows[0].bis;
    await ereignis(req.params.id, 'ssh-wartung-an', wer, `bis ${uhrzeit(bis)}`);
  }
  console.log(`[stations] SSH-Wartung '${req.params.id}' von ${wer} bis ${new Date(bis).toISOString()}`);
  res.json({ ok: true, bis });
}));

// DELETE /api/stations/admin/:id/ssh-wartung — vorzeitig beenden.
router.delete('/admin/:id/ssh-wartung', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE station_ssh_wartung SET beendet_am = NOW(), beendet_von = $2
      WHERE station_id = $1 AND beendet_am IS NULL AND bis > NOW() RETURNING id`,
    [req.params.id, wer]);
  if (r.rows.length) await ereignis(req.params.id, 'ssh-wartung-aus', wer, 'vorzeitig beendet');
  res.json({ ok: true, beendet: r.rows.length });
}));

// Die Wartungsschluessel. Nur oeffentliche Teile, geprueft wie im Profil
// (lib/sshkeys.js: keine Optionen vor dem Typ, RSA ab 2048 Bit).
router.get('/admin/wartungsschluessel', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    `SELECT id, typ, kommentar, fingerprint, label, erstellt_von, erstellt_am
       FROM station_wartung_schluessel ORDER BY erstellt_am`);
  res.json({ schluessel: r.rows });
}));

router.post('/admin/wartungsschluessel', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  let k;
  try { k = schluesselPruefen(req.body?.schluessel); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const label = String(req.body?.label || k.kommentar || '').trim().slice(0, 100) || null;
  const r = await pool.query(
    `INSERT INTO station_wartung_schluessel (typ, blob_b64, kommentar, fingerprint, label, erstellt_von)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
    [k.typ, k.blobB64, k.kommentar || null, k.fingerprint, label, wer]);
  if (!r.rows.length) return res.status(409).json({ error: 'Dieser Schlüssel ist schon hinterlegt' });
  console.log(`[stations] Wartungsschlüssel ${k.fingerprint} hinzugefügt von ${wer}`);
  res.json({ ok: true, id: r.rows[0].id, fingerprint: k.fingerprint });
}));

router.delete('/admin/wartungsschluessel/:sid', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  if (!/^\d+$/.test(req.params.sid)) return res.status(404).json({ error: 'Schlüssel nicht gefunden' });
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    'DELETE FROM station_wartung_schluessel WHERE id = $1 RETURNING fingerprint', [req.params.sid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Schlüssel nicht gefunden' });
  console.log(`[stations] Wartungsschlüssel ${r.rows[0].fingerprint} entfernt von ${wer}`);
  res.json({ ok: true });
}));

// Sperren, von Hand wie durch den Anschluss-Wächter. Ein Weg, damit beide
// dasselbe bewirken: Station bekommt keine Config mehr, das Lebenszeichen
// trägt Sperre und Grund zur Station (station-sperre an).
async function stationSperren(id, grund, wer) {
  const r = await pool.query(
    `UPDATE stations SET status='gesperrt', sperr_grund=$2, gesperrt_von=$3, gesperrt_am=NOW()
      WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
    [id, grund, wer],
  );
  if (!r.rows.length) return false;
  await ereignis(id, 'gesperrt', wer, grund);
  console.log(`[stations] '${id}' gesperrt von ${wer}${grund ? ` (${grund})` : ''}`);
  return true;
}

router.post('/admin/:id/block', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const grund = (req.body?.grund || '').trim() || null;
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  if (!await stationSperren(req.params.id, grund, wer)) return res.status(404).json({ error: 'Station nicht gefunden' });
  res.json({ ok: true });
}));

// POST /api/stations/admin/:id/unblock
router.post('/admin/:id/unblock', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  // Ein offener fremder Anschluss wird dabei verworfen, nicht übernommen:
  // hängt die Station noch dort, sperrt der Wächter nach zwei Abgleichen
  // erneut. Wer den neuen Anschluss gelten lassen will, nimmt
  // "Anschluss übernehmen und freigeben".
  const r = await pool.query(
    `UPDATE stations SET status='aktiv', sperr_grund=NULL, gesperrt_von=NULL, gesperrt_am=NULL,
            anschluss_abweichung = NULL, anschluss_kandidat = NULL
      WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
    [req.params.id],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'entsperrt', wer, null);
  res.json({ ok: true });
}));

// DELETE /api/stations/admin/:id — endgültig entfernen. Das Token der Station
// ist danach wertlos; das Gerät fällt beim nächsten Lauf auf.
// POST /api/stations/admin/:id/zuruecksetzen — in den Einrichtungszustand.
//
// Anders als 'entfernen': dort wird nur revoked_at gesetzt, und das Geraet
// laeuft unveraendert weiter, weil es davon nie erfaehrt. Hier holt die Station
// die Aufforderung im Lebenszeichen ab, loescht ihre Identitaet und startet in
// den Einrichtungszustand — danach meldet sie sich selbst ab, und erst dadurch
// wird das Token entwertet.
router.post('/admin/:id/zuruecksetzen', authMiddleware, nurTechnik, nichtFuerWindows, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET zuruecksetzen_angefordert = NOW(), zuruecksetzen_angefordert_von = $2
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [req.params.id, wer],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'zuruecksetzen-angefordert', wer,
    'Station soll ihre Identität löschen und in den Einrichtungszustand starten');
  res.json({ ok: true });
}));

// DELETE /api/stations/admin/:id/zuruecksetzen — Aufforderung zurueckziehen.
router.delete('/admin/:id/zuruecksetzen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  await pool.query(
    `UPDATE stations SET zuruecksetzen_angefordert = NULL, zuruecksetzen_angefordert_von = NULL
      WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

router.delete('/admin/:id', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    'UPDATE stations SET revoked_at = NOW(), status = $2 WHERE id = $1 RETURNING id',
    [req.params.id, 'entfernt'],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'entfernt', wer, null);
  console.log(`[stations] '${req.params.id}' entfernt von ${wer}`);
  res.json({ ok: true });
}));

// ─── Anmeldung der Anwendungen auf der Station ──────────────────────
// Der Stationstoken gehoert dem Geraet und kennt keine Person. Fuer alles,
// was von der angemeldeten Person abhaengt — das Telefonbuch etwa —, braucht
// es eine eigene Sitzung.

async function appSession(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token.startsWith(APP_PREFIX)) return res.status(401).json({ error: 'Nicht angemeldet' });
    await ensureSchema();
    const r = await pool.query(
      'SELECT * FROM station_app_sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [sha256(token)],
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Anmeldung abgelaufen' });
    // Die Sitzung lebt 30 Tage mit den Gruppen vom Anmeldezeitpunkt. Ein im
    // Portal deaktiviertes Konto soll nicht bis zum Ablauf weiterlaufen.
    if (r.rows[0].email) {
      const u = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND active IS FALSE LIMIT 1', [r.rows[0].email]);
      if (u.rows.length) return res.status(401).json({ error: 'Konto deaktiviert' });
    }
    req.appUser = r.rows[0];
    pool.query('UPDATE station_app_sessions SET last_used_at = NOW() WHERE token_hash = $1',
      [sha256(token)]).catch(() => {});
    next();
  } catch (e) { next(e); }
}

// POST /api/stations/app-login  { username, password, station_id? }
router.post('/app-login', a(async (req, res) => {
  const { username, password, station_id } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzer und Passwort nötig' });
  if (adGesperrt(req, username)) return res.status(429).json({ error: 'Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen' });
  const versuch = adVersuchVormerken(req, username);

  let user;
  try {
    user = await authenticateAD(username, password);
  } catch (e) {
    adVersuchZuruecknehmen(versuch);
    console.error('[stations] AD nicht erreichbar:', e.message);
    return res.status(503).json({ error: 'Verzeichnisdienst nicht erreichbar' });
  }
  if (!user) return res.status(401).json({ error: 'Benutzer oder Passwort stimmt nicht' });
  adVersuchZuruecknehmen(versuch);
  adFehlversuche.delete(adNameKey(username));

  await ensureSchema();
  const token = newToken(APP_PREFIX);
  await pool.query(
    `INSERT INTO station_app_sessions (token_hash, username, display_name, groups_json, email, station_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + ($7 || ' days')::interval)`,
    [sha256(token), user.username, user.displayName, JSON.stringify(user.groups || []),
      user.email || null, station_id || null, String(APP_TTL_TAGE)],
  );
  res.json({
    token,
    expires_in: APP_TTL_TAGE * 24 * 3600,
    user: { name: user.displayName, username: user.username, groups: user.groups },
  });
}));

// GET /api/stations/telefonbuch — Umfang richtet sich nach den Gruppen.
router.get('/telefonbuch', appSession, a(async (req, res) => {
  let groups = [];
  try { groups = JSON.parse(req.appUser.groups_json || '[]'); } catch { groups = []; }
  res.json({
    fuer: req.appUser.display_name || req.appUser.username,
    eintraege: await telefonbuch(groups),
  });
}));

// ─── Registrierung ──────────────────────────────────────────────────

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// POST /api/stations/register  { type, standort, id?, hostname?, notiz?, hardware? }
router.post('/register', setupSession, a(async (req, res) => {
  const { type, standort, notiz, hardware } = req.body || {};
  // Die Hausnummer kommt aus dem Einrichtungsdialog. Ohne sie zeigt die
  // Station später jede Ankündigung — deshalb fragt der Installer danach.
  const haus = HAEUSER.includes(Number(req.body?.haus)) ? Number(req.body.haus) : null;
  if (!STATION_TYPES.some((t) => t.id === type)) {
    return res.status(400).json({ error: `Unbekannter Typ '${type}'` });
  }
  if (!standort || !String(standort).trim()) {
    return res.status(400).json({ error: 'Standort fehlt' });
  }

  const id = slug(req.body.id || `${type}-${standort}`);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    return res.status(400).json({ error: `Ungültige Kennung '${id}'` });
  }

  const vorhanden = await pool.query('SELECT id FROM stations WHERE id = $1 AND revoked_at IS NULL', [id]);
  if (vorhanden.rows.length) {
    return res.status(409).json({
      error: `Station '${id}' gibt es schon — anderen Standort oder eigene Kennung wählen`,
    });
  }

  // ─── Gesperrte Hardware ───────────────────────────────────────────
  //
  // Eine Sperre, die man mit einem Einrichtungslauf abschütteln kann, ist
  // keine. Dieselbe Kennung fängt die Dublettenprüfung oben ab — aber wer
  // state.json löscht und die Station unter NEUEM Namen einrichtet, bekam
  // bisher ein frisches, voll eingerichtetes Gerät mit gültigem Token,
  // während der gesperrte Eintrag unberührt danebenstand.
  //
  // Wiedererkannt wird deshalb die Maschine, nicht der Name: Seriennummer
  // aus dem DMI und die MAC-Adressen. Beide schickt der Einrichtungsdialog
  // ohnehin schon fürs Inventar mit.
  //
  // Aufheben darf das die Gruppe technik — dieselbe, die auch sperrt. Damit
  // bleibt der reguläre Weg offen (erst entsperren oder gleich hier neu
  // zuordnen), und für alle anderen ist Schluss. Wer die Platte tauscht,
  // umgeht das; dagegen hilft Verschlüsselung, nicht diese Prüfung.
  // Inventar ist ein paar hundert Byte; mehr landet nur als Ballast in der
  // Tabelle (der Body-Parser liesse 10 MB durch).
  if (hardware !== undefined && hardware !== null
      && (typeof hardware !== 'object' || Array.isArray(hardware) || JSON.stringify(hardware).length > 32 * 1024)) {
    return res.status(400).json({ error: 'hardware ungültig oder zu gross' });
  }
  const hw = hardware && typeof hardware === 'object' ? hardware : {};
  const seriennummer = String(hw.seriennummer || '').trim();
  const macs = Object.values(hw.macs || {})
    .map((m) => String(m || '').trim().toLowerCase())
    .filter((m) => m && m !== '00:00:00:00:00:00');

  if (seriennummer || macs.length) {
    const gesperrt = await pool.query(
      `SELECT id, sperr_grund, gesperrt_am FROM stations
        WHERE status = 'gesperrt'
          -- Eine nur auf Freigabe wartende Station ist keine Sperre der Hardware.
          AND COALESCE(gesperrt_von, '') <> 'registrierung'
          AND ( ($1 <> '' AND lower(hardware->>'seriennummer') = lower($1))
             OR EXISTS (SELECT 1
                          FROM jsonb_each_text(COALESCE(hardware->'macs', '{}'::jsonb)) AS m
                         WHERE lower(m.value) = ANY($2::text[])) )
        LIMIT 1`,
      [seriennummer, macs],
    );
    if (gesperrt.rows.length) {
      let gruppen = [];
      try { gruppen = JSON.parse(req.setupUser?.groups_json || '[]'); } catch { gruppen = []; }
      if (!isTechnik(gruppen) && !isPraesident(gruppen)) {
        const alt = gesperrt.rows[0];
        console.warn(`[stations] Neuzuordnung abgelehnt: Hardware gehört zur gesperrten Station '${alt.id}'`
          + ` (Versuch als '${id}' von ${req.setupUser?.username || 'unbekannt'})`);
        await ereignis(alt.id, 'neuzuordnung-abgelehnt',
          req.setupUser?.username || 'unbekannt',
          `Versuch, dieselbe Hardware als '${id}' einzurichten`);
        return res.status(403).json({
          error: `Dieses Gerät ist gesperrt (als '${alt.id}')`
            + `${alt.sperr_grund ? `: ${alt.sperr_grund}` : '.'}`
            + ' Nur die Gruppe technik kann es neu zuordnen.',
        });
      }
    }
  }

  // Geheimnisse (AD-Join-Passwort, root-Hash, MQTT, Admin-SSH-Schlüssel und
  // über /config der WLAN-Schlüssel) gehen nur an Stationen, die Technik
  // eingerichtet oder freigegeben hat. Richtet jemand anderes ein, entsteht
  // die Station gesperrt mit Vermerk; die Freigabe ist das bestehende
  // "Entsperren" in der Verwaltung, danach holt sich die Station ihre Config.
  let setupGruppen = [];
  try { setupGruppen = JSON.parse(req.setupUser?.groups_json || '[]'); } catch { setupGruppen = []; }
  const vonTechnik = isTechnik(setupGruppen) || isPraesident(setupGruppen);

  const token = newToken(STATION_PREFIX);
  const row = {
    id,
    role: type,
    hostname: slug(req.body.hostname || id),
    standort: String(standort).trim(),
    notiz: notiz ? String(notiz).trim() : null,
    overrides: {},
  };

  // Eine abgemeldete Station hinterlässt ihre Zeile (Verlauf und Ereignisse
  // sollen bleiben), und id ist der Primärschlüssel. Ohne ON CONFLICT würde
  // dieselbe Kennung nach einem 'stationctl unregister' nie wieder vergeben
  // werden können. Das WHERE ist der Riegel davor, eine *aktive* Station zu
  // überschreiben — die hat die Dublettenprüfung oben schon abgefangen.
  const eingefuegt = await pool.query(
    `INSERT INTO stations (id, role, hostname, standort, notiz, haus, token_hash, hardware,
                           registered_by, last_seen_ip, status, sperr_grund, gesperrt_von, gesperrt_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET
       role = EXCLUDED.role, hostname = EXCLUDED.hostname,
       standort = EXCLUDED.standort, notiz = EXCLUDED.notiz, haus = EXCLUDED.haus,
       token_hash = EXCLUDED.token_hash, hardware = EXCLUDED.hardware,
       registered_by = EXCLUDED.registered_by, last_seen_ip = EXCLUDED.last_seen_ip,
       registered_at = NOW(), revoked_at = NULL, status = EXCLUDED.status,
       sperr_grund = EXCLUDED.sperr_grund, gesperrt_von = EXCLUDED.gesperrt_von,
       gesperrt_am = EXCLUDED.gesperrt_am,
       -- Offene Auftraege verfallen mit der alten Identitaet.
       --
       -- Am 11. August 2026 fehlte das: eine Station wurde zurueckgesetzt, neu
       -- eingerichtet — und vier Minuten spaeter sah der Agent dieselbe
       -- Aufforderung von vorher und setzte sie erneut zurueck. Die Arbeit an
       -- der Konsole war umsonst.
       zuruecksetzen_angefordert = NULL, zuruecksetzen_angefordert_von = NULL,
       update_angefordert = NULL, update_angefordert_von = NULL,
       last_seen_at = NULL, last_state = NULL
     WHERE stations.revoked_at IS NOT NULL
     RETURNING id`,
    [row.id, row.role, row.hostname, row.standort, row.notiz, row.haus, sha256(token),
      JSON.stringify(hardware || {}), req.setupUser.username, clientIp(req),
      vonTechnik ? 'aktiv' : 'gesperrt',
      vonTechnik ? null : 'Wartet auf Freigabe durch Technik',
      vonTechnik ? null : 'registrierung',
      vonTechnik ? null : new Date()],
  );
  if (!eingefuegt.rows.length) {
    return res.status(409).json({ error: `Station '${id}' gibt es schon` });
  }
  await ereignis(id, 'registriert', req.setupUser.username, `${type} · ${row.standort}`);

  console.log(`[stations] '${id}' (${type}) registriert von ${req.setupUser.username}`);
  if (!vonTechnik) {
    await ereignis(id, 'freigabe-noetig', req.setupUser.username, 'Eingerichtet ohne Gruppe technik — Geheimnisse erst nach Entsperren');
    const cfg = buildConfig(row);
    // Gerüst ohne Geheimnisse: die Station kennt Kennung und Rolle, aber
    // nichts, womit sie ins AD, an den Broker oder als root käme.
    if (cfg.system) cfg.system.root_password_hash = '';
    if (cfg.domain) cfg.domain.join_password = '';
    if (cfg.admin) { cfg.admin.ssh_authorized_keys = []; cfg.admin.ssh_enabled = false; }
    if (cfg.mqtt) cfg.mqtt.password = '';
    return res.status(202).json({
      station_id: id, station_token: token, config: cfg, freigabe_noetig: true,
      hinweis: 'Station angelegt, wartet auf Freigabe durch die Gruppe technik. Danach holt sie ihre Konfiguration selbst.',
    });
  }
  res.status(201).json({ station_id: id, station_token: token, config: buildConfig(row) });
}));

// ─── Betrieb (Station selbst) ───────────────────────────────────────

// GET /api/stations/:id/apps
//
// Die Rosenweg-Seiten als Programmliste. Abgeleitet aus js/nav.js, damit die
// Stationen nicht hinterherhinken, wenn die Website eine Seite dazubekommt.
// Je Eintrag steht dabei, WER ihn sehen darf. Die Station blendet danach ein,
// was zur Gruppenzugehörigkeit der angemeldeten Person passt — bisher zeigte
// sie jeder Person alles und überliess die Prüfung der Seite nach dem Klick.
router.get('/:id/apps', stationAuth, a(async (req, res) => {
  res.json({ apps: await gruppenJeApp(pool, { haus: req.station.haus }) });
}));

// POST /api/stations/:id/programme  { programme: [{ id, name }, …] }
//
// Die Station meldet, welche Programmeinträge auf ihr überhaupt vorhanden
// sind. Nur so kann die Verwaltung eine Auswahl anbieten statt eines
// Textfelds — und nur so sieht man dort, dass ein Eintrag aus der Liste gar
// nicht installiert ist.
//
// Gemeldet wird bei jedem Einrichtungslauf, also selten. Die Liste ersetzt
// die vorige vollständig: ein deinstalliertes Programm soll verschwinden.
router.post('/:id/programme', stationAuth, a(async (req, res) => {
  const roh = Array.isArray(req.body?.programme) ? req.body.programme : null;
  if (!roh) return res.status(400).json({ error: 'programme fehlt oder ist keine Liste' });

  // Eine Station mit sehr vielen Paketen soll die Tabelle nicht sprengen, und
  // ein Name ist ein Name — keine Romane.
  const programme = roh
    .filter((p) => p && typeof p.id === 'string' && /^[\w.+-]+\.desktop$/.test(p.id))
    .slice(0, 600)
    .map((p) => ({ id: p.id, name: String(p.name || p.id).slice(0, 120) }))
    .sort((x, y) => x.name.localeCompare(y.name, 'de'));

  await pool.query(
    'UPDATE stations SET programme = $2, programme_gemeldet_am = NOW() WHERE id = $1',
    [req.station.id, JSON.stringify(programme)],
  );
  res.json({ ok: true, anzahl: programme.length });
}));

// GET /api/stations/:id/os?kanal=main — was ist das Neueste?
router.get('/:id/os', stationAuth, a(async (req, res) => {
  const n = await stationos.neueste(req.query.kanal || 'main');
  if (!n) return res.status(404).json({ error: 'Für diesen Kanal ist noch nichts veröffentlicht' });
  res.json(n);
}));

// GET /api/stations/:id/os/tarball?version=…&kanal=main
// Auch alte Versionen — der Rollback braucht genau das.
router.get('/:id/os/tarball', stationAuth, a(async (req, res) => {
  const kanal = req.query.kanal || 'main';
  const version = String(req.query.version || '').trim()
    || (await stationos.neueste(kanal))?.version;
  if (!version) return res.status(404).json({ error: 'Keine Version angegeben und keine vorhanden' });

  const v = await stationos.holen(kanal, version);
  if (!v) return res.status(404).json({ error: `Version '${version}' gibt es im Kanal '${kanal}' nicht` });

  res.set('Content-Type', 'application/gzip');
  res.set('X-Version', v.version);
  res.set('X-SHA256', v.sha256);
  res.send(v.daten);
}));

// GET /api/stations/:id/config
router.get('/:id/config', stationAuth, a(async (req, res) => {
  await pool.query('UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1',
    [req.station.id, clientIp(req)]);

  // Der WLAN-Schlüssel wird erst hier eingesetzt, frisch aus UniFi. In der
  // Config steht nur der Netzname — so gibt es keinen zweiten Ort, an dem ein
  // Schlüssel gepflegt werden müsste und veralten kann.
  const cfg = buildConfig(req.station);
  cfg.network = { ...(cfg.network || {}), wifi: await wlanAufloesen(cfg.network?.wifi) };
  res.json(cfg);
}));

// GET /api/stations/:id/persist-key
//
// Der Schlüssel für die verschlüsselte Datenpartition. Auf der Station liegt
// er nirgends — sie holt ihn bei jedem Start hier ab und reicht ihn direkt an
// cryptsetup weiter.
//
// Damit hängt der Zugriff auf die Daten an drei Bedingungen, die alle
// hier entschieden werden und nicht am Gerät:
//
//   1. Ein gültiges Stationstoken. Das liegt zwar auf dem unverschlüsselten
//      Root und ist mit der Platte in der Hand lesbar — deshalb allein
//      genügt es nicht.
//   2. Die Station ist nicht gesperrt. stationAuth weist Gesperrte ab (nur
//      das Lebenszeichen darf durch). Wer ein Gerät als verschwunden meldet
//      und sperrt, macht damit die Daten unlesbar.
//   3. Die Anfrage kommt aus dem Hausnetz. Ein Gerät, das jemand mitnimmt,
//      bekommt seinen Schlüssel anderswo nicht — auch dann nicht, wenn der
//      Diebstahl noch niemandem aufgefallen ist.
//
// Der Schlüssel selbst steht in keiner Tabelle: er wird aus einem Geheimnis
// des Servers und der Kennung abgeleitet. Zu sichern ist damit genau eine
// Zeichenkette (STATION_PERSIST_SECRET) statt einer Schlüsselsammlung. Geht
// sie verloren, sind die Datenpartitionen aller Stationen verloren — was
// Protokolle und Zwischenspeicher kostet, keine Nutzdaten: die Homes liegen
// auf dem Dateiserver.
//
// persist_key_gen macht eine Neuverschlüsselung einzelner Stationen möglich:
// hochzählen, Partition neu anlegen, fertig.
const INTERN_NETZE = (process.env.STATION_INTERN_NETZE
  || '2a02:16a:1400::/48,100.64.0.0/10,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,::1,127.0.0.0/8')
  .split(',').map((s) => s.trim()).filter(Boolean);

function ipInNetz(ip, netz) {
  const [basis, bitsText] = netz.split('/');
  const bits = bitsText === undefined ? null : Number(bitsText);
  const a = ipBytes(ip);
  const b = ipBytes(basis);
  if (!a || !b || a.length !== b.length) return false;
  const praefix = bits === null ? a.length * 8 : bits;
  let rest = praefix;
  for (let i = 0; i < a.length && rest > 0; i += 1) {
    const nimm = Math.min(8, rest);
    const maske = (0xff << (8 - nimm)) & 0xff;
    if ((a[i] & maske) !== (b[i] & maske)) return false;
    rest -= nimm;
  }
  return true;
}

// Beide Familien auf 16 Byte bringen: eine IPv4 kommt hinter dem Traefik
// gelegentlich als ::ffff:1.2.3.4 an, und dann muss sie mit einem IPv4-Netz
// vergleichbar bleiben.
function ipBytes(ip) {
  if (!ip) return null;
  let text = String(ip).trim().replace(/^\[|\]$/g, '');
  if (text.startsWith('::ffff:') && text.includes('.')) text = text.slice(7);
  if (text.includes('.') && !text.includes(':')) {
    const teile = text.split('.').map(Number);
    if (teile.length !== 4 || teile.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return Uint8Array.from(teile);
  }
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const doppelt = text.split('::');
  if (doppelt.length > 2) return null;
  const links = doppelt[0] ? doppelt[0].split(':') : [];
  const rechts = doppelt.length === 2 && doppelt[1] ? doppelt[1].split(':') : [];
  const fehlend = 8 - links.length - rechts.length;
  if (doppelt.length === 1 && links.length !== 8) return null;
  if (doppelt.length === 2 && fehlend < 0) return null;
  const gruppen = doppelt.length === 2
    ? [...links, ...Array(fehlend).fill('0'), ...rechts]
    : links;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const wert = parseInt(gruppen[i] || '0', 16);
    if (Number.isNaN(wert) || wert < 0 || wert > 0xffff) return null;
    bytes[i * 2] = wert >> 8;
    bytes[i * 2 + 1] = wert & 0xff;
  }
  return bytes;
}

function istHausnetz(ip) {
  return INTERN_NETZE.some((netz) => ipInNetz(ip, netz));
}

router.get('/:id/persist-key', stationAuth, a(async (req, res) => {
  const geheimnis = process.env.STATION_PERSIST_SECRET || '';
  if (!geheimnis) {
    console.error('[stations] STATION_PERSIST_SECRET fehlt — kein Schlüssel für /persist möglich.');
    return res.status(503).json({ error: 'Schlüsselableitung nicht konfiguriert' });
  }

  // Was für diese Station gilt, steht in ihrer Config — eine Stationsart
  // 'laptop' bringt 'mobil: true' mit.
  const cfgStation = buildConfig(req.station);
  const mobil = cfgStation.sicherheit?.mobil === true;
  const maxStille = Number(cfgStation.sicherheit?.max_stille_tage ?? 14);

  const ip = clientIp(req);

  // Ortsprüfung — aber nicht für Geräte, die das Haus verlassen dürfen.
  //
  // Bei einer ortsgebundenen Station ist "meldet sich von auswärts" ein
  // Alarmzeichen: sie steht im Treppenhaus und hat dort zu bleiben. Bei einem
  // Laptop wäre dieselbe Regel keine Sicherung, sondern eine Sperre — und sie
  // täuschte obendrein Schutz vor, denn der Tunnelschlüssel liegt auf dem
  // unverschlüsselten Root. Wer das Gerät hat, käme damit ohnehin als
  // Hausgerät herein. Für mobile Geräte tragen deshalb Sperre, Passphrase und
  // die Frist unten — nicht der Ort.
  if (!mobil && !istHausnetz(ip)) {
    console.warn(`[stations] Schlüssel für '${req.station.id}' abgelehnt — ${ip} ist nicht im Hausnetz.`);
    await ereignis(req.station.id, 'schluessel-abgelehnt', null, `Anfrage von ${ip}`);
    return res.status(403).json({ error: 'Schlüssel wird nur im Hausnetz herausgegeben' });
  }

  // Frist ohne Kontakt.
  //
  // Ein Dieb, der ein Gerät liegen lässt, bis niemand mehr daran denkt, soll
  // es danach nicht einfach anschliessen können. Das Lebenszeichen ist das
  // Mass: es läuft alle fünf Minuten und braucht kein Zutun.
  //
  // Für eine Station, die nur aus war, kostet das nichts — sie meldet sich
  // beim Hochfahren, und der Entsperrdienst versucht es ohnehin jede Minute
  // erneut. Bei einem Laptop ohne Verbindung tritt stattdessen die Passphrase
  // an die Stelle des Schlüssels.
  // Ersatzweise die Registrierung: eine frisch eingerichtete Station hat noch
  // kein Lebenszeichen gesendet — das erste kommt erst NACH install.sh, und
  // genau dort fragt sie zum ersten Mal nach ihrem Schlüssel. Ohne diesen
  // Rückfall bliebe die Frist an der eigenen Einrichtung hängen.
  const letzterKontakt = req.station.last_seen_at || req.station.registered_at;
  const stille = letzterKontakt
    ? (Date.now() - new Date(letzterKontakt).getTime()) / 86400000
    : 0;
  if (maxStille > 0 && stille > maxStille) {
    const tage = Number.isFinite(stille) ? Math.floor(stille) : null;
    console.warn(`[stations] Schlüssel für '${req.station.id}' abgelehnt — ${tage ?? 'nie'} Tage ohne Lebenszeichen.`);
    await ereignis(req.station.id, 'schluessel-abgelehnt', null,
      `${tage ?? 'nie'} Tage ohne Lebenszeichen (Grenze ${maxStille})`);
    return res.status(403).json({
      error: `Diese Station hat sich ${tage ?? 'noch nie'} Tage nicht gemeldet —`
        + ' der Schlüssel wird erst nach einem Lebenszeichen wieder herausgegeben',
    });
  }

  const gen = Number(req.station.persist_key_gen || 1);
  const schluessel = crypto.createHmac('sha256', geheimnis)
    .update(`${req.station.id}:${gen}`).digest('hex');

  await pool.query(
    'UPDATE stations SET persist_key_zuletzt = NOW(), last_seen_ip = $2 WHERE id = $1',
    [req.station.id, ip],
  );
  res.json({ schluessel, gen });
}));

// POST /api/stations/:id/seen  { state }
//
// Das ist die Rückmeldung, von der die Verwaltung lebt: was für ein Gerät,
// welche Rolle, welche Version, hat die Einrichtung geklappt.
router.post('/:id/seen', stationAuth, a(async (req, res) => {
  const state = req.body?.state || {};
  await pool.query(
    'UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $3, last_state = $2 WHERE id = $1',
    [req.station.id, JSON.stringify(state), clientIp(req)],
  );
  // Doppelte Station? Fehler hier dürfen das Lebenszeichen nicht kosten —
  // über seine Antwort erfährt die Station von Sperre und Update.
  await lebenszeichenPruefen(req.station, state, clientIp(req))
    .catch((e) => console.error('[stations] Doppel-Prüfung:', e.message));
  if (state.ereignis) {
    await ereignis(req.station.id, String(state.ereignis).slice(0, 40), null,
      state.text ? String(state.text).slice(0, 500) : null);
  }

  // Hat jemand in der Verwaltung ein Update angefordert? Dann hier ausliefern
  // und im selben Zug quittieren — sonst liefe die Station bei jedem
  // Lebenszeichen erneut los.
  //
  // Eine gesperrte Station bekommt nichts: sie soll gerade NICHT weiterlaufen.
  let update = false;
  if (req.station.status !== 'gesperrt' && req.station.update_angefordert) {
    const r = await pool.query(
      `UPDATE stations SET update_angefordert = NULL, update_angefordert_von = NULL
        WHERE id = $1 AND update_angefordert IS NOT NULL RETURNING update_angefordert_von`,
      [req.station.id],
    );
    if (r.rows.length) {
      update = true;
      await ereignis(req.station.id, 'update-abgeholt', r.rows[0].update_angefordert_von,
        'Station hat die Aufforderung entgegengenommen');
    }
  }

  // Der Grund reist mit: die Station schreibt ihn in /etc/nologin, und wer
  // vor dem gesperrten Geraet steht, liest ihn dort statt nur "gesperrt".
  // Zuruecksetzen wird NICHT hier zurueckgesetzt, anders als beim Update.
  // Die Aufforderung bleibt stehen, bis die Station sich selbst abmeldet —
  // sonst waere sie nach dem ersten Lebenszeichen weg, und ein Neustart
  // mitten im Vorgang liesse die Station im alten Zustand zurueck.
  // SSH-Wartung: die Station oeffnet, solange hier etwas steht, und schliesst
  // beim ersten Lebenszeichen ohne. 'bis' als Epoch-Sekunden, die Station
  // rechnet damit expiry-time und Firewall-Timeout aus.
  let sshWartung = null;
  if (req.station.status !== 'gesperrt') {
    const offen = await wartungOffen(req.station.id);
    if (offen) {
      const k = await pool.query(
        'SELECT typ, blob_b64, kommentar FROM station_wartung_schluessel ORDER BY id');
      if (k.rows.length) {
        sshWartung = {
          bis: Math.floor(new Date(offen.bis).getTime() / 1000),
          von: offen.erteilt_von,
          schluessel: k.rows.map(alsZeile),
        };
      }
    }
  }

  res.json({
    ok: true,
    ssh_wartung: sshWartung,
    gesperrt: req.station.status === 'gesperrt',
    sperr_grund: req.station.status === 'gesperrt' ? (req.station.sperr_grund || null) : null,
    zuruecksetzen: !!req.station.zuruecksetzen_angefordert,
    update,
  });
}));

// POST /api/stations/:id/logs  { teile: { journal: "…", failed_units: "…", … } }
//
// Stationen sind von aussen nicht erreichbar — keine Firewall-Öffnung, SSH
// maskiert. Ohne diesen Weg kommt niemand an das Journal eines Geräts heran,
// ohne davorzusitzen. Genau das war der Grund, warum die Fehler vom 2. August
// so lange unbemerkt blieben.
//
// Die Station schickt mit ihrem eigenen Token; auf dem Gerät liegt dafür kein
// zusätzlicher Schlüssel. Der frühere Weg — git ins private Config-Repo mit
// einem Deploy-Key je Station — ist mit dem Repo entfallen.
//
// Bewusst kein Streaming und keine Datei: ein paar tausend Journal-Zeilen
// passen in eine Textspalte, und was älter ist als log_keep_days, fliegt beim
// nächsten Einsenden raus.
// 'update' ist der Update-Lauf allein — dieselben Zeilen stehen zwar auch im
// Journal, aber dort zwischen zweitausend anderen und über drei Neustarts
// verteilt. Wer wissen will, ob das Update durchging, soll einen Eintrag
// anklicken und nicht suchen.
const LOG_TEILE = ['journal', 'update', 'failed_units', 'status', 'state', 'gesundheit'];
const LOG_MAX_ZEICHEN = 200_000;   // je Teil, rund 2000 Journal-Zeilen
const LOG_MAX_EINSENDUNGEN = 24;   // je Station — bei stündlich rund ein Tag

// Kein eigener Body-Parser: server.js hat express.json({ limit: '10mb' })
// bereits global davor. Ein zweiter hier täte nichts — der Body ist längst
// gelesen — und täuschte ein Limit vor, das nicht gilt.
router.post('/:id/logs', stationAuth, a(async (req, res) => {
  const teile = req.body?.teile;
  if (!teile || typeof teile !== 'object' || Array.isArray(teile)) {
    return res.status(400).json({ error: 'Feld "teile" fehlt oder ist kein Objekt' });
  }

  const angenommen = [];
  for (const name of LOG_TEILE) {
    const roh = teile[name];
    if (roh === undefined || roh === null) continue;
    let text = typeof roh === 'string' ? roh : JSON.stringify(roh, null, 2);
    if (!text.trim()) continue;

    // Vorne kürzen, nicht hinten: das Neueste steht am Ende eines Journals,
    // und das ist das, weswegen jemand nachsieht.
    let gekuerzt = false;
    if (text.length > LOG_MAX_ZEICHEN) {
      text = text.slice(text.length - LOG_MAX_ZEICHEN);
      gekuerzt = true;
    }
    if (gekuerzt) text = `[… Anfang abgeschnitten, Grenze ${LOG_MAX_ZEICHEN} Zeichen …]\n${text}`;

    await pool.query(
      'INSERT INTO station_logs (station_id, teil, inhalt, bytes) VALUES ($1,$2,$3,$4)',
      [req.station.id, name, text, Buffer.byteLength(text, 'utf8')],
    );
    angenommen.push(name);
  }

  if (!angenommen.length) return res.status(400).json({ error: 'Keine verwertbaren Teile' });

  // Aufräumen beim Schreiben, nicht per Cron: so gibt es keinen zweiten Ort,
  // an dem etwas vergessen werden kann.
  const tage = Number(buildConfig(req.station)?.agent?.log_keep_days) || 14;
  await pool.query(
    `DELETE FROM station_logs
      WHERE station_id = $1
        AND (erstellt < NOW() - ($2 || ' days')::interval
             OR id NOT IN (SELECT id FROM station_logs WHERE station_id = $1
                            ORDER BY erstellt DESC LIMIT $3))`,
    [req.station.id, String(tage), LOG_MAX_EINSENDUNGEN * LOG_TEILE.length],
  ).catch((e) => console.error('[stations] Logs nicht aufgeräumt:', e.message));

  await pool.query('UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1',
    [req.station.id, clientIp(req)]);

  res.json({ ok: true, angenommen });
}));

// DELETE /api/stations/:id — die Station meldet sich selbst ab.
router.delete('/:id', stationAuth, a(async (req, res) => {
  await pool.query(
    `UPDATE stations SET revoked_at = NOW(), status = $2,
            zuruecksetzen_angefordert = NULL, zuruecksetzen_angefordert_von = NULL
      WHERE id = $1`,
    [req.station.id, 'abgemeldet']);
  await ereignis(req.station.id, 'abgemeldet', null, 'von der Station selbst');
  console.log(`[stations] '${req.station.id}' hat sich abgemeldet`);
  res.json({ ok: true });
}));

// Letzte Instanz: was hier ankommt, wäre sonst eine Anfrage ohne Antwort —
// der Installer stünde bis in seinen Timeout und wüsste nichts.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[stations] unbehandelt:', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Unerwarteter Fehler in der Stationsverwaltung' });
});

// Das Schema wird auch ausserhalb dieses Routers gebraucht: server.js fragt
// beim Notfall die Tabelle anzeigegeraete ab. Lief bis dahin keine
// Stationen-Route, gab es die Spalte alarm_zone noch nicht — am 6. August 2026
// stand deshalb ein echter Notfall auf keiner Tafel, und im Log stand nur
// 'column "alarm_zone" does not exist'. Deshalb hier herausgereicht, damit
// server.js es beim Start einmal anstossen kann.
router.ensureSchema = ensureSchema;
// server.js haengt die Tunnel-Route daneben — dort liegen wgControl und die
// Wohnungssuche. Die Pruefung des Einrichtungstokens gehoert aber hierher.
router.setupSession = setupSession;
router.appSession = appSession;
// Der Stationstoken gehoert dem GERAET. Er reicht nicht, um einen Tunnel
// anzulegen — dafuer braucht es die Person und ihre Wohnung —, wohl aber, um
// die eigenen Peers beim Abmelden zurueckzuziehen. Da ist niemand mehr
// angemeldet, den man fragen koennte, und ein Geraet darf abraeumen, was es
// selbst bekommen hat.
// POST /api/stations/:id/journal-zertifikat { csr } — Client-Zertifikat fuers
// Stationsjournal (systemd-journal-upload -> journal-remote, siehe
// journal-remote/README.md). Die Station schickt eine CSR mit ihrer ID als CN,
// die API signiert mit der Stations-CA (1 Jahr) und gibt Zertifikat, CA und
// Ziel-URL zurueck. Der private Schluessel verlaesst die Station nie.
const JOURNAL_CA_KEY = process.env.JOURNAL_CA_KEY || '/journal-tls/ca.key';
const JOURNAL_CA_CRT = process.env.JOURNAL_CA_CRT || '/journal-tls/ca.crt';
const JOURNAL_URL = process.env.JOURNAL_URL || '';
router.post('/:id/journal-zertifikat', stationAuth, a(async (req, res) => {
  const fs = require('fs/promises');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const run = (args, eingabe) => new Promise((ok, fehl) => {
    const p = execFile('openssl', args, { timeout: 20000 }, (e, out, err) => e ? fehl(new Error(String(err || e.message).trim())) : ok(out));
    if (eingabe !== undefined) p.stdin.end(eingabe);
  });

  if (!JOURNAL_URL) return res.status(503).json({ error: 'Stationsjournal ist nicht eingerichtet (JOURNAL_URL fehlt)' });
  try { await fs.access(JOURNAL_CA_KEY); } catch { return res.status(503).json({ error: 'Stations-CA fehlt' }); }
  const csr = String(req.body?.csr || '');
  if (!/^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/.test(csr) || csr.length > 8192) {
    return res.status(400).json({ error: 'Feld "csr" fehlt oder ist keine PEM-CSR' });
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-'));
  try {
    const csrDatei = path.join(dir, 'station.csr');
    await fs.writeFile(csrDatei, csr);
    // CSR pruefen: Signatur gueltig, CN genau die eigene Stations-ID.
    await run(['req', '-in', csrDatei, '-noout', '-verify']);
    const subject = await run(['req', '-in', csrDatei, '-noout', '-subject', '-nameopt', 'RFC2253']);
    const cn = (subject.match(/CN=([^,\n]+)/) || [])[1];
    if (cn !== req.station.id) {
      return res.status(400).json({ error: `CN der CSR muss "${req.station.id}" sein` });
    }
    const ext = path.join(dir, 'ext');
    await fs.writeFile(ext, 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature,keyEncipherment\n');
    const crt = path.join(dir, 'station.crt');
    await run(['x509', '-req', '-in', csrDatei, '-CA', JOURNAL_CA_CRT, '-CAkey', JOURNAL_CA_KEY,
      '-set_serial', '0x' + crypto.randomBytes(16).toString('hex'),
      '-days', '365', '-sha256', '-extfile', ext, '-out', crt]);
    const [zertifikat, ca] = await Promise.all([fs.readFile(crt, 'utf8'), fs.readFile(JOURNAL_CA_CRT, 'utf8')]);
    console.log(`[stations] Journal-Zertifikat fuer ${req.station.id} ausgestellt`);
    res.json({ zertifikat, ca, url: JOURNAL_URL });
  } catch (e) {
    console.error('[stations] Journal-Zertifikat:', e.message);
    res.status(400).json({ error: 'CSR nicht verwendbar' });
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}));

router.stationAuth = stationAuth;
// Für den Abgleich von Hand (Tests, Fehlersuche) — der Zyklus ruft ihn selbst.
router.anschlussAbgleichen = anschlussAbgleichen;

module.exports = router;
