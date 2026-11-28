// ═══════════════════════════════════════════════════════════════════
// EMAIL ARCHIVE (4-Augen Löschprinzip)
// Aus server.js ausgelagert (Router-Split).
//
// Entscheide Stefan 28.11.2026 (Klaerung Mail-Archiv):
//  - STWEG-Bindung: Spalte stweg ('1'…'8' oder 'haus'). Ausschuss und
//    Verwaltung lesen ihre STWEG plus 'haus', Technik/Praesident alles; dazu
//    das Seitenrecht „email-archiv“ (lib/email-archiv-rechte.js).
//  - Vier-Augen: andere Konto-ID, aus derselben STWEG oder Technik/Praesident.
//  - Loeschen leert auch Betreff, Absender und Empfaenger; Fehler beim
//    Entfernen der Dateien werden protokolliert und spaeter erneut versucht;
//    die antragstellende Person bekommt eine Mitteilung (ohne Betreff).
//  - Zugriffsprotokoll: Lesen, Anhang, Suche, Export (auch MCP/Token).
//  - Aufbewahrung: nach 10 Jahren anonymisiert ein taeglicher Lauf.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fsSync = require('fs');
const fs = require('fs').promises;
const pathModule = require('path');
const { pool } = require('../lib/db');
const { authMiddleware, requirePermission, absenderIp } = require('../middleware/auth');
const { isTechnik, isPraesident } = require('../lib/groups');
const regeln = require('../lib/email-archiv-rechte');

const router = express.Router();

// DOCS_PATH ist SHARED (auch von documents-Routes genutzt) — Router definiert
// hier seine eigene, identische Konstante.
const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const ARCHIV_DIR = pathModule.resolve(DOCS_PATH, 'archiv');
const SITE_URL = process.env.SITE_URL || 'https://www.rosenweg4303.ch';

// ─── Schema / Migration ─────────────────────────────────────────────
const SQL_SCHEMA = `
  ALTER TABLE email_archive ADD COLUMN IF NOT EXISTS stweg VARCHAR(10);
  ALTER TABLE email_archive ADD COLUMN IF NOT EXISTS anonymisiert_am TIMESTAMPTZ;
  ALTER TABLE email_archive ADD COLUMN IF NOT EXISTS offene_dateien JSONB;
  ALTER TABLE email_archive ALTER COLUMN from_email DROP NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_email_archive_stweg_datum ON email_archive(stweg, email_date DESC);
  ALTER TABLE email_archive_deletions ADD COLUMN IF NOT EXISTS requested_by_id INTEGER;
  ALTER TABLE email_archive_deletions ADD COLUMN IF NOT EXISTS confirmed_by_id INTEGER;
  ALTER TABLE email_archive_deletions ADD COLUMN IF NOT EXISTS antrag_stwegs TEXT[];
  UPDATE email_archive_deletions d SET requested_by_id = u.id FROM users u
    WHERE d.requested_by_id IS NULL AND LOWER(u.email) = LOWER(d.requested_by);
  UPDATE email_archive_deletions d SET confirmed_by_id = u.id FROM users u
    WHERE d.confirmed_by_id IS NULL AND d.confirmed_by IS NOT NULL AND LOWER(u.email) = LOWER(d.confirmed_by);
  CREATE TABLE IF NOT EXISTS email_archive_zugriffe (
    id BIGSERIAL PRIMARY KEY,
    zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    aktion VARCHAR(30) NOT NULL,
    archive_id INTEGER,
    detail TEXT,
    user_id INTEGER,
    email VARCHAR(255),
    weg VARCHAR(40),
    token_id INTEGER,
    ip VARCHAR(64)
  );
  CREATE INDEX IF NOT EXISTS idx_email_archive_zugriffe_zeit ON email_archive_zugriffe(zeit DESC);
  CREATE INDEX IF NOT EXISTS idx_email_archive_zugriffe_mail ON email_archive_zugriffe(archive_id, zeit DESC);`;

