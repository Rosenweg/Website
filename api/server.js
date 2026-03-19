const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

// STWEG group mapping (Authentik group names per STWEG)
const STWEG_GROUPS = {
  1: { bewohner: 'stweg1-bewohner', eigentuemer: 'stweg1-eigentuemer', ausschuss: 'stweg1-ausschuss' },
  2: { bewohner: 'stweg2-bewohner', eigentuemer: 'stweg2-eigentuemer', ausschuss: 'stweg2-ausschuss' },
  3: { bewohner: 'r9-bewohner', eigentuemer: 'r9-eigentuemer', ausschuss: 'stweg3-ausschuss' },
  4: { bewohner: 'stweg4-bewohner', eigentuemer: 'stweg4-eigentuemer', ausschuss: 'stweg4-ausschuss' },
  5: { bewohner: 'stweg5-bewohner', eigentuemer: 'stweg5-eigentuemer', ausschuss: 'stweg5-ausschuss' },
  6: { bewohner: 'r1-bewohner', eigentuemer: 'r1-eigentuemer', ausschuss: 'stweg6-ausschuss' },
  7: { bewohner: 'stweg7-bewohner', eigentuemer: 'stweg7-eigentuemer', ausschuss: 'stweg7-ausschuss' },
  8: { ausschuss: 'stweg8-ausschuss' },
};

const app = express();

// Raw body parser for email inbound and document uploads (must be before json parser)
app.use('/api/email/inbound', express.raw({ type: '*/*', limit: '25mb' }));
app.use('/api/documents', express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));

// ─── Database ───────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rosenweg',
  user: process.env.DB_USER || 'rosenweg',
  password: process.env.DB_PASSWORD || 'changeme',
});

// ─── Energy Database (for Waschküche billing) ──────────────────────
const energyPool = new Pool({
  host: process.env.ENERGY_DB_HOST || 'energy-db',
  port: process.env.ENERGY_DB_PORT || 5432,
  database: process.env.ENERGY_DB_NAME || 'energy',
  user: process.env.ENERGY_DB_USER || 'energy',
  password: process.env.ENERGY_DB_PASSWORD || 'energy2026',
});

// ─── SMTP (SMTP2GO) ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.smtp2go.com',
  port: parseInt(process.env.SMTP_PORT || '2525'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

const MAIL_FROM = process.env.MAIL_FROM || 'noreply@rosenweg4303.ch';
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY || '';
const SMTP2GO_API_URL = 'https://eu-api.smtp2go.com/v3';

// ─── Helpers ────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// ─── Health ─────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// OTP ENDPOINTS (replaces n8n stweg3-otp, send-otp, verify-otp)
// ═══════════════════════════════════════════════════════════════════

app.post('/api/otp/send', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  try {
    // Check if email is authorized
    const userResult = await pool.query(
      'SELECT id, name, email, role FROM users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );
    if (userResult.rows.length === 0) {
      return res.status(403).json({ error: 'E-Mail-Adresse nicht berechtigt' });
    }

    const user = userResult.rows[0];
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Invalidate old OTPs
    await pool.query(
      'UPDATE otp_codes SET used = true WHERE email = $1 AND used = false',
      [email.toLowerCase().trim()]
    );

    // Store new OTP
    await pool.query(
      'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
      [email.toLowerCase().trim(), code, expiresAt]
    );

    // Send email
    await transporter.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: 'Ihr Anmeldecode - Rosenweg',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1e40af;">Rosenweg Login</h2>
          <p>Hallo ${user.name},</p>
          <p>Ihr Anmeldecode lautet:</p>
          <div style="background: #f0f9ff; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${code}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Der Code ist 10 Minuten gültig.</p>
        </div>
      `,
    });

    res.json({ success: true, message: 'OTP wurde per E-Mail gesendet' });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Fehler beim Senden des OTP-Codes' });
  }
});

app.post('/api/otp/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'E-Mail und Code erforderlich' });

  try {
    const result = await pool.query(
      `SELECT o.id, o.code, o.expires_at, u.id as user_id, u.name, u.email, u.role, u.wohnung, u.stweg
       FROM otp_codes o
       JOIN users u ON u.email = o.email
       WHERE o.email = $1 AND o.used = false
       ORDER BY o.created_at DESC LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Kein OTP gefunden. Bitte fordern Sie einen neuen Code an.' });
    }

    const row = result.rows[0];

    if (new Date() > new Date(row.expires_at)) {
      await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [row.id]);
      return res.status(400).json({ error: 'OTP-Code ist abgelaufen.' });
    }

    if (row.code !== code.trim()) {
      return res.status(400).json({ error: 'Ungültiger OTP-Code' });
    }

    // Mark as used
    await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [row.id]);

    // Create session token
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, row.user_id, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

    res.json({
      success: true,
      token,
      user: {
        id: row.user_id,
        name: row.name,
        email: row.email,
        role: row.role,
        wohnung: row.wohnung,
        stweg: row.stweg,
        isAdmin: row.role === 'admin',
      },
    });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Fehler bei der Verifizierung' });
  }
});

// ─── Authentik OAuth2 Config ─────────────────────────────────────────
const AUTHENTIK_URL = process.env.AUTHENTIK_URL || 'https://authentik-server:9443';
const AUTHENTIK_EXTERNAL_URL = process.env.AUTHENTIK_EXTERNAL_URL || 'https://authentik.rosenweg4303.ch';
const AUTHENTIK_CLIENT_ID = process.env.AUTHENTIK_CLIENT_ID || '';
const AUTHENTIK_CLIENT_SECRET = process.env.AUTHENTIK_CLIENT_SECRET || '';
const AUTHENTIK_API_TOKEN = process.env.AUTHENTIK_API_TOKEN || '';
const SITE_URL = process.env.SITE_URL || 'https://www.rosenweg4303.ch';

// ═══════════════════════════════════════════════════════════════════
// AUTHENTIK OAuth2 LOGIN
// ═══════════════════════════════════════════════════════════════════

// Returns the Authentik authorize URL for the frontend to redirect to
app.get('/api/auth/login', (req, res) => {
  const { redirect } = req.query;
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SITE_URL}/api/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: AUTHENTIK_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state: `${state}:${redirect || '/'}`,
  });
  res.redirect(`${AUTHENTIK_EXTERNAL_URL}/application/o/authorize/?${params}`);
});

// Logout - end Authentik session and redirect back
app.get('/api/auth/logout', (req, res) => {
  const { redirect } = req.query;
  const postLogoutRedirect = redirect || SITE_URL;
  const params = new URLSearchParams({
    post_logout_redirect_uri: postLogoutRedirect,
    client_id: AUTHENTIK_CLIENT_ID,
  });
  res.redirect(`${AUTHENTIK_EXTERNAL_URL}/application/o/rosenweg-website/end-session/?${params}`);
});

// OAuth2 callback - exchanges code for token, creates session, redirects back
app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Kein Authorization Code erhalten');

  const redirectPath = state?.split(':').slice(1).join(':') || '/';

  try {
    // Exchange code for token
    const tokenUrl = `${AUTHENTIK_EXTERNAL_URL}/application/o/token/`;
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${SITE_URL}/api/auth/callback`,
      client_id: AUTHENTIK_CLIENT_ID,
      client_secret: AUTHENTIK_CLIENT_SECRET,
    }).toString();
    console.log('Token exchange URL:', tokenUrl);
    console.log('Redirect URI:', `${SITE_URL}/api/auth/callback`);
    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
      signal: AbortSignal.timeout(10000),
    });
    const tokenText = await tokenResp.text();
    console.log('Token response status:', tokenResp.status, 'body:', tokenText.substring(0, 500));
    const tokenData = tokenText ? JSON.parse(tokenText) : {};
    if (!tokenData.access_token) {
      console.error('Token exchange failed:', tokenData);
      return res.status(400).send('Token-Austausch fehlgeschlagen');
    }

    // Get user info
    const userResp = await fetch(`${AUTHENTIK_EXTERNAL_URL}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    const userInfo = await userResp.json();

    const email = (userInfo.email || userInfo.sub).toLowerCase();
    const name = userInfo.name || userInfo.preferred_username || email;
    const groups = userInfo.groups || [];
    const isAdmin = groups.some(g => g.toLowerCase() === 'technik');

    // Create/update user in DB
    const userResult = await pool.query(
      `INSERT INTO users (email, name, role, groups_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, groups_json = EXCLUDED.groups_json
       RETURNING id, email, name, wohnung, stweg, role, groups_json`,
      [email, name, isAdmin ? 'admin' : 'bewohner', JSON.stringify(groups)]
    );
    const user = userResult.rows[0];

    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [sessionToken, user.id, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

    // Fetch permissions for this user
    const permissions = await getUserPermissions(groups);

    // Redirect back to frontend with session token
    const userData = encodeURIComponent(JSON.stringify({
      token: sessionToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        wohnung: user.wohnung,
        stweg: user.stweg,
        isAdmin: user.role === 'admin',
        groups: groups,
        permissions: permissions,
      },
    }));
    res.redirect(`${SITE_URL}${redirectPath}#auth=${userData}`);
  } catch (err) {
    console.error('OAuth2 callback error:', err);
    res.status(500).send('Anmeldung fehlgeschlagen');
  }
});

// Cache for Authentik token introspection
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60 * 1000; // 1 minute

async function validateAuthentikToken(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.time < TOKEN_CACHE_TTL) return cached.user;

  try {
    const params = new URLSearchParams({
      token,
      client_id: AUTHENTIK_CLIENT_ID,
      client_secret: AUTHENTIK_CLIENT_SECRET,
    });
    const resp = await fetch(`${AUTHENTIK_EXTERNAL_URL}/application/o/introspect/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (!data.active) return null;

    // Map Authentik user to our user format, create/update in DB
    const email = data.email || data.sub;
    const name = data.name || data.preferred_username || email;

    const result = await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, wohnung, stweg, role`,
      [email.toLowerCase(), name, (data.groups?.some(g => g.toLowerCase() === 'technik')) ? 'admin' : 'bewohner']
    );
    const user = result.rows[0];
    user.isAdmin = user.role === 'admin';
    user.user_id = user.id;
    user.auth_source = 'authentik';
    user.groups = data.groups || [];

    tokenCache.set(token, { user, time: Date.now() });
    return user;
  } catch (err) {
    console.error('Authentik token validation error:', err.message);
    return null;
  }
}

