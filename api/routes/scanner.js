// ═══════════════════════════════════════════════════════════════════
// SCANNER — eigenes AD-Konto je allgemeinem Scanner, Passwort per Zettel
// (Seite scanner.html, Technik/Präsident wie /stationen und /sicherungen)
//
//   GET  /api/scanner                          Geräte, wann zuletzt gesetzt, Protokoll
//   POST /api/scanner/:id/passwort-drucken     neues Passwort erzeugen, Zettel auf
//                                              DruckerR9 drucken, im AD setzen
//
// Das Passwort verlässt die API nur zweimal: als PDF an die Druck-API
// (CT 111) und an die Passwort-API auf dc1. Es geht nie an den Browser,
// steht in keiner Tabelle und in keiner Logzeile. Ins Protokoll kommt nur,
// wer wann für welchen Scanner gedruckt hat und wie es ausging.
//
// Reihenfolge mit Absicht: erst drucken, dann im AD setzen. Scheitert der
// Druck, ist nichts geändert und das Gerät scannt weiter. Scheitert danach
// das AD, liegt ein ungültiger Zettel im Drucker (die Seite sagt: vernichten),
// das Gerät scannt aber ebenfalls weiter. Andersherum stünde das Gerät still,
// bis jemand den Knopf nochmals drückt.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { pool: dbPool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const kartenAdmin = require('../lib/kartenadmin'); // Admin-Aktionen mit der Karte
const { isTechnik, isPraesident } = require('../lib/groups');
const druckApi = require('../lib/druckapi');
const adPasswort = require('../lib/adpasswort');
const S = require('../lib/scanner');

const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

let pool = dbPool;
let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_passwort_protokoll (
      id          BIGSERIAL PRIMARY KEY,
      scanner_id  TEXT NOT NULL,
      konto       TEXT NOT NULL,
      email       TEXT,
      name        TEXT,
      art         TEXT,
      ergebnis    TEXT NOT NULL,
      detail      TEXT,
      zeit        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS scanner_passwort_protokoll_scanner ON scanner_passwort_protokoll (scanner_id, zeit DESC);
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/** Was fehlt, damit der Knopf geht — nur Namen, nie Werte. */
function einrichtung() {
  const fehlt = [];
  if (!adPasswort.eingerichtet()) fehlt.push('AD_PASSWORD_API_SECRET');
  if (!druckApi.eingerichtet()) fehlt.push('PRINT_API_SECRET');
  return fehlt;
}

// ─── Router ────────────────────────────────────────────────────────

function nurTechnik(req, res, next) {
  const g = req.user?.groups || [];
  if (!(req.user?.isAdmin || isTechnik(g) || isPraesident(g))) return res.status(403).json({ error: 'Nur die Technik verwaltet die Scanner-Konten' });
  kartenAdmin.vermerken(req, res); // mit der Karte: Protokoll + Quittung
  next();
}

const laufend = new Set(); // je Scanner höchstens ein Druck gleichzeitig

function scannerRouter(deps = {}) {
  if (deps.pool) pool = deps.pool;
  const semaphore = deps.gotenbergSemaphore || null;
  const rateLimitGuard = deps.rateLimitGuard || (() => ({ ok: true }));
  const fehlerListe = S.listePruefen();
  if (fehlerListe.length) console.error('[scanner] Geräteliste fehlerhaft:', fehlerListe.join('; '));

  const router = express.Router();
  router.use(authMiddleware, nurTechnik);
  router.use(a(async (req, res, next) => { await ensureSchema(); next(); }));

  router.get('/', a(async (req, res) => {
    const { rows: letzte } = await pool.query(`
      SELECT DISTINCT ON (scanner_id) scanner_id, zeit, name, email
        FROM scanner_passwort_protokoll WHERE ergebnis = 'ok'
       ORDER BY scanner_id, zeit DESC`);
    const { rows: protokoll } = await pool.query(`
      SELECT scanner_id, konto, name, email, art, ergebnis, zeit
        FROM scanner_passwort_protokoll ORDER BY zeit DESC LIMIT 30`);
    const je = new Map(letzte.map(z => [z.scanner_id, z]));
    res.json({
      drucker: S.ZETTEL_DRUCKER,
      ziel: { server: S.ZIEL.server, servername: S.ZIEL.servername, freigabe: S.ZIEL.freigabe },
      fehlt: einrichtung(),
      scanner: S.SCANNER.map(s => {
        const z = je.get(s.id);
        return {
          id: s.id, name: s.name, modell: s.modell, standort: s.standort, ip: s.ip, konto: s.konto,
          gesetzt: z ? { zeit: z.zeit, von: z.name || z.email || '' } : null,
        };
      }),
      protokoll,
    });
  }));

  router.post('/:id/passwort-drucken', a(async (req, res) => {
    const scanner = S.scannerFinden(req.params.id);
    if (!scanner) return res.status(404).json({ error: 'Diesen Scanner gibt es nicht' });
    const fehlt = einrichtung();
    if (fehlt.length) return res.status(503).json({ error: `Auf dem Server fehlt: ${fehlt.join(', ')}` });
    if (laufend.has(scanner.id)) return res.status(409).json({ error: 'Für diesen Scanner wird gerade gedruckt' });
    const rl = rateLimitGuard('scanner-passwort', scanner.id, 6, 60 * 60 * 1000);
    if (!rl.ok) return res.status(429).json({ error: `Zu viele Zettel für ${scanner.name}. Bitte in ${Math.ceil((rl.retryAfter || 60) / 60)} Min. nochmals.` });

    laufend.add(scanner.id);
    try {
      const wer = { email: req.user?.email || '', name: req.user?.name || '', art: req.auth?.art || 'website' };
      const r = await S.passwortDrucken(scanner, wer, {
        htmlZuPdf: (html) => druckApi.htmlZuPdf(html, { semaphore }),
        drucken: (drucker, pdf, name) => druckApi.drucken(drucker, pdf, name),
        adSetzen: (konto, pw) => adPasswort.setzen(konto, pw),
        protokollieren: (z) => pool.query(
          `INSERT INTO scanner_passwort_protokoll (scanner_id, konto, email, name, art, ergebnis, detail, zeit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [z.scanner_id, z.konto, z.email, z.name, z.art, z.ergebnis, z.detail, z.zeit]),
      });
      console.log(`[scanner] ${scanner.konto}: ${r.ergebnis} (ausgelöst von ${wer.email || '?'}, ${wer.art})`);
      res.status(r.status).json({ ok: r.ergebnis === 'ok', ergebnis: r.ergebnis, meldung: r.meldung });
    } finally {
      laufend.delete(scanner.id);
    }
  }));

  return router;
}

module.exports = { scannerRouter, ensureSchema, einrichtung };