// STWEG aus den Empfaengern (Verteiler-Adressen): genau eine STWEG = diese,
// sonst 'haus'. Gleiche Regel wie regeln.stwegAusAdressen, hier in SQL fuer
// den Altbestand und jede neue Mail (stweg IS NULL).
const SQL_STWEG_ZUORDNEN = `
  UPDATE email_archive a SET stweg = COALESCE((
    SELECT CASE WHEN COUNT(DISTINCT v.stweg) = 1 THEN MIN(v.stweg)::text END
      FROM email_verteiler v
     WHERE v.stweg > 0 AND COALESCE(TRIM(v.email_address), '') <> ''
       AND LOWER(TRIM(v.email_address)) = ANY(
         SELECT LOWER(TRIM(regexp_replace(x, '^.*<([^>]+)>.*$', '\\1')))
           FROM regexp_split_to_table(COALESCE(a.to_addresses, ''), '[,;]') AS x)
  ), 'haus')
  WHERE a.stweg IS NULL`;

async function schemaSicherstellen(db) {
  await db.query(SQL_SCHEMA);
  const r = await db.query(SQL_STWEG_ZUORDNEN);
  if (r.rowCount) console.log(`[email-archive] STWEG zugeordnet: ${r.rowCount} Mail(s)`);
}

/** Neue Mails (stweg leer) zuordnen; nach jedem Archivieren aufrufen. */
async function stwegZuordnen(db = pool) {
  return db.query(SQL_STWEG_ZUORDNEN).catch(e => console.error('[email-archive] STWEG-Zuordnung:', e.message));
}

