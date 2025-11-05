const express = require('express');
const router = express.Router();
const database = require('../config/database');
const shellyService = require('../services/shelly.service');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/devices
 * Hole alle Geräte mit aktuellem Status
 */
router.get('/', async (req, res) => {
  try {
    const devices = await database.all(
      'SELECT * FROM devices ORDER BY location, device_type'
    );

    // Hole Live-Status von jedem Gerät
    const devicesWithStatus = await Promise.all(
      devices.map(async (device) => {
        try {
          const energyData = await shellyService.getEnergyData(device.device_id);
          const isOnline = await shellyService.isOnline(device.device_id);

          return {
            ...device,
            current_power: energyData.power,
            is_in_use: energyData.power > 10, // Annahme: > 10W = in Nutzung
            is_online: isOnline,
            ...energyData
          };
        } catch (error) {
          return {
            ...device,
            is_online: false,
            error: error.message
          };
        }
      })
    );

    res.json(devicesWithStatus);
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Geräte'
    });
  }
});

/**
 * GET /api/devices/:id
 * Hole ein spezifisches Gerät mit Details
 */
router.get('/:id', async (req, res) => {
  try {
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ?',
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({
        error: 'Gerät nicht gefunden'
      });
    }

    // Hole Live-Daten
    try {
      const energyData = await shellyService.getEnergyData(device.device_id);
      const isOnline = await shellyService.isOnline(device.device_id);

      res.json({
        ...device,
        ...energyData,
        is_online: isOnline
      });
    } catch (error) {
      res.json({
        ...device,
        is_online: false,
        error: error.message
      });
    }
  } catch (error) {
    console.error('Get device error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden des Geräts'
    });
  }
});

/**
 * GET /api/devices/:id/status
 * Hole aktuellen Echtzeit-Status eines Geräts
 */
router.get('/:id/status', async (req, res) => {
  try {
    const device = await database.get(
      'SELECT * FROM devices WHERE id = ?',
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({
        error: 'Gerät nicht gefunden'
      });
    }

    const status = await shellyService.getSwitchStatus(device.device_id);
    const energyData = await shellyService.getEnergyData(device.device_id);

    res.json({
      device_id: device.id,
      device_name: device.device_name,
      ...status,
      ...energyData
    });
  } catch (error) {
    console.error('Get device status error:', error);
    res.status(500).json({
      error: 'Fehler beim Abrufen des Gerätestatus'
    });
  }
});

/**
 * GET /api/devices/:id/history
 * Hole Nutzungshistorie eines Geräts
 */
router.get('/:id/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const history = await database.all(
      `SELECT s.*, u.name, u.wohnung
       FROM usage_sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.device_id = ?
       ORDER BY s.started_at DESC
       LIMIT ?`,
      [req.params.id, limit]
    );

    res.json(history);
  } catch (error) {
    console.error('Get device history error:', error);
    res.status(500).json({
      error: 'Fehler beim Laden der Historie'
    });
  }
});

module.exports = router;
