// Auth-Middleware — aus server.js ausgelagert (Router-Split). LOGIN-KRITISCH:
// authMiddleware authentifiziert PAT / Session / Authentik-Token pro Request.
// Helfer (validateAuthentikToken, resolveAncestorGroups, ACCESS_LEVELS) kommen
// aus lib/auth; pool + auditCtx aus lib/db; AUTHENTIK_CLIENT_ID aus lib/config.
const crypto = require('crypto');
const { pool, auditCtx } = require('../lib/db');
const { AUTHENTIK_CLIENT_ID } = require('../lib/config');
const { validateAuthentikToken, resolveAncestorGroups, ACCESS_LEVELS } = require('../lib/auth');

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    // 0. Personal Access Token (PAT) — prefix-erkennbar, für M2M/AI-Agents
    //    Wirkt als 'login als der User der den Token erstellt hat'.
    if (token.startsWith('rw_pat_')) {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const r = await pool.query(
        `SELECT t.*, u.id AS user_id, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
           FROM api_tokens t
           LEFT JOIN users u ON LOWER(u.email) = LOWER(t.user_email)
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > NOW())
          LIMIT 1`,
        [hash],
      );
      if (r.rows.length === 0) return res.status(401).json({ error: 'PAT ungueltig oder widerrufen' });
      const row = r.rows[0];
      req.user = {
        id: row.user_id, user_id: row.user_id,
        name: row.name, email: row.user_email, role: row.role,
        wohnung: row.wohnung, stweg: row.stweg,
        groups: (() => { try { return JSON.parse(row.groups_json || '[]'); } catch { return []; } })(),
      };
      req.user.isAdmin = req.user.role === 'admin' || req.user.groups.some(g => g.toLowerCase() === 'technik');
      req.pat = { id: row.id, name: row.name, scopes: row.scopes };
      // Scope-Check: wenn token.scopes gesetzt, prüfen ob aktueller Endpoint erlaubt
      if (Array.isArray(row.scopes) && row.scopes.length > 0) {
        const need = req.method === 'GET' ? 'read' : 'write';
        const path = req.path.replace(/\/api\//, '').split('/')[0] || 'root';
        const allowed = row.scopes.some(s => s === '*' || s === path + ':*' || s === path + ':' + need || s === 'all:' + need);
        if (!allowed) return res.status(403).json({ error: `PAT-Scope fehlt: ${path}:${need}` });
      }
      // last_used async (kein await damit Antwort nicht blockiert)
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
      pool.query('UPDATE api_tokens SET last_used_at=NOW(), last_used_ip=$1 WHERE id=$2', [ip, row.id]).catch(() => {});
      return auditCtx.run({ userEmail: req.user.email || 'pat:' + row.id }, next);
    }

    // 1. Try local session token first
    const result = await pool.query(
      `SELECT s.user_id, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user.id = req.user.user_id; // Ensure both .id and .user_id are set consistently
      req.user.isAdmin = req.user.role === 'admin';
      req.user.groups = (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
      return auditCtx.run({ userEmail: req.user.email || req.user.name || 'unknown' }, next);
    }

    // 2. Try Authentik OAuth2 token
    if (AUTHENTIK_CLIENT_ID) {
      const user = await validateAuthentikToken(token);
      if (user) {
        req.user = user;
        return auditCtx.run({ userEmail: user.email || user.name || 'unknown' }, next);
      }
    }

    return res.status(401).json({ error: 'Session abgelaufen' });
  } catch (err) {
    console.error('[auth] error:', err.message);
    res.status(500).json({ error: 'Auth-Fehler' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  next();
}

function requirePermission(page, level = 'read') {
  return async (req, res, next) => {
    const groups = req.user.groups || (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
    // Technik and Präsident always have full access
    if (groups.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) return next();

    try {
      const allGroups = await resolveAncestorGroups(groups);
      const result = await pool.query(
        'SELECT access FROM permissions WHERE LOWER(group_name) = ANY($1) AND page = $2',
        [allGroups, page]
      );
      const maxAccess = result.rows.reduce((max, r) => Math.max(max, ACCESS_LEVELS[r.access] || 0), 0);
      if (maxAccess >= (ACCESS_LEVELS[level] || 0)) return next();
    } catch (err) {
      console.error('Permission check error:', err);
    }
    res.status(403).json({ error: 'Keine Berechtigung' });
  };
}

// PATs werden NUR via Authentik-/Session-Login erstellt/widerrufen (nicht via PAT
// selbst), damit ein kompromittierter PAT keine neuen PATs anlegen oder andere
// widerrufen kann. Wir checken req.pat (gesetzt durch PAT-Auth) und lehnen ab.
function requireUserLogin(req, res, next) {
  if (req.pat) return res.status(403).json({ error: 'Token-Verwaltung nur via Browser-Login (Authentik) möglich' });
  next();
}

module.exports = { authMiddleware, adminOnly, requirePermission, requireUserLogin };
