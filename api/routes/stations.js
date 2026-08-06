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
//   Station selbst (Stationstoken)
//     GET    /api/stations/:id/config     Konfiguration abholen
//     POST   /api/stations/:id/seen       Lebenszeichen und Zustand melden
//     POST   /api/stations/:id/logs       Journal und Zustand einsenden
//     DELETE /api/stations/:id            sich selbst abmelden
//
//   Verwaltung (Anmeldung im Web, Gruppe technik)
//     GET    /api/stations/admin/list     alle Stationen mit Zustand
//     GET    /api/stations/admin/:id/logs      eingesandte Logs, ohne Inhalt
//     GET    /api/stations/admin/:id/logs/:logId   ein Log im Klartext
//     POST   /api/stations/admin/:id/update   Update anfordern
//     POST   /api/stations/admin/:id/block    sperren
//     POST   /api/stations/admin/:id/unblock  entsperren
//     DELETE /api/stations/admin/:id          endgültig entfernen
//
// Ablauf und Begründung: os-stationen/docs/installer.md
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { authenticateAD } = require('../lib/adauth');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik, isPraesident } = require('../lib/groups');
const { STATION_TYPES, buildConfig, missingSecrets, hausWlan } = require('../lib/stationconfig');
const { HAEUSER } = require('../lib/haeuser');
const { wlanAufloesen, netznamen } = require('../lib/stationwlan');
const { stationApps, gruppenJeApp } = require('../lib/stationapps');
const { telefonbuch } = require('../lib/telefonbuch');
const stationos = require('../lib/stationos');

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
    -- Aufforderung aus der Verwaltung: "aktualisiere dich beim naechsten
    -- Lebenszeichen". Eine Station ist von aussen nicht erreichbar, also kann
    -- man ihr nichts schicken — sie fragt alle paar Minuten selbst nach.
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS update_angefordert TIMESTAMPTZ;
    ALTER TABLE stations ADD COLUMN IF NOT EXISTS update_angefordert_von TEXT;
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
    CREATE TABLE IF NOT EXISTS station_setup_sessions (
      token_hash   TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      display_name TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL
    );
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
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function ereignis(stationId, art, wer, text) {
  return pool.query(
    'INSERT INTO station_events (station_id, art, wer, text) VALUES ($1,$2,$3,$4)',
    [stationId, art, wer || null, text || null],
  ).catch((e) => console.error('[stations] Ereignis nicht geschrieben:', e.message));
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip || req.socket?.remoteAddress || null;
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
router.post('/login', a(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzer und Passwort nötig' });

  let user;
  try {
    user = await authenticateAD(username, password);
  } catch (e) {
    console.error('[stations] AD nicht erreichbar:', e.message);
    return res.status(503).json({ error: 'Verzeichnisdienst nicht erreichbar' });
  }
  if (!user) return res.status(401).json({ error: 'Benutzer oder Passwort stimmt nicht' });

  const fehlt = missingSecrets();
  if (fehlt.length) {
    console.error('[stations] Umgebung unvollständig:', fehlt.join(', '));
    return res.status(500).json({ error: `Server unvollständig konfiguriert: ${fehlt.join(', ')}` });
  }

  await ensureSchema();
  const token = newToken(SETUP_PREFIX);
  await pool.query(
    `INSERT INTO station_setup_sessions (token_hash, username, display_name, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)`,
    [sha256(token), user.username, user.displayName, String(SETUP_TTL_MINUTES)],
  );
  res.json({
    token,
    expires_in: SETUP_TTL_MINUTES * 60,
    user: { name: user.displayName, username: user.username },
  });
}));

// GET /api/stations/types
router.get('/types', setupSession, (req, res) => res.json({ types: STATION_TYPES }));

// ─── Versionen des Stations-Betriebssystems ─────────────────────────
// MUSS vor den /:id-Routen stehen.