// ─── Zugriffsprotokoll ──────────────────────────────────────────────
async function protokoll(req, aktion, archiveId, detail) {
  await pool.query(
    `INSERT INTO email_archive_zugriffe (aktion, archive_id, detail, user_id, email, weg, token_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [aktion, archiveId || null, detail == null ? null : String(detail).slice(0, 1000),
     req.user?.id ?? null, String(req.user?.email || '').toLowerCase().slice(0, 255) || null,
     regeln.zugriffsWeg(req), req.pat?.id ?? null, String(absenderIp(req) || '').slice(0, 64) || null]);
}

// ─── Zugang ─────────────────────────────────────────────────────────
// Seitenrecht „email-archiv“ (Technik/Praesident immer) und Ausschuss bzw.
// Verwaltung einer STWEG. req.archivStwegs: null = alles, sonst Liste.
const seitenRecht = requirePermission('email-archiv', 'read');
function requireArchiveAccess(req, res, next) {
  seitenRecht(req, res, () => {
    const s = regeln.leseStwegs(req.user?.groups || []);
    if (Array.isArray(s) && !s.length) return res.status(403).json({ error: 'Kein Zugriff auf das E-Mail-Archiv' });
    req.archivStwegs = s;
    next();
  });
}
const istAdmin = (req) => isTechnik(req.user?.groups || []) || isPraesident(req.user?.groups || []);

/** WHERE-Teil fuer die STWEG-Sicht; haengt den Parameter an params an. */
function stwegFilter(req, params, spalte = 'stweg') {
  if (req.archivStwegs === null) return 'TRUE';
  params.push(req.archivStwegs);
  return `COALESCE(${spalte}, 'haus') = ANY($${params.length}::text[])`;
}

function suchFilter(search, params) {
  if (!search) return 'TRUE';
  params.push(regeln.likeMuster(search));
  const p = `$${params.length}`;
  return `(subject ILIKE ${p} ESCAPE '\\' OR from_email ILIKE ${p} ESCAPE '\\' OR from_name ILIKE ${p} ESCAPE '\\')`;
}

// GET /api/email-archive - List archived emails with search & pagination
router.get('/', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 200);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const params = [];
    const where = `deletion_status != 'deleted' AND ${stwegFilter(req, params)} AND ${suchFilter(search, params)}`;

    const countRes = await pool.query(`SELECT COUNT(*) FROM email_archive WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    // Suchen ist ein Zugriff (F5); blosses Blaettern ohne Suchtext nicht.
    if (search && page === 1) await protokoll(req, 'suche', null, `${search} (${total} Treffer)`);

    params.push(limit, offset);
    const dataRes = await pool.query(
      `SELECT id, from_email, from_name, subject, email_date, created_at, attachments, deletion_status, stweg
       FROM email_archive WHERE ${where}
       ORDER BY email_date DESC NULLS LAST, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ emails: dataRes.rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Email archive list error:', err.message);
    res.status(500).json({ error: 'Fehler beim Laden des Archivs' });
  }
});

// GET /api/email-archive/export - Excel-Export der (gesuchten) Liste, ohne Mailtext (L3)
const EXPORT_MAX = 10000;
router.get('/export', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 200);
    const params = [];
    const where = `deletion_status != 'deleted' AND ${stwegFilter(req, params)} AND ${suchFilter(search, params)}`;
    params.push(EXPORT_MAX);
    const r = await pool.query(
      `SELECT id, email_date, stweg, from_email, from_name, to_addresses, subject, attachments, deletion_status, message_id
         FROM email_archive WHERE ${where}
        ORDER BY email_date DESC NULLS LAST, created_at DESC LIMIT $${params.length}`, params);
    await protokoll(req, 'export', null, `${r.rows.length} Zeilen${search ? `, Suche: ${search}` : ''}`);
    res.json({ zeilen: r.rows.map(regeln.exportZeile), gekuerzt: r.rows.length >= EXPORT_MAX });
  } catch (err) {
    console.error('Email archive export error:', err.message);
    res.status(500).json({ error: 'Fehler beim Export' });
  }
});

// GET /api/email-archive/protokoll - Zugriffsprotokoll (nur Technik/Praesident)
router.get('/protokoll', authMiddleware, requireArchiveAccess, async (req, res) => {
  if (!istAdmin(req)) return res.status(403).json({ error: 'Nur Technik/Präsident' });
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 200));
    const id = parseInt(req.query.archive_id, 10);
    const params = [limit];
    let where = 'TRUE';
    if (Number.isFinite(id)) { params.push(id); where = 'archive_id = $2'; }
    const r = await pool.query(
      `SELECT zeit, aktion, archive_id, detail, email, weg, token_id FROM email_archive_zugriffe
        WHERE ${where} ORDER BY zeit DESC, id DESC LIMIT $1`, params);
    res.json({ eintraege: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden des Protokolls' });
  }
});

// GET /api/email-archive/delete-requests - List pending deletion requests
router.get('/delete-requests', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const params = [];
    const result = await pool.query(
      `SELECT d.id, d.archive_id, d.requested_by, d.requested_by_id, d.requested_at, d.reason, d.status, d.antrag_stwegs,
              a.subject, a.from_email, a.from_name, a.email_date, a.stweg
       FROM email_archive_deletions d
       JOIN email_archive a ON a.id = d.archive_id
       WHERE d.status = 'pending' AND a.deletion_status != 'deleted' AND ${stwegFilter(req, params, 'a.stweg')}
       ORDER BY d.requested_at DESC`, params
    );
    const requests = result.rows.map(r => {
      const e = regeln.darfEntscheiden(req.user, r, r.stweg);
      return { ...r, eigener_antrag: e.grund === 'eigener-antrag', darf_entscheiden: e.ok };
    });
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Löschanträge' });
  }
});

async function mailLesen(req, id, spalten = 'a.*') {
  const params = [id];
  const r = await pool.query(
    `SELECT ${spalten} FROM email_archive a
      WHERE a.id = $1 AND a.deletion_status != 'deleted' AND ${stwegFilter(req, params, 'a.stweg')}`, params);
  return r.rows[0] || null;
}

// GET /api/email-archive/:id - Single email detail
router.get('/:id', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const mail = await mailLesen(req, id);
    if (!mail) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    const d = await pool.query(
      `SELECT id, requested_by, requested_by_id, reason, status, antrag_stwegs FROM email_archive_deletions
        WHERE archive_id = $1 AND status = 'pending'`, [id]);
    await protokoll(req, 'lesen', id, null);
    delete mail.offene_dateien;
    const antrag = d.rows[0];
    const out = { ...mail, deletion_id: null, requested_by: null, reason: null, deletion_request_status: null };
    if (antrag) {
      const e = regeln.darfEntscheiden(req.user, antrag, mail.stweg);
      Object.assign(out, {
        deletion_id: antrag.id, requested_by: antrag.requested_by, reason: antrag.reason,
        deletion_request_status: antrag.status, eigener_antrag: e.grund === 'eigener-antrag', darf_entscheiden: e.ok,
      });
    }
    out.darf_loeschantrag = regeln.darfLoeschweg(req.user?.groups || []);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der E-Mail' });
  }
});

/** Pfad einer gespeicherten Datei im Archiv-Ordner, oder null (Ausbruch). */
function archivPfad(storedName) {
  const p = pathModule.resolve(ARCHIV_DIR, String(storedName || ''));
  const rel = pathModule.relative(ARCHIV_DIR, p);
  if (!rel || rel.startsWith('..') || pathModule.isAbsolute(rel)) return null;
  return p;
}

// GET /api/email-archive/:id/attachment/:filename - Download attachment
router.get('/:id/attachment/:filename', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const mail = await mailLesen(req, id, 'a.attachments');
    if (!mail) return res.status(404).json({ error: 'E-Mail nicht gefunden' });

    const attachments = mail.attachments || [];
    const att = attachments.find(a => a.stored_name === req.params.filename || a.filename === req.params.filename);
    if (!att) return res.status(404).json({ error: 'Anhang nicht gefunden' });

    const filePath = archivPfad(att.stored_name);
    if (!filePath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await protokoll(req, 'anhang', id, att.filename || att.stored_name);

    const safeAttName = (att.filename || 'attachment').replace(/["\r\n\\]/g, '_');
    const safeAttAscii = safeAttName.replace(/[^\x20-\x7E]/g, '_');
    // Der Typ stammt aus der eingegangenen Mail, also vom Absender. Ein
    // image/svg+xml oder text/html liefe im Browser als Skript unter unserer
    // Herkunft (Blob-URL im neuen Tab) — darum nur bekannte, passive Typen.
    const ERLAUBTE_TYPEN = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
    const typ = String(att.content_type || '').split(';')[0].trim().toLowerCase();
    res.setHeader('Content-Type', ERLAUBTE_TYPEN.has(typ) ? typ : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${safeAttAscii}"; filename*=UTF-8''${encodeURIComponent(safeAttName)}`);
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Datei nicht gefunden' }); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Download' });
  }
});

