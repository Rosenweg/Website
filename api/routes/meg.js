// ═══════════════════════════════════════════════════════════════════
// MEG (Tiefeinstellhalle) - Einstellplatz-Verwaltung
// Aus server.js ausgelagert (Router-Split). Verhalten identisch.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { darfMegPlaetzeVerwalten, megPlatzAenderung } = require('../lib/meg');

const router = express.Router();

// MEG-Platzverwaltung: Technik/Praesident ODER MEG-Ausschuss (Ausschuss fuer
// STWEG 8), Regel in lib/meg.js. Die Seite fragt /einstellplaetze/rechte und
// zeigt das Bearbeiten-Grid nur dann (M1).
function megManageGate(req, res, next) {
  if (darfMegPlaetzeVerwalten(req.user)) return next();
  return res.status(403).json({ error: 'Nur der MEG-Ausschuss, Technik oder Präsident dürfen Plätze ändern.' });
}

// Was die Seite anbieten darf (M1). Eingeloggt; keine Daten, nur das Recht.
router.get('/einstellplaetze/rechte', authMiddleware, (req, res) => {
  res.json({ verwalten: darfMegPlaetzeVerwalten(req.user) });
});

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

// Volle Liste — eingeloggt. Zuordnungen (Name, E-Mail, Wohnung, Notiz) sieht
// nur, wer die Plaetze verwaltet; alle anderen nur Platz, Typ, Status und den
// eigenen Platz. Vorher bekam jedes Konto jeder STWEG die ganze Tabelle.
router.get('/einstellplaetze', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM meg_einstellplaetze ORDER BY typ, platz_nr');
    if (darfMegPlaetzeVerwalten(req.user)) return res.json(r.rows);
    const me = String(req.user?.email || '').toLowerCase();
    res.json(r.rows.map(p => (me && String(p.zugeordnet_email || '').toLowerCase() === me)
      ? p
      : { id: p.id, platz_nr: p.platz_nr, typ: p.typ, status: p.status }));
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

// M2: nur mitgeschickte Felder aendern (megPlatzAenderung). Vorher setzte jedes
// Speichern der Seite zugeordnet_email und wohnung_id auf NULL.
router.put('/einstellplaetze/:id', authMiddleware, megManageGate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige Platz-ID' });
  const aend = megPlatzAenderung(req.body);
  if (aend.error) return res.status(400).json({ error: aend.error });
  try {
    const sets = aend.felder.map((f, i) => `${f}=$${i + 2}`);
    sets.push('updated_at=NOW()');
    const r = await pool.query(
      `UPDATE meg_einstellplaetze SET ${sets.join(', ')} WHERE id=$1 RETURNING *`,
      [id, ...aend.werte]);
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
