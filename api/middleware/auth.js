// Auth-Middleware — aus server.js ausgelagert (Router-Split). LOGIN-KRITISCH:
// authMiddleware authentifiziert PAT / Session / Authentik-Token pro Request.
// Helfer (validateAuthentikToken, resolveAncestorGroups, ACCESS_LEVELS) kommen
// aus lib/auth; pool + auditCtx aus lib/db; AUTHENTIK_CLIENT_ID aus lib/config.
const crypto = require('crypto');
const { pool, auditCtx } = require('../lib/db');
const { AUTHENTIK_CLIENT_ID } = require('../lib/config');
const { validateAuthentikToken, resolveAncestorGroups, ACCESS_LEVELS } = require('../lib/auth');

// Pfade, die einen Ausweis erzeugen oder ändern — für Zugangstoken tabu.
// Relativ zu /api/, Präfix-Vergleich auf Segmentgrenze.
const PAT_GESPERRT = [
  'change-password',      // Passwort — das eigentliche Loch, siehe unten
  'me/tokens',            // weitere Token
  'me/passkeys',          // Passkeys
  'auth',                 // OAuth-Fluss, Profil-Login
  'mqtt/my-app-passwords',// MQTT-Zugangsdaten
];

// Scope-Grammatik. Ein Token ohne Scopes hat alle Rechte der Person.
// pfad ist relativ zu /api/ ("wasch/reservations"); GET zählt als read,
// alles andere als write. Wird auch vom MCP-Server benutzt, um die
// Werkzeugliste je Token zu filtern — dieselbe Regel an beiden Stellen.
function scopeErlaubt(scopes, pfad, method) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  const need = method === 'GET' ? 'read' : 'write';
  const teile = String(pfad || '').split('/').filter(Boolean);
  const segment = teile[0] || 'root';
  const unter = teile.length > 1 ? segment + '/' + teile[1] : null;
  const passt = (s, name) => s === name + ':*' || s === name + ':' + need;
  return scopes.some(s => s === '*' || s === 'all:' + need || passt(s, segment) || (unter && passt(s, unter)));
}

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
      // Innerhalb eines Routers (/api/ssh, /api/stations …) ist req.path nur der
      // Rest hinter dem Mount — der Scope-Check würde dort das falsche Segment
      // lesen. baseUrl + path ergibt in beiden Fällen den vollen Pfad.
      const vollerPfad = ((req.baseUrl || '') + req.path).replace(/^\/api\//, '');
      // Ein Token darf nie ändern, womit man sich anmeldet. Token, Passkeys
      // und MQTT-Zugangsdaten schützt requireUserLogin an der Route schon;
      // /change-password hatte diese Sperre nicht und verlangt das alte
      // Passwort nicht — ein geleakter Token hätte das Konto übernehmen
      // können. Die Liste hier gilt zentral, unabhängig davon, ob jemand an
      // der Route daran denkt. SSH-Schlüssel bewusst nicht: requireUserLogin
      // sperrt sie ohnehin, und ein Agent, der sich seinen Shell-Zugang selbst
      // einrichtet, wäre ein gewollter Anwendungsfall (Entscheid 5.9.2026).
      if (PAT_GESPERRT.some(pfx => vollerPfad === pfx || vollerPfad.startsWith(pfx + '/'))) {
        return res.status(403).json({ error: 'Mit einem Zugangstoken nicht erlaubt — nur angemeldet im Profil' });
      }
      // Scope-Check: wenn token.scopes gesetzt, prüfen ob aktueller Endpoint erlaubt.
      // Grammatik: "*", "all:read|write", "segment:*", "segment:read|write" — und
      // feiner "segment/unter:…" (z. B. "isp/vpn-accounts:read"), damit ein Token
      // nicht gleich alle 79 ISP-Endpunkte bekommt, wenn er nur sein VPN-Profil will.
      // Der MCP-Transport (/mcp) liegt nicht unter /api/ und ist kein
      // Bereich, den ein Scope benennt. Die Scopes greifen dort an den
      // Loopback-Aufrufen der Werkzeuge — die Route sagt das mit req.scopeAmZiel.
      if (!req.scopeAmZiel && !scopeErlaubt(row.scopes, vollerPfad, req.method)) {
        const segment = vollerPfad.split('/').filter(Boolean)[0] || 'root';
        return res.status(403).json({ error: `PAT-Scope fehlt: ${segment}:${req.method === 'GET' ? 'read' : 'write'}` });
      }
      // last_used async (kein await damit Antwort nicht blockiert)
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
      pool.query('UPDATE api_tokens SET last_used_at=NOW(), last_used_ip=$1 WHERE id=$2', [ip, row.id]).catch(() => {});
      return auditCtx.run({ userEmail: req.user.email || 'pat:' + row.id }, next);
    }

    // 1. Try local session token first
    const result = await pool.query(
      `SELECT s.user_id, s.expires_at, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user.id = req.user.user_id; // Ensure both .id and .user_id are set consistently
      req.user.isAdmin = req.user.role === 'admin';
      req.user.groups = (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
      // Sliding-Expiry: aktive Sessions automatisch verlaengern (kein staendiges
      // Neu-Anmelden). Nur schreiben wenn die Session naeher als 1 Tag an ihre
      // 30-Tage-Marke gerueckt ist -> max. 1 DB-Write pro Tag/Session, non-blocking.
      const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const exp = new Date(req.user.expires_at).getTime();
      if (exp < Date.now() + SESSION_TTL_MS - 24 * 60 * 60 * 1000) {
        pool.query('UPDATE sessions SET expires_at = $1 WHERE token = $2',
          [new Date(Date.now() + SESSION_TTL_MS), token]).catch(() => {});
      }
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

module.exports = { authMiddleware, adminOnly, requirePermission, requireUserLogin, scopeErlaubt };
