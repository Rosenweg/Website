const express = require('express');
const router = express.Router();
const database = require('../config/database');
const shellyService = require('../services/shelly.service');
const { authenticateToken } = require('../middleware/auth');

/**
 * POST /api/sessions/start
 * Starte eine neue Wasch-/Trockner-Session
 * Authentifizierung via USB-Stick/Yubikey erforderlich
 */
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { device_id, user_token } = req.body;

    if (!device_id || !user_token) {
      return res.status(400).json({
        error: 'Geräte-ID und Benutzer-Token erforderlich'
      });
    }

    // Prüfe ob Gerät verfügbar ist
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ? AND is_available = 1',
      [device_id]
    );

    if (!device) {
      return res.status(404).json({
        error: 'Gerät nicht gefunden oder nicht verfügbar'
      });
    }

    // Prüfe ob Gerät bereits in Benutzung ist
    const activeSession = await database.get(
      'SELECT * FROM usage_sessions WHERE device_id = ? AND status = ?',
      [device_id, 'active']
    );

    if (activeSession) {
      return res.status(409).json({
        error: 'Gerät ist bereits in Benutzung'
      });
    }

    // Hole Benutzer
    const user = await database.get(
      'SELECT * FROM users WHERE user_token = ? AND is_active = 1',
      [user_token]
    );

    if (!user) {
      return res.status(404).json({
        error: 'Benutzer nicht gefunden'
      });
    }

    // Prüfe Guthaben
    if (user.balance <= 0) {
      return res.status(402).json({
        error: 'Unzureichendes Guthaben. Bitte Konto aufladen.'
      });
    }

    // Reset Shelly Energiezähler
    await shellyService.resetEnergyCounter(device.device_id);

    // Schalte Gerät ein
    await shellyService.turnOn(device.device_id);

    // Erstelle Session
    const result = await database.run(
      'INSERT INTO usage_sessions (user_id, device_id, status) VALUES (?, ?, ?)',
      [user.id, device_id, 'active']
    );

    // Markiere Gerät als nicht verfügbar
    await database.run(
      'UPDATE devices SET is_available = 0 WHERE id = ?',
      [device_id]
    );

    const session = await database.get(
      'SELECT * FROM usage_sessions WHERE id = ?',
      [result.lastID]
    );

    res.json({
      success: true,
      session,
      message: `${device.device_name} wurde gestartet`
    });
  } catch (error) {
    console.error('Start session error:', error);
    res.status(500).json({
      error: 'Fehler beim Starten der Session'
    });
  }
});

/**
 * POST /api/sessions/:id/stop
 * Beende eine Session und berechne Kosten
 */
router.post('/:id/stop', authenticateToken, async (req, res) => {
  try {
    const sessionId = req.params.id;

    // Hole Session
    const session = await database.get(
      'SELECT s.*, d.*, u.balance FROM usage_sessions s JOIN devices d ON s.device_id = d.id JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.status = ?',
      [sessionId, 'active']
    );

    if (!session) {
      return res.status(404).json({
        error: 'Session nicht gefunden oder bereits beendet'
      });
    }

    // Hole finale Energieverbrauchsdaten vom Shelly
    const energyData = await shellyService.getEnergyData(session.device_id);

    // Berechne Kosten
    const energyConsumed = energyData.totalEnergy; // in kWh
    const cost = energyConsumed * session.cost_per_kwh;

    // Schalte Gerät aus
    await shellyService.turnOff(session.device_id);

    // Update Session
    await database.run(
      `UPDATE usage_sessions
       SET ended_at = CURRENT_TIMESTAMP,
           energy_consumed = ?,
           cost = ?,
           status = 'completed'
       WHERE id = ?`,
      [energyConsumed, cost, sessionId]
    );

    // Erstelle Transaction
    await database.run(
      `INSERT INTO transactions (user_id, amount, transaction_type, description, session_id)
       VALUES (?, ?, 'usage', ?, ?)`,
      [session.user_id, -cost, `${session.device_name} - ${energyConsumed.toFixed(2)} kWh`, sessionId]
    );

    // Update Benutzer-Balance
    await database.run(
      'UPDATE users SET balance = balance - ? WHERE id = ?',
      [cost, session.user_id]
    );

    // Markiere Gerät als verfügbar
    await database.run(
      'UPDATE devices SET is_available = 1 WHERE id = ?',
      [session.device_id]
    );

    const updatedSession = await database.get(
      'SELECT * FROM usage_sessions WHERE id = ?',
      [sessionId]
    );

    res.json({
      success: true,
      session: updatedSession,
      energy_consumed: energyConsumed,
      cost: cost,
      remaining_balance: session.balance - cost,
      message: `Session beendet. Verbrauch: ${energyConsumed.toFixed(2)} kWh, Kosten: CHF ${cost.toFixed(2)}`
    });
  } catch (error) {
    console.error('Stop session error:', error);
    res.status(500).json({
      error: 'Fehler beim Beenden der Session'
    });
  }
});

/**
 * GET /api/sessions/active
 * Hole alle aktiven Sessions
 */
router.get('/active', async (req, res) => {
  try {
    const sessions = await database.all(
      `SELECT s.*, u.name, u.wohnung, d.device_name, d.device_type, d.location
       FROM usage_sessions s
       JOIN users u ON s.user_id = u.id
       JOIN devices d ON s.device_id = d.id
       WHERE s.status = 'active'
       ORDER BY s.started_at DESC`
    );

    // Füge Live-Energiedaten hinzu
    const sessionsWithLiveData = await Promise.all(
      sessions.map(async (session) => {
        try {
          const energyData = await shellyService.getEnergyData(session.device_id);
          const estimatedCost = energyData.totalEnergy * session.cost_per_kwh;

          return {
            ...session,
            current_energy: energyData.totalEnergy,
            current_power: energyData.power,
            estimated_cost: estimatedCost
          };
        } catch (error) {
          return session;
        }
      })
    );

    res.json(sessionsWithLiveData);
  } catch (error) {
    console.error('Get active sessions error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der aktiven Sessions'
    });
  }
});

/**
 * GET /api/sessions/user/:userId
 * Hole alle Sessions eines Benutzers
 */
router.get('/user/:userId', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const sessions = await database.all(
      `SELECT s.*, d.device_name, d.device_type, d.location
       FROM usage_sessions s
       JOIN devices d ON s.device_id = d.id
       WHERE s.user_id = ?
       ORDER BY s.started_at DESC
       LIMIT ?`,
      [req.params.userId, limit]
    );

    res.json(sessions);
  } catch (error) {
    console.error('Get user sessions error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Sessions'
    });
  }
});

/**
 * GET /api/sessions/:id
 * Hole Details einer Session
 */
router.get('/:id', async (req, res) => {
  try {
    const session = await database.get(
      `SELECT s.*, u.name, u.wohnung, d.device_name, d.device_type, d.location
       FROM usage_sessions s
       JOIN users u ON s.user_id = u.id
       JOIN devices d ON s.device_id = d.id
       WHERE s.id = ?`,
      [req.params.id]
    );

    if (!session) {
      return res.status(404).json({
        error: 'Session nicht gefunden'
      });
    }

    res.json(session);
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Session'
    });
  }
});

module.exports = router;
