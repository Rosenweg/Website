const express = require('express');
const router = express.Router();
const database = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/users/:id
 * Hole Benutzer-Profil
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const user = await database.get(
      'SELECT id, name, wohnung, email, balance, created_at FROM users WHERE id = ?',
      [req.params.id]
    );

    if (!user) {
      return res.status(404).json({
        error: 'Benutzer nicht gefunden'
      });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden des Benutzers'
    });
  }
});

/**
 * GET /api/users/:id/balance
 * Hole Guthaben eines Benutzers
 */
router.get('/:id/balance', authenticateToken, async (req, res) => {
  try {
    const user = await database.get(
      'SELECT balance FROM users WHERE id = ?',
      [req.params.id]
    );

    if (!user) {
      return res.status(404).json({
        error: 'Benutzer nicht gefunden'
      });
    }

    res.json({
      balance: user.balance
    });
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden des Guthabens'
    });
  }
});

/**
 * POST /api/users/:id/topup
 * Guthaben aufladen
 */
router.post('/:id/topup', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Ungültiger Betrag'
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
       VALUES (?, ?, 'topup', ?)`,
      [req.params.id, amount, `Guthaben aufgeladen: CHF ${amount.toFixed(2)}`]
    );

    const user = await database.get(
      'SELECT balance FROM users WHERE id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      balance: user.balance,
      message: `Guthaben erfolgreich aufgeladen: CHF ${amount.toFixed(2)}`
    });
  } catch (error) {
    console.error('Topup error:', error);
    res.status(500).json({
      error: 'Fehler beim Aufladen des Guthabens'
    });
  }
});

/**
 * GET /api/users/:id/transactions
 * Hole Transaktionshistorie
 */
router.get('/:id/transactions', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const transactions = await database.all(
      `SELECT * FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [req.params.id, limit]
    );

    res.json(transactions);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Transaktionen'
    });
  }
});

/**
 * GET /api/users/:id/stats
 * Hole Benutzer-Statistiken
 */
router.get('/:id/stats', authenticateToken, async (req, res) => {
  try {
    // Gesamtverbrauch
    const totalUsage = await database.get(
      `SELECT
         COUNT(*) as total_sessions,
         COALESCE(SUM(energy_consumed), 0) as total_energy,
         COALESCE(SUM(cost), 0) as total_cost
       FROM usage_sessions
       WHERE user_id = ? AND status = 'completed'`,
      [req.params.id]
    );

    // Verbrauch pro Gerätetyp
    const usageByType = await database.all(
      `SELECT
         d.device_type,
         COUNT(*) as sessions,
         COALESCE(SUM(s.energy_consumed), 0) as energy,
         COALESCE(SUM(s.cost), 0) as cost
       FROM usage_sessions s
       JOIN devices d ON s.device_id = d.id
       WHERE s.user_id = ? AND s.status = 'completed'
       GROUP BY d.device_type`,
      [req.params.id]
    );

    // Letzte 7 Tage
    const last7Days = await database.all(
      `SELECT
         DATE(started_at) as date,
         COUNT(*) as sessions,
         COALESCE(SUM(energy_consumed), 0) as energy,
         COALESCE(SUM(cost), 0) as cost
       FROM usage_sessions
       WHERE user_id = ? AND status = 'completed'
         AND started_at >= date('now', '-7 days')
       GROUP BY DATE(started_at)
       ORDER BY date DESC`,
      [req.params.id]
    );

    res.json({
      total: totalUsage,
      by_type: usageByType,
      last_7_days: last7Days
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Statistiken'
    });
  }
});

module.exports = router;
