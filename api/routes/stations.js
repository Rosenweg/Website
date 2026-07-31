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
//     DELETE /api/stations/:id            sich selbst abmelden
//
//   Verwaltung (Anmeldung im Web, Gruppe technik)
//     GET    /api/stations/admin/list     alle Stationen mit Zustand
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
const { STATION_TYPES, buildConfig, missingSecrets } = require('../lib/stationconfig');

const router = express.Router();

const SETUP_TTL_MINUTES = 30;
const SETUP_PREFIX = 'rw_setup_';
const STATION_PREFIX = 'rw_station_';

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
    CREATE TABLE IF NOT EXISTS station_setup_sessions (
      token_hash   TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      display_name TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
router.post('/login', async (req, res) => {
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
});

// GET /api/stations/types
router.get('/types', setupSession, (req, res) => res.json({ types: STATION_TYPES }));

// ─── Verwaltung ─────────────────────────────────────────────────────
// MUSS vor den /:id-Routen stehen, sonst frisst ':id' das 'admin'.

// GET /api/stations/admin/list
router.get('/admin/list', authMiddleware, nurTechnik, async (req, res) => {
  await ensureSchema();
  const r = await pool.query(`
    SELECT id, role, hostname, standort, notiz, status, sperr_grund, gesperrt_von,
           gesperrt_am, hardware, registered_by, registered_at,
           last_seen_at, last_seen_ip, last_state, revoked_at
      FROM stations
     ORDER BY (revoked_at IS NOT NULL), registered_at DESC`);
  res.json({ stations: r.rows, types: STATION_TYPES });
});

// GET /api/stations/admin/:id/events
router.get('/admin/:id/events', authMiddleware, nurTechnik, async (req, res) => {
  await ensureSchema();
  const r = await pool.query(
    'SELECT art, wer, text, erstellt FROM station_events WHERE station_id = $1 ORDER BY erstellt DESC LIMIT 100',
    [req.params.id],
  );
  res.json({ events: r.rows });
});

// POST /api/stations/admin/:id/block  { grund }
router.post('/admin/:id/block', authMiddleware, nurTechnik, async (req, res) => {
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
});

// POST /api/stations/admin/:id/unblock
router.post('/admin/:id/unblock', authMiddleware, nurTechnik, async (req, res) => {
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
});

// DELETE /api/stations/admin/:id — endgültig entfernen. Das Token der Station
// ist danach wertlos; das Gerät fällt beim nächsten Lauf auf.
router.delete('/admin/:id', authMiddleware, nurTechnik, async (req, res) => {
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
});

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
router.post('/register', setupSession, async (req, res) => {
  const { type, standort, notiz, hardware } = req.body || {};
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

  await pool.query(
    `INSERT INTO stations (id, role, hostname, standort, notiz, token_hash, hardware,
                           registered_by, last_seen_ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.id, row.role, row.hostname, row.standort, row.notiz, sha256(token),
      JSON.stringify(hardware || {}), req.setupUser.username, clientIp(req)],
  );
  await ereignis(id, 'registriert', req.setupUser.username, `${type} · ${row.standort}`);

  console.log(`[stations] '${id}' (${type}) registriert von ${req.setupUser.username}`);
  res.status(201).json({ station_id: id, station_token: token, config: buildConfig(row) });
});

// ─── Betrieb (Station selbst) ───────────────────────────────────────

// GET /api/stations/:id/config
router.get('/:id/config', stationAuth, async (req, res) => {
  await pool.query('UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1',
    [req.station.id, clientIp(req)]);
  res.json(buildConfig(req.station));
});

// POST /api/stations/:id/seen  { state }
//
// Das ist die Rückmeldung, von der die Verwaltung lebt: was für ein Gerät,
// welche Rolle, welche Version, hat die Einrichtung geklappt.
router.post('/:id/seen', stationAuth, async (req, res) => {
  const state = req.body?.state || {};
  await pool.query(
    'UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $3, last_state = $2 WHERE id = $1',
    [req.station.id, JSON.stringify(state), clientIp(req)],
  );
  if (state.ereignis) {
    await ereignis(req.station.id, String(state.ereignis).slice(0, 40), null,
      state.text ? String(state.text).slice(0, 500) : null);
  }
  res.json({ ok: true, gesperrt: req.station.status === 'gesperrt' });
});

// DELETE /api/stations/:id — die Station meldet sich selbst ab.
router.delete('/:id', stationAuth, async (req, res) => {
  await pool.query('UPDATE stations SET revoked_at = NOW(), status = $2 WHERE id = $1',
    [req.station.id, 'abgemeldet']);
  await ereignis(req.station.id, 'abgemeldet', null, 'von der Station selbst');
  console.log(`[stations] '${req.station.id}' hat sich abgemeldet`);
  res.json({ ok: true });
});

module.exports = router;
