const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const database = require('../config/database');

/**
 * POST /api/auth/login
 * Authentifizierung via USB-Stick/Yubikey
 */
router.post('/login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Token ist erforderlich'
      });
    }

    // Prüfe ob Token in der Datenbank existiert
    const authToken = await database.get(
      'SELECT at.*, u.* FROM auth_tokens at JOIN users u ON at.user_id = u.id WHERE at.token_identifier = ? AND at.is_active = 1',
      [token]
    );

    if (!authToken) {
      return res.status(401).json({
        error: 'Ungültiger oder inaktiver Token'
      });
    }

    // Update last_used
    await database.run(
      'UPDATE auth_tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?',
      [authToken.id]
    );

    // Erstelle JWT
    const jwtToken = jwt.sign(
      {
        userId: authToken.user_id,
        wohnung: authToken.wohnung,
        name: authToken.name
      },
      process.env.JWT_SECRET || 'default-secret',
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: authToken.user_id,
        name: authToken.name,
        wohnung: authToken.wohnung,
        email: authToken.email,
        balance: authToken.balance
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login fehlgeschlagen'
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout (invalidiert JWT auf Client-Seite)
 */
router.post('/logout', (req, res) => {
  // Bei JWT müssen wir den Token auf Client-Seite löschen
  res.json({
    success: true,
    message: 'Erfolgreich abgemeldet'
  });
});

/**
 * GET /api/auth/verify
 * Verifiziere JWT Token
 */
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        valid: false,
        error: 'Kein Token vorhanden'
      });
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');

    // Hole aktuelle Benutzerdaten
    const user = await database.get(
      'SELECT id, name, wohnung, email, balance, is_active FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({
        valid: false,
        error: 'Benutzer nicht gefunden oder inaktiv'
      });
    }

    res.json({
      valid: true,
      user
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({
      valid: false,
      error: 'Ungültiger Token'
    });
  }
});

module.exports = router;
