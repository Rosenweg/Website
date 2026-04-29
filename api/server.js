const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs').promises;
const pathModule = require('path');

/** Escape string for safe HTML insertion */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
app.use('/api/documents', express.raw({ type: 'application/octet-stream', limit: '500mb' }));
app.use('/api/scan-upload', express.raw({ type: 'application/octet-stream', limit: '500mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return cb(null, true);
    const allowed = [SITE_URL, 'https://rosenweg4303.ch', 'https://www.rosenweg4303.ch', 'https://tv.rosenweg4303.ch'];
    if (allowed.includes(origin) || origin.endsWith('.rosenweg4303.ch')) return cb(null, true);
    cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));

// ─── Database ───────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'rosenweg',
  user: process.env.DB_USER || 'rosenweg',
  password: process.env.DB_PASSWORD || 'changeme',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));

// ─── Energy Database (for Waschküche billing) ──────────────────────
const energyPool = new Pool({
  host: process.env.ENERGY_DB_HOST || 'energy-db',
  port: process.env.ENERGY_DB_PORT || 5432,
  database: process.env.ENERGY_DB_NAME || 'energy',
  user: process.env.ENERGY_DB_USER || 'energy',
  password: process.env.ENERGY_DB_PASSWORD || 'energy2026',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
energyPool.on('error', (err) => console.error('[EnergyDB] Idle client error:', err.message));

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

// External sender allowlist for all rosenweg email functions (verteiler, drucker, etc.)
// Format: comma-separated emails. Senders from VERTEILER_DOMAIN, users table, or Authentik
// are always allowed; this covers external addresses that should be trusted.
const EMAIL_ALLOWLIST = (process.env.EMAIL_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ─── Helpers ────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Wrapper um transporter.sendMail() der jeden Versand in email_log protokolliert.
// trigger ist ein kurzer Slug ('print-notification', 'otp-login', ...) zur Nachvollziehbarkeit.
async function loggedSendMail(mailOpts, trigger, extra = {}) {
  const toRaw = mailOpts.to || '';
  const toAddresses = Array.isArray(toRaw) ? toRaw.join(', ') : String(toRaw);
  const recipientsCount = (toAddresses ? toAddresses.split(',').filter(s => s.trim()).length : 0);
  const fromRaw = String(mailOpts.from || MAIL_FROM);
  // Versuch, Name <email> aus from zu extrahieren
  let fromEmail = fromRaw, fromName = null;
  const m = fromRaw.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (m) { fromName = m[1].trim(); fromEmail = m[2].trim(); }
  let result, error;
  try {
    result = await transporter.sendMail(mailOpts);
  } catch (err) {
    error = err;
  }
  try {
    await pool.query(
      `INSERT INTO email_log (trigger, from_email, from_name, subject, to_addresses, recipients_count, has_attachments, status, message_id, error_message, verteiler_id, recipients_list)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        trigger, fromEmail, fromName, mailOpts.subject || null, toAddresses, recipientsCount,
        Array.isArray(mailOpts.attachments) && mailOpts.attachments.length > 0,
        error ? 'failed' : 'sent',
        result?.messageId || null,
        error ? String(error.message || error).slice(0, 1000) : null,
        extra.verteiler_id || null,
        extra.recipients_list || null,
      ]
    );
  } catch (logErr) {
    console.error('[email_log] insert error:', logErr.message);
  }
  if (error) throw error;
  return result;
}

function isAllowlistedSender(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return EMAIL_ALLOWLIST.includes(e) || EMAIL_ALLOWLIST.includes(e.replace(/\+[^@]*/, ''));
}

// Simple async semaphore to throttle Gotenberg/external converter calls.
// Default max 3 concurrent — high enough for normal load, low enough that
// 20+ parallel print emails don't slam the converter into timeouts.
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    queue.shift()();
  };
  return async function acquire() {
    await new Promise(r => { queue.push(r); next(); });
    return () => { active--; next(); };
  };
}
const gotenbergSemaphore = createSemaphore(parseInt(process.env.GOTENBERG_MAX_CONCURRENT || '3'));

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

// Rate limiting for OTP endpoints
const otpRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpRateLimit) {
    if (now - val.first > 10 * 60 * 1000) otpRateLimit.delete(key);
  }
}, 60 * 1000);

app.post('/api/otp/send', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });

  // Rate limit: max 3 OTP requests per email per 10 minutes
  const rateLimitKey = email.toLowerCase().trim();
  const now = Date.now();
  const entry = otpRateLimit.get(rateLimitKey);
  if (entry && now - entry.first < 10 * 60 * 1000 && entry.count >= 3) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warten Sie einige Minuten.' });
  }
  if (entry && now - entry.first < 10 * 60 * 1000) {
    entry.count++;
  } else {
    otpRateLimit.set(rateLimitKey, { first: now, count: 1 });
  }

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
    await loggedSendMail({
      from: MAIL_FROM,
      to: email,
      subject: 'Ihr Anmeldecode - Rosenweg',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1e40af;">Rosenweg Login</h2>
          <p>Hallo ${escapeHtml(user.name)},</p>
          <p>Ihr Anmeldecode lautet:</p>
          <div style="background: #f0f9ff; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${code}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px;">Der Code ist 10 Minuten gültig.</p>
        </div>
      `,
    }, 'otp-login');

    res.json({ success: true, message: 'OTP wurde per E-Mail gesendet' });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Fehler beim Senden des OTP-Codes' });
  }
});

// Rate limiting for OTP verification
const otpVerifyRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpVerifyRateLimit) {
    if (now - val.first > 10 * 60 * 1000) otpVerifyRateLimit.delete(key);
  }
}, 60 * 1000);

app.post('/api/otp/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'E-Mail und Code erforderlich' });

  // Rate limit: max 5 verify attempts per email per 10 minutes
  const verifyKey = email.toLowerCase().trim();
  const now = Date.now();
  const entry = otpVerifyRateLimit.get(verifyKey);
  if (entry && now - entry.first < 10 * 60 * 1000 && entry.count >= 5) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte warten Sie einige Minuten.' });
  }
  if (entry && now - entry.first < 10 * 60 * 1000) {
    entry.count++;
  } else {
    otpVerifyRateLimit.set(verifyKey, { first: now, count: 1 });
  }

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

    const codeA = Buffer.from(row.code); const codeB = Buffer.from(code.trim());
    if (codeA.length !== codeB.length || !crypto.timingSafeEqual(codeA, codeB)) {
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

// ─── Proxmox VE Config ──────────────────────────────────────────────
const PVE_API_URL = process.env.PVE_API_URL || 'https://100.64.2.20:8006';
const PVE_API_TOKEN = process.env.PVE_API_TOKEN || '';

// ═══════════════════════════════════════════════════════════════════
// AUTHENTIK OAuth2 LOGIN
// ═══════════════════════════════════════════════════════════════════

// OAuth2 state store (CSRF protection) - states expire after 10 minutes
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (now - val.created > 10 * 60 * 1000) oauthStates.delete(key);
  }
}, 60 * 1000);

// Returns the Authentik authorize URL for the frontend to redirect to
app.get('/api/auth/login', (req, res) => {
  const { redirect } = req.query;
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SITE_URL}/api/auth/callback`;

  // Sanitize redirect: only allow relative paths to prevent open redirect
  const safeRedirect = (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) ? redirect : '/';
  // Store state for CSRF validation in callback
  oauthStates.set(state, { redirect: safeRedirect, created: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: AUTHENTIK_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
  });
  res.redirect(`${AUTHENTIK_EXTERNAL_URL}/application/o/authorize/?${params}`);
});

// Logout - end Authentik session and redirect back
app.get('/api/auth/logout', async (req, res) => {
  // Invalidate local session if token is provided
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (token) {
    try {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      tokenCache.delete(token);
    } catch (err) {
      console.error('Session invalidation error:', err.message);
    }
  }

  const { redirect } = req.query;
  // Only allow redirects to our own site to prevent open redirect
  let postLogoutRedirect = SITE_URL;
  if (redirect) {
    try {
      const url = new URL(redirect, SITE_URL);
      if (url.origin === new URL(SITE_URL).origin) postLogoutRedirect = url.href;
    } catch {}
  }
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

  // Validate CSRF state
  const storedState = oauthStates.get(state);
  if (!storedState) return res.status(400).send('Ungültiger oder abgelaufener State-Parameter (CSRF-Schutz)');
  oauthStates.delete(state);

  // Sanitize redirect path: must be a relative path starting with /, prevent open redirect
  let redirectPath = storedState.redirect || '/';
  if (!redirectPath.startsWith('/') || redirectPath.startsWith('//')) redirectPath = '/';

  try {
    // Exchange code for token
    const tokenUrl = `${AUTHENTIK_URL}/application/o/token/`;
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${SITE_URL}/api/auth/callback`,
      client_id: AUTHENTIK_CLIENT_ID,
      client_secret: AUTHENTIK_CLIENT_SECRET,
    }).toString();
    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
      signal: AbortSignal.timeout(10000),
    });
    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) {
      console.error('Token exchange failed, status:', tokenResp.status, 'body:', tokenText.substring(0, 500));
      return res.status(400).send('Token-Austausch fehlgeschlagen');
    }
    let tokenData;
    try {
      tokenData = tokenText ? JSON.parse(tokenText) : {};
    } catch (parseErr) {
      console.error('Token response not JSON, status:', tokenResp.status, 'body:', tokenText.substring(0, 500));
      return res.status(500).send('Authentik-Antwort ungültig');
    }
    if (!tokenData.access_token) {
      console.error('Token exchange: no access_token, status:', tokenResp.status, 'body:', tokenText.substring(0, 200));
      return res.status(400).send('Token-Austausch fehlgeschlagen');
    }

    // Get user info
    const userResp = await fetch(`${AUTHENTIK_URL}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    const userInfo = await userResp.json();

    const email = (userInfo.email || userInfo.sub).toLowerCase();
    const username = userInfo.preferred_username || email.split('@')[0];
    const name = userInfo.name || username;
    const groups = userInfo.groups || [];
    const isAdmin = groups.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; });

    // Create/update user in DB
    const userResult = await pool.query(
      `INSERT INTO users (email, name, role, groups_json, username)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, groups_json = EXCLUDED.groups_json, username = EXCLUDED.username
       RETURNING id, email, name, wohnung, stweg, role, groups_json, username`,
      [email, name, isAdmin ? 'admin' : 'bewohner', JSON.stringify(groups), username]
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
        username: username,
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
// Purge expired entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenCache) { if (now - v.time > TOKEN_CACHE_TTL) tokenCache.delete(k); }
}, 5 * 60 * 1000);

async function validateAuthentikToken(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.time < TOKEN_CACHE_TTL) return cached.user;

  try {
    const params = new URLSearchParams({
      token,
      client_id: AUTHENTIK_CLIENT_ID,
      client_secret: AUTHENTIK_CLIENT_SECRET,
    });
    const resp = await fetch(`${AUTHENTIK_URL}/application/o/introspect/`, {
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
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING id, email, name, wohnung, stweg, role`,
      [email.toLowerCase(), name, (data.groups?.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) ? 'admin' : 'bewohner']
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
      req.user.id = req.user.user_id; // Ensure both .id and .user_id are set consistently
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
    return gl === 'technik' || gl === 'präsident' || gl === 'praesident' || gl.endsWith('-ausschuss');
  });
  if (!allowed) return res.status(403).json({ error: 'Nur Technik, Präsident und Ausschuss dürfen Dokumente verwalten' });
  next();
}

