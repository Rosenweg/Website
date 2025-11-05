const express = require('express');
const router = express.Router();
const database = require('../config/database');
const { authenticateAdmin } = require('../middleware/auth');

/**
 * GET /api/admin/users
 * Hole alle Benutzer
 */
router.get('/users', async (req, res) => {
  try {
    const users = await database.all(
      'SELECT id, name, wohnung, email, balance, is_active, created_at FROM users ORDER BY wohnung'
    );

    res.json(users);
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Benutzer'
    });
  }
});

/**
 * POST /api/admin/users
 * Erstelle neuen Benutzer
 */
router.post('/users', async (req, res) => {
  try {
    const { user_token, wohnung, name, email, initial_balance } = req.body;

    if (!user_token || !wohnung || !name) {
      return res.status(400).json({
        error: 'Token, Wohnung und Name sind erforderlich'
      });
    }

    // Erstelle Benutzer
    const result = await database.run(
      `INSERT INTO users (user_token, wohnung, name, email, balance)
       VALUES (?, ?, ?, ?, ?)`,
      [user_token, wohnung, name, email || null, initial_balance || 0]
    );

    // Erstelle Auth Token
    await database.run(
      `INSERT INTO auth_tokens (user_id, token_identifier, token_type)
       VALUES (?, ?, ?)`,
      [result.lastID, user_token, 'usb']
    );

    const user = await database.get(
      'SELECT id, name, wohnung, email, balance FROM users WHERE id = ?',
      [result.lastID]
    );

    res.json({
      success: true,
      user,
      message: 'Benutzer erfolgreich erstellt'
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      error: 'Fehler beim Erstellen des Benutzers'
    });
  }
});

/**
 * PUT /api/admin/users/:id
 * Benutzer aktualisieren
 */
router.put('/users/:id', async (req, res) => {
  try {
    const { name, email, wohnung, is_active } = req.body;

    await database.run(
      `UPDATE users
       SET name = ?, email = ?, wohnung = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, email, wohnung, is_active, req.params.id]
    );

    const user = await database.get(
      'SELECT id, name, wohnung, email, balance, is_active FROM users WHERE id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      user,
      message: 'Benutzer erfolgreich aktualisiert'
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      error: 'Fehler beim Aktualisieren des Benutzers'
    });
  }
});

/**
 * POST /api/admin/users/:id/adjust-balance
 * Admin-Balance-Anpassung
 */
router.post('/users/:id/adjust-balance', async (req, res) => {
  try {
    const { amount, reason } = req.body;

    if (!amount) {
      return res.status(400).json({
        error: 'Betrag ist erforderlich'
      });
    }

    // Update Balance
    await database.run(
      'UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [amount, req.params.id]
    );

    // Erstelle Transaction
    await database.run(
      `INSERT INTO transactions (user_id, amount, transaction_type, description)
       VALUES (?, ?, 'admin_adjustment', ?)`,
      [req.params.id, amount, reason || 'Admin-Anpassung']
    );

    const user = await database.get(
      'SELECT balance FROM users WHERE id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      balance: user.balance,
      message: 'Guthaben erfolgreich angepasst'
    });
  } catch (error) {
    console.error('Adjust balance error:', error);
    res.status(500).json({
      error: 'Fehler beim Anpassen des Guthabens'
    });
  }
});

/**
 * GET /api/admin/sessions
 * Alle Sessions (für Abrechnung/Übersicht)
 */
router.get('/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const status = req.query.status || null;

    let sql = `
      SELECT s.*, u.name, u.wohnung, d.device_name, d.location
      FROM usage_sessions s
      JOIN users u ON s.user_id = u.id
      JOIN devices d ON s.device_id = d.id
    `;

    const params = [];

    if (status) {
      sql += ' WHERE s.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY s.started_at DESC LIMIT ?';
    params.push(limit);

    const sessions = await database.all(sql, params);

    res.json(sessions);
  } catch (error) {
    console.error('Get all sessions error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Sessions'
    });
  }
});

/**
 * GET /api/admin/stats
 * Gesamt-Statistiken für Admin
 */
router.get('/stats', async (req, res) => {
  try {
    // Gesamt-Übersicht
    const overview = await database.get(
      `SELECT
         COUNT(DISTINCT user_id) as total_users,
         COUNT(*) as total_sessions,
         COALESCE(SUM(energy_consumed), 0) as total_energy,
         COALESCE(SUM(cost), 0) as total_revenue
       FROM usage_sessions
       WHERE status = 'completed'`
    );

    // Top 5 Nutzer
    const topUsers = await database.all(
      `SELECT
         u.name,
         u.wohnung,
         COUNT(s.id) as sessions,
         COALESCE(SUM(s.energy_consumed), 0) as energy,
         COALESCE(SUM(s.cost), 0) as spent
       FROM users u
       JOIN usage_sessions s ON u.id = s.user_id
       WHERE s.status = 'completed'
       GROUP BY u.id, u.name, u.wohnung
       ORDER BY spent DESC
       LIMIT 5`
    );

    // Geräte-Nutzung
    const deviceUsage = await database.all(
      `SELECT
         d.device_name,
         d.location,
         COUNT(s.id) as sessions,
         COALESCE(SUM(s.energy_consumed), 0) as energy
       FROM devices d
       LEFT JOIN usage_sessions s ON d.id = s.device_id AND s.status = 'completed'
       GROUP BY d.id, d.device_name, d.location
       ORDER BY sessions DESC`
    );

    // Letzte 30 Tage
    const last30Days = await database.all(
      `SELECT
         DATE(started_at) as date,
         COUNT(*) as sessions,
         COALESCE(SUM(energy_consumed), 0) as energy,
         COALESCE(SUM(cost), 0) as revenue
       FROM usage_sessions
       WHERE status = 'completed'
         AND started_at >= date('now', '-30 days')
       GROUP BY DATE(started_at)
       ORDER BY date DESC`
    );

    res.json({
      overview,
      top_users: topUsers,
      device_usage: deviceUsage,
      last_30_days: last30Days
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Statistiken'
    });
  }
});

/**
 * GET /api/admin/logs
 * Admin-Logs abrufen
 */
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    const logs = await database.all(
      'SELECT * FROM admin_logs ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );

    res.json(logs);
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Logs'
    });
  }
});

/**
 * GET /api/admin/export/sessions
 * Export Sessions als CSV
 */
router.get('/export/sessions', async (req, res) => {
  try {
    const sessions = await database.all(
      `SELECT
         s.id,
         u.name,
         u.wohnung,
         d.device_name,
         d.location,
         s.started_at,
         s.ended_at,
         s.energy_consumed,
         s.cost,
         s.status
       FROM usage_sessions s
       JOIN users u ON s.user_id = u.id
       JOIN devices d ON s.device_id = d.id
       ORDER BY s.started_at DESC`
    );

    // Konvertiere zu CSV
    const csv = [
      'ID,Name,Wohnung,Gerät,Standort,Start,Ende,Energie (kWh),Kosten (CHF),Status',
      ...sessions.map(s =>
        `${s.id},${s.name},${s.wohnung},${s.device_name},${s.location},${s.started_at},${s.ended_at || ''},${s.energy_consumed || ''},${s.cost || ''},${s.status}`
      )
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=sessions.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export sessions error:', error);
    res.status(500).json({
      error: 'Fehler beim Exportieren der Sessions'
    });
  }
});

module.exports = router;