// POST /api/stations/os — neue Version veroeffentlichen (Technik).
// Der Tarball kommt roh im Koerper; Version und Kanal als Kopfzeilen.
router.post('/os', express.raw({ type: '*/*', limit: '64mb' }),
  appSession, darfOsVeroeffentlichen, a(async (req, res) => {
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
           gesperrt_am, hardware, registered_by, registered_at,
           last_seen_at, last_seen_ip, last_state, revoked_at,
           update_angefordert, update_angefordert_von, overrides,
           programme, programme_gemeldet_am, haus
      FROM stations
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
    types: STATION_TYPES,
    // Die Hausvorgabe zum WLAN. Ohne sie sähe die Verwaltung nur die
    // stationseigene Ebene — also ein leeres Feld — und jemand trüge das Netz
    // ein zweites Mal ein, obwohl es längst für alle gilt.
    haus_wlan: hausWlan(),
    // Die Netze aus UniFi, nur die Namen — damit die Verwaltung eine Auswahl
    // anbieten kann statt eines Textfelds, in das jemand einen Schlüssel
    // tippt, den es längst gibt.
    wlan_netze: await netznamen(),
  });
}));

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
router.post('/admin/:id/update', authMiddleware, nurTechnik, a(async (req, res) => {
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
      'Zurück in dieser Übersicht prüfen, ob das Gerät sich meldet.',
    ],
    hinweisAdresse: 'Diese Adresse gehört in die .url-Datei, die das Gerät anzeigt.',
    hinweis: 'Das Passwort steht nur hier. Es wird nirgends gespeichert — nur seine Prüfsumme. '
           + 'Geht es verloren, legen Sie das Gerät neu an.',
    steuerung: {
      thema: `${ANZEIGE_TOPIC_PREFIX}/REQ/${mqtt_thema}/API`,
      antwort: `${ANZEIGE_TOPIC_PREFIX}/RESP/${mqtt_thema}/API`,
      beispiel: { operation: 'playlist/set', zoneName: 'Whole screen', playlist: 'Alarm' },
    },
  };
}

// GET /api/stations/admin/anzeigen
router.get('/admin/anzeigen', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    `SELECT id, name, standort, notiz, mqtt_thema, mqtt_benutzer, haus, angelegt_von, angelegt_am
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

router.post('/admin/:id/block', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const grund = (req.body?.grund || '').trim() || null;
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET status='gesperrt', sperr_grund=$2, gesperrt_von=$3, gesperrt_am=NOW()
      WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
    [req.params.id, grund, wer],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'gesperrt', wer, grund);
  console.log(`[stations] '${req.params.id}' gesperrt von ${wer}${grund ? ` (${grund})` : ''}`);
  res.json({ ok: true });
}));

// POST /api/stations/admin/:id/unblock
router.post('/admin/:id/unblock', authMiddleware, nurTechnik, a(async (req, res) => {
  await ensureSchema();
  const wer = req.user?.email || req.user?.name || 'unbekannt';
  const r = await pool.query(
    `UPDATE stations SET status='aktiv', sperr_grund=NULL, gesperrt_von=NULL, gesperrt_am=NULL
      WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
    [req.params.id],
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Station nicht gefunden' });
  await ereignis(req.params.id, 'entsperrt', wer, null);
  res.json({ ok: true });
}));

// DELETE /api/stations/admin/:id — endgültig entfernen. Das Token der Station
// ist danach wertlos; das Gerät fällt beim nächsten Lauf auf.
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

  let user;
  try {
    user = await authenticateAD(username, password);
  } catch (e) {
    console.error('[stations] AD nicht erreichbar:', e.message);
    return res.status(503).json({ error: 'Verzeichnisdienst nicht erreichbar' });
  }
  if (!user) return res.status(401).json({ error: 'Benutzer oder Passwort stimmt nicht' });

  await ensureSchema();
  const token = newToken(APP_PREFIX);
  await pool.query(
    `INSERT INTO station_app_sessions (token_hash, username, display_name, groups_json, station_id, expires_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' days')::interval)`,
    [sha256(token), user.username, user.displayName, JSON.stringify(user.groups || []),
      station_id || null, String(APP_TTL_TAGE)],
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
                           registered_by, last_seen_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       role = EXCLUDED.role, hostname = EXCLUDED.hostname,
       standort = EXCLUDED.standort, notiz = EXCLUDED.notiz, haus = EXCLUDED.haus,
       token_hash = EXCLUDED.token_hash, hardware = EXCLUDED.hardware,
       registered_by = EXCLUDED.registered_by, last_seen_ip = EXCLUDED.last_seen_ip,
       registered_at = NOW(), revoked_at = NULL, status = 'aktiv',
       sperr_grund = NULL, gesperrt_von = NULL, gesperrt_am = NULL,
       last_seen_at = NULL, last_state = NULL
     WHERE stations.revoked_at IS NOT NULL
     RETURNING id`,
    [row.id, row.role, row.hostname, row.standort, row.notiz, row.haus, sha256(token),
      JSON.stringify(hardware || {}), req.setupUser.username, clientIp(req)],
  );
  if (!eingefuegt.rows.length) {
    return res.status(409).json({ error: `Station '${id}' gibt es schon` });
  }
  await ereignis(id, 'registriert', req.setupUser.username, `${type} · ${row.standort}`);

  console.log(`[stations] '${id}' (${type}) registriert von ${req.setupUser.username}`);
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
  res.json({ apps: await gruppenJeApp(pool) });
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

  res.json({ ok: true, gesperrt: req.station.status === 'gesperrt', update });
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
  await pool.query('UPDATE stations SET revoked_at = NOW(), status = $2 WHERE id = $1',
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

module.exports = router;
