const jwt = require('jsonwebtoken');

/**
 * Middleware zur JWT-Token-Authentifizierung
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      error: 'Zugriff verweigert. Kein Token vorhanden.'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default-secret');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({
      error: 'Ungültiger oder abgelaufener Token'
    });
  }
}

/**
 * Middleware zur Admin-Authentifizierung
 */
function authenticateAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    // Prüfe ob Benutzer Admin ist (kann erweitert werden)
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Zugriff verweigert. Admin-Rechte erforderlich.'
      });
    }
    next();
  });
}

module.exports = {
  authenticateToken,
  authenticateAdmin
};