// ─── Auth Middleware ─────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Nicht authentifiziert' });

  try {
    // 1. Try local session token first
    const result = await pool.query(
      `SELECT s.user_id, u.name, u.email, u.role, u.wohnung, u.stweg, u.groups_json
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user.isAdmin = req.user.role === 'admin';
      req.user.groups = (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
      return next();
    }

    // 2. Try Authentik OAuth2 token
    if (AUTHENTIK_CLIENT_ID) {
      const user = await validateAuthentikToken(token);
      if (user) {
        req.user = user;
        return next();
      }
    }

    return res.status(401).json({ error: 'Session abgelaufen' });
  } catch (err) {
    res.status(500).json({ error: 'Auth-Fehler' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  next();
}

function canManageDocs(req, res, next) {
  const groups = req.user?.groups || [];
  const allowed = groups.some(g => {
    const gl = g.toLowerCase();
    return gl === 'technik' || gl.endsWith('-ausschuss');
  });
  if (!allowed) return res.status(403).json({ error: 'Nur Technik und Ausschuss dürfen Dokumente verwalten' });
  next();
}

/** Get STWEG numbers a user belongs to based on their groups */
function getUserStwegs(groups) {
  const stwegs = new Set();
  for (const [nr, mapping] of Object.entries(STWEG_GROUPS)) {
    const groupNames = Object.values(mapping).map(g => g.toLowerCase());
    if (groups.some(g => groupNames.includes(g.toLowerCase()))) {
      stwegs.add(parseInt(nr));
    }
  }
  return stwegs;
}

/** Check if user is Technik (full access to all folders) */
function isTechnik(groups) {
  return groups.some(g => g.toLowerCase() === 'technik');
}

/** Check if a document path is allowed for a user */
function isDocPathAllowed(filePath, groups) {
  if (isTechnik(groups)) return true;
  const folder = filePath.includes('/') ? filePath.split('/')[0] : 'allgemein';
  if (folder === 'allgemein') return true;
  const stwegs = getUserStwegs(groups);
  const match = folder.match(/^stweg(\d+)$/);
  return match && stwegs.has(parseInt(match[1]));
}

/** Check if user can write to a document path */
function canWriteDocPath(filePath, groups) {
  if (isTechnik(groups)) return true;
  const folder = filePath.includes('/') ? filePath.split('/')[0] : 'allgemein';
  // Ausschuss members can write to their own stweg + allgemein
  const isAusschuss = groups.some(g => g.toLowerCase().endsWith('-ausschuss'));
  if (!isAusschuss) return false;
  if (folder === 'allgemein') return true;
  const stwegs = getUserStwegs(groups);
  const match = folder.match(/^stweg(\d+)$/);
  return match && stwegs.has(parseInt(match[1]));
}

/** Middleware: require user to have access to the :stweg param (Technik=all, Ausschuss/Bewohner=own STWEG) */
function requireStwegAccess(req, res, next) {
  const stweg = parseInt(req.params.stweg);
  const groups = req.user?.groups || [];
  if (isTechnik(groups)) return next();
  const stwegGroups = STWEG_GROUPS[stweg];
  if (!stwegGroups) return res.status(404).json({ error: 'STWEG nicht gefunden' });
  const userGroupsLower = groups.map(g => g.toLowerCase());
  const hasAccess = Object.values(stwegGroups).some(g => userGroupsLower.includes(g.toLowerCase()));
  if (!hasAccess) return res.status(403).json({ error: 'Kein Zugriff auf diese STWEG' });
  next();
}

// ─── Permission System ──────────────────────────────────────────────
const MANAGED_PAGES = [
  { id: 'bewohner-verwaltung', label: 'Bewohner-Verwaltung' },
  { id: 'energie-monitor', label: 'Energie-Monitor' },
  { id: 'energie-config', label: 'Energie-Konfiguration' },
  { id: 'email-verteiler', label: 'E-Mail-Verteiler' },
  { id: 'zaehler', label: 'Zähler & Verbrauch' },
  { id: 'waschkueche', label: 'Waschküche' },
  { id: 'waschkueche-admin', label: 'Waschküche-Admin' },
  { id: 'kontakte', label: 'Kontakte' },
  { id: 'verwaltung', label: 'Verwaltung' },
  { id: 'rechteverwaltung', label: 'Rechteverwaltung' },
  { id: 'wohnungsverwaltung', label: 'Wohnungsverwaltung' },
];

const ACCESS_LEVELS = { none: 0, read: 1, write: 2 };

// Resolve user's direct groups to include all ancestor groups via Authentik hierarchy
// Caches the group hierarchy for 5 minutes
let _groupHierarchyCache = null;
let _groupHierarchyCacheTime = 0;
const GROUP_HIERARCHY_TTL = 5 * 60 * 1000;

async function resolveAncestorGroups(directGroupNames) {
  // Fetch and cache group hierarchy from Authentik
  const now = Date.now();
  if (!_groupHierarchyCache || now - _groupHierarchyCacheTime > GROUP_HIERARCHY_TTL) {
    try {
      const data = await authentikAPI('GET', '/core/groups/?page_size=500');
      const groups = data.results || data;
      // Build name->parent_name lookup
      const byPk = {};
      for (const g of groups) byPk[g.pk] = g;
      const parentNameOf = {};
      for (const g of groups) {
        if (g.parent && byPk[g.parent]) {
          parentNameOf[g.name.toLowerCase()] = byPk[g.parent].name.toLowerCase();
        }
      }
      _groupHierarchyCache = parentNameOf;
      _groupHierarchyCacheTime = now;
    } catch (err) {
      console.error('Failed to fetch group hierarchy:', err.message);
      // Fall back to direct groups only
      return directGroupNames.map(g => g.toLowerCase());
    }
  }

  // Walk up parent chain for each group
  const result = new Set(directGroupNames.map(g => g.toLowerCase()));
  for (const name of directGroupNames) {
    let current = name.toLowerCase();
    while (_groupHierarchyCache[current]) {
      const parent = _groupHierarchyCache[current];
      if (result.has(parent)) break;
      result.add(parent);
      current = parent;
    }
  }
  return [...result];
}

function requirePermission(page, level = 'read') {
  return async (req, res, next) => {
    const groups = req.user.groups || (() => { try { return JSON.parse(req.user.groups_json || '[]'); } catch { return []; } })();
    // Technik always has full access
    if (groups.some(g => g.toLowerCase() === 'technik')) return next();

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

async function getUserPermissions(groups) {
  const permissions = {};
  // Technik gets write on everything
  if (groups.some(g => g.toLowerCase() === 'technik')) {
    for (const p of MANAGED_PAGES) permissions[p.id] = 'write';
    return permissions;
  }
  try {
    const allGroups = await resolveAncestorGroups(groups);
    const result = await pool.query(
      'SELECT page, access FROM permissions WHERE LOWER(group_name) = ANY($1)',
      [allGroups]
    );
    for (const row of result.rows) {
      const current = ACCESS_LEVELS[permissions[row.page]] || 0;
      if ((ACCESS_LEVELS[row.access] || 0) > current) {
        permissions[row.page] = row.access;
      }
    }
  } catch (err) {
    console.error('getUserPermissions error:', err);
  }
  return permissions;
}

// ─── Permission API ─────────────────────────────────────────────────
app.get('/api/permissions/pages', authMiddleware, requirePermission('rechteverwaltung', 'read'), (req, res) => {
  res.json({ pages: MANAGED_PAGES });
});

app.get('/api/permissions', authMiddleware, requirePermission('rechteverwaltung', 'read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT group_name, page, access FROM permissions ORDER BY group_name, page');
    res.json({ permissions: result.rows, pages: MANAGED_PAGES });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Berechtigungen' });
  }
});

app.put('/api/permissions', authMiddleware, requirePermission('rechteverwaltung', 'write'), async (req, res) => {
  const { permissions } = req.body; // [{ group_name, page, access }]
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions Array erforderlich' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of permissions) {
      if (!p.group_name || !p.page || !['none', 'read', 'write'].includes(p.access)) continue;
      if (p.access === 'none') {
        await client.query('DELETE FROM permissions WHERE group_name = $1 AND page = $2', [p.group_name, p.page]);
      } else {
        await client.query(
          `INSERT INTO permissions (group_name, page, access) VALUES ($1, $2, $3)
           ON CONFLICT (group_name, page) DO UPDATE SET access = EXCLUDED.access`,
          [p.group_name, p.page, p.access]
        );
      }
    }
    await client.query('COMMIT');
    const result = await pool.query('SELECT group_name, page, access FROM permissions ORDER BY group_name, page');
    res.json({ success: true, permissions: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Permission update error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  } finally {
    client.release();
  }
});

// Get current user from session token
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const result = await pool.query(
    'SELECT id, email, name, wohnung, stweg, role, phone, strasse, plz, ort, groups_json, avatar_url FROM users WHERE id = $1',
    [userId]
  );
  const u = result.rows[0] || req.user;
  const groups = (() => { try { return JSON.parse(u.groups_json || '[]'); } catch { return []; } })();

  // Fetch user's assigned meters
  let meters = [];
  try {
    const meterResult = await pool.query(
      `SELECT zc.zaehler_id, zc.bezeichnung, zc.typ, zc.standort, zc.einheit
       FROM zaehler_config zc
       WHERE zc.user_id = $1 AND zc.active = true
       ORDER BY zc.bezeichnung`,
      [userId]
    );
    meters = meterResult.rows;
  } catch { /* table may not exist yet */ }

  // Fetch user's effective permissions
  const permissions = await getUserPermissions(groups);

  res.json({
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      wohnung: u.wohnung,
      stweg: u.stweg,
      phone: u.phone,
      strasse: u.strasse,
      plz: u.plz,
      ort: u.ort,
      avatar_url: u.avatar_url,
      isAdmin: u.role === 'admin',
      groups: groups,
      meters: meters,
      permissions: permissions,
    },
  });
});

// Update own profile
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const { name, wohnung, stweg, phone, strasse, plz, ort } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), wohnung = $2, stweg = $3,
       phone = $4, strasse = $5, plz = $6, ort = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING id, email, name, wohnung, stweg, role, phone, strasse, plz, ort`,
      [name, wohnung || null, stweg || null, phone || null, strasse || null, plz || null, ort || null, userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Profil konnte nicht gespeichert werden' });
  }
});

// Upload avatar (base64) and sync to Authentik
app.put('/api/auth/avatar', authMiddleware, async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const { avatar } = req.body; // base64 data URL e.g. "data:image/png;base64,..."
  if (!avatar) return res.status(400).json({ error: 'Kein Avatar-Bild' });

  try {
    // Store in DB
    await pool.query('UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatar, userId]);

    // Sync to Authentik: get user email, find Authentik user, set avatar attribute
    const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (userRow.rows[0] && AUTHENTIK_API_TOKEN) {
      const email = userRow.rows[0].email;
      try {
        const searchData = await authentikAPI('GET', `/core/users/?search=${encodeURIComponent(email)}`);
        const akUser = searchData.results?.find(u => u.email === email);
        if (akUser) {
          await authentikAPI('PATCH', `/core/users/${akUser.pk}/`, {
            attributes: { ...akUser.attributes, avatar: avatar },
          });
        }
      } catch (akErr) {
        console.error('Authentik avatar sync error:', akErr.message);
        // non-fatal, avatar is still saved locally
      }
    }

    res.json({ success: true, avatar_url: avatar });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Avatar konnte nicht gespeichert werden' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════

app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, wohnung, stweg, role, balance, active FROM users ORDER BY stweg, wohnung'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Benutzer' });
  }
});

app.get('/api/users/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, wohnung, stweg, role, balance FROM users WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});


// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - RÄUME
// ═══════════════════════════════════════════════════════════════════

app.get('/api/wasch/rooms', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wasch_rooms WHERE active = true ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Räume' });
  }
});

app.post('/api/wasch/rooms', authMiddleware, adminOnly, async (req, res) => {
  const { name, location, energy_meter_id, unifi_door_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const result = await pool.query(
      `INSERT INTO wasch_rooms (name, location, energy_meter_id, unifi_door_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, location || '', energy_meter_id || null, unifi_door_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/wasch/rooms/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, location, energy_meter_id, unifi_door_id, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE wasch_rooms SET name=COALESCE($2,name), location=COALESCE($3,location),
       energy_meter_id=$4, unifi_door_id=$5, active=COALESCE($6,active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, location, energy_meter_id || null, unifi_door_id || null, active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Raum nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - RESERVIERUNGEN (minutengenau)
// ═══════════════════════════════════════════════════════════════════

// Get all reservations (optionally filter by ?room_id=X and ?from=ISO&to=ISO)
app.get('/api/wasch/reservations', authMiddleware, async (req, res) => {
  try {
    const { room_id, from, to } = req.query;
    let query = `SELECT r.*, u.name as user_name, u.wohnung, rm.name as room_name
       FROM wasch_reservations r
       JOIN users u ON u.id = r.user_id
       JOIN wasch_rooms rm ON rm.id = r.room_id
       WHERE r.cancelled = false`;
    const params = [];
    if (room_id) { params.push(room_id); query += ` AND r.room_id = $${params.length}`; }
    if (from) { params.push(from); query += ` AND r.end_time >= $${params.length}::timestamp`; }
    if (to) { params.push(to); query += ` AND r.start_time <= $${params.length}::timestamp`; }
    if (!from && !to) { query += ' AND r.end_time >= NOW()'; }
    query += ' ORDER BY r.start_time';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Reservierungen' });
  }
});

// Create reservation (one-time or recurring weekly)
app.post('/api/wasch/reservations', authMiddleware, async (req, res) => {
  const { room_id, start_time, end_time, recurring, recurring_until } = req.body;
  if (!room_id || !start_time || !end_time) {
    return res.status(400).json({ error: 'room_id, start_time und end_time erforderlich' });
  }

  const startDt = new Date(start_time);
  const endDt = new Date(end_time);
  if (endDt <= startDt) return res.status(400).json({ error: 'end_time muss nach start_time liegen' });

  // Duration in minutes
  const durationMin = (endDt - startDt) / 60000;
  if (durationMin < 30) return res.status(400).json({ error: 'Mindestdauer: 30 Minuten' });
  if (durationMin > 720) return res.status(400).json({ error: 'Maximaldauer: 12 Stunden' });

  try {
    if (recurring && recurring_until) {
      // Generate weekly recurring reservations (same weekday, same time)
      const created = [];
      const until = new Date(recurring_until);
      let curStart = new Date(startDt);
      let curEnd = new Date(endDt);

      while (curStart <= until) {
        // Check overlap with existing reservations
        const conflict = await pool.query(
          `SELECT id FROM wasch_reservations
           WHERE room_id=$1 AND cancelled=false
           AND start_time < $3::timestamp AND end_time > $2::timestamp`,
          [room_id, curStart.toISOString(), curEnd.toISOString()]
        );
        if (conflict.rows.length === 0) {
          const result = await pool.query(
            `INSERT INTO wasch_reservations (user_id, room_id, start_time, end_time, recurring, recurring_until)
             VALUES ($1, $2, $3, $4, true, $5) RETURNING *`,
            [req.user.user_id, room_id, curStart.toISOString(), curEnd.toISOString(), recurring_until]
          );
          created.push(result.rows[0]);
        }
        curStart.setDate(curStart.getDate() + 7);
        curEnd.setDate(curEnd.getDate() + 7);
      }
      res.json({ created: created.length, reservations: created });
    } else {
      // One-time reservation - check overlap
      const conflict = await pool.query(
        `SELECT id FROM wasch_reservations
         WHERE room_id=$1 AND cancelled=false
         AND start_time < $3::timestamp AND end_time > $2::timestamp`,
        [room_id, start_time, end_time]
      );
      if (conflict.rows.length > 0) return res.status(409).json({ error: 'Zeitraum überschneidet sich mit bestehender Reservierung' });

      const result = await pool.query(
        `INSERT INTO wasch_reservations (user_id, room_id, start_time, end_time)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.user_id, room_id, start_time, end_time]
      );
      res.json(result.rows[0]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Erstellen der Reservierung' });
  }
});

