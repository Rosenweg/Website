// ═══════════════════════════════════════════════════════════════════
// MEG (Tiefeinstellhalle) - Einstellplatz-Verwaltung
// Aus server.js ausgelagert (Router-Split). Verhalten identisch.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { getAusschussStwegs } = require('../lib/groups');

const router = express.Router();

// MEG-Platzverwaltung: Technik/Praesident (isAdmin) ODER MEG-Ausschuss
// (Ausschuss fuer STWEG 8). Frontend (einstellplaetze.html) zeigt dem Ausschuss
// das Bearbeiten-Grid — adminOnly waere zu streng und gaebe 403 beim Speichern.
function megManageGate(req, res, next) {
  const groups = req.user?.groups || [];
  if (req.user?.isAdmin || getAusschussStwegs(groups).has(8)) return next();
  return res.status(403).json({ error: 'MEG-Ausschuss oder Technik erforderlich' });
}

// Public: nur die zu vermietenden Plaetze (fuer "Motorradplaetze noch frei").
// Keine PII — nur platz_nr/typ/status. Wird vom meg-Frontend ungeschuetzt geladen.
router.get('/einstellplaetze/verfuegbar', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, platz_nr, typ FROM meg_einstellplaetze
        WHERE status = 'zu_vermieten' ORDER BY typ, platz_nr`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Fehler beim Laden' }); }
});

// Volle Liste — nur eingeloggt (Ausschuss/Eigentuemer sehen Zuordnungen).
router.get('/einstellplaetze', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM meg_einstellplaetze ORDER BY typ, platz_nr');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Fehler beim Laden' }); }
});

router.post('/einstellplaetze', authMiddleware, megManageGate, async (req, res) => {
  const { platz_nr, typ, status, zugeordnet_name, zugeordnet_email, wohnung_id, notizen } = req.body;
  if (!platz_nr) return res.status(400).json({ error: 'platz_nr erforderlich' });
  try {
    const r = await pool.query(
      `INSERT INTO meg_einstellplaetze (platz_nr, typ, status, zugeordnet_name, zugeordnet_email, wohnung_id, notizen)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [platz_nr, typ || 'auto', status || 'frei', zugeordnet_name || null,
       zugeordnet_email || null, wohnung_id || null, notizen || null]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' }); }
});

router.put('/einstellplaetze/:id', authMiddleware, megManageGate, async (req, res) => {
  const { platz_nr, typ, status, zugeordnet_name, zugeordnet_email, wohnung_id, notizen } = req.body;
  try {
    const r = await pool.query(
      `UPDATE meg_einstellplaetze SET
         platz_nr=COALESCE($2,platz_nr), typ=COALESCE($3,typ), status=COALESCE($4,status),
         zugeordnet_name=$5, zugeordnet_email=$6, wohnung_id=$7, notizen=$8, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, platz_nr, typ, status, zugeordnet_name || null,
       zugeordnet_email || null, wohnung_id || null, notizen || null]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Platz nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' }); }
});

router.delete('/einstellplaetze/:id', authMiddleware, megManageGate, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM meg_einstellplaetze WHERE id=$1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Platz nicht gefunden' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Interner Serverfehler' }); }
});

module.exports = router;
