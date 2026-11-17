// ═══════════════════════════════════════════════════════════════════
// EMAIL ARCHIVE (4-Augen Löschprinzip)
// Aus server.js ausgelagert (Router-Split). Verhalten identisch.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fsSync = require('fs');
const fs = require('fs').promises;
const pathModule = require('path');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik, isPraesident, isAusschussForAny } = require('../lib/groups');

const router = express.Router();

// DOCS_PATH ist SHARED (auch von documents-Routes genutzt) — Router definiert
// hier seine eigene, identische Konstante.
const DOCS_PATH = process.env.DOCS_PATH || '/documents';

function requireArchiveAccess(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups) || isAusschussForAny(groups)) return next();
  return res.status(403).json({ error: 'Kein Zugriff auf das E-Mail-Archiv' });
}

// GET /api/email-archive - List archived emails with search & pagination
router.get('/', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = "deletion_status != 'deleted'";
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (subject ILIKE $1 OR from_email ILIKE $1 OR from_name ILIKE $1)`;
    }

    const countRes = await pool.query(`SELECT COUNT(*) FROM email_archive WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const dataRes = await pool.query(
      `SELECT id, from_email, from_name, subject, email_date, created_at, attachments, deletion_status
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

// GET /api/email-archive/delete-requests - List pending deletion requests
router.get('/delete-requests', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, a.subject, a.from_email, a.from_name, a.email_date
       FROM email_archive_deletions d
       JOIN email_archive a ON a.id = d.archive_id
       WHERE d.status = 'pending'
       ORDER BY d.requested_at DESC`
    );
    res.json({ requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Löschanträge' });
  }
});

// GET /api/email-archive/:id - Single email detail
router.get('/:id', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, d.id as deletion_id, d.requested_by, d.reason, d.status as deletion_request_status
       FROM email_archive a
       LEFT JOIN email_archive_deletions d ON d.archive_id = a.id AND d.status = 'pending'
       WHERE a.id = $1 AND a.deletion_status != 'deleted'`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der E-Mail' });
  }
});

// GET /api/email-archive/:id/attachment/:filename - Download attachment
router.get('/:id/attachment/:filename', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT attachments FROM email_archive WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden' });

    const attachments = result.rows[0].attachments || [];
    const att = attachments.find(a => a.stored_name === req.params.filename || a.filename === req.params.filename);
    if (!att) return res.status(404).json({ error: 'Anhang nicht gefunden' });

    const filePath = pathModule.join(DOCS_PATH, 'archiv', att.stored_name);
    // Path traversal protection
    if (!filePath.startsWith(pathModule.resolve(DOCS_PATH, 'archiv'))) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

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
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Begründung erforderlich' });
    await pendingIndexSicherstellen();

    // Status atomar von 'active' auf 'pending' umstellen: nur eine von mehreren
    // gleichzeitigen Anfragen gewinnt, es entsteht kein zweiter offener Antrag.
    const email = await pool.query(
      "UPDATE email_archive SET deletion_status = 'pending' WHERE id = $1 AND deletion_status = 'active' RETURNING id", [req.params.id]
    );
    if (email.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden oder bereits in Löschung' });

    // Check no pending request exists
    const existing = await pool.query(
      "SELECT id FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [req.params.id]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });

    try {
      await pool.query(
        `INSERT INTO email_archive_deletions (archive_id, requested_by, reason) VALUES ($1, $2, $3)`,
        [req.params.id, req.user.email, reason.trim()]
      );
    } catch (e) {
      // Antrag nicht angelegt -> Status zuruecksetzen, sonst haengt die Mail in 'pending'.
      await pool.query("UPDATE email_archive SET deletion_status = 'active' WHERE id = $1 AND deletion_status = 'pending' AND NOT EXISTS (SELECT 1 FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending')", [req.params.id]).catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });
      throw e;
    }

    res.json({ success: true, message: 'Löschantrag erstellt. Eine zweite Person muss bestätigen.' });
  } catch (err) {
    console.error('Delete request error:', err.message);
    res.status(500).json({ error: 'Fehler beim Erstellen des Löschantrags' });
  }
});

// POST /api/email-archive/:id/confirm-delete - Confirm or reject deletion (4-Augen step 2)
router.post('/:id/confirm-delete', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const { action } = req.body; // 'confirm' or 'reject'
    if (!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: 'Aktion muss "confirm" oder "reject" sein' });

    const pending = await pool.query(
      "SELECT * FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [req.params.id]
    );
    if (pending.rows.length === 0) return res.status(404).json({ error: 'Kein offener Löschantrag gefunden' });

    const request = pending.rows[0];

    // 4-Augen: confirmer must be different from requester. Gross-/Kleinschreibung
    // egal, sonst bestaetigte dieselbe Person mit anders geschriebener Adresse.
    const norm = (e) => String(e || '').trim().toLowerCase();
    if (!norm(req.user.email) || norm(request.requested_by) === norm(req.user.email)) {
      return res.status(403).json({ error: '4-Augen-Prinzip: Sie können Ihren eigenen Löschantrag nicht bestätigen' });
    }

    if (action === 'reject') {
      // Nur wenn noch offen: zwei gleichzeitige Entscheide duerfen nicht beide greifen.
      const upd = await pool.query(
        `UPDATE email_archive_deletions SET status = 'rejected', confirmed_by = $1, confirmed_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING id`,
        [req.user.email, request.id]
      );
      if (!upd.rows.length) return res.status(409).json({ error: 'Löschantrag wurde bereits entschieden' });
      await pool.query("UPDATE email_archive SET deletion_status = 'active' WHERE id = $1", [req.params.id]);
      return res.json({ success: true, message: 'Löschantrag abgelehnt' });
    }

    // Confirm: erst den Antrag atomar abschliessen, dann loeschen.
    const upd = await pool.query(
      `UPDATE email_archive_deletions SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.user.email, request.id]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'Löschantrag wurde bereits entschieden' });

    // Delete attachments from disk, then mark as deleted
    const emailData = await pool.query('SELECT attachments FROM email_archive WHERE id = $1', [req.params.id]);
    if (emailData.rows.length > 0) {
      const attachments = emailData.rows[0].attachments || [];
      for (const att of attachments) {
        try {
          await fs.unlink(pathModule.join(DOCS_PATH, 'archiv', att.stored_name));
        } catch {}
      }
    }

    await pool.query(
      "UPDATE email_archive SET deletion_status = 'deleted', text_body = NULL, html_body = NULL, attachments = '[]' WHERE id = $1",
      [req.params.id]
    );

    res.json({ success: true, message: 'E-Mail wurde gelöscht (4-Augen bestätigt)' });
  } catch (err) {
    console.error('Confirm delete error:', err.message);
    res.status(500).json({ error: 'Fehler bei der Löschbestätigung' });
  }
});

module.exports = router;