// My reservations (upcoming)
app.get('/api/wasch/my/reservations', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, rm.name as room_name
       FROM wasch_reservations r
       JOIN wasch_rooms rm ON rm.id = r.room_id
       WHERE r.user_id = $1 AND r.cancelled = false AND r.end_time >= NOW()
       ORDER BY r.start_time`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Cancel reservation (own or admin)
app.delete('/api/wasch/reservations/:id', authMiddleware, async (req, res) => {
  try {
    let query = 'UPDATE wasch_reservations SET cancelled = true WHERE id = $1';
    const params = [req.params.id];
    if (!req.user.isAdmin) {
      query += ' AND user_id = $2';
      params.push(req.user.user_id);
    }
    query += ' RETURNING *';
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Reservierung nicht gefunden' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Cancel all recurring reservations from a series (future only)
app.delete('/api/wasch/reservations/:id/series', authMiddleware, async (req, res) => {
  try {
    const reservation = await pool.query(
      'SELECT * FROM wasch_reservations WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.user_id]
    );
    if (reservation.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const r = reservation.rows[0];
    if (!r.recurring) return res.status(400).json({ error: 'Keine wiederkehrende Reservierung' });
    const result = await pool.query(
      `UPDATE wasch_reservations SET cancelled = true
       WHERE user_id=$1 AND room_id=$2 AND recurring_until=$3
       AND start_time >= NOW() AND cancelled=false`,
      [req.user.user_id, r.room_id, r.recurring_until]
    );
    res.json({ success: true, cancelled: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - SESSIONS & VERBRAUCH
// ═══════════════════════════════════════════════════════════════════

// My sessions
app.get('/api/wasch/my/sessions', authMiddleware, async (req, res) => {
  try {
    const { month } = req.query; // optional: YYYY-MM
    let query = `SELECT s.*, rm.name as room_name
       FROM wasch_sessions s
       JOIN wasch_rooms rm ON rm.id = s.room_id
       WHERE s.user_id = $1`;
    const params = [req.user.user_id];
    if (month) {
      params.push(month + '-01');
      query += ` AND s.started_at >= $${params.length}::date AND s.started_at < ($${params.length}::date + interval '1 month')`;
    }
    query += ' ORDER BY s.started_at DESC LIMIT 50';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// My costs summary
app.get('/api/wasch/my/costs', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rm.name as room_name,
         COUNT(s.id) as sessions,
         COALESCE(SUM(s.energy_consumed), 0) as total_kwh,
         COALESCE(SUM(s.duration_minutes), 0) as total_minutes,
         COALESCE(SUM(cost), 0) as total_cost
       FROM wasch_sessions s
       JOIN wasch_rooms rm ON rm.id = s.room_id
       WHERE s.user_id = $1 AND s.status = 'completed'
       GROUP BY rm.name`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - ADMIN
// ═══════════════════════════════════════════════════════════════════

// Admin dashboard stats
app.get('/api/wasch/admin/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rooms = await pool.query('SELECT COUNT(*) FROM wasch_rooms WHERE active=true');
    const sessions = await pool.query(
      `SELECT COUNT(*) as total_sessions,
       COALESCE(SUM(energy_consumed),0) as total_kwh,
       COALESCE(SUM(duration_minutes),0) as total_minutes,
       COALESCE(SUM(cost),0) as total_cost FROM wasch_sessions WHERE status='completed'`
    );
    const topUsers = await pool.query(
      `SELECT u.name, u.wohnung, COUNT(s.id) as sessions,
       COALESCE(SUM(s.duration_minutes),0) as minutes,
       COALESCE(SUM(cost),0) as cost FROM wasch_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status='completed'
       GROUP BY u.name, u.wohnung ORDER BY cost DESC LIMIT 5`
    );
    res.json({
      rooms: parseInt(rooms.rows[0].count),
      ...sessions.rows[0],
      top_users: topUsers.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Admin: all sessions (with optional month filter)
app.get('/api/wasch/admin/sessions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { month } = req.query;
    let query = `SELECT s.*, u.name, u.wohnung, rm.name as room_name
       FROM wasch_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN wasch_rooms rm ON rm.id = s.room_id`;
    const params = [];
    if (month) {
      params.push(month + '-01');
      query += ` WHERE s.started_at >= $1::date AND s.started_at < ($1::date + interval '1 month')`;
    }
    query += ' ORDER BY s.started_at DESC LIMIT 200';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Admin: monthly cost breakdown per user
app.get('/api/wasch/admin/costs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { month } = req.query;
    const monthStr = month || new Date().toISOString().slice(0, 7);
    const result = await pool.query(
      `SELECT u.name, u.wohnung, u.email,
         COUNT(s.id) as sessions,
         COALESCE(SUM(s.energy_consumed), 0) as total_kwh,
         COALESCE(SUM(s.duration_minutes), 0) as total_minutes,
         COALESCE(SUM(s.cost), 0) as total_cost
       FROM wasch_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'completed'
         AND s.started_at >= $1::date
         AND s.started_at < ($1::date + interval '1 month')
       GROUP BY u.name, u.wohnung, u.email
       ORDER BY total_cost DESC`,
      [monthStr + '-01']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Admin: billing overview
app.get('/api/wasch/admin/billing', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT b.*, u.name, u.wohnung, u.email FROM wasch_billing b JOIN users u ON u.id = b.user_id ORDER BY b.month DESC, u.name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Waschküche settings
app.get('/api/wasch/settings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wasch_settings ORDER BY key');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.put('/api/wasch/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `INSERT INTO wasch_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - MINUTENGENAUE ABRECHNUNG (Cron)
// ═══════════════════════════════════════════════════════════════════

async function getWaschSetting(key, defaultValue) {
  try {
    const result = await pool.query('SELECT value FROM wasch_settings WHERE key = $1', [key]);
    return result.rows.length > 0 ? result.rows[0].value : defaultValue;
  } catch { return defaultValue; }
}

// Process a completed reservation: read exact energy consumption from energy DB
async function processReservationEnd(reservation) {
  const room = await pool.query('SELECT * FROM wasch_rooms WHERE id = $1', [reservation.room_id]);
  if (room.rows.length === 0 || !room.rows[0].energy_meter_id) return;

  const meterId = room.rows[0].energy_meter_id;
  const startTime = new Date(reservation.start_time).toISOString();
  const endTime = new Date(reservation.end_time).toISOString();
  const durationMinutes = Math.round((new Date(reservation.end_time) - new Date(reservation.start_time)) / 60000);

  try {
    // Read exact consumption between reservation start and end from energy DB
    const consumption = await energyPool.query(
      `SELECT
         MIN(energy_import_kwh) AS start_kwh,
         MAX(energy_import_kwh) AS end_kwh,
         MAX(energy_import_kwh) - MIN(energy_import_kwh) AS consumption_kwh,
         COUNT(*) AS samples
       FROM readings
       WHERE meter_id = $1 AND ts >= $2 AND ts <= $3`,
      [meterId, startTime, endTime]
    );

    const data = consumption.rows[0];
    if (!data || data.consumption_kwh == null || parseInt(data.samples) < 2) return;

    const costPerKwh = parseFloat(await getWaschSetting('cost_per_kwh', '0.30'));
    const kwh = parseFloat(data.consumption_kwh) || 0;
    const cost = Math.round(kwh * costPerKwh * 100) / 100;

    // Create session with exact timestamps and duration
    await pool.query(
      `INSERT INTO wasch_sessions (user_id, room_id, reservation_id, status, started_at, ended_at, duration_minutes, energy_start_kwh, energy_end_kwh, energy_consumed, cost)
       VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [reservation.user_id, reservation.room_id, reservation.id,
       startTime, endTime, durationMinutes, data.start_kwh, data.end_kwh, kwh, cost]
    );

    console.log(`[Waschküche] Session created: reservation ${reservation.id}, ${durationMinutes}min, ${kwh.toFixed(3)}kWh, CHF ${cost.toFixed(2)}`);
  } catch (err) {
    console.error(`[Waschküche] processReservationEnd error for reservation ${reservation.id}:`, err.message);
  }
}

// Monthly billing: aggregate sessions and send detailed emails
async function runMonthlyBilling() {
  const now = new Date();
  const billingMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthStr = billingMonth.toISOString().slice(0, 7);
  const monthStart = monthStr + '-01';

  console.log(`[Waschküche] Running monthly billing for ${monthStr}`);

  try {
    const costPerKwh = parseFloat(await getWaschSetting('cost_per_kwh', '0.30'));

    const users = await pool.query(
      `SELECT u.id as user_id, u.name, u.email, u.wohnung,
         COUNT(s.id) as total_sessions,
         COALESCE(SUM(s.energy_consumed), 0) as total_kwh,
         COALESCE(SUM(s.duration_minutes), 0) as total_minutes,
         COALESCE(SUM(s.cost), 0) as total_cost
       FROM wasch_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'completed'
         AND s.started_at >= $1::date
         AND s.started_at < ($1::date + interval '1 month')
       GROUP BY u.id, u.name, u.email, u.wohnung
       HAVING COUNT(s.id) > 0`,
      [monthStart]
    );

    const monthNames = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    const monthName = monthNames[billingMonth.getMonth()];
    const year = billingMonth.getFullYear();

    for (const user of users.rows) {
      // Get individual sessions for detail view in email
      const sessions = await pool.query(
        `SELECT s.*, rm.name as room_name
         FROM wasch_sessions s
         JOIN wasch_rooms rm ON rm.id = s.room_id
         WHERE s.user_id = $1 AND s.status = 'completed'
           AND s.started_at >= $2::date AND s.started_at < ($2::date + interval '1 month')
         ORDER BY s.started_at`,
        [user.user_id, monthStart]
      );

      await pool.query(
        `INSERT INTO wasch_billing (user_id, month, total_sessions, total_kwh, cost_per_kwh, total_cost)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, month) DO UPDATE SET total_sessions=$3, total_kwh=$4, cost_per_kwh=$5, total_cost=$6`,
        [user.user_id, monthStart, user.total_sessions, user.total_kwh, costPerKwh, user.total_cost]
      );

      if (user.email) {
        // Build session detail rows for email
        const sessionRows = sessions.rows.map(s => {
          const start = new Date(s.started_at);
          const dateStr = `${start.getDate()}.${start.getMonth()+1}.${start.getFullYear()}`;
          const startStr = `${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`;
          const end = new Date(s.ended_at);
          const endStr = `${String(end.getHours()).padStart(2,'0')}:${String(end.getMinutes()).padStart(2,'0')}`;
          return `<tr>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${dateStr}</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${s.room_name}</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${startStr}-${endStr} (${s.duration_minutes} Min.)</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${parseFloat(s.energy_consumed).toFixed(3)} kWh</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right;">CHF ${parseFloat(s.cost).toFixed(2)}</td>
          </tr>`;
        }).join('');

        try {
          await transporter.sendMail({
            from: MAIL_FROM,
            to: user.email,
            subject: `Waschküche Abrechnung ${monthName} ${year} - STWEG 3`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
                <h2 style="color: #1a56db;">Waschküche Abrechnung</h2>
                <p>Hallo ${user.name},</p>
                <p>hier ist Ihre minutengenaue Waschküche-Abrechnung für <strong>${monthName} ${year}</strong>:</p>

                <h3 style="color:#374151;margin-top:24px;">Einzelnachweise</h3>
                <table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:0.9em;">
                  <thead>
                    <tr style="background:#f3f4f6;">
                      <th style="padding:8px 10px;border:1px solid #e5e7eb;text-align:left;">Datum</th>
                      <th style="padding:8px 10px;border:1px solid #e5e7eb;text-align:left;">Raum</th>
                      <th style="padding:8px 10px;border:1px solid #e5e7eb;text-align:left;">Zeit (Dauer)</th>
                      <th style="padding:8px 10px;border:1px solid #e5e7eb;text-align:left;">Verbrauch</th>
                      <th style="padding:8px 10px;border:1px solid #e5e7eb;text-align:right;">Kosten</th>
                    </tr>
                  </thead>
                  <tbody>${sessionRows}</tbody>
                </table>

                <h3 style="color:#374151;margin-top:24px;">Zusammenfassung</h3>
                <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
                  <tr style="background: #f3f4f6;">
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">Wohnung</td>
                    <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: bold;">${user.wohnung || '-'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">Anzahl Waschgänge</td>
                    <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: bold;">${user.total_sessions}</td>
                  </tr>
                  <tr style="background: #f3f4f6;">
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">Gesamtdauer</td>
                    <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: bold;">${Math.floor(user.total_minutes / 60)}h ${user.total_minutes % 60}min</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">Gesamtverbrauch</td>
                    <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: bold;">${parseFloat(user.total_kwh).toFixed(2)} kWh</td>
                  </tr>
                  <tr style="background: #f3f4f6;">
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">Tarif</td>
                    <td style="padding: 10px; border: 1px solid #e5e7eb;">CHF ${costPerKwh.toFixed(2)} / kWh</td>
                  </tr>
                  <tr style="background: #1a56db; color: white;">
                    <td style="padding: 12px; border: 1px solid #1a56db; font-weight: bold;">Gesamtbetrag</td>
                    <td style="padding: 12px; border: 1px solid #1a56db; font-weight: bold; font-size: 1.2em;">CHF ${parseFloat(user.total_cost).toFixed(2)}</td>
                  </tr>
                </table>
                <p style="color: #6b7280; font-size: 0.9em;">
                  Der Betrag wird mit der nächsten Nebenkostenabrechnung verrechnet.
                </p>
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="color: #9ca3af; font-size: 0.8em;">
                  STWEG 3 - Rosenweg 9, 4303 Kaiseraugst<br>
                  Minutengenaue Abrechnung basierend auf tatsächlichem Stromverbrauch.<br>
                  Diese Email wurde automatisch generiert.
                </p>
              </div>
            `,
          });

          await pool.query(
            'UPDATE wasch_billing SET email_sent = true, email_sent_at = NOW() WHERE user_id = $1 AND month = $2',
            [user.user_id, monthStart]
          );
          console.log(`[Waschküche] Billing email sent to ${user.email} for ${monthStr}`);
        } catch (emailErr) {
          console.error(`[Waschküche] Email to ${user.email} failed:`, emailErr.message);
        }
      }
    }

    console.log(`[Waschküche] Monthly billing complete: ${users.rows.length} users billed`);
  } catch (err) {
    console.error('[Waschküche] Monthly billing error:', err.message);
  }
}

// Cron: process completed reservations (runs every 5 min for minute-precision)
async function processCompletedReservations() {
  try {
    const now = new Date();

    // Find reservations whose end_time has passed and have no session yet
    // Look back up to 7 days for any missed reservations
    const reservations = await pool.query(
      `SELECT r.* FROM wasch_reservations r
       WHERE r.end_time <= $1 AND r.cancelled = false
       AND NOT EXISTS (SELECT 1 FROM wasch_sessions s WHERE s.reservation_id = r.id)
       AND r.end_time >= NOW() - interval '7 days'`,
      [now.toISOString()]
    );

    for (const reservation of reservations.rows) {
      await processReservationEnd(reservation);
    }

    if (reservations.rows.length > 0) {
      console.log(`[Waschküche] Processed ${reservations.rows.length} completed reservations`);
    }
  } catch (err) {
    console.error('[Waschküche] processCompletedReservations error:', err.message);
  }
}

// Schedule: process reservations every 5 min, door access every 1 min, monthly billing on 1st at 08:00
let waschCronInterval;
function startWaschCron() {
  // Process completed reservations & billing every 5 min
  waschCronInterval = setInterval(processCompletedReservations, 5 * 60 * 1000);
  setTimeout(processCompletedReservations, 30 * 1000);

  // Door access control every minute (quick check, no-op if disabled)
  setInterval(manageDoorAccess, 60 * 1000);
  setTimeout(manageDoorAccess, 10 * 1000);

  // Monthly billing on 1st at 08:00
  setInterval(() => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 8 && now.getMinutes() < 5) {
      runMonthlyBilling();
    }
  }, 5 * 60 * 1000);

  console.log('[Waschküche] Cron jobs started (reservations 5min, doors 1min, billing 1st@08:00)');
}

// Manual trigger for billing (admin only)
app.post('/api/wasch/admin/billing/run', authMiddleware, adminOnly, async (req, res) => {
  try {
    await runMonthlyBilling();
    res.json({ success: true, message: 'Abrechnung wurde ausgeführt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - UNIFI ACCESS (Zutrittskontrolle)
// ═══════════════════════════════════════════════════════════════════

// UniFi Access API helper
async function unifiAccessRequest(method, path, body = null) {
  const host = await getWaschSetting('unifi_access_host', '');
  const token = await getWaschSetting('unifi_access_token', '');
  if (!host || !token) return null;

  const url = `https://${host}/api/v1/developer${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  };
  // UniFi Access uses self-signed certs
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      console.error(`[UniFi Access] ${method} ${path}: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[UniFi Access] ${method} ${path} error:`, err.message);
    return null;
  }
}

// Unlock a door temporarily (for reservation start)
async function unlockDoor(doorId, durationSeconds = 10) {
  const enabled = await getWaschSetting('unifi_access_enabled', 'false');
  if (enabled !== 'true' || !doorId) return false;

  const result = await unifiAccessRequest('PUT', `/door/${doorId}/unlock`, {
    duration: durationSeconds,
  });
  if (result) {
    console.log(`[UniFi Access] Door ${doorId} unlocked for ${durationSeconds}s`);
    return true;
  }
  return false;
}

// Lock a door (for reservation end)
async function lockDoor(doorId) {
  const enabled = await getWaschSetting('unifi_access_enabled', 'false');
  if (enabled !== 'true' || !doorId) return false;

  const result = await unifiAccessRequest('PUT', `/door/${doorId}/lock`);
  if (result) {
    console.log(`[UniFi Access] Door ${doorId} locked`);
    return true;
  }
  return false;
}

// Check door status
async function getDoorStatus(doorId) {
  if (!doorId) return null;
  return await unifiAccessRequest('GET', `/door/${doorId}`);
}

// Cron: manage door access based on active reservations (runs with billing cron)
async function manageDoorAccess() {
  const enabled = await getWaschSetting('unifi_access_enabled', 'false');
  if (enabled !== 'true') return;

  const now = new Date();
  try {
    // Find rooms with UniFi door IDs
    const rooms = await pool.query('SELECT * FROM wasch_rooms WHERE active = true AND unifi_door_id IS NOT NULL');

    for (const room of rooms.rows) {
      // Check if there's an active reservation right now
      const active = await pool.query(
        `SELECT r.* FROM wasch_reservations r
         WHERE r.room_id = $1 AND r.cancelled = false
         AND r.start_time <= $2 AND r.end_time > $2`,
        [room.id, now.toISOString()]
      );

      if (active.rows.length > 0) {
        // Reservation active → ensure door is accessible (unlock briefly for entry)
        // Note: In practice, UniFi Access policies handle ongoing access.
        // This just ensures the door unlock happens at reservation start.
        const res = active.rows[0];
        const startTime = new Date(res.start_time);
        const timeSinceStart = (now - startTime) / 60000; // minutes
        if (timeSinceStart < 6) {
          // Within first 6 minutes of reservation → unlock for entry
          await unlockDoor(room.unifi_door_id, 300); // 5 min unlock window
        }
      } else {
        // No active reservation → lock
        await lockDoor(room.unifi_door_id);
      }
    }
  } catch (err) {
    console.error('[UniFi Access] manageDoorAccess error:', err.message);
  }
}

// Admin: get door status
app.get('/api/wasch/admin/doors', authMiddleware, adminOnly, async (req, res) => {
  try {
    const rooms = await pool.query('SELECT * FROM wasch_rooms WHERE active = true AND unifi_door_id IS NOT NULL');
    const statuses = [];
    for (const room of rooms.rows) {
      const status = await getDoorStatus(room.unifi_door_id);
      statuses.push({ room_id: room.id, room_name: room.name, door_id: room.unifi_door_id, status });
    }
    res.json(statuses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: manually unlock a door
app.post('/api/wasch/admin/doors/:roomId/unlock', authMiddleware, adminOnly, async (req, res) => {
  try {
    const room = await pool.query('SELECT * FROM wasch_rooms WHERE id = $1', [req.params.roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Raum nicht gefunden' });
    if (!room.rows[0].unifi_door_id) return res.status(400).json({ error: 'Kein UniFi Türschloss konfiguriert' });

    const duration = parseInt(req.body.duration) || 30;
    const ok = await unlockDoor(room.rows[0].unifi_door_id, duration);
    res.json({ success: ok, message: ok ? `Tür für ${duration}s entsperrt` : 'UniFi Access nicht erreichbar' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// KONTAKTE (replaces n8n stweg3-save-json)
// ═══════════════════════════════════════════════════════════════════

app.get('/api/kontakte/:stweg', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM kontakte WHERE stweg = $1 ORDER BY sort_order, name`,
      [parseInt(req.params.stweg)]
    );
    res.json({ kontakte: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.put('/api/kontakte', authMiddleware, adminOnly, async (req, res) => {
  const { kontakte } = req.body;
  if (!Array.isArray(kontakte)) return res.status(400).json({ error: 'Ungültige Daten' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const k of kontakte) {
      if (k.id) {
        await client.query(
          `UPDATE kontakte SET name=$1, email=$2, telefon=$3, funktion=$4, wohnung=$5, sort_order=$6, updated_at=NOW()
           WHERE id=$7`,
          [k.name, k.email, k.telefon, k.funktion, k.wohnung, k.sort_order || 0, k.id]
        );
      } else {
        await client.query(
          `INSERT INTO kontakte (name, email, telefon, funktion, wohnung, stweg, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [k.name, k.email, k.telefon, k.funktion, k.wohnung, k.stweg, k.sort_order || 0]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Fehler beim Speichern' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL VERTEILER (replaces n8n stweg3-email-verteiler)
// ═══════════════════════════════════════════════════════════════════

// Resolve all email addresses for a group (including all descendant groups)
async function resolveGroupEmails(groupName) {
  try {
    const groupsData = await authentikAPI('GET', '/core/groups/?page_size=500');
    const allGroups = groupsData.results || groupsData;
    const usersData = await authentikAPI('GET', '/core/users/?page_size=500');
    const allUsers = (usersData.results || usersData).filter(u => u.is_active && u.email);

    // Find the target group
    const target = allGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
    if (!target) return [];

    // Collect target + all descendant group PKs
    const groupPks = new Set([target.pk]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of allGroups) {
        if (g.parent && groupPks.has(g.parent) && !groupPks.has(g.pk)) {
          groupPks.add(g.pk);
          changed = true;
        }
      }
    }

    // Find all users in any of these groups
    const emails = new Set();
    for (const u of allUsers) {
      const userGroupPks = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
      if (userGroupPks.some(pk => groupPks.has(pk))) {
        emails.add(u.email.toLowerCase());
      }
    }
    return [...emails];
  } catch (err) {
    console.error('resolveGroupEmails error:', err.message);
    return [];
  }
}

// Resolve members for a verteiler (multi-group or single group or static)
async function resolveVerteilerRecipients(verteiler) {
  const groupNames = verteiler.group_names?.length ? verteiler.group_names : (verteiler.group_name ? [verteiler.group_name] : []);
  if (groupNames.length > 0) {
    const allEmails = new Set();
    for (const gn of groupNames) {
      const emails = await resolveGroupEmails(gn);
      emails.forEach(e => allEmails.add(e));
    }
    return [...allEmails];
  }
  // Fallback: static members list
  return (verteiler.members || []).map(m => m.email).filter(e => e && !e.endsWith('.invalid'));
}

app.get('/api/verteiler/by-stweg/:stweg', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM email_verteiler WHERE stweg = $1 ORDER BY name`,
      [parseInt(req.params.stweg)]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.post('/api/verteiler/send', authMiddleware, adminOnly, async (req, res) => {
  const { verteiler_id, subject, body, recipients } = req.body;
  if (!subject || !body || !recipients?.length) {
    return res.status(400).json({ error: 'Betreff, Text und Empfänger erforderlich' });
  }

  try {
    let sent = 0;
    const failed = [];
    for (const to of recipients) {
      try {
        await transporter.sendMail({
          from: MAIL_FROM,
          to,
          subject,
          html: body,
        });
        sent++;
      } catch (sendErr) {
        console.error(`Failed to send to ${to}:`, sendErr.message);
        failed.push(to);
      }
    }

    // Log to email_log
    const status = failed.length === 0 ? 'sent' : (sent > 0 ? 'partial' : 'failed');
    await pool.query(
      `INSERT INTO email_log (verteiler_id, from_email, from_name, subject, recipients_count, has_attachments, recipients_list, failed_recipients, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [verteiler_id || null, req.user?.email || MAIL_FROM, req.user?.name || 'Admin', subject, sent, false,
       JSON.stringify(recipients), failed.length > 0 ? JSON.stringify(failed) : null, status]
    );

    res.json({ success: true, sent, failed: failed.length });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Fehler beim E-Mail-Versand' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ENERGIE/ZÄHLER (replaces n8n zaehler webhooks)
// ═══════════════════════════════════════════════════════════════════

app.post('/api/zaehler/benutzer', authMiddleware, adminOnly, async (req, res) => {
  const { email, name, wohnung, stweg, zugriff } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO users (email, name, wohnung, stweg, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name=$2, wohnung=$3, stweg=$4, role=$5
       RETURNING *`,
      [email.toLowerCase().trim(), name, wohnung, parseInt(stweg), zugriff || 'bewohner']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Erstellen des Benutzers' });
  }
});

app.post('/api/zaehler/daten', async (req, res) => {
  // Receives meter data from ioBroker/webhook
  const { zaehler_id, wert, timestamp } = req.body;
  try {
    await pool.query(
      `INSERT INTO zaehler_daten (zaehler_id, wert, timestamp)
       VALUES ($1, $2, $3)`,
      [zaehler_id, wert, timestamp || new Date()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.get('/api/zaehler/daten/:zaehler_id', authMiddleware, async (req, res) => {
  const { von, bis } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM zaehler_daten
       WHERE zaehler_id = $1 AND timestamp >= $2 AND timestamp <= $3
       ORDER BY timestamp`,
      [req.params.zaehler_id, von || new Date(Date.now() - 24 * 60 * 60 * 1000), bis || new Date()]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GENERIC EMAIL (replaces n8n send-email)
// ═══════════════════════════════════════════════════════════════════

app.post('/api/email/send', authMiddleware, adminOnly, async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Empfänger, Betreff und Inhalt erforderlich' });
  }
  try {
    await transporter.sendMail({ from: MAIL_FROM, to, subject, html });
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'E-Mail-Versand fehlgeschlagen' });
  }
});


// ═══════════════════════════════════════════════════════════════════
// EMAIL VERTEILERLISTEN (Cloudflare Worker → Gmail+tag → IMAP → SMTP2GO)
// ═══════════════════════════════════════════════════════════════════

const EMAIL_INBOUND_SECRET = process.env.EMAIL_INBOUND_SECRET || 'rosenweg-email-2026';

// ─── Shared email processing logic ──────────────────────────────────
async function processInboundEmail(rawEmail, overrideToAddress, messageId) {
  const parsed = await simpleParser(Buffer.isBuffer(rawEmail) ? rawEmail : Buffer.from(rawEmail));

  const toAddress = overrideToAddress || parsed.to?.value?.[0]?.address?.toLowerCase();
  if (!toAddress) {
    return { success: false, error: 'No recipient found' };
  }

  console.log(`Email inbound: ${parsed.from?.text} → ${toAddress} | Subject: ${parsed.subject}`);

  const verteiler = await pool.query(
    'SELECT * FROM email_verteiler WHERE email_address = $1 AND active = true',
    [toAddress]
  );

  if (verteiler.rows.length === 0) {
    console.log(`No verteiler found for ${toAddress}, dropping`);
    return { success: true, action: 'dropped', reason: 'no verteiler' };
  }

  const list = verteiler.rows[0];
  const senderEmail = parsed.from?.value?.[0]?.address || '';
  const senderName = parsed.from?.value?.[0]?.name || senderEmail;
  const recipients = await resolveVerteilerRecipients(list);

  if (recipients.length === 0) {
    return { success: true, action: 'dropped', reason: 'no valid recipients' };
  }

  const subjectPrefix = list.subject_prefix || `[${list.name}]`;
  const subject = parsed.subject?.startsWith(subjectPrefix)
    ? parsed.subject
    : `${subjectPrefix} ${parsed.subject || '(kein Betreff)'}`;

  let replyTo;
  if (list.reply_to === 'list') {
    replyTo = toAddress;
  } else if (list.reply_to === 'sender') {
    replyTo = senderEmail;
  } else {
    replyTo = list.reply_to || senderEmail;
  }

  const attachments = (parsed.attachments || []).map(att => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType,
    cid: att.cid || undefined,
  }));

  await transporter.sendMail({
    from: `"${senderName} via ${list.name}" <${toAddress}>`,
    to: recipients,
    replyTo: replyTo,
    subject: subject,
    text: parsed.text || '',
    html: parsed.html || undefined,
    attachments: attachments,
    headers: {
      'List-Id': `<${toAddress.replace('@', '.')}>`,
      'List-Post': `<mailto:${toAddress}>`,
      'X-Original-From': senderEmail,
      'X-Forwarded-By': 'Rosenweg Verteiler',
    },
  });
  console.log(`Distributed email to ${recipients.length} recipients for ${toAddress}`);

  await pool.query(
    `INSERT INTO email_log (verteiler_id, from_email, from_name, subject, recipients_count, has_attachments, recipients_list, status, message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [list.id, senderEmail, senderName, parsed.subject, recipients.length, attachments.length > 0,
     JSON.stringify(recipients), 'sent', messageId || parsed.messageId || null]
  );

  return { success: true, action: 'distributed', recipients: recipients.length };
}

// HTTP endpoint (kept for direct API testing)
app.post('/api/email/inbound', async (req, res) => {
  const secret = req.headers['x-email-secret'] || req.query.secret;
  if (secret !== EMAIL_INBOUND_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const result = await processInboundEmail(req.body);
    res.json(result);
  } catch (err) {
    console.error('Email inbound error:', err);
    res.status(500).json({ error: `Email-Verarbeitung fehlgeschlagen: ${err.message}` });
  }
});

// ─── IMAP Gmail Polling ──────────────────────────────────────────────
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER = process.env.IMAP_USER || '';
const IMAP_PASS = process.env.IMAP_PASS || '';  // Gmail App Password
const IMAP_POLL_INTERVAL = parseInt(process.env.IMAP_POLL_INTERVAL || '60') * 1000;
const VERTEILER_DOMAIN = process.env.VERTEILER_DOMAIN || 'rosenweg4303.ch';

async function pollGmailForVerteiler() {
  if (!IMAP_USER || !IMAP_PASS) return;

  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });
  client.on('error', (err) => {
    console.error('[IMAP] Connection error:', err.message);
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Search all emails from last 7 days (not just unread) and check against DB
      const since = new Date();
      since.setDate(since.getDate() - 7);
      const uids = await client.search({ since }, { uid: true });
      if (!uids.length) { lock.release(); return; }

      for (const uid of uids) {
        try {
          // Fetch headers only first (fast, small)
          let headers = null;
          for await (const msg of client.fetch(String(uid), { headers: true }, { uid: true })) {
            headers = msg.headers?.toString() || '';
          }
          if (!headers) { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); continue; }

          // Extract Message-ID for deduplication
          const msgIdMatch = headers.match(/^Message-ID:\s*<?([^>\r\n]+)>?/im);
          const messageId = msgIdMatch ? msgIdMatch[1].trim() : null;

          let verteilerAddress = null;

          // Plus-tag in Delivered-To (rosenweg4303+ausschuss@gmail.com)
          const plusMatch = headers.match(/^Delivered-To:\s*[^+\r\n]+\+([^@\r\n]+)@/im);
          if (plusMatch) {
            verteilerAddress = `${plusMatch[1].toLowerCase()}@${VERTEILER_DOMAIN}`;
          }

          // To: header contains @rosenweg4303.ch address (strip +tag if present)
          if (!verteilerAddress) {
            const toMatch = headers.match(/^To:\s*[^]*?([a-z0-9._+-]+@rosenweg4303\.ch)/im);
            if (toMatch) {
              verteilerAddress = toMatch[1].toLowerCase().replace(/\+[^@]*/, '');
            }
          }

          if (!verteilerAddress) {
            // Not a verteiler email, move to _sonstige
            try {
              try { await client.mailboxCreate('Verteiler/_sonstige'); } catch {}
              await client.messageMove(uid, 'Verteiler/_sonstige', { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
          }

          // Check if verteiler exists
          const exists = await pool.query(
            'SELECT id FROM email_verteiler WHERE email_address = $1 AND active = true', [verteilerAddress]
          );
          if (exists.rows.length === 0) {
            try {
              try { await client.mailboxCreate('Verteiler/_unbekannt'); } catch {}
              await client.messageMove(uid, 'Verteiler/_unbekannt', { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
          }

          // Dedup: skip if already processed (same message-id in email_log)
          if (messageId) {
            const dup = await pool.query('SELECT id FROM email_log WHERE message_id = $1', [messageId]);
            if (dup.rows.length > 0) {
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
              continue;
            }
          }

          // Now fetch the full source for processing
          let source = null;
          for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
            source = msg.source;
          }
          if (!source) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }

          console.log(`[IMAP] Processing: ${verteilerAddress} (UID ${uid})`);
          const result = await processInboundEmail(source, verteilerAddress, messageId);
          console.log(`[IMAP] Result: ${result.action} (${result.recipients || 0} recipients)`);

          // Move to verteiler-named folder (e.g. "Verteiler/ausschuss")
          const folderName = verteilerAddress.split('@')[0];
          const targetFolder = `Verteiler/${folderName}`;
          try {
            try { await client.mailboxCreate(targetFolder); } catch {}
            await client.messageMove(uid, targetFolder, { uid: true });
          } catch (moveErr) {
            // Fallback: just mark as read if move fails
            console.error(`[IMAP] Move to ${targetFolder} failed:`, moveErr.message);
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          }
        } catch (msgErr) {
          console.error(`[IMAP] Error processing UID ${uid}:`, msgErr.message);
          // Don't mark as read on error - will retry next poll
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error('[IMAP] Poll error:', err.message);
  } finally {
    client.close();
  }
}

function startImapPoll() {
  if (!IMAP_USER || !IMAP_PASS) {
    console.log('[IMAP] No credentials configured, polling disabled');
    return;
  }
  console.log(`[IMAP] Polling ${IMAP_USER} every ${IMAP_POLL_INTERVAL / 1000}s`);
  setTimeout(pollGmailForVerteiler, 10000);
  setInterval(pollGmailForVerteiler, IMAP_POLL_INTERVAL);
}

// ─── STWEG Kontakte ─────────────────────────────────────────────────

// Cache for kontakte data (users + groups from Authentik)
let _kontakteCache = null;
let _kontakteCacheTime = 0;
const KONTAKTE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function getKontakteData() {
  const now = Date.now();
  if (_kontakteCache && now - _kontakteCacheTime < KONTAKTE_CACHE_TTL) {
    return _kontakteCache;
  }
  const [groupsData, usersData] = await Promise.all([
    authentikAPI('GET', '/core/groups/?page_size=500'),
    authentikAPI('GET', '/core/users/?page_size=500'),
  ]);
  _kontakteCache = {
    groups: groupsData.results || groupsData,
    users: (usersData.results || usersData).filter(u => u.is_active),
  };
  _kontakteCacheTime = now;
  return _kontakteCache;
}

// Resolve all descendant group PKs for a given group name
function resolveDescendantPks(groupName, allGroups) {
  const target = allGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
  if (!target) return new Set();
  const pks = new Set([target.pk]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of allGroups) {
      if (g.parent && pks.has(g.parent) && !pks.has(g.pk)) {
        pks.add(g.pk);
        changed = true;
      }
    }
  }
  return pks;
}

// Get users in a set of group PKs
function getUsersInGroups(groupPks, allUsers) {
  return allUsers.filter(u => {
    const userPks = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
    return userPks.some(pk => groupPks.has(pk));
  });
}

// Natural sort for wohnung (EG.1, EG.2, 1OG.1, 1OG.2, 2OG.1, ...)
function wohnungSort(a, b) {
  const order = { 'ug': 0, 'eg': 1, '1og': 2, '2og': 3, '3og': 4, 'dg': 5 };
  const parseW = (w) => {
    if (!w) return { floor: 99, num: 99 };
    const m = w.toLowerCase().match(/^(\d*[a-z]+)\.?(\d+)?$/);
    if (!m) return { floor: 99, num: 99 };
    return { floor: order[m[1]] ?? 99, num: parseInt(m[2]) || 0 };
  };
  const pa = parseW(a), pb = parseW(b);
  return pa.floor - pb.floor || pa.num - pb.num;
}

app.get('/api/stweg/:nr/kontakte', authMiddleware, async (req, res) => {
  try {
    const nr = parseInt(req.params.nr);
    const stwegGroups = STWEG_GROUPS[nr];
    if (!stwegGroups) return res.status(404).json({ error: 'STWEG nicht gefunden' });

    // Check access: user must be in one of the STWEG's groups or Technik
    const userGroups = (req.user.groups || []).map(g => g.toLowerCase());
    const allUserGroups = await resolveAncestorGroups(req.user.groups || []);
    const accessGroups = Object.values(stwegGroups).map(g => g.toLowerCase());
    const hasAccess = allUserGroups.some(g => g === 'technik') ||
                      allUserGroups.some(g => accessGroups.includes(g));
    if (!hasAccess) return res.status(403).json({ error: 'Kein Zugriff auf diese STWEG' });

    const { groups: allGroups, users: allUsers } = await getKontakteData();

    // Resolve group PKs (including child groups)
    const bewohnerPks = stwegGroups.bewohner ? resolveDescendantPks(stwegGroups.bewohner, allGroups) : new Set();
    const eigentuemerPks = stwegGroups.eigentuemer ? resolveDescendantPks(stwegGroups.eigentuemer, allGroups) : new Set();
    const ausschussPks = stwegGroups.ausschuss ? resolveDescendantPks(stwegGroups.ausschuss, allGroups) : new Set();

    // Get all relevant users (union of all groups)
    const allPks = new Set([...bewohnerPks, ...eigentuemerPks, ...ausschussPks]);
    const relevantUsers = getUsersInGroups(allPks, allUsers);

    // Build contact list grouped by wohnung
    const wohnungen = {};
    const ausschuss = [];

    for (const u of relevantUsers) {
      const userPks = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
      const isEigentuemer = userPks.some(pk => eigentuemerPks.has(pk));
      const isBewohner = userPks.some(pk => bewohnerPks.has(pk));
      const isAusschuss = userPks.some(pk => ausschussPks.has(pk));

      const attrs = u.attributes || {};
      const person = {
        name: u.name,
        email: u.email,
        telefon: attrs.telefon || null,
        wohnung: attrs.wohnung || null,
        rolle: isEigentuemer ? 'eigentuemer' : 'mieter',
      };

      if (isAusschuss) {
        ausschuss.push({ ...person, funktion: attrs.funktion || 'Vertreter' });
      }

      if (person.wohnung) {
        if (!wohnungen[person.wohnung]) wohnungen[person.wohnung] = [];
        wohnungen[person.wohnung].push(person);
      }
    }

    // Sort wohnungen and build response
    const sortedWohnungen = Object.keys(wohnungen)
      .sort(wohnungSort)
      .map(w => ({
        bezeichnung: w,
        bewohner: wohnungen[w].sort((a, b) => {
          // Eigentuemer first
          if (a.rolle === 'eigentuemer' && b.rolle !== 'eigentuemer') return -1;
          if (a.rolle !== 'eigentuemer' && b.rolle === 'eigentuemer') return 1;
          return 0;
        }),
      }));

    res.json({
      stweg: nr,
      wohnungen: sortedWohnungen,
      ausschuss: ausschuss,
    });
  } catch (err) {
    console.error('Kontakte error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Kontakte' });
  }
});

// ─── Wohnungsverwaltung ─────────────────────────────────────────────

// Helper: load wohnung with kontakte
async function loadWohnungMitKontakte(wohnungId) {
  const wRes = await pool.query('SELECT * FROM wohnungen WHERE id = $1', [wohnungId]);
  if (wRes.rows.length === 0) return null;
  const w = wRes.rows[0];
  const kRes = await pool.query('SELECT * FROM wohnungen_kontakte WHERE wohnung_id = $1 ORDER BY rolle, sort_order, id', [wohnungId]);
  w.kontakte = kRes.rows;
  return w;
}

// Helper: save kontakte for a wohnung (replace all)
async function saveKontakte(client, wohnungId, kontakte) {
  await client.query('DELETE FROM wohnungen_kontakte WHERE wohnung_id = $1', [wohnungId]);
  if (!kontakte || !Array.isArray(kontakte)) return;
  for (let i = 0; i < kontakte.length; i++) {
    const k = kontakte[i];
    if (!k.name && !k.email) continue;
    await client.query(
      `INSERT INTO wohnungen_kontakte (wohnung_id, rolle, name, email, telefon, adresse, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [wohnungId, k.rolle || 'eigentuemer', k.name || null, k.email || null, k.telefon || null, k.adresse || null, i]
    );
  }
}

// GET /api/wohnungen/:stweg - List all apartments for a STWEG
app.get('/api/wohnungen/:stweg', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), requireStwegAccess, async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg);
    const wResult = await pool.query('SELECT * FROM wohnungen WHERE stweg = $1', [stweg]);
    const kResult = await pool.query(
      `SELECT k.* FROM wohnungen_kontakte k JOIN wohnungen w ON k.wohnung_id = w.id WHERE w.stweg = $1 ORDER BY k.rolle, k.sort_order, k.id`,
      [stweg]
    );
    // Group kontakte by wohnung_id
    const kontakteMap = {};
    for (const k of kResult.rows) {
      if (!kontakteMap[k.wohnung_id]) kontakteMap[k.wohnung_id] = [];
      kontakteMap[k.wohnung_id].push(k);
    }
    const wohnungen = wResult.rows.map(w => ({ ...w, kontakte: kontakteMap[w.id] || [] }));
    wohnungen.sort((a, b) => wohnungSort(a.bezeichnung, b.bezeichnung));
    res.json({ stweg, wohnungen });
  } catch (err) {
    console.error('Wohnungen list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Wohnungen' });
  }
});

// GET /api/wohnungen/:stweg/stats - Occupancy statistics
app.get('/api/wohnungen/:stweg/stats', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), requireStwegAccess, async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg);
    const result = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE bewohnt_von = 'eigentuemer') as selbstbewohnt,
              COUNT(*) FILTER (WHERE bewohnt_von = 'mieter') as vermietet,
              COUNT(*) FILTER (WHERE bewohnt_von = 'leer') as leer
       FROM wohnungen WHERE stweg = $1`, [stweg]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Wohnungen stats error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
  }
});

// GET /api/wohnungen/:stweg/:id - Single apartment with kontakte
app.get('/api/wohnungen/:stweg/:id', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), requireStwegAccess, async (req, res) => {
  try {
    const w = await loadWohnungMitKontakte(parseInt(req.params.id));
    if (!w || w.stweg !== parseInt(req.params.stweg)) return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    res.json(w);
  } catch (err) {
    console.error('Wohnung get error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Wohnung' });
  }
});

// POST /api/wohnungen/:stweg - Create apartment
app.post('/api/wohnungen/:stweg', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), requireStwegAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const stweg = parseInt(req.params.stweg);
    const b = req.body;
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO wohnungen (stweg, bezeichnung, stockwerk, zimmer, flaeche_m2, typ, besonderheiten,
        bewohnt_von, waschkueche_berechtigt, notizen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [stweg, b.bezeichnung, b.stockwerk, b.zimmer, b.flaeche_m2, b.typ || 'Wohnung', b.besonderheiten,
       b.bewohnt_von || 'eigentuemer', b.waschkueche_berechtigt !== false, b.notizen]
    );
    await saveKontakte(client, result.rows[0].id, b.kontakte);
    await client.query('COMMIT');
    const wohnung = await loadWohnungMitKontakte(result.rows[0].id);
    res.status(201).json(wohnung);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Wohnung mit dieser Bezeichnung existiert bereits' });
    console.error('Wohnung create error:', err);
    res.status(500).json({ error: 'Fehler beim Anlegen der Wohnung' });
  } finally {
    client.release();
  }
});

// PUT /api/wohnungen/:stweg/:id - Update apartment
app.put('/api/wohnungen/:stweg/:id', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), requireStwegAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body;
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE wohnungen SET bezeichnung=$1, stockwerk=$2, zimmer=$3, flaeche_m2=$4, typ=$5, besonderheiten=$6,
        bewohnt_von=$7, waschkueche_berechtigt=$8, notizen=$9, updated_at=NOW()
       WHERE id=$10 AND stweg=$11 RETURNING *`,
      [b.bezeichnung, b.stockwerk, b.zimmer, b.flaeche_m2, b.typ || 'Wohnung', b.besonderheiten,
       b.bewohnt_von || 'eigentuemer', b.waschkueche_berechtigt !== false, b.notizen,
       req.params.id, req.params.stweg]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    }
    await saveKontakte(client, result.rows[0].id, b.kontakte);
    await client.query('COMMIT');
    const wohnung = await loadWohnungMitKontakte(result.rows[0].id);
    res.json(wohnung);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Wohnung mit dieser Bezeichnung existiert bereits' });
    console.error('Wohnung update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der Wohnung' });
  } finally {
    client.release();
  }
});

// DELETE /api/wohnungen/:stweg/:id - Delete apartment
app.delete('/api/wohnungen/:stweg/:id', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), requireStwegAccess, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM wohnungen WHERE id = $1 AND stweg = $2 RETURNING id', [req.params.id, req.params.stweg]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    res.json({ success: true });
  } catch (err) {
    console.error('Wohnung delete error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen der Wohnung' });
  }
});

// POST /api/wohnungen/:stweg/import - Import from kontakte.json format
app.post('/api/wohnungen/:stweg/import', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), requireStwegAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const stweg = parseInt(req.params.stweg);
    const data = req.body;
    if (!data.wohnungen) return res.status(400).json({ error: 'Keine Wohnungsdaten gefunden' });

    const stockwerkMap = {
      'erdgeschoss': 'Erdgeschoss', 'untergeschoss': 'Untergeschoss',
      'obergeschoss_1': '1. Obergeschoss', 'obergeschoss_2': '2. Obergeschoss',
      'obergeschoss_3': '3. Obergeschoss', 'dachgeschoss': 'Dachgeschoss',
      'sonstiges': 'Sonstiges',
    };

    await client.query('BEGIN');
    let imported = 0;
    for (const [floor, units] of Object.entries(data.wohnungen)) {
      const stockwerk = stockwerkMap[floor] || floor;
      for (const u of units) {
        const hasMieter = u.mieter && u.mieter.name;
        const bewohntVon = hasMieter ? 'mieter' : 'eigentuemer';
        const wResult = await client.query(
          `INSERT INTO wohnungen (stweg, bezeichnung, stockwerk, zimmer, flaeche_m2, typ, besonderheiten,
            bewohnt_von, waschkueche_berechtigt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (stweg, bezeichnung) DO UPDATE SET
            stockwerk=EXCLUDED.stockwerk, zimmer=EXCLUDED.zimmer, flaeche_m2=EXCLUDED.flaeche_m2,
            bewohnt_von=EXCLUDED.bewohnt_von, updated_at=NOW()
           RETURNING id`,
          [stweg, u.bezeichnung, stockwerk, u.zimmer, u.flaeche_m2,
           u.typ || 'Wohnung', u.besonderheiten ? JSON.stringify(u.besonderheiten) : null,
           bewohntVon, u.eigentümer?.waschkueche_berechtigt ?? u.eigentuemer?.waschkueche_berechtigt ?? true]
        );
        const wohnungId = wResult.rows[0].id;
        // Build kontakte from legacy format
        const kontakte = [];
        const eig = u.eigentümer || u.eigentuemer;
        if (eig?.name) kontakte.push({ rolle: 'eigentuemer', name: eig.name, email: eig.email, telefon: eig.telefon });
        if (u.mieter?.name) kontakte.push({ rolle: 'mieter', name: u.mieter.name, email: u.mieter.email, telefon: u.mieter.telefon });
        await saveKontakte(client, wohnungId, kontakte);
        imported++;
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, imported });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Wohnungen import error:', err);
    res.status(500).json({ error: 'Import fehlgeschlagen: ' + err.message });
  } finally {
    client.release();
  }
});

/** Auto-add users to Authentik STWEG groups when assigned to apartments */
async function syncWohnungGroups(stweg, wohnung) {
  try {
    const stwegGroups = STWEG_GROUPS[stweg];
    if (!stwegGroups) return;

    // Sync owner to eigentuemer group
    if (wohnung.eigentuemer_user_pk && stwegGroups.eigentuemer) {
      const groupData = await authentikAPI('GET', `/core/groups/?search=${encodeURIComponent(stwegGroups.eigentuemer)}`);
      const group = (groupData.results || []).find(g => g.name.toLowerCase() === stwegGroups.eigentuemer.toLowerCase());
      if (group) {
        await authentikAPI('POST', `/core/groups/${group.pk}/add_user/`, { pk: wohnung.eigentuemer_user_pk }).catch(() => {});
      }
    }
    // Sync tenant to bewohner group
    if (wohnung.mieter_user_pk && stwegGroups.bewohner) {
      const groupData = await authentikAPI('GET', `/core/groups/?search=${encodeURIComponent(stwegGroups.bewohner)}`);
      const group = (groupData.results || []).find(g => g.name.toLowerCase() === stwegGroups.bewohner.toLowerCase());
      if (group) {
        await authentikAPI('POST', `/core/groups/${group.pk}/add_user/`, { pk: wohnung.mieter_user_pk }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Authentik group sync error:', err.message);
  }
}

// ─── Verteiler CRUD (admin only) ────────────────────────────────────

// List all Verteiler
app.get('/api/verteiler', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, stweg, name, email_address, members, active,
              reply_to, subject_prefix, group_name, group_names, created_at,
              jsonb_array_length(COALESCE(members, '[]'::jsonb)) as member_count
       FROM email_verteiler ORDER BY stweg, name`
    );
    // For group-based verteiler, resolve actual member count
    const rows = result.rows;
    for (const v of rows) {
      const groupNames = v.group_names?.length ? v.group_names : (v.group_name ? [v.group_name] : []);
      if (groupNames.length > 0) {
        const allEmails = new Set();
        for (const gn of groupNames) {
          const emails = await resolveGroupEmails(gn);
          emails.forEach(e => allEmails.add(e));
        }
        v.member_count = allEmails.size;
        v.resolved_emails = [...allEmails];
      }
    }
    res.json({ verteiler: rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Verteiler' });
  }
});

// Get single Verteiler
app.get('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM email_verteiler WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = result.rows[0];
    const groupNames = v.group_names?.length ? v.group_names : (v.group_name ? [v.group_name] : []);
    if (groupNames.length > 0) {
      const allEmails = new Set();
      for (const gn of groupNames) {
        const emails = await resolveGroupEmails(gn);
        emails.forEach(e => allEmails.add(e));
      }
      v.resolved_emails = [...allEmails];
      v.member_count = allEmails.size;
    }
    res.json(v);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Create Verteiler
app.post('/api/verteiler', authMiddleware, adminOnly, async (req, res) => {
  const { stweg, name, email_address, members, reply_to, subject_prefix, group_name, group_names } = req.body;
  if (!name || !email_address) return res.status(400).json({ error: 'Name und Email-Adresse erforderlich' });
  try {
    const groups = group_names?.length ? group_names : (group_name ? [group_name] : []);
    const result = await pool.query(
      `INSERT INTO email_verteiler (stweg, name, email_address, members, reply_to, subject_prefix, group_name, group_names)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [stweg || 0, name, email_address, JSON.stringify(members || []), reply_to || 'sender', subject_prefix || null, groups[0] || null, JSON.stringify(groups)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email-Adresse existiert bereits' });
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// Update Verteiler
app.put('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  const { stweg, name, email_address, members, active, reply_to, subject_prefix, group_name, group_names } = req.body;
  try {
    const groups = group_names?.length ? group_names : (group_name ? [group_name] : []);
    const result = await pool.query(
      `UPDATE email_verteiler SET stweg=$1, name=$2, email_address=$3, members=$4, active=$5,
              reply_to=$6, subject_prefix=$7, group_name=$8, group_names=$9
       WHERE id=$10 RETURNING *`,
      [stweg, name, email_address, JSON.stringify(members || []), active !== false, reply_to || 'sender', subject_prefix || null, groups[0] || null, JSON.stringify(groups), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

// Delete Verteiler
app.delete('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM email_verteiler WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Add member to Verteiler
app.post('/api/verteiler/:id/members', authMiddleware, adminOnly, async (req, res) => {
  const { name, email, wohnung, funktion } = req.body;
  if (!email) return res.status(400).json({ error: 'Email erforderlich' });
  try {
    const member = { name: name || '', email };
    if (wohnung) member.wohnung = wohnung;
    if (funktion) member.funktion = funktion;
    const result = await pool.query(
      `UPDATE email_verteiler SET members = members || $1::jsonb WHERE id = $2 RETURNING *`,
      [JSON.stringify(member), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Remove member from Verteiler (by email)
app.delete('/api/verteiler/:id/members/:email', authMiddleware, adminOnly, async (req, res) => {
  try {
    const verteiler = await pool.query('SELECT members FROM email_verteiler WHERE id = $1', [req.params.id]);
    if (verteiler.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const filtered = (verteiler.rows[0].members || []).filter(m => m.email !== req.params.email);
    const result = await pool.query(
      'UPDATE email_verteiler SET members = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(filtered), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Email log (recent distributions)
app.get('/api/email/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await pool.query(
      `SELECT l.*, v.name as verteiler_name, v.email_address as verteiler_address FROM email_log l
       LEFT JOIN email_verteiler v ON v.id = l.verteiler_id
       ORDER BY l.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ log: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// SMTP2GO delivery status for a specific email log entry
app.get('/api/email/log/:id/status', authMiddleware, adminOnly, async (req, res) => {
  if (!SMTP2GO_API_KEY) return res.status(400).json({ error: 'SMTP2GO API-Key nicht konfiguriert' });
  try {
    const entry = await pool.query('SELECT * FROM email_log WHERE id = $1', [req.params.id]);
    if (entry.rows.length === 0) return res.status(404).json({ error: 'Log-Eintrag nicht gefunden' });
    const log = entry.rows[0];

    // Search SMTP2GO activity for this email by subject and time range
    const startDate = new Date(log.created_at);
    startDate.setMinutes(startDate.getMinutes() - 5);
    const endDate = new Date(log.created_at);
    endDate.setHours(endDate.getHours() + 48);

    const apiRes = await fetch(`${SMTP2GO_API_URL}/activity/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': SMTP2GO_API_KEY },
      body: JSON.stringify({
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        search_subject: log.subject,
        limit: 200,
      }),
    });
    const apiData = await apiRes.json();

    // Deduplicate: keep the most recent/best event per recipient
    const eventMap = new Map();
    const priority = { 'clicked': 5, 'opened': 4, 'delivered': 3, 'soft_bounced': 2, 'bounced': 2, 'rejected': 2, 'sent': 1, 'queued': 0 };
    for (const e of (apiData.data?.events || [])) {
      const existing = eventMap.get(e.recipient);
      if (!existing || (priority[e.event] || 0) > (priority[existing.event] || 0)) {
        eventMap.set(e.recipient, { recipient: e.recipient, event: e.event, date: e.date, smtp_response: e.smtp_response || null });
      }
    }
    const events = [...eventMap.values()];

    // Update failed_recipients in DB based on SMTP2GO data
    const bounced = events.filter(e => e.event.includes('bounced') || e.event === 'rejected');
    if (bounced.length > 0) {
      await pool.query(
        'UPDATE email_log SET failed_recipients = $1, status = $2 WHERE id = $3',
        [JSON.stringify(bounced.map(b => b.recipient)),
         bounced.length >= (log.recipients_count || 1) ? 'failed' : 'partial',
         log.id]
      );
    }

    res.json({ events, total: apiData.data?.total_events || 0 });
  } catch (err) {
    console.error('SMTP2GO status error:', err);
    res.status(500).json({ error: 'SMTP2GO-Abfrage fehlgeschlagen' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUBLIC INFO API (Ausschuss, Technischer Dienst)
// ═══════════════════════════════════════════════════════════════════

// GET /api/public/ausschuss - Ausschuss-Vertreter per STWEG (from Authentik groups)
app.get('/api/public/ausschuss', async (req, res) => {
  try {
    const [groupsData, usersData] = await Promise.all([
      authentikAPI('GET', '/core/groups/?page_size=500'),
      authentikAPI('GET', '/core/users/?page_size=500'),
    ]);
    const allGroups = groupsData.results || [];
    const allUsers = (usersData.results || []).filter(u => u.is_active && u.email);

    // Build group PK → name mapping
    const groupMap = {};
    for (const g of allGroups) groupMap[g.pk] = g.name;

    // Find users per ausschuss group
    const result = { vertreter: [] };

    for (let nr = 1; nr <= 8; nr++) {
      const groupName = STWEG_GROUPS[nr]?.ausschuss;
      if (!groupName) continue;

      const group = allGroups.find(g => g.name.toLowerCase() === groupName.toLowerCase());
      if (!group) continue;

      const members = allUsers
        .filter(u => {
          const uGroups = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
          return uGroups.includes(group.pk);
        })
        .map(u => ({ name: u.name, email: u.email }));

      result.vertreter.push({
        stweg_nummer: nr,
        stweg_typ: nr === 8 ? 'Tiefgarage' : 'Wohngebäude',
        email: `stweg${nr}@rosenweg4303.ch`,
        vertreter: members,
      });
    }

    // Präsident: look for user in "Präsident" group or first eigentuemer group match
    const praesidentGroup = allGroups.find(g => g.name.toLowerCase() === 'präsident' || g.name.toLowerCase() === 'praesident');
    if (praesidentGroup) {
      const praesidentUser = allUsers.find(u => {
        const uGroups = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
        return uGroups.includes(praesidentGroup.pk);
      });
      if (praesidentUser) {
        result.praesident = {
          name: praesidentUser.name,
          email: 'praesident@rosenweg4303.ch',
        };
      }
    }

    res.json(result);
  } catch (err) {
    console.error('Public ausschuss error:', err.message);
    res.status(500).json({ error: 'Ausschuss-Daten konnten nicht geladen werden' });
  }
});

// GET /api/public/technik - Technischer Dienst Mitglieder (from Authentik Technik group)
app.get('/api/public/technik', async (req, res) => {
  try {
    const [groupsData, usersData] = await Promise.all([
      authentikAPI('GET', '/core/groups/?page_size=500'),
      authentikAPI('GET', '/core/users/?page_size=500'),
    ]);
    const allGroups = groupsData.results || [];
    const allUsers = (usersData.results || []).filter(u => u.is_active && u.email);

    const technikGroup = allGroups.find(g => g.name === 'Technik' || g.name === 'technik');
    if (!technikGroup) return res.json({ mitglieder: [] });

    const mitglieder = allUsers
      .filter(u => {
        const uGroups = u.groups_obj ? u.groups_obj.map(g => g.pk) : (u.groups || []);
        return uGroups.includes(technikGroup.pk);
      })
      .map(u => ({
        name: u.name,
        email: u.email,
      }));

    res.json({
      email: 'technik@rosenweg9.ch',
      mitglieder,
    });
  } catch (err) {
    console.error('Public technik error:', err.message);
    res.status(500).json({ error: 'Technik-Daten konnten nicht geladen werden' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR (ICS → JSON Proxy)
// ═══════════════════════════════════════════════════════════════════

const GOOGLE_CALENDAR_ICS_URL = process.env.GOOGLE_CALENDAR_ICS_URL ||
  'https://calendar.google.com/calendar/ical/rosenweg4303%40gmail.com/private-21cb7a217f2b19dc884e2baf38762fb0/basic.ics';

// Simple ICS parser - extracts VEVENT blocks
function parseICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const event = {};

    // Unfold lines (RFC 5545: lines starting with space/tab are continuations)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');

    for (const line of unfolded.split(/\r?\n/)) {
      const match = line.match(/^([A-Z\-;]+?)[:;](.+)/);
      if (!match) continue;
      const key = match[1];
      const value = match[2];

      if (key === 'SUMMARY') {
        event.title = value.replace(/\\,/g, ',').replace(/\\n/g, '\n').trim();
      } else if (key.startsWith('DTSTART')) {
        event.start = parseICSDate(value);
      } else if (key.startsWith('DTEND')) {
        event.end = parseICSDate(value);
      } else if (key === 'LOCATION') {
        event.location = value.replace(/\\,/g, ',').replace(/\\n/g, '\n').trim();
      } else if (key === 'DESCRIPTION') {
        event.description = value.replace(/\\,/g, ',').replace(/\\n/g, '\n').replace(/\\;/g, ';').trim();
      }
    }

    if (event.title && event.start) {
      events.push(event);
    }
  }

  return events;
}

function parseICSDate(value) {
  // Remove any parameters like TZID=... before the actual value
  const parts = value.split(':');
  const dateStr = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  // Format: 20260315T190000Z or 20260315T190000 or 20260315
  const m = dateStr.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (h !== undefined) {
    const isUTC = dateStr.endsWith('Z');
    if (isUTC) {
      return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
    }
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).toISOString();
  }
  // All-day event
  return `${y}-${mo}-${d}`;
}

// Cache: re-fetch at most every 5 minutes
let calendarCache = { data: null, fetchedAt: 0 };

app.get('/api/calendar', async (req, res) => {
  try {
    const now = Date.now();
    if (!calendarCache.data || now - calendarCache.fetchedAt > 5 * 60 * 1000) {
      const response = await fetch(GOOGLE_CALENDAR_ICS_URL);
      if (!response.ok) throw new Error(`Google Calendar fetch failed: ${response.status}`);
      const icsText = await response.text();
      const allEvents = parseICS(icsText);

      // Only return future events (from today onwards), sorted by start date
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const futureEvents = allEvents
        .filter(e => new Date(e.start) >= today)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      calendarCache = { data: futureEvents, fetchedAt: now };
    }
    res.json({ events: calendarCache.data });
  } catch (err) {
    console.error('Calendar fetch error:', err.message);
    res.status(500).json({ error: 'Kalender konnte nicht geladen werden' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AUTHENTIK ADMIN PROXY API
// ═══════════════════════════════════════════════════════════════════

async function authentikAPI(method, path, body = null) {
  const url = `${AUTHENTIK_URL}/api/v3${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${AUTHENTIK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentik API ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// GET /api/admin/users - List all users
app.get('/api/admin/users', authMiddleware, requirePermission('bewohner-verwaltung', 'read'), async (req, res) => {
  try {
    const data = await authentikAPI('GET', '/core/users/?page_size=500');
    res.json(data);
  } catch (err) {
    console.error('Admin list users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users - Create user
app.post('/api/admin/users', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const { username, name, email, password, groups } = req.body;
    const user = await authentikAPI('POST', '/core/users/', {
      username,
      name,
      email,
      password,
    });
    if (groups && groups.length > 0) {
      const allGroupsData = await authentikAPI('GET', '/core/groups/?page_size=500');
      const allGroups = allGroupsData.results || allGroupsData;
      const resolvedGroups = resolveGroupHierarchy(groups, allGroups);
      for (const groupPk of resolvedGroups) {
        await authentikAPI('POST', `/core/groups/${groupPk}/add_user/`, { pk: user.pk });
      }
    }
    res.json(user);
  } catch (err) {
    console.error('Admin create user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/:pk - Get single user
app.get('/api/admin/users/:pk', authMiddleware, requirePermission('bewohner-verwaltung', 'read'), async (req, res) => {
  try {
    const data = await authentikAPI('GET', `/core/users/${req.params.pk}/`);
    res.json(data);
  } catch (err) {
    console.error('Admin get user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-add all parent groups (via Authentik's parent field) when adding a child group
// Auto-remove parent groups when no other child in that parent remains
function resolveGroupHierarchy(desiredGroupPks, allGroups) {
  const groupByPk = {};
  const childrenOf = {}; // parentPk -> [childGroup, ...]
  for (const g of allGroups) {
    groupByPk[g.pk] = g;
    if (g.parent) {
      if (!childrenOf[g.parent]) childrenOf[g.parent] = [];
      childrenOf[g.parent].push(g);
    }
  }

  const result = new Set(desiredGroupPks);

  // Walk UP: add all ancestors of desired groups
  for (const pk of desiredGroupPks) {
    let current = groupByPk[pk];
    while (current && current.parent) {
      if (result.has(current.parent)) break;
      result.add(current.parent);
      current = groupByPk[current.parent];
    }
  }

  // Walk DOWN from removed parents: if a parent group is NOT in desired set,
  // but WAS added by walking up, check if it still has any desired children.
  // If not, remove it again. This handles the removal case.
  // We do this by re-validating: a parent stays only if at least one child is in the set.
  // Iterate bottom-up by removing parents that have no children in the result.
  let changed = true;
  while (changed) {
    changed = false;
    for (const pk of [...result]) {
      // Skip if this was explicitly desired (user checked it)
      if (desiredGroupPks.includes(pk)) continue;
      // This was auto-added as a parent - check if any child is still in result
      const children = childrenOf[pk] || [];
      const hasChildInResult = children.some(c => result.has(c.pk));
      if (!hasChildInResult) {
        result.delete(pk);
        changed = true;
      }
    }
  }

  return [...result];
}

// PUT /api/admin/users/:pk - Update user
app.put('/api/admin/users/:pk', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const { name, email, is_active, groups } = req.body;
    const userPk = parseInt(req.params.pk);
    const patchBody = {};
    if (name !== undefined) patchBody.name = name;
    if (email !== undefined) patchBody.email = email;
    if (is_active !== undefined) patchBody.is_active = is_active;
    const updated = Object.keys(patchBody).length > 0
      ? await authentikAPI('PATCH', `/core/users/${userPk}/`, patchBody)
      : await authentikAPI('GET', `/core/users/${userPk}/`);
    if (groups) {
      // Fetch all groups to resolve implied parent groups
      const allGroupsData = await authentikAPI('GET', '/core/groups/?page_size=500');
      const allGroups = allGroupsData.results || allGroupsData;
      const desiredGroups = resolveGroupHierarchy(groups, allGroups);

      const currentUser = await authentikAPI('GET', `/core/users/${userPk}/`);
      const currentGroups = currentUser.groups_obj ? currentUser.groups_obj.map(g => g.pk) : [];
      const toAdd = desiredGroups.filter(g => !currentGroups.includes(g));
      const toRemove = currentGroups.filter(g => !desiredGroups.includes(g));
      for (const groupPk of toAdd) {
        await authentikAPI('POST', `/core/groups/${groupPk}/add_user/`, { pk: userPk });
      }
      for (const groupPk of toRemove) {
        await authentikAPI('POST', `/core/groups/${groupPk}/remove_user/`, { pk: userPk });
      }
    }
    res.json(updated);
  } catch (err) {
    console.error('Admin update user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:pk - Delete/deactivate user
app.delete('/api/admin/users/:pk', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    await authentikAPI('DELETE', `/core/users/${req.params.pk}/`);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/groups - List all groups
app.get('/api/admin/groups', authMiddleware, requirePermission('bewohner-verwaltung', 'read'), async (req, res) => {
  try {
    const data = await authentikAPI('GET', '/core/groups/?page_size=500');
    res.json(data);
  } catch (err) {
    console.error('Admin list groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/groups/:pk - Get single group with members
app.get('/api/admin/groups/:pk', authMiddleware, requirePermission('bewohner-verwaltung', 'read'), async (req, res) => {
  try {
    const data = await authentikAPI('GET', `/core/groups/${req.params.pk}/`);
    // Resolve user details if group only has user PKs
    if (data.users && data.users.length > 0 && typeof data.users[0] === 'number') {
      const usersData = await authentikAPI('GET', '/core/users/?page_size=500');
      const allUsers = usersData.results || usersData;
      data.users = data.users.map(uid => allUsers.find(u => u.pk === uid)).filter(Boolean);
    }
    res.json(data);
  } catch (err) {
    console.error('Admin get group detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/groups/:pk/add_user - Add user to group
app.put('/api/admin/groups/:pk/add_user', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const data = await authentikAPI('POST', `/core/groups/${req.params.pk}/add_user/`, { pk: req.body.pk });
    res.json(data);
  } catch (err) {
    console.error('Admin add user to group error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/groups/:pk/remove_user - Remove user from group
app.put('/api/admin/groups/:pk/remove_user', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const data = await authentikAPI('POST', `/core/groups/${req.params.pk}/remove_user/`, { pk: req.body.pk });
    res.json(data);
  } catch (err) {
    console.error('Admin remove user from group error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DOCUMENTS (files from private GitHub repo, auth required)
// ═══════════════════════════════════════════════════════════════════

const GITHUB_DOCS_REPO = process.env.GITHUB_DOCS_REPO || 'Rosenweg/documents';
const GITHUB_DOCS_TOKEN = process.env.GITHUB_DOCS_TOKEN || '';
const GITHUB_DOCS_BRANCH = process.env.GITHUB_DOCS_BRANCH || 'main';

// Cache for document list (5 min TTL)
let docsListCache = { data: null, expires: 0 };

// GET /api/documents - List available documents (filtered by user's STWEGs)
app.get('/api/documents', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    let allDocs = docsListCache.data;
    if (!allDocs || docsListCache.expires <= now) {
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_DOCS_REPO}/git/trees/${GITHUB_DOCS_BRANCH}?recursive=1`,
        { headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
      );
      if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

      const tree = await response.json();
      const IGNORED = ['README.md', 'LICENSE', '.gitignore'];
      allDocs = tree.tree
        .filter(f => f.type === 'blob' && !IGNORED.includes(f.path) && !f.path.startsWith('.') && !f.path.endsWith('.gitkeep'))
        .map(f => ({
          path: f.path,
          size: f.size,
          url: `/api/documents/${f.path}`,
        }));
      docsListCache = { data: allDocs, expires: now + 5 * 60 * 1000 };
    }

    // Filter by user's allowed STWEGs
    const groups = req.user?.groups || [];
    const docs = allDocs.filter(f => isDocPathAllowed(f.path, groups));

    res.json(docs);
  } catch (err) {
    console.error('Documents list error:', err.message);
    res.status(500).json({ error: 'Dokumente konnten nicht geladen werden' });
  }
});

// POST /api/documents-preview - Convert Office document to PDF for viewing
const DOC_CONVERTER_URL = process.env.DOC_CONVERTER_URL || 'http://doc-converter:3000';
const OFFICE_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'dotx']);
const previewCache = new Map(); // path → { pdf: Buffer, expires: number }
const PREVIEW_CACHE_TTL = 30 * 60 * 1000; // 30 min

app.post('/api/documents-preview', authMiddleware, async (req, res) => {
  try {
    const filePath = req.body?.path;
    if (!filePath || filePath.includes('..') || filePath.startsWith('/')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const ext = filePath.split('.').pop().toLowerCase();
    if (!OFFICE_EXTS.has(ext)) {
      return res.status(400).json({ error: 'Dateityp wird nicht unterstützt' });
    }

    // Check access
    const groups = req.user?.groups || [];
    if (!isDocPathAllowed(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Zugriff auf dieses Dokument' });
    }

    // Check cache
    const now = Date.now();
    const cached = previewCache.get(filePath);
    if (cached && cached.expires > now) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="preview.pdf"`);
      return res.send(cached.pdf);
    }

    // Fetch document from GitHub
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const ghResp = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${encodedPath}?ref=${GITHUB_DOCS_BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3.raw' } }
    );
    if (!ghResp.ok) {
      if (ghResp.status === 404) return res.status(404).json({ error: 'Dokument nicht gefunden' });
      throw new Error(`GitHub API error: ${ghResp.status}`);
    }
    const docBuffer = Buffer.from(await ghResp.arrayBuffer());

    // Send to Gotenberg for conversion
    const fileName = filePath.split('/').pop();
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n`,
      `Content-Type: application/octet-stream\r\n\r\n`,
    ];
    const header = Buffer.from(bodyParts.join(''));
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const multipartBody = Buffer.concat([header, docBuffer, footer]);

    const convertResp = await fetch(`${DOC_CONVERTER_URL}/forms/libreoffice/convert`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody,
    });

    if (!convertResp.ok) {
      const errText = await convertResp.text().catch(() => '');
      throw new Error(`Converter error ${convertResp.status}: ${errText}`);
    }

    const pdfBuffer = Buffer.from(await convertResp.arrayBuffer());

    // Cache the result
    previewCache.set(filePath, { pdf: pdfBuffer, expires: now + PREVIEW_CACHE_TTL });
    // Limit cache size (max 50 entries)
    if (previewCache.size > 50) {
      const oldest = previewCache.keys().next().value;
      previewCache.delete(oldest);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Document preview error:', err.message);
    res.status(500).json({ error: 'Vorschau konnte nicht erstellt werden' });
  }
});

// GET /api/documents/:path(*) - Download a document
app.get('/api/documents/:path(*)', authMiddleware, async (req, res) => {
  try {
    const filePath = req.params.path;

    // Prevent path traversal
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    // Check STWEG access
    const groups = req.user?.groups || [];
    if (!isDocPathAllowed(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Zugriff auf dieses Dokument' });
    }

    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${encodedPath}?ref=${GITHUB_DOCS_BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3.raw' } }
    );

    if (!response.ok) {
      if (response.status === 404) return res.status(404).json({ error: 'Dokument nicht gefunden' });
      throw new Error(`GitHub API error: ${response.status}`);
    }

    // Set content type based on extension
    const ext = filePath.split('.').pop().toLowerCase();
    const contentTypes = {
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      txt: 'text/plain',
      csv: 'text/csv',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    const fileName = filePath.split('/').pop();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Document download error:', err.message);
    res.status(500).json({ error: 'Dokument konnte nicht geladen werden' });
  }
});

// PUT /api/documents/:path(*) - Upload/replace a document (admin only)
app.put('/api/documents/:path(*)', authMiddleware, canManageDocs, async (req, res) => {
  try {
    // Sanitize filename: keep folder structure, clean the filename part
    const rawPath = req.params.path;
    if (rawPath.includes('..') || rawPath.startsWith('/')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    const parts = rawPath.split('/');
    const fileName = parts.pop()
      .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .toLowerCase();
    parts.push(fileName);
    const filePath = parts.join('/');

    const groups = req.user?.groups || [];
    if (!canWriteDocPath(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff auf diesen Ordner' });
    }

    const content = req.body.toString('base64');

    // Check if file already exists (need SHA for update)
    let sha;
    const checkResp = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${filePath}?ref=${GITHUB_DOCS_BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (checkResp.ok) {
      const existing = await checkResp.json();
      sha = existing.sha;
    }

    const body = {
      message: `Upload: ${filePath.split('/').pop()} (von ${req.user.name || req.user.email})`,
      content,
      branch: GITHUB_DOCS_BRANCH,
    };
    if (sha) body.sha = sha;

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || `GitHub API error: ${response.status}`);
    }

    docsListCache = { data: null, expires: 0 };
    previewCache.delete(filePath);
    res.json({ success: true, path: filePath });
  } catch (err) {
    console.error('Document upload error:', err.message);
    res.status(500).json({ error: 'Dokument konnte nicht hochgeladen werden' });
  }
});

// DELETE /api/documents/:path(*) - Delete a document (admin only)
app.delete('/api/documents/:path(*)', authMiddleware, canManageDocs, async (req, res) => {
  try {
    const filePath = req.params.path;
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const groups = req.user?.groups || [];
    if (!canWriteDocPath(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff auf diesen Ordner' });
    }

    // Get SHA (required for delete)
    const checkResp = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${filePath}?ref=${GITHUB_DOCS_BRANCH}`,
      { headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!checkResp.ok) return res.status(404).json({ error: 'Dokument nicht gefunden' });
    const { sha } = await checkResp.json();

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_DOCS_REPO}/contents/${filePath}`,
      {
        method: 'DELETE',
        headers: { Authorization: `token ${GITHUB_DOCS_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Gelöscht: ${filePath.split('/').pop()} (von ${req.user.name || req.user.email})`,
          sha,
          branch: GITHUB_DOCS_BRANCH,
        }),
      }
    );

    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);

    docsListCache = { data: null, expires: 0 };
    previewCache.delete(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error('Document delete error:', err.message);
    res.status(500).json({ error: 'Dokument konnte nicht gelöscht werden' });
  }
});

// ─── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        wohnung VARCHAR(255),
        stweg INTEGER,
        role VARCHAR(50) DEFAULT 'bewohner',
        groups_json TEXT DEFAULT '[]',
        balance DECIMAL(10,2) DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS otp_codes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(6) NOT NULL,
        used BOOLEAN DEFAULT false,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email, used);

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

      CREATE TABLE IF NOT EXISTS wasch_rooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255),
        energy_meter_id VARCHAR(100),
        unifi_door_id VARCHAR(100),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wasch_reservations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        room_id INTEGER REFERENCES wasch_rooms(id),
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        recurring BOOLEAN DEFAULT false,
        recurring_until DATE,
        cancelled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wasch_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        room_id INTEGER REFERENCES wasch_rooms(id),
        reservation_id INTEGER REFERENCES wasch_reservations(id),
        status VARCHAR(50) DEFAULT 'active',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        duration_minutes INTEGER,
        energy_start_kwh DECIMAL(10,4),
        energy_end_kwh DECIMAL(10,4),
        energy_consumed DECIMAL(10,4),
        cost DECIMAL(10,2)
      );

      CREATE TABLE IF NOT EXISTS wasch_billing (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        month DATE NOT NULL,
        total_sessions INTEGER DEFAULT 0,
        total_kwh DECIMAL(10,4) DEFAULT 0,
        cost_per_kwh DECIMAL(10,4),
        total_cost DECIMAL(10,2) DEFAULT 0,
        email_sent BOOLEAN DEFAULT false,
        email_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, month)
      );

      CREATE TABLE IF NOT EXISTS wasch_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS kontakte (
        id SERIAL PRIMARY KEY,
        stweg INTEGER NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        telefon VARCHAR(50),
        funktion VARCHAR(255),
        wohnung VARCHAR(255),
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS email_verteiler (
        id SERIAL PRIMARY KEY,
        stweg INTEGER NOT NULL,
        name VARCHAR(255) NOT NULL,
        email_address VARCHAR(255) NOT NULL,
        members JSONB DEFAULT '[]',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS zaehler_daten (
        id SERIAL PRIMARY KEY,
        zaehler_id VARCHAR(100) NOT NULL,
        wert DECIMAL(12,4) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_zaehler ON zaehler_daten(zaehler_id, timestamp);

      CREATE TABLE IF NOT EXISTS email_log (
        id SERIAL PRIMARY KEY,
        verteiler_id INTEGER REFERENCES email_verteiler(id) ON DELETE SET NULL,
        from_email VARCHAR(255),
        from_name VARCHAR(255),
        subject TEXT,
        recipients_count INTEGER DEFAULT 0,
        has_attachments BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS recipients_list TEXT;
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS failed_recipients TEXT;
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'sent';
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS message_id VARCHAR(500);

      CREATE TABLE IF NOT EXISTS zaehler_config (
        id SERIAL PRIMARY KEY,
        zaehler_id VARCHAR(100) UNIQUE NOT NULL,
        bezeichnung VARCHAR(255),
        typ VARCHAR(100),
        standort VARCHAR(255),
        einheit VARCHAR(50) DEFAULT 'kWh',
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        stweg INTEGER,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_zaehler_config_user ON zaehler_config(user_id);

      -- Migrate users if missing columns
      ALTER TABLE users ADD COLUMN IF NOT EXISTS groups_json TEXT DEFAULT '[]';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

      -- Migrate email_verteiler if missing new columns
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS reply_to VARCHAR(255) DEFAULT 'sender';
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS subject_prefix VARCHAR(100);
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS group_name VARCHAR(255);
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS group_names JSONB DEFAULT '[]';
      -- Migrate single group_name to group_names array
      UPDATE email_verteiler SET group_names = jsonb_build_array(group_name)
        WHERE group_name IS NOT NULL AND group_name != '' AND (group_names IS NULL OR group_names = '[]'::jsonb);

      -- Migrate wasch_reservations: old schema had date+time_slot or missing room_id
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wasch_reservations' AND column_name='time_slot')
           OR (EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='wasch_reservations')
               AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wasch_reservations' AND column_name='room_id'))
        THEN
          -- Drop old table and recreate (no production data yet)
          DROP TABLE IF EXISTS wasch_sessions CASCADE;
          DROP TABLE IF EXISTS wasch_billing CASCADE;
          DROP TABLE IF EXISTS wasch_reservations CASCADE;
          CREATE TABLE wasch_reservations (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            room_id INTEGER REFERENCES wasch_rooms(id),
            start_time TIMESTAMP NOT NULL,
            end_time TIMESTAMP NOT NULL,
            recurring BOOLEAN DEFAULT false,
            recurring_until DATE,
            cancelled BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
          );
          CREATE TABLE wasch_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            room_id INTEGER REFERENCES wasch_rooms(id),
            reservation_id INTEGER REFERENCES wasch_reservations(id),
            status VARCHAR(50) DEFAULT 'active',
            started_at TIMESTAMP DEFAULT NOW(),
            ended_at TIMESTAMP,
            duration_minutes INTEGER,
            energy_start_kwh DECIMAL(10,4),
            energy_end_kwh DECIMAL(10,4),
            energy_consumed DECIMAL(10,4),
            cost DECIMAL(10,2)
          );
          CREATE TABLE wasch_billing (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            month DATE NOT NULL,
            total_sessions INTEGER DEFAULT 0,
            total_kwh DECIMAL(10,4) DEFAULT 0,
            cost_per_kwh DECIMAL(10,4),
            total_cost DECIMAL(10,2) DEFAULT 0,
            email_sent BOOLEAN DEFAULT false,
            email_sent_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, month)
          );
          RAISE NOTICE 'Migrated wasch_reservations to new schema (start_time/end_time)';
        END IF;
      END $$;

      -- Ensure duration_minutes column exists on wasch_sessions
      ALTER TABLE wasch_sessions ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;

      -- Permissions table
      CREATE TABLE IF NOT EXISTS wohnungen (
        id SERIAL PRIMARY KEY,
        stweg INTEGER NOT NULL,
        bezeichnung VARCHAR(50) NOT NULL,
        stockwerk VARCHAR(50),
        zimmer VARCHAR(10),
        flaeche_m2 DECIMAL(6,1),
        typ VARCHAR(50) DEFAULT 'Wohnung',
        besonderheiten TEXT,
        eigentuemer_name VARCHAR(255),
        eigentuemer_email VARCHAR(255),
        eigentuemer_telefon VARCHAR(100),
        eigentuemer_user_pk INTEGER,
        mieter_name VARCHAR(255),
        mieter_email VARCHAR(255),
        mieter_telefon VARCHAR(100),
        mieter_user_pk INTEGER,
        bewohnt_von VARCHAR(20) DEFAULT 'eigentuemer',
        waschkueche_berechtigt BOOLEAN DEFAULT true,
        notizen TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(stweg, bezeichnung)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wohnungen_stweg ON wohnungen(stweg);
    `);

    // Kontakte table for dynamic contacts per wohnung
    await client.query(`
      CREATE TABLE IF NOT EXISTS wohnungen_kontakte (
        id SERIAL PRIMARY KEY,
        wohnung_id INTEGER NOT NULL REFERENCES wohnungen(id) ON DELETE CASCADE,
        rolle VARCHAR(50) NOT NULL DEFAULT 'eigentuemer',
        name VARCHAR(255),
        email VARCHAR(255),
        telefon VARCHAR(100),
        adresse TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wohnungen_kontakte_wohnung ON wohnungen_kontakte(wohnung_id);
    `);

    // Migrate existing flat columns to kontakte table (one-time)
    const migrationCheck = await client.query(
      `SELECT COUNT(*) as cnt FROM wohnungen WHERE eigentuemer_name IS NOT NULL
       AND id NOT IN (SELECT DISTINCT wohnung_id FROM wohnungen_kontakte)`
    );
    if (parseInt(migrationCheck.rows[0].cnt) > 0) {
      console.log('Migrating wohnungen contacts to wohnungen_kontakte table...');
      await client.query(`
        INSERT INTO wohnungen_kontakte (wohnung_id, rolle, name, email, telefon, sort_order)
        SELECT id, 'eigentuemer', eigentuemer_name, eigentuemer_email, eigentuemer_telefon, 0
        FROM wohnungen WHERE eigentuemer_name IS NOT NULL
        AND id NOT IN (SELECT DISTINCT wohnung_id FROM wohnungen_kontakte)
      `);
      await client.query(`
        INSERT INTO wohnungen_kontakte (wohnung_id, rolle, name, email, telefon, sort_order)
        SELECT id, 'mieter', mieter_name, mieter_email, mieter_telefon, 1
        FROM wohnungen WHERE mieter_name IS NOT NULL
        AND id NOT IN (SELECT DISTINCT wohnung_id FROM wohnungen_kontakte WHERE rolle = 'mieter')
      `);
      console.log('Migration complete.');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        group_name VARCHAR(255) NOT NULL,
        page VARCHAR(100) NOT NULL,
        access VARCHAR(10) NOT NULL DEFAULT 'none' CHECK(access IN ('none', 'read', 'write')),
        UNIQUE(group_name, page)
      );
    `);

    // Create index after migration (separate query to avoid parse errors on old schema)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wasch_res_times ON wasch_reservations(room_id, start_time, end_time) WHERE cancelled = false;
    `);

    // Seed default wasch_rooms if none exist
    const roomsExist = await client.query('SELECT COUNT(*) FROM wasch_rooms');
    if (parseInt(roomsExist.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO wasch_rooms (name, location, energy_meter_id, unifi_door_id) VALUES
        ('Waschküche 1', 'Untergeschoss Links', NULL, NULL),
        ('Waschküche 2', 'Untergeschoss Rechts', NULL, NULL)
      `);
      console.log('Seeded 2 default Waschküche rooms');
    }

    // Seed default wasch_settings if none exist
    const settingsExist = await client.query('SELECT COUNT(*) FROM wasch_settings');
    if (parseInt(settingsExist.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO wasch_settings (key, value) VALUES
        ('cost_per_kwh', '0.30'),
        ('min_duration_minutes', '30'),
        ('max_duration_minutes', '720'),
        ('unifi_access_enabled', 'false'),
        ('unifi_access_host', ''),
        ('unifi_access_token', '')
      `);
      console.log('Seeded default Waschküche settings');
    }

    // Seed default permissions if none exist
    const permsExist = await client.query('SELECT COUNT(*) FROM permissions');
    if (parseInt(permsExist.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES
        ('Verwaltung', 'bewohner-verwaltung', 'write'),
        ('Verwaltung', 'energie-monitor', 'read'),
        ('Verwaltung', 'email-verteiler', 'read'),
        ('Verwaltung', 'zaehler', 'read'),
        ('Verwaltung', 'kontakte', 'read'),
        ('Verwaltung', 'verwaltung', 'read')
        ON CONFLICT DO NOTHING
      `);
      console.log('Seeded default permissions');
    }

    // Ensure Ausschuss groups have bewohner-verwaltung write access
    await client.query(`
      INSERT INTO permissions (group_name, page, access) VALUES
      ('stweg3-ausschuss', 'bewohner-verwaltung', 'write'),
      ('stweg6-ausschuss', 'bewohner-verwaltung', 'write')
      ON CONFLICT (group_name, page) DO NOTHING
    `);

    // Seed wohnungsverwaltung permissions for all Ausschuss groups
    const ausschussGroups = Object.values(STWEG_GROUPS).map(g => g.ausschuss).filter(Boolean);
    for (const groupName of ausschussGroups) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'wohnungsverwaltung', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }

    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Rosenweg API running on port ${PORT}`);
      // Start Waschküche cron jobs
      startWaschCron();
      // Start IMAP polling for verteiler emails
      startImapPoll();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