// Hoechstens ein offener Loeschantrag je E-Mail, auch bei parallelen Anfragen.
// Einmalig angelegt; scheitert es (z.B. Altbestand mit Doppelten), bleibt die
// atomare Statusumstellung unten als Schutz.
let pendingIndexBereit = null;
function pendingIndexSicherstellen() {
  if (!pendingIndexBereit) {
    pendingIndexBereit = pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_archive_deletions_pending ON email_archive_deletions(archive_id) WHERE status = 'pending'"
    ).catch(e => console.warn('[email-archive] Unique-Index pending:', e.message));
  }
  return pendingIndexBereit;
}

// POST /api/email-archive/:id/delete-request - Request deletion (4-Augen step 1)
router.post('/:id/delete-request', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    if (!regeln.darfLoeschweg(req.user?.groups || [])) return res.status(403).json({ error: 'Löschanträge nur durch Ausschuss, Technik oder Präsident' });
    if (req.user?.id == null) return res.status(403).json({ error: 'Löschantrag nur mit Rosenweg-Konto' });
    const { reason } = req.body || {};
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'Begründung erforderlich' });
    const mail = await mailLesen(req, id, 'a.id, a.stweg');
    if (!mail) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    await pendingIndexSicherstellen();

    // Status atomar von 'active' auf 'pending' umstellen: nur eine von mehreren
    // gleichzeitigen Anfragen gewinnt, es entsteht kein zweiter offener Antrag.
    const email = await pool.query(
      "UPDATE email_archive SET deletion_status = 'pending' WHERE id = $1 AND deletion_status = 'active' RETURNING id", [id]
    );
    if (email.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden oder bereits in Löschung' });

    // Check no pending request exists
    const existing = await pool.query(
      "SELECT id FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [id]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });

    try {
      await pool.query(
        `INSERT INTO email_archive_deletions (archive_id, requested_by, requested_by_id, reason, antrag_stwegs) VALUES ($1, $2, $3, $4, $5)`,
        [id, req.user.email, req.user.id, String(reason).trim().slice(0, 2000), regeln.antragStwegs(req.user.groups, mail.stweg)]
      );
    } catch (e) {
      // Antrag nicht angelegt -> Status zuruecksetzen, sonst haengt die Mail in 'pending'.
      await pool.query("UPDATE email_archive SET deletion_status = 'active' WHERE id = $1 AND deletion_status = 'pending' AND NOT EXISTS (SELECT 1 FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending')", [id]).catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });
      throw e;
    }
    await protokoll(req, 'loeschantrag', id, String(reason).trim().slice(0, 500));

    res.json({ success: true, message: 'Löschantrag erstellt. Eine zweite Person muss bestätigen.' });
  } catch (err) {
    console.error('Delete request error:', err.message);
    res.status(500).json({ error: 'Fehler beim Erstellen des Löschantrags' });
  }
});

