const express = require('express');
const router = express.Router();
const shellyService = require('../services/shelly.service');
const database = require('../config/database');

/**
 * POST /api/shelly/register
 * Registriere Shelly-Geräte beim Start
 */
router.post('/register', async (req, res) => {
  try {
    // Lade alle Geräte aus der Datenbank
    const devices = await database.all('SELECT * FROM devices');

    // Registriere jedes Gerät beim Shelly Service
    devices.forEach(device => {
      shellyService.registerDevice(
        device.device_id,
        device.shelly_ip,
        null // Auth, falls benötigt
      );
    });

    res.json({
      success: true,
      registered: devices.length,
      message: `${devices.length} Geräte erfolgreich registriert`
    });
  } catch (error) {
    console.error('Register devices error:', error);
    res.status(500).json({
      error: 'Fehler beim Registrieren der Geräte'
    });
  }
});

/**
 * GET /api/shelly/status
 * Hole Status aller Shelly-Geräte
 */
router.get('/status', async (req, res) => {
  try {
    const statuses = await shellyService.getAllDevicesStatus();
    res.json(statuses);
  } catch (error) {
    console.error('Get all device statuses error:', error);
    res.status(500).json({
      error: 'Fehler beim Abrufen der Gerätestatus'
    });
  }
});

/**
 * GET /api/shelly/:deviceId/info
 * Hole Geräteinformationen vom Shelly
 */
router.get('/:deviceId/info', async (req, res) => {
  try {
    const info = await shellyService.getDeviceInfo(req.params.deviceId);
    res.json(info);
  } catch (error) {
    console.error('Get device info error:', error);
    res.status(500).json({
      error: 'Fehler beim Abrufen der Geräteinformationen'
    });
  }
});

/**
 * POST /api/shelly/:deviceId/turn-on
 * Schalte Gerät ein (nur für Tests/Admin)
 */
router.post('/:deviceId/turn-on', async (req, res) => {
  try {
    const result = await shellyService.turnOn(req.params.deviceId);
    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Turn on error:', error);
    res.status(500).json({
      error: 'Fehler beim Einschalten'
    });
  }
});

/**
 * POST /api/shelly/:deviceId/turn-off
 * Schalte Gerät aus (nur für Tests/Admin)
 */
router.post('/:deviceId/turn-off', async (req, res) => {
  try {
    const result = await shellyService.turnOff(req.params.deviceId);
    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Turn off error:', error);
    res.status(500).json({
      error: 'Fehler beim Ausschalten'
    });
  }
});

module.exports = router;