/** Parse and validate stweg param - returns number or null */
function parseStweg(val) {
  const n = parseInt(val, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
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
function isPraesident(groups) {
  return groups.some(g => g.toLowerCase() === 'präsident' || g.toLowerCase() === 'praesident');
}

/** Check if a document path is allowed for a user */
function isDocPathAllowed(filePath, groups) {
  if (isTechnik(groups) || isPraesident(groups)) return true;
  const folder = filePath.includes('/') ? filePath.split('/')[0] : 'allgemein';
  if (folder === 'allgemein' || folder.toLowerCase() === 'scans') return true;
  // Projekte folder: accessible to all eigentuemer
  if (folder === 'projekte' && groups.some(g => g.toLowerCase().includes('eigentuemer'))) return true;
  const stwegs = getUserStwegs(groups);
  const match = folder.match(/^stweg(\d+)$/);
  return match && stwegs.has(parseInt(match[1]));
}

/** Check if user can write to a document path */
function canWriteDocPath(filePath, groups) {
  if (isTechnik(groups) || isPraesident(groups)) return true;
  const folder = filePath.includes('/') ? filePath.split('/')[0] : 'allgemein';
  const isAusschuss = groups.some(g => g.toLowerCase().endsWith('-ausschuss'));
  if (!isAusschuss) return false;
  // Ausschuss members can write to their own stweg + allgemein + projekte
  if (folder === 'allgemein' || folder === 'projekte') return true;
  const stwegs = getUserStwegs(groups);
  const match = folder.match(/^stweg(\d+)$/);
  return match && stwegs.has(parseInt(match[1]));
}

/** Get STWEG numbers where user is Ausschuss member */
function getAusschussStwegs(groups) {
  const stwegs = new Set();
  for (const [nr, mapping] of Object.entries(STWEG_GROUPS)) {
    if (mapping.ausschuss && groups.some(g => g.toLowerCase() === mapping.ausschuss.toLowerCase())) {
      stwegs.add(parseInt(nr));
    }
  }
  return stwegs;
}

/** Check if user is Ausschuss for any STWEG */
function isAusschussForAny(groups) {
  return getAusschussStwegs(groups).size > 0;
}

/** Middleware: require user to have access to the :stweg param (Technik=all, Ausschuss/Bewohner=own STWEG) */
function requireStwegAccess(req, res, next) {
  const stweg = parseStweg(req.params.stweg);
  if (!stweg) return res.status(400).json({ error: 'Ungültige STWEG-Nummer' });
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return next();
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
  { id: 'proxmox-verwaltung', label: 'Proxmox-Verwaltung' },
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

async function getUserPermissions(groups) {
  const permissions = {};
  // Technik and Präsident get write on everything
  if (groups.some(g => { const gl = g.toLowerCase(); return gl === 'technik' || gl === 'präsident' || gl === 'praesident'; })) {
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
  // Ausschuss members get bewohner-verwaltung access for their own STWEG
  if (isAusschussForAny(groups) && !permissions['bewohner-verwaltung']) {
    permissions['bewohner-verwaltung'] = 'write';
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
  try {
  const userId = req.user.user_id || req.user.id;
  const result = await pool.query(
    'SELECT id, email, name, username, wohnung, stweg, role, phone, strasse, plz, ort, groups_json, avatar_url FROM users WHERE id = $1',
    [userId]
  );
  const u = result.rows[0] || req.user;
  const groups = (() => { try { return JSON.parse(u.groups_json || '[]'); } catch { return []; } })();

  // Fetch user's assigned meters from energy-db (direct + group-based)
  let meters = [];
  try {
    const userEmail = u.email?.toLowerCase();
    const lowerGroups = groups.map(g => g.toLowerCase());
    if (userEmail || lowerGroups.length > 0) {
      const meterResult = await energyPool.query(
        `SELECT DISTINCT m.id as zaehler_id, m.name as bezeichnung, m.type as typ
         FROM meters m
         LEFT JOIN meter_users mu ON mu.meter_id = m.id AND LOWER(mu.user_email) = $1
         LEFT JOIN meter_groups mg ON mg.meter_id = m.id AND LOWER(mg.group_name) = ANY($2)
         WHERE mu.id IS NOT NULL OR mg.id IS NOT NULL
         ORDER BY m.name`,
        [userEmail || '', lowerGroups]
      );
      meters = meterResult.rows;
    }
  } catch { /* energy-db may not be available */ }

  // Fetch user's effective permissions
  const permissions = await getUserPermissions(groups);

  // Auto-grant energie-monitor access if user has assigned meters
  if (meters.length > 0 && !permissions['energie-monitor']) {
    permissions['energie-monitor'] = 'read';
  }

  res.json({
    user: {
      id: u.id,
      username: u.username,
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
  } catch (err) {
    console.error('[auth/me] Error:', err.message);
    res.status(500).json({ error: 'Benutzerdaten konnten nicht geladen werden' });
  }
});

// GET /api/me/wohnungen — finds apartments where the logged-in user is a contact
app.get('/api/me/wohnungen', authMiddleware, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const name = req.user.name || '';
    if (!email && !name) return res.json({ wohnungen: [] });

    // Match by email (case-insensitive) OR by exact name
    const result = await pool.query(
      `SELECT k.id AS kontakt_id, k.name, k.email, k.telefon, k.adresse, k.rolle,
              w.id AS wohnung_id, w.bezeichnung, w.stockwerk, w.zimmer, w.flaeche_m2,
              w.typ, w.besonderheiten, w.bewohnt_von, w.stweg, w.notizen,
              w.waschkueche_berechtigt, w.wertquote_zaehler, w.wertquote_nenner
       FROM wohnungen_kontakte k JOIN wohnungen w ON k.wohnung_id = w.id
       WHERE LOWER(k.email) = $1 OR LOWER(k.name) = LOWER($2)
       ORDER BY w.stweg, w.bezeichnung`,
      [email, name]
    );
    res.json({ wohnungen: result.rows });
  } catch (err) {
    console.error('[me/wohnungen] error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/me/kontakt/:id — user can edit their own contact entry (email, telefon, adresse)
app.put('/api/me/kontakt/:id', authMiddleware, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const name = req.user.name || '';
    const own = await pool.query(
      `SELECT id, name, email FROM wohnungen_kontakte WHERE id = $1 AND (LOWER(email) = $2 OR LOWER(name) = LOWER($3))`,
      [req.params.id, email, name]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Du kannst nur deine eigenen Kontaktdaten bearbeiten' });

    const { email: newEmail, telefon, adresse } = req.body;
    if (newEmail && newEmail.toLowerCase() !== email && newEmail.toLowerCase() !== (own.rows[0].email || '').toLowerCase()) {
      const conflict = await pool.query("SELECT id FROM wohnungen_kontakte WHERE LOWER(email) = $1 AND id != $2", [newEmail.toLowerCase(), req.params.id]);
      if (conflict.rows.length > 0) return res.status(400).json({ error: 'Email wird bereits von einem anderen Kontakt verwendet' });
    }

    const result = await pool.query(
      `UPDATE wohnungen_kontakte SET email = COALESCE($1, email), telefon = COALESCE($2, telefon), adresse = COALESCE($3, adresse)
       WHERE id = $4 RETURNING id, name, email, telefon, adresse`,
      [newEmail || null, telefon || null, adresse || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[me/kontakt] error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/me/wohnung/:id — full apartment with kontakte (like /api/wohnungen/:stweg/:id)
app.get('/api/me/wohnung/:id', authMiddleware, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const name = req.user.name || '';
    const own = await pool.query(
      `SELECT w.* FROM wohnungen w JOIN wohnungen_kontakte k ON k.wohnung_id = w.id
       WHERE w.id = $1 AND (LOWER(k.email) = $2 OR LOWER(k.name) = LOWER($3)) LIMIT 1`,
      [req.params.id, email, name]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Du kannst nur deine eigenen Wohnungen sehen' });
    const w = own.rows[0];
    const k = await pool.query("SELECT * FROM wohnungen_kontakte WHERE wohnung_id = $1 ORDER BY rolle, sort_order, id", [w.id]);
    w.kontakte = k.rows;
    res.json(w);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/me/wohnung/:id — full update of own apartment (all fields + kontakte)
// Same shape as PUT /api/wohnungen/:stweg/:id but ownership-checked instead of permission-checked
app.put('/api/me/wohnung/:id', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const email = (req.user.email || '').toLowerCase();
    const name = req.user.name || '';
    const own = await client.query(
      `SELECT w.id, w.stweg FROM wohnungen w JOIN wohnungen_kontakte k ON k.wohnung_id = w.id
       WHERE w.id = $1 AND (LOWER(k.email) = $2 OR LOWER(k.name) = LOWER($3)) LIMIT 1`,
      [req.params.id, email, name]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Du kannst nur deine eigenen Wohnungen bearbeiten' });
    const stweg = own.rows[0].stweg;
    const b = req.body;
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE wohnungen SET bezeichnung=COALESCE($1,bezeichnung), stockwerk=$2, zimmer=$3, flaeche_m2=$4,
        typ=COALESCE($5,typ), besonderheiten=$6, bewohnt_von=COALESCE($7,bewohnt_von),
        waschkueche_berechtigt=COALESCE($8,waschkueche_berechtigt), notizen=$9,
        wertquote_zaehler=$10, wertquote_nenner=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [b.bezeichnung, b.stockwerk, b.zimmer, b.flaeche_m2, b.typ || 'Wohnung', b.besonderheiten,
       b.bewohnt_von || 'eigentuemer', b.waschkueche_berechtigt !== false, b.notizen,
       b.wertquote_zaehler || null, b.wertquote_nenner || null, req.params.id]
    );
    await saveKontakte(client, result.rows[0].id, b.kontakte, stweg);
    await client.query('COMMIT');
    const w = await loadWohnungMitKontakte(result.rows[0].id);
    res.json(w);
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[me/wohnung PUT] error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  } finally {
    client.release();
  }
});

// Change password (sets in both Authentik and AD)
const AD_PASSWORD_API_URL = process.env.AD_PASSWORD_API_URL || 'http://100.64.2.30:8446/';
const AD_PASSWORD_API_SECRET = process.env.AD_PASSWORD_API_SECRET || 'RwAdPwApi2026!';

app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password) {
    return res.status(400).json({ error: 'Neues Passwort erforderlich' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben' });
  }

  // User is already authenticated via authMiddleware — no need to verify old password
  const email = req.user.email;
  console.log(`[change-password] Request from user: ${email}`);

  // Step 1: Find user in Authentik and set new password
  let akUsername;
  try {
    const userSearch = await authentikAPI('GET', `/core/users/?search=${encodeURIComponent(email)}`);
    const akUser = (userSearch.results || []).find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!akUser) {
      console.error(`[change-password] User not found in Authentik: ${email}`);
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }
    akUsername = akUser.username;
    await authentikAPI('POST', `/core/users/${akUser.pk}/set_password/`, {
      password: new_password,
    });
    console.log(`[change-password] Authentik password set for ${akUsername}`);
  } catch (err) {
    console.error('Authentik password change error:', err.message);
    return res.status(500).json({ error: 'Passwort konnte in Authentik nicht geändert werden' });
  }

  // Step 2: Set new password in AD
  try {
    const adResp = await fetch(AD_PASSWORD_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AD_PASSWORD_API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: akUsername, password: new_password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!adResp.ok) {
      const err = await adResp.text();
      console.error('AD password change failed:', err);
      // Don't fail the whole request - Authentik password is already changed
    } else {
      console.log(`[change-password] AD password set for ${akUsername}`);
    }
  } catch (err) {
    console.error('AD password sync error:', err.message);
  }

  res.json({ status: 'ok', message: 'Passwort wurde geändert' });
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

// WiFi info for authenticated users (PPSK from UniFi)
const UNIFI_API_KEY = process.env.UNIFI_API_KEY || 'eQq7HtvQwjnAJzHwBLMrlueFDjSfmc6H';
const UNIFI_HOST = process.env.UNIFI_HOST || 'https://100.64.2.1';

app.get('/api/wifi', authMiddleware, async (req, res) => {
  try {
    // Get network configs (ID → name/vlan mapping)
    const netResp = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/rest/networkconf`, {
      headers: { 'X-API-Key': UNIFI_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    const nets = (await netResp.json()).data || [];
    const netMap = {};
    for (const n of nets) {
      netMap[n._id] = { name: n.name, vlan: n.vlan || null, subnet: n.ip_subnet || null };
    }

    // Get WLAN config with PPSKs
    const wlanResp = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/rest/wlanconf`, {
      headers: { 'X-API-Key': UNIFI_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    const wlans = (await wlanResp.json()).data || [];
    const rosenweg = wlans.find(w => w.name === 'Rosenweg' && w.enabled);
    if (!rosenweg) return res.status(404).json({ error: 'WLAN nicht gefunden' });

    // Extract house numbers from Authentik groups (e.g. "r9-bewohner", "r14-eigentuemer")
    // bewohner groups take priority over eigentuemer
    const groups = req.user.groups || [];
    const bewohnerHaeuser = new Set();
    const eigentuemerHaeuser = new Set();
    for (const g of groups) {
      const m = g.match(/^r(\d+)-(bewohner|eigentuemer)$/i);
      if (m) {
        if (m[2].toLowerCase() === 'bewohner') bewohnerHaeuser.add(parseInt(m[1]));
        else eigentuemerHaeuser.add(parseInt(m[1]));
      }
    }
    // Only show houses where user is bewohner; eigentuemer without bewohner see nothing
    const hausNummern = bewohnerHaeuser;

    // Fallback: extract from strasse field
    if (hausNummern.size === 0) {
      const userId = req.user.user_id || req.user.id;
      const userRow = await pool.query('SELECT strasse FROM users WHERE id = $1', [userId]);
      const strasse = userRow.rows[0]?.strasse || '';
      const hausMatch = strasse.match(/rosenweg\s+(\d+)/i);
      if (hausMatch) hausNummern.add(parseInt(hausMatch[1]));
    }

    // Find PPSKs for all user's houses
    const userWlans = [];
    if (rosenweg.private_preshared_keys_enabled) {
      for (const hausNr of hausNummern) {
        const targetNet = `RW${hausNr}-Clients`;
        for (const ppsk of rosenweg.private_preshared_keys || []) {
          const net = netMap[ppsk.networkconf_id];
          if (net && net.name === targetNet) {
            userWlans.push({
              hausNr,
              password: ppsk.password,
              network: net.name,
              vlan: net.vlan,
              subnet: net.subnet,
              rolle: bewohnerHaeuser.has(hausNr) ? 'bewohner' : 'eigentuemer',
            });
            break;
          }
        }
      }
    }

    // Build all PPSKs for admins
    let allPpsks = null;
    if (req.user.isAdmin) {
      allPpsks = (rosenweg.private_preshared_keys || []).map(ppsk => {
        const net = netMap[ppsk.networkconf_id] || {};
        return { network: net.name, vlan: net.vlan, password: ppsk.password };
      });
    }

    res.json({
      ssid: 'Rosenweg',
      wlans: userWlans,
      guest: { ssid: 'Rosenweg-Guest', password: null, security: 'open' },
      allPpsks,
    });
  } catch (err) {
    console.error('WiFi info error:', err.message);
    res.status(500).json({ error: 'WiFi-Daten konnten nicht geladen werden' });
  }
});

// ─── TV7 (Init7 IPTV) ────────────────────────────────────────────────
const TV7_PLAYLIST_URL = 'https://api.init7.net/tvchannels.m3u?rp=true';
const UDPXY_HOST = process.env.UDPXY_HOST || 'http://100.64.2.31:4022';
let tv7ChannelsCache = null;
let tv7CacheTime = 0;

async function fetchTV7Channels() {
  if (tv7ChannelsCache && Date.now() - tv7CacheTime < 3600000) return tv7ChannelsCache;
  const resp = await fetch(TV7_PLAYLIST_URL, { signal: AbortSignal.timeout(10000) });
  const text = await resp.text();
  const channels = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      const logoMatch = lines[i].match(/tvg-logo="([^"]+)"/);
      const groupMatch = lines[i].match(/group-title="([^"]+)"/);
      const nameMatch = lines[i].match(/,\s*(.+)$/);
      const url = (lines[i + 1] || '').trim();
      if (url.startsWith('http')) {
        channels.push({
          name: nameMatch ? nameMatch[1].trim() : 'Unknown',
          logo: logoMatch ? logoMatch[1] : '',
          group: groupMatch ? groupMatch[1] : '',
          streamUrl: url,
        });
      } else if (url.startsWith('udp://')) {
        const mcMatch = url.match(/udp:\/\/@?([\d.]+):(\d+)/);
        if (mcMatch) {
          channels.push({
            name: nameMatch ? nameMatch[1].trim() : 'Unknown',
            logo: logoMatch ? logoMatch[1] : '',
            group: groupMatch ? groupMatch[1] : '',
            multicast: `${mcMatch[1]}:${mcMatch[2]}`,
          });
        }
      }
    }
  }
  tv7ChannelsCache = channels;
  tv7CacheTime = Date.now();
  return channels;
}

app.get('/api/tv/channels', authMiddleware, async (req, res) => {
  try {
    const channels = await fetchTV7Channels();
    res.json(channels);
  } catch (err) {
    console.error('TV7 channels error:', err.message);
    res.status(500).json({ error: 'TV7-Kanäle konnten nicht geladen werden' });
  }
});

// TV proxy: short-lived HMAC tokens instead of leaking session tokens in URLs
const TV_PROXY_SECRET = crypto.randomBytes(32);
const TV_PROXY_TTL = 3600; // 1 hour

function createTvProxyToken(userId) {
  const exp = Math.floor(Date.now() / 1000) + TV_PROXY_TTL;
  const payload = `${userId}:${exp}`;
  const sig = crypto.createHmac('sha256', TV_PROXY_SECRET).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${sig}`;
}

function verifyTvProxyToken(token) {
  if (!token) return false;
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  const [userId, exp, sig] = parts;
  if (parseInt(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', TV_PROXY_SECRET).update(`${userId}:${exp}`).digest('hex').slice(0, 16);
  const sigBuf = Buffer.from(sig); const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

// Stream proxy: /api/tv/stream/:channelId → Init7 HLS (or udpxy for multicast)
// Proxied because Init7 only accepts traffic from their own IPs
app.get('/api/tv/stream/:channelId', (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, authMiddleware, async (req, res) => {
  const id = req.params.channelId;
  const proxyToken = createTvProxyToken(req.user.id || req.user.user_id);
  try {
    // HLS stream from Init7
    const init7Url = `https://api.tv.init7.net/api/live/?channel=${encodeURIComponent(id)}`;
    const upstream = await fetch(init7Url, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(502).json({ error: 'Stream nicht verfügbar' });
    const contentType = upstream.headers.get('content-type') || 'application/x-mpegURL';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Pipe the M3U8 playlist, rewriting segment URLs to also proxy through us
    const body = await upstream.text();
    // Rewrite relative/absolute segment URLs to proxy through API (short-lived HMAC token, not session)
    const rewritten = body.replace(/(https?:\/\/[^\s]+)/g, (url) => {
      return `/api/tv/proxy?url=${encodeURIComponent(url)}&pt=${proxyToken}`;
    });
    res.send(rewritten);
  } catch (err) {
    console.error('TV7 stream error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Stream-Fehler' });
  }
});

// Generic proxy for TV7 segment URLs (uses short-lived HMAC token, not session token)
app.get('/api/tv/proxy', (req, res, next) => {
  // Accept either session auth or HMAC proxy token
  if (req.headers.authorization || (req.query.token && !req.query.pt)) {
    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }
    return authMiddleware(req, res, next);
  }
  // Verify HMAC proxy token
  if (req.query.pt && verifyTvProxyToken(req.query.pt)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}, async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://api.tv.init7.net/')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const proxyToken = req.query.pt || createTvProxyToken(req.user?.id || 0);
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return res.status(upstream.status).end();
    const contentType = upstream.headers.get('content-type') || 'video/MP2T';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'max-age=2');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const buf = Buffer.from(await upstream.arrayBuffer());
    // If it's another M3U8, rewrite URLs
    if (contentType.includes('mpegURL') || url.endsWith('.m3u8')) {
      const text = buf.toString();
      const rewritten = text.replace(/(https?:\/\/[^\s]+)/g, (u) => {
        return `/api/tv/proxy?url=${encodeURIComponent(u)}&pt=${proxyToken}`;
      });
      res.send(rewritten);
    } else {
      res.send(buf);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).end();
  }
});

// ─── Print Job Pickup Confirmation ───────────────────────────────────
app.get('/api/pickup/:token', async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM print_jobs WHERE token = $1', [req.params.token]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Druckauftrag nicht gefunden' });
    res.json(job.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pickup/:token', async (req, res) => {
  try {
    const job = await pool.query('SELECT * FROM print_jobs WHERE token = $1', [req.params.token]);
    if (job.rows.length === 0) return res.status(404).json({ error: 'Druckauftrag nicht gefunden' });
    if (job.rows[0].status === 'picked_up') return res.json({ ...job.rows[0], message: 'Bereits abgeholt' });
    const updated = await pool.query(
      "UPDATE print_jobs SET status = 'picked_up', picked_up_at = NOW(), picked_up_by = $1 WHERE token = $2 RETURNING *",
      [req.body?.name || 'Empfänger', req.params.token]
    );
    res.json({ ...updated.rows[0], message: 'Abholung bestätigt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const requestedId = parseInt(req.params.id);
    const ownId = req.user.user_id || req.user.id;
    if (requestedId !== ownId && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Zugriff verweigert' });
    }
    const result = await pool.query(
      'SELECT id, name, email, wohnung, stweg, role, balance FROM users WHERE id = $1',
      [requestedId]
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
    const stweg = req.query.stweg ? parseInt(req.query.stweg) : null;
    const result = stweg
      ? await pool.query('SELECT * FROM wasch_rooms WHERE active = true AND stweg = $1 ORDER BY name', [stweg])
      : await pool.query('SELECT * FROM wasch_rooms WHERE active = true ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Räume' });
  }
});

app.post('/api/wasch/rooms', authMiddleware, adminOnly, async (req, res) => {
  const { name, location, stweg, energy_meter_id, unifi_door_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  try {
    const result = await pool.query(
      `INSERT INTO wasch_rooms (name, location, stweg, energy_meter_id, unifi_door_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, location || '', stweg || null, energy_meter_id || null, unifi_door_id || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

app.put('/api/wasch/rooms/:id', authMiddleware, adminOnly, async (req, res) => {
  const { name, location, stweg, energy_meter_id, unifi_door_id, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE wasch_rooms SET name=COALESCE($2,name), location=COALESCE($3,location),
       stweg=COALESCE($4,stweg), energy_meter_id=$5, unifi_door_id=$6, active=COALESCE($7,active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, location, stweg, energy_meter_id || null, unifi_door_id || null, active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Raum nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock on room_id to prevent concurrent overlapping reservations
    await client.query('SELECT pg_advisory_xact_lock($1)', [room_id]);

    if (recurring && recurring_until) {
      // Generate weekly recurring reservations (same weekday, same time)
      const created = [];
      const until = new Date(recurring_until);
      let curStart = new Date(startDt);
      let curEnd = new Date(endDt);

      while (curStart <= until) {
        // Check overlap with existing reservations
        const conflict = await client.query(
          `SELECT id FROM wasch_reservations
           WHERE room_id=$1 AND cancelled=false
           AND start_time < $3::timestamp AND end_time > $2::timestamp`,
          [room_id, curStart.toISOString(), curEnd.toISOString()]
        );
        if (conflict.rows.length === 0) {
          const result = await client.query(
            `INSERT INTO wasch_reservations (user_id, room_id, start_time, end_time, recurring, recurring_until)
             VALUES ($1, $2, $3, $4, true, $5) RETURNING *`,
            [req.user.user_id, room_id, curStart.toISOString(), curEnd.toISOString(), recurring_until]
          );
          created.push(result.rows[0]);
        }
        curStart.setDate(curStart.getDate() + 7);
        curEnd.setDate(curEnd.getDate() + 7);
      }
      await client.query('COMMIT');
      res.json({ created: created.length, reservations: created });
    } else {
      // One-time reservation - check overlap
      const conflict = await client.query(
        `SELECT id FROM wasch_reservations
         WHERE room_id=$1 AND cancelled=false
         AND start_time < $3::timestamp AND end_time > $2::timestamp`,
        [room_id, start_time, end_time]
      );
      if (conflict.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Zeitraum überschneidet sich mit bestehender Reservierung' });
      }

      const result = await client.query(
        `INSERT INTO wasch_reservations (user_id, room_id, start_time, end_time)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.user_id, room_id, start_time, end_time]
      );
      await client.query('COMMIT');
      res.json(result.rows[0]);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Fehler beim Erstellen der Reservierung' });
  } finally {
    client.release();
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
    const isAdmin = req.user.isAdmin;
    const reservation = await pool.query(
      isAdmin
        ? 'SELECT * FROM wasch_reservations WHERE id=$1'
        : 'SELECT * FROM wasch_reservations WHERE id=$1 AND user_id=$2',
      isAdmin ? [req.params.id] : [req.params.id, req.user.user_id]
    );
    if (reservation.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const r = reservation.rows[0];
    if (!r.recurring) return res.status(400).json({ error: 'Keine wiederkehrende Reservierung' });
    const result = await pool.query(
      `UPDATE wasch_reservations SET cancelled = true
       WHERE user_id=$1 AND room_id=$2 AND recurring_until=$3
       AND start_time >= NOW() AND cancelled=false`,
      [r.user_id, r.room_id, r.recurring_until]
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
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Ungültiges Monatsformat (YYYY-MM)' });
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
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Ungültiges Monatsformat (YYYY-MM)' });
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
    if (!/^\d{4}-\d{2}$/.test(monthStr)) return res.status(400).json({ error: 'Ungültiges Monatsformat (YYYY-MM)' });
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
    const ALLOWED_SETTINGS = ['cost_per_kwh', 'auto_billing', 'billing_day', 'reservation_max_days', 'reservation_max_per_user'];
    for (const [key, value] of Object.entries(settings)) {
      if (!ALLOWED_SETTINGS.includes(key)) continue;
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
    // Check if billing was already run for this month (prevent duplicate emails on restart)
    const existingBilling = await pool.query(
      'SELECT COUNT(*) FROM wasch_billing WHERE month = $1', [monthStart]
    );
    if (parseInt(existingBilling.rows[0].count) > 0) {
      console.log(`[Waschküche] Billing for ${monthStr} already exists, skipping`);
      return;
    }

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
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${escapeHtml(s.room_name)}</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${startStr}-${endStr} (${s.duration_minutes} Min.)</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;">${parseFloat(s.energy_consumed).toFixed(3)} kWh</td>
            <td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right;">CHF ${parseFloat(s.cost).toFixed(2)}</td>
          </tr>`;
        }).join('');

        try {
          await loggedSendMail({
            from: MAIL_FROM,
            to: user.email,
            subject: `Waschküche Abrechnung ${monthName} ${year} - STWEG 3`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
                <h2 style="color: #1a56db;">Waschküche Abrechnung</h2>
                <p>Hallo ${escapeHtml(user.name)},</p>
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
          }, 'wasch-billing');

          await pool.query(
            'UPDATE wasch_billing SET email_sent = true, email_sent_at = NOW() WHERE user_id = $1 AND month = $2',
            [user.user_id, monthStart]
          );
          console.log(`[Waschküche] Billing email sent to user ${user.user_id} for ${monthStr}`);
        } catch (emailErr) {
          console.error(`[Waschküche] Email to user ${user.user_id} failed:`, emailErr.message);
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
let isProcessingReservations = false;
let isRunningBilling = false;
let isManagingDoors = false;

async function guardedProcessReservations() {
  if (isProcessingReservations) { console.log('[Waschküche] processCompletedReservations still running, skipping'); return; }
  isProcessingReservations = true;
  try { await processCompletedReservations(); } finally { isProcessingReservations = false; }
}

async function guardedManageDoorAccess() {
  if (isManagingDoors) return;
  isManagingDoors = true;
  try { await manageDoorAccess(); } finally { isManagingDoors = false; }
}

async function guardedRunMonthlyBilling() {
  if (isRunningBilling) { console.log('[Waschküche] runMonthlyBilling still running, skipping'); return; }
  isRunningBilling = true;
  try { await runMonthlyBilling(); } finally { isRunningBilling = false; }
}

function startWaschCron() {
  // Process completed reservations every 5 min
  waschCronInterval = setInterval(guardedProcessReservations, 5 * 60 * 1000);
  activeIntervals.push(waschCronInterval);
  setTimeout(guardedProcessReservations, 30 * 1000);

  // Door access control every minute
  activeIntervals.push(setInterval(guardedManageDoorAccess, 60 * 1000));
  setTimeout(guardedManageDoorAccess, 10 * 1000);

  // Monthly billing on 1st at 08:00
  activeIntervals.push(setInterval(() => {
    const now = new Date();
    if (now.getDate() === 1 && now.getHours() === 8 && now.getMinutes() < 5) {
      guardedRunMonthlyBilling();
    }
  }, 5 * 60 * 1000));

  console.log('[Waschküche] Cron jobs started (reservations 5min, doors 1min, billing 1st@08:00)');
}

// Manual trigger for billing (admin only)
app.post('/api/wasch/admin/billing/run', authMiddleware, adminOnly, async (req, res) => {
  try {
    await runMonthlyBilling();
    res.json({ success: true, message: 'Abrechnung wurde ausgeführt' });
  } catch (err) {
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
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

// List all doors from UniFi Access
async function listDoors() {
  const data = await unifiAccessRequest('GET', '/doors');
  if (!data?.data) return [];
  return data.data.map(d => ({ id: d.unique_id || d._id, name: d.name, type: d.door_guard || d.type }));
}

app.get('/api/wasch/admin/doors/list', authMiddleware, adminOnly, async (req, res) => {
  try {
    const doors = await listDoors();
    res.json(doors);
  } catch (err) {
    res.status(500).json({ error: 'UniFi Access nicht erreichbar' });
  }
});

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
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// Admin: manually unlock a door
app.post('/api/wasch/admin/doors/:roomId/unlock', authMiddleware, adminOnly, async (req, res) => {
  try {
    const room = await pool.query('SELECT * FROM wasch_rooms WHERE id = $1', [req.params.roomId]);
    if (room.rows.length === 0) return res.status(404).json({ error: 'Raum nicht gefunden' });
    if (!room.rows[0].unifi_door_id) return res.status(400).json({ error: 'Kein UniFi Türschloss konfiguriert' });

    const duration = Math.min(Math.max(parseInt(req.body.duration) || 30, 5), 300); // 5s min, 5min max
    const ok = await unlockDoor(room.rows[0].unifi_door_id, duration);
    res.json({ success: ok, message: ok ? `Tür für ${duration}s entsperrt` : 'UniFi Access nicht erreichbar' });
  } catch (err) {
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// KONTAKTE (replaces n8n stweg3-save-json)
// ═══════════════════════════════════════════════════════════════════

app.get('/api/kontakte/:stweg', authMiddleware, async (req, res) => {
  const stweg = parseStweg(req.params.stweg);
  if (!stweg) return res.status(400).json({ error: 'Ungültige STWEG-Nummer' });
  try {
    const result = await pool.query(
      `SELECT * FROM kontakte WHERE stweg = $1 ORDER BY sort_order, name`,
      [stweg]
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

// Resolve a Verwaltungs-Gruppe (live from wohnungen_kontakte / wohnungen).
// Spec: "verwaltung:<rolle>[:stweg=N][:include_drucker]"
//   rolle: eigentuemer | verwalter | mieter | bewohner (= eigentuemer if bewohnt_von='eigentuemer' else mieter, per wohnung)
//   stweg=N optional: scope to one STWEG
//   include_drucker optional: include druckerr9+ tags as fallback when no real email
async function resolveVerwaltungsGroup(spec) {
  const parts = spec.split(':').slice(1); // strip "verwaltung:"
  const rolle = parts[0];
  let stwegFilter = null;
  let includeDrucker = false;
  for (const opt of parts.slice(1)) {
    if (opt.startsWith('stweg=')) stwegFilter = parseInt(opt.slice(6));
    else if (opt === 'include_drucker') includeDrucker = true;
  }
  const emails = new Set();
  const druckerCandidates = [];
  try {
    if (rolle === 'bewohner') {
      // Per-wohnung: pick the role that actually lives there (bewohnt_von)
      const q = await pool.query(`
        SELECT wk.email FROM wohnungen w
        JOIN wohnungen_kontakte wk ON wk.wohnung_id = w.id AND wk.rolle = w.bewohnt_von
        WHERE wk.email IS NOT NULL AND wk.email <> '' ${stwegFilter ? 'AND w.stweg = $1' : ''}
      `, stwegFilter ? [stwegFilter] : []);
      for (const r of q.rows) {
        const e = r.email.toLowerCase();
        if (e.startsWith('druckerr9+') || e.startsWith('druckerr13+')) druckerCandidates.push(e);
        else emails.add(e);
      }
    } else {
      const q = await pool.query(`
        SELECT wk.email FROM wohnungen_kontakte wk
        JOIN wohnungen w ON w.id = wk.wohnung_id
        WHERE wk.rolle = $1 AND wk.email IS NOT NULL AND wk.email <> '' ${stwegFilter ? 'AND w.stweg = $2' : ''}
      `, stwegFilter ? [rolle, stwegFilter] : [rolle]);
      for (const r of q.rows) {
        const e = r.email.toLowerCase();
        if (e.startsWith('druckerr9+') || e.startsWith('druckerr13+')) druckerCandidates.push(e);
        else emails.add(e);
      }
    }
    if (includeDrucker) druckerCandidates.forEach(e => emails.add(e));
  } catch (err) {
    console.error('resolveVerwaltungsGroup error:', err.message);
  }
  return [...emails];
}

// Resolve members for a verteiler. groupNames entries:
//   "verwaltung:..."  → live from Verwaltungs-DB
//   <other>           → Authentik group (resolveGroupEmails)
async function resolveVerteilerRecipients(verteiler) {
  // Druckeradressen ohne +tag (z.B. "druckerr9@…") sind keine zustellbaren Empfänger —
  // ohne tag weiss das Print-System nicht, an wen → niemals in die Verteiler-Liste lassen.
  const isInvalidDrucker = e => /^druckerr(9|13)@/i.test(e);
  const groupNames = verteiler.group_names?.length ? verteiler.group_names : (verteiler.group_name ? [verteiler.group_name] : []);
  if (groupNames.length > 0) {
    const allEmails = new Set();
    for (const gn of groupNames) {
      const emails = gn.startsWith('verwaltung:')
        ? await resolveVerwaltungsGroup(gn)
        : await resolveGroupEmails(gn);
      emails.forEach(e => { if (!isInvalidDrucker(e)) allEmails.add(e); });
    }
    return [...allEmails];
  }
  // Fallback: static members list (legacy — for verteilers not yet migrated)
  return (verteiler.members || [])
    .map(m => typeof m === 'string' ? m : m.email)
    .filter(e => e && !e.endsWith('.invalid') && !isInvalidDrucker(e));
}

app.get('/api/verteiler/by-stweg/:stweg', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email_address, stweg FROM email_verteiler WHERE stweg = $1 AND active = true ORDER BY name`,
      [parseStweg(req.params.stweg)]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

const verteilerSendLog = new Map(); // userId → [timestamps]
app.post('/api/verteiler/send', authMiddleware, adminOnly, async (req, res) => {
  // Rate limit: max 10 sends per 10 minutes per user
  const uid = req.user.user_id || req.user.id;
  const now = Date.now();
  const log = (verteilerSendLog.get(uid) || []).filter(t => now - t < 600000);
  if (log.length >= 10) {
    return res.status(429).json({ error: 'Zu viele Emails — bitte 10 Minuten warten' });
  }
  log.push(now);
  verteilerSendLog.set(uid, log);

  const { verteiler_id, subject, body, recipients } = req.body;
  if (!subject || !body || !recipients?.length) {
    return res.status(400).json({ error: 'Betreff, Text und Empfänger erforderlich' });
  }

  // Validate all recipients are valid email addresses
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validRecipients = recipients.filter(r => typeof r === 'string' && emailRegex.test(r));
  if (validRecipients.length === 0) {
    return res.status(400).json({ error: 'Keine gültigen E-Mail-Adressen' });
  }

  try {
    let sent = 0;
    const failed = [];
    for (const to of validRecipients) {
      try {
        await transporter.sendMail({
          from: MAIL_FROM,
          to,
          subject,
          html: body,
        });
        sent++;
      } catch (sendErr) {
        console.error(`Failed to send to recipient:`, sendErr.message);
        failed.push(to);
      }
    }

    // Log to email_log
    const status = failed.length === 0 ? 'sent' : (sent > 0 ? 'partial' : 'failed');
    await pool.query(
      `INSERT INTO email_log (verteiler_id, from_email, from_name, subject, recipients_count, has_attachments, recipients_list, failed_recipients, status, trigger, to_addresses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [verteiler_id || null, req.user?.email || MAIL_FROM, req.user?.name || 'Admin', subject, sent, false,
       JSON.stringify(recipients), failed.length > 0 ? JSON.stringify(failed) : null, status,
       'verteiler-direct', recipients.join(', ')]
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

app.post('/api/zaehler/daten', authMiddleware, async (req, res) => {
  // Receives meter data from ioBroker/webhook
  const { zaehler_id, wert, timestamp } = req.body;
  if (!zaehler_id || wert == null) return res.status(400).json({ error: 'zaehler_id und wert erforderlich' });
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
    await loggedSendMail({ from: MAIL_FROM, to, subject, html }, 'admin-direct-mail');
    res.json({ success: true });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'E-Mail-Versand fehlgeschlagen' });
  }
});


// ═══════════════════════════════════════════════════════════════════
// EMAIL VERTEILERLISTEN (Cloudflare Worker → Gmail+tag → IMAP → SMTP2GO)
// ═══════════════════════════════════════════════════════════════════

const EMAIL_INBOUND_SECRET = process.env.EMAIL_INBOUND_SECRET || '';
if (!process.env.EMAIL_INBOUND_SECRET) console.warn('WARNING: EMAIL_INBOUND_SECRET not set - inbound email endpoint is disabled');

// ─── Shared email processing logic ──────────────────────────────────
async function processInboundEmail(rawEmail, overrideToAddress, messageId) {
  const parsed = await simpleParser(Buffer.isBuffer(rawEmail) ? rawEmail : Buffer.from(rawEmail));

  const toAddress = overrideToAddress || parsed.to?.value?.[0]?.address?.toLowerCase();
  if (!toAddress) {
    return { success: false, error: 'No recipient found' };
  }

  // Bounce-/Auto-Reply-/System-Loop-Detection: niemals als neue Verteiler-Mail prozessieren —
  // sonst entsteht eine Endlosschleife wenn ein Bounce, eine Out-of-Office-Antwort oder
  // unser eigener Zustellbericht zurück an die Verteiler-Adresse geht.
  const senderAddrRaw = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subjLower = (parsed.subject || '').toLowerCase();
  const headersStr = (parsed.headerLines || []).map(h => `${h.key}: ${h.line}`).join('\n').toLowerCase();
  const ourDomain = (VERTEILER_DOMAIN || 'rosenweg4303.ch').toLowerCase();
  const isBounce =
    senderAddrRaw.startsWith('mailer-daemon@') ||
    senderAddrRaw.startsWith('postmaster@') ||
    senderAddrRaw === '<>' || senderAddrRaw === '' && subjLower.includes('delivery') ||
    /(undelivered|delivery failed|delivery status notification|returning message to sender|undeliverable|failure notice)/i.test(parsed.subject || '') ||
    /^auto-submitted:\s*auto-/im.test(headersStr) ||
    /^x-failed-recipients:/im.test(headersStr) ||
    /^content-type:\s*multipart\/report/im.test(headersStr) ||
    /^x-rosenweg-system:/im.test(headersStr) ||
    /^x-forwarded-by:\s*rosenweg verteiler/im.test(headersStr) || // Eigene Verteiler-Mail kommt zurück → Loop
    senderAddrRaw === `noreply@${ourDomain}` ||
    senderAddrRaw.startsWith('noreply@') ||
    senderAddrRaw.endsWith(`@${ourDomain}`) || // Jede Mail von eigener Domain ist System (Verteiler/Druckserver/etc.)
    /^zustellbericht:/i.test(parsed.subject || '') ||
    /zustellbericht:/i.test(parsed.subject || '') || // auch wenn prefixed
    senderAddrRaw === toAddress; // Self-loop: Verteiler an sich selbst
  if (isBounce) {
    console.log(`[Bounce] System-Loop/Bounce ignoriert (von ${senderAddrRaw}, Subject: ${(parsed.subject||'').substring(0,80)})`);
    return { success: true, action: 'bounce-skipped' };
  }

  console.log(`Email inbound → ${toAddress} | Subject: ${parsed.subject?.substring(0, 80)}`);

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

  // Sender-Validierung: wenn allowed_sender_groups gesetzt, muss Sender Mitglied sein
  const allowedGroups = Array.isArray(list.allowed_sender_groups) ? list.allowed_sender_groups : [];
  if (allowedGroups.length > 0 && senderEmail) {
    const senderEmailLower = senderEmail.toLowerCase();
    let allowed = false;
    if (AUTHENTIK_API_TOKEN) {
      try {
        const akData = await authentikAPI('GET', `/core/users/?email=${encodeURIComponent(senderEmailLower)}`);
        const user = akData.results?.find(u => u.email?.toLowerCase() === senderEmailLower);
        if (user) {
          const userGroupNames = (user.groups_obj || []).map(g => g.name.toLowerCase());
          allowed = allowedGroups.some(g => userGroupNames.includes(g.toLowerCase()));
        }
      } catch (err) { console.error('[Verteiler] Sender-Auth-Check fehler:', err.message); }
    }
    if (!allowed) {
      console.log(`[Verteiler] Sender ${senderEmail} nicht in erlaubten Gruppen [${allowedGroups.join(',')}] für ${toAddress} — abgelehnt`);
      // Höflicher Bounce an Sender
      try {
        await loggedSendMail({
          from: `"Rosenweg Verteiler" <noreply@${VERTEILER_DOMAIN}>`,
          to: senderEmail,
          subject: `Rückläufer: Versand an ${toAddress} nicht erlaubt`,
          text: `Hallo,\n\nIhre Email an ${toAddress} (Betreff: "${parsed.subject}") wurde nicht zugestellt — Sie sind nicht in einer der für diesen Verteiler erlaubten Gruppen (${allowedGroups.join(', ')}).\n\nBitte wenden Sie sich an den Ausschuss falls Sie hier publizieren möchten.\n\nRosenweg Verteiler`,
        }, 'verteiler-bounce-not-allowed');
      } catch (e) { console.error('[Verteiler] Bounce-Mail fehler:', e.message); }
      return { success: true, action: 'rejected', reason: 'sender not in allowed_sender_groups' };
    }
  }

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

  // DSGVO: Empfänger via BCC, damit niemand die Email-Adressen der anderen sieht.
  // To = Verteiler-Adresse selbst (sichtbar im Header als "An: eigentuemer@rosenweg4303.ch")
  // Drucker-Tags müssen einzeln versendet werden, damit das +tag fürs Routing erhalten bleibt
  // (Cloudflare/Gmail würde sonst einen einzigen +tag aus BCC nicht extrahieren können).
  const bccRecipients = recipients.filter(r => !r.startsWith('druckerr9+') && !r.startsWith('druckerr13+'));
  const druckerRecipients = recipients.filter(r => r.startsWith('druckerr9+') || r.startsWith('druckerr13+'));
  const baseMail = {
    from: `"${senderName} via ${list.name}" <${toAddress}>`,
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
  };
  // Bulk-Versand an alle echten Empfänger via BCC.
  // WICHTIG: To = "undisclosed-recipients:;" (RFC 5322 leere Group),
  // NICHT toAddress — sonst leitet Cloudflare Email Routing die Mail
  // an die Verteiler-Adresse selbst zurück und unser IMAP-Poll
  // verarbeitet sie erneut (Endlosschleife).
  if (bccRecipients.length > 0) {
    await transporter.sendMail({ ...baseMail, to: 'undisclosed-recipients:;', bcc: bccRecipients });
  }
  // Drucker-Tags einzeln (jeder Tag braucht seine eigene To-Zeile fürs Print-Routing)
  for (const drucker of druckerRecipients) {
    await transporter.sendMail({ ...baseMail, to: drucker });
  }
  console.log(`Distributed email to ${recipients.length} recipients for ${toAddress} (${bccRecipients.length} BCC + ${druckerRecipients.length} drucker-individuell)`);

  const logResult = await pool.query(
    `INSERT INTO email_log (verteiler_id, from_email, from_name, subject, recipients_count, has_attachments, recipients_list, status, message_id, trigger, to_addresses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [list.id, senderEmail, senderName, parsed.subject, recipients.length, attachments.length > 0,
     JSON.stringify(recipients), 'sent', messageId || parsed.messageId || null,
     'verteiler-batch', recipients.join(', ')]
  );

  // Schedule delivery report to sender after 90 seconds (only for internal senders — DSGVO)
  if (SMTP2GO_API_KEY && senderEmail && senderEmail.endsWith(`@${VERTEILER_DOMAIN}`)) {
    const logId = logResult.rows[0].id;
    setTimeout(() => sendDeliveryReport(logId, senderEmail, list.name, parsed.subject, recipients).catch(
      err => console.error('[DeliveryReport] Error:', err.message)
    ), 90_000);
  }

  return { success: true, action: 'distributed', recipients: recipients.length };
}

// ─── Delivery Report ────────────────────────────────────────────────
async function sendDeliveryReport(logId, senderEmail, verteilerName, originalSubject, recipientsList) {
  // Loop-Schutz: niemals Zustellbericht an noreply, system-Adressen oder Verteiler selbst senden
  const senderLower = (senderEmail || '').toLowerCase();
  if (!senderLower
      || senderLower.startsWith('noreply@')
      || senderLower.startsWith('mailer-daemon@')
      || senderLower.startsWith('postmaster@')
      || senderLower === `noreply@${VERTEILER_DOMAIN}`) {
    console.log(`[DeliveryReport] skipped — sender ${senderEmail} ist System-Adresse`);
    return;
  }
  // Niemals an einen Verteiler-Empfänger als Sender zurückschreiben (Self-Loop)
  const verteilerCheck = await pool.query(
    'SELECT 1 FROM email_verteiler WHERE LOWER(email_address) = $1 AND active = true LIMIT 1',
    [senderLower]
  );
  if (verteilerCheck.rows.length > 0) {
    console.log(`[DeliveryReport] skipped — sender ${senderEmail} ist selbst eine Verteiler-Adresse (Loop-Schutz)`);
    return;
  }
  // Niemals Zustellbericht zu Zustellbericht senden (Subject-Check)
  if (/^zustellbericht:/i.test(originalSubject || '')) {
    console.log(`[DeliveryReport] skipped — original subject is bereits ein Zustellbericht`);
    return;
  }
  const log = await pool.query('SELECT * FROM email_log WHERE id = $1', [logId]);
  if (log.rows.length === 0) return;
  const entry = log.rows[0];

  // Query SMTP2GO for delivery status
  const startDate = new Date(entry.created_at);
  startDate.setMinutes(startDate.getMinutes() - 5);
  const endDate = new Date(entry.created_at);
  endDate.setHours(endDate.getHours() + 2);

  const apiRes = await fetch(`${SMTP2GO_API_URL}/activity/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': SMTP2GO_API_KEY },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      search_subject: originalSubject,
      limit: 200,
    }),
  });
  const apiData = await apiRes.json();

  // Best status per recipient
  const statusMap = new Map();
  const priority = { clicked: 5, opened: 4, delivered: 3, soft_bounced: 2, bounced: 2, rejected: 2, sent: 1, queued: 0 };
  for (const e of (apiData.data?.events || [])) {
    const cur = statusMap.get(e.recipient);
    if (!cur || (priority[e.event] || 0) > (priority[cur.event] || 0)) {
      statusMap.set(e.recipient, { event: e.event, date: e.date });
    }
  }

  // Build report
  const statusIcon = { delivered: '\u2705', opened: '\u2705', clicked: '\u2705', sent: '\u23F3', queued: '\u23F3', soft_bounced: '\u26A0\uFE0F', bounced: '\u274C', rejected: '\u274C' };
  const statusLabel = { delivered: 'Zugestellt', opened: 'Gelesen', clicked: 'Link geklickt', sent: 'Gesendet', queued: 'In Warteschlange', soft_bounced: 'Temporärer Fehler', bounced: 'Fehlgeschlagen', rejected: 'Abgelehnt' };

  let rows = '';
  for (const email of recipientsList) {
    const status = statusMap.get(email);
    const icon = status ? (statusIcon[status.event] || '\u2753') : '\u2753';
    const label = status ? (statusLabel[status.event] || status.event) : 'Unbekannt';
    rows += `<tr><td style="padding:4px 12px;border-bottom:1px solid #eee">${escapeHtml(email)}</td><td style="padding:4px 12px;border-bottom:1px solid #eee">${icon} ${label}</td></tr>`;
  }

  const delivered = [...statusMap.values()].filter(s => ['delivered', 'opened', 'clicked'].includes(s.event)).length;
  const failed = [...statusMap.values()].filter(s => ['bounced', 'rejected'].includes(s.event)).length;
  const pending = recipientsList.length - delivered - failed;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1a56db">Zustellbericht: ${escapeHtml(verteilerName)}</h2>
      <p><strong>Betreff:</strong> ${escapeHtml(originalSubject || '(kein Betreff)')}</p>
      <p><strong>Empfänger:</strong> ${recipientsList.length} | <strong>Zugestellt:</strong> ${delivered} | <strong>Ausstehend:</strong> ${pending} | <strong>Fehlgeschlagen:</strong> ${failed}</p>
      <table style="border-collapse:collapse;width:100%;margin-top:12px">
        <thead><tr style="background:#f3f4f6"><th style="padding:6px 12px;text-align:left">Empfänger</th><th style="padding:6px 12px;text-align:left">Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#6b7280;font-size:12px;margin-top:16px">Automatischer Zustellbericht von Rosenweg Verteiler. Status kann sich noch ändern (z.B. "Gesendet" → "Zugestellt").</p>
    </div>`;

  await loggedSendMail({
    from: `"Rosenweg Verteiler" <noreply@rosenweg4303.ch>`,
    to: senderEmail,
    subject: `Zustellbericht: ${originalSubject || verteilerName}`,
    html,
    headers: {
      'Auto-Submitted': 'auto-replied',
      'X-Auto-Response-Suppress': 'All',
      'X-Rosenweg-System': 'verteiler-delivery-report',
      'Precedence': 'auto_reply',
    },
  }, 'verteiler-delivery-report');
  console.log(`[DeliveryReport] Sent to ${senderEmail} for log #${logId}: ${delivered}/${recipientsList.length} delivered`);
}

// HTTP endpoint (kept for direct API testing)
app.post('/api/email/inbound', async (req, res) => {
  const secret = req.headers['x-email-secret'] || req.query.secret;
  if (!EMAIL_INBOUND_SECRET || secret !== EMAIL_INBOUND_SECRET) {
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
    connectionTimeout: 30000,
  });
  client.on('error', (err) => {
    console.error('[IMAP] Connection error:', err.message);
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Only process UNSEEN emails from last 7 days. Seen flag is set on every
      // outcome (success, rejection, error) so reprocessing requires explicit
      // unflag — protects against race conditions and accidental re-runs.
      const since = new Date();
      since.setDate(since.getDate() - 7);
      const uids = await client.search({ since, seen: false }, { uid: true });
      if (!uids.length) { lock.release(); return; }

      for (const uid of uids) {
        try {
          // Fetch headers only first (fast, small)
          let headers = null;
          for await (const msg of client.fetch(String(uid), { headers: true }, { uid: true })) {
            headers = msg.headers?.toString() || '';
          }
          if (!headers) { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); continue; }

          // Extract Message-ID for deduplication (fallback: hash from Date+Subject+From)
          const msgIdMatch = headers.match(/^Message-ID:\s*<?([^>\r\n]+)>?/im);
          let messageId = msgIdMatch ? msgIdMatch[1].trim() : null;
          if (!messageId) {
            const dateH = (headers.match(/^Date:\s*(.+)/im) || [])[1] || '';
            const subjH = (headers.match(/^Subject:\s*(.+)/im) || [])[1] || '';
            const fromH = (headers.match(/^From:\s*(.+)/im) || [])[1] || '';
            messageId = 'gen-' + crypto.createHash('md5').update(dateH + subjH + fromH + uid).digest('hex');
          }

          let verteilerAddress = null;
          let alsoArchive = false;

          // Collect ALL @rosenweg4303.ch addresses from To/Cc/Bcc (primary source — what the sender really wrote)
          const allAddrs = [];
          const addrRegex = /^(?:To|Cc|Bcc):\s*([^\r\n](?:[^\r\n]|\r?\n[ \t])*)/gim;
          let am;
          while ((am = addrRegex.exec(headers)) !== null) {
            const lineAddrs = am[1].match(/[a-z0-9._+-]+@rosenweg4303\.ch/gi) || [];
            for (const a of lineAddrs) allAddrs.push(a.toLowerCase());
          }

          // Fallback: Delivered-To plus-tag (used by Cloudflare/Gmail routing)
          const plusMatch = headers.match(/^Delivered-To:\s*[^+\r\n]+\+([^@\r\n]+)@/im);
          if (allAddrs.length === 0 && plusMatch) {
            const base = plusMatch[1].toLowerCase().split('+')[0];
            allAddrs.push(`${base}@${VERTEILER_DOMAIN}`);
          }

          // Detect archiv@ as side-effect (separate from main delivery)
          const archivAddr = `archiv@${VERTEILER_DOMAIN}`;
          alsoArchive = allAddrs.includes(archivAddr);

          // Pick the primary verteiler address: prefer non-archiv addresses
          const primaryCandidates = allAddrs.filter(a => a !== archivAddr);
          const picked = primaryCandidates.length > 0 ? primaryCandidates[0] : (allAddrs[0] || null);
          if (picked) {
            // Keep full address for drucker (need +tag), strip for others
            if (picked.startsWith('druckerr9') || picked.startsWith('druckerr13')) {
              verteilerAddress = picked;
            } else {
              verteilerAddress = picked.replace(/\+[^@]*/, '');
            }
          }

          // ── Print-to-Email: druckerr9@ / druckerr13@ ──
          const isDruckerAddr = verteilerAddress && (verteilerAddress.startsWith(`druckerr9`) || verteilerAddress.startsWith(`druckerr13`));
          if (isDruckerAddr) {
            // Normalize: druckerr9+tag@domain → match on druckerr9
            const printerBase = verteilerAddress.split('+')[0].split('@')[0];
            const printer = printerBase === 'druckerr9' ? 'DruckerR9' : 'DruckerR13';
            const PRINT_API = process.env.PRINT_API_URL || 'http://100.64.2.32:8080';
            const PRINT_TOKEN = process.env.PRINT_API_SECRET || 'RwPrintApi2026';

            // Whitelist check: only known users may print (strip +tags from email)
            // Unfold MIME-folded From header (continuation lines start with WSP) before extraction.
            const headersUnfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
            const senderEmailRaw = headersUnfolded.match(/^From:\s*.*?([a-z0-9._+-]+@[a-z0-9.-]+)/im)?.[1]?.toLowerCase();
            const senderEmail = senderEmailRaw?.replace(/\+[^@]*/, ''); // strip +tag
            let authorized = false;
            if (senderEmail) {
              // Allow emails from own domain
              if (senderEmail.endsWith(`@${VERTEILER_DOMAIN}`)) authorized = true;
              // Check general allowlist (env: EMAIL_ALLOWLIST)
              if (!authorized && (isAllowlistedSender(senderEmail) || isAllowlistedSender(senderEmailRaw))) authorized = true;
              // Check DB for known users (exact match on stripped and original email)
              if (!authorized) {
                const known = await pool.query(
                  "SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(email) = $2",
                  [senderEmail, senderEmailRaw || '']
                );
                if (known.rows.length > 0) authorized = true;
              }
              // Also check Authentik users via API (exact email match)
              if (!authorized && AUTHENTIK_API_TOKEN) {
                try {
                  const akResp = await fetch(`${AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(senderEmail)}`, {
                    headers: { 'Authorization': `Bearer ${AUTHENTIK_API_TOKEN}` },
                    signal: AbortSignal.timeout(5000),
                  });
                  if (akResp.ok) {
                    const akData = await akResp.json();
                    // Verify exact email match (API may return partial matches)
                    if (akData.results?.some(u => u.email?.toLowerCase() === senderEmail)) authorized = true;
                  }
                } catch {}
              }
            }
            if (!authorized) {
              console.log(`[Print] Rejected: ${senderEmail || 'unknown'} not whitelisted for ${printer}`);
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
              continue;
            }

            // Extract recipient tag (e.g. druckerr9+ingrid.limbach@domain → ingrid.limbach)
            const tagMatch = verteilerAddress.match(/^drucker(?:r9|r13)\+([^@]+)@/i) ||
                             plusMatch?.[1]?.match(/^drucker(?:r9|r13)\+(.+)/i);
            const recipientTag = tagMatch ? tagMatch[1].replace(/\./g, ' ') : null;

            // Look up recipient: zuerst über die echte Drucker-Tag-Email in
            // wohnungen_kontakte (eindeutig), dann den Wohnungs-Kontext + alle
            // Eigentümer kombinieren. Fallback: alte Authentik-users-Suche.
            let recipientInfo = null;
            if (verteilerAddress) {
              const found = await pool.query(`
                SELECT
                  COALESCE(
                    (SELECT string_agg(name, ', ' ORDER BY sort_order, id)
                     FROM wohnungen_kontakte WHERE wohnung_id = w.id AND rolle = 'eigentuemer' AND name IS NOT NULL),
                    wk.name
                  ) AS name,
                  COALESCE(
                    (SELECT string_agg(DISTINCT adresse, '; ')
                     FROM wohnungen_kontakte WHERE wohnung_id = w.id AND adresse IS NOT NULL AND adresse <> ''),
                    wk.adresse
                  ) AS strasse,
                  w.bezeichnung AS wohnung,
                  w.stweg
                FROM wohnungen_kontakte wk
                JOIN wohnungen w ON w.id = wk.wohnung_id
                WHERE LOWER(wk.email) = LOWER($1)
                ORDER BY (CASE WHEN wk.rolle='eigentuemer' THEN 0 ELSE 1 END), wk.id
                LIMIT 1
              `, [verteilerAddress]);
              if (found.rows.length > 0) recipientInfo = found.rows[0];
            }
            // Fallback: alter Lookup über Authentik users-Tabelle (nur wenn nichts gefunden)
            if (!recipientInfo && recipientTag) {
              const nameSearch = recipientTag.split(' ').pop().replace(/%/g, '\\%').replace(/_/g, '\\_');
              const found = await pool.query("SELECT name, strasse, wohnung, stweg FROM users WHERE name ILIKE $1 LIMIT 1", [`%${nameSearch}%`]);
              if (found.rows.length > 0) recipientInfo = found.rows[0];
            }

            // Dedup: skip if (message_id, recipient) already printed (race-safe via UNIQUE index)
            const dedupName = recipientInfo?.name || recipientTag || 'allgemein';
            const dupCheck = await pool.query(
              'SELECT id FROM print_jobs WHERE message_id = $1 AND recipient_name = $2',
              [messageId, dedupName]
            );
            if (dupCheck.rows.length > 0) {
              console.log(`[IMAP] Skip duplicate print: ${dedupName} (msgId=${messageId})`);
              try { await client.mailboxCreate('Gedruckt'); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              try { await client.messageMove(uid, 'Gedruckt', { uid: true }); } catch {}
              continue;
            }

            // Create print job with token for pickup confirmation
            const jobToken = crypto.randomBytes(16).toString('hex');
            const pickupUrl = `${SITE_URL}/abholung.html?token=${jobToken}`;

            console.log(`[IMAP] Print job for ${printer} from ${senderEmail} (UID ${uid})${recipientInfo ? ` → ${recipientInfo.name}` : ''}`);
            try {
              const dl = await client.download(String(uid), undefined, { uid: true });
              const chunks = [];
              for await (const chunk of dl.content) chunks.push(chunk);
              const parsed = await simpleParser(Buffer.concat(chunks));
              const attachments = parsed.attachments || [];
              const printableExts = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'tif', 'txt']);

              // Count total pages to print
              const printableAtts = attachments.filter(a => printableExts.has((a.filename || '').split('.').pop().toLowerCase()));
              const hasBody = (parsed.text || '').trim().length > 10;
              const totalItems = printableAtts.length + (hasBody ? 1 : 0);

              // Build HTML cover page with logo
              const now = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
              const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              let rows = '';
              if (recipientInfo) {
                rows += `<tr><td class="label">Für</td><td class="value"><strong>${esc(recipientInfo.name)}</strong></td></tr>`;
                if (recipientInfo.strasse) rows += `<tr><td class="label">Adresse</td><td class="value">${esc(recipientInfo.strasse)}</td></tr>`;
                if (recipientInfo.wohnung) rows += `<tr><td class="label">Wohnung</td><td class="value">${esc(recipientInfo.wohnung)}</td></tr>`;
                if (recipientInfo.stweg) rows += `<tr><td class="label">STWEG</td><td class="value">${recipientInfo.stweg}</td></tr>`;
              } else if (recipientTag) {
                rows += `<tr><td class="label">Für</td><td class="value"><strong>${esc(recipientTag)}</strong></td></tr>`;
              }
              rows += `<tr><td colspan="2" style="padding:8px 0"><hr style="border:none;border-top:1px solid #ddd"></td></tr>`;
              rows += `<tr><td class="label">Von</td><td class="value">${esc(senderEmailRaw || 'unbekannt')}</td></tr>`;
              rows += `<tr><td class="label">Betreff</td><td class="value">${esc(parsed.subject || '(kein Betreff)')}</td></tr>`;
              rows += `<tr><td class="label">Datum</td><td class="value">${esc(now)}</td></tr>`;
              rows += `<tr><td class="label">Dokumente</td><td class="value">${totalItems}</td></tr>`;
              if (printableAtts.length > 0) {
                rows += `<tr><td class="label">Anhänge</td><td class="value">${printableAtts.map((a, i) => `${i + 1}. ${esc(a.filename)}`).join('<br>')}</td></tr>`;
              }

              const coverHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  @page { size: ${printer === 'DruckerR13' ? 'A3' : 'A4'}; margin: 20mm 25mm; }
  body { font-family: 'Times New Roman', Georgia, serif; color: #333; margin: 0; }
  .header { display: flex; align-items: center; gap: 24px; margin-bottom: 20px; }
  .header img { width: 90px; height: 90px; }
  .header-text h1 { font-family: Arial, Helvetica, sans-serif; font-size: 28px; color: #000; margin: 0; font-weight: bold; }
  .header-text p { font-size: 13px; color: #333; margin: 3px 0 0; }
  .section-title { color: #c41e1e; font-size: 18px; font-weight: bold; margin: 30px 0 8px; font-family: Arial, Helvetica, sans-serif; }
  table.info { width: 100%; border-collapse: collapse; border: 1px solid #ccc; }
  table.info thead th { background: #c41e1e; color: white; padding: 6px 12px; font-size: 12px; font-weight: bold; text-align: left; font-family: Arial, sans-serif; }
  table.info td { padding: 8px 12px; border-bottom: 1px solid #ddd; font-size: 13px; }
  table.info td.label { font-weight: bold; width: 220px; background: #fafafa; }
  table.info td.value { }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9px; color: #888; padding: 10px 0; border-top: 1px solid #ccc; }
</style></head><body>
  <div class="header">
    <img src="https://www.rosenweg4303.ch/logo-rosenweg.png" alt="Rosenweg">
    <div class="header-text">
      <h1>STWEG-Kooperation Rosenweg</h1>
      <p>Druckauftrag</p>
      <p>4303 Kaiseraugst</p>
    </div>
  </div>

  <h2 class="section-title">Empfänger</h2>
  <table class="info">
    <thead><tr><th>Funktion</th><th>Angabe</th></tr></thead>
    <tbody>
      ${recipientInfo ? `
        <tr><td class="label">Name</td><td class="value"><strong>${esc(recipientInfo.name)}</strong></td></tr>
        ${recipientInfo.strasse ? `<tr><td class="label">Adresse</td><td class="value">${esc(recipientInfo.strasse)}</td></tr>` : ''}
        ${recipientInfo.wohnung ? `<tr><td class="label">Wohnung / Einheit</td><td class="value">${esc(recipientInfo.wohnung)}</td></tr>` : ''}
        ${recipientInfo.stweg ? `<tr><td class="label">STWEG Nr.</td><td class="value">${recipientInfo.stweg}</td></tr>` : ''}
      ` : recipientTag ? `<tr><td class="label">Name</td><td class="value"><strong>${esc(recipientTag)}</strong></td></tr>` : `<tr><td class="label">Name</td><td class="value">Allgemein</td></tr>`}
    </tbody>
  </table>

  <h2 class="section-title">Druckauftrag</h2>
  <table class="info">
    <thead><tr><th>Funktion</th><th>Angabe</th></tr></thead>
    <tbody>
      <tr><td class="label">Drucker</td><td class="value">${esc(printer)}</td></tr>
      <tr><td class="label">Von</td><td class="value">${esc(senderEmailRaw || 'unbekannt')}</td></tr>
      <tr><td class="label">Betreff</td><td class="value">${esc(parsed.subject || '(kein Betreff)')}</td></tr>
      <tr><td class="label">Datum</td><td class="value">${esc(now)}</td></tr>
      <tr><td class="label">Anzahl Dokumente</td><td class="value">${totalItems}</td></tr>
      ${printableAtts.length > 0 ? `<tr><td class="label">Anhänge</td><td class="value">${printableAtts.map((a, i) => `${i + 1}. ${esc(a.filename)}`).join('<br>')}</td></tr>` : ''}
    </tbody>
  </table>

  ${recipientTag ? `
  <h2 class="section-title">Abholung bestätigen</h2>
  <table class="info">
    <thead><tr><th>Funktion</th><th>Angabe</th></tr></thead>
    <tbody>
      <tr>
        <td class="label">QR-Code scannen</td>
        <td class="value" style="text-align:center;padding:15px">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(pickupUrl)}" width="150" height="150" alt="QR">
          <br><span style="font-size:10px;color:#888">${esc(pickupUrl)}</span>
        </td>
      </tr>
      <tr><td class="label">Anleitung</td><td class="value">QR-Code mit dem Smartphone scannen und Abholung bestätigen.</td></tr>
    </tbody>
  </table>
  ` : ''}

  <div class="footer">STWEG-Kooperation Rosenweg • Druckauftrag • 4303 Kaiseraugst • ${esc(now)}</div>
</body></html>`;

              // Convert HTML to PDF via Gotenberg
              let printed = 0;
              try {
                const GOTENBERG = process.env.GOTENBERG_URL || 'http://doc-converter:3000';
                const formData = new FormData();
                formData.append('files', new Blob([coverHtml], { type: 'text/html' }), 'index.html');
                formData.append('paperWidth', printer === 'DruckerR13' ? '11.7' : '8.27');
                formData.append('paperHeight', printer === 'DruckerR13' ? '16.54' : '11.7');
                formData.append('marginTop', '0.5');
                formData.append('marginBottom', '0.5');
                formData.append('marginLeft', '0.5');
                formData.append('marginRight', '0.5');

                const release = await gotenbergSemaphore();
                let pdfResp;
                try {
                  pdfResp = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, {
                    method: 'POST',
                    body: formData,
                    signal: AbortSignal.timeout(30000),
                  });
                } finally { release(); }

                if (pdfResp.ok) {
                  const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
                  const coverResp = await fetch(`${PRINT_API}/print/${printer}`, {
                    method: 'POST',
                    body: pdfBuf,
                    headers: { 'Authorization': `Bearer ${PRINT_TOKEN}`, 'X-Filename': 'deckblatt.pdf' },
                    signal: AbortSignal.timeout(30000),
                  });
                  const coverResult = await coverResp.json();
                  console.log(`[Print] Cover page (PDF) → ${printer}: ${coverResult.status}`);
                } else {
                  // Fallback: print as plain text
                  const fallback = `DRUCKAUFTRAG - ${printer}\n${recipientInfo ? `Für: ${recipientInfo.name}\n${recipientInfo.strasse || ''}\n${recipientInfo.wohnung || ''}` : recipientTag || ''}\nVon: ${senderEmailRaw}\nBetreff: ${parsed.subject}\nDatum: ${now}\nDokumente: ${totalItems}`;
                  const coverResp = await fetch(`${PRINT_API}/print/${printer}`, {
                    method: 'POST',
                    body: Buffer.from(fallback),
                    headers: { 'Authorization': `Bearer ${PRINT_TOKEN}`, 'X-Filename': 'deckblatt.txt' },
                    signal: AbortSignal.timeout(30000),
                  });
                  console.log(`[Print] Cover page (text fallback) → ${printer}`);
                }
              } catch (e) { console.error(`[Print] Cover failed: ${e.message}`); }

              // Print email body if present and non-empty (skip empty/whitespace-only bodies)
              const bodyText = (parsed.text || '').trim();
              if (bodyText.length > 10) {
                try {
                  const body = Buffer.from(parsed.text || parsed.html || '');
                  const bodyResp = await fetch(`${PRINT_API}/print/${printer}`, {
                    method: 'POST',
                    body: body,
                    headers: { 'Authorization': `Bearer ${PRINT_TOKEN}`, 'X-Filename': 'email-body.txt' },
                    signal: AbortSignal.timeout(30000),
                  });
                  const bodyResult = await bodyResp.json();
                  console.log(`[Print] Email body → ${printer}: ${bodyResult.status}`);
                  printed++;
                } catch (e) { console.error(`[Print] Body failed: ${e.message}`); }
              }

              // Print attachments
              for (const att of printableAtts) {
                try {
                  const printResp = await fetch(`${PRINT_API}/print/${printer}`, {
                    method: 'POST',
                    body: att.content,
                    headers: { 'Authorization': `Bearer ${PRINT_TOKEN}`, 'X-Filename': att.filename },
                    signal: AbortSignal.timeout(30000),
                  });
                  const result = await printResp.json();
                  console.log(`[Print] ${att.filename} → ${printer}: ${result.status} ${result.message || ''}`);
                  printed++;
                } catch (printErr) {
                  console.error(`[Print] Failed: ${att.filename}: ${printErr.message}`);
                }
              }

              console.log(`[Print] ${printed} items sent to ${printer}`);

              // Save print job to DB (UNIQUE on message_id+recipient prevents race-duplicate)
              if (recipientTag) {
                try {
                  await pool.query(
                    `INSERT INTO print_jobs (token, printer, recipient_name, recipient_address, recipient_wohnung, recipient_stweg, sender_email, subject, documents, message_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                     ON CONFLICT (message_id, recipient_name) WHERE message_id IS NOT NULL DO NOTHING`,
                    [jobToken, printer, recipientInfo?.name || recipientTag, recipientInfo?.strasse || null,
                     recipientInfo?.wohnung || null, recipientInfo?.stweg || null,
                     senderEmailRaw, parsed.subject, printed, messageId]
                  );
                } catch (dbErr) { console.error(`[Print] DB save error: ${dbErr.message}`); }
              }

              // Notify Technik + Präsident if recipient was tagged
              if (recipientTag && printed > 0) {
                try {
                  const notifyGroups = ['technik', 'präsident'];
                  const notifyEmails = new Set();
                  const members = await pool.query(
                    "SELECT email, groups_json FROM users WHERE active = true"
                  );
                  for (const row of members.rows) {
                    try {
                      const groups = JSON.parse(row.groups_json || '[]');
                      if (groups.some(g => notifyGroups.includes(g.toLowerCase())) && row.email && !row.email.includes('placeholder')) {
                        notifyEmails.add(row.email);
                      }
                    } catch {}
                  }
                  if (notifyEmails.size > 0) {
                    const recipName = recipientInfo?.name || recipientTag;
                    const recipAddr = recipientInfo?.strasse || '';
                    const recipWohn = recipientInfo?.wohnung || '';
                    await loggedSendMail({
                      from: `"Rosenweg Druckserver" <noreply@${VERTEILER_DOMAIN}>`,
                      to: [...notifyEmails].join(', '),
                      subject: `Druckauftrag: ${recipName} (${printer})`,
                      text: `Druckauftrag verarbeitet\n\nEmpfänger: ${recipName}\n${recipAddr ? `Adresse: ${recipAddr}\n` : ''}${recipWohn ? `Wohnung: ${recipWohn}\n` : ''}Drucker: ${printer}\nBetreff: ${parsed.subject || '(kein Betreff)'}\nVon: ${senderEmailRaw}\nDokumente: ${printed}\nDatum: ${now}`,
                    }, 'print-notification');
                    console.log(`[Print] Notification sent to ${notifyEmails.size} recipients`);
                  }
                } catch (notifyErr) {
                  console.error(`[Print] Notification error: ${notifyErr.message}`);
                }
              }

              // Move to Gedruckt on success, Drucken-Fehlgeschlagen on full failure
              const targetFolder = printed > 0 ? 'Gedruckt' : 'Drucken-Fehlgeschlagen';
              try { await client.mailboxCreate(targetFolder); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              await client.messageMove(uid, targetFolder, { uid: true });

              // Notify Technik on full failure (printed=0) — they can manually retry
              if (printed === 0 && recipientTag) {
                try {
                  const notifyEmails = new Set();
                  const members = await pool.query("SELECT email, groups_json FROM users WHERE active = true");
                  for (const row of members.rows) {
                    try {
                      const groups = JSON.parse(row.groups_json || '[]');
                      if (groups.some(g => g.toLowerCase() === 'technik') && row.email && !row.email.includes('placeholder')) {
                        notifyEmails.add(row.email);
                      }
                    } catch {}
                  }
                  if (notifyEmails.size > 0) {
                    const recipName = recipientInfo?.name || recipientTag;
                    await loggedSendMail({
                      from: `"Rosenweg Druckserver" <noreply@${VERTEILER_DOMAIN}>`,
                      to: [...notifyEmails].join(', '),
                      subject: `[FEHLGESCHLAGEN] Druckauftrag: ${recipName} (${printer})`,
                      text: `Druckauftrag konnte NICHT gedruckt werden.\n\nEmpfänger: ${recipName}\nDrucker: ${printer}\nBetreff: ${parsed.subject || '(kein Betreff)'}\nVon: ${senderEmailRaw}\nDatum: ${now}\n\nDie Email liegt im IMAP-Folder "Drucken-Fehlgeschlagen". Bitte manuell prüfen.`,
                    }, 'print-failure');
                    console.log(`[Print] Failure notification sent to ${notifyEmails.size} Technik recipients`);
                  }
                } catch (notifyErr) {
                  console.error(`[Print] Failure-notification error: ${notifyErr.message}`);
                }
              }
            } catch (printErr) {
              console.error(`[Print] Error: ${printErr.message}`);
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            }
            continue;
          }

          // ── DMARC reports: move to dedicated folder for /api/dmarc/reports ──
          if (verteilerAddress === `dmarc@${VERTEILER_DOMAIN}`) {
            try {
              try { await client.mailboxCreate('DMARC'); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              await client.messageMove(uid, 'DMARC', { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
          }

          // ── Email Archive: archive if archiv@ was a recipient (CC) — only intercept move if archiv is the SOLE recipient ──
          // If archiv@ is just a CC alongside another verteiler, archive AND continue with verteiler processing.
          if (alsoArchive && verteilerAddress !== `archiv@${VERTEILER_DOMAIN}`) {
            const archDup = await pool.query('SELECT id FROM email_archive WHERE message_id = $1', [messageId]);
            if (archDup.rows.length === 0) {
              let archSource = null;
              for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
                archSource = msg.source;
              }
              if (archSource) {
                try { await archiveEmail(archSource, messageId); console.log(`[ARCHIVE] Also archived UID ${uid} (CC)`); }
                catch (archErr) { console.error(`[ARCHIVE] CC archive error UID ${uid}:`, archErr.message); }
              }
            }
            // DON'T continue — fall through to verteiler processing below
          }

          if (verteilerAddress === `archiv@${VERTEILER_DOMAIN}`) {
            // Dedup against email_archive
            const archDup = await pool.query('SELECT id FROM email_archive WHERE message_id = $1', [messageId]);
            if (archDup.rows.length > 0) {
              try {
                try { await client.mailboxCreate('Archiv'); } catch {}
                try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
                await client.messageMove(uid, 'Archiv', { uid: true });
              } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
              continue;
            }
            // Fetch full source for archiving
            let archSource = null;
            for await (const msg of client.fetch(String(uid), { source: true }, { uid: true })) {
              archSource = msg.source;
            }
            if (!archSource) { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); continue; }
            try {
              await archiveEmail(archSource, messageId);
              console.log(`[ARCHIVE] Archived UID ${uid}`);
            } catch (archErr) {
              console.error(`[ARCHIVE] Error archiving UID ${uid}:`, archErr.message);
            }
            try {
              try { await client.mailboxCreate('Archiv'); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              await client.messageMove(uid, 'Archiv', { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
          }

          if (!verteilerAddress) {
            // Not a verteiler email, move to _sonstige
            try {
              try { await client.mailboxCreate('Verteiler/_sonstige'); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
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
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              await client.messageMove(uid, 'Verteiler/_unbekannt', { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
          }

          // Dedup: skip if already processed (same message-id in email_log)
          const dup = await pool.query('SELECT id FROM email_log WHERE message_id = $1', [messageId]);
          if (dup.rows.length > 0) {
            // Already processed, just ensure it's moved to the right folder
            try {
              const folderName2 = verteilerAddress.split('@')[0];
              try { await client.mailboxCreate(`Verteiler/${folderName2}`); } catch {}
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              await client.messageMove(uid, `Verteiler/${folderName2}`, { uid: true });
            } catch { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
            continue;
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
          let processed = false;
          try {
            const result = await processInboundEmail(source, verteilerAddress, messageId);
            console.log(`[IMAP] Result: ${result.action} (${result.recipients || 0} recipients)`);
            processed = true;
          } catch (procErr) {
            console.error(`[IMAP] Processing failed for UID ${uid} (${verteilerAddress}):`, procErr.message);
            // Don't move, don't mark as read — will retry next poll
          }

          // Only move AFTER successful processing
          if (processed) {
            const folderName = verteilerAddress.split('@')[0];
            const targetFolder = `Verteiler/${folderName}`;
            try {
              // Erst als gelesen markieren, dann verschieben — damit Gmail-App keine Pop-ups
              // mehr fuer bereits verarbeitete Verteiler-Mails zeigt.
              try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch {}
              try { await client.mailboxCreate(targetFolder); } catch {}
              await client.messageMove(uid, targetFolder, { uid: true });
            } catch (moveErr) {
              console.error(`[IMAP] Move to ${targetFolder} failed:`, moveErr.message);
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            }
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
    try { client.close(); } catch {}
  }
}

// ─── Email Archive: store incoming archiv@ emails ───────────────────
async function archiveEmail(rawSource, messageId) {
  const parsed = await simpleParser(Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource));
  const fromEmail = parsed.from?.value?.[0]?.address || '';
  const fromName = parsed.from?.value?.[0]?.name || fromEmail;
  const toAddresses = (parsed.to?.value || []).map(a => a.address).join(', ');
  const subject = parsed.subject || '(kein Betreff)';
  const emailDate = parsed.date || new Date();

  const result = await pool.query(
    `INSERT INTO email_archive (from_email, from_name, to_addresses, subject, text_body, html_body, message_id, email_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [fromEmail, fromName, toAddresses, subject, parsed.text || '', parsed.html || '', messageId, emailDate]
  );
  const archiveId = result.rows[0].id;

  // Save attachments to document storage
  const attachmentsMeta = [];
  if (parsed.attachments?.length) {
    const archivDir = pathModule.join(DOCS_PATH, 'archiv');
    try { await fs.mkdir(archivDir, { recursive: true }); } catch {}

    for (let i = 0; i < parsed.attachments.length; i++) {
      const att = parsed.attachments[i];
      let filename = (att.filename || `attachment_${i + 1}`).replace(/[/\\:*?"<>|]/g, '_').substring(0, 200);
      // Avoid collisions within same email
      const storedName = `${archiveId}_${filename}`;
      const storedPath = pathModule.join(archivDir, storedName);
      try {
        await fs.writeFile(storedPath, att.content);
        attachmentsMeta.push({
          filename: att.filename || filename,
          content_type: att.contentType || 'application/octet-stream',
          size: att.size || att.content?.length || 0,
          stored_name: storedName,
        });
      } catch (err) {
        console.error(`[ARCHIVE] Failed to save attachment ${filename}:`, err.message);
      }
    }

    if (attachmentsMeta.length) {
      await pool.query('UPDATE email_archive SET attachments = $1 WHERE id = $2', [JSON.stringify(attachmentsMeta), archiveId]);
    }
  }

  console.log(`[ARCHIVE] Archived: "${subject}" from ${fromEmail} (${attachmentsMeta.length} attachments)`);
  return archiveId;
}

let imapPolling = false;
let imapConsecutiveErrors = 0;

async function guardedPollGmail() {
  if (imapPolling) return;
  imapPolling = true;
  try {
    // Hard timeout: abort entire poll after 5 minutes to prevent hangs
    await Promise.race([
      pollGmailForVerteiler(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Poll timeout (5min)')), 300000)),
    ]);
    imapConsecutiveErrors = 0;
  } catch (err) {
    imapConsecutiveErrors++;
    console.error(`[IMAP] Poll failed (${imapConsecutiveErrors} consecutive):`, err.message);
  } finally {
    imapPolling = false;
  }
}

function startImapPoll() {
  if (!IMAP_USER || !IMAP_PASS) {
    console.log('[IMAP] No credentials configured, polling disabled');
    return;
  }
  console.log(`[IMAP] Polling ${IMAP_USER} every ${IMAP_POLL_INTERVAL / 1000}s`);
  // Reliable polling: setInterval ensures polls keep running even if the chain breaks
  activeIntervals.push(setInterval(() => guardedPollGmail(), IMAP_POLL_INTERVAL));
  // First poll after 10s (wait for DNS/network to be ready)
  setTimeout(() => guardedPollGmail(), 10000);
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
  const order = { 'ug': 0, 'eg': 1, '1og': 2, '1.og': 2, '2og': 3, '2.og': 3, '3og': 4, '3.og': 4, 'dg': 5 };
  const parseW = (w) => {
    if (!w) return { floor: -100, num: 0, isPark: false, isOther: true };
    const s = w.toLowerCase().replace(/\s+/g, '');
    // Parkplatz format: "P1", "P107"
    const pm = s.match(/^p(\d+)$/);
    if (pm) return { floor: -1, num: parseInt(pm[1]), isPark: true, isOther: false };
    // Match formats: "EG.1", "1OG.2", "9.EG.1", "9.2OG.3"
    const m = s.match(/(?:\d+\.)?(ug|eg|\d+\.?og|dg)\.?(\d+)?/);
    if (!m) return { floor: -100, num: 0, isPark: false, isOther: true };
    return { floor: order[m[1]] ?? -100, num: parseInt(m[2]) || 0, isPark: false, isOther: false };
  };
  const pa = parseW(a), pb = parseW(b);
  // Parkplaetze: ascending by number
  if (pa.isPark && pb.isPark) return pa.num - pb.num;
  // Sonstiges (Hobbyraum etc.): always last, alphabetically among themselves
  if (pa.isOther && !pb.isOther) return 1;
  if (!pa.isOther && pb.isOther) return -1;
  if (pa.isOther && pb.isOther) return String(a).localeCompare(String(b));
  // Wohnungen: bottom floor first (EG → 1OG → 2OG), then by number ascending
  return pa.floor - pb.floor || pa.num - pb.num;
}

app.get('/api/stweg/:nr/kontakte', authMiddleware, async (req, res) => {
  try {
    const nr = parseInt(req.params.nr);
    if (!nr || nr < 1 || nr > 8) return res.status(404).json({ error: 'STWEG nicht gefunden' });

    // Check access: user must be in this STWEG's groups or Technik
    const stwegGroups = STWEG_GROUPS[nr];
    const allUserGroups = await resolveAncestorGroups(req.user.groups || []);
    const accessGroups = stwegGroups ? Object.values(stwegGroups).map(g => g.toLowerCase()) : [];
    const hasAccess = allUserGroups.some(g => g === 'technik' || g === 'präsident' || g === 'praesident') ||
                      allUserGroups.some(g => accessGroups.includes(g));
    if (!hasAccess) return res.status(403).json({ error: 'Kein Zugriff auf diese STWEG' });

    // Load apartments + contacts from Verwaltungs-DB
    const wRes = await pool.query('SELECT * FROM wohnungen WHERE stweg = $1', [nr]);
    const kRes = await pool.query(
      `SELECT k.* FROM wohnungen_kontakte k JOIN wohnungen w ON k.wohnung_id = w.id WHERE w.stweg = $1 ORDER BY k.rolle, k.sort_order, k.id`,
      [nr]
    );

    // Group kontakte by wohnung_id
    const kontakteMap = {};
    for (const k of kRes.rows) {
      if (!kontakteMap[k.wohnung_id]) kontakteMap[k.wohnung_id] = [];
      kontakteMap[k.wohnung_id].push({
        name: k.name, email: k.email, telefon: k.telefon, rolle: k.rolle,
      });
    }

    // Build wohnungen array with bewohner
    const wohnungen = wRes.rows.map(w => {
      let bewohner = kontakteMap[w.id] || [];
      // Fallback: flat fields if no kontakte
      if (bewohner.length === 0 && w.eigentuemer_name) {
        bewohner.push({ name: w.eigentuemer_name, email: w.eigentuemer_email, telefon: w.eigentuemer_telefon, rolle: 'eigentuemer' });
      }
      if (bewohner.length === 0 && w.mieter_name) {
        bewohner.push({ name: w.mieter_name, email: w.mieter_email, telefon: w.mieter_telefon, rolle: 'mieter' });
      }
      // Eigentuemer first
      bewohner.sort((a, b) => {
        if (a.rolle === 'eigentuemer' && b.rolle !== 'eigentuemer') return -1;
        if (a.rolle !== 'eigentuemer' && b.rolle === 'eigentuemer') return 1;
        return 0;
      });
      return { bezeichnung: w.bezeichnung, typ: w.typ, bewohner };
    }).filter(w => w.bewohner.length > 0);

    wohnungen.sort((a, b) => wohnungSort(a.bezeichnung, b.bezeichnung));

    // Ausschuss-Vertreter from Authentik (still group-based)
    let ausschuss = [];
    if (stwegGroups) {
      try {
        const { groups: allGroups, users: allUsers } = await getKontakteData();
        const ausschussPks = stwegGroups.ausschuss ? resolveDescendantPks(stwegGroups.ausschuss, allGroups) : new Set();
        const ausschussUsers = getUsersInGroups(ausschussPks, allUsers);
        ausschuss = ausschussUsers.map(u => ({
          name: u.name, email: u.email,
          telefon: u.attributes?.telefon || null,
          funktion: u.attributes?.funktion || 'Vertreter',
        }));
      } catch {}
    }

    res.json({ stweg: nr, wohnungen, ausschuss });
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
  // Fallback: synthesize kontakte from flat fields
  if (w.kontakte.length === 0 && w.eigentuemer_name) {
    w.kontakte.push({ rolle: 'eigentuemer', name: w.eigentuemer_name, email: w.eigentuemer_email || null, telefon: w.eigentuemer_telefon || null, adresse: null });
  }
  if (w.kontakte.length === 0 && w.mieter_name) {
    w.kontakte.push({ rolle: 'mieter', name: w.mieter_name, email: w.mieter_email || null, telefon: w.mieter_telefon || null, adresse: null });
  }
  return w;
}

// Helper: save kontakte for a wohnung (replace all)
async function saveKontakte(client, wohnungId, kontakte, stweg) {
  // Load old kontakte before deleting (for tracking removals)
  const oldRes = await client.query('SELECT * FROM wohnungen_kontakte WHERE wohnung_id = $1', [wohnungId]);
  const oldKontakte = oldRes.rows;

  await client.query('DELETE FROM wohnungen_kontakte WHERE wohnung_id = $1', [wohnungId]);
  if (!kontakte || !Array.isArray(kontakte)) return;
  const VALID_ROLLEN = ['eigentuemer', 'mieter', 'verwalter', 'bewohner', 'sonstige'];
  for (let i = 0; i < kontakte.length; i++) {
    const k = kontakte[i];
    if (!k.name && !k.email) continue;
    const rolle = VALID_ROLLEN.includes(k.rolle) ? k.rolle : 'eigentuemer';
    // Default authentik_zugang: true für Eigentümer/Verwalter, sonst null (opt-in via UI checkbox)
    const authentikZugang = k.authentik_zugang !== undefined ? k.authentik_zugang
      : (rolle === 'eigentuemer' || rolle === 'verwalter') ? true : null;
    // Auto-Drucker-Tag wenn weder echte Email noch Authentik-Zugang gewünscht
    let email = k.email || null;
    if (!email && authentikZugang !== true && k.name) {
      const slug = k.name.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9 -]/g, '')
        .trim()
        .split(/\s+/).reverse().join('.'); // "Hans Müller" → "mueller.hans"
      if (slug) email = `druckerr9+${slug}@${VERTEILER_DOMAIN}`;
    }
    await client.query(
      `INSERT INTO wohnungen_kontakte (wohnung_id, rolle, name, email, telefon, adresse, sort_order, authentik_zugang)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [wohnungId, rolle, k.name || null, email, k.telefon || null, k.adresse || null, i, authentikZugang]
    );
    // Cancel pending deletion if contact is re-added
    if (email) cancelPendingDeletion(email).catch(() => {});
  }

  // Track removed kontakte for delayed Authentik deletion
  if (stweg) trackRemovedKontakte(wohnungId, stweg, oldKontakte, kontakte).catch(() => {});
}

// Sync kontakte with email to Authentik as users and assign STWEG groups
// bewohntVon: 'eigentuemer' means self-occupied → Eigentümer/Verwalter also get bewohner group
async function syncKontakteToAuthentik(stweg, kontakte, bewohntVon) {
  if (!AUTHENTIK_API_TOKEN || !kontakte || !Array.isArray(kontakte)) return;
  // Authentik-Zugang: automatisch für Eigentümer/Verwalter, opt-in für Mieter/Bewohner.
  const withEmail = kontakte.filter(k => {
    if (!k.email || !k.email.includes('@')) return false;
    if (k.email.startsWith('druckerr9+') || k.email.startsWith('druckerr13+')) return false;
    if (k.rolle === 'eigentuemer' || k.rolle === 'verwalter') return k.authentik_zugang !== false;
    return k.authentik_zugang === true;
  });
  if (withEmail.length === 0) return;

  try {
    // Fetch all existing users and groups once
    const [usersData, groupsData] = await Promise.all([
      authentikAPI('GET', '/core/users/?page_size=1000'),
      authentikAPI('GET', '/core/groups/?page_size=500'),
    ]);
    const existingUsers = (usersData.results || []);
    const allGroups = (groupsData.results || []);

    const stwegGroups = STWEG_GROUPS[stweg] || {};

    for (const k of withEmail) {
      const email = k.email.toLowerCase().trim();
      let user = existingUsers.find(u => u.email?.toLowerCase() === email);

      if (!user) {
        // Create user in Authentik
        const username = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').substring(0, 50);
        // Check if username already taken
        const existingByName = existingUsers.find(u => u.username === username);
        const finalUsername = existingByName ? `${username}-${Date.now().toString(36).slice(-4)}` : username;

        try {
          user = await authentikAPI('POST', '/core/users/', {
            username: finalUsername,
            name: k.name || email.split('@')[0],
            email,
            is_active: true,
          });
          console.log(`[Authentik] Created user: ${finalUsername} (${email})`);
        } catch (err) {
          console.error(`[Authentik] Failed to create user ${email}:`, err.message);
          continue;
        }
      }

      // Determine which groups to assign based on rolle
      const targetGroups = [];
      const effectiveBewohntVon = k._bewohntVon || bewohntVon;
      if (k.rolle === 'eigentuemer' || k.rolle === 'verwalter') {
        targetGroups.push(stwegGroups.eigentuemer);
        // Self-occupied: Eigentümer/Verwalter also become Bewohner
        if (effectiveBewohntVon === 'eigentuemer' && stwegGroups.bewohner) {
          targetGroups.push(stwegGroups.bewohner);
        }
      } else if (k.rolle === 'mieter' || k.rolle === 'bewohner') {
        targetGroups.push(stwegGroups.bewohner);
      }

      if (user.pk) {
        const userGroups = user.groups_obj || [];
        for (const targetGroupName of targetGroups) {
          if (!targetGroupName) continue;
          const group = allGroups.find(g => g.name === targetGroupName);
          if (group) {
            const alreadyInGroup = userGroups.some(g => g.pk === group.pk);
            if (!alreadyInGroup) {
              try {
                await authentikAPI('POST', `/core/groups/${group.pk}/add_user/`, { pk: user.pk });
                console.log(`[Authentik] Added ${email} to group ${targetGroupName}`);
              } catch (err) {
                console.error(`[Authentik] Failed to add ${email} to ${targetGroupName}:`, err.message);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    // Don't fail the save operation if Authentik sync fails
    console.error('[Authentik] Kontakte sync error:', err.message);
  }
}

// Track removed kontakte for delayed Authentik user deletion
async function trackRemovedKontakte(wohnungId, stweg, oldKontakte, newKontakte) {
  if (!AUTHENTIK_API_TOKEN) return;
  const newEmails = new Set((newKontakte || []).filter(k => k.email).map(k => k.email.toLowerCase().trim()));
  const removedWithEmail = (oldKontakte || []).filter(k => k.email && !newEmails.has(k.email.toLowerCase().trim()));
  if (removedWithEmail.length === 0) return;

  // Check if the email still exists in another wohnung
  for (const k of removedWithEmail) {
    const email = k.email.toLowerCase().trim();
    const stillExists = await pool.query(
      `SELECT COUNT(*) as cnt FROM wohnungen_kontakte WHERE LOWER(email) = $1 AND wohnung_id != $2`,
      [email, wohnungId]
    );
    if (parseInt(stillExists.rows[0].cnt) > 0) continue; // Still assigned elsewhere

    // Schedule for deletion in 30 days
    await pool.query(
      `INSERT INTO authentik_pending_deletions (email, name, stweg, scheduled_at, reminder_sent)
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', false)
       ON CONFLICT (email) DO UPDATE SET scheduled_at = NOW() + INTERVAL '30 days', cancelled = false, reminder_sent = false`,
      [email, k.name || '', stweg]
    );
    console.log(`[Authentik] Scheduled deletion for ${email} in 30 days`);
  }
}

// Cancel pending deletion if contact is re-added
async function cancelPendingDeletion(email) {
  if (!email) return;
  await pool.query(
    `UPDATE authentik_pending_deletions SET cancelled = true WHERE LOWER(email) = $1 AND cancelled = false`,
    [email.toLowerCase().trim()]
  );
}

// Periodic job: process pending Authentik deletions (reminders + deletions)
async function processAuthentiKDeletions() {
  if (!AUTHENTIK_API_TOKEN) return;
  try {
    // 1. Send reminders (7 days before deletion, i.e. scheduled_at - 7 days <= NOW)
    const reminders = await pool.query(
      `SELECT * FROM authentik_pending_deletions
       WHERE cancelled = false AND reminder_sent = false
       AND scheduled_at - INTERVAL '7 days' <= NOW()
       AND scheduled_at > NOW()`
    );
    for (const row of reminders.rows) {
      try {
        const deleteDate = new Date(row.scheduled_at);
        const formattedDate = `${deleteDate.getDate()}.${deleteDate.getMonth() + 1}.${deleteDate.getFullYear()}`;
        await loggedSendMail({
          from: MAIL_FROM,
          to: row.email,
          subject: 'Rosenweg: Ihr Konto wird in 7 Tagen gelöscht',
          html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #1e40af;">Rosenweg Kooperation</h2>
              <p>Hallo ${escapeHtml(row.name || row.email)},</p>
              <p>Ihr Konto bei der STWEG-Kooperation Rosenweg wird am <strong>${formattedDate}</strong> gelöscht,
                 da Sie keiner Wohnung mehr zugeordnet sind.</p>
              <p>Falls dies ein Fehler ist, wenden Sie sich bitte an die Verwaltung oder den Technischen Dienst.</p>
              <p style="color: #6b7280; font-size: 0.875rem; margin-top: 24px;">
                STWEG-Kooperation Rosenweg, Kaiseraugst
              </p>
            </div>`,
        }, 'authentik-deletion-reminder');
        await pool.query('UPDATE authentik_pending_deletions SET reminder_sent = true WHERE id = $1', [row.id]);
        console.log(`[Authentik] Deletion reminder sent to ${row.email}`);
      } catch (err) {
        console.error(`[Authentik] Failed to send reminder to ${row.email}:`, err.message);
      }
    }

    // 2. Delete users past their scheduled date
    const deletions = await pool.query(
      `SELECT * FROM authentik_pending_deletions
       WHERE cancelled = false AND scheduled_at <= NOW()`
    );
    for (const row of deletions.rows) {
      try {
        // Find user in Authentik by email
        const usersData = await authentikAPI('GET', `/core/users/?search=${encodeURIComponent(row.email)}`);
        const user = (usersData.results || []).find(u => u.email?.toLowerCase() === row.email.toLowerCase());
        if (user) {
          // Hard delete per DSG/DSGVO requirements
          await authentikAPI('DELETE', `/core/users/${user.pk}/`);
          console.log(`[Authentik] Deleted user ${row.email} (pk: ${user.pk})`);
        }
        await pool.query('DELETE FROM authentik_pending_deletions WHERE id = $1', [row.id]);
      } catch (err) {
        console.error(`[Authentik] Failed to delete ${row.email}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Authentik] Deletion processing error:', err.message);
  }
}

// Run deletion processor daily (every 24h) with guard
let isDeletionRunning = false;
let deletionInterval;
async function guardedProcessDeletions() {
  if (isDeletionRunning) return;
  isDeletionRunning = true;
  try { await processAuthentiKDeletions(); } finally { isDeletionRunning = false; }
}
deletionInterval = setInterval(guardedProcessDeletions, 24 * 60 * 60 * 1000);
// Also run once 60s after startup
setTimeout(guardedProcessDeletions, 60 * 1000);

// ─── Nightly Drucker-Tag-Cleanup-Warning ───────────────────────────
// Findet Kontakte mit Drucker-Tag-Email wo derselbe Name woanders eine echte Email hat.
// Schickt einmal pro Tag eine Zusammenfassung an Technik (nur wenn Funde vorhanden).
async function checkStaleDruckerTags() {
  try {
    const result = await pool.query(`
      WITH drucker AS (
        SELECT wk.id, wk.name, wk.email, w.stweg, w.bezeichnung, w.typ
        FROM wohnungen_kontakte wk JOIN wohnungen w ON w.id = wk.wohnung_id
        WHERE wk.email LIKE 'druckerr9+%' OR wk.email LIKE 'druckerr13+%'
      ),
      real_for_name AS (
        SELECT DISTINCT name FROM wohnungen_kontakte
        WHERE email IS NOT NULL AND email <> ''
          AND email NOT LIKE 'druckerr9+%' AND email NOT LIKE 'druckerr13+%'
      )
      SELECT d.* FROM drucker d
      JOIN real_for_name r ON r.name = d.name
      ORDER BY d.stweg, d.bezeichnung
    `);
    if (result.rows.length === 0) {
      console.log('[CleanupWarn] Keine veralteten Drucker-Tags gefunden');
      return;
    }
    // Adressaten: Technik
    if (!AUTHENTIK_API_TOKEN) return;
    const usersData = await authentikAPI('GET', '/core/users/?page_size=1000');
    const technikGroup = (await authentikAPI('GET', '/core/groups/?page_size=500')).results
      ?.find(g => g.name.toLowerCase() === 'technik');
    if (!technikGroup) return;
    const recipients = (usersData.results || [])
      .filter(u => u.is_active && u.email && u.groups_obj?.some(g => g.pk === technikGroup.pk))
      .map(u => u.email);
    if (recipients.length === 0) return;
    const rows = result.rows.map(r =>
      `<tr><td>${r.name}</td><td><code>${r.email}</code></td><td>STWEG ${r.stweg} · ${r.typ} · ${r.bezeichnung}</td></tr>`
    ).join('');
    await loggedSendMail({
      from: `"Rosenweg Daten-Cleanup" <noreply@${VERTEILER_DOMAIN}>`,
      to: recipients.join(', '),
      subject: `[Cleanup] ${result.rows.length} veraltete Drucker-Tags gefunden`,
      html: `<p>Folgende Kontakte haben einen Drucker-Tag als Email, obwohl die Person woanders eine echte Email-Adresse hat. Bitte in der Wohnungsverwaltung anpassen — die Drucker-Tags sind dann überflüssig:</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
<thead><tr><th align="left">Name</th><th align="left">Drucker-Tag</th><th align="left">Objekt</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="color:#666;font-size:11px">Automatisch generiert · ${new Date().toLocaleString('de-CH')}</p>`,
    }, 'cleanup-stale-drucker-tags');
    console.log(`[CleanupWarn] ${result.rows.length} Funde an ${recipients.length} Technik-Mitglieder geschickt`);
  } catch (err) {
    console.error('[CleanupWarn] Fehler:', err.message);
  }
}

// ─── Inverse Authentik-Sync ────────────────────────────────────────
// Liest Authentik-User mit is_active=false und setzt für Matches in
// wohnungen_kontakte authentik_zugang=false.
async function syncAuthentikDeactivations() {
  if (!AUTHENTIK_API_TOKEN) return;
  try {
    const data = await authentikAPI('GET', '/core/users/?is_active=false&page_size=1000');
    const inactive = (data.results || []).filter(u => u.email);
    if (inactive.length === 0) return;
    const emails = inactive.map(u => u.email.toLowerCase());
    const r = await pool.query(
      `UPDATE wohnungen_kontakte
       SET authentik_zugang = false
       WHERE LOWER(email) = ANY($1) AND authentik_zugang = true
       RETURNING name, email`,
      [emails]
    );
    if (r.rows.length > 0) {
      console.log(`[InverseSync] ${r.rows.length} Kontakte auf authentik_zugang=false gesetzt:`, r.rows.map(x => x.email).join(', '));
    }
  } catch (err) {
    console.error('[InverseSync] Fehler:', err.message);
  }
}

// Beide Jobs täglich um ~03:00 (deletion läuft 02:00 implizit)
setInterval(checkStaleDruckerTags, 24 * 60 * 60 * 1000);
setInterval(syncAuthentikDeactivations, 24 * 60 * 60 * 1000);
setTimeout(() => { checkStaleDruckerTags(); syncAuthentikDeactivations(); }, 5 * 60 * 1000);

// ─── Pickup-Reminder für ungeholte Druckaufträge ───────────────────
// Schickt eine Sammel-Mail an Technik+Präsident mit allen Drucksachen,
// die seit >24h gedruckt sind, aber noch nicht abgeholt wurden.
// Cooldown: pro Job nur alle 3 Tage erneut erinnern.
async function sendPickupReminder() {
  try {
    const { rows: jobs } = await pool.query(`
      SELECT id, token, recipient_name, recipient_address, recipient_wohnung,
             recipient_stweg, sender_email, subject, printer, created_at, last_reminder_at
      FROM print_jobs
      WHERE picked_up_at IS NULL
        AND status = 'printed'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND (last_reminder_at IS NULL OR last_reminder_at < NOW() - INTERVAL '3 days')
      ORDER BY created_at ASC
    `);
    if (jobs.length === 0) {
      console.log('[PickupReminder] Keine offenen Druckaufträge zum Erinnern');
      return;
    }

    // Empfänger-Liste: Technik + Präsident
    const notifyEmails = new Set();
    const members = await pool.query("SELECT email, groups_json FROM users WHERE active = true");
    for (const row of members.rows) {
      try {
        const groups = JSON.parse(row.groups_json || '[]');
        if (groups.some(g => ['technik', 'präsident'].includes(g.toLowerCase())) && row.email && !row.email.includes('placeholder')) {
          notifyEmails.add(row.email);
        }
      } catch {}
    }
    if (notifyEmails.size === 0) {
      console.log('[PickupReminder] Keine Notify-Empfänger gefunden');
      return;
    }

    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = jobs.map(j => {
      const ageDays = Math.floor((Date.now() - new Date(j.created_at).getTime()) / 86400000);
      const pickupUrl = `${SITE_URL}/abholung.html?token=${j.token}`;
      return `<tr>
        <td style="padding:6px 8px">${esc(j.recipient_name || '—')}${j.recipient_wohnung ? `<br><span style="font-size:11px;color:#666">${esc(j.recipient_wohnung)}</span>` : ''}</td>
        <td style="padding:6px 8px">${esc(j.printer)}</td>
        <td style="padding:6px 8px;text-align:right;color:${ageDays > 7 ? '#c41e1e' : '#666'};font-weight:${ageDays > 7 ? '600' : 'normal'}">${ageDays} Tage</td>
        <td style="padding:6px 8px;font-size:11px;color:#444">${esc((j.subject || '').slice(0, 50))}</td>
        <td style="padding:6px 8px"><a href="${pickupUrl}" style="font-size:11px;color:#c41e1e">Abholung bestätigen</a></td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto">
      <h2 style="color:#c41e1e">${jobs.length} Druckauftrag${jobs.length === 1 ? '' : 'e'} wartet${jobs.length === 1 ? '' : 'en'} auf Abholung</h2>
      <p>Folgende Drucksachen liegen seit mehr als 24 Stunden bereit und sind noch nicht als abgeholt markiert:</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #ddd">
        <thead><tr style="background:#fafafa">
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Empfänger</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Drucker</th>
          <th style="padding:6px 8px;text-align:right;border-bottom:1px solid #ddd">Alter</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Betreff</th>
          <th style="padding:6px 8px;text-align:left;border-bottom:1px solid #ddd">Aktion</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:11px;color:#888;margin-top:16px">Bitte Drucksachen verteilen und über den Link "Abholung bestätigen" oder direkt am ausgedruckten Deckblatt-QR quittieren.<br>
      Diese Erinnerung wird pro Auftrag alle 3 Tage wiederholt, bis er abgeholt ist.</p>
    </body></html>`;

    await loggedSendMail({
      from: `"Rosenweg Druckserver" <noreply@${VERTEILER_DOMAIN}>`,
      to: [...notifyEmails].join(', '),
      subject: `${jobs.length} Druckauftr${jobs.length === 1 ? 'ag wartet' : 'äge warten'} auf Abholung`,
      html,
    }, 'pickup-reminder');

    await pool.query(
      `UPDATE print_jobs SET last_reminder_at = NOW() WHERE id = ANY($1::int[])`,
      [jobs.map(j => j.id)]
    );
    console.log(`[PickupReminder] ${jobs.length} offene Aufträge an ${notifyEmails.size} Empfänger gemeldet`);
  } catch (err) {
    console.error('[PickupReminder] Fehler:', err.message);
  }
}
setInterval(sendPickupReminder, 24 * 60 * 60 * 1000);
setTimeout(sendPickupReminder, 10 * 60 * 1000); // initial run nach 10min

// ─── SMTP2GO-Rejection-Sync ────────────────────────────────────────
// SMTP2GO klassifiziert Mails asynchron als 'rejected' (Suppression-Liste,
// hard-bounce, etc). Wir pollen alle 10 Min die Activity-API und tragen
// betroffene Mails im email_log nach (status='failed' + error_message).
async function syncSmtp2goRejections() {
  if (!SMTP2GO_API_KEY) return;
  try {
    const lookbackHours = 6;
    const r = await fetch(`${SMTP2GO_API_URL}/activity/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smtp2go-Api-Key': SMTP2GO_API_KEY },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        start_date: new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString(),
        end_date: new Date().toISOString(),
        event: 'rejected',
        limit: 500,
      }),
    });
    if (!r.ok) {
      console.error('[Smtp2goSync] API error:', r.status);
      return;
    }
    const data = await r.json();
    const events = data.data?.events || [];
    if (events.length === 0) return;

    let updated = 0;
    for (const ev of events) {
      const recipient = (ev.recipient || ev.to || '').toLowerCase().trim();
      const subject = ev.subject || '';
      const reason = (ev.smtp_response || '').slice(0, 1000);
      // Nur ECHTE Bounces (550-er) markieren — SMTP2GO klassifiziert auch
      // "250 OK"-Antworten als 'rejected' (backscatter), das sind keine Fehler.
      const isRealBounce = /^5\d\d/.test(reason) || /unknown|not found|unavailable|hard.{0,2}bounce/i.test(reason);
      if (!isRealBounce) continue;
      // Match nach Empfänger + Subject in unseren letzten Logs
      const upd = await pool.query(
        `UPDATE email_log
         SET status = 'failed',
             error_message = $1,
             failed_recipients = COALESCE(failed_recipients, '') || CASE WHEN failed_recipients IS NULL THEN $2 ELSE ',' || $2 END
         WHERE status = 'sent'
           AND created_at > NOW() - INTERVAL '${lookbackHours} hours'
           AND LOWER(to_addresses) LIKE '%' || $2 || '%'
           AND ($3 = '' OR subject = $3 OR subject LIKE '%' || $3 || '%')
         RETURNING id`,
        [reason, recipient, subject]
      );
      updated += upd.rows.length;
    }
    if (updated > 0) console.log(`[Smtp2goSync] ${updated} email_log Eintraege auf failed gesetzt (von ${events.length} rejected events)`);
  } catch (err) {
    console.error('[Smtp2goSync] Fehler:', err.message);
  }
}
setInterval(syncSmtp2goRejections, 10 * 60 * 1000); // alle 10 Min
setTimeout(syncSmtp2goRejections, 60 * 1000); // initial run nach 1 min

// ─── Nextcloud-CardDAV-Sync (Telefonbuch fuer EAS / iOS / DAVx5) ──
// Schreibt alle Kontakte aus wohnungen_kontakte als vCards ins
// Nextcloud-Adressbuch "rosenweg-tel". Read-only freigegeben an alle
// Nextcloud-User → iOS native CardDAV, Android via DAVx5 oder Z-Push EAS.
async function syncContactsToNextcloud() {
  const ncUrl = process.env.NEXTCLOUD_URL;
  const ncUser = process.env.NEXTCLOUD_ADMIN_USER;
  const ncPass = process.env.NEXTCLOUD_ADMIN_APP_PASSWORD;
  const book = process.env.NEXTCLOUD_ADDRESSBOOK || 'rosenweg-tel';
  if (!ncUrl || !ncUser || !ncPass) {
    console.log('[CardDAVSync] Skipped: NEXTCLOUD_URL/USER/APP_PASSWORD nicht gesetzt');
    return;
  }
  const auth = 'Basic ' + Buffer.from(`${ncUser}:${ncPass}`).toString('base64');
  const baseDav = `${ncUrl.replace(/\/$/, '')}/remote.php/dav/addressbooks/users/${ncUser}/${book}`;

  try {
    // Adressbuch erstellen wenn nicht existiert (MKCOL ist idempotent — 405 wenn exists)
    await fetch(baseDav, { method: 'MKCOL', headers: {
      'Authorization': auth,
      'Content-Type': 'application/xml',
    }, body: `<?xml version="1.0" encoding="utf-8"?>
<mkcol xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <set><prop>
    <resourcetype><collection/><c:addressbook/></resourcetype>
    <displayname>Rosenweg Telefonbuch</displayname>
    <c:addressbook-description>Internes Adressbuch der STWEG-Kooperation Rosenweg (auto-sync)</c:addressbook-description>
  </prop></set>
</mkcol>`}).catch(() => {});

    // Aktuelle Kontakte aus DB
    const { rows } = await pool.query(`
      SELECT k.name, k.email, k.telefon,
             json_agg(json_build_object('stweg', w.stweg, 'bezeichnung', w.bezeichnung, 'rolle', k.rolle)) AS wohnungen
      FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
      WHERE k.name IS NOT NULL AND TRIM(k.name) <> ''
      GROUP BY k.name, k.email, k.telefon
    `);

    // Dedup pro Person (Name): bevorzuge nicht-Drucker-Email + erste Telefon
    const byName = new Map();
    for (const r of rows) {
      const name = r.name.replace(/\s*\(verstorben\)\s*/i, '').trim();
      const isDeceased = /\(verstorben\)/i.test(r.name);
      const isDruckerTag = r.email && (r.email.startsWith('druckerr9+') || r.email.startsWith('druckerr13+'));
      if (isDeceased) continue; // Verstorbene nicht ins Adressbuch
      if (!byName.has(name)) byName.set(name, { name, email: null, telefon: null, wohnungen: [] });
      const e = byName.get(name);
      if (!isDruckerTag && r.email && !e.email) e.email = r.email.trim();
      if (r.telefon && !e.telefon) e.telefon = r.telefon.trim();
      for (const w of (r.wohnungen || [])) {
        if (!e.wohnungen.find(x => x.stweg === w.stweg && x.bezeichnung === w.bezeichnung)) {
          e.wohnungen.push(w);
        }
      }
    }
    const contacts = [...byName.values()].filter(c => c.telefon || c.email); // nur Personen mit erreichbaren Daten

    // vCard 3.0 generieren
    const vcardEscape = s => String(s || '').replace(/([\\,;])/g, '\\$1').replace(/\n/g, '\\n');
    const buildVCard = (c) => {
      const last = c.name.trim().split(/\s+/).pop() || '';
      const firstParts = c.name.trim().split(/\s+/).slice(0, -1).join(' ');
      const note = c.wohnungen.map(w => `STWEG ${w.stweg} ${w.bezeichnung} (${w.rolle})`).join('; ');
      const uid = 'rosenweg-' + crypto.createHash('sha1').update(c.name.toLowerCase()).digest('hex').slice(0, 16);
      const lines = [
        'BEGIN:VCARD', 'VERSION:3.0',
        `UID:${uid}`,
        `FN:${vcardEscape(c.name)}`,
        `N:${vcardEscape(last)};${vcardEscape(firstParts)};;;`,
      ];
      if (c.telefon) lines.push(`TEL;TYPE=CELL:${vcardEscape(c.telefon)}`);
      if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(c.email)}`);
      if (note) lines.push(`NOTE:${vcardEscape(note)}`);
      lines.push(`CATEGORIES:Rosenweg`);
      lines.push('END:VCARD');
      return { uid, vcard: lines.join('\r\n') + '\r\n' };
    };

    // Bestehende vCards im Adressbuch holen (PROPFIND)
    const propfindRes = await fetch(baseDav + '/', {
      method: 'PROPFIND',
      headers: { 'Authorization': auth, 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>`,
    });
    const propText = await propfindRes.text();
    const existingHrefs = new Set();
    for (const m of propText.matchAll(/<d:href[^>]*>([^<]+)<\/d:href>/gi)) {
      const href = m[1];
      if (href.endsWith('.vcf')) existingHrefs.add(decodeURIComponent(href.split('/').pop()));
    }

    // Aktuelle UIDs berechnen + PUT
    const currentUids = new Set();
    let upserted = 0;
    for (const c of contacts) {
      const { uid, vcard } = buildVCard(c);
      currentUids.add(uid + '.vcf');
      const r = await fetch(`${baseDav}/${uid}.vcf`, {
        method: 'PUT',
        headers: { 'Authorization': auth, 'Content-Type': 'text/vcard; charset=utf-8' },
        body: vcard,
      });
      if (r.ok || r.status === 201 || r.status === 204) upserted++;
      else console.error(`[CardDAVSync] PUT ${uid} → ${r.status}`);
    }

    // Verwaiste Eintraege loeschen
    let deleted = 0;
    for (const href of existingHrefs) {
      if (currentUids.has(href)) continue;
      if (!href.startsWith('rosenweg-')) continue; // nur unsere
      const r = await fetch(`${baseDav}/${href}`, { method: 'DELETE', headers: { 'Authorization': auth } });
      if (r.ok || r.status === 204) deleted++;
    }
    console.log(`[CardDAVSync] ${upserted} Kontakte synced (${contacts.length} aktuell, ${deleted} entfernt)`);
  } catch (err) {
    console.error('[CardDAVSync] Fehler:', err.message);
  }
}
setInterval(syncContactsToNextcloud, 60 * 60 * 1000); // hourly
setTimeout(syncContactsToNextcloud, 2 * 60 * 1000); // initial run nach 2 min

// POST /api/internal/carddav-sync — manueller Trigger fuer Tests (admin only)
app.post('/api/internal/carddav-sync', authMiddleware, adminOnly, async (req, res) => {
  syncContactsToNextcloud().catch(err => console.error('[CardDAVSync] manual:', err.message));
  res.json({ triggered: true, message: 'Sync laeuft im Hintergrund — Logs siehe API' });
});

// POST /api/wohnungen/sync-authentik - Bulk sync all kontakte with email to Authentik
app.post('/api/wohnungen/sync-authentik', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT k.rolle, k.name, k.email, w.stweg, w.bewohnt_von
       FROM wohnungen_kontakte k JOIN wohnungen w ON k.wohnung_id = w.id
       WHERE k.email IS NOT NULL AND k.email != ''
       ORDER BY w.stweg`
    );
    const byStwg = {};
    for (const row of result.rows) {
      if (!byStwg[row.stweg]) byStwg[row.stweg] = [];
      byStwg[row.stweg].push({ ...row, _bewohntVon: row.bewohnt_von });
    }
    for (const [stweg, kontakte] of Object.entries(byStwg)) {
      await syncKontakteToAuthentik(parseInt(stweg), kontakte);
    }
    res.json({ success: true, total: result.rows.length, message: `Sync für ${result.rows.length} Kontakte mit E-Mail abgeschlossen.` });
  } catch (err) {
    console.error('Bulk Authentik sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stweg/:stweg/wohnungen - Public apartment info (no personal data)
app.get('/api/stweg/:stweg/wohnungen', async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg, 10);
    if (!stweg || stweg < 1 || stweg > 8) return res.status(400).json({ error: 'Ungueltige STWEG' });
    const result = await pool.query(
      'SELECT bezeichnung, stockwerk, zimmer, flaeche_m2, typ, besonderheiten, bewohnt_von, wertquote_zaehler, wertquote_nenner FROM wohnungen WHERE stweg = $1',
      [stweg]
    );
    result.rows.sort((a, b) => wohnungSort(a.bezeichnung, b.bezeichnung));
    res.json({ stweg, wohnungen: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/wohnungen/eigentuemer-uebersicht — gruppiert alle Objekte nach Eigentümer
app.get('/api/wohnungen/eigentuemer-uebersicht', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), async (req, res) => {
  try {
    // Technik/Präsident sehen alle, Ausschuss-Mitglieder nur ihre STWEGs
    const groups = req.user?.groups || [];
    let stwegFilter = '';
    let params = [];
    if (!isTechnik(groups) && !isPraesident(groups)) {
      const accessibleStwegs = [...getAusschussStwegs(groups)];
      if (accessibleStwegs.length === 0) return res.json({ eigentuemer: [] });
      stwegFilter = 'AND w.stweg = ANY($1::int[])';
      params = [accessibleStwegs];
    }
    const result = await pool.query(`
      SELECT wk.name, wk.email, wk.telefon, wk.rolle,
             w.id AS wohnung_id, w.stweg, w.bezeichnung, w.typ,
             w.wertquote_zaehler, w.wertquote_nenner
      FROM wohnungen_kontakte wk
      JOIN wohnungen w ON w.id = wk.wohnung_id
      WHERE wk.rolle IN ('eigentuemer','verwalter') AND wk.name IS NOT NULL ${stwegFilter}
      ORDER BY wk.name, w.stweg, w.bezeichnung
    `, params);

    const byName = new Map();
    for (const r of result.rows) {
      if (!byName.has(r.name)) {
        byName.set(r.name, { name: r.name, email: r.email, telefon: r.telefon, rollen: new Set(), objects: [] });
      }
      const e = byName.get(r.name);
      e.rollen.add(r.rolle);
      // Prefer non-drucker email if multiple kontakte exist for same name
      if (e.email?.startsWith('druckerr') && r.email && !r.email.startsWith('druckerr')) {
        e.email = r.email;
      }
      if (!e.telefon && r.telefon) e.telefon = r.telefon;
      e.objects.push({
        wohnung_id: r.wohnung_id, stweg: r.stweg, bezeichnung: r.bezeichnung, typ: r.typ, rolle: r.rolle,
        wertquote_zaehler: r.wertquote_zaehler, wertquote_nenner: r.wertquote_nenner
      });
    }
    // Set → Array für JSON-Serialisierung
    for (const e of byName.values()) e.rollen = [...e.rollen];
    // Sortierung nach Nachname (letztes Wort), bei Gleichheit nach Vorname
    const lastName = n => (n || '').trim().split(/\s+/).pop() || '';
    res.json({ eigentuemer: [...byName.values()].sort((a,b) => {
      const c = lastName(a.name).localeCompare(lastName(b.name), 'de');
      return c !== 0 ? c : a.name.localeCompare(b.name, 'de');
    }) });
  } catch (err) {
    console.error('eigentuemer-uebersicht error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// ─── Unterschriftenlisten-Generator ────────────────────────────────
// Live aus DB generiert, PDF-only (kein DOCX) damit nicht manipulierbar.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isAuswaerts(adresse, stwegNr) {
  if (!adresse) return false;
  // "Rosenweg [number] [optional comma] 4303 Kaiseraugst" → vor Ort
  return !/Rosenweg\s+\d+[\s,]+4303\s+Kaiseraugst/i.test(adresse);
}
function rosenwegNrAusBezeichnung(bezeichnung) {
  if (!bezeichnung) return null;
  // RW17-01 / RW18 / RW5-03 / RW1-04
  let m = /^RW(\d+)/i.exec(bezeichnung);
  if (m) return parseInt(m[1]);
  // 9.EG.1 / 13.EG.2 / 10.5 / 12.4
  m = /^(\d+)\./.exec(bezeichnung);
  if (m) return parseInt(m[1]);
  // 1305 / 1604 (4-stellig) → erste 2 Stellen
  m = /^(\d{2})\d{2}$/.exec(bezeichnung);
  if (m) return parseInt(m[1]);
  // P-Nummern (Tiefgarage, STWEG 8) → keine Hausnummer
  return null;
}
async function buildUnterschriftenlisteHTML(stweg, opts, replaySnapshot = null) {
  const { datum, anlass_titel, anlass_zweck, ruecksendung_bis, ruecksendung_an,
          zeichnungsberechtigte = [], kollektiv_text } = opts;
  // Daten aus Snapshot ODER live aus DB
  let wohnungen, byWohnung;
  if (replaySnapshot) {
    // Replay aus gespeichertem Snapshot — Daten exakt wie damals
    wohnungen = { rows: replaySnapshot.wohnungen.map((w, idx) => {
      const [z, n] = (w.wertquote || '').split('/').map(s => parseInt(s) || null);
      return { id: idx + 1, bezeichnung: w.bezeichnung, typ: w.typ, wertquote_zaehler: z, wertquote_nenner: n || 1000 };
    })};
    byWohnung = new Map();
    replaySnapshot.wohnungen.forEach((w, idx) => {
      byWohnung.set(idx + 1, {
        id: idx + 1, bezeichnung: w.bezeichnung, typ: w.typ,
        eigentuemer: (w.eigentuemer || []).map(name => ({ name })),
        verwalter: (w.verwalter || []).map(name => ({ name })),
        adressen: new Set(w.korrespondenz_adressen || []),
      });
    });
  } else {
    // Live aus DB
    wohnungen = await pool.query(`
      SELECT w.id, w.bezeichnung, w.typ, w.wertquote_zaehler, w.wertquote_nenner
      FROM wohnungen w
      WHERE w.stweg = $1 AND w.typ IN ('Wohnung','Hobbyraum')
      ORDER BY w.bezeichnung
    `, [stweg]);
    const wohnungIds = wohnungen.rows.map(w => w.id);
    const kontakte = wohnungIds.length === 0 ? { rows: [] } : await pool.query(`
      SELECT wohnung_id, rolle, name, email, adresse, sort_order
      FROM wohnungen_kontakte
      WHERE wohnung_id = ANY($1::int[]) AND rolle IN ('eigentuemer','verwalter') AND name IS NOT NULL
      ORDER BY wohnung_id, (CASE WHEN rolle='eigentuemer' THEN 0 ELSE 1 END), sort_order, id
    `, [wohnungIds]);
    byWohnung = new Map();
    for (const w of wohnungen.rows) {
      byWohnung.set(w.id, { ...w, eigentuemer: [], verwalter: [], adressen: new Set() });
    }
    for (const k of kontakte.rows) {
      const w = byWohnung.get(k.wohnung_id);
      if (!w) continue;
      if (k.rolle === 'eigentuemer') w.eigentuemer.push(k);
      else if (k.rolle === 'verwalter') w.verwalter.push(k);
      if (k.adresse) w.adressen.add(k.adresse.trim());
    }
  }

  // STWEG 8 (MEG-Tiefgarage) hat ueber 100 Eigentuemer in unterschiedlichsten
  // Haeusern + viele Auswaertige — Sammelliste an einem Ort macht keinen Sinn.
  // Daher generiere fuer STWEG 8 grundsaetzlich nur Einzelbriefe (jeder
  // Eigentuemer bekommt seinen eigenen Brief mit Unterschriftszeile).
  const einzelOnly = stweg === 8;

  // Einzelbrief-Empfänger sammeln (auswärtige Eigentümer; bei einzelOnly: alle)
  const einzelbriefe = [];
  let totalWQ = 0, totalUnits = 0;
  let dataRows = '';
  for (const w of wohnungen.rows) {
    const wInfo = byWohnung.get(w.id);
    totalUnits++;
    totalWQ += w.wertquote_zaehler || 0;
    const eigNamen = wInfo.eigentuemer.map(e => e.name).filter(Boolean);
    const verwNamen = wInfo.verwalter.map(v => v.name).filter(Boolean);
    const korrespondenzAdressen = [...wInfo.adressen];
    // Auswärts-Check über Korrespondenz-Adressen (= Eigentümer wohnt nicht im Rosenweg)
    const auswaertsAdressen = korrespondenzAdressen.filter(a => isAuswaerts(a, stweg));
    let nameZelle = eigNamen.join(', ') || '<em>—</em>';
    if (verwNamen.length > 0) {
      nameZelle += `<div class="verwalter-line">↳ in Vertretung Verwalter: <strong>${verwNamen.join(', ')}</strong></div>`;
    }
    // Wohnadresse = primaer die hinterlegte Korrespondenz-Adresse(n) der
    // Eigentuemer (also wo sie tatsaechlich wohnen — kann ein anderes Haus
    // im Rosenweg-Areal sein, z.B. Emini wohnen RW5 besitzen aber 9.2OG.2).
    // Fallback wenn keine Adresse hinterlegt: aus bezeichnung ableiten.
    let adresseZelle;
    if (korrespondenzAdressen.length > 0) {
      adresseZelle = korrespondenzAdressen.map(a => escHtml(a)).join('<br>');
    } else {
      const hausnr = rosenwegNrAusBezeichnung(w.bezeichnung);
      adresseZelle = hausnr ? `Rosenweg ${hausnr}, 4303 Kaiseraugst` : '4303 Kaiseraugst';
    }
    // Einzelbrief: alle wenn einzelOnly, sonst nur fuer auswaerts
    if (einzelOnly || auswaertsAdressen.length > 0) {
      const briefAdresse = auswaertsAdressen[0] || korrespondenzAdressen[0]
        || (rosenwegNrAusBezeichnung(w.bezeichnung) ? `Rosenweg ${rosenwegNrAusBezeichnung(w.bezeichnung)}, 4303 Kaiseraugst` : '4303 Kaiseraugst');
      if (!einzelOnly) {
        adresseZelle += `<div class="auswaerts-marker">📮 Einzelbrief an: ${escHtml(briefAdresse)}</div>`;
      }
      einzelbriefe.push({ bezeichnung: w.bezeichnung, eigentuemer: eigNamen, verwalter: verwNamen, adresse: briefAdresse });
    }
    const wq = (w.wertquote_zaehler && w.wertquote_nenner) ? `${w.wertquote_zaehler}/${w.wertquote_nenner}` : '—';
    dataRows += `<tr>
      <td class="cell-einheit">${escHtml(w.bezeichnung)}</td>
      <td class="cell-name">${nameZelle}</td>
      <td class="cell-adresse">${adresseZelle}</td>
      <td class="cell-wq">${wq}</td>
      <td class="cell-vote">☐ JA &nbsp;&nbsp; ☐ NEIN</td>
      <td class="cell-sig">&nbsp;</td>
    </tr>`;
  }
  // Total-Zeile
  dataRows += `<tr class="total-row">
    <td><strong>TOTAL</strong></td>
    <td><strong>${totalUnits} Einheiten</strong></td>
    <td></td>
    <td><strong>${totalWQ}/1000</strong></td>
    <td></td><td></td>
  </tr>`;

  // Strikter Hash über kompletten Snapshot der Liste-Daten — jede Änderung
  // (Eigentümer-Name, Wertquote, Adresse) ergibt einen neuen Hash. Snapshot
  // wird in DB persistiert, sodass die Verifizierung auch nach DB-Änderungen
  // den Original-Inhalt zurückgeben kann (Bank/Notar scannt → sieht exakt
  // den damaligen Stand).
  const snapshotData = {
    stweg, datum, anlass_titel, anlass_zweck,
    ruecksendung_bis, ruecksendung_an,
    zeichnungsberechtigte: zeichnungsberechtigte || [],
    kollektiv_text: kollektiv_text || null,
    wohnungen: wohnungen.rows.map(w => {
      const wInfo = byWohnung.get(w.id);
      return {
        bezeichnung: w.bezeichnung,
        typ: w.typ,
        wertquote: w.wertquote_zaehler && w.wertquote_nenner ? `${w.wertquote_zaehler}/${w.wertquote_nenner}` : null,
        eigentuemer: wInfo.eigentuemer.map(e => e.name).filter(Boolean),
        verwalter: wInfo.verwalter.map(v => v.name).filter(Boolean),
        korrespondenz_adressen: [...wInfo.adressen],
      };
    }),
    total_units: wohnungen.rows.length,
    total_wq: wohnungen.rows.reduce((s, w) => s + (w.wertquote_zaehler || 0), 0),
  };
  // Hash + Snapshot persistieren (nur bei Live-Generierung, nicht beim Replay)
  let hash, generatedAt;
  if (replaySnapshot) {
    hash = replaySnapshot._hash || 'REPLAY';
    generatedAt = new Date(replaySnapshot._generated_at || Date.now()).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
  } else {
    const canonical = JSON.stringify(snapshotData, Object.keys(snapshotData).sort());
    hash = crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 12).toUpperCase();
    generatedAt = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
    try {
      await pool.query(`
        INSERT INTO unterschriftenliste_snapshots (hash, stweg, datum, anlass_titel, snapshot_data, generated_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        ON CONFLICT (hash) DO UPDATE SET download_count = unterschriftenliste_snapshots.download_count + 1
      `, [hash, stweg, datum, anlass_titel, JSON.stringify(snapshotData), opts.generated_by || null]);
    } catch (e) { console.error('[Unterschriftenliste] Snapshot-Save error:', e.message); }
    // Hash für PDF-Speicherung im Endpoint zurückgeben
    opts._hash = hash;
  }

  // Öffentliche Echtheitsprüfungs-Seite — Hash aus der Fusszeile dort eingeben
  const verifyUrl = `${SITE_URL}/echtheitspruefung.html?hash=${hash}`;
  const verifyPageBase = `${SITE_URL}/echtheitspruefung.html`;

  // Bei einzelOnly (STWEG 8) zeigt schon die Hauptseite die Tabelle;
  // doppelte Auflistung vermeiden.
  const einzelbriefeUebersicht = (einzelbriefe.length === 0 || einzelOnly) ? '' : `
    <h2 class="section-title">Einzelbriefe (auswärts wohnende Eigentümer)</h2>
    <p class="hinweis">Folgende ${einzelbriefe.length} Eigentümer wohnen ausserhalb von Rosenweg / 4303 Kaiseraugst und haben den Brief per Einzelversand erhalten. Die personalisierten Anschreiben folgen ab Seite 2.</p>
    <table class="info-table">
      <thead><tr><th>Einheit</th><th>Eigentümer</th><th>Verwalter (in Vertretung)</th><th>Versand-Adresse</th></tr></thead>
      <tbody>
        ${einzelbriefe.map(e => `<tr>
          <td>${escHtml(e.bezeichnung)}</td>
          <td>${escHtml(e.eigentuemer.join(', '))}</td>
          <td>${e.verwalter.length > 0 ? escHtml(e.verwalter.join(', ')) : '<em>—</em>'}</td>
          <td>${escHtml(e.adresse)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  // Pro auswärtigem Empfänger ein eigenständiges Anschreiben mit eigener Unterschriftszeile
  const einzelbriefeSeiten = einzelbriefe.map((e, idx) => {
    const wohnung = wohnungen.rows.find(w => w.bezeichnung === e.bezeichnung);
    const wq = (wohnung?.wertquote_zaehler && wohnung?.wertquote_nenner) ? `${wohnung.wertquote_zaehler}/${wohnung.wertquote_nenner}` : '—';
    const empfaenger = e.eigentuemer.join(' & ');
    const verwalterLine = e.verwalter.length > 0 ? `<p class="hinweis">↳ <em>vertreten durch Verwalter: <strong>${escHtml(e.verwalter.join(', '))}</strong></em></p>` : '';
    return `
    <div class="page-break"></div>
    <div class="einzelbrief">
      <div class="header">
        <img src="https://www.rosenweg4303.ch/logo-rosenweg.png" alt="Rosenweg">
        <div class="header-text">
          <h1>STWEG-Kooperation Rosenweg</h1>
          <p>STWEG ${stweg} · 4303 Kaiseraugst · Stand ${escHtml(datum)}</p>
        </div>
      </div>
      <div class="absender">Absender: STWEG-Kooperation Rosenweg, ${ruecksendung_an ? escHtml(ruecksendung_an) : 'c/o Ausschuss, 4303 Kaiseraugst'}</div>
      <div class="anschrift">
        <strong>${escHtml(empfaenger)}</strong><br>
        ${escHtml(e.adresse).replace(/,/g, '<br>')}
      </div>
      <h2 class="section-title">${escHtml(anlass_titel || 'Unterschriftenliste')}</h2>
      ${anlass_zweck ? `<p class="zweck">${escHtml(anlass_zweck).replace(/\n/g, '<br>')}</p>` : ''}
      ${verwalterLine}
      <p class="hinweis">Sie sind Eigentümer/in der Einheit <strong>${escHtml(e.bezeichnung)}</strong> (Wertquote ${wq}) in der STWEG ${stweg}, wohnen aber ausserhalb von Rosenweg, Kaiseraugst. Bitte kreuzen Sie unten <strong>JA</strong> oder <strong>NEIN</strong> an, datieren und unterschreiben Sie, und senden Sie das Blatt bis spätestens <strong>${escHtml(ruecksendung_bis || '—')}</strong> zurück${ruecksendung_an ? ` an <strong>${escHtml(ruecksendung_an)}</strong>` : ''}.</p>
      <table class="signatur einzel-signatur">
        <thead><tr>
          <th class="cell-einheit">Einheit</th>
          <th class="cell-name">Eigentümer/in (bzw. Verwalter)</th>
          <th class="cell-wq">Wertquote</th>
          <th class="cell-vote">JA / NEIN</th>
          <th class="cell-sig">Datum / Unterschrift</th>
        </tr></thead>
        <tbody><tr>
          <td><strong>${escHtml(e.bezeichnung)}</strong></td>
          <td>${escHtml(empfaenger)}${e.verwalter.length>0?'<br><span style="font-size:8.5pt;color:#555">↳ in Vertretung: '+escHtml(e.verwalter.join(', '))+'</span>':''}</td>
          <td style="text-align:center;font-family:monospace">${wq}</td>
          <td style="text-align:center;font-size:14pt">☐&nbsp;JA &nbsp;&nbsp; ☐&nbsp;NEIN</td>
          <td style="height:60px"></td>
        </tr></tbody>
      </table>
      <div class="footer-legal">
        <strong>Rechtshinweis:</strong> Dieses Anschreiben gehört zur Unterschriftenliste der STWEG ${stweg} vom ${escHtml(datum)}.
        Echtheit prüfen unter <code style="word-break:break-all">${escHtml(verifyPageBase)}</code> (Hash <strong>${hash}</strong> aus der Fusszeile eingeben).
        Brief Nr. ${idx+1} von ${einzelbriefe.length} (Einheit ${escHtml(e.bezeichnung)}).
        <strong>Vollständigkeit:</strong> Das Gesamtdokument ist nur gültig, wenn alle im Seitenzähler ausgewiesenen Seiten ("Seite X von Y") vorhanden sind — fehlt eine Seite, ist die Unterschriftenliste als ungültig zu betrachten.
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 16mm 24mm 16mm;
    @bottom-center { content: "STWEG ${stweg} — Unterschriftenliste · " counter(page) " von " counter(pages) " · Stand ${escHtml(datum)} · Hash ${hash}"; font-family: sans-serif; font-size: 8pt; color: #888; } }
  body { font-family: 'Helvetica', Arial, sans-serif; color: #222; font-size: 10pt; line-height: 1.4; margin: 0; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; border-bottom: 2px solid #c41e1e; padding-bottom: 10px; }
  .header img { width: 60px; height: 60px; }
  .header-text h1 { font-size: 16pt; font-weight: 700; margin: 0; color: #000; }
  .header-text p { margin: 2px 0; font-size: 9pt; color: #555; }
  h2.section-title { color: #c41e1e; font-size: 12pt; font-weight: bold; margin: 16px 0 6px; border-bottom: 1px solid #c41e1e; padding-bottom: 2px; }
  p.hinweis { font-size: 9pt; color: #555; margin: 4px 0; }
  p.zweck { font-size: 10pt; margin: 6px 0; }
  table.signatur { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.signatur th { background: #c41e1e; color: white; padding: 6px 8px; font-size: 9pt; text-align: left; }
  table.signatur td { padding: 6px 8px; border: 1px solid #aaa; font-size: 9.5pt; vertical-align: top; }
  .cell-einheit { width: 12%; font-weight: 600; }
  .cell-name { width: 28%; }
  .cell-adresse { width: 24%; font-size: 9pt; }
  .cell-wq { width: 8%; text-align: center; font-family: monospace; }
  .cell-vote { width: 14%; text-align: center; }
  .cell-sig { width: 14%; }
  tr.total-row { background: #fce4e4; font-weight: bold; }
  .verwalter-line { font-size: 8.5pt; color: #555; margin-top: 2px; padding-left: 8px; border-left: 2px solid #c41e1e; }
  .auswaerts-marker { font-size: 8.5pt; color: #c41e1e; margin-top: 2px; font-weight: 600; }
  table.info-table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 9pt; }
  table.info-table th, table.info-table td { padding: 4px 6px; border: 1px solid #ccc; text-align: left; }
  table.info-table thead th { background: #f0f0f0; }
  .footer-legal { margin-top: 14px; padding: 8px 10px; background: #fafafa; border: 1px solid #ddd; font-size: 8.5pt; color: #444; line-height: 1.5; }
  .zeichnungs-block { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .zeichnungs-box { border: 1px solid #888; padding: 10px 12px; min-height: 100px; }
  .zeichnungs-titel { font-weight: 700; color: #c41e1e; margin-bottom: 8px; }
  .zeichnungs-zeile { font-size: 9.5pt; margin-bottom: 6px; display: flex; gap: 6px; align-items: baseline; }
  .zeichnungs-zeile .line { flex: 1; border-bottom: 1px solid #888; min-height: 12pt; }
  .zeichnungs-zeile .line.short { flex: 0 0 60%; border-bottom: 1px solid #888; min-height: 12pt; }
  .zeichnungs-sigline { border-bottom: 1px solid #888; height: 30px; margin-top: 4px; }
  .footer-kontakte { margin-top: 14px; padding: 6px 0; border-top: 1px solid #ccc; font-size: 9pt; color: #444; }
  .footer-kontakte p { margin: 2px 0; }
  .verify-block { margin-top: 12px; padding: 10px; border: 1px dashed #888; border-radius: 4px; page-break-inside: avoid; break-inside: avoid; }
  .verify-block .verify-text { font-size: 9pt; color: #444; word-break: break-all; }
  .verify-block .verify-text strong { color: #c41e1e; font-family: monospace; font-size: 11pt; letter-spacing: 1px; }
  .verify-block code { word-break: break-all; }
  .footer-legal { page-break-inside: avoid; break-inside: avoid; }
  .zeichnungs-block, table.signatur tr { page-break-inside: avoid; break-inside: avoid; }
  .page-break { page-break-after: always; }
  .einzelbrief { padding-top: 6mm; }
  .einzelbrief .absender { font-size: 8pt; color: #555; border-bottom: 1px solid #999; padding-bottom: 2px; margin: 4mm 0 14mm 0; }
  .einzelbrief .anschrift { font-size: 11pt; line-height: 1.5; margin-bottom: 8mm; padding: 4px 0; }
</style></head><body>
  <div class="header">
    <img src="https://www.rosenweg4303.ch/logo-rosenweg.png" alt="Rosenweg">
    <div class="header-text">
      <h1>STWEG-Kooperation Rosenweg</h1>
      <p>STWEG ${stweg} · 4303 Kaiseraugst · Stand ${escHtml(datum)}</p>
    </div>
  </div>
  <h2 class="section-title">${escHtml(anlass_titel || 'Unterschriftenliste')}</h2>
  ${anlass_zweck ? `<p class="zweck">${escHtml(anlass_zweck).replace(/\n/g, '<br>')}</p>` : ''}
  ${ruecksendung_bis ? `<p class="hinweis"><strong>Rücksendung bis spätestens ${escHtml(ruecksendung_bis)}${ruecksendung_an ? ' an ' + escHtml(ruecksendung_an) : ''}</strong></p>` : ''}
  ${einzelOnly ? `
    <p class="hinweis">Diese Sammelseite dient als Übersicht. Aufgrund der breiten Streuung der ${totalUnits} Eigentümer der MEG-Tiefgarage über mehrere Häuser und auswärtige Adressen wird der Beschluss <strong>ausschliesslich per Einzelbrief</strong> versendet — jeder Eigentümer erhält ein eigenes Anschreiben mit Unterschriftszeile (siehe Folgeseiten).</p>
    <table class="info-table">
      <thead><tr><th>Einheit</th><th>Eigentümer</th><th>Wertquote</th><th>Versand-Adresse</th></tr></thead>
      <tbody>${einzelbriefe.map((e, i) => {
        const wq = wohnungen.rows.find(w => w.bezeichnung === e.bezeichnung);
        const wqStr = (wq?.wertquote_zaehler && wq?.wertquote_nenner) ? `${wq.wertquote_zaehler}/${wq.wertquote_nenner}` : '—';
        return `<tr><td><strong>${escHtml(e.bezeichnung)}</strong></td><td>${escHtml(e.eigentuemer.join(', '))}${e.verwalter.length>0?'<br><span style=\"font-size:8.5pt;color:#555\">↳ ' + escHtml(e.verwalter.join(', ')) + '</span>':''}</td><td style="text-align:center;font-family:monospace">${wqStr}</td><td style="font-size:9pt">${escHtml(e.adresse)}</td></tr>`;
      }).join('')}
      <tr class="total-row"><td><strong>TOTAL</strong></td><td><strong>${totalUnits} Einheiten</strong></td><td style="text-align:center"><strong>${totalWQ}/1000</strong></td><td></td></tr>
      </tbody>
    </table>
  ` : `
  <p class="hinweis">Jede/r Eigentümer/in kreuzt JA oder NEIN an und unterschreibt. Bei mehreren Eigentümern genügt die Unterschrift eines Eigentümers oder eines bevollmächtigten Vertreters. Auswärts wohnende Eigentümer haben den Brief per Einzelversand erhalten (siehe Anhang).</p>
  <table class="signatur">
    <thead><tr>
      <th class="cell-einheit">Einheit</th>
      <th class="cell-name">Eigentümer/in (bzw. Verwalter)</th>
      <th class="cell-adresse">Wohnadresse</th>
      <th class="cell-wq">Wertquote</th>
      <th class="cell-vote">JA / NEIN</th>
      <th class="cell-sig">Datum / Unterschrift</th>
    </tr></thead>
    <tbody>${dataRows}</tbody>
  </table>
  `}
  ${einzelbriefeUebersicht}
  ${zeichnungsberechtigte.length > 0 ? `
  <h2 class="section-title">Bestätigung des Ergebnisses &amp; Zeichnungsberechtigung</h2>
  <p class="hinweis">${escHtml(kollektiv_text || `Folgende Personen sind im Rahmen dieses Beschlusses zeichnungs- und vertretungsberechtigt für die STWEG-Kooperation Rosenweg gegenüber Banken, Notaren und Dritten. Zwei dieser Personen sind – kollektiv zu zweien – ermächtigt, im Namen der Eigentümer/innen dieser STWEG die vorgesehenen Handlungen vorzunehmen.`)}</p>
  <p class="hinweis">Mit ihren Unterschriften bestätigen die nachstehend zeichnenden Personen das Ergebnis des Zirkularbeschlusses und nehmen die Zeichnungsberechtigung an.</p>
  <table class="signatur" style="margin-top:10px">
    <thead><tr>
      <th style="width:25%">Funktion</th>
      <th style="width:30%">Name</th>
      <th style="width:18%">Datum</th>
      <th style="width:27%">Unterschrift</th>
    </tr></thead>
    <tbody>
      ${zeichnungsberechtigte.map(z => `<tr>
        <td><strong>${escHtml(z.funktion || '')}</strong></td>
        <td>${escHtml(z.name || '')}</td>
        <td style="height:50px"></td>
        <td></td>
      </tr>`).join('')}
    </tbody>
  </table>
  ` : ''}
  ${ruecksendung_an ? `
  <div class="footer-kontakte">
    <p><strong>Rückgabe:</strong> ${escHtml(ruecksendung_an)}</p>
  </div>
  ` : ''}
  <div class="footer-legal">
    <strong>Rechtshinweis:</strong> Diese Unterschriftenliste ist nur in Verbindung mit dem versendeten Hauptdokument gültig.
    Die Liste wurde am ${escHtml(generatedAt)} aus der zentralen Eigentümerdatenbank der STWEG-Kooperation Rosenweg generiert.
    Verwalter mit eingetragener Vollmacht zeichnen in Vertretung der Eigentümer.
    Bei mehreren Eigentümern einer Einheit genügt die Unterschrift eines Eigentümers oder eines bevollmächtigten Vertreters.
    Die Zeichnungsberechtigten oben bestätigen die Vollständigkeit dieser Sammlung gegenüber Banken und Behörden.
    <strong>Vollständigkeit:</strong> Das Dokument ist nur vollständig gültig, wenn alle im Seitenzähler ausgewiesenen Seiten ("Seite X von Y") vorhanden sind. Fehlt eine Seite, ist die gesamte Unterschriftenliste als ungültig zu betrachten und über die Echtheitsprüfung neu zu beziehen.
  </div>
  <div class="verify-block">
    <div class="verify-text">
      <p><strong>Echtheitsprüfung:</strong> Hash aus der Fusszeile eingeben unter<br>
      <code style="word-break:break-all">${escHtml(verifyPageBase)}</code></p>
      <p>Integritäts-Hash dieses Dokuments: <strong>${hash}</strong> · Generiert: ${escHtml(generatedAt)}</p>
    </div>
  </div>
  ${einzelbriefeSeiten}
</body></html>`;
}

// GET /api/unterschriftenliste/verify-json — Öffentliche JSON-API für die Echtheitsprüfungs-Webseite
app.get('/api/unterschriftenliste/verify-json', async (req, res) => {
  try {
    const claimedHash = (req.query.hash || '').toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(claimedHash)) return res.status(400).json({ error: 'Ungültiges Hash-Format', found: false });
    const snap = await pool.query('SELECT * FROM unterschriftenliste_snapshots WHERE hash = $1', [claimedHash]);
    if (snap.rows.length === 0) return res.json({ found: false, hash: claimedHash });
    const s = snap.rows[0];
    pool.query('UPDATE unterschriftenliste_snapshots SET download_count = COALESCE(download_count,0) + 1 WHERE hash = $1', [claimedHash]).catch(() => {});
    res.json({
      found: true,
      hash: s.hash,
      stweg: s.stweg,
      datum: String(s.datum).slice(0, 10),
      anlass_titel: s.anlass_titel,
      generated_at: s.generated_at,
      generated_at_local: new Date(s.generated_at).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }),
      download_count: (s.download_count || 0) + 1,
      snapshot: s.snapshot_data
    });
  } catch (err) {
    console.error('[Verify-JSON] error:', err.message);
    res.status(500).json({ error: err.message, found: false });
  }
});

// GET /api/unterschriftenliste/verify — Legacy-Route (z.B. ältere QR-Codes) → Redirect zur Webseite
app.get('/api/unterschriftenliste/verify', async (req, res) => {
  const h = (req.query.hash || '').toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 12);
  return res.redirect(302, h ? `/echtheitspruefung.html?hash=${h}` : '/echtheitspruefung.html');
});

// (deaktiviert) Alte server-rendered Verify-HTML — bleibt für historische Snapshots als Fallback
app.get('/api/unterschriftenliste/verify-legacy', async (req, res) => {
  try {
    const claimedHash = (req.query.hash || '').toUpperCase();
    if (!claimedHash) return res.status(400).send('<h1>Ungültige Verify-Anfrage</h1>');
    const snap = await pool.query(
      'SELECT * FROM unterschriftenliste_snapshots WHERE hash = $1',
      [claimedHash]
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (snap.rows.length === 0) {
      return res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Verifizierung — Rosenweg</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:20px;color:#222;}h1{color:#c41e1e}.box{padding:18px;border-radius:8px;margin:14px 0}.warn{background:#fee2e2;border-left:4px solid #dc2626}code{background:#f5f5f5;padding:2px 5px;border-radius:3px}</style></head><body>
<h1>Echtheitsprüfung — UNGÜLTIG</h1>
<div class="box warn">
  <p><strong>✗ Hash <code>${escHtml(claimedHash)}</code> nicht gefunden.</strong></p>
  <p>Diese Liste wurde entweder manipuliert, das PDF stammt nicht aus der STWEG-Kooperation Rosenweg, oder der Snapshot wurde gelöscht.</p>
</div>
<p style="font-size:11pt;color:#666">Bei Zweifel: Wenden Sie sich an den Ausschuss der STWEG-Kooperation Rosenweg.</p>
</body></html>`);
    }
    const s = snap.rows[0];
    const data = s.snapshot_data;
    const wohnungenHtml = (data.wohnungen || []).map(w => `<tr>
      <td><strong>${escHtml(w.bezeichnung)}</strong></td>
      <td>${escHtml((w.eigentuemer || []).join(', '))}${w.verwalter && w.verwalter.length>0 ? `<br><span style="font-size:9pt;color:#666">↳ Verwalter: ${escHtml(w.verwalter.join(', '))}</span>` : ''}</td>
      <td style="text-align:center">${escHtml(w.wertquote || '—')}</td>
      <td style="font-size:9pt">${(w.korrespondenz_adressen || []).map(escHtml).join('; ') || '<em>—</em>'}</td>
    </tr>`).join('');
    const zeichnerHtml = (data.zeichnungsberechtigte || []).map(z => `<tr>
      <td><strong>${escHtml(z.funktion || '')}</strong></td>
      <td>${escHtml(z.name || '')}</td>
    </tr>`).join('');
    res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>Verifizierung Unterschriftenliste</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:30px auto;padding:20px;color:#222}
h1{color:#10b981;border-bottom:3px solid #10b981;padding-bottom:8px}
h2{color:#c41e1e;margin-top:24px}
.box{padding:18px;border-radius:8px;margin:14px 0;background:#d1fae5;border-left:4px solid #10b981}
.meta{background:#f0f9ff;padding:14px;border-radius:8px;margin:12px 0;font-size:11pt}
.meta div{margin:4px 0}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10pt}
th{background:#f5f5f5;padding:8px;text-align:left;border:1px solid #ddd}
td{padding:6px 8px;border:1px solid #eee;vertical-align:top}
code{background:#f5f5f5;padding:2px 5px;border-radius:3px;font-family:monospace}
.hash{font-size:14pt;color:#10b981;font-weight:bold;letter-spacing:1px}
</style></head><body>
<h1>✓ Echtheit bestätigt</h1>
<div class="box">
<p><strong>Diese Unterschriftenliste ist authentisch und stammt aus der zentralen Datenbank der STWEG-Kooperation Rosenweg.</strong></p>
<p>Hash: <span class="hash">${escHtml(s.hash)}</span></p>
</div>
<div class="meta">
<div><strong>STWEG:</strong> ${s.stweg} · <strong>Datum:</strong> ${escHtml(String(s.datum).slice(0,10))}</div>
<div><strong>Anlass:</strong> ${escHtml(s.anlass_titel)}</div>
<div><strong>Generiert am:</strong> ${escHtml(new Date(s.generated_at).toLocaleString('de-CH', {timeZone:'Europe/Zurich'}))}${s.generated_by ? ' von '+escHtml(s.generated_by) : ''}</div>
<div><strong>Aufrufe:</strong> ${s.download_count + 1}</div>
</div>
<h2>Eigentümer-Stand zum Zeitpunkt der Generierung</h2>
<p style="font-size:10pt;color:#666">Vergleichen Sie diese Daten mit Ihrer ausgedruckten Liste. Stimmen alle ${data.wohnungen?.length||0} Einträge überein, ist die Liste unverändert.</p>
<table>
<thead><tr><th>Einheit</th><th>Eigentümer</th><th>Wertquote</th><th>Korrespondenz</th></tr></thead>
<tbody>${wohnungenHtml}</tbody>
<tfoot><tr style="background:#fce4e4;font-weight:bold"><td>TOTAL</td><td>${data.total_units||0} Einheiten</td><td>${data.total_wq||0}/1000</td><td></td></tr></tfoot>
</table>
${zeichnerHtml ? `<h2>Zeichnungsberechtigte</h2><table><thead><tr><th>Funktion</th><th>Name</th></tr></thead><tbody>${zeichnerHtml}</tbody></table>` : ''}
<h2>Original-PDF</h2>
<p>Falls Teile der ausgedruckten Liste verloren gegangen sind oder Sie eine zusätzliche Kopie brauchen — das Original-PDF kann jederzeit mit identischem Inhalt neu generiert werden:</p>
<p style="margin:14px 0">
  <a href="/api/unterschriftenliste/snapshot/${escHtml(s.hash)}.pdf" style="display:inline-block;padding:10px 18px;background:#10b981;color:white;border-radius:6px;text-decoration:none;font-weight:600">📄 Original-PDF herunterladen</a>
  &nbsp;
  <a href="/api/unterschriftenliste/snapshot/${escHtml(s.hash)}.pdf?preview=1" target="_blank" style="display:inline-block;padding:10px 18px;background:#f5f5f5;color:#333;border:1px solid #ddd;border-radius:6px;text-decoration:none">👁 Im Browser ansehen</a>
</p>
<p style="font-size:9pt;color:#888">Login erforderlich — Sie werden ggf. zur Authentik-Anmeldung weitergeleitet.</p>
<p style="font-size:10pt;color:#888;margin-top:30px">Diese Verifizierungsseite zeigt den Original-Stand zur Generierungszeit. Spätere Änderungen in der Datenbank haben keinen Einfluss auf diesen Snapshot. Für Rechtszwecke gilt das physisch unterschriebene Original.</p>
</body></html>`);
  } catch (err) {
    console.error('[Verify] error:', err.message);
    res.status(500).send('Verifizierungsfehler: ' + err.message);
  }
});

// GET /api/unterschriftenliste/snapshot/:hash.pdf — Gespeichertes Original-PDF ausliefern (öffentlich, Hash dient als Token)
app.get('/api/unterschriftenliste/snapshot/:hash.pdf', async (req, res) => {
  try {
    const hash = req.params.hash.toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(hash)) return res.status(400).json({ error: 'Ungültiger Hash' });
    const snap = await pool.query('SELECT stweg, datum, pdf_path FROM unterschriftenliste_snapshots WHERE hash = $1', [hash]);
    if (snap.rows.length === 0 || !snap.rows[0].pdf_path) return res.status(404).json({ error: 'PDF nicht gefunden' });
    const s = snap.rows[0];
    const fullPath = pathModule.join(DOCS_PATH, s.pdf_path);
    if (!fullPath.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return res.status(404).end();
    pool.query('UPDATE unterschriftenliste_snapshots SET download_count = COALESCE(download_count,0) + 1 WHERE hash = $1', [hash]).catch(() => {});
    res.setHeader('Content-Type', 'application/pdf');
    const inline = req.query.preview === '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="unterschriftenliste-stweg${s.stweg}-${String(s.datum).slice(0,10)}-${hash}.pdf"`);
    res.setHeader('Content-Length', stat.size);
    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) {
    console.error('[Snapshot-PDF] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/unterschriftenliste/history — alle generierten Snapshots auflisten
app.get('/api/unterschriftenliste/history', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.stweg) { params.push(parseInt(req.query.stweg)); where.push(`stweg = $${params.length}`); }
    const r = await pool.query(`
      SELECT hash, stweg, datum, anlass_titel, generated_at, generated_by, download_count,
             jsonb_array_length(snapshot_data->'wohnungen') AS unit_count
      FROM unterschriftenliste_snapshots
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY generated_at DESC LIMIT 100
    `, params);
    res.json({ snapshots: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/unterschriftenliste/:stweg.pdf', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), async (req, res) => {
  try {
    const stweg = parseStweg(req.params.stweg);
    if (!stweg) return res.status(400).json({ error: 'Ungültige STWEG' });
    let zeichner = [];
    if (req.query.zeichnungsberechtigte) {
      try { zeichner = JSON.parse(req.query.zeichnungsberechtigte); } catch {}
      if (!Array.isArray(zeichner)) zeichner = [];
    }
    const opts = {
      datum: req.query.datum || new Date().toISOString().slice(0, 10),
      anlass_titel: req.query.anlass_titel || 'Unterschriftenliste',
      anlass_zweck: req.query.anlass_zweck || '',
      ruecksendung_bis: req.query.ruecksendung_bis || '',
      ruecksendung_an: req.query.ruecksendung_an || '',
      zeichnungsberechtigte: zeichner,
      kollektiv_text: req.query.kollektiv_text || '',
    };
    opts.generated_by = req.user?.email || req.user?.name || null;
    const html = await buildUnterschriftenlisteHTML(stweg, opts);
    const GOTENBERG = process.env.GOTENBERG_URL || 'http://doc-converter:3000';
    const formData = new FormData();
    formData.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    formData.append('paperWidth', '8.27');
    formData.append('paperHeight', '11.7');
    formData.append('marginTop', '0.4');
    formData.append('marginBottom', '0.6');
    formData.append('marginLeft', '0.4');
    formData.append('marginRight', '0.4');
    formData.append('preferCssPageSize', 'true');
    const release = await gotenbergSemaphore();
    let pdfResp;
    try {
      pdfResp = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, {
        method: 'POST', body: formData, signal: AbortSignal.timeout(30000),
      });
    } finally { release(); }
    if (!pdfResp.ok) {
      const err = await pdfResp.text();
      console.error('[Unterschriftenliste] Gotenberg error:', err.slice(0, 300));
      return res.status(500).json({ error: 'PDF-Erstellung fehlgeschlagen' });
    }
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    // PDF persistieren — Original-Datei für späteren Re-Download
    if (opts._hash) {
      try {
        const dir = pathModule.join(DOCS_PATH, 'allgemein', 'unterschriftenlisten');
        await fs.mkdir(dir, { recursive: true });
        const pdfPath = pathModule.join(dir, `${opts._hash}.pdf`);
        await fs.writeFile(pdfPath, pdfBuf);
        await pool.query(
          'UPDATE unterschriftenliste_snapshots SET pdf_path = $1, pdf_size = $2 WHERE hash = $3',
          [`allgemein/unterschriftenlisten/${opts._hash}.pdf`, pdfBuf.length, opts._hash]
        );
      } catch (e) { console.error('[Unterschriftenliste] PDF save error:', e.message); }
    }
    res.setHeader('Content-Type', 'application/pdf');
    const inline = req.query.preview === '1';
    const fname = `unterschriftenliste-stweg${stweg}-${opts.datum}-${opts._hash || ''}.pdf`;
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fname}"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[Unterschriftenliste] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wohnungen/:stweg - List all apartments for a STWEG (admin, with kontakte)
app.get('/api/wohnungen/:stweg', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), requireStwegAccess, async (req, res) => {
  try {
    const stweg = parseStweg(req.params.stweg);
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
    const wohnungen = wResult.rows.map(w => {
      const kontakte = kontakteMap[w.id] || [];
      // Fallback: if no kontakte but flat eigentuemer_name exists, synthesize a kontakt
      if (kontakte.length === 0 && w.eigentuemer_name) {
        kontakte.push({
          rolle: 'eigentuemer', name: w.eigentuemer_name,
          email: w.eigentuemer_email || null, telefon: w.eigentuemer_telefon || null, adresse: null,
        });
      }
      if (kontakte.length === 0 && w.mieter_name) {
        kontakte.push({
          rolle: 'mieter', name: w.mieter_name,
          email: w.mieter_email || null, telefon: w.mieter_telefon || null, adresse: null,
        });
      }
      return { ...w, kontakte };
    });
    wohnungen.sort((a, b) => wohnungSort(a.bezeichnung, b.bezeichnung));
    res.json({ stweg, wohnungen });
  } catch (err) {
    console.error('Wohnungen list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Wohnungen' });
  }
});

// GET /api/stweg/:stweg/overview - Public summary (counts only, no personal data)
app.get('/api/stweg/:stweg/overview', async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg, 10);
    if (!stweg || stweg < 1 || stweg > 8) return res.status(400).json({ error: 'Ungueltige STWEG' });
    const counts = await pool.query(
      `SELECT typ, COUNT(*) as anzahl FROM wohnungen WHERE stweg = $1 GROUP BY typ`, [stweg]
    );
    const occupancy = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE bewohnt_von = 'eigentuemer') as selbstbewohnt,
              COUNT(*) FILTER (WHERE bewohnt_von = 'mieter') as vermietet,
              COUNT(*) FILTER (WHERE bewohnt_von = 'leer') as leer
       FROM wohnungen WHERE stweg = $1`, [stweg]
    );
    const waschRooms = await pool.query(
      'SELECT COUNT(*) as anzahl FROM wasch_rooms WHERE stweg = $1 AND active = true', [stweg]
    );
    const typCounts = {};
    for (const r of counts.rows) typCounts[r.typ || 'Wohnung'] = parseInt(r.anzahl);
    res.json({
      stweg,
      typen: typCounts,
      belegung: occupancy.rows[0],
      waschkuechen: parseInt(waschRooms.rows[0].anzahl),
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Uebersicht' });
  }
});

// GET /api/wohnungen/:stweg/stats - Occupancy statistics
app.get('/api/wohnungen/:stweg/stats', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), requireStwegAccess, async (req, res) => {
  try {
    const stweg = parseStweg(req.params.stweg);
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
    const wId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wId) || wId < 1) return res.status(400).json({ error: 'Ungültige Wohnungs-ID' });
    const w = await loadWohnungMitKontakte(wId);
    if (!w || w.stweg !== parseStweg(req.params.stweg)) return res.status(404).json({ error: 'Wohnung nicht gefunden' });
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
    const stweg = parseStweg(req.params.stweg);
    const b = req.body;
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO wohnungen (stweg, bezeichnung, stockwerk, zimmer, flaeche_m2, typ, besonderheiten,
        bewohnt_von, waschkueche_berechtigt, notizen, wertquote_zaehler, wertquote_nenner)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [stweg, b.bezeichnung, b.stockwerk, b.zimmer, b.flaeche_m2, b.typ || 'Wohnung', b.besonderheiten,
       b.bewohnt_von || 'eigentuemer', b.waschkueche_berechtigt !== false, b.notizen,
       b.wertquote_zaehler || null, b.wertquote_nenner || null]
    );
    await saveKontakte(client, result.rows[0].id, b.kontakte, stweg);
    await client.query('COMMIT');
    const wohnung = await loadWohnungMitKontakte(result.rows[0].id);
    res.status(201).json(wohnung);
    // Sync kontakte to Authentik in background (don't block response)
    syncKontakteToAuthentik(stweg, b.kontakte, b.bewohnt_von).catch(() => {});
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
    const stweg = parseStweg(req.params.stweg);
    const b = req.body;
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE wohnungen SET bezeichnung=$1, stockwerk=$2, zimmer=$3, flaeche_m2=$4, typ=$5, besonderheiten=$6,
        bewohnt_von=$7, waschkueche_berechtigt=$8, notizen=$9,
        wertquote_zaehler=$10, wertquote_nenner=$11, updated_at=NOW()
       WHERE id=$12 AND stweg=$13 RETURNING *`,
      [b.bezeichnung, b.stockwerk, b.zimmer, b.flaeche_m2, b.typ || 'Wohnung', b.besonderheiten,
       b.bewohnt_von || 'eigentuemer', b.waschkueche_berechtigt !== false, b.notizen,
       b.wertquote_zaehler || null, b.wertquote_nenner || null,
       req.params.id, stweg]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    }
    await saveKontakte(client, result.rows[0].id, b.kontakte, stweg);
    // Clear flat fields when kontakte are saved (migration from old format)
    if (b.kontakte && b.kontakte.length > 0) {
      await client.query(
        `UPDATE wohnungen SET eigentuemer_name=NULL, eigentuemer_email=NULL, eigentuemer_telefon=NULL,
         mieter_name=NULL, mieter_email=NULL, mieter_telefon=NULL WHERE id=$1`,
        [result.rows[0].id]
      );
    }
    await client.query('COMMIT');
    const wohnung = await loadWohnungMitKontakte(result.rows[0].id);
    res.json(wohnung);
    // Sync kontakte to Authentik in background
    syncKontakteToAuthentik(parseStweg(req.params.stweg), b.kontakte, b.bewohnt_von).catch(() => {});
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
    const stweg = parseStweg(req.params.stweg);
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
        const bewohntVon = u.bewohnt_von || (hasMieter ? 'mieter' : 'eigentuemer');
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
        await saveKontakte(client, wohnungId, kontakte, stweg);
        imported++;
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, imported });
    // Sync all imported kontakte to Authentik in background
    const allKontakte = [];
    for (const [, units] of Object.entries(data.wohnungen)) {
      for (const u of units) {
        const eig = u.eigentümer || u.eigentuemer;
        if (eig?.email) allKontakte.push({ rolle: 'eigentuemer', name: eig.name, email: eig.email });
        if (u.mieter?.email) allKontakte.push({ rolle: 'mieter', name: u.mieter.name, email: u.mieter.email });
      }
    }
    if (allKontakte.length > 0) syncKontakteToAuthentik(stweg, allKontakte).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Wohnungen import error:', err);
    res.status(500).json({ error: 'Import fehlgeschlagen: ' + err.message });
  } finally {
    client.release();
  }
});


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
          const emails = gn.startsWith('verwaltung:')
            ? await resolveVerwaltungsGroup(gn)
            : await resolveGroupEmails(gn);
          // Filter out base drucker addresses without +tag (kein Empfänger zugeordnet)
          emails.filter(e => !/^druckerr(9|13)@/.test(e)).forEach(e => allEmails.add(e));
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
        const emails = gn.startsWith('verwaltung:')
          ? await resolveVerwaltungsGroup(gn)
          : await resolveGroupEmails(gn);
        emails.filter(e => !/^druckerr(9|13)@/.test(e)).forEach(e => allEmails.add(e));
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
  const { stweg, name, email_address, members, reply_to, subject_prefix, group_name, group_names, allowed_sender_groups } = req.body;
  if (!name || !email_address) return res.status(400).json({ error: 'Name und Email-Adresse erforderlich' });
  try {
    const groups = group_names?.length ? group_names : (group_name ? [group_name] : []);
    const allowedSenders = Array.isArray(allowed_sender_groups) ? allowed_sender_groups : [];
    const result = await pool.query(
      `INSERT INTO email_verteiler (stweg, name, email_address, members, reply_to, subject_prefix, group_name, group_names, allowed_sender_groups)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [stweg || 0, name, email_address, JSON.stringify(members || []), reply_to || 'sender', subject_prefix || null, groups[0] || null, JSON.stringify(groups), JSON.stringify(allowedSenders)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email-Adresse existiert bereits' });
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// Update Verteiler
app.put('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  const { stweg, name, email_address, members, active, reply_to, subject_prefix, group_name, group_names, allowed_sender_groups } = req.body;
  try {
    const groups = group_names?.length ? group_names : (group_name ? [group_name] : []);
    const allowedSenders = Array.isArray(allowed_sender_groups) ? allowed_sender_groups : [];
    const result = await pool.query(
      `UPDATE email_verteiler SET stweg=$1, name=$2, email_address=$3, members=$4, active=$5,
              reply_to=$6, subject_prefix=$7, group_name=$8, group_names=$9, allowed_sender_groups=$10
       WHERE id=$11 RETURNING *`,
      [stweg, name, email_address, JSON.stringify(members || []), active !== false, reply_to || 'sender', subject_prefix || null, groups[0] || null, JSON.stringify(groups), JSON.stringify(allowedSenders), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

// POST /api/verteiler/preview-groups — Live-Auflösung von Verwaltungs/Authentik-Gruppen
app.post('/api/verteiler/preview-groups', authMiddleware, adminOnly, async (req, res) => {
  const { group_names } = req.body;
  if (!Array.isArray(group_names)) return res.status(400).json({ error: 'group_names array erforderlich' });
  try {
    const allEmails = new Set();
    for (const gn of group_names) {
      const emails = gn.startsWith('verwaltung:')
        ? await resolveVerwaltungsGroup(gn)
        : await resolveGroupEmails(gn);
      emails.filter(e => !/^druckerr(9|13)@/i.test(e)).forEach(e => allEmails.add(e));
    }
    res.json({ emails: [...allEmails].sort(), count: allEmails.size });
  } catch (err) {
    console.error('preview-groups error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/verteiler/:id/test-send — Test-Versand nur an aufrufenden Admin
app.post('/api/verteiler/:id/test-send', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows: [list] } = await pool.query('SELECT * FROM email_verteiler WHERE id = $1', [req.params.id]);
    if (!list) return res.status(404).json({ error: 'Verteiler nicht gefunden' });
    const recipientEmail = req.user?.email;
    if (!recipientEmail) return res.status(400).json({ error: 'Keine Email beim eingeloggten User' });
    const subject = (req.body?.subject || 'Test-Email an Verteiler').slice(0, 200);
    const recipients = await resolveVerteilerRecipients(list);
    await loggedSendMail({
      from: `"Rosenweg Verteiler-Test" <noreply@${VERTEILER_DOMAIN}>`,
      to: recipientEmail,
      subject: `[TEST] ${subject}`,
      html: `<p>Dies ist eine Test-Email für den Verteiler <strong>${list.name}</strong> (<code>${list.email_address}</code>).</p>
        <p>Bei einem echten Versand würden <strong>${recipients.length} Empfänger</strong> diese Email erhalten:</p>
        <p style="font-size:12px;color:#555;font-family:monospace">${recipients.slice(0, 100).join(', ')}${recipients.length > 100 ? ' …' : ''}</p>
        <hr>
        <p style="color:#888;font-size:11px">Sender-Validierung: ${list.allowed_sender_groups?.length ? 'eingeschränkt auf ' + list.allowed_sender_groups.join(', ') : 'jeder @rosenweg4303.ch-Sender'}</p>`,
    }, 'verteiler-test');
    res.json({ sent_to: recipientEmail, would_reach: recipients.length });
  } catch (err) {
    console.error('test-send error:', err.message);
    res.status(500).json({ error: err.message });
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
      signal: AbortSignal.timeout(15000),
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

// DMARC Reports - parse from Gmail inbox
app.get('/api/dmarc/reports', authMiddleware, adminOnly, async (req, res) => {
  if (!IMAP_USER || !IMAP_PASS) return res.status(400).json({ error: 'IMAP nicht konfiguriert' });
  try {
    const { ImapFlow } = require('imapflow');
    const zlib = require('zlib');
    const client = new ImapFlow({
      host: IMAP_HOST, port: IMAP_PORT, secure: true,
      auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false,
      socketTimeout: 30000, greetingTimeout: 15000, connectionTimeout: 30000,
    });
    await client.connect();

    // Try DMARC folder first (IMAP poller moves dmarc@ mails here), fallback to INBOX
    let folderOpened = false;
    try { await client.mailboxOpen('DMARC'); folderOpened = true; } catch {}
    if (!folderOpened) await client.mailboxOpen('INBOX');

    // Find DMARC report emails
    const uids = [];
    for await (const msg of client.fetch('1:*', { envelope: true })) {
      const subj = (msg.envelope.subject || '').toLowerCase();
      const from = msg.envelope.from?.[0]?.address || '';
      if (folderOpened || subj.includes('report domain') || subj.includes('dmarc') || from.includes('dmarc')) {
        uids.push({ uid: msg.uid, subject: msg.envelope.subject, from, date: msg.envelope.date });
      }
    }

    const reports = [];
    for (const info of uids.slice(-20)) { // last 20 reports
      try {
        const dl = await client.download(String(info.uid), undefined, { uid: true });
        const chunks = [];
        for await (const chunk of dl.content) chunks.push(chunk);
        const parsed = await simpleParser(Buffer.concat(chunks));
        const att = (parsed.attachments || [])[0];
        if (!att) continue;

        let xml;
        const buf = att.content;
        if (att.filename?.endsWith('.gz')) {
          xml = zlib.gunzipSync(buf).toString();
        } else if (att.filename?.endsWith('.zip')) {
          // Parse ZIP local file header
          let i = 0;
          while (i < buf.length - 4) {
            if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
              const fnLen = buf.readUInt16LE(i + 26);
              const exLen = buf.readUInt16LE(i + 28);
              const compSize = buf.readUInt32LE(i + 18);
              const dataStart = i + 30 + fnLen + exLen;
              xml = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString();
              break;
            }
            i++;
          }
        } else {
          xml = buf.toString();
        }
        if (!xml) continue;

        // Parse XML manually (no dependency needed)
        const getTag = (s, tag) => { const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
        const getAllTags = (s, tag) => { const r = []; let m; const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'); while ((m = re.exec(s))) r.push(m[1]); return r; };

        const meta = getTag(xml, 'report_metadata');
        const policy = getTag(xml, 'policy_published');
        const records = getAllTags(xml, 'record');

        const report = {
          org: getTag(meta, 'org_name'),
          reportId: getTag(meta, 'report_id'),
          dateRange: {
            begin: new Date(parseInt(getTag(getTag(meta, 'date_range'), 'begin')) * 1000).toISOString(),
            end: new Date(parseInt(getTag(getTag(meta, 'date_range'), 'end')) * 1000).toISOString(),
          },
          domain: getTag(policy, 'domain'),
          policy: { dkim: getTag(policy, 'adkim'), spf: getTag(policy, 'aspf'), p: getTag(policy, 'p') },
          records: records.map(r => {
            const row = getTag(r, 'row');
            const pe = getTag(row, 'policy_evaluated');
            const auth = getTag(r, 'auth_results');
            const dkimResults = getAllTags(auth, 'dkim').map(d => ({
              domain: getTag(d, 'domain'), result: getTag(d, 'result'), selector: getTag(d, 'selector')
            }));
            const spfResults = getAllTags(auth, 'spf').map(s => ({
              domain: getTag(s, 'domain'), result: getTag(s, 'result')
            }));
            return {
              sourceIp: getTag(row, 'source_ip'),
              count: parseInt(getTag(row, 'count')) || 0,
              disposition: getTag(pe, 'disposition'),
              dkim: getTag(pe, 'dkim'),
              spf: getTag(pe, 'spf'),
              headerFrom: getTag(getTag(r, 'identifiers'), 'header_from'),
              authDkim: dkimResults,
              authSpf: spfResults,
            };
          }),
        };
        reports.push(report);
      } catch (e) {
        console.warn(`[DMARC] Failed to parse report UID ${info.uid}:`, e.message);
      }
    }

    try { await client.logout(); } catch {} finally { try { client.close(); } catch {} }

    // Summary
    let totalPass = 0, totalFail = 0, totalMessages = 0;
    for (const r of reports) {
      for (const rec of r.records) {
        totalMessages += rec.count;
        if (rec.dkim === 'pass' || rec.spf === 'pass') totalPass += rec.count;
        else totalFail += rec.count;
      }
    }

    res.json({ reports: reports.reverse(), summary: { totalMessages, totalPass, totalFail, reportCount: reports.length } });
  } catch (err) {
    console.error('DMARC error:', err);
    res.status(500).json({ error: 'DMARC-Reports konnten nicht geladen werden' });
  }
});

// SMTP2GO email quota / kontingent
app.get('/api/email/quota', authMiddleware, adminOnly, async (req, res) => {
  if (!SMTP2GO_API_KEY) return res.status(400).json({ error: 'SMTP2GO API-Key nicht konfiguriert' });
  try {
    const apiRes = await fetch(`${SMTP2GO_API_URL}/stats/email_summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ api_key: SMTP2GO_API_KEY }),
    });
    const apiData = await apiRes.json();
    const d = apiData.data || {};
    res.json({
      cycle_start: d.cycle_start,
      cycle_end: d.cycle_end,
      used: d.cycle_used || 0,
      remaining: d.cycle_remaining || 0,
      max: d.cycle_max || 0,
      opens: d.opens || 0,
      bounces: (d.hardbounces || 0) + (d.softbounces || 0),
    });
  } catch (err) {
    console.error('SMTP2GO quota error:', err);
    res.status(500).json({ error: 'SMTP2GO-Abfrage fehlgeschlagen' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PUBLIC INFO API (Ausschuss, Technischer Dienst)
// ═══════════════════════════════════════════════════════════════════

// Cache for public endpoints (prevents DoS on Authentik)
const publicApiCache = { ausschuss: { data: null, at: 0 }, technik: { data: null, at: 0 } };
const PUBLIC_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// GET /api/public/ausschuss - Ausschuss-Vertreter per STWEG (from Authentik groups)
app.get('/api/public/ausschuss', async (req, res) => {
  try {
    if (publicApiCache.ausschuss.data && Date.now() - publicApiCache.ausschuss.at < PUBLIC_CACHE_TTL) {
      return res.json(publicApiCache.ausschuss.data);
    }
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

    publicApiCache.ausschuss = { data: result, at: Date.now() };
    res.json(result);
  } catch (err) {
    console.error('Public ausschuss error:', err.message);
    res.status(500).json({ error: 'Ausschuss-Daten konnten nicht geladen werden' });
  }
});

// GET /api/public/technik - Technischer Dienst Mitglieder (from Authentik Technik group)
app.get('/api/public/technik', async (req, res) => {
  try {
    if (publicApiCache.technik.data && Date.now() - publicApiCache.technik.at < PUBLIC_CACHE_TTL) {
      return res.json(publicApiCache.technik.data);
    }
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

    const technikResult = { email: 'technik@rosenweg9.ch', mitglieder };
    publicApiCache.technik = { data: technikResult, at: Date.now() };
    res.json(technikResult);
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
      const response = await fetch(GOOGLE_CALENDAR_ICS_URL, { signal: AbortSignal.timeout(10000) });
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
// STWEG CALENDAR
// ═══════════════════════════════════════════════════════════════════

// GET /api/stweg/:stweg/events — list events (own STWEG + kooperation events from global calendar)
app.get('/api/stweg/:stweg/events', authMiddleware, async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg, 10);
    if (!stweg || stweg < 1 || stweg > 8) return res.status(400).json({ error: 'Ungueltige STWEG' });
    // STWEG-eigene Termine
    const result = await pool.query(
      `SELECT * FROM stweg_events WHERE stweg = $1 AND start_date >= NOW() - INTERVAL '7 days' ORDER BY start_date LIMIT 20`,
      [stweg]
    );
    // Merge with global calendar
    let globalEvents = [];
    try {
      const calResp = await fetch(`http://127.0.0.1:${PORT}/api/calendar`);
      if (calResp.ok) {
        const calData = await calResp.json();
        globalEvents = (calData.events || []).slice(0, 10).map(e => ({ ...e, source: 'kooperation' }));
      }
    } catch {}
    const stwegEvents = result.rows.map(e => ({
      title: e.title, description: e.description, start: e.start_date, end: e.end_date,
      location: e.location, category: e.category, all_day: e.all_day,
      id: e.id, source: 'stweg',
    }));
    // Merge and sort by date
    const all = [...stwegEvents, ...globalEvents].sort((a, b) => new Date(a.start) - new Date(b.start));
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/stweg/:stweg/events — create event (admin/ausschuss only)
app.post('/api/stweg/:stweg/events', authMiddleware, adminOnly, async (req, res) => {
  try {
    const stweg = parseInt(req.params.stweg, 10);
    const { title, description, start_date, end_date, all_day, location, category } = req.body;
    if (!title || !start_date) return res.status(400).json({ error: 'Titel und Startdatum erforderlich' });
    const result = await pool.query(
      `INSERT INTO stweg_events (stweg, title, description, start_date, end_date, all_day, location, category, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [stweg, title, description || null, start_date, end_date || null, all_day || false, location || null, category || 'sonstiges', req.user.user_id || req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// DELETE /api/stweg/:stweg/events/:id
app.delete('/api/stweg/:stweg/events/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM stweg_events WHERE id = $1 AND stweg = $2', [req.params.id, parseInt(req.params.stweg)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════

async function authentikAPI(method, path, body = null) {
  // WICHTIG: AUTHENTIK_EXTERNAL_URL nutzen (nicht AUTHENTIK_URL/intern), damit
  // Authentik bei URL-aufbauenden Endpunkten (recovery_email, account-confirm,
  // MFA-setup-link) den oeffentlichen Hostnamen in die generierten Links
  // einsetzt. Sonst landen Links als https://authentik-server:9443/... in
  // Mails, die fuer Empfaenger nicht klickbar sind.
  const url = `${AUTHENTIK_EXTERNAL_URL}/api/v3${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${AUTHENTIK_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  opts.signal = AbortSignal.timeout(15000);
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
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  const groups = req.user?.groups || [];
  const isAdmin = isTechnik(groups) || isPraesident(groups);
  const ausschussStwegs = getAusschussStwegs(groups);

  if (!isAdmin && ausschussStwegs.size === 0) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  try {
    const data = await authentikAPI('GET', '/core/users/?page_size=500');
    if (isAdmin) return res.json(data);

    // Ausschuss: filter to users in their STWEGs
    const allowedGroupNames = new Set();
    for (const nr of ausschussStwegs) {
      const mapping = STWEG_GROUPS[nr];
      if (mapping) Object.values(mapping).forEach(g => allowedGroupNames.add(g.toLowerCase()));
    }
    const results = (data.results || data).filter(u => {
      const userGroups = (u.groups_obj || []).map(g => g.name.toLowerCase());
      return userGroups.some(g => allowedGroupNames.has(g));
    });
    res.json({ ...data, results });
  } catch (err) {
    console.error('Admin list users error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
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
    // Sync password to AD DC
    if (password && username) {
      try {
        await fetch(AD_PASSWORD_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AD_PASSWORD_API_SECRET}` },
          body: JSON.stringify({ username, password }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) { console.error('AD password sync failed:', e.message); }
    }
    res.json(user);
  } catch (err) {
    console.error('Admin create user error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// GET /api/admin/users/:pk - Get single user
app.get('/api/admin/users/:pk', authMiddleware, async (req, res) => {
  const groups = req.user?.groups || [];
  const isAdmin = isTechnik(groups) || isPraesident(groups);
  if (!isAdmin && !isAusschussForAny(groups)) return res.status(403).json({ error: 'Keine Berechtigung' });
  const pk = parseInt(req.params.pk, 10);
  if (!Number.isFinite(pk) || pk < 1) return res.status(400).json({ error: 'Ungültige User-ID' });
  try {
    const data = await authentikAPI('GET', `/core/users/${pk}/`);
    res.json(data);
  } catch (err) {
    console.error('Admin get user error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
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
app.put('/api/admin/users/:pk', authMiddleware, async (req, res) => {
  const callerGroups = req.user?.groups || [];
  const isAdmin = isTechnik(callerGroups) || isPraesident(callerGroups);
  const ausschussStwegs = getAusschussStwegs(callerGroups);
  if (!isAdmin && ausschussStwegs.size === 0) return res.status(403).json({ error: 'Keine Berechtigung' });

  const userPk = parseInt(req.params.pk, 10);
  if (!Number.isFinite(userPk) || userPk < 1) return res.status(400).json({ error: 'Ungültige User-ID' });

  // Ausschuss: verify target user is in their STWEG
  if (!isAdmin) {
    try {
      const targetUser = await authentikAPI('GET', `/core/users/${userPk}/`);
      const targetGroups = (targetUser.groups_obj || []).map(g => g.name.toLowerCase());
      const allowedGroupNames = new Set();
      for (const nr of ausschussStwegs) {
        const mapping = STWEG_GROUPS[nr];
        if (mapping) Object.values(mapping).forEach(g => allowedGroupNames.add(g.toLowerCase()));
      }
      if (!targetGroups.some(g => allowedGroupNames.has(g))) {
        return res.status(403).json({ error: 'Benutzer gehört nicht zu deiner STWEG' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Berechtigungsprüfung fehlgeschlagen' });
    }
  }

  try {
    const { name, email, is_active, groups } = req.body;
    // Ausschuss cannot modify groups
    if (!isAdmin && groups) return res.status(403).json({ error: 'Gruppen können nur von Technik geändert werden' });
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
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// DELETE /api/admin/users/:pk - Delete/deactivate user
app.delete('/api/admin/users/:pk', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  const pk = parseInt(req.params.pk, 10);
  if (!Number.isFinite(pk) || pk < 1) return res.status(400).json({ error: 'Ungültige User-ID' });
  try {
    await authentikAPI('DELETE', `/core/users/${pk}/`);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete user error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// GET /api/admin/groups - List all groups
app.get('/api/admin/groups', authMiddleware, requirePermission('bewohner-verwaltung', 'read'), async (req, res) => {
  try {
    const data = await authentikAPI('GET', '/core/groups/?page_size=500');
    res.json(data);
  } catch (err) {
    console.error('Admin list groups error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
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
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// PUT /api/admin/groups/:pk/add_user - Add user to group
app.put('/api/admin/groups/:pk/add_user', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const data = await authentikAPI('POST', `/core/groups/${req.params.pk}/add_user/`, { pk: req.body.pk });
    res.json(data);
  } catch (err) {
    console.error('Admin add user to group error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// PUT /api/admin/groups/:pk/remove_user - Remove user from group
app.put('/api/admin/groups/:pk/remove_user', authMiddleware, requirePermission('bewohner-verwaltung', 'write'), async (req, res) => {
  try {
    const data = await authentikAPI('POST', `/core/groups/${req.params.pk}/remove_user/`, { pk: req.body.pk });
    res.json(data);
  } catch (err) {
    console.error('Admin remove user from group error:', err.message);
    res.status(500).json({ error: req.user?.isAdmin ? err.message : 'Interner Serverfehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL ARCHIVE (4-Augen Löschprinzip)
// ═══════════════════════════════════════════════════════════════════

function requireArchiveAccess(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups) || isAusschussForAny(groups)) return next();
  return res.status(403).json({ error: 'Kein Zugriff auf das E-Mail-Archiv' });
}

// GET /api/email-archive - List archived emails with search & pagination
app.get('/api/email-archive', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = "deletion_status != 'deleted'";
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (subject ILIKE $1 OR from_email ILIKE $1 OR from_name ILIKE $1)`;
    }

    const countRes = await pool.query(`SELECT COUNT(*) FROM email_archive WHERE ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const dataRes = await pool.query(
      `SELECT id, from_email, from_name, subject, email_date, created_at, attachments, deletion_status
       FROM email_archive WHERE ${where}
       ORDER BY email_date DESC NULLS LAST, created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ emails: dataRes.rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Email archive list error:', err.message);
    res.status(500).json({ error: 'Fehler beim Laden des Archivs' });
  }
});

// GET /api/email-archive/delete-requests - List pending deletion requests
app.get('/api/email-archive/delete-requests', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, a.subject, a.from_email, a.from_name, a.email_date
       FROM email_archive_deletions d
       JOIN email_archive a ON a.id = d.archive_id
       WHERE d.status = 'pending'
       ORDER BY d.requested_at DESC`
    );
    res.json({ requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Löschanträge' });
  }
});

// GET /api/email-archive/:id - Single email detail
app.get('/api/email-archive/:id', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, d.id as deletion_id, d.requested_by, d.reason, d.status as deletion_request_status
       FROM email_archive a
       LEFT JOIN email_archive_deletions d ON d.archive_id = a.id AND d.status = 'pending'
       WHERE a.id = $1 AND a.deletion_status != 'deleted'`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der E-Mail' });
  }
});

// GET /api/email-archive/:id/attachment/:filename - Download attachment
app.get('/api/email-archive/:id/attachment/:filename', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT attachments FROM email_archive WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden' });

    const attachments = result.rows[0].attachments || [];
    const att = attachments.find(a => a.stored_name === req.params.filename || a.filename === req.params.filename);
    if (!att) return res.status(404).json({ error: 'Anhang nicht gefunden' });

    const filePath = pathModule.join(DOCS_PATH, 'archiv', att.stored_name);
    // Path traversal protection
    if (!filePath.startsWith(pathModule.resolve(DOCS_PATH, 'archiv'))) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const safeAttName = (att.filename || 'attachment').replace(/["\r\n\\]/g, '_');
    const safeAttAscii = safeAttName.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', att.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeAttAscii}"; filename*=UTF-8''${encodeURIComponent(safeAttName)}`);
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Datei nicht gefunden' }); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Download' });
  }
});

// POST /api/email-archive/:id/delete-request - Request deletion (4-Augen step 1)
app.post('/api/email-archive/:id/delete-request', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Begründung erforderlich' });

    const email = await pool.query(
      "SELECT id FROM email_archive WHERE id = $1 AND deletion_status = 'active'", [req.params.id]
    );
    if (email.rows.length === 0) return res.status(404).json({ error: 'E-Mail nicht gefunden oder bereits in Löschung' });

    // Check no pending request exists
    const existing = await pool.query(
      "SELECT id FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [req.params.id]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });

    await pool.query(
      `INSERT INTO email_archive_deletions (archive_id, requested_by, reason) VALUES ($1, $2, $3)`,
      [req.params.id, req.user.email, reason.trim()]
    );
    await pool.query("UPDATE email_archive SET deletion_status = 'pending' WHERE id = $1", [req.params.id]);

    res.json({ success: true, message: 'Löschantrag erstellt. Eine zweite Person muss bestätigen.' });
  } catch (err) {
    console.error('Delete request error:', err.message);
    res.status(500).json({ error: 'Fehler beim Erstellen des Löschantrags' });
  }
});

// POST /api/email-archive/:id/confirm-delete - Confirm or reject deletion (4-Augen step 2)
app.post('/api/email-archive/:id/confirm-delete', authMiddleware, requireArchiveAccess, async (req, res) => {
  try {
    const { action } = req.body; // 'confirm' or 'reject'
    if (!['confirm', 'reject'].includes(action)) return res.status(400).json({ error: 'Aktion muss "confirm" oder "reject" sein' });

    const pending = await pool.query(
      "SELECT * FROM email_archive_deletions WHERE archive_id = $1 AND status = 'pending'", [req.params.id]
    );
    if (pending.rows.length === 0) return res.status(404).json({ error: 'Kein offener Löschantrag gefunden' });

    const request = pending.rows[0];

    // 4-Augen: confirmer must be different from requester
    if (request.requested_by === req.user.email) {
      return res.status(403).json({ error: '4-Augen-Prinzip: Sie können Ihren eigenen Löschantrag nicht bestätigen' });
    }

    if (action === 'reject') {
      await pool.query(
        `UPDATE email_archive_deletions SET status = 'rejected', confirmed_by = $1, confirmed_at = NOW() WHERE id = $2`,
        [req.user.email, request.id]
      );
      await pool.query("UPDATE email_archive SET deletion_status = 'active' WHERE id = $1", [req.params.id]);
      return res.json({ success: true, message: 'Löschantrag abgelehnt' });
    }

    // Confirm: delete attachments from disk, then mark as deleted
    const emailData = await pool.query('SELECT attachments FROM email_archive WHERE id = $1', [req.params.id]);
    if (emailData.rows.length > 0) {
      const attachments = emailData.rows[0].attachments || [];
      for (const att of attachments) {
        try {
          await fs.unlink(pathModule.join(DOCS_PATH, 'archiv', att.stored_name));
        } catch {}
      }
    }

    await pool.query(
      `UPDATE email_archive_deletions SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW() WHERE id = $2`,
      [req.user.email, request.id]
    );
    await pool.query(
      "UPDATE email_archive SET deletion_status = 'deleted', text_body = NULL, html_body = NULL, attachments = '[]' WHERE id = $1",
      [req.params.id]
    );

    res.json({ success: true, message: 'E-Mail wurde gelöscht (4-Augen bestätigt)' });
  } catch (err) {
    console.error('Confirm delete error:', err.message);
    res.status(500).json({ error: 'Fehler bei der Löschbestätigung' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// GRUNDBUCH-CROWDSOURCING (Eigentümer erfassen Anteile per Upload)
// ═══════════════════════════════════════════════════════════════════

const GRUNDBUCH_BILDER_DIR = 'allgemein/grundbuch-bilder';

function isAusschussOrTechnik(req) {
  const groups = req.user?.groups || [];
  return isTechnik(groups) || isPraesident(groups) || isAusschussForAny(groups);
}

// GET /api/grundbuch/status — Übersicht-Statistik
app.get('/api/grundbuch/status', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'offen') AS offen,
        COUNT(*) FILTER (WHERE status = 'reserviert') AS reserviert,
        COUNT(*) FILTER (WHERE status = 'erfasst') AS erfasst,
        COUNT(*) FILTER (WHERE status = 'freigegeben') AS freigegeben,
        COUNT(DISTINCT erfasst_von) FILTER (WHERE erfasst_von IS NOT NULL) AS contributors
      FROM grundbuch_anteile`);
    const top = await pool.query(`
      SELECT erfasst_von AS user, COUNT(*) AS anzahl
      FROM grundbuch_anteile WHERE erfasst_von IS NOT NULL
      GROUP BY erfasst_von ORDER BY anzahl DESC LIMIT 10`);
    res.json({ stats: r.rows[0], top_contributors: top.rows });
  } catch (err) {
    console.error('grundbuch status err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/grundbuch/anteile — Liste mit Filtern (alle eingeloggten User)
app.get('/api/grundbuch/anteile', authMiddleware, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.parzelle) { params.push(parseInt(req.query.parzelle)); where.push(`parzelle = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.mine === '1' && req.user?.email) { params.push(req.user.email); where.push(`(erfasst_von = $${params.length} OR reserviert_von = $${params.length})`); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await pool.query(`
      SELECT parzelle, sub_id, anteil_z, anteil_n, anteil_typ, gemeinde, flaeche_m2,
             eigentumsform, eigentuemer, wohnadressen, bild_path,
             status, reserviert_von, reserviert_am, erfasst_von, erfasst_am,
             verifiziert_von, verifiziert_am, notizen
      FROM grundbuch_anteile ${wsql}
      ORDER BY parzelle, sub_id`, params);
    res.json({ anteile: r.rows });
  } catch (err) {
    console.error('grundbuch list err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/reserve — als „in Bearbeitung" markieren
app.post('/api/grundbuch/anteile/:parzelle/:sub_id/reserve', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    // Auto-release nach 30 Min
    await pool.query(`
      UPDATE grundbuch_anteile SET status='offen', reserviert_von=NULL, reserviert_am=NULL
      WHERE status='reserviert' AND reserviert_am < now() - interval '30 minutes'`);
    const r = await pool.query(`
      UPDATE grundbuch_anteile
      SET status='reserviert', reserviert_von=$1, reserviert_am=now(), updated_at=now()
      WHERE parzelle=$2 AND sub_id=$3 AND status IN ('offen','reserviert') AND (reserviert_von IS NULL OR reserviert_von=$1)
      RETURNING *`, [me, p, s]);
    if (r.rows.length === 0) return res.status(409).json({ error: 'Bereits reserviert oder erfasst' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('grundbuch reserve err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// DELETE /api/grundbuch/anteile/:parzelle/:sub_id/reserve — Reservierung freigeben
app.delete('/api/grundbuch/anteile/:parzelle/:sub_id/reserve', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const r = await pool.query(`
      UPDATE grundbuch_anteile SET status='offen', reserviert_von=NULL, reserviert_am=NULL, updated_at=now()
      WHERE parzelle=$1 AND sub_id=$2 AND reserviert_von=$3 AND status='reserviert'
      RETURNING parzelle, sub_id`, [p, s, me]);
    res.json({ released: r.rows.length > 0 });
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/grundbuch/ocr — Grundbuchauszug-Bild via Claude Vision (OpenRouter) auslesen
// Body: { bild_base64, bild_filename }
// Returns: { eigentumsform?, eigentuemer:[], wohnadressen:[], anteil_z?, flaeche_m2?, raw }
app.post('/api/grundbuch/ocr', authMiddleware, async (req, res) => {
  try {
    const { bild_base64, bild_filename } = req.body || {};
    if (!bild_base64) return res.status(400).json({ error: 'bild_base64 fehlt' });
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    const ext = (bild_filename || 'png').split('.').pop().toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' };
    const mime = mimeMap[ext] || 'image/png';
    const dataUrl = `data:${mime};base64,${bild_base64}`;

    const systemPrompt = `Du bist ein präziser Extraktor für schweizerische Grundbuchauszüge der Gemeinde Kaiseraugst (AG).
Lies den Grundbuchauszug aus dem Bild und extrahiere die folgenden Felder.
Antworte AUSSCHLIESSLICH mit gültigem JSON, ohne Markdown-Codeblöcke, ohne erklärenden Text.

Schema:
{
  "anteil_z": number|null,           // Zähler des Stockwerk-Anteils, z.B. 5 bei "5/1000"
  "eigentumsform": string|null,      // Wörtlich aus dem Auszug, z.B. "Alleineigentum" oder "Gesamteigentum (einf. Gesellschaft)" oder "Miteigentum"
  "eigentuemer": [string],           // Liste aller Eigentümer-Namen, je ein Eintrag pro Person, Format "Nachname Vorname". Bei Gesamteigentum alle Personen separat.
  "wohnadressen": [string],          // Wohnadresse(n) der Eigentümer, Format "Strasse Nr, PLZ Ort". Eine Adresse pro Eigentümer ODER eine gemeinsame, wenn nur eine angegeben ist.
  "flaeche_m2": number|null          // Quadratmeter falls aufgeführt
}

Wenn ein Feld nicht eindeutig erkennbar ist, setze null bzw. leeres Array. Korrigiere keine Namen — übernimm sie wörtlich aus dem Auszug.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Grundbuch-OCR',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Extrahiere die Felder aus diesem Grundbuchauszug.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      console.error('[Grundbuch-OCR] OpenRouter error', orRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})`, detail: errText.slice(0, 200) });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';

    // JSON aus dem Modell-Output extrahieren (defensiv: code-fences entfernen)
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();

    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[Grundbuch-OCR] JSON-Parse fehlgeschlagen:', jsonText.slice(0, 300));
      return res.status(502).json({ error: 'OCR-Antwort ist kein gültiges JSON', raw: content });
    }

    // Defensive Normalisierung
    const norm = {
      anteil_z: Number.isFinite(parsed.anteil_z) ? parsed.anteil_z : (parseInt(parsed.anteil_z) || null),
      eigentumsform: typeof parsed.eigentumsform === 'string' ? parsed.eigentumsform.trim() : null,
      eigentuemer: Array.isArray(parsed.eigentuemer) ? parsed.eigentuemer.map(s => String(s).trim()).filter(Boolean) : [],
      wohnadressen: Array.isArray(parsed.wohnadressen) ? parsed.wohnadressen.map(s => String(s).trim()).filter(Boolean) : [],
      flaeche_m2: Number.isFinite(parsed.flaeche_m2) ? parsed.flaeche_m2 : (parseInt(parsed.flaeche_m2) || null),
    };
    res.json({ ...norm, model: orJson.model, usage: orJson.usage });
  } catch (err) {
    console.error('[Grundbuch-OCR] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id — Daten + Bild speichern (multipart-base64)
// Body: { eigentumsform, eigentuemer:[], wohnadressen:[], anteil_z?, flaeche_m2?, notizen?, bild_base64?, bild_filename? }
app.post('/api/grundbuch/anteile/:parzelle/:sub_id', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const b = req.body || {};
    let bildPath = null;
    if (b.bild_base64 && b.bild_filename) {
      const ext = (b.bild_filename.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'pdf'].includes(ext)) return res.status(400).json({ error: 'Nur PNG/JPG/PDF erlaubt' });
      const buf = Buffer.from(b.bild_base64, 'base64');
      if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu gross (>10MB)' });
      const dir = pathModule.join(DOCS_PATH, GRUNDBUCH_BILDER_DIR);
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
      const az = b.anteil_z || (await pool.query('SELECT anteil_z FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s])).rows[0]?.anteil_z;
      const filename = `grundbuch_p${p}-${s}_${az || 'x'}-1000.${ext}`;
      const fullPath = pathModule.join(dir, filename);
      await fs.writeFile(fullPath, buf);
      bildPath = `${GRUNDBUCH_BILDER_DIR}/${filename}`;
    }
    const r = await pool.query(`
      UPDATE grundbuch_anteile
      SET eigentumsform = COALESCE($1, eigentumsform),
          eigentuemer = COALESCE($2::jsonb, eigentuemer),
          wohnadressen = COALESCE($3::jsonb, wohnadressen),
          flaeche_m2 = COALESCE($4, flaeche_m2),
          notizen = COALESCE($5, notizen),
          bild_path = COALESCE($6, bild_path),
          erfasst_von = $7, erfasst_am = now(),
          status = 'erfasst',
          reserviert_von = NULL, reserviert_am = NULL,
          updated_at = now()
      WHERE parzelle = $8 AND sub_id = $9
      RETURNING *`,
      [b.eigentumsform || null,
       b.eigentuemer ? JSON.stringify(b.eigentuemer) : null,
       b.wohnadressen ? JSON.stringify(b.wohnadressen) : null,
       b.flaeche_m2 || null, b.notizen || null,
       bildPath, me, p, s]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Anteil nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('grundbuch save err:', err.message);
    res.status(500).json({ error: 'Fehler', detail: err.message });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/verify — Ausschuss/Technik bestätigt
app.post('/api/grundbuch/anteile/:parzelle/:sub_id/verify', authMiddleware, async (req, res) => {
  if (!isAusschussOrTechnik(req)) return res.status(403).json({ error: 'Nur Ausschuss/Technik darf verifizieren' });
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const r = await pool.query(`
      UPDATE grundbuch_anteile SET status='freigegeben', verifiziert_von=$1, verifiziert_am=now(), updated_at=now()
      WHERE parzelle=$2 AND sub_id=$3 AND status='erfasst' RETURNING *`, [me, p, s]);
    if (r.rows.length === 0) return res.status(409).json({ error: 'Nur erfasste Anteile können verifiziert werden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/grundbuch/anteile/:parzelle/:sub_id/bild — Auszug-Bild ausliefern
app.get('/api/grundbuch/anteile/:parzelle/:sub_id/bild', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const r = await pool.query('SELECT bild_path FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s]);
    if (!r.rows[0]?.bild_path) return res.status(404).end();
    const fullPath = pathModule.join(DOCS_PATH, r.rows[0].bild_path);
    if (!fullPath.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    const ext = r.rows[0].bild_path.split('.').pop().toLowerCase();
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// ═══════════════════════════════════════════════════════════════════
// DOCUMENTS (local fileserver, NFS-mounted or local path)
// ═══════════════════════════════════════════════════════════════════

const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const IGNORED_FILES = new Set(['README.md', 'LICENSE', '.gitignore', '.gitkeep', '.gitattributes']);

/** Resolve user path safely within DOCS_PATH, returns null if path escapes */
function safeDocPath(userPath) {
  const resolved = pathModule.resolve(DOCS_PATH, userPath);
  if (!resolved.startsWith(pathModule.resolve(DOCS_PATH) + '/') && resolved !== pathModule.resolve(DOCS_PATH)) return null;
  return resolved;
}

/** Recursively walk directory and collect files.
 *  For empty subdirectories, emit a .gitkeep entry so the frontend can register them. */
async function walkDocs(dir, prefix = '') {
  const results = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip .recycle, .git-backup, etc.
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = pathModule.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subResults = await walkDocs(fullPath, relPath);
      if (subResults.length === 0) {
        // Empty directory: emit a .gitkeep so frontend registers the subfolder
        results.push({ path: `${relPath}/.gitkeep`, size: 0, url: `/api/documents/${relPath}/.gitkeep` });
      } else {
        results.push(...subResults);
      }
    } else {
      if (IGNORED_FILES.has(entry.name)) continue;
      try {
        const stat = await fs.stat(fullPath);
        results.push({ path: relPath, size: stat.size, url: `/api/documents/${relPath}` });
      } catch { /* skip unreadable files */ }
    }
  }
  return results;
}

// GET /api/documents - List available documents (filtered by user's STWEGs)
app.get('/api/documents', authMiddleware, async (req, res) => {
  try {
    const allDocs = await walkDocs(DOCS_PATH);
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
    if (!filePath || filePath.includes('..') || filePath.startsWith('/') || /[%\\]/.test(filePath) || /\0/.test(filePath)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const ext = filePath.split('.').pop().toLowerCase();
    if (!OFFICE_EXTS.has(ext)) {
      return res.status(400).json({ error: 'Dateityp wird nicht unterstützt' });
    }

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

    // Read from local filesystem
    const fullPath = safeDocPath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });
    const docBuffer = await fs.readFile(fullPath);

    // Send to Gotenberg for conversion
    const fileName = filePath.split('/').pop();
    const form = new FormData();
    form.append('files', new Blob([docBuffer]), fileName);

    const convertResp = await fetch(`${DOC_CONVERTER_URL}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!convertResp.ok) {
      const errText = await convertResp.text().catch(() => '');
      throw new Error(`Converter error ${convertResp.status}: ${errText}`);
    }

    const pdfBuffer = Buffer.from(await convertResp.arrayBuffer());

    // Cache the result (skip if too large — prevent OOM)
    if (pdfBuffer.length > 10 * 1024 * 1024) {
      // Don't cache files > 10MB, just serve directly
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(pdfBuffer);
    }
    previewCache.set(filePath, { pdf: pdfBuffer, expires: now + PREVIEW_CACHE_TTL });
    if (previewCache.size > 50) {
      for (const [k, v] of previewCache) {
        if (v.expires < now) previewCache.delete(k);
      }
      while (previewCache.size > 50) {
        let oldestKey = null, oldestExp = Infinity;
        for (const [k, v] of previewCache) {
          if (v.expires < oldestExp) { oldestKey = k; oldestExp = v.expires; }
        }
        if (oldestKey) previewCache.delete(oldestKey); else break;
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Dokument nicht gefunden' });
    console.error('Document preview error:', err.message);
    res.status(500).json({ error: 'Vorschau konnte nicht erstellt werden' });
  }
});

// GET /api/documents/:path(*) - Download a document
app.get('/api/documents/:path(*)', authMiddleware, async (req, res) => {
  try {
    const filePath = req.params.path;
    if (filePath.includes('..') || filePath.startsWith('/') || /[%\\]/.test(filePath) || /\0/.test(filePath)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const groups = req.user?.groups || [];
    if (!isDocPathAllowed(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Zugriff auf dieses Dokument' });
    }

    const fullPath = safeDocPath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    const stat = await fs.stat(fullPath);
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
      gif: 'image/gif',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      csv: 'text/csv',
      zip: 'application/zip',
    };
    const fileName = filePath.split('/').pop();

    const safeFileName = fileName.replace(/["\r\n\\]/g, '_');
    const safeAscii = safeFileName.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`);
    res.setHeader('Content-Length', stat.size);

    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Dokument nicht gefunden' });
    console.error('Document download error:', err.message);
    res.status(500).json({ error: 'Dokument konnte nicht geladen werden' });
  }
});

// POST /api/scan-upload - Upload scanned document via API key (for scan server)
const SCAN_API_KEY = process.env.SCAN_API_KEY || '';

app.post('/api/scan-upload', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!SCAN_API_KEY || apiKey !== SCAN_API_KEY) {
      return res.status(401).json({ error: 'Ungültiger API-Key' });
    }

    const fileName = req.headers['x-filename'];
    if (!fileName) {
      return res.status(400).json({ error: 'X-Filename Header fehlt' });
    }

    const cleanName = fileName
      .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .toLowerCase();

    const filePath = `Scans/${cleanName}`;
    const fullPath = safeDocPath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await fs.mkdir(pathModule.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, req.body);

    console.log(`[SCAN] Uploaded: ${filePath}`);
    res.json({ success: true, path: filePath });
  } catch (err) {
    console.error('[SCAN] Upload error:', err.message);
    res.status(500).json({ error: 'Scan-Upload fehlgeschlagen' });
  }
});

// POST /api/documents/folder - Create a subfolder
app.post('/api/documents/folder', authMiddleware, canManageDocs, async (req, res) => {
  try {
    const { parent, name } = req.body || {};
    if (!parent || !name) return res.status(400).json({ error: 'parent und name erforderlich' });
    if (parent.includes('..') || /[%\\]/.test(parent) || /\0/.test(parent)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    const safeName = name
      .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .toLowerCase();
    if (!safeName) return res.status(400).json({ error: 'Ungültiger Ordnername' });

    const folderPath = `${parent}/${safeName}`;
    const groups = req.user?.groups || [];
    if (!canWriteDocPath(folderPath + '/x', groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff' });
    }

    const fullPath = safeDocPath(folderPath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await fs.mkdir(fullPath, { recursive: true });
    res.json({ success: true, path: folderPath });
  } catch (err) {
    console.error('[DOCS] Create folder error:', err.message);
    res.status(500).json({ error: 'Ordner konnte nicht erstellt werden: ' + err.message });
  }
});

// PUT /api/documents/:path(*) - Upload/replace a document (admin only)
app.put('/api/documents/:path(*)', authMiddleware, canManageDocs, async (req, res) => {
  try {
    const rawPath = req.params.path;
    if (rawPath.includes('..') || rawPath.startsWith('/') || /[%\\]/.test(rawPath) || /\0/.test(rawPath)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    const parts = rawPath.split('/');
    const fileName = parts.pop()
      .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .toLowerCase();

    const ALLOWED_UPLOAD_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'dotx', 'zip', 'tiff', 'tif', 'bmp']);
    const uploadExt = fileName.split('.').pop();
    if (!uploadExt || !ALLOWED_UPLOAD_EXTS.has(uploadExt)) {
      return res.status(400).json({ error: `Dateityp .${uploadExt} nicht erlaubt` });
    }

    parts.push(fileName);
    const filePath = parts.join('/');

    const groups = req.user?.groups || [];
    if (!canWriteDocPath(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff auf diesen Ordner' });
    }

    const fullPath = safeDocPath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await fs.mkdir(pathModule.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, req.body);

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
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0') || filePath.includes('\\')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const groups = req.user?.groups || [];
    if (!canWriteDocPath(filePath, groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff auf diesen Ordner' });
    }

    const fullPath = safeDocPath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await fs.unlink(fullPath);
    previewCache.delete(filePath);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Dokument nicht gefunden' });
    console.error('Document delete error:', err.message);
    res.status(500).json({ error: 'Dokument konnte nicht gelöscht werden' });
  }
});

// POST /api/documents/move - Move a document to another folder
app.post('/api/documents/move', authMiddleware, canManageDocs, async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });
    if (from.includes('..') || to.includes('..') || from.startsWith('/') || to.startsWith('/') || from.includes('\0') || to.includes('\0') || from.includes('\\') || to.includes('\\')) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }

    const groups = req.user?.groups || [];
    if (!canWriteDocPath(from, groups) || !canWriteDocPath(to, groups)) {
      return res.status(403).json({ error: 'Kein Schreibzugriff' });
    }

    const fromPath = safeDocPath(from);
    const toPath = safeDocPath(to);
    if (!fromPath || !toPath) return res.status(400).json({ error: 'Ungültiger Pfad' });

    await fs.mkdir(pathModule.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);

    previewCache.delete(from);
    res.json({ success: true, from, to });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Quelldatei nicht gefunden' });
    console.error('Document move error:', err.message);
    res.status(500).json({ error: 'Verschieben fehlgeschlagen: ' + err.message });
  }
});

// ─── Proxmox VE Management ──────────────────────────────────────────

async function pveAPI(method, path, body = null) {
  if (!PVE_API_TOKEN) throw new Error('PVE_API_TOKEN nicht konfiguriert');
  const url = `${PVE_API_URL}/api2/json${path}`;
  const opts = {
    method,
    headers: { 'Authorization': `PVEAPIToken=${PVE_API_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PVE API ${res.status}: ${text}`);
  }
  return (await res.json()).data;
}

// List all VMs and CTs
app.get('/api/proxmox/resources', authMiddleware, adminOnly, async (req, res) => {
  try {
    const resources = await pveAPI('GET', '/cluster/resources?type=vm');
    const items = resources.map(r => ({
      vmid: r.vmid,
      name: r.name,
      type: r.type, // qemu or lxc
      status: r.status,
      node: r.node,
      id: r.id, // e.g. "qemu/100" or "lxc/201"
    }));
    items.sort((a, b) => a.vmid - b.vmid);
    res.json(items);
  } catch (err) {
    console.error('PVE resources error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List Proxmox users (authentik realm)
app.get('/api/proxmox/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const users = await pveAPI('GET', '/access/users');
    const filtered = users
      .filter(u => u.userid.endsWith('@authentik'))
      .map(u => ({ userid: u.userid, enable: u.enable }));
    res.json(filtered);
  } catch (err) {
    console.error('PVE users error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List ACLs
app.get('/api/proxmox/acl', authMiddleware, adminOnly, async (req, res) => {
  try {
    const acl = await pveAPI('GET', '/access/acl');
    // Only return ACLs for VMs/CTs (path starts with /vms/)
    const filtered = acl
      .filter(a => a.path.startsWith('/vms/'))
      .map(a => ({ path: a.path, ugid: a.ugid, roleid: a.roleid, type: a.type, propagate: a.propagate }));
    res.json(filtered);
  } catch (err) {
    console.error('PVE ACL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List available roles
app.get('/api/proxmox/roles', authMiddleware, adminOnly, async (req, res) => {
  try {
    const roles = await pveAPI('GET', '/access/roles');
    res.json(roles.map(r => ({ roleid: r.roleid })));
  } catch (err) {
    console.error('PVE roles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Set ACL (grant access)
app.put('/api/proxmox/acl', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { path, userid, roleid } = req.body;
    if (!path || !userid || !roleid) return res.status(400).json({ error: 'path, userid und roleid erforderlich' });
    // Validate path format: /vms/{vmid}
    if (!/^\/vms\/\d+$/.test(path)) return res.status(400).json({ error: 'Ungültiger Pfad (Format: /vms/{vmid})' });
    await pveAPI('PUT', '/access/acl', { path, users: userid, roles: roleid, propagate: 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error('PVE ACL set error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete ACL (revoke access)
app.delete('/api/proxmox/acl', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { path, userid, roleid } = req.body;
    if (!path || !userid || !roleid) return res.status(400).json({ error: 'path, userid und roleid erforderlich' });
    await pveAPI('PUT', '/access/acl', { path, users: userid, roles: roleid, delete: 1 });
    res.json({ ok: true });
  } catch (err) {
    console.error('PVE ACL delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ensure user exists in Proxmox (auto-create if needed)
app.post('/api/proxmox/ensure-user', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username erforderlich' });
    const userid = username.includes('@') ? username : `${username}@authentik`;
    // Check if user exists
    const users = await pveAPI('GET', '/access/users');
    const exists = users.some(u => u.userid === userid);
    if (!exists) {
      await pveAPI('POST', '/access/users', { userid, enable: 1 });
    }
    res.json({ userid, created: !exists });
  } catch (err) {
    console.error('PVE ensure-user error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Projects API ──────────────────────────────────────────────────

/** Middleware: require eigentuemer group */
function requireEigentuemer(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return next();
  if (groups.some(g => g.toLowerCase().includes('eigentuemer'))) return next();
  res.status(403).json({ error: 'Nur für Eigentümer' });
}

/** Middleware: require ausschuss or technik for editing */
function requireAusschussOrTechnik(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return next();
  if (isAusschussForAny(groups)) return next();
  res.status(403).json({ error: 'Nur für Ausschuss/Technik' });
}

// ─── Email-Log (Admin-UI) ───────────────────────────────────────────
// GET /api/email-log — letzte 500 Versand-Einträge mit Filter
// GET /api/telefonbuch — Internes Adressbuch fuer alle eingeloggten User
// Zeigt alle Kontakte aus wohnungen_kontakte mit Telefon/Email,
// gruppiert pro Person (Name als Schluessel), aggregiert ueber alle
// Wohnungen die ihnen gehoeren/in denen sie wohnen.
app.get('/api/telefonbuch', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT k.name, k.email, k.telefon, k.rolle,
             w.id AS wohnung_id, w.stweg, w.bezeichnung, w.typ
      FROM wohnungen_kontakte k
      JOIN wohnungen w ON w.id = k.wohnung_id
      WHERE k.name IS NOT NULL AND TRIM(k.name) <> ''
      ORDER BY k.name
    `);
    // Drucker-Tags filtern, pro Name aggregieren
    const byName = new Map();
    for (const r of rows) {
      const name = r.name.trim();
      const isDeceased = /\(verstorben\)/i.test(name);
      const cleanName = name.replace(/\s*\(verstorben\)\s*/i, '').trim();
      const isDruckerTag = r.email && (r.email.startsWith('druckerr9+') || r.email.startsWith('druckerr13+'));
      if (!byName.has(cleanName)) {
        byName.set(cleanName, {
          name: cleanName,
          deceased: isDeceased,
          email: null,
          telefon: null,
          rollen: new Set(),
          wohnungen: [],
        });
      }
      const e = byName.get(cleanName);
      // Bevorzuge Nicht-Drucker-Email
      if (!isDruckerTag && r.email && !e.email) e.email = r.email.trim();
      if (r.telefon && !e.telefon) e.telefon = r.telefon.trim();
      if (r.rolle) e.rollen.add(r.rolle);
      e.wohnungen.push({
        wohnung_id: r.wohnung_id,
        stweg: r.stweg,
        bezeichnung: r.bezeichnung,
        typ: r.typ,
        rolle: r.rolle,
      });
      if (isDeceased) e.deceased = true;
    }
    // Set → Array fuer JSON
    for (const e of byName.values()) e.rollen = [...e.rollen];
    // Sortierung nach Nachname (letztes Wort), dann Vorname
    const lastName = n => (n || '').trim().split(/\s+/).pop() || '';
    const list = [...byName.values()].sort((a, b) => {
      const c = lastName(a.name).localeCompare(lastName(b.name), 'de');
      return c !== 0 ? c : a.name.localeCompare(b.name, 'de');
    });
    res.json({ contacts: list, count: list.length });
  } catch (err) {
    console.error('[telefonbuch] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email-log', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.trigger) { params.push(req.query.trigger); where.push(`trigger = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(subject ILIKE $${params.length} OR to_addresses ILIKE $${params.length} OR from_email ILIKE $${params.length})`);
    }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.since) { params.push(req.query.since); where.push(`created_at >= $${params.length}`); }
    const sql = `
      SELECT id, created_at, trigger, from_email, from_name, subject, to_addresses,
             recipients_count, has_attachments, status, message_id, error_message, verteiler_id
      FROM email_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT 500
    `;
    const { rows } = await pool.query(sql, params);
    // Zusätzlich: Liste aller bekannten Trigger für Filter-Dropdown
    const { rows: triggers } = await pool.query(
      `SELECT trigger, COUNT(*) AS cnt FROM email_log WHERE trigger IS NOT NULL
       AND created_at > NOW() - INTERVAL '90 days'
       GROUP BY trigger ORDER BY cnt DESC`
    );
    res.json({ entries: rows, triggers });
  } catch (err) {
    console.error('[email-log] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Public Project Access ──────────────────────────────────────────
// GET /api/public/project/:slug — view project without login (only if public_access = true)
app.get('/api/public/project/:slug', async (req, res) => {
  try {
    const { rows: [project] } = await pool.query(
      'SELECT id, slug, title, description, status, public_access FROM projects WHERE slug = $1 AND public_access = true',
      [req.params.slug]
    );
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden oder nicht öffentlich' });

    // Filter sensitive fields: omit notizen, comments, kontakt-details
    const [candidates, timeline, attachments] = await Promise.all([
      pool.query(`SELECT id, name, webseite, offerte_betrag, offerte_details, bewertung, status FROM project_candidates WHERE project_id = $1 ORDER BY sort_order, name`, [project.id]),
      pool.query('SELECT id, datum, titel, beschreibung, erledigt FROM project_timeline WHERE project_id = $1 ORDER BY datum', [project.id]),
      pool.query('SELECT id, target_type, target_id, doc_path FROM project_attachments WHERE project_slug = $1 ORDER BY created_at', [req.params.slug]),
    ]);
    res.json({ ...project, candidates: candidates.rows, timeline: timeline.rows, attachments: attachments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/public/project/:slug/document/* — serve attached documents publicly if project is public
app.get('/api/public/project/:slug/document/:path(*)', async (req, res) => {
  try {
    const { rows: [project] } = await pool.query(
      'SELECT id FROM projects WHERE slug = $1 AND public_access = true', [req.params.slug]
    );
    if (!project) return res.status(404).json({ error: 'Projekt nicht öffentlich' });

    // Verify the requested document is actually attached to this project
    const { rows: atts } = await pool.query(
      'SELECT doc_path FROM project_attachments WHERE project_slug = $1 AND doc_path = $2',
      [req.params.slug, req.params.path]
    );
    if (atts.length === 0) return res.status(404).json({ error: 'Dokument nicht gefunden' });

    const fullPath = pathModule.join(DOCS_PATH, req.params.path);
    if (!fullPath.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();

    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return res.status(404).end();

    const ext = req.params.path.split('.').pop().toLowerCase();
    const contentTypes = {
      pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const fileName = req.params.path.split('/').pop().replace(/["\r\n\\]/g, '_');
    // RFC 5987: filename* for non-ASCII (UTF-8 percent-encoded), filename= as ASCII fallback
    const fileNameAscii = fileName.replace(/[^\x20-\x7E]/g, '_');
    const fileNameStar = encodeURIComponent(fileName);
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${fileNameAscii}"; filename*=UTF-8''${fileNameStar}`);
    res.setHeader('Content-Length', stat.size);
    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Dokument nicht gefunden' });
    console.error('[public-doc] error:', err.message, 'path:', req.params.path);
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/projects/:slug/public — toggle public access (admin only)
app.put('/api/projects/:slug/public', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { public_access } = req.body;
    const { rows: [row] } = await pool.query(
      'UPDATE projects SET public_access = $1 WHERE slug = $2 RETURNING slug, public_access',
      [!!public_access, req.params.slug]
    );
    if (!row) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/projects - List projects
app.get('/api/projects', authMiddleware, requireEigentuemer, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:slug - Get project with all data
app.get('/api/projects/:slug', authMiddleware, requireEigentuemer, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT * FROM projects WHERE slug = $1', [req.params.slug]);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const [candidates, timeline, comments, attachments] = await Promise.all([
      pool.query('SELECT * FROM project_candidates WHERE project_id = $1 ORDER BY sort_order, name', [project.id]),
      pool.query('SELECT * FROM project_timeline WHERE project_id = $1 ORDER BY datum', [project.id]),
      pool.query('SELECT * FROM project_comments WHERE project_id = $1 ORDER BY created_at DESC', [project.id]),
      pool.query('SELECT * FROM project_attachments WHERE project_slug = $1 ORDER BY created_at', [req.params.slug]),
    ]);
    res.json({ ...project, candidates: candidates.rows, timeline: timeline.rows, comments: comments.rows, attachments: attachments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:slug/candidates - Add candidate
app.post('/api/projects/:slug/candidates', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT id FROM projects WHERE slug = $1', [req.params.slug]);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { name, kontakt, telefon, email, webseite, offerte_betrag, offerte_details, bewertung, status, notizen } = req.body;
    const { rows: [row] } = await pool.query(
      `INSERT INTO project_candidates (project_id, name, kontakt, telefon, email, webseite, offerte_betrag, offerte_details, bewertung, status, notizen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [project.id, name, kontakt, telefon, email, webseite, offerte_betrag, offerte_details, bewertung || null, status || 'angefragt', notizen]);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:slug/candidates/:id - Update candidate
app.put('/api/projects/:slug/candidates/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { name, kontakt, telefon, email, webseite, offerte_betrag, offerte_details, bewertung, status, notizen } = req.body;
    const { rows: [row] } = await pool.query(
      `UPDATE project_candidates SET name=$1, kontakt=$2, telefon=$3, email=$4, webseite=$5, offerte_betrag=$6, offerte_details=$7, bewertung=$8, status=$9, notizen=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [name, kontakt, telefon, email, webseite, offerte_betrag, offerte_details, bewertung || null, status, notizen, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Kandidat nicht gefunden' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:slug/candidates/:id
app.delete('/api/projects/:slug/candidates/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM project_candidates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:slug/timeline - Add timeline entry
app.post('/api/projects/:slug/timeline', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT id FROM projects WHERE slug = $1', [req.params.slug]);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { datum, titel, beschreibung, erledigt } = req.body;
    const { rows: [row] } = await pool.query(
      'INSERT INTO project_timeline (project_id, datum, titel, beschreibung, erledigt) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [project.id, datum, titel, beschreibung, erledigt || false]);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:slug/timeline/:id
app.put('/api/projects/:slug/timeline/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { datum, titel, beschreibung, erledigt } = req.body;
    const { rows: [row] } = await pool.query(
      'UPDATE project_timeline SET datum=$1, titel=$2, beschreibung=$3, erledigt=$4 WHERE id=$5 RETURNING *',
      [datum, titel, beschreibung, erledigt, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:slug/timeline/:id
app.delete('/api/projects/:slug/timeline/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM project_timeline WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:slug/comments - Any eigentuemer can comment
app.post('/api/projects/:slug/comments', authMiddleware, requireEigentuemer, async (req, res) => {
  try {
    const { rows: [project] } = await pool.query('SELECT id FROM projects WHERE slug = $1', [req.params.slug]);
    if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Text erforderlich' });
    const { rows: [row] } = await pool.query(
      'INSERT INTO project_comments (project_id, user_name, user_email, text) VALUES ($1,$2,$3,$4) RETURNING *',
      [project.id, req.user.name, req.user.email, text.trim()]);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:slug/comments/:id - Ausschuss/Technik can delete
app.delete('/api/projects/:slug/comments/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM project_comments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:slug/attachments - Link existing doc to timeline/candidate
app.post('/api/projects/:slug/attachments', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { target_type, target_id, doc_path } = req.body;
    if (!['timeline', 'kandidaten'].includes(target_type)) return res.status(400).json({ error: 'Ungültiger Typ' });
    if (!target_id || !doc_path) return res.status(400).json({ error: 'target_id und doc_path erforderlich' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO project_attachments (project_slug, target_type, target_id, doc_path)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
      [req.params.slug, target_type, target_id, doc_path]);
    res.json(row || { already_linked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:slug/attachments/:id - Unlink doc
app.delete('/api/projects/:slug/attachments/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM project_attachments WHERE id = $1 AND project_slug = $2', [req.params.id, req.params.slug]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

      ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);

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
        stweg INTEGER,
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
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS trigger VARCHAR(80);
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS to_addresses TEXT;
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_message TEXT;
      CREATE INDEX IF NOT EXISTS idx_email_log_trigger ON email_log (trigger, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log (created_at DESC);

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

      -- Waschkueche: stweg column for per-STWEG rooms
      ALTER TABLE wasch_rooms ADD COLUMN IF NOT EXISTS stweg INTEGER;
      -- Migrate existing rooms to STWEG 3 (original installation)
      UPDATE wasch_rooms SET stweg = 3 WHERE stweg IS NULL;

      -- Projects: public access flag (allows non-logged-in viewing of project)
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_access BOOLEAN DEFAULT false;
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_token VARCHAR(64);

      -- STWEG calendar events
      CREATE TABLE IF NOT EXISTS stweg_events (
        id SERIAL PRIMARY KEY,
        stweg INTEGER NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP,
        all_day BOOLEAN DEFAULT false,
        location VARCHAR(255),
        category VARCHAR(50) DEFAULT 'sonstiges',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

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

    // Pending Authentik user deletions (30-day grace period)
    await client.query(`
      CREATE TABLE IF NOT EXISTS authentik_pending_deletions (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255),
        stweg INTEGER,
        scheduled_at TIMESTAMP NOT NULL,
        reminder_sent BOOLEAN DEFAULT false,
        cancelled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_attachments (
        id SERIAL PRIMARY KEY,
        project_slug VARCHAR(100) NOT NULL,
        target_type VARCHAR(20) NOT NULL CHECK(target_type IN ('timeline', 'kandidaten')),
        target_id INTEGER NOT NULL,
        doc_path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(project_slug, target_type, target_id, doc_path)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_archive (
        id SERIAL PRIMARY KEY,
        from_email VARCHAR(255) NOT NULL,
        from_name VARCHAR(255),
        to_addresses TEXT,
        subject TEXT,
        text_body TEXT,
        html_body TEXT,
        attachments JSONB DEFAULT '[]',
        message_id VARCHAR(500) UNIQUE,
        email_date TIMESTAMP,
        deletion_status VARCHAR(20) DEFAULT 'active' CHECK(deletion_status IN ('active', 'pending', 'deleted')),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_archive_date ON email_archive(created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_archive_deletions (
        id SERIAL PRIMARY KEY,
        archive_id INTEGER NOT NULL REFERENCES email_archive(id) ON DELETE CASCADE,
        requested_by VARCHAR(255) NOT NULL,
        requested_at TIMESTAMP DEFAULT NOW(),
        reason TEXT NOT NULL,
        confirmed_by VARCHAR(255),
        confirmed_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'rejected')),
        CONSTRAINT four_eyes CHECK (confirmed_by IS NULL OR confirmed_by != requested_by)
      );
    `);

    // Connection log for FPÜV compliance (6 months retention)
    await client.query(`
      CREATE TABLE IF NOT EXISTS connection_log (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_type VARCHAR(20) NOT NULL,
        source VARCHAR(10) NOT NULL,
        mac VARCHAR(17),
        ip VARCHAR(45),
        hostname VARCHAR(255),
        network_name VARCHAR(100),
        vlan INT,
        ap_name VARCHAR(100),
        ap_mac VARCHAR(17),
        is_wired BOOLEAN DEFAULT FALSE,
        signal_dbm INT,
        rx_bytes BIGINT,
        tx_bytes BIGINT,
        dst_ip VARCHAR(45),
        dst_port INT,
        src_port INT,
        proto VARCHAR(10),
        raw_message TEXT
      );
      -- Add new columns if table already exists (before creating indexes)
      ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS dst_ip VARCHAR(45);
      ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS dst_port INT;
      ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS src_port INT;
      ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS proto VARCHAR(10);
      ALTER TABLE connection_log ADD COLUMN IF NOT EXISTS raw_message TEXT;
      CREATE INDEX IF NOT EXISTS idx_connlog_timestamp ON connection_log(timestamp);

      -- Print jobs for pickup confirmation
      CREATE TABLE IF NOT EXISTS print_jobs (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) UNIQUE NOT NULL,
        printer VARCHAR(50) NOT NULL,
        recipient_name VARCHAR(255),
        recipient_address VARCHAR(255),
        recipient_wohnung VARCHAR(255),
        recipient_stweg INT,
        sender_email VARCHAR(255),
        subject TEXT,
        documents INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'printed',
        picked_up_at TIMESTAMPTZ,
        picked_up_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_print_jobs_token ON print_jobs(token);
      ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_print_jobs_open ON print_jobs (created_at DESC) WHERE picked_up_at IS NULL AND status = 'printed';
      CREATE INDEX IF NOT EXISTS idx_connlog_mac ON connection_log(mac);
      CREATE INDEX IF NOT EXISTS idx_connlog_network ON connection_log(network_name);
      CREATE INDEX IF NOT EXISTS idx_connlog_ip ON connection_log(ip);
      CREATE INDEX IF NOT EXISTS idx_connlog_dst ON connection_log(dst_ip);
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

    // Seed wohnungsverwaltung and email-archiv permissions for all Ausschuss groups
    const ausschussGroups = Object.values(STWEG_GROUPS).map(g => g.ausschuss).filter(Boolean);
    for (const groupName of ausschussGroups) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'wohnungsverwaltung', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'email-archiv', 'read')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }

    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

// Cleanup expired sessions and OTP codes periodically
async function cleanupExpiredSessions() {
  try {
    const sessions = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    const otps = await pool.query('DELETE FROM otp_codes WHERE expires_at < NOW()');
    if (sessions.rowCount > 0 || otps.rowCount > 0) {
      console.log(`Cleanup: ${sessions.rowCount} expired sessions, ${otps.rowCount} expired OTPs removed`);
    }
    // Cleanup connection_log older than 6 months
    const connCleanup = await pool.query("DELETE FROM connection_log WHERE timestamp < NOW() - INTERVAL '6 months'");
    if (connCleanup.rowCount > 0) {
      console.log(`Cleanup: ${connCleanup.rowCount} old connection_log entries removed`);
    }
  } catch (err) {
    console.error('Session cleanup error:', err.message);
  }
}

// ─── FPÜV Connection Polling ─────────────────────────────────────────
const CONN_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Track last-seen MACs to detect connect/disconnect
let lastSeenMacs = new Set();
let connPollFirstRun = true;
let connPolling = false;

async function pollConnections() {
  if (connPolling) return;
  connPolling = true;
  try {
    const resp = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/stat/sta`, {
      headers: { 'X-API-Key': UNIFI_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const clients = data.data || [];

    // Get network name mapping
    const netResp = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/rest/networkconf`, {
      headers: { 'X-API-Key': UNIFI_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    const nets = (await netResp.json()).data || [];
    const netMap = {};
    for (const n of nets) netMap[n._id] = { name: n.name, vlan: n.vlan || null };

    const currentMacs = new Set();
    const values = [];
    const params = [];
    let idx = 1;

    for (const c of clients) {
      const mac = c.mac;
      currentMacs.add(mac);
      const net = netMap[c.network_id] || {};
      // First run: all clients are "snapshot" (already connected before restart)
      const isNew = !connPollFirstRun && !lastSeenMacs.has(mac);

      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        isNew ? 'connect' : 'snapshot', 'poll',
        mac, c.ip || null, c.hostname || c.name || null,
        net.name || c.network || null, net.vlan || null,
        c.ap_name || null, c.ap_mac || null,
        !!c.is_wired, c.rssi || null,
        c.rx_bytes || null, c.tx_bytes || null
      );
    }

    // Detect disconnects
    for (const mac of lastSeenMacs) {
      if (!currentMacs.has(mac)) {
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push('disconnect', 'poll', mac, null, null, null, null, null, null, false, null, null, null);
      }
    }

    if (values.length > 0) {
      await pool.query(
        `INSERT INTO connection_log (event_type, source, mac, ip, hostname, network_name, vlan, ap_name, ap_mac, is_wired, signal_dbm, rx_bytes, tx_bytes)
         VALUES ${values.join(',')}`,
        params
      );
    }

    lastSeenMacs = currentMacs;
    connPollFirstRun = false;
  } catch (err) {
    console.error('[ConnPoll] Error:', err.message);
  } finally {
    connPolling = false;
  }
}

function startConnectionPolling() {
  if (!UNIFI_API_KEY) {
    console.log('[ConnPoll] No UniFi API key, polling disabled');
    return;
  }
  console.log(`[ConnPoll] Polling UniFi every ${CONN_POLL_INTERVAL / 1000}s`);
  setTimeout(pollConnections, 10000); // first poll after 10s
  activeIntervals.push(setInterval(pollConnections, CONN_POLL_INTERVAL));
}

// ─── Connection Log API ──────────────────────────────────────────────
app.get('/api/connections', authMiddleware, adminOnly, async (req, res) => {
  const { mac, network, from, to, limit: lim } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (mac) { conditions.push(`mac ILIKE $${idx++}`); params.push(`%${mac}%`); }
  if (network) { conditions.push(`network_name = $${idx++}`); params.push(network); }
  if (from) { conditions.push(`timestamp >= $${idx++}`); params.push(from); }
  if (to) { conditions.push(`timestamp <= $${idx++}`); params.push(to); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = Math.min(parseInt(lim) || 1000, 10000);

  try {
    const result = await pool.query(
      `SELECT * FROM connection_log ${where} ORDER BY timestamp DESC LIMIT $${idx}`,
      [...params, limit]
    );
    res.json({ total: result.rowCount, entries: result.rows });
  } catch (err) {
    console.error('Connection log error:', err);
    res.status(500).json({ error: 'Verbindungsdaten konnten nicht geladen werden' });
  }
});

// Connection log stats
app.get('/api/connections/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [total, networks, recent] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM connection_log'),
      pool.query(`SELECT network_name, COUNT(DISTINCT mac) as clients, COUNT(*) as events
                  FROM connection_log WHERE timestamp > NOW() - INTERVAL '24 hours'
                  GROUP BY network_name ORDER BY clients DESC`),
      pool.query(`SELECT COUNT(DISTINCT mac) as active FROM connection_log
                  WHERE event_type != 'disconnect' AND timestamp > NOW() - INTERVAL '10 minutes'`),
    ]);
    res.json({
      totalEntries: parseInt(total.rows[0].count),
      activeClients: parseInt(recent.rows[0].active),
      last24h: networks.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track intervals and server for graceful shutdown
let server;
const activeIntervals = [];

initDB()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`Rosenweg API running on port ${PORT}`);
      // Start Waschküche cron jobs
      startWaschCron();
      // Start IMAP polling for verteiler emails
      startImapPoll();
      // Start connection logging (FPÜV)
      startConnectionPolling();
      // Cleanup expired sessions every hour
      activeIntervals.push(setInterval(cleanupExpiredSessions, 60 * 60 * 1000));
      setTimeout(cleanupExpiredSessions, 30 * 1000); // first cleanup after 30s
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Graceful shutdown
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new requests
  if (server) server.close(() => console.log('HTTP server closed'));

  // Clear all intervals
  activeIntervals.forEach(id => clearInterval(id));
  if (deletionInterval) clearInterval(deletionInterval);

  // Close database pools
  try {
    await pool.end();
    await energyPool.end();
    console.log('Database pools closed');
  } catch (err) {
    console.error('Error closing database pools:', err.message);
  }

  // Force exit after 10s
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Prevent crashes from unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
});