/**
 * Dateien einer Mail entfernen. Fehlende Dateien (ENOENT) gelten als entfernt;
 * andere Fehler werden gemeldet und als offene Dateien zurueckgegeben (der
 * Aufraeumlauf versucht es erneut).
 */
async function dateienEntfernen(attachments, kontext) {
  const offen = [];
  for (const att of attachments || []) {
    const p = archivPfad(att && att.stored_name);
    if (!p) { console.error(`[email-archive] ${kontext}: ungültiger Dateiname im Anhang übersprungen`); continue; }
    try { await fs.unlink(p); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      console.error(`[email-archive] ${kontext}: Datei ${att.stored_name} nicht entfernt: ${e.message}`);
      offen.push({ stored_name: att.stored_name, fehler: String(e.code || e.message).slice(0, 100) });
    }
  }
  return offen;
}

// Was beim Loeschen bzw. Anonymisieren aus der Mail verschwindet (F4).
const SQL_LEEREN = `deletion_status = 'deleted', subject = NULL, from_email = NULL, from_name = NULL,
  to_addresses = NULL, text_body = NULL, html_body = NULL, attachments = '[]'`;

async function mitteilen(antrag, entscheid) {
  try {
    const u = antrag.requested_by_id != null
      ? (await pool.query('SELECT email FROM users WHERE id = $1', [antrag.requested_by_id])).rows[0] : null;
    const an = (u && u.email) || antrag.requested_by;
    if (!an) return;
    // Nie Betreff oder Absender in die Meldung (Sperrbildschirm).
    await require('../lib/webpush').sendToEmails([an], {
      title: 'Mail-Archiv: Löschantrag entschieden',
      body: entscheid === 'confirmed' ? 'Ihr Löschantrag wurde bestätigt, die Mail ist gelöscht.' : 'Ihr Löschantrag wurde abgelehnt.',
      url: `${SITE_URL}/email-archiv.html`, tag: `archiv-loeschantrag-${antrag.id}`,
    });
  } catch (e) { console.error('[email-archive] Mitteilung an Antragsteller:', e.message); }
}

// POST /api/email-archive/:id/confirm-delete - Confirm or reject deletion (4-Augen step 2)
router.post('/:id/confirm-delete', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const { action } = req.body || {}; // 'confirm' or 'reject'
    if (!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: 'Aktion muss "confirm" oder "reject" sein' });

    const mail = await mailLesen(req, id, 'a.id, a.stweg, a.attachments');
    if (!mail) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    const pending = await pool.query(
      "SELECT * FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [id]
    );
    if (pending.rows.length === 0) return res.status(404).json({ error: 'Kein offener Löschantrag gefunden' });

    const request = pending.rows[0];

    // 4-Augen: andere Person (Konto-ID), aus derselben STWEG oder Technik/Praesident.
    const e = regeln.darfEntscheiden(req.user, request, mail.stweg);
    if (!e.ok) {
      const text = e.grund === 'eigener-antrag' ? '4-Augen-Prinzip: Sie können Ihren eigenen Löschantrag nicht entscheiden'
        : e.grund === 'andere-stweg' ? '4-Augen-Prinzip: Entscheiden darf nur der Ausschuss derselben STWEG, Technik oder Präsident'
          : 'Keine Berechtigung, über Löschanträge zu entscheiden';
      return res.status(403).json({ error: text });
    }

    if (action === 'reject') {
      // Nur wenn noch offen: zwei gleichzeitige Entscheide duerfen nicht beide greifen.
      const upd = await pool.query(
        `UPDATE email_archive_deletions SET status = 'rejected', confirmed_by = $1, confirmed_by_id = $2, confirmed_at = NOW() WHERE id = $3 AND status = 'pending' RETURNING id`,
        [req.user.email, req.user.id, request.id]
      );
      if (!upd.rows.length) return res.status(409).json({ error: 'Löschantrag wurde bereits entschieden' });
      await pool.query("UPDATE email_archive SET deletion_status = 'active' WHERE id = $1", [id]);
      await protokoll(req, 'loeschung-abgelehnt', id, null);
      mitteilen(request, 'rejected');
      return res.json({ success: true, message: 'Löschantrag abgelehnt' });
    }

    // Confirm: erst den Antrag atomar abschliessen, dann loeschen.
    const upd = await pool.query(
      `UPDATE email_archive_deletions SET status = 'confirmed', confirmed_by = $1, confirmed_by_id = $2, confirmed_at = NOW() WHERE id = $3 AND status = 'pending' RETURNING id`,
      [req.user.email, req.user.id, request.id]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'Löschantrag wurde bereits entschieden' });

    const offen = await dateienEntfernen(mail.attachments, `Löschung Mail ${id}`);
    await pool.query(`UPDATE email_archive SET ${SQL_LEEREN}, offene_dateien = $2 WHERE id = $1`,
      [id, offen.length ? JSON.stringify(offen) : null]);
    await protokoll(req, 'loeschung-bestaetigt', id, offen.length ? `${offen.length} Datei(en) nicht entfernt, wird erneut versucht` : null);
    mitteilen(request, 'confirmed');

    res.json({
      success: true,
      message: offen.length ? `E-Mail gelöscht; ${offen.length} Anhang-Datei(en) konnten noch nicht entfernt werden (wird erneut versucht)` : 'E-Mail wurde gelöscht (4-Augen bestätigt)',
      dateien_offen: offen.length,
    });
  } catch (err) {
    console.error('Confirm delete error:', err.message);
    res.status(500).json({ error: 'Fehler bei der Löschbestätigung' });
  }
});

// ─── Aufbewahrung (E1): nach 10 Jahren anonymisieren ────────────────
// Mails, deren Datum (sonst Eingang) mehr als 10 Jahre zurueckliegt, werden wie
// eine bestaetigte Loeschung geleert; offene Antraege dazu gelten als erledigt.
// Dazu: Dateien, deren Entfernen frueher scheiterte, erneut entfernen.
async function aufbewahrungLauf(db = pool) {
  const alt = await db.query(
    `SELECT id, attachments FROM email_archive
      WHERE deletion_status != 'deleted'
        AND COALESCE(email_date, created_at) < NOW() - make_interval(years => $1::int)
      ORDER BY id LIMIT 500`, [regeln.AUFBEWAHRUNG_JAHRE]);
  let anonymisiert = 0;
  for (const m of alt.rows) {
    const offen = await dateienEntfernen(m.attachments, `Aufbewahrung Mail ${m.id}`);
    await db.query(`UPDATE email_archive SET ${SQL_LEEREN}, anonymisiert_am = NOW(), offene_dateien = $2 WHERE id = $1`,
      [m.id, offen.length ? JSON.stringify(offen) : null]);
    await db.query(
      `UPDATE email_archive_deletions SET status = 'confirmed', confirmed_by = 'aufbewahrung', confirmed_at = NOW()
        WHERE archive_id = $1 AND status = 'pending'`, [m.id]);
    await db.query(
      `INSERT INTO email_archive_zugriffe (aktion, archive_id, detail, weg) VALUES ('anonymisiert', $1, $2, 'aufbewahrung')`,
      [m.id, `älter als ${regeln.AUFBEWAHRUNG_JAHRE} Jahre${offen.length ? `; ${offen.length} Datei(en) offen` : ''}`]);
    anonymisiert++;
  }
  const reste = await db.query(`SELECT id, offene_dateien FROM email_archive WHERE offene_dateien IS NOT NULL LIMIT 500`);
  let nachgeholt = 0;
  for (const m of reste.rows) {
    const offen = await dateienEntfernen(m.offene_dateien, `Nachholen Mail ${m.id}`);
    await db.query('UPDATE email_archive SET offene_dateien = $2 WHERE id = $1', [m.id, offen.length ? JSON.stringify(offen) : null]);
    if (!offen.length) nachgeholt++;
  }
  if (anonymisiert || nachgeholt) console.log(`[email-archive] Aufbewahrung: ${anonymisiert} anonymisiert, ${nachgeholt} Datei-Reste entfernt`);
  return { anonymisiert, nachgeholt };
}

function aufbewahrungStarten(intervals) {
  const lauf = () => aufbewahrungLauf().catch(e => console.error('[email-archive] Aufbewahrung:', e.message));
  const t = setInterval(lauf, 24 * 60 * 60 * 1000);
  if (Array.isArray(intervals)) intervals.push(t);
  setTimeout(lauf, 5 * 60 * 1000);
}

module.exports = router;
module.exports.schemaSicherstellen = schemaSicherstellen;
module.exports.stwegZuordnen = stwegZuordnen;
module.exports.aufbewahrungLauf = aufbewahrungLauf;
module.exports.aufbewahrungStarten = aufbewahrungStarten;
module.exports.SQL_STWEG_ZUORDNEN = SQL_STWEG_ZUORDNEN;
