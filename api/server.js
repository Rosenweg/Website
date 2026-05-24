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
app.use('/api/vollmachten/:id/upload-signed', express.raw({ type: 'application/pdf', limit: '20mb' }));
// PBX-Voicemail-Upload: Asterisk-AGI laedt das WAV als Raw-Body hoch
app.use('/api/pbx/voicemail', express.raw({ type: 'audio/wav', limit: '50mb' }));
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

// ─── Audit-Kontext: AsyncLocalStorage haelt die User-Email pro Request ──
// Trigger audit_trigger_fn() liest current_setting('app.user_email').
// Wir wrappen pool.query: bei MUTATIONEN (INSERT/UPDATE/DELETE) wird ein
// Client gecheckt, in einer Transaction "SET LOCAL app.user_email" gesetzt
// und die Query darin ausgefuehrt. Reads bleiben unveraendert (Performance).
const { AsyncLocalStorage } = require('async_hooks');
const auditCtx = new AsyncLocalStorage();
const _origPoolQuery = pool.query.bind(pool);
const isMutation = (sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(typeof sql === 'string' ? sql : sql?.text || '');
pool.query = async function (sqlOrCfg, params) {
  const userEmail = auditCtx.getStore()?.userEmail;
  const sqlStr = typeof sqlOrCfg === 'string' ? sqlOrCfg : sqlOrCfg?.text || '';
  if (!userEmail || !isMutation(sqlStr)) return _origPoolQuery(sqlOrCfg, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_email', $1, true)`, [userEmail]);
    const r = await client.query(sqlOrCfg, params);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
};

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
      `INSERT INTO email_log (trigger, from_email, from_name, subject, to_addresses, recipients_count, has_attachments, status, message_id, error_message, verteiler_id, recipients_list, parent_message_id, parent_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        trigger, fromEmail, fromName, mailOpts.subject || null, toAddresses, recipientsCount,
        Array.isArray(mailOpts.attachments) && mailOpts.attachments.length > 0,
        error ? 'failed' : 'sent',
        result?.messageId || null,
        error ? String(error.message || error).slice(0, 1000) : null,
        extra.verteiler_id || null,
        extra.recipients_list || null,
        extra.parent_message_id || null,
        extra.parent_source || null,
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

// Generischer Rate-Limit-Helper fuer beliebige Endpoints.
// Verwendung: rateLimitGuard(name, key, maxCount, windowMs) → {ok:true|false, retryAfter?}
const rateLimitBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitBuckets) {
    if (now - v.first > v.windowMs) rateLimitBuckets.delete(k);
  }
}, 5 * 60 * 1000);

function rateLimitGuard(name, key, maxCount, windowMs) {
  const bucketKey = `${name}:${key}`;
  const now = Date.now();
  const entry = rateLimitBuckets.get(bucketKey);
  if (entry && now - entry.first < windowMs) {
    if (entry.count >= maxCount) {
      return { ok: false, retryAfter: Math.ceil((windowMs - (now - entry.first)) / 1000) };
    }
    entry.count++;
    return { ok: true };
  }
  rateLimitBuckets.set(bucketKey, { first: now, count: 1, windowMs });
  return { ok: true };
}

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

// History-Zugriff: Technik / Präsident / Ausschuss / Verwaltung-Mitglieder
function canViewKontakteHistory(req, res, next) {
  const groups = req.user?.groups || [];
  const ok = groups.some(g => {
    const gl = g.toLowerCase();
    return gl === 'technik' || gl === 'präsident' || gl === 'praesident'
      || gl === 'verwaltung' || gl.endsWith('-ausschuss');
  });
  if (!ok) return res.status(403).json({ error: 'Historie nur fuer Technik, Praesident, Ausschuss und Verwaltung' });
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
// Sanftes Telefon-Normalisieren: 079 X → +41 79 X X X, 00CC… → +CC…, sonst belassen.
// Mischformate (mit Buchstaben/Doppelpunkten) werden nicht angefasst.
function normalizePhone(val) {
  if (!val) return null;
  let s = String(val).trim();
  if (!s) return null;
  if (/[a-zA-ZäöüÄÖÜ:]/.test(s)) return s;
  s = s.replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('0') && !s.startsWith('00')) s = '+41' + s.slice(1);
  if (s.startsWith('41') && !s.startsWith('+')) s = '+' + s;
  const ch = s.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
  if (ch) return `+41 ${ch[1]} ${ch[2]} ${ch[3]} ${ch[4]}`;
  const intl = s.match(/^\+(\d{1,3})(\d+)$/);
  if (intl) return `+${intl[1]} ${intl[2].replace(/(\d{3})(?=\d)/g, '$1 ')}`;
  return s;
}

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
  { id: 'handwerker', label: 'Handwerker & Lieferanten' },
  { id: 'auslagen', label: 'Auslagen / Vorschuesse' },
  { id: 'verwaltung-mail-outbox', label: 'Verwaltungs-Mail Outbox' },
  { id: 'personen', label: 'Personen (Eigentuemer/Bewohner)' },
  { id: 'mail-empfaenger', label: 'Mail-Empfaenger (Stammdaten)' },
  { id: 'mail-compose', label: 'Mail schreiben (Ad-hoc)' },
  { id: 'mail-approval-config', label: 'Mail-Freigabe-Regeln' },
  { id: 'mail-templates', label: 'Mail-Templates' },
  { id: 'auslagen-stundensatz', label: 'Auslagen-Stundensatz' },
  { id: 'whatsapp-bot', label: 'WhatsApp-Bot' },
  { id: 'reklamationen', label: 'Reklamationen' },
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

  // WhatsApp-Opt-In aus personen-Tabelle (via email lookup)
  let whatsappOptIn = false;
  try {
    const pRes = await pool.query(
      `SELECT whatsapp_opt_in FROM personen WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [u.email || '']
    );
    whatsappOptIn = !!pRes.rows[0]?.whatsapp_opt_in;
  } catch { /* personen table may not exist yet */ }

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
      whatsapp_opt_in: whatsappOptIn,
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
// Wenn der Kontakt eine person_id hat, wird die Person aktualisiert → Trigger
// propagiert auf alle Wohnungen der Person. Dadurch ist die Aenderung "sticky"
// fuer den User: er sieht sie ueberall.
app.put('/api/me/kontakt/:id', authMiddleware, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const name = req.user.name || '';
    const own = await pool.query(
      `SELECT id, name, email, person_id, wohnung_id FROM wohnungen_kontakte
        WHERE id = $1 AND (LOWER(email) = $2 OR LOWER(name) = LOWER($3))`,
      [req.params.id, email, name]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Du kannst nur deine eigenen Kontaktdaten bearbeiten' });
    const cur = own.rows[0];

    const { email: newEmail, telefon, adresse } = req.body;
    if (newEmail && newEmail.toLowerCase() !== email && newEmail.toLowerCase() !== (cur.email || '').toLowerCase()) {
      // Konfliktcheck nur gegen andere Personen, nicht gegen Family-Sharing
      const conflict = await pool.query(
        `SELECT k.id FROM wohnungen_kontakte k
          WHERE LOWER(k.email) = $1 AND k.id != $2
            AND (k.person_id IS NULL OR k.person_id != $3)`,
        [newEmail.toLowerCase(), req.params.id, cur.person_id || -1]
      );
      if (conflict.rows.length > 0) return res.status(400).json({ error: 'Email wird bereits von einer anderen Person verwendet' });
    }

    if (cur.person_id) {
      // Sauberer Pfad: Person aktualisieren → Trigger propagiert auf alle Wohnungen
      const updates = [];
      const params = [];
      if (newEmail !== undefined) { params.push(newEmail || null); updates.push(`email = $${params.length}`); }
      if (telefon !== undefined)  { params.push(normalizePhone(telefon));  updates.push(`telefon = $${params.length}`); }
      if (adresse !== undefined)  { params.push(adresse || null);  updates.push(`adresse = $${params.length}`); }
      if (updates.length > 0) {
        params.push(cur.person_id);
        await pool.query(`UPDATE personen SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
      }
    } else {
      // Legacy: keine person_id → direkt Kontakt aktualisieren
      await pool.query(
        `UPDATE wohnungen_kontakte SET email = COALESCE($1, email), telefon = COALESCE($2, telefon), adresse = COALESCE($3, adresse)
          WHERE id = $4`,
        [newEmail || null, normalizePhone(telefon), adresse || null, req.params.id]
      );
    }
    const r = await pool.query(`SELECT id, name, email, telefon, adresse, wohnung_id, person_id FROM wohnungen_kontakte WHERE id = $1`, [req.params.id]);
    res.json(r.rows[0]);
    // Verwaltung informieren — pro betroffenem STWEG einmal
    try {
      const wRes = cur.person_id
        ? await pool.query(
            `SELECT DISTINCT w.stweg, w.bezeichnung FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
              WHERE k.person_id = $1 AND k.archiviert_am IS NULL`, [cur.person_id])
        : await pool.query(`SELECT stweg, bezeichnung FROM wohnungen WHERE id = $1`, [cur.wohnung_id]);
      const changes = [];
      if (newEmail !== undefined) changes.push('E-Mail → ' + (newEmail || '∅'));
      if (telefon !== undefined) changes.push('Tel → ' + (telefon || '∅'));
      if (adresse !== undefined) changes.push('Adresse → ' + String(adresse || '∅').slice(0, 80));
      if (changes.length > 0) {
        const where = wRes.rows.length === 1
          ? wRes.rows[0].bezeichnung
          : `${wRes.rows.length} Wohnungen der Person`;
        for (const row of wRes.rows) {
          recordObjektChange(row.stweg, `${cur.name} (${where}) hat Kontaktdaten aktualisiert: ${changes.join(', ')}`, req.user.email).catch(() => {});
        }
      }
    } catch {}
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
    recordObjektChange(stweg, `Eigentuemer-Self-Service: Wohnung "${w.bezeichnung}" aktualisiert`, req.user.email).catch(() => {});
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

// GET /api/me/person-data — liefert das personen-Datenset des eingeloggten Users
// (zusaetzliche Telefonnummern + Email-Aliasse, die nicht in users gepflegt sind)
app.get('/api/me/person-data', authMiddleware, async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.json({ found: false, telefone: [], emails: [] });
  try {
    const r = await pool.query(
      `SELECT id, name, email, telefon, mobile, telefone, emails, whatsapp_opt_in
         FROM personen
        WHERE LOWER(email) = $1
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(emails,'[]'::jsonb)) e WHERE LOWER(e) = $1)
        LIMIT 1`,
      [email],
    );
    if (!r.rows[0]) return res.json({ found: false, telefone: [], emails: [] });
    const p = r.rows[0];
    res.json({
      found: true,
      person_id: p.id,
      person_name: p.name,
      person_email: p.email,
      primary_phone: p.mobile || p.telefon || null,
      telefone: Array.isArray(p.telefone) ? p.telefone : [],
      emails: Array.isArray(p.emails) ? p.emails : [],
      whatsapp_opt_in: !!p.whatsapp_opt_in,
    });
  } catch (err) {
    console.error('[me/person-data] error:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// PUT /api/me/phones — Zusatznummern (telefone JSONB) verwalten
// Body: { telefone: [{ typ, label?, nummer, whatsapp? }, ...] }
app.put('/api/me/phones', authMiddleware, async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'Keine E-Mail' });
  const raw = Array.isArray(req.body?.telefone) ? req.body.telefone : [];
  // Validierung + Normalisierung
  const cleaned = [];
  for (const t of raw.slice(0, 10)) {
    const nummer = String(t?.nummer || '').trim();
    if (!nummer) continue;
    cleaned.push({
      typ: String(t?.typ || 'sonstige').slice(0, 30),
      label: t?.label ? String(t.label).slice(0, 50) : undefined,
      nummer,
      whatsapp: !!t?.whatsapp,
    });
  }
  try {
    const r = await pool.query(
      `UPDATE personen SET telefone = $1::jsonb, updated_at = NOW()
         WHERE LOWER(email) = $2
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(emails,'[]'::jsonb)) e WHERE LOWER(e) = $2)
      RETURNING id, telefone`,
      [JSON.stringify(cleaned), email],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Kein personen-Eintrag fuer diese E-Mail' });
    res.json({ ok: true, telefone: r.rows[0].telefone });
  } catch (err) {
    console.error('[me/phones] error:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// PUT /api/me/emails — Email-Aliasse verwalten (emails JSONB)
// Body: { emails: ["alias1@x.com", ...] }
app.put('/api/me/emails', authMiddleware, async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'Keine E-Mail' });
  const raw = Array.isArray(req.body?.emails) ? req.body.emails : [];
  // Validierung: nur korrekt aussehende Emails behalten
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const cleaned = [];
  for (const e of raw.slice(0, 10)) {
    const s = String(e || '').trim().toLowerCase();
    if (!s || !emailRe.test(s)) continue;
    if (cleaned.includes(s)) continue;
    cleaned.push(s);
  }
  try {
    const r = await pool.query(
      `UPDATE personen SET emails = $1::jsonb, updated_at = NOW()
         WHERE LOWER(email) = $2
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(emails,'[]'::jsonb)) e WHERE LOWER(e) = $2)
      RETURNING id, emails`,
      [JSON.stringify(cleaned), email],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Kein personen-Eintrag fuer diese E-Mail' });
    res.json({ ok: true, emails: r.rows[0].emails });
  } catch (err) {
    console.error('[me/emails] error:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// PUT /api/me/whatsapp-optin — Toggle WhatsApp-Opt-In am Personen-Datensatz
// Body: { enabled: bool }
// Liefert Status zurueck: { ok, enabled, phone, reason? }
app.put('/api/me/whatsapp-optin', authMiddleware, async (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'Keine E-Mail' });
  const enabled = !!req.body?.enabled;
  try {
    const person = await pool.query(
      `SELECT id, name, telefon, mobile, telefone, whatsapp_opt_in
         FROM personen WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    if (!person.rows[0]) {
      return res.status(404).json({
        error: 'Kein Personen-Eintrag fuer diese E-Mail gefunden',
        hint: 'Bitte zuerst Telefonnummer in der Objektverwaltung hinterlegen lassen.',
      });
    }
    const p = person.rows[0];
    // Pick a usable phone: mobile -> telefon -> telefone[0].nummer
    let phone = p.mobile || p.telefon || null;
    if (!phone && Array.isArray(p.telefone) && p.telefone.length > 0) {
      phone = p.telefone[0]?.nummer || null;
    }
    if (enabled && !phone) {
      return res.status(400).json({
        error: 'Keine Telefonnummer hinterlegt',
        hint: 'WhatsApp-Benachrichtigungen benoetigen eine Telefonnummer im Profil.',
      });
    }
    await pool.query(
      `UPDATE personen SET whatsapp_opt_in = $1, updated_at = NOW() WHERE id = $2`,
      [enabled, p.id]
    );
    res.json({ ok: true, enabled, phone });
  } catch (err) {
    console.error('[whatsapp-optin] error:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
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
    /^zustellbericht:/i.test(parsed.subject || '') ||
    /zustellbericht:/i.test(parsed.subject || '') || // auch wenn prefixed
    senderAddrRaw === toAddress; // Self-loop: Verteiler an sich selbst
  // Frueher hier: senderAddrRaw.endsWith('@'+ourDomain) als Pauschal-Block.
  // Zu breit — blockte legitime Mails von Funktions-Adressen wie
  // praesident@ → ausschuss@ oder technik@ → bewohner@. Spezifische
  // System-Markierungen (noreply@, X-Rosenweg-System, X-Forwarded-By,
  // self-loop) sind eindeutig genug.
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

  // Mirror in WhatsApp-Gruppe wenn fuer diesen Verteiler eine Group-ID hinterlegt ist.
  // KI-Aufbereitung: Claude Haiku formatiert + kuerzt fuer WhatsApp-Lesbarkeit.
  if (list.whatsapp_group_id) {
    try {
      const rawBody = (parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '').trim();
      const waBody = await reformatEmailForWhatsapp({
        subject: parsed.subject || '(kein Betreff)',
        senderName,
        body: rawBody,
        attachmentCount: attachments.length,
      });
      await queueWhatsappMessage({
        phone: list.whatsapp_group_id,
        body: waBody,
        sourceType: 'verteiler-mirror',
        sourceId: logResult.rows[0].id,
      });
      console.log(`[Verteiler] Mirror in WA-Gruppe ${list.whatsapp_group_name || list.whatsapp_group_id} fuer ${toAddress}`);
    } catch (err) {
      console.warn('[Verteiler] WA-Mirror fehlgeschlagen:', err.message);
    }
  }

  // Schedule delivery report to sender after 90 seconds (only for internal senders — DSGVO)
  if (SMTP2GO_API_KEY && senderEmail && senderEmail.endsWith(`@${VERTEILER_DOMAIN}`)) {
    const logId = logResult.rows[0].id;
    const parentMsgId = messageId || parsed.messageId || null;
    setTimeout(() => sendDeliveryReport(logId, senderEmail, list.name, parsed.subject, recipients, parentMsgId).catch(
      err => console.error('[DeliveryReport] Error:', err.message)
    ), 90_000);
  }

  return { success: true, action: 'distributed', recipients: recipients.length };
}

// ─── Delivery Report ────────────────────────────────────────────────
async function sendDeliveryReport(logId, senderEmail, verteilerName, originalSubject, recipientsList, parentMessageId) {
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
  }, 'verteiler-delivery-report', { parent_message_id: parentMessageId || null, parent_source: `verteiler ${verteilerName} (log #${logId})` });
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
// Welche Mailboxen werden gepolled — INBOX + Spam wegen Cloudflare Spam-Heuristik
// die manche Mails (z.B. von externen Mailservern mit komischen DKIM) in den
// Spam-Folder forwardet. Sender-Auth-Check unten verhindert echte Spam-Forwards.
const IMAP_MAILBOXES = (process.env.IMAP_MAILBOXES || 'INBOX,[Gmail]/Spam').split(',').map(s => s.trim()).filter(Boolean);
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

  // Helper: einer Mailbox per Loop polled, behaelt eigenen Watermark in DB.
  // Wird einmal pro IMAP_MAILBOXES-Eintrag aufgerufen (INBOX + Spam).
  async function processOneMailbox(MAILBOX) {
    let lock;
    try { lock = await client.getMailboxLock(MAILBOX); }
    catch (e) { console.warn(`[IMAP] Cannot open ${MAILBOX}: ${e.message}`); return; }

    try {
      // UID-Watermark statt UNSEEN-Filter: robust gegen versehentliches Lesen
      // im Gmail-Webclient (Mail bleibt "seen" → wuerde sonst nie verarbeitet).
      // Wir tracken die hoechste verarbeitete UID pro Mailbox in der DB.
      const mbox = client.mailbox;
      // STATUS holt uidValidity/uidNext explizit (mbox-Werte sind manchmal stale)
      const status = await client.status(MAILBOX, { uidValidity: true, uidNext: true });
      const currentValidity = String(status.uidValidity ?? mbox.uidValidity ?? '0');
      const currentUidNext = Number(status.uidNext ?? mbox.uidNext ?? 1);
      const stateRes = await pool.query(
        'SELECT uid_validity::text AS uid_validity, last_uid::text AS last_uid FROM imap_state WHERE mailbox = $1',
        [MAILBOX]
      );
      let lastUid = 0;
      if (stateRes.rows.length === 0) {
        lastUid = Math.max(0, currentUidNext - 1);
        await pool.query(
          'INSERT INTO imap_state (mailbox, uid_validity, last_uid) VALUES ($1, $2, $3)',
          [MAILBOX, currentValidity, lastUid]
        );
        console.log(`[IMAP/${MAILBOX}] First run, watermark initialized at UID ${lastUid} (uidValidity=${currentValidity}, uidNext=${currentUidNext})`);
      } else if (stateRes.rows[0].uid_validity !== currentValidity) {
        lastUid = Math.max(0, currentUidNext - 1);
        await pool.query(
          'UPDATE imap_state SET uid_validity = $1, last_uid = $2, updated_at = NOW() WHERE mailbox = $3',
          [currentValidity, lastUid, MAILBOX]
        );
        console.warn(`[IMAP/${MAILBOX}] UIDVALIDITY changed (${stateRes.rows[0].uid_validity} → ${currentValidity}), watermark reset to ${lastUid}`);
      } else {
        lastUid = Number(stateRes.rows[0].last_uid);
      }

      // Robust: ALLE UIDs holen, in JS auf > lastUid filtern.
      // (Gmail-IMAP gibt bei '590:*' wenn uidNext=590 manchmal die hoechste UID
      // zurueck, auch wenn sie < 590 ist — daher zusaetzlicher JS-Filter.)
      const allUids = await client.search({ all: true }, { uid: true });
      const uids = (allUids || []).filter(u => Number(u) > lastUid).sort((a, b) => a - b);
      if (!uids.length) { lock.release(); return; }
      console.log(`[IMAP] Processing ${uids.length} new UIDs above watermark ${lastUid}: ${uids.slice(0, 10).join(',')}${uids.length > 10 ? '...' : ''}`);

      for (const uid of uids) {
        if (Number(uid) <= lastUid) {
          console.warn(`[IMAP] Defensive: skip UID ${uid} (<= watermark ${lastUid})`);
          continue;
        }
        let advancedWatermark = false;
        const advanceWatermark = async () => {
          if (advancedWatermark) return;
          advancedWatermark = true;
          try {
            await pool.query(
              'UPDATE imap_state SET last_uid = $1, updated_at = NOW() WHERE mailbox = $2 AND last_uid < $1',
              [uid, 'INBOX']
            );
          } catch (e) { console.error('[IMAP] Watermark update failed:', e.message); }
        };
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

            // System-Mail-Guard: noreply@…, Auto-Submitted-Header oder explizites
            // X-Rosenweg-No-Print blockieren Print-Loop (z.B. Konto-Loesch-Reminder
            // an druckerr+ wuerden sonst Print-Notification an Admins triggern).
            const isAutoSubmitted = /^Auto-Submitted:\s*(auto-generated|auto-replied)/im.test(headers);
            const isNoPrint = /^X-Rosenweg-No-Print:\s*true/im.test(headers);
            const isSystemSender = senderEmail === `noreply@${VERTEILER_DOMAIN}` || senderEmail === `mailer-daemon@${VERTEILER_DOMAIN}`;
            if (isAutoSubmitted || isNoPrint || isSystemSender) {
              console.log(`[Print] Skipped System-Mail (auto=${isAutoSubmitted} noprint=${isNoPrint} sysSender=${isSystemSender}) from=${senderEmailRaw} to=${verteilerAddress}`);
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
              continue;
            }
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
                    }, 'print-notification', { parent_message_id: messageId || null, parent_source: `inbound-mail to ${verteilerAddress}` });
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
                    }, 'print-failure', { parent_message_id: messageId || null, parent_source: `inbound-mail to ${verteilerAddress}` });
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
          // Mit UID-watermark wird die Mail trotzdem als "behandelt" markiert
          // (sonst Endlos-Retry-Loop). Message-ID-Dedup schuetzt vor
          // versehentlicher Doppel-Verarbeitung wenn UID-Reset noetig waere.
        } finally {
          // Auch bei `continue` aus dem try-Block: Watermark immer vorruecken,
          // damit alte/uebersprungene UIDs nicht endlos re-gescannt werden.
          await advanceWatermark();
        }
      }
    } finally {
      lock.release();
    }
  } // end of inner processOneMailbox

  try {
    await client.connect();
    for (const mb of IMAP_MAILBOXES) {
      try { await processOneMailbox(mb); }
      catch (e) { console.error(`[IMAP/${mb}] processOneMailbox error:`, e.message); }
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

// Helper: load wohnung with kontakte. Default returns aktive + zukünftige (passiv) Eintraege;
// archivierte (history) sind ausgeblendet. opts.onlyHistory=true liefert ausschliesslich Historie.
async function loadWohnungMitKontakte(wohnungId, opts = {}) {
  const wRes = await pool.query('SELECT * FROM wohnungen WHERE id = $1', [wohnungId]);
  if (wRes.rows.length === 0) return null;
  const w = wRes.rows[0];
  let kRes;
  if (opts.onlyHistory) {
    kRes = await pool.query(
      'SELECT * FROM wohnungen_kontakte WHERE wohnung_id = $1 AND archiviert_am IS NOT NULL ORDER BY archiviert_am DESC, rolle, id',
      [wohnungId]
    );
  } else {
    // Aktiv + zukünftig: alles, was nicht archiviert ist
    kRes = await pool.query(
      `SELECT * FROM wohnungen_kontakte
       WHERE wohnung_id = $1 AND archiviert_am IS NULL
       ORDER BY rolle, sort_order, id`,
      [wohnungId]
    );
  }
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

// Helper: save kontakte for a wohnung. Preserves history:
// - Existing active entries with matching id are UPDATEd
// - Entries without id are INSERTed (gueltig_ab from input, default today)
// - Active entries no longer in array are ARCHIVED (archiviert_am=today), not deleted
// - Archived/historical entries are never touched
// Findet eine bestehende Person via Name+Email oder legt sie neu an.
// Liefert person_id zurueck. Email-Sharing zwischen Familienmitgliedern wird
// respektiert: Match nur wenn Name UND Email uebereinstimmen.
async function findOrCreatePerson(client, name, email, telefon, adresse) {
  if (!name && !email) return null;
  const nameNorm = (name || '').toLowerCase().trim();
  const emailNorm = (email || '').toLowerCase().trim();
  const r = await client.query(
    `SELECT id FROM personen
      WHERE LOWER(TRIM(COALESCE(name,''))) = $1
        AND LOWER(TRIM(COALESCE(email,''))) = $2
      ORDER BY id LIMIT 1`,
    [nameNorm, emailNorm],
  );
  if (r.rows.length > 0) return r.rows[0].id;
  // Fallback: nur per Name (wenn dieser eindeutig in personen ist)
  if (name && !email) {
    const byName = await client.query(
      `SELECT id, COUNT(*) OVER () AS total
         FROM personen WHERE LOWER(TRIM(name)) = $1 LIMIT 2`,
      [nameNorm],
    );
    if (byName.rows.length === 1) return byName.rows[0].id;
  }
  // H2: Race-safe INSERT via UNIQUE-Index (uq_personen_name_email).
  // ON CONFLICT → DO NOTHING gibt keine ID zurueck, daher fallback SELECT.
  const ins = await client.query(
    `INSERT INTO personen (name, email, telefon, adresse)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (LOWER(TRIM(COALESCE(name,''))), LOWER(TRIM(COALESCE(email,''))))
       DO NOTHING
     RETURNING id`,
    [name || null, email || null, telefon || null, adresse || null],
  );
  if (ins.rows.length > 0) return ins.rows[0].id;
  // Conflict → parallele Anlage; lese die existierende Person
  const again = await client.query(
    `SELECT id FROM personen
      WHERE LOWER(TRIM(COALESCE(name,''))) = $1
        AND LOWER(TRIM(COALESCE(email,''))) = $2
      LIMIT 1`,
    [nameNorm, emailNorm],
  );
  return again.rows[0]?.id || null;
}

async function saveKontakte(client, wohnungId, kontakte, stweg) {
  // Load currently-active kontakte (not archived) for diff
  const oldRes = await client.query(
    'SELECT * FROM wohnungen_kontakte WHERE wohnung_id = $1 AND archiviert_am IS NULL',
    [wohnungId]
  );
  const oldKontakte = oldRes.rows;
  const incoming = Array.isArray(kontakte) ? kontakte : [];
  const incomingIds = new Set(incoming.map(k => k.id).filter(Boolean));

  // Archive old active entries that the frontend dropped from the list
  const removed = oldKontakte.filter(k => !incomingIds.has(k.id));
  if (removed.length > 0) {
    const ids = removed.map(k => k.id);
    await client.query(
      `UPDATE wohnungen_kontakte SET archiviert_am = CURRENT_DATE
       WHERE id = ANY($1::int[]) AND archiviert_am IS NULL`,
      [ids]
    );
  }

  const VALID_ROLLEN = ['eigentuemer', 'mieter', 'verwalter', 'bewohner', 'sonstige'];
  for (let i = 0; i < incoming.length; i++) {
    const k = incoming[i];
    if (!k.name && !k.email) continue;
    const rolle = VALID_ROLLEN.includes(k.rolle) ? k.rolle : 'eigentuemer';
    const authentikZugang = k.authentik_zugang !== undefined ? k.authentik_zugang
      : (rolle === 'eigentuemer' || rolle === 'verwalter') ? true : null;
    let email = k.email || null;
    if (!email && authentikZugang !== true && k.name) {
      const slug = k.name.toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9 -]/g, '')
        .trim()
        .split(/\s+/).reverse().join('.');
      if (slug) email = `druckerr9+${slug}@${VERTEILER_DOMAIN}`;
    }
    const gueltigAb = k.gueltig_ab || null;
    // Person-ID ermitteln (explizit mitgegeben, oder via find/create)
    const personId = Number.isFinite(parseInt(k.person_id, 10))
      ? parseInt(k.person_id, 10)
      : await findOrCreatePerson(client, k.name || null, email, normalizePhone(k.telefon), k.adresse || null);

    if (k.id && oldKontakte.find(o => o.id === k.id)) {
      await client.query(
        `UPDATE wohnungen_kontakte
            SET rolle = $1, name = $2, email = $3, telefon = $4, adresse = $5,
                sort_order = $6, authentik_zugang = $7,
                gueltig_ab = COALESCE($8, gueltig_ab),
                person_id = COALESCE($10, person_id)
          WHERE id = $9`,
        [rolle, k.name || null, email, normalizePhone(k.telefon), k.adresse || null, i, authentikZugang, gueltigAb, k.id, personId]
      );
    } else {
      await client.query(
        `INSERT INTO wohnungen_kontakte (wohnung_id, rolle, name, email, telefon, adresse, sort_order, authentik_zugang, gueltig_ab, person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [wohnungId, rolle, k.name || null, email, normalizePhone(k.telefon), k.adresse || null, i, authentikZugang, gueltigAb, personId]
      );
    }
    if (email) cancelPendingDeletion(email).catch(() => {});
  }

  if (stweg) trackRemovedKontakte(wohnungId, stweg, oldKontakte, incoming).catch(() => {});

  // Auto-Vollmacht-Entwurf fuer Verwalter: bei jedem neuen oder
  // aktualisierten Verwalter-Kontakt wird ein Entwurf erzeugt, falls
  // noch keine aktive/Entwurfs-Vollmacht zwischen Eigentuemer und
  // Verwalter existiert. CH-Recht: Vertretung braucht Schriftform,
  // daher MUSS der Eigentuemer noch signieren bevor der Verwalter
  // tatsaechlich vertreten darf.
  autoCreateVollmachtForVerwalter(client, wohnungId, stweg, incoming).catch(err =>
    console.warn('[vollmacht-auto] saveKontakte:', err.message),
  );
}

async function autoCreateVollmachtForVerwalter(client, wohnungId, stweg, kontakte) {
  const verwalter = kontakte.filter(k => k.rolle === 'verwalter' && k.email && k.name);
  if (verwalter.length === 0) return;
  // Alle Eigentuemer dieser Wohnung holen (aus DB, inkl. die nicht im incoming)
  const eigRes = await client.query(
    `SELECT name, email, adresse, person_id FROM wohnungen_kontakte
      WHERE wohnung_id = $1 AND rolle = 'eigentuemer' AND archiviert_am IS NULL AND email IS NOT NULL`,
    [wohnungId],
  );
  if (eigRes.rows.length === 0) return; // ohne Eigentuemer keine Vollmacht
  const eigentuemerEmails = eigRes.rows.map(e => (e.email || '').toLowerCase());
  for (const v of verwalter) {
    if (eigentuemerEmails.includes((v.email || '').toLowerCase())) continue;
    // Existiert schon eine aktive/Entwurfs-Vollmacht zwischen dieser Eigentuemer-
    // Gruppe (alle Emails) und diesem Verwalter? Wir definieren das als: jede
    // Vollmacht an diesen Verwalter, die alle aktuellen Eigentuemer abdeckt.
    const exists = await client.query(
      `SELECT v.id FROM vollmachten v
        WHERE LOWER(v.bevollmaechtigter_email) = LOWER($1)
          AND v.wohnung_id = $2
          AND v.status IN ('entwurf','aktiv')
        LIMIT 1`,
      [v.email, wohnungId],
    );
    if (exists.rows.length > 0) continue;
    // Vollmacht-Haupt-Record (vollmachtgeber_* = primaerer Eigentuemer)
    const primary = eigRes.rows[0];
    const sql = h => `INSERT INTO vollmachten (
         doc_hash,
         vollmachtgeber_name, vollmachtgeber_email, vollmachtgeber_adresse,
         bevollmaechtigter_typ, bevollmaechtigter_name, bevollmaechtigter_email,
         bevollmaechtigter_telefon, bevollmaechtigter_adresse,
         art, geltungsbereich, wohnung_id, stweg,
         gueltig_ab, status, created_by_user_email
       ) VALUES ($1,$2,$3,$4,'verwaltung',$5,$6,$7,$8,'generell',$9,$10,$11,CURRENT_DATE,'entwurf','system:auto-verwalter')
       RETURNING id`;
    const eigSuffix = eigRes.rows.length > 1 ? ' und ' + (eigRes.rows.length - 1) + ' weitere/r Eigentuemer/in' : '';
    const ins = await vmInsertWithRetry(client, sql, [
      primary.name, primary.email, primary.adresse || null,
      v.name, v.email, v.telefon || null, v.adresse || null,
      'Automatisch erzeugter Entwurf aus Objektverwaltung: Verwalter '
        + v.name + ' vertritt ' + primary.name + eigSuffix + ' in allen Belangen der Wohnung. '
        + 'Bitte pruefen, anpassen und signieren (digital oder Papier). Bei Miteigentum muessen ALLE eingetragenen Vollmachtgeber separat signieren.',
      wohnungId, stweg,
    ]);
    const vollmachtId = ins.rows[0].id;
    // Alle Eigentuemer als separate Vollmachtgeber-Zeilen anlegen (jeder
    // muss einzeln signieren)
    for (let i = 0; i < eigRes.rows.length; i++) {
      const e = eigRes.rows[i];
      await client.query(
        `INSERT INTO vollmachten_vollmachtgeber (vollmacht_id, person_id, name, email, adresse, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [vollmachtId, e.person_id || null, e.name, e.email, e.adresse || null, i],
      );
    }
    console.log('[vollmacht-auto] Entwurf #' + vollmachtId + ' erstellt: ' + eigRes.rows.length + ' Eigentuemer → Verwalter=' + v.email + ' Wohnung=' + wohnungId);
  }
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
    // Drucker-Aliasse (druckerr9+name@…, druckerr13+…) sind technische
    // Print-to-Mail-Adressen — keine echten User-Accounts → niemals scheduling.
    if (/^druckerr\d+\+/i.test(email)) continue;
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

// ─── Admin-API fuer Pending Deletions (UI in loeschungen.html) ────────
// Mail-Chain: liefert eine flache Liste aller Mails + ihre Folge-Mails (rekursiv)
// fuer eine gegebene message_id oder source.
app.get('/api/admin/mail-chain', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const messageId = String(req.query.message_id || '').trim();
  const source = String(req.query.source_contains || '').trim();
  if (!messageId && !source) return res.status(400).json({ error: 'message_id ODER source_contains erforderlich' });
  try {
    let rootCondition, rootParams;
    if (messageId) {
      rootCondition = `message_id = $1`;
      rootParams = [messageId];
    } else {
      rootCondition = `parent_source ILIKE $1`;
      rootParams = [`%${source}%`];
    }
    // Recursive CTE: alle Mails wo message_id matched + alle wo parent_message_id einer
    // Mail aus dem matched set entspricht (Level 1+).
    const r = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT 0 AS depth, id, message_id, parent_message_id, parent_source, trigger,
                subject, from_email, to_addresses, recipients_count, status, created_at
           FROM email_log WHERE ${rootCondition}
         UNION ALL
         SELECT c.depth + 1, e.id, e.message_id, e.parent_message_id, e.parent_source, e.trigger,
                e.subject, e.from_email, e.to_addresses, e.recipients_count, e.status, e.created_at
           FROM email_log e JOIN chain c ON e.parent_message_id = c.message_id
          WHERE c.depth < 5
       )
       SELECT * FROM chain ORDER BY created_at ASC LIMIT 200`,
      rootParams,
    );
    res.json({ chain: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/pending-deletions', authMiddleware, requireTechnikOrPraesident, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.email, d.name, d.stweg, d.scheduled_at, d.reminder_sent, d.cancelled, d.created_at,
              EXTRACT(DAY FROM (d.scheduled_at - NOW()))::int AS days_until,
              EXISTS(SELECT 1 FROM wohnungen_kontakte wk WHERE LOWER(wk.email) = LOWER(d.email)) AS still_in_kontakte
         FROM authentik_pending_deletions d
        ORDER BY d.scheduled_at ASC`
    );
    res.json({ deletions: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/pending-deletions/:id/cancel', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE authentik_pending_deletions SET cancelled = true WHERE id = $1 RETURNING email, cancelled`,
      [parseInt(req.params.id, 10)],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    console.log(`[Authentik] Pending-Deletion cancelled by ${req.user.email}: ${r.rows[0].email}`);
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/pending-deletions/:id/reactivate', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE authentik_pending_deletions SET cancelled = false, reminder_sent = false,
                                              scheduled_at = NOW() + INTERVAL '30 days'
        WHERE id = $1 RETURNING email`,
      [parseInt(req.params.id, 10)],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ ok: true, email: r.rows[0].email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/pending-deletions/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    await pool.query(`DELETE FROM authentik_pending_deletions WHERE id = $1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    // Drucker-Aliasse (druckerr<N>+name@…) ueberspringen — die sind keine
    // echten User-Accounts und der Reminder wuerde via Print-Notification
    // an Admins zurueckschlagen.
    const reminders = await pool.query(
      `SELECT * FROM authentik_pending_deletions
       WHERE cancelled = false AND reminder_sent = false
       AND scheduled_at - INTERVAL '7 days' <= NOW()
       AND scheduled_at > NOW()
       AND email !~* '^druckerr\\d+\\+'`
    );
    for (const row of reminders.rows) {
      try {
        const deleteDate = new Date(row.scheduled_at);
        const formattedDate = `${deleteDate.getDate()}.${deleteDate.getMonth() + 1}.${deleteDate.getFullYear()}`;
        await loggedSendMail({
          from: MAIL_FROM,
          to: row.email,
          subject: 'Rosenweg: Ihr Konto wird in 7 Tagen gelöscht',
          headers: {
            'Auto-Submitted': 'auto-generated',
            'X-Rosenweg-No-Print': 'true',
            'X-Auto-Response-Suppress': 'All',
          },
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
        }, 'authentik-deletion-reminder', { parent_source: `authentik_pending_deletions #${row.id} (${row.email})` });
        await pool.query('UPDATE authentik_pending_deletions SET reminder_sent = true WHERE id = $1', [row.id]);
        console.log(`[Authentik] Deletion reminder sent to ${row.email}`);
      } catch (err) {
        console.error(`[Authentik] Failed to send reminder to ${row.email}:`, err.message);
      }
    }

    // 2. Delete users past their scheduled date — Drucker-Aliasse ebenfalls auslassen
    const deletions = await pool.query(
      `SELECT * FROM authentik_pending_deletions
       WHERE cancelled = false AND scheduled_at <= NOW()
       AND email !~* '^druckerr\\d+\\+'`
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

// ─── Taegliche Auslagen-Outbox: nachreichen an neu-wirksame Verwaltungen ──
// Wenn eine Verwaltung mit Startdatum in der Zukunft erfasst wurde,
// wird sie zum Stichtag automatisch wirksam — hier reichen wir alle
// genehmigten Auslagen, die waehrend der Vakanz nur an den Ausschuss gingen,
// jetzt an die neue Verwaltung nach.
//
// ACHTUNG: lastOutboxRunDay ist In-Memory, deshalb nur sicher mit 1 API-Replica.
// Bei Scale-up auf >1 Replica: replace mit DB-backed Lock (z.B. advisory_lock
// oder Tabelle outbox_runs(run_date PRIMARY KEY)).
let lastOutboxRunDay = null;
async function runAuslagenOutboxDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastOutboxRunDay === today) return;
  lastOutboxRunDay = today;
  try {
    // Pro STWEG + uebergreifend pruefen
    const stwegs = [null, 1, 2, 3, 4, 5, 6, 7, 8];
    let totalResent = 0;
    for (const s of stwegs) {
      const res = await resendOffeneAuszahlungenFuerWirksameVerwaltung(s);
      if (res && res.resent) totalResent += res.resent;
    }
    if (totalResent > 0) {
      console.log(`[auslagen-outbox] ${totalResent} offene Auslagen heute an wirksam gewordene Verwaltungen nachgereicht`);
    }
  } catch (e) {
    console.error('[auslagen-outbox] Lauf fehlgeschlagen:', e.message);
  }
}
// Stuendlich pruefen ob heute schon gelaufen — robust ggue Restarts.
setInterval(runAuslagenOutboxDaily, 60 * 60 * 1000);
// Initial 90s nach Start (nach initDB)
setTimeout(runAuslagenOutboxDaily, 90 * 1000);

// ─── Reminder: genehmigte Auslagen ohne Auszahlung > 30 Tage ─────────
// Taeglich pruefen + Reminder an Verwaltung (CC Ausschuss + Eigentuemer)
// Damit keine genehmigte Auszahlung versehentlich vergessen wird.
let lastAuszahlungReminderDay = null;
async function runAuszahlungReminderDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastAuszahlungReminderDay === today) return;
  lastAuszahlungReminderDay = today;
  try {
    // Genehmigte Auslagen die > 30 Tage alt sind und noch nicht ausbezahlt
    // bearbeitet_am = Zeitpunkt der letzten Status-Aenderung (z.B. → genehmigt)
    // Nur 1× pro Auslage pro 14 Tage erinnern (via auszahlung_reminder_at)
    const r = await pool.query(`
      SELECT * FROM auslagen
       WHERE status = 'genehmigt'
         AND bearbeitet_am < NOW() - INTERVAL '30 days'
         AND (auszahlung_reminder_at IS NULL OR auszahlung_reminder_at < NOW() - INTERVAL '14 days')
       ORDER BY bearbeitet_am
       LIMIT 100
    `);
    if (r.rows.length === 0) return;
    let reminded = 0;
    for (const a of r.rows) {
      try {
        const verw = await findVerwaltungForStweg(a.stweg);
        const stwegLabel = a.stweg ? `STWEG ${a.stweg}` : 'Kooperation';
        const tage = Math.floor((Date.now() - new Date(a.bearbeitet_am).getTime()) / (1000 * 60 * 60 * 24));
        const betrag = Number(a.betrag_chf).toFixed(2);
        const to = (verw && verw.mailTo.length > 0) ? verw.mailTo.join(', ') : a.bearbeitet_von || a.user_email;
        const ausschussCc = [a.user_email, a.bearbeitet_von].filter((v, i, ar) => v && ar.indexOf(v) === i);
        await loggedSendMail({
          from: MAIL_FROM,
          to,
          cc: ausschussCc.join(', '),
          subject: `⏰ Erinnerung: Auszahlung offen seit ${tage} Tagen — ${stwegLabel}, CHF ${betrag} (Auslage ${a.id})`,
          text:
            `Diese Auslage wurde vor ${tage} Tagen genehmigt, aber noch nicht als ausbezahlt markiert.\n\n`
            + `── Auslage ${a.id} ──\n`
            + `STWEG:           ${stwegLabel}\n`
            + `Eingereicht von: ${a.user_name} <${a.user_email}>\n`
            + `Beschreibung:    ${a.beschreibung}\n`
            + `Betrag:          CHF ${betrag}\n`
            + `IBAN:            ${a.iban || '— nicht angegeben —'}\n`
            + `Genehmigt am:    ${new Date(a.bearbeitet_am).toLocaleDateString('de-CH')} (vor ${tage} Tagen)\n\n`
            + `Bitte Auszahlung pruefen / durchfuehren und im System als "ausbezahlt" markieren:\n${SITE_URL}/auslagen.html\n\n`
            + `(Diese Erinnerung wird alle 14 Tage automatisch wiederholt, bis die Auslage als ausbezahlt markiert ist.)`,
        }, 'auslage-auszahlung-reminder');
        // WhatsApp-Push an Eigentuemer + bearbeitet_von (Approver) bei Opt-In
        pushWhatsappBroadcast({
          emails: ausschussCc, sourceType: 'auslage-auszahlung-reminder', sourceId: a.id,
          body: `⏰ *Auszahlung offen seit ${tage} Tagen*\n${stwegLabel} · CHF ${betrag}\n${a.beschreibung.slice(0, 80)}\n\n${SITE_URL}/auslagen.html`,
        }).catch(() => {});
        await pool.query('UPDATE auslagen SET auszahlung_reminder_at = NOW() WHERE id = $1', [a.id]);
        reminded++;
      } catch (e) {
        console.warn(`[reminder] Auslage ${a.id} Mail fehlgeschlagen:`, e.message);
      }
    }
    if (reminded > 0) console.log(`[reminder] ${reminded} Auszahlungs-Reminder verschickt`);
  } catch (e) {
    console.error('[reminder] Lauf fehlgeschlagen:', e.message);
  }
}
setInterval(runAuszahlungReminderDaily, 60 * 60 * 1000);
setTimeout(runAuszahlungReminderDaily, 120 * 1000);

// ─── Nightly Drucker-Tag-Cleanup ────────────────────────────────────
// Findet Kontakte mit Drucker-Tag-Email wo derselbe Name woanders eine echte
// Email hat — und ersetzt den Drucker-Tag automatisch durch die echte Email.
// Versendet Zusammenfassung an Technik UND Präsident.
async function checkStaleDruckerTags() {
  try {
    // Kandidaten + echte Email pro Name aufschlüsseln
    const result = await pool.query(`
      WITH drucker AS (
        SELECT wk.id, wk.name, wk.email, w.stweg, w.bezeichnung, w.typ
        FROM wohnungen_kontakte wk JOIN wohnungen w ON w.id = wk.wohnung_id
        WHERE wk.email LIKE 'druckerr9+%' OR wk.email LIKE 'druckerr13+%'
      ),
      real_email_for_name AS (
        SELECT name, MIN(email) AS real_email
        FROM wohnungen_kontakte
        WHERE email IS NOT NULL AND email <> ''
          AND email NOT LIKE 'druckerr9+%' AND email NOT LIKE 'druckerr13+%'
        GROUP BY name
      )
      SELECT d.id, d.name, d.email AS drucker_tag, r.real_email,
             d.stweg, d.bezeichnung, d.typ
      FROM drucker d
      JOIN real_email_for_name r ON r.name = d.name
      ORDER BY d.stweg, d.bezeichnung
    `);
    if (result.rows.length === 0) {
      console.log('[CleanupWarn] Keine veralteten Drucker-Tags gefunden');
      return;
    }

    // Auto-Fix: Drucker-Tag-Email durch die echte Email ersetzen
    const ids = result.rows.map(r => r.id);
    await pool.query(`
      UPDATE wohnungen_kontakte k SET email = r.real_email
      FROM (VALUES ${result.rows.map((_, i) => `($${i*2+1}::int, $${i*2+2}::text)`).join(',')}) AS r(id, real_email)
      WHERE k.id = r.id
    `, result.rows.flatMap(r => [r.id, r.real_email]));
    console.log(`[CleanupFix] ${result.rows.length} Drucker-Tags durch echte Emails ersetzt`);

    // Adressaten: Technik + Präsident
    if (!AUTHENTIK_API_TOKEN) return;
    const usersData = await authentikAPI('GET', '/core/users/?page_size=1000');
    const groupsData = await authentikAPI('GET', '/core/groups/?page_size=500');
    const groupPks = (groupsData.results || [])
      .filter(g => ['technik', 'präsident', 'praesident'].includes(g.name.toLowerCase()))
      .map(g => g.pk);
    if (groupPks.length === 0) return;
    const recipients = [...new Set((usersData.results || [])
      .filter(u => u.is_active && u.email && u.groups_obj?.some(g => groupPks.includes(g.pk)))
      .map(u => u.email))];
    if (recipients.length === 0) return;

    const rows = result.rows.map(r =>
      `<tr><td>${r.name}</td><td><code style="color:#999;text-decoration:line-through">${r.drucker_tag}</code></td><td><code style="color:#10b981">${r.real_email}</code></td><td>STWEG ${r.stweg} · ${r.typ} · ${r.bezeichnung}</td></tr>`
    ).join('');
    await loggedSendMail({
      from: `"Rosenweg Daten-Cleanup" <noreply@${VERTEILER_DOMAIN}>`,
      to: recipients.join(', '),
      subject: `[Cleanup] ${result.rows.length} Drucker-Tags automatisch durch echte Email ersetzt`,
      html: `<p>Folgende Kontakte hatten einen Drucker-Tag als Email, obwohl die Person woanders bereits eine echte E-Mail-Adresse hinterlegt hat. Die Drucker-Tags wurden <strong>automatisch durch die echten Adressen ersetzt</strong> — zur Information, kein Handlungsbedarf:</p>
<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
<thead><tr><th align="left">Name</th><th align="left">Alt (Drucker-Tag)</th><th align="left">Neu</th><th align="left">Objekt</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="color:#666;font-size:11px">Automatisch generiert · ${new Date().toLocaleString('de-CH')}</p>`,
    }, 'cleanup-stale-drucker-tags');
    console.log(`[CleanupWarn] ${result.rows.length} Korrekturen an ${recipients.length} Empfänger (Technik+Präsident) geschickt`);
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

// ─── Auto-Archive: Vorgemerkte Eintraege werden heute aktiv ────────
// Wenn ein neuer Kontakt mit gueltig_ab=heute aktiv wird und ein anderer aktiver
// Kontakt mit derselben Rolle auf derselben Wohnung existiert (gueltig_ab < neuer.gueltig_ab),
// wird der Vorgaenger archiviert. Authentik-Zugang bleibt unveraendert (wird beim Anlegen
// schon vergeben und bei Archivierung ueber trackRemovedKontakte verzoegert deaktiviert).
async function autoArchiveSupersededKontakte() {
  try {
    // Kontakte, die heute (oder früher) effektiv geworden sind und noch keinen
    // Vorgaenger archiviert haben
    const sql = `
      WITH heute_aktiv AS (
        SELECT id, wohnung_id, rolle, gueltig_ab
          FROM wohnungen_kontakte
         WHERE archiviert_am IS NULL
           AND gueltig_ab IS NOT NULL
           AND gueltig_ab <= CURRENT_DATE
      )
      UPDATE wohnungen_kontakte alt
         SET archiviert_am = CURRENT_DATE
        FROM heute_aktiv neu
       WHERE alt.wohnung_id = neu.wohnung_id
         AND alt.rolle = neu.rolle
         AND alt.id <> neu.id
         AND alt.archiviert_am IS NULL
         AND (alt.gueltig_ab IS NULL OR alt.gueltig_ab < neu.gueltig_ab)
      RETURNING alt.id, alt.wohnung_id, alt.rolle, alt.email
    `;
    const r = await pool.query(sql);
    if (r.rowCount > 0) {
      console.log(`[KontakteCron] ${r.rowCount} Vorgaenger archiviert (durch vorgemerkte Eintraege superseded)`);
    }
  } catch (err) {
    console.error('[KontakteCron] Auto-Archive Fehler:', err.message);
  }
}
setInterval(autoArchiveSupersededKontakte, 24 * 60 * 60 * 1000);
setTimeout(autoArchiveSupersededKontakte, 5 * 60 * 1000); // initial run 5min nach Start

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
// Helper: WebDAV-Request via node:http/https (Node fetch/undici hat Probleme
// mit Sabre/DAV PUT/MKCOL — manche Auth-Layer matchen nicht; klassisches
// http-Modul mit Connection: close ist robuster).
function davRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
    const finalHeaders = { 'Connection': 'close', ...headers };
    // Sabre/DAV akzeptiert chunked transfer nicht zuverlaessig fuer PUT/MKCOL
    // → explizites Content-Length setzen.
    if (bodyBuf) finalHeaders['Content-Length'] = bodyBuf.length;
    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: finalHeaders,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function syncContactsToNextcloud() {
  // NEXTCLOUD_URL_INTERNAL = z.B. http://nextcloud_nextcloud (Service-Discovery
  // im Swarm) — umgeht Cloudflare-Egress-IP und damit Brute-Force-Limits, die
  // beim ersten erfolglosen Versuch sonst alle weiteren Calls blockieren.
  // NEXTCLOUD_URL_PUBLIC bleibt fuer trusted_domains-Validierung im Host-Header.
  const ncUrl = process.env.NEXTCLOUD_URL_INTERNAL || process.env.NEXTCLOUD_URL;
  const ncHost = process.env.NEXTCLOUD_URL_PUBLIC || process.env.NEXTCLOUD_URL;
  const ncUser = process.env.NEXTCLOUD_ADMIN_USER;
  const ncPass = process.env.NEXTCLOUD_ADMIN_APP_PASSWORD;
  const book = process.env.NEXTCLOUD_ADDRESSBOOK || 'rosenweg-tel';
  if (!ncUrl || !ncUser || !ncPass) {
    console.log('[CardDAVSync] Skipped: NEXTCLOUD_URL/USER/APP_PASSWORD nicht gesetzt');
    return;
  }
  const auth = 'Basic ' + Buffer.from(`${ncUser}:${ncPass}`).toString('base64');
  const baseDav = `${ncUrl.replace(/\/$/, '')}/remote.php/dav/addressbooks/users/${ncUser}/${book}`;
  // Host-Header fuer trusted_domains; Authority aus public URL extrahiert
  const hostHeader = (() => { try { return new URL(ncHost).host; } catch { return undefined; } })();
  const headersWithHost = base => hostHeader ? { ...base, Host: hostHeader } : base;

  try {
    // Adressbuch erstellen wenn nicht existiert (MKCOL ist idempotent — 405 wenn exists)
    await davRequest('MKCOL', baseDav, headersWithHost({
      'Authorization': auth,
      'Content-Type': 'application/xml',
    }), `<?xml version="1.0" encoding="utf-8"?>
<mkcol xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <set><prop>
    <resourcetype><collection/><c:addressbook/></resourcetype>
    <displayname>Rosenweg Telefonbuch</displayname>
    <c:addressbook-description>Internes Adressbuch der STWEG-Kooperation Rosenweg (auto-sync)</c:addressbook-description>
  </prop></set>
</mkcol>`).catch(() => {});

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
    const propfindRes = await davRequest('PROPFIND', baseDav + '/', headersWithHost({
      'Authorization': auth, 'Depth': '1', 'Content-Type': 'application/xml',
    }), `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>`);
    const existingHrefs = new Set();
    for (const m of propfindRes.body.matchAll(/<d:href[^>]*>([^<]+)<\/d:href>/gi)) {
      const href = m[1];
      if (href.endsWith('.vcf')) existingHrefs.add(decodeURIComponent(href.split('/').pop()));
    }

    // Aktuelle UIDs berechnen + PUT
    const currentUids = new Set();
    let upserted = 0;
    for (const c of contacts) {
      const { uid, vcard } = buildVCard(c);
      currentUids.add(uid + '.vcf');
      const r = await davRequest('PUT', `${baseDav}/${uid}.vcf`, headersWithHost({
        'Authorization': auth, 'Content-Type': 'text/vcard; charset=utf-8',
      }), vcard);
      if (r.status === 200 || r.status === 201 || r.status === 204) upserted++;
      else console.error(`[CardDAVSync] PUT ${uid} → ${r.status}`);
    }

    // Verwaiste Eintraege loeschen
    let deleted = 0;
    for (const href of existingHrefs) {
      if (currentUids.has(href)) continue;
      if (!href.startsWith('rosenweg-')) continue; // nur unsere
      const r = await davRequest('DELETE', `${baseDav}/${href}`, headersWithHost({ 'Authorization': auth }));
      if (r.status === 200 || r.status === 204) deleted++;
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
// ─── Verwaltungen-CRUD (Hausverwaltungs-Firmen pro STWEG) ─────────
// Public-View: GET /api/verwaltungen/public — minimaler Datensatz fuer
// Anzeige auf oeffentlicher /verwaltung.html (ohne Login-Daten + Notizen).
app.get('/api/verwaltungen/public', async (req, res) => {
  try {
    // "Wirksam" = aktiv UND (kein Startdatum ODER Startdatum erreicht)
    //                  UND (kein Enddatum ODER Enddatum noch nicht vorbei)
    const { rows: verw } = await pool.query(`
      SELECT id, stweg, firma_name, adresse, telefon, email, website, oeffnungszeiten,
             plattform_name, plattform_url, vertrag_von, vertrag_bis
      FROM verwaltungen
      WHERE aktiv = true
        AND (vertrag_von IS NULL OR vertrag_von <= CURRENT_DATE)
        AND (vertrag_bis IS NULL OR vertrag_bis >= CURRENT_DATE)
      ORDER BY stweg NULLS FIRST, firma_name
    `);
    const ids = verw.map(v => v.id);
    const { rows: kontakte } = ids.length === 0 ? { rows: [] } : await pool.query(`
      SELECT verwaltung_id, name, funktion, email, telefon
      FROM verwaltungs_kontakte WHERE verwaltung_id = ANY($1::int[])
      ORDER BY verwaltung_id, sort_order, id
    `, [ids]);
    const byVerw = new Map();
    for (const v of verw) byVerw.set(v.id, { ...v, kontakte: [] });
    for (const k of kontakte) byVerw.get(k.verwaltung_id)?.kontakte.push(k);
    res.json({ verwaltungen: [...byVerw.values()] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin-View: alle Felder (inkl. Login-Passwoerter), nur Ausschuss/Technik
app.get('/api/verwaltungen', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { rows: verw } = await pool.query(`SELECT * FROM verwaltungen ORDER BY stweg NULLS FIRST, aktiv DESC, firma_name`);
    const ids = verw.map(v => v.id);
    const { rows: kontakte } = ids.length === 0 ? { rows: [] } : await pool.query(
      `SELECT * FROM verwaltungs_kontakte WHERE verwaltung_id = ANY($1::int[]) ORDER BY verwaltung_id, sort_order, id`,
      [ids]
    );
    const byVerw = new Map();
    for (const v of verw) byVerw.set(v.id, { ...v, kontakte: [] });
    for (const k of kontakte) byVerw.get(k.verwaltung_id)?.kontakte.push(k);
    res.json({ verwaltungen: [...byVerw.values()] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create
app.post('/api/verwaltungen', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(`
      INSERT INTO verwaltungen
        (stweg, firma_name, adresse, telefon, email, website, oeffnungszeiten,
         plattform_name, plattform_url, plattform_user, plattform_pass,
         vertrag_von, vertrag_bis, kuendigungsfrist_monate, kuendigung_eingereicht_am, dokument_pfad, notizen, aktiv)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, COALESCE($18, true))
      RETURNING *
    `, [b.stweg || null, b.firma_name, b.adresse || null, normalizePhone(b.telefon), b.email || null,
        b.website || null, b.oeffnungszeiten || null,
        b.plattform_name || null, b.plattform_url || null, b.plattform_user || null, b.plattform_pass || null,
        b.vertrag_von || null, b.vertrag_bis || null, b.kuendigungsfrist_monate || null, b.kuendigung_eingereicht_am || null,
        b.dokument_pfad || null, b.notizen || null, b.aktiv]);
    const created = r.rows[0];
    // Wenn die neue Verwaltung sofort wirksam ist, offene Auslagen nachreichen
    const resent = await maybeResendForVerwaltung(created);
    res.json({ ...created, _nachgereicht: resent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Hilfsfunktion: prueft ob eine Verwaltung wirksam ist und reicht offene Auslagen nach.
async function maybeResendForVerwaltung(v) {
  if (!v || v.aktiv === false) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (v.vertrag_von && String(v.vertrag_von).slice(0, 10) > today) return null;
  if (v.vertrag_bis && String(v.vertrag_bis).slice(0, 10) < today) return null;
  return await resendOffeneAuszahlungenFuerWirksameVerwaltung(v.stweg);
}

// Update
app.put('/api/verwaltungen/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const r = await pool.query(`
      UPDATE verwaltungen SET
        stweg = $1, firma_name = $2, adresse = $3, telefon = $4, email = $5,
        website = $6, oeffnungszeiten = $7,
        plattform_name = $8, plattform_url = $9, plattform_user = $10, plattform_pass = $11,
        vertrag_von = $12, vertrag_bis = $13, kuendigungsfrist_monate = $14, kuendigung_eingereicht_am = $15,
        dokument_pfad = $16, notizen = $17, aktiv = $18, updated_at = NOW()
      WHERE id = $19 RETURNING *
    `, [b.stweg || null, b.firma_name, b.adresse || null, normalizePhone(b.telefon), b.email || null,
        b.website || null, b.oeffnungszeiten || null,
        b.plattform_name || null, b.plattform_url || null, b.plattform_user || null, b.plattform_pass || null,
        b.vertrag_von || null, b.vertrag_bis || null, b.kuendigungsfrist_monate || null, b.kuendigung_eingereicht_am || null,
        b.dokument_pfad || null, b.notizen || null, b.aktiv === false ? false : true, id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const updated = r.rows[0];
    // Wenn die Verwaltung jetzt wirksam ist, offene Auslagen nachreichen
    const resent = await maybeResendForVerwaltung(updated);
    res.json({ ...updated, _nachgereicht: resent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete (hard)
app.delete('/api/verwaltungen/:id', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM verwaltungen WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kontakt-Add
app.post('/api/verwaltungen/:id/kontakte', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const verwId = parseInt(req.params.id);
    const b = req.body || {};
    const r = await pool.query(
      `INSERT INTO verwaltungs_kontakte (verwaltung_id, name, funktion, email, telefon, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0)) RETURNING *`,
      [verwId, b.name, b.funktion || null, b.email || null, normalizePhone(b.telefon), b.sort_order || 0]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kontakt-Update
app.put('/api/verwaltungen/kontakte/:kid', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await pool.query(
      `UPDATE verwaltungs_kontakte SET name=$1, funktion=$2, email=$3, telefon=$4, sort_order=$5
       WHERE id = $6 RETURNING *`,
      [b.name, b.funktion || null, b.email || null, normalizePhone(b.telefon), b.sort_order || 0, parseInt(req.params.kid)]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kontakt-Delete
app.delete('/api/verwaltungen/kontakte/:kid', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    await pool.query('DELETE FROM verwaltungs_kontakte WHERE id = $1', [parseInt(req.params.kid)]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
// Adresse fuer Anschrift mit Zeilenumbruechen formatieren — funktioniert mit
// und ohne Komma. Trennt vor 4-stelliger PLZ und vor "Land" (Schweiz/Deutschland/...).
function formatAdresseAnschrift(adresseStr) {
  if (!adresseStr) return '';
  const esc = escHtml(adresseStr);
  // Variante 1: Komma als Trennzeichen
  if (esc.includes(',')) {
    return esc.split(',').map(s => s.trim()).filter(Boolean).join('<br>');
  }
  // Variante 2: kein Komma → vor PLZ (4-stellig) brechen
  // "Rosenweg 17 4303 Kaiseraugst" → "Rosenweg 17<br>4303 Kaiseraugst"
  return esc.replace(/\s+(\d{4,5}\s+[A-ZÄÖÜ])/g, '<br>$1');
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
  // Optional: nur bestimmte Hausnummern (z.B. STWEG 1 = RW17+18, aber Liste
  // soll nur fuer RW17 generiert werden). haus_filter=[17] oder [13,14].
  // Wenn leer/null → alle Wohnungen der STWEG.
  const hausFilter = (Array.isArray(opts.haus_filter) && opts.haus_filter.length > 0)
    ? opts.haus_filter.map(n => parseInt(n)).filter(n => Number.isFinite(n))
    : null;
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
    // STWEG 8 ist die MEG-Tiefgarage mit ausschliesslich typ='Parkplatz'.
    // Fuer alle anderen STWEGen sind nur Wohnungen + Hobbyraeume relevant
    // (Tiefgarage-Plaetze gehoeren nicht ins Stockwerkeigentum).
    const erlaubteTypen = stweg === 8 ? ['Parkplatz'] : ['Wohnung', 'Hobbyraum'];
    wohnungen = await pool.query(`
      SELECT w.id, w.bezeichnung, w.typ, w.wertquote_zaehler, w.wertquote_nenner
      FROM wohnungen w
      WHERE w.stweg = $1 AND w.typ = ANY($2::text[])
      ORDER BY
        CASE WHEN w.bezeichnung ~ '^P[0-9]+$'
          THEN LPAD(SUBSTRING(w.bezeichnung FROM 2), 4, '0')
          ELSE w.bezeichnung
        END
    `, [stweg, erlaubteTypen]);
    // Haus-Filter anwenden: Hausnummer aus bezeichnung ableiten
    if (hausFilter) {
      wohnungen.rows = wohnungen.rows.filter(w => {
        const nr = rosenwegNrAusBezeichnung(w.bezeichnung);
        return nr && hausFilter.includes(nr);
      });
    }
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
  // Nenner ist normalerweise 1000 (STWEG-Wohnungen) oder 110 (STWEG 8 Tiefgarage).
  // Wir leiten ihn aus den vorhandenen Wohnungen ab — nimm den haeufigsten Nenner.
  const nennerCounts = new Map();
  for (const w of wohnungen.rows) {
    const n = w.wertquote_nenner || 1000;
    nennerCounts.set(n, (nennerCounts.get(n) || 0) + 1);
  }
  const totalWQNenner = [...nennerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1000;
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
    // Einzelbrief: bei einzelOnly (STWEG 8) ALLE Eigentuemer; sonst NUR
    // Eigentuemer mit auswaertiger Adresse — lokale Eigentuemer derselben
    // Einheit bleiben auf der Sammelliste. So bekommt z.B. Salvatore Cali
    // (wohnt Rosenweg 10) keinen Einzelbrief, auch wenn Mit-Eigentuemer
    // Filippo+Lorenza extern wohnen.
    if (einzelOnly || auswaertsAdressen.length > 0) {
      const fallbackAdresse = korrespondenzAdressen[0]
        || (rosenwegNrAusBezeichnung(w.bezeichnung) ? `Rosenweg ${rosenwegNrAusBezeichnung(w.bezeichnung)}, 4303 Kaiseraugst` : '4303 Kaiseraugst');
      const eigKontakte = wInfo.eigentuemer.filter(e => e.name);
      const eigToProcess = einzelOnly
        ? eigKontakte
        : eigKontakte.filter(e => isAuswaerts((e.adresse && e.adresse.trim()) || fallbackAdresse, stweg));
      const briefStartIdx = einzelbriefe.length;
      if (eigKontakte.length === 0) {
        // Keine Eigentuemer hinterlegt → ein Brief an Fallback-Adresse
        einzelbriefe.push({ bezeichnung: w.bezeichnung, eigentuemer: eigNamen, verwalter: verwNamen, adresse: fallbackAdresse, wq_zaehler: w.wertquote_zaehler || 0, wq_nenner: w.wertquote_nenner || 1000 });
      } else if (eigToProcess.length > 0) {
        // Nach Adresse gruppieren — Ehepaare/Gesamteigentum mit gleicher
        // Adresse bekommen einen gemeinsamen Brief.
        const normAdr = a => (a || '').trim().toLowerCase()
          .replace(/[,;.]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
        const byAdr = new Map();
        for (const eig of eigToProcess) {
          const persAdr = (eig.adresse && eig.adresse.trim()) || fallbackAdresse;
          const key = normAdr(persAdr);
          if (!byAdr.has(key)) byAdr.set(key, { adresse: persAdr, namen: [] });
          byAdr.get(key).namen.push(eig.name);
        }
        for (const grp of byAdr.values()) {
          einzelbriefe.push({
            bezeichnung: w.bezeichnung,
            eigentuemer: grp.namen,
            verwalter: verwNamen,
            adresse: grp.adresse,
            wq_zaehler: w.wertquote_zaehler || 0,
            wq_nenner: w.wertquote_nenner || 1000,
          });
        }
      }
      if (!einzelOnly && einzelbriefe.length > briefStartIdx) {
        const briefeFuerWohnung = einzelbriefe.slice(briefStartIdx);
        const liste = briefeFuerWohnung.map(b => b.eigentuemer.join(' & ')).join(' / ');
        const n = briefeFuerWohnung.length;
        adresseZelle += `<div class="auswaerts-marker">📮 ${n} Einzelbrief${n===1?'':'e'} an: ${escHtml(liste)}</div>`;
      }
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

  // ── Haushaltszusammenfassung über Wohnungs-Grenzen hinweg ──────
  // Per-Wohnung haben wir oben bereits Eigentuemer mit gleicher Adresse
  // gruppiert (Ehepaare auf demselben Platz = ein Brief). STWEG 8 hat
  // aber haeufig denselben Haushalt auf MEHREREN Parkplaetzen (Thomas
  // Nijs P50/P64/P70, Esther Fleig P41/P42, etc.). Wir mergen daher
  // nach dem Sammeln noch einmal ueber alle Briefe: gleiche normalisierte
  // Name-Menge + gleiche normalisierte Adresse → ein Brief mit allen
  // Plaetzen kommagetrennt in `bezeichnung`.
  if (einzelbriefe.length > 0) {
    const normAdr = a => (a || '').trim().toLowerCase()
      .replace(/[,;.]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const normName = n => (n || '').trim().toLowerCase().split(/\s+/).sort().join('|');
    const normNameSet = arr => arr.map(normName).sort().join('||');
    const merged = new Map();
    for (const b of einzelbriefe) {
      const key = normNameSet(b.eigentuemer || []) + '###' + normAdr(b.adresse);
      if (!merged.has(key)) {
        merged.set(key, {
          ...b,
          bezeichnungen: [b.bezeichnung],
          wq_total_z: b.wq_zaehler || 0,
          wq_nenner: b.wq_nenner || 1000,
        });
      } else {
        const prev = merged.get(key);
        prev.bezeichnungen.push(b.bezeichnung);
        prev.wq_total_z += (b.wq_zaehler || 0);
        const verwSet = new Set([...(prev.verwalter || []), ...(b.verwalter || [])]);
        prev.verwalter = [...verwSet];
      }
    }
    einzelbriefe.length = 0;
    for (const m of merged.values()) {
      einzelbriefe.push({
        bezeichnung: m.bezeichnungen.join(', '),
        eigentuemer: m.eigentuemer,
        verwalter: m.verwalter,
        adresse: m.adresse,
        wq_zaehler: m.wq_total_z,
        wq_nenner: m.wq_nenner,
      });
    }
  }

  // Total-Zeile
  dataRows += `<tr class="total-row">
    <td><strong>TOTAL</strong></td>
    <td><strong>${totalUnits} Einheiten</strong></td>
    <td></td>
    <td><strong>${totalWQ}/${totalWQNenner}</strong></td>
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
    haus_filter: hausFilter || null,
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
      // Rücklauf-Einträge anlegen (1 pro Brief). Bei einzelOnly: nur Einzelbriefe.
      // Sonst: 1 "Sammelbrief"-Eintrag pro Wohnung + 1 pro Einzelbrief.
      const brieflist = einzelOnly
        ? einzelbriefe.map(e => ({ brief_typ: 'einzel', einheit: e.bezeichnung, empfaenger: e.eigentuemer.join(' & '), adresse: e.adresse }))
        : [
            ...wohnungen.rows.map(w => {
              const wInfo = byWohnung.get(w.id);
              const eigName = (wInfo.eigentuemer.map(e => e.name).filter(Boolean).join(' & ')) || '—';
              return { brief_typ: 'sammel', einheit: w.bezeichnung, empfaenger: eigName, adresse: 'Sammelliste' };
            }),
            ...einzelbriefe.map(e => ({ brief_typ: 'einzel', einheit: e.bezeichnung, empfaenger: e.eigentuemer.join(' & '), adresse: e.adresse })),
          ];
      // Erst alte Eintraege fuer diesen hash loeschen, dann neu (bei Re-Generation)
      await pool.query('DELETE FROM unterschriftenliste_rueckläufe WHERE snapshot_hash = $1', [hash]);
      for (let i = 0; i < brieflist.length; i++) {
        const b = brieflist[i];
        await pool.query(
          `INSERT INTO unterschriftenliste_rueckläufe (snapshot_hash, brief_idx, brief_typ, einheit, empfaenger_name, empfaenger_adresse)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [hash, i + 1, b.brief_typ, b.einheit, b.empfaenger, b.adresse]
        );
      }
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
    // WQ kommt direkt aus dem (ggf. gemergten) Brief; bei Mehrfach-Plaetzen
    // ist e.wq_zaehler bereits die Summe aller Einheiten dieses Haushalts.
    const wq = (e.wq_zaehler && e.wq_nenner) ? `${e.wq_zaehler}/${e.wq_nenner}` : '—';
    const plaetzeArr = (e.bezeichnung || '').split(',').map(s => s.trim()).filter(Boolean);
    const einheitLabel = plaetzeArr.length > 1
      ? `den Einheiten <strong>${escHtml(plaetzeArr.join(', '))}</strong>`
      : `der Einheit <strong>${escHtml(e.bezeichnung)}</strong>`;
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
      <div class="absender">${ruecksendung_an ? escHtml(ruecksendung_an) : 'STWEG-Kooperation Rosenweg · c/o Ausschuss · 4303 Kaiseraugst'}</div>
      <div class="anschrift">
        <strong>${escHtml(empfaenger)}</strong><br>
        ${formatAdresseAnschrift(e.adresse)}
      </div>
      <h2 class="section-title">${escHtml(anlass_titel || 'Unterschriftenliste')}</h2>
      ${anlass_zweck ? `<p class="zweck">${escHtml(anlass_zweck).replace(/\n/g, '<br>')}</p>` : ''}
      ${verwalterLine}
      <p class="hinweis">Sie sind Eigentümer/in ${einheitLabel} (${plaetzeArr.length > 1 ? 'gemeinsame Wertquote' : 'Wertquote'} <strong>${wq}</strong>) in der STWEG ${stweg}, wohnen aber ausserhalb von Rosenweg, Kaiseraugst. Bitte kreuzen Sie unten <strong>JA</strong> oder <strong>NEIN</strong> an, datieren und unterschreiben Sie, und senden Sie das Blatt bis spätestens <strong>${escHtml(ruecksendung_bis || '—')}</strong> zurück${ruecksendung_an ? ` an <strong>${escHtml(ruecksendung_an)}</strong>` : ''}.</p>
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
  /* C5-Couvert Rechtsfenster (DIN 5008 Form B, Schweizer Standard):
     Anschriftenfeld 85x40mm, Position 125mm von links und 45mm von oben
     (auf physischem A4-Papier). @page-Margin oben=18mm, links=16mm wird
     bereits abgezogen, also Position innerhalb des Print-Bereichs:
     left = 125-16 = 109mm, top = 45-18 = 27mm. */
  /* C5-Couvert Rechtsfenster (DIN 5008 Form B):
     Anschriftenfeld 85x40mm bei 125mm/45mm vom Papier-Rand.
     Absender-Mini-Zeile in den oberen 12mm, eigentliche Anschrift
     ab 50mm Page-Top = 32mm im Print-Bereich, sodass auch bei
     2-zeiligem Absender genug Abstand bleibt.
     Mit @page-Margin (18mm/16mm) → left=109mm, top der Anschrift=37mm. */
  /* Absender single-line erzwungen, Empfaenger weiter unten (~50mm vom
     Absender-Top entfernt). DIN 5008 Form B: Anschriftenfeld 45-85mm
     vom Page-Top, Empfaenger ab ca. 55-60mm Page-Top empfohlen. */
  .einzelbrief { position: relative; padding-top: 85mm; }
  .einzelbrief .header { position: absolute; top: 0; left: 0; }
  .einzelbrief .absender { position: absolute; top: 27mm; left: 109mm; width: 85mm; font-size: 7.5pt; color: #444; border-bottom: 1px solid #999; padding-bottom: 1px; margin: 0; line-height: 1.2; max-height: 11mm; overflow: hidden; }
  .einzelbrief .anschrift { position: absolute; top: 42mm; left: 109mm; width: 85mm; height: 25mm; font-size: 11pt; line-height: 1.35; padding: 0; }
  .einzelbrief .anschrift strong { font-weight: 600; }
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
        // WQ direkt aus dem (ggf. gemergten) Brief; bei Mehrfach-Plaetzen
        // ist e.wq_zaehler die Summe aller Einheiten dieses Haushalts.
        const wqStr = (e.wq_zaehler && e.wq_nenner) ? `${e.wq_zaehler}/${e.wq_nenner}` : '—';
        return `<tr><td><strong>${escHtml(e.bezeichnung)}</strong></td><td>${escHtml(e.eigentuemer.join(', '))}${e.verwalter.length>0?'<br><span style=\"font-size:8.5pt;color:#555\">↳ ' + escHtml(e.verwalter.join(', ')) + '</span>':''}</td><td style="text-align:center;font-family:monospace">${wqStr}</td><td style="font-size:9pt">${escHtml(e.adresse)}</td></tr>`;
      }).join('')}
      <tr class="total-row"><td><strong>TOTAL</strong></td><td><strong>${totalUnits} Einheiten</strong></td><td style="text-align:center"><strong>${totalWQ}/${totalWQNenner}</strong></td><td></td></tr>
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

// GET /api/unterschriftenliste/:stweg/haeuser — Liste aller in dieser STWEG belegten Hausnummern,
// damit das UI Auswahl-Optionen zeigen kann (z.B. "Nur RW17", "Nur RW18", "RW17+18").
app.get('/api/unterschriftenliste/:stweg/haeuser', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), async (req, res) => {
  try {
    const stweg = parseStweg(req.params.stweg);
    if (!stweg) return res.status(400).json({ error: 'Ungültige STWEG' });
    const r = await pool.query(`SELECT bezeichnung FROM wohnungen WHERE stweg=$1 AND typ IN ('Wohnung','Hobbyraum')`, [stweg]);
    const counts = new Map();
    for (const row of r.rows) {
      const nr = rosenwegNrAusBezeichnung(row.bezeichnung);
      if (nr) counts.set(nr, (counts.get(nr) || 0) + 1);
    }
    const haeuser = [...counts.entries()].sort((a,b) => a[0]-b[0]).map(([nr, count]) => ({ nr, count }));
    res.json({ stweg, haeuser });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// GET /api/unterschriftenliste/:hash/rueckläufe — Liste aller Briefe + Rücklauf-Status
app.get('/api/unterschriftenliste/:hash/rueckläufe', authMiddleware, requirePermission('wohnungsverwaltung', 'read'), async (req, res) => {
  try {
    const hash = req.params.hash.toUpperCase();
    const snap = await pool.query(
      'SELECT hash, stweg, datum, anlass_titel, generated_at FROM unterschriftenliste_snapshots WHERE hash = $1',
      [hash]
    );
    if (snap.rows.length === 0) return res.status(404).json({ error: 'Snapshot nicht gefunden' });
    const briefe = await pool.query(`
      SELECT brief_idx, brief_typ, einheit, empfaenger_name, empfaenger_adresse,
             retourniert_am, vote, notiz, erfasst_von, updated_at
      FROM unterschriftenliste_rueckläufe
      WHERE snapshot_hash = $1
      ORDER BY brief_idx
    `, [hash]);
    const stats = {
      total: briefe.rows.length,
      retourniert: briefe.rows.filter(b => b.retourniert_am).length,
      ja: briefe.rows.filter(b => b.vote === 'ja').length,
      nein: briefe.rows.filter(b => b.vote === 'nein').length,
      enthaltung: briefe.rows.filter(b => b.vote === 'enthaltung').length,
      offen: briefe.rows.filter(b => !b.retourniert_am).length,
    };
    res.json({ snapshot: snap.rows[0], briefe: briefe.rows, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/unterschriftenliste/:hash/rueckläufe/:idx — Rücklauf-Eintrag aktualisieren
app.put('/api/unterschriftenliste/:hash/rueckläufe/:idx', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), async (req, res) => {
  try {
    const hash = req.params.hash.toUpperCase();
    const idx = parseInt(req.params.idx);
    const { retourniert_am, vote, notiz } = req.body;
    const validVote = ['ja', 'nein', 'enthaltung', null].includes(vote) ? vote : null;
    const me = req.user?.email || req.user?.name || 'unknown';
    const r = await pool.query(`
      UPDATE unterschriftenliste_rueckläufe
      SET retourniert_am = $1, vote = $2, notiz = $3, erfasst_von = $4, updated_at = NOW()
      WHERE snapshot_hash = $5 AND brief_idx = $6
      RETURNING *
    `, [retourniert_am || null, validVote, notiz || null, me, hash, idx]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Brief nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
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
    // Optionaler Haus-Filter (kommagetrennt, z.B. "17" oder "13,14")
    let hausFilter = null;
    if (req.query.haus) {
      hausFilter = String(req.query.haus).split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));
      if (hausFilter.length === 0) hausFilter = null;
    }
    const opts = {
      datum: req.query.datum || new Date().toISOString().slice(0, 10),
      anlass_titel: req.query.anlass_titel || 'Unterschriftenliste',
      anlass_zweck: req.query.anlass_zweck || '',
      ruecksendung_bis: req.query.ruecksendung_bis || '',
      ruecksendung_an: req.query.ruecksendung_an || '',
      zeichnungsberechtigte: zeichner,
      kollektiv_text: req.query.kollektiv_text || '',
      haus_filter: hausFilter,
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

// GET /api/wohnungen/:stweg/:id/historie - Archivierte Kontakte (Technik/Praesident/Ausschuss/Verwaltung)
app.get('/api/wohnungen/:stweg/:id/historie', authMiddleware, requireStwegAccess, canViewKontakteHistory, async (req, res) => {
  try {
    const wId = parseInt(req.params.id, 10);
    if (!Number.isFinite(wId) || wId < 1) return res.status(400).json({ error: 'Ungültige Wohnungs-ID' });
    const stweg = parseStweg(req.params.stweg);
    const wRes = await pool.query('SELECT id, stweg, bezeichnung FROM wohnungen WHERE id = $1', [wId]);
    if (wRes.rows.length === 0 || wRes.rows[0].stweg !== stweg) return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    const kRes = await pool.query(
      `SELECT id, rolle, name, email, telefon, adresse, gueltig_ab, archiviert_am, created_at
         FROM wohnungen_kontakte
        WHERE wohnung_id = $1 AND archiviert_am IS NOT NULL
        ORDER BY archiviert_am DESC, rolle, id`,
      [wId]
    );
    res.json({ wohnung: wRes.rows[0], historie: kRes.rows });
  } catch (err) {
    console.error('Historie error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Historie' });
  }
});

// POST /api/wohnungen/:stweg/:id/kontakte/:kid/archive - Einzelnen Kontakt archivieren
app.post('/api/wohnungen/:stweg/:id/kontakte/:kid/archive', authMiddleware, requirePermission('wohnungsverwaltung', 'write'), requireStwegAccess, async (req, res) => {
  try {
    const stweg = parseStweg(req.params.stweg);
    const wId = parseInt(req.params.id, 10);
    const kId = parseInt(req.params.kid, 10);
    if (!Number.isFinite(wId) || !Number.isFinite(kId)) return res.status(400).json({ error: 'Ungültige IDs' });
    const k = await pool.query('SELECT k.name, k.rolle, w.bezeichnung FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id WHERE k.id = $1', [kId]);
    const info = k.rows[0] || {};
    const r = await pool.query(
      `UPDATE wohnungen_kontakte SET archiviert_am = CURRENT_DATE
         WHERE id = $1 AND wohnung_id = $2 AND archiviert_am IS NULL
       RETURNING id`,
      [kId, wId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden oder bereits archiviert' });
    res.json({ ok: true });
    recordObjektChange(stweg, `${info.rolle === 'eigentuemer' ? 'Eigentuemer' : 'Mieter'} "${info.name}" aus Wohnung "${info.bezeichnung}" archiviert (Wegzug)`, req.user.email).catch(() => {});
  } catch (err) {
    console.error('Archive error:', err);
    res.status(500).json({ error: 'Fehler beim Archivieren' });
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
    // Verwaltung informieren
    recordObjektChange(stweg, `Neue Wohnung "${wohnung.bezeichnung}" angelegt`, req.user.email).catch(() => {});
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
    // Verwaltung informieren
    recordObjektChange(stweg, `Wohnung "${wohnung.bezeichnung}" aktualisiert (Bewohner/Daten)`, req.user.email).catch(() => {});
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
    const stweg = parseStweg(req.params.stweg);
    const w = await pool.query('SELECT bezeichnung FROM wohnungen WHERE id = $1 AND stweg = $2', [req.params.id, stweg]);
    const bez = w.rows[0]?.bezeichnung || `#${req.params.id}`;
    const result = await pool.query('DELETE FROM wohnungen WHERE id = $1 AND stweg = $2 RETURNING id', [req.params.id, stweg]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Wohnung nicht gefunden' });
    res.json({ success: true });
    recordObjektChange(stweg, `Wohnung "${bez}" geloescht`, req.user.email).catch(() => {});
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
  const { stweg, name, email_address, members, active, reply_to, subject_prefix, group_name, group_names, allowed_sender_groups,
          whatsapp_group_id, whatsapp_group_name } = req.body;
  try {
    const groups = group_names?.length ? group_names : (group_name ? [group_name] : []);
    const allowedSenders = Array.isArray(allowed_sender_groups) ? allowed_sender_groups : [];
    const result = await pool.query(
      `UPDATE email_verteiler SET stweg=$1, name=$2, email_address=$3, members=$4, active=$5,
              reply_to=$6, subject_prefix=$7, group_name=$8, group_names=$9, allowed_sender_groups=$10,
              whatsapp_group_id=$11, whatsapp_group_name=$12
       WHERE id=$13 RETURNING *`,
      [stweg, name, email_address, JSON.stringify(members || []), active !== false, reply_to || 'sender', subject_prefix || null, groups[0] || null, JSON.stringify(groups), JSON.stringify(allowedSenders),
       whatsapp_group_id || null, whatsapp_group_name || null,
       req.params.id]
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
    // Wartungen als virtuelle Events einmischen (aktive Vertraege mit naechster_termin
    // dieser STWEG oder ohne STWEG-Zuordnung, ab heute - 7 Tage bis +365)
    let wartungEvents = [];
    try {
      const wartungen = await pool.query(
        `SELECT v.id, v.titel, v.beschreibung, v.naechster_termin, v.frequenz_einheit, v.frequenz_intervall,
                v.handwerker_id, h.firma, h.kategorie
           FROM handwerker_vertraege v
           JOIN handwerker h ON h.id = v.handwerker_id
          WHERE v.status = 'aktiv'
            AND v.naechster_termin IS NOT NULL
            AND (v.stweg = $1 OR v.stweg IS NULL)
            AND v.naechster_termin BETWEEN CURRENT_DATE - INTERVAL '7 days' AND CURRENT_DATE + INTERVAL '365 days'
            AND h.archiviert = false
          ORDER BY v.naechster_termin`,
        [stweg]
      );
      wartungEvents = wartungen.rows.map(v => ({
        id: `wartung-${v.id}`,
        title: `🔧 ${v.titel}`,
        description: `${v.beschreibung || ''}${v.beschreibung ? '\n' : ''}${v.firma} (${v.kategorie})`.trim(),
        start: v.naechster_termin,
        end: null,
        location: null,
        category: 'wartung',
        all_day: true,
        source: 'wartung',
        handwerker_id: v.handwerker_id,
        vertrag_id: v.id,
      }));
    } catch (wErr) {
      console.error('Wartungs-Events Merge error:', wErr.message);
    }
    // Merge and sort by date
    const all = [...stwegEvents, ...globalEvents, ...wartungEvents].sort((a, b) => new Date(a.start) - new Date(b.start));
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

// ═══════════════════════════════════════════════════════════════════
// BRIEFE TRACKING — Versendete Briefe, Empfaenger via OpenRouter Vision
// ═══════════════════════════════════════════════════════════════════

const BRIEFE_DIR = 'allgemein/fotos_von_versendeten_briefen';
// WebStamp-Tracking-Format: 98.01.018499.705XXXXX (8-stellige laufende Nr, beginnt mit 705)
const TRACKING_PREFIX_DOTTED = '98.01.018499.705';
const TRACKING_PREFIX_PLAIN = '9801018499705';

function parseBriefFilename(filename) {
  const m = filename.match(/^(.+)-(\d{5})\.(jpe?g|png)$/i);
  if (!m) return null;
  const nameSlug = m[1];
  const tracking5 = m[2];
  const display = nameSlug
    .replace(/-und-/g, ' & ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  return {
    filename,
    name: display,
    nameSlug,
    tracking5,
    trackingDotted: `${TRACKING_PREFIX_DOTTED}${tracking5}`,
    trackingPlain: `${TRACKING_PREFIX_PLAIN}${tracking5}`,
  };
}

function nameToSlug(name) {
  return String(name)
    .replace(/&/g, ' und ')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .toLowerCase();
}

// GET /api/briefe — Alle Brief-Fotos im Ordner mit geparsten Tracking-Nummern
app.get('/api/briefe', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const dir = pathModule.join(DOCS_PATH, BRIEFE_DIR);
    let files;
    try { files = await fs.readdir(dir); }
    catch (e) {
      if (e.code === 'ENOENT') return res.json({ briefe: [], dir: BRIEFE_DIR });
      throw e;
    }
    const briefe = [];
    for (const f of files) {
      const parsed = parseBriefFilename(f);
      if (!parsed) continue;
      try {
        const stat = await fs.stat(pathModule.join(dir, f));
        briefe.push({ ...parsed, mtime: stat.mtime.toISOString(), size: stat.size });
      } catch {}
    }
    briefe.sort((a, b) => b.tracking5.localeCompare(a.tracking5));
    res.json({ briefe, dir: BRIEFE_DIR });
  } catch (err) {
    console.error('[Briefe-List]', err.message);
    res.status(500).json({ error: 'Liste konnte nicht geladen werden' });
  }
});

// POST /api/briefe/upload — Foto hochladen, OCR via Haiku 4.5, umbenennen, ablegen
// Body: { bild_base64, bild_filename }
app.post('/api/briefe/upload', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const { bild_base64, bild_filename } = req.body || {};
    if (!bild_base64) return res.status(400).json({ error: 'bild_base64 fehlt' });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    const ext = (bild_filename || 'jpeg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!['jpg', 'jpeg', 'png'].includes(ext)) return res.status(400).json({ error: 'Nur JPG/PNG erlaubt' });
    const buf = Buffer.from(bild_base64, 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu gross (>15MB)' });
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${bild_base64}`;

    const systemPrompt = `Du extrahierst Empfaenger und Tracking aus dem Foto eines Schweizer WebStamp-Couverts (A-Post Plus).
Antworte AUSSCHLIESSLICH mit gueltigem JSON, keine Markdown-Codebloecke, kein erklaerender Text.

Schema:
{
  "tracking": string|null,    // Volle Tracking-Nr unter dem Barcode, Format "98.01.018499.705XXXXX". 8 Ziffern beginnend mit 705.
  "empfaenger": string|null,  // Vollstaendiger Empfaenger-Name (Person ODER Firma), z.B. "Roland Britt" oder "Ulrich Brueckner & Christine Brueckner" oder "Peker Holding AG"
  "strasse": string|null,
  "plz": string|null,
  "ort": string|null
}

WICHTIG: Der Empfaenger ist NICHT Joerg Herrmann / Rosenweg 14 (das ist der Absender). Lies das Empfaenger-Adressfeld.
Wenn ein Feld nicht erkennbar ist, setze null.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Brief-Tracking-OCR',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Extrahiere Empfaenger und Tracking aus diesem Brief-Foto.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      console.error('[Briefe-OCR] OpenRouter error', orRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})` });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[Briefe-OCR] JSON-Parse fehlgeschlagen:', jsonText.slice(0, 300));
      return res.status(502).json({ error: 'OCR-Antwort ist kein gueltiges JSON', raw: content });
    }

    const trackDigits = String(parsed.tracking || '').replace(/\D/g, '');
    const tail8 = trackDigits.slice(-8);
    if (!/^705\d{5}$/.test(tail8)) {
      return res.status(422).json({ error: 'Tracking-Nr nicht erkannt oder Format unerwartet', ocr: parsed });
    }
    const tracking5 = tail8.slice(-5);

    if (!parsed.empfaenger || typeof parsed.empfaenger !== 'string') {
      return res.status(422).json({ error: 'Empfaenger nicht erkannt', ocr: parsed });
    }
    const nameSlug = nameToSlug(parsed.empfaenger);
    if (!nameSlug) return res.status(422).json({ error: 'Empfaenger nicht in Dateiname konvertierbar' });

    const newFilename = `${nameSlug}-${tracking5}.jpeg`;
    const dir = pathModule.join(DOCS_PATH, BRIEFE_DIR);
    await fs.mkdir(dir, { recursive: true });
    const newPath = pathModule.join(dir, newFilename);
    try {
      await fs.access(newPath);
      return res.status(409).json({
        error: `Datei existiert bereits: ${newFilename}`,
        filename: newFilename, ocr: parsed,
      });
    } catch {}

    await fs.writeFile(newPath, buf);
    res.json({
      success: true,
      filename: newFilename,
      tracking5,
      trackingDotted: `${TRACKING_PREFIX_DOTTED}${tracking5}`,
      trackingPlain: `${TRACKING_PREFIX_PLAIN}${tracking5}`,
      empfaenger: parsed.empfaenger,
      strasse: parsed.strasse,
      plz: parsed.plz,
      ort: parsed.ort,
      model: orJson.model,
    });
  } catch (err) {
    console.error('[Briefe-Upload]', err.message);
    res.status(500).json({ error: err.message });
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

// PUT /api/projects/:slug/budget — Budget setzen (Ausschuss/Technik)
app.put('/api/projects/:slug/budget', authMiddleware, requireAusschussOrTechnik, async (req, res) => {
  try {
    const budget = req.body?.budget_chf;
    const warnPct = req.body?.budget_warnung_pct;
    const budgetVal = budget === null || budget === '' ? null : Number(budget);
    if (budgetVal !== null && (!Number.isFinite(budgetVal) || budgetVal < 0)) {
      return res.status(400).json({ error: 'budget_chf muss >= 0 oder null sein' });
    }
    const warnVal = warnPct === null || warnPct === undefined || warnPct === '' ? 80 : parseInt(warnPct, 10);
    if (!Number.isFinite(warnVal) || warnVal < 0 || warnVal > 100) {
      return res.status(400).json({ error: 'budget_warnung_pct muss 0-100 sein' });
    }
    const { rows: [row] } = await pool.query(
      'UPDATE projects SET budget_chf = $1, budget_warnung_pct = $2, updated_at = NOW() WHERE slug = $3 RETURNING slug, budget_chf, budget_warnung_pct',
      [budgetVal, warnVal, req.params.slug],
    );
    if (!row) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const [candidates, timeline, comments, attachments, auslagenSumme] = await Promise.all([
      pool.query('SELECT * FROM project_candidates WHERE project_id = $1 ORDER BY sort_order, name', [project.id]),
      pool.query('SELECT * FROM project_timeline WHERE project_id = $1 ORDER BY datum', [project.id]),
      pool.query('SELECT * FROM project_comments WHERE project_id = $1 ORDER BY created_at DESC', [project.id]),
      pool.query('SELECT * FROM project_attachments WHERE project_slug = $1 ORDER BY created_at', [req.params.slug]),
      pool.query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(betrag_chf), 0)::numeric AS summe
           FROM auslagen WHERE projekt_slug = $1 GROUP BY status`,
        [req.params.slug],
      ),
    ]);
    const auslagenStat = { total_count: 0, total_chf: 0, by_status: {} };
    for (const r of auslagenSumme.rows) {
      auslagenStat.by_status[r.status] = { count: r.n, summe: Number(r.summe) };
      auslagenStat.total_count += r.n;
      auslagenStat.total_chf += Number(r.summe);
    }
    res.json({
      ...project,
      candidates: candidates.rows, timeline: timeline.rows, comments: comments.rows, attachments: attachments.rows,
      auslagen_stat: auslagenStat,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:slug/auslagen — alle Auslagen eines Projekts mit Summen
app.get('/api/projects/:slug/auslagen', authMiddleware, requireEigentuemer, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.user_email, a.user_name, a.stweg, a.datum, a.kategorie, a.beschreibung,
              a.betrag_chf, a.status, a.bearbeitet_am, a.ausbezahlt_am, a.created_at
         FROM auslagen a WHERE a.projekt_slug = $1
        ORDER BY a.created_at DESC`,
      [req.params.slug],
    );
    const summe = await pool.query(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(betrag_chf), 0)::numeric AS s
         FROM auslagen WHERE projekt_slug = $1 GROUP BY status`,
      [req.params.slug],
    );
    const by_status = {};
    for (const row of summe.rows) by_status[row.status] = { count: row.n, summe: Number(row.s) };
    res.json({ auslagen: r.rows, by_status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/projects-mini — kompakte Liste fuer Dropdowns (kein Eigentuemer-Check, alle eingeloggten User)
app.get('/api/projects-mini', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT slug, title FROM projects WHERE COALESCE(status,'aktiv') != 'archiviert' ORDER BY title`);
    res.json({ projekte: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ─── Handwerker- / Lieferantenliste ────────────────────────────────
async function loadHandwerkerEventZuweisungen(handwerkerIds) {
  if (!Array.isArray(handwerkerIds) || handwerkerIds.length === 0) return {};
  const result = await pool.query(
    `SELECT z.*, t.name AS event_name, t.icon AS event_icon
       FROM handwerker_event_zuweisungen z
       JOIN handwerker_event_typen t ON t.id = z.event_typ_id
      WHERE z.handwerker_id = ANY($1)
      ORDER BY z.handwerker_id, t.sort_order, t.name, z.prioritaet`,
    [handwerkerIds]
  );
  const map = {};
  for (const z of result.rows) {
    if (!map[z.handwerker_id]) map[z.handwerker_id] = [];
    map[z.handwerker_id].push(z);
  }
  return map;
}

async function saveHandwerkerEventZuweisungen(client, handwerkerId, zuweisungen) {
  if (!Array.isArray(zuweisungen)) return;
  const trim = (v) => (v == null ? null : String(v).trim() || null);
  await client.query('DELETE FROM handwerker_event_zuweisungen WHERE handwerker_id = $1', [handwerkerId]);
  for (const z of zuweisungen) {
    const eventId = parseInt(z.event_typ_id, 10);
    if (!Number.isFinite(eventId)) continue;
    const prio = parseInt(z.prioritaet, 10);
    const stweg = z.stweg == null || z.stweg === '' ? null : parseInt(z.stweg, 10);
    await client.query(
      `INSERT INTO handwerker_event_zuweisungen (event_typ_id, handwerker_id, prioritaet, stweg, hinweis)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, handwerkerId,
       Number.isFinite(prio) && prio >= 1 ? prio : 1,
       Number.isFinite(stweg) && stweg >= 1 && stweg <= 8 ? stweg : null,
       trim(z.hinweis)]
    );
  }
}

async function loadHandwerkerPersonen(handwerkerIds) {
  if (!Array.isArray(handwerkerIds) || handwerkerIds.length === 0) return {};
  const result = await pool.query(
    `SELECT * FROM handwerker_personen
       WHERE handwerker_id = ANY($1)
       ORDER BY handwerker_id, sort_order, id`,
    [handwerkerIds]
  );
  const map = {};
  for (const p of result.rows) {
    if (!map[p.handwerker_id]) map[p.handwerker_id] = [];
    map[p.handwerker_id].push(p);
  }
  return map;
}

async function saveHandwerkerPersonen(client, handwerkerId, personen) {
  if (!Array.isArray(personen)) return;
  const trim = (v) => (v == null ? null : String(v).trim() || null);
  const incoming = personen
    .map((p, idx) => ({ ...p, _idx: idx }))
    .filter(p => p && trim(p.name));

  const exRes = await client.query(
    'SELECT id FROM handwerker_personen WHERE handwerker_id = $1',
    [handwerkerId]
  );
  const existingIds = new Set(exRes.rows.map(r => r.id));
  const incomingIds = new Set(
    incoming.map(p => parseInt(p.id, 10)).filter(n => Number.isFinite(n))
  );
  const toDelete = [...existingIds].filter(id => !incomingIds.has(id));
  if (toDelete.length > 0) {
    await client.query('DELETE FROM handwerker_personen WHERE id = ANY($1)', [toDelete]);
  }

  for (const p of incoming) {
    const data = [
      trim(p.rolle),
      trim(p.name),
      trim(p.email),
      trim(p.telefon),
      trim(p.mobile),
      trim(p.notiz),
      p._idx,
    ];
    const pid = parseInt(p.id, 10);
    if (Number.isFinite(pid) && existingIds.has(pid)) {
      await client.query(
        `UPDATE handwerker_personen
            SET rolle=$1, name=$2, email=$3, telefon=$4, mobile=$5, notiz=$6, sort_order=$7
          WHERE id=$8 AND handwerker_id=$9`,
        [...data, pid, handwerkerId]
      );
    } else {
      await client.query(
        `INSERT INTO handwerker_personen
           (handwerker_id, rolle, name, email, telefon, mobile, notiz, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [handwerkerId, ...data]
      );
    }
  }
}

app.get('/api/handwerker', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1';
    const kategorie = (req.query.kategorie || '').trim();
    const where = [];
    const params = [];
    if (!includeArchived) where.push('archiviert = false');
    if (kategorie) { params.push(kategorie); where.push(`kategorie = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM handwerker ${whereSql} ORDER BY archiviert ASC, kategorie ASC, firma ASC`,
      params
    );
    const ids = result.rows.map(r => r.id);
    const personenMap = await loadHandwerkerPersonen(ids);
    const zuwMap = await loadHandwerkerEventZuweisungen(ids);
    for (const r of result.rows) {
      r.personen = personenMap[r.id] || [];
      r.event_zuweisungen = zuwMap[r.id] || [];
    }
    res.json({ handwerker: result.rows });
  } catch (err) {
    console.error('Handwerker list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Handwerker' });
  }
});

app.get('/api/handwerker/kategorien', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT kategorie, COUNT(*)::int AS anzahl FROM handwerker WHERE archiviert = false GROUP BY kategorie ORDER BY kategorie`
    );
    res.json({ kategorien: result.rows });
  } catch (err) {
    console.error('Handwerker kategorien error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Kategorien' });
  }
});

function sanitizeHandwerker(b) {
  const trim = (v) => (v == null ? null : String(v).trim() || null);
  const bewertung = b.bewertung == null || b.bewertung === '' ? null : parseInt(b.bewertung, 10);
  let leistungen = null;
  if (Array.isArray(b.leistungen)) {
    leistungen = b.leistungen.map(s => String(s).trim()).filter(Boolean);
  } else if (typeof b.leistungen === 'string') {
    leistungen = b.leistungen.split(',').map(s => s.trim()).filter(Boolean);
  }
  return {
    kategorie: trim(b.kategorie),
    firma: trim(b.firma),
    ansprechpartner: trim(b.ansprechpartner),
    telefon: trim(b.telefon),
    mobile: trim(b.mobile),
    email: trim(b.email),
    website: trim(b.website),
    adresse: trim(b.adresse),
    plz: trim(b.plz),
    ort: trim(b.ort),
    notiz: trim(b.notiz),
    bewertung: Number.isInteger(bewertung) && bewertung >= 1 && bewertung <= 5 ? bewertung : null,
    letzter_auftrag: trim(b.letzter_auftrag),
    empfohlen_von: trim(b.empfohlen_von),
    leistungen: leistungen && leistungen.length > 0 ? leistungen : null,
  };
}

app.post('/api/handwerker', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const h = sanitizeHandwerker(req.body || {});
    if (!h.kategorie || !h.firma) return res.status(400).json({ error: 'Kategorie und Firma sind Pflichtfelder' });
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO handwerker (kategorie, firma, ansprechpartner, telefon, mobile, email, website,
         adresse, plz, ort, notiz, bewertung, letzter_auftrag, empfohlen_von, leistungen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [h.kategorie, h.firma, h.ansprechpartner, h.telefon, h.mobile, h.email, h.website,
       h.adresse, h.plz, h.ort, h.notiz, h.bewertung, h.letzter_auftrag, h.empfohlen_von, h.leistungen]
    );
    const created = result.rows[0];
    await saveHandwerkerPersonen(client, created.id, req.body && req.body.personen);
    if (req.body && Array.isArray(req.body.event_zuweisungen)) {
      await saveHandwerkerEventZuweisungen(client, created.id, req.body.event_zuweisungen);
    }
    await client.query('COMMIT');
    const personenMap = await loadHandwerkerPersonen([created.id]);
    const zuwMap = await loadHandwerkerEventZuweisungen([created.id]);
    created.personen = personenMap[created.id] || [];
    created.event_zuweisungen = zuwMap[created.id] || [];
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Handwerker create error:', err);
    res.status(500).json({ error: 'Fehler beim Anlegen' });
  } finally {
    client.release();
  }
});

app.put('/api/handwerker/:id', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID' });
    const h = sanitizeHandwerker(req.body || {});
    if (!h.kategorie || !h.firma) return res.status(400).json({ error: 'Kategorie und Firma sind Pflichtfelder' });
    const archivedFlag = req.body && typeof req.body.archiviert === 'boolean' ? req.body.archiviert : null;
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE handwerker SET
         kategorie=$1, firma=$2, ansprechpartner=$3, telefon=$4, mobile=$5, email=$6, website=$7,
         adresse=$8, plz=$9, ort=$10, notiz=$11, bewertung=$12, letzter_auftrag=$13, empfohlen_von=$14,
         leistungen=$15,
         archiviert = COALESCE($16, archiviert),
         updated_at = NOW()
       WHERE id=$17 RETURNING *`,
      [h.kategorie, h.firma, h.ansprechpartner, h.telefon, h.mobile, h.email, h.website,
       h.adresse, h.plz, h.ort, h.notiz, h.bewertung, h.letzter_auftrag, h.empfohlen_von,
       h.leistungen, archivedFlag, id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    }
    if (req.body && Array.isArray(req.body.personen)) {
      await saveHandwerkerPersonen(client, id, req.body.personen);
    }
    if (req.body && Array.isArray(req.body.event_zuweisungen)) {
      await saveHandwerkerEventZuweisungen(client, id, req.body.event_zuweisungen);
    }
    await client.query('COMMIT');
    const updated = result.rows[0];
    const personenMap = await loadHandwerkerPersonen([id]);
    const zuwMap = await loadHandwerkerEventZuweisungen([id]);
    updated.personen = personenMap[id] || [];
    updated.event_zuweisungen = zuwMap[id] || [];
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Handwerker update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  } finally {
    client.release();
  }
});

// Auftraege pro Handwerker
async function syncLetzterAuftrag(client, handwerkerId) {
  await client.query(
    `UPDATE handwerker SET
       letzter_auftrag = (SELECT MAX(datum) FROM handwerker_auftraege WHERE handwerker_id = $1),
       updated_at = NOW()
     WHERE id = $1`,
    [handwerkerId]
  );
}

// Bei Auftrag mit vertrag_id: naechster_termin neu berechnen aus letztem Auftrag + frequenz
const FREQUENZ_PG_UNIT = { tage: 'days', wochen: 'weeks', monate: 'months', jahre: 'years' };
async function recomputeNaechsterTermin(client, vertragId) {
  if (!Number.isFinite(vertragId)) return;
  const v = await client.query('SELECT frequenz_einheit, frequenz_intervall FROM handwerker_vertraege WHERE id = $1', [vertragId]);
  if (v.rows.length === 0) return;
  const { frequenz_einheit, frequenz_intervall } = v.rows[0];
  const unit = FREQUENZ_PG_UNIT[frequenz_einheit];
  if (!unit || !frequenz_intervall || frequenz_intervall < 1) {
    await client.query('UPDATE handwerker_vertraege SET naechster_termin = NULL WHERE id = $1', [vertragId]);
    return;
  }
  const last = await client.query(
    'SELECT MAX(datum) AS last FROM handwerker_auftraege WHERE vertrag_id = $1',
    [vertragId]
  );
  if (!last.rows[0]?.last) return;
  await client.query(
    `UPDATE handwerker_vertraege
        SET naechster_termin = ($1::date + $2::interval)::date,
            updated_at = NOW()
      WHERE id = $3`,
    [last.rows[0].last, `${frequenz_intervall} ${unit}`, vertragId]
  );
}

// Vertraege pro Handwerker
function sanitizeVertrag(b) {
  const trim = (v) => (v == null ? null : String(v).trim() || null);
  const intvl = b.frequenz_intervall == null || b.frequenz_intervall === '' ? null : parseInt(b.frequenz_intervall, 10);
  const kosten = b.jahres_kosten_chf == null || b.jahres_kosten_chf === '' ? null : parseFloat(b.jahres_kosten_chf);
  const kuendFrist = b.kuendigungsfrist_tage == null || b.kuendigungsfrist_tage === '' ? null : parseInt(b.kuendigungsfrist_tage, 10);
  const stweg = b.stweg == null || b.stweg === '' ? null : parseInt(b.stweg, 10);
  const einheit = trim(b.frequenz_einheit);
  return {
    titel: trim(b.titel),
    beschreibung: trim(b.beschreibung),
    frequenz_einheit: einheit && FREQUENZ_PG_UNIT[einheit] ? einheit : null,
    frequenz_intervall: Number.isFinite(intvl) && intvl >= 1 ? intvl : null,
    naechster_termin: trim(b.naechster_termin),
    startet_am: trim(b.startet_am),
    endet_am: trim(b.endet_am),
    kuendigungsfrist_tage: Number.isFinite(kuendFrist) && kuendFrist >= 0 ? kuendFrist : null,
    jahres_kosten_chf: Number.isFinite(kosten) ? kosten : null,
    status: ['aktiv','gekuendigt','pausiert'].includes(b.status) ? b.status : 'aktiv',
    vertragsdokument_url: trim(b.vertragsdokument_url),
    notiz: trim(b.notiz),
    stweg: Number.isFinite(stweg) && stweg >= 1 && stweg <= 8 ? stweg : null,
  };
}

app.get('/api/handwerker/:id/vertraege', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige Handwerker-ID' });
    const result = await pool.query(
      `SELECT * FROM handwerker_vertraege WHERE handwerker_id = $1 ORDER BY status ASC, naechster_termin NULLS LAST, titel`,
      [id]
    );
    res.json({ vertraege: result.rows });
  } catch (err) {
    console.error('Vertraege list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Verträge' });
  }
});

app.post('/api/handwerker/:id/vertraege', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige Handwerker-ID' });
    const v = sanitizeVertrag(req.body || {});
    if (!v.titel) return res.status(400).json({ error: 'Titel ist Pflichtfeld' });
    const result = await pool.query(
      `INSERT INTO handwerker_vertraege
         (handwerker_id, titel, beschreibung, frequenz_einheit, frequenz_intervall, naechster_termin,
          startet_am, endet_am, kuendigungsfrist_tage, jahres_kosten_chf, status,
          vertragsdokument_url, notiz, stweg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [id, v.titel, v.beschreibung, v.frequenz_einheit, v.frequenz_intervall, v.naechster_termin,
       v.startet_am, v.endet_am, v.kuendigungsfrist_tage, v.jahres_kosten_chf, v.status,
       v.vertragsdokument_url, v.notiz, v.stweg]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Handwerker nicht gefunden' });
    console.error('Vertrag create error:', err);
    res.status(500).json({ error: 'Fehler beim Anlegen' });
  }
});

app.put('/api/handwerker/:id/vertraege/:vid', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const vid = parseInt(req.params.vid, 10);
    if (!Number.isFinite(id) || !Number.isFinite(vid)) return res.status(400).json({ error: 'Ungültige IDs' });
    const v = sanitizeVertrag(req.body || {});
    if (!v.titel) return res.status(400).json({ error: 'Titel ist Pflichtfeld' });
    const result = await pool.query(
      `UPDATE handwerker_vertraege SET
         titel=$1, beschreibung=$2, frequenz_einheit=$3, frequenz_intervall=$4, naechster_termin=$5,
         startet_am=$6, endet_am=$7, kuendigungsfrist_tage=$8, jahres_kosten_chf=$9, status=$10,
         vertragsdokument_url=$11, notiz=$12, stweg=$13, updated_at=NOW()
       WHERE id=$14 AND handwerker_id=$15 RETURNING *`,
      [v.titel, v.beschreibung, v.frequenz_einheit, v.frequenz_intervall, v.naechster_termin,
       v.startet_am, v.endet_am, v.kuendigungsfrist_tage, v.jahres_kosten_chf, v.status,
       v.vertragsdokument_url, v.notiz, v.stweg, vid, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vertrag nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Vertrag update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

app.delete('/api/handwerker/:id/vertraege/:vid', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const vid = parseInt(req.params.vid, 10);
    if (!Number.isFinite(id) || !Number.isFinite(vid)) return res.status(400).json({ error: 'Ungültige IDs' });
    const result = await pool.query(
      'DELETE FROM handwerker_vertraege WHERE id = $1 AND handwerker_id = $2 RETURNING id',
      [vid, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vertrag nicht gefunden' });
    res.json({ success: true });
  } catch (err) {
    console.error('Vertrag delete error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// Anstehende Wartungen ueber alle Handwerker
app.get('/api/handwerker-vertraege/anstehend', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const result = await pool.query(
      `SELECT v.*, h.firma, h.kategorie
         FROM handwerker_vertraege v
         JOIN handwerker h ON h.id = v.handwerker_id
        WHERE v.status = 'aktiv'
          AND v.naechster_termin IS NOT NULL
          AND v.naechster_termin <= CURRENT_DATE + ($1 || ' days')::interval
          AND h.archiviert = false
        ORDER BY v.naechster_termin ASC, h.firma ASC`,
      [String(days)]
    );
    res.json({ vertraege: result.rows, days });
  } catch (err) {
    console.error('Vertraege anstehend error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der anstehenden Wartungen' });
  }
});

app.get('/api/handwerker/:id/auftraege', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige Handwerker-ID' });
    const result = await pool.query(
      'SELECT * FROM handwerker_auftraege WHERE handwerker_id = $1 ORDER BY datum DESC, id DESC',
      [id]
    );
    res.json({ auftraege: result.rows });
  } catch (err) {
    console.error('Auftraege list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Aufträge' });
  }
});

function sanitizeAuftrag(b) {
  const trim = (v) => (v == null ? null : String(v).trim() || null);
  const kosten = b.kosten == null || b.kosten === '' ? null : parseFloat(b.kosten);
  const stweg = b.stweg == null || b.stweg === '' ? null : parseInt(b.stweg, 10);
  const vertragId = b.vertrag_id == null || b.vertrag_id === '' ? null : parseInt(b.vertrag_id, 10);
  return {
    datum: trim(b.datum),
    beschreibung: trim(b.beschreibung),
    kosten: Number.isFinite(kosten) ? kosten : null,
    stweg: Number.isFinite(stweg) && stweg >= 1 && stweg <= 8 ? stweg : null,
    notiz: trim(b.notiz),
    vertrag_id: Number.isFinite(vertragId) ? vertragId : null,
  };
}

app.post('/api/handwerker/:id/auftraege', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige Handwerker-ID' });
    const a = sanitizeAuftrag(req.body || {});
    if (!a.datum || !a.beschreibung) return res.status(400).json({ error: 'Datum und Beschreibung sind Pflichtfelder' });
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO handwerker_auftraege (handwerker_id, datum, beschreibung, kosten, stweg, notiz, vertrag_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, a.datum, a.beschreibung, a.kosten, a.stweg, a.notiz, a.vertrag_id]
    );
    await syncLetzterAuftrag(client, id);
    if (a.vertrag_id) await recomputeNaechsterTermin(client, a.vertrag_id);
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') return res.status(404).json({ error: 'Handwerker nicht gefunden' });
    console.error('Auftrag create error:', err);
    res.status(500).json({ error: 'Fehler beim Anlegen des Auftrags' });
  } finally {
    client.release();
  }
});

app.put('/api/handwerker/:id/auftraege/:aid', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const aid = parseInt(req.params.aid, 10);
    if (!Number.isFinite(id) || !Number.isFinite(aid)) return res.status(400).json({ error: 'Ungültige IDs' });
    const a = sanitizeAuftrag(req.body || {});
    if (!a.datum || !a.beschreibung) return res.status(400).json({ error: 'Datum und Beschreibung sind Pflichtfelder' });
    await client.query('BEGIN');
    // alten vertrag_id ermitteln, damit wir den vorherigen Vertrag ggf. auch neu rechnen
    const before = await client.query('SELECT vertrag_id FROM handwerker_auftraege WHERE id = $1 AND handwerker_id = $2', [aid, id]);
    const result = await client.query(
      `UPDATE handwerker_auftraege SET datum=$1, beschreibung=$2, kosten=$3, stweg=$4, notiz=$5, vertrag_id=$6
       WHERE id=$7 AND handwerker_id=$8 RETURNING *`,
      [a.datum, a.beschreibung, a.kosten, a.stweg, a.notiz, a.vertrag_id, aid, id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    }
    await syncLetzterAuftrag(client, id);
    const oldVertragId = before.rows[0]?.vertrag_id;
    if (oldVertragId && oldVertragId !== a.vertrag_id) await recomputeNaechsterTermin(client, oldVertragId);
    if (a.vertrag_id) await recomputeNaechsterTermin(client, a.vertrag_id);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Auftrag update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  } finally {
    client.release();
  }
});

app.delete('/api/handwerker/:id/auftraege/:aid', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const aid = parseInt(req.params.aid, 10);
    if (!Number.isFinite(id) || !Number.isFinite(aid)) return res.status(400).json({ error: 'Ungültige IDs' });
    await client.query('BEGIN');
    const before = await client.query('SELECT vertrag_id FROM handwerker_auftraege WHERE id = $1 AND handwerker_id = $2', [aid, id]);
    const result = await client.query(
      'DELETE FROM handwerker_auftraege WHERE id = $1 AND handwerker_id = $2 RETURNING id',
      [aid, id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    }
    await syncLetzterAuftrag(client, id);
    const oldVertragId = before.rows[0]?.vertrag_id;
    if (oldVertragId) await recomputeNaechsterTermin(client, oldVertragId);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Auftrag delete error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  } finally {
    client.release();
  }
});

// Event-Typen (Notfall-Kategorien) CRUD
app.get('/api/handwerker-events', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM handwerker_event_typen ORDER BY sort_order, name');
    res.json({ event_typen: result.rows });
  } catch (err) {
    console.error('Event-Typen list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Event-Typen' });
  }
});

app.post('/api/handwerker-events', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const trim = (v) => (v == null ? null : String(v).trim() || null);
    const name = trim(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name ist Pflichtfeld' });
    const sortOrder = parseInt(req.body?.sort_order, 10);
    const result = await pool.query(
      `INSERT INTO handwerker_event_typen (name, icon, beschreibung, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, trim(req.body?.icon), trim(req.body?.beschreibung), Number.isFinite(sortOrder) ? sortOrder : 999]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Event-Typ mit diesem Namen existiert bereits' });
    console.error('Event-Typ create error:', err);
    res.status(500).json({ error: 'Fehler beim Anlegen' });
  }
});

app.put('/api/handwerker-events/:id', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const trim = (v) => (v == null ? null : String(v).trim() || null);
    const name = trim(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name ist Pflichtfeld' });
    const sortOrder = parseInt(req.body?.sort_order, 10);
    const result = await pool.query(
      `UPDATE handwerker_event_typen
          SET name=$1, icon=$2, beschreibung=$3, sort_order=$4
        WHERE id=$5 RETURNING *`,
      [name, trim(req.body?.icon), trim(req.body?.beschreibung),
       Number.isFinite(sortOrder) ? sortOrder : 999, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event-Typ nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Event-Typ mit diesem Namen existiert bereits' });
    console.error('Event-Typ update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

app.delete('/api/handwerker-events/:id', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const result = await pool.query('DELETE FROM handwerker_event_typen WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event-Typ nicht gefunden' });
    res.json({ success: true });
  } catch (err) {
    console.error('Event-Typ delete error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// Notfall-Übersicht: alle Event-Typen mit zugeordneten Handwerkern (sortiert nach Priorität)
app.get('/api/handwerker-notfall', authMiddleware, requirePermission('handwerker', 'read'), async (req, res) => {
  try {
    const stwegFilter = req.query.stweg ? parseInt(req.query.stweg, 10) : null;
    const events = await pool.query('SELECT * FROM handwerker_event_typen ORDER BY sort_order, name');
    const zuws = await pool.query(`
      SELECT z.*, h.firma, h.kategorie, h.telefon AS h_telefon, h.mobile AS h_mobile, h.email AS h_email,
             h.archiviert AS h_archiviert
        FROM handwerker_event_zuweisungen z
        JOIN handwerker h ON h.id = z.handwerker_id
       WHERE h.archiviert = false
       ORDER BY z.event_typ_id, z.prioritaet, h.firma`);
    const personen = await pool.query(`
      SELECT p.* FROM handwerker_personen p
        JOIN handwerker_event_zuweisungen z ON z.handwerker_id = p.handwerker_id
       ORDER BY p.handwerker_id, p.sort_order, p.id`);
    const personenByHandwerker = {};
    for (const p of personen.rows) {
      if (!personenByHandwerker[p.handwerker_id]) personenByHandwerker[p.handwerker_id] = [];
      personenByHandwerker[p.handwerker_id].push(p);
    }
    const zuwsByEvent = {};
    for (const z of zuws.rows) {
      // STWEG-Filter: leere stweg = gilt fuer alle, sonst nur passend
      if (stwegFilter && z.stweg && z.stweg !== stwegFilter) continue;
      if (!zuwsByEvent[z.event_typ_id]) zuwsByEvent[z.event_typ_id] = [];
      zuwsByEvent[z.event_typ_id].push({
        ...z,
        personen: personenByHandwerker[z.handwerker_id] || [],
      });
    }
    const result = events.rows.map(e => ({
      ...e,
      zuweisungen: zuwsByEvent[e.id] || [],
    }));
    res.json({ events: result });
  } catch (err) {
    console.error('Notfall summary error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Notfall-Übersicht' });
  }
});

app.delete('/api/handwerker/:id', authMiddleware, requirePermission('handwerker', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Ungültige ID' });
    const hard = req.query.hard === '1';
    if (hard) {
      const groups = req.user?.groups || [];
      const isTechnik = groups.some(g => g.toLowerCase() === 'technik');
      if (!isTechnik) return res.status(403).json({ error: 'Hartes Löschen nur für Technik-Gruppe' });
      const result = await pool.query('DELETE FROM handwerker WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
      return res.json({ success: true, hard_deleted: true });
    }
    const result = await pool.query(
      'UPDATE handwerker SET archiviert = true, updated_at = NOW() WHERE id = $1 AND archiviert = false RETURNING id',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden oder bereits archiviert' });
    res.json({ success: true, archived: true });
  } catch (err) {
    console.error('Handwerker delete error:', err);
    res.status(500).json({ error: 'Fehler beim Löschen' });
  }
});

// ─── Auslagen / Vorschuesse ────────────────────────────────────────────
// Eigentuemer reichen verauslagte Betraege ein; Ausschuss/Technik genehmigt
// und markiert als ausbezahlt. Belege werden als Dateien im DOCS-Volume
// unter <stweg-folder>/auslagen/ abgelegt.

const AUSLAGEN_KATEGORIEN = ['Material', 'Reparatur', 'Porto/Versand', 'Verpflegung', 'Reinigung', 'Reisekosten', 'Sonstiges'];
const AUSLAGEN_STATUS = ['eingereicht', 'genehmigt', 'abgelehnt', 'ausbezahlt'];

function auslagenStwegFolder(stweg) {
  const n = parseInt(stweg, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 8) return `stweg${n}`;
  return 'allgemein';
}

// Sucht die zustaendige Verwaltung fuer einen STWEG.
// Reihenfolge:
//   1) Aktive Verwaltung mit passendem stweg
//   2) Aktive Verwaltung mit stweg IS NULL (Kooperations-weit)
//   3) Fallback: Ausschuss des STWEGs (+ Technik) — mit Hinweis "keine Verwaltung hinterlegt"
// Liefert { firma, mailTo, mailCc, fallback }
async function findVerwaltungForStweg(stweg) {
  const stwegInt = parseInt(stweg, 10);
  const stwegVal = Number.isFinite(stwegInt) ? stwegInt : null;
  // L9: kombinierte Query mit LEFT JOIN auf Kontakte. Eine Query statt 2-3.
  // Praezedenz: stweg-spezifisch (rank=1) → uebergreifend (rank=2) → leer (Fallback)
  const r = await pool.query(`
    WITH ranked AS (
      SELECT v.id, v.firma_name, v.email AS firma_email,
             CASE WHEN v.stweg = $1 THEN 1 ELSE 2 END AS rk
        FROM verwaltungen v
       WHERE v.aktiv = true
         AND (v.vertrag_von IS NULL OR v.vertrag_von <= CURRENT_DATE)
         AND (v.vertrag_bis IS NULL OR v.vertrag_bis >= CURRENT_DATE)
         AND ($1::int IS NULL AND v.stweg IS NULL OR v.stweg = $1 OR v.stweg IS NULL)
    ),
    chosen AS (SELECT * FROM ranked ORDER BY rk, id LIMIT 1)
    SELECT c.id, c.firma_name, c.firma_email,
           COALESCE((
             SELECT array_agg(k.email ORDER BY k.sort_order, k.id)
               FROM verwaltungs_kontakte k
              WHERE k.verwaltung_id = c.id AND k.email IS NOT NULL AND k.email <> ''
           ), ARRAY[]::text[]) AS kontakt_emails
      FROM chosen c
  `, [stwegVal]);
  if (r.rows.length > 0) {
    const v = r.rows[0];
    const mailTo = [];
    if (v.firma_email) mailTo.push(v.firma_email);
    const mailCc = (v.kontakt_emails || []).filter(e => e && !mailTo.includes(e));
    if (mailTo.length > 0 || mailCc.length > 0) {
      return { id: v.id, firma: v.firma_name, mailTo, mailCc, fallback: null };
    }
    // Verwaltung existiert, hat aber keine E-Mail → Fallback
  }
  // Fallback: Ausschuss des STWEGs (+ Technik-Gruppe). Aus users.groups_json
  const groupNames = [];
  if (stwegVal && STWEG_GROUPS[stwegVal]?.ausschuss) groupNames.push(STWEG_GROUPS[stwegVal].ausschuss);
  groupNames.push('technik');
  const u = await pool.query(
    `SELECT DISTINCT email FROM users
      WHERE active = true AND email IS NOT NULL AND email <> ''
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(groups_json::jsonb, '[]'::jsonb)) g
          WHERE LOWER(g) = ANY($1::text[])
        )`,
    [groupNames.map(g => g.toLowerCase())],
  );
  const emails = u.rows.map(x => x.email).filter(Boolean);
  if (emails.length === 0) return null;
  return {
    id: null,
    firma: `Ausschuss ${stwegVal ? 'STWEG ' + stwegVal : 'Kooperation'} (KEINE Verwaltung hinterlegt!)`,
    mailTo: emails,
    mailCc: [],
    fallback: 'ausschuss',
  };
}

// ─── Verwaltungs-Mail-Genehmigungs-Queue ─────────────────────────────
// Jede Mail an die externe Verwaltung muss erst von Technik oder Praesident
// freigegeben werden. Inhalt ist in der Queue editierbar.

async function enqueueVerwaltungMail({
  source_type, source_id, mailTo, mailCc, mailReplyTo, subject, bodyText, attachments, createdBy,
}) {
  const toStr = Array.isArray(mailTo) ? mailTo.join(', ') : String(mailTo || '');
  const ccStr = Array.isArray(mailCc) ? mailCc.join(', ') : (mailCc ? String(mailCc) : null);
  // M7: Attachments in separater Tabelle statt JSONB inline (Skalierbarkeit).
  // Legacy attachments-JSONB-Spalte wird mit minimalen Metadaten gefuellt fuer
  // Backward-Compat des GET-Endpoints.
  const attMeta = (attachments || []).map(a => ({
    filename: a.filename,
    size: a.size || (a.content_base64 ? Math.floor(a.content_base64.length * 0.75) : null),
    docs_path: a.docs_path || null,
  }));
  const r = await pool.query(
    `INSERT INTO verwaltung_mail_queue
       (source_type, source_id, mail_to, mail_cc, mail_reply_to, subject, body_text, attachments, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id`,
    [source_type, source_id || null, toStr, ccStr, mailReplyTo || null, subject, bodyText, JSON.stringify(attMeta), createdBy || null],
  );
  const queueId = r.rows[0].id;
  // Real Attachments in separate Tabelle
  for (let i = 0; i < (attachments || []).length; i++) {
    const a = attachments[i];
    if (!a || (!a.docs_path && !a.content_base64)) continue;
    await pool.query(
      `INSERT INTO verwaltung_mail_attachments (queue_id, filename, size_bytes, docs_path, content_base64, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [queueId, a.filename || `anhang-${i+1}`,
       a.size || (a.content_base64 ? Math.floor(a.content_base64.length * 0.75) : null),
       a.docs_path || null, a.content_base64 || null, i],
    );
  }

  // Notification an Technik + Praesident: "Neue Mail wartet auf Freigabe"
  try {
    const approvers = await pool.query(
      `SELECT DISTINCT email FROM users
        WHERE active = true AND email IS NOT NULL AND email <> ''
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(groups_json::jsonb, '[]'::jsonb)) g
            WHERE LOWER(g) IN ('technik','präsident','praesident')
          )`,
    );
    const recipients = approvers.rows.map(r => r.email).filter(Boolean);
    if (recipients.length > 0) {
      const pendingCount = await pool.query(`SELECT COUNT(*) AS cnt FROM verwaltung_mail_queue WHERE status = 'pending'`);
      const cnt = pendingCount.rows[0].cnt;
      await loggedSendMail({
        from: MAIL_FROM,
        to: recipients.join(', '),
        subject: `Verwaltungs-Mail wartet auf Freigabe: ${subject.slice(0, 80)}`,
        text:
          `Eine ausgehende Mail an die Verwaltung wartet auf deine Freigabe.\n\n`
          + `Quelle:   ${source_type}${source_id ? ' #' + source_id : ''}\n`
          + `An:       ${toStr}\n`
          + (ccStr ? `CC:       ${ccStr}\n` : '')
          + `Betreff:  ${subject}\n`
          + `Eingestellt von: ${createdBy || 'system'}\n\n`
          + `Aktuell ${cnt} Mail${cnt === '1' ? '' : 's'} pending.\n\n`
          + `Zur Freigabe / Bearbeitung / Ablehnung:\n${SITE_URL}/verwaltung-mail-outbox.html`,
      }, 'verwaltung-mail-pending');
      // WhatsApp-Push an Approver (kuerzer)
      pushWhatsappBroadcast({
        emails: recipients, sourceType: 'verwaltung-mail-pending', sourceId: queueId,
        body: `📨 *Outbox: ${cnt} Mail${cnt === '1' ? '' : 's'} pending*\n${source_type}${source_id ? ' #' + source_id : ''}\n→ ${subject.slice(0, 80)}\n\nFreigabe: ${SITE_URL}/verwaltung-mail-outbox.html`,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[verwaltung-mail-queue] Notification fehlgeschlagen:', err.message);
  }

  return queueId;
}

// Sendet eine freigegebene Mail aus der Queue.
async function sendVerwaltungMailFromQueue(queueId, approverEmail) {
  const r = await pool.query('SELECT * FROM verwaltung_mail_queue WHERE id = $1', [queueId]);
  if (r.rows.length === 0) throw new Error('Queue-Eintrag nicht gefunden');
  const q = r.rows[0];
  if (q.status !== 'freigegeben') throw new Error(`Status ist '${q.status}', erwartet 'freigegeben'`);

  // M7: Attachments aus separater Tabelle lesen, mit Fallback auf Legacy-JSONB
  const attachments = [];
  const attRows = await pool.query(
    'SELECT * FROM verwaltung_mail_attachments WHERE queue_id = $1 ORDER BY sort_order, id',
    [queueId],
  );
  const attSources = attRows.rows.length > 0 ? attRows.rows : (q.attachments || []);
  for (const a of attSources) {
    if (a.content_base64) {
      attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64') });
    } else if (a.docs_path) {
      try {
        const full = pathModule.join(DOCS_PATH, a.docs_path);
        if (full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) {
          const buf = await fs.readFile(full);
          attachments.push({ filename: a.filename || pathModule.basename(a.docs_path), content: buf });
        }
      } catch (e) {
        console.warn(`[verwaltung-mail-queue ${queueId}] Anhang ${a.docs_path} konnte nicht gelesen werden:`, e.message);
      }
    }
  }

  try {
    await loggedSendMail({
      from: MAIL_FROM,
      to: q.mail_to,
      cc: q.mail_cc || undefined,
      replyTo: q.mail_reply_to || undefined,
      subject: q.subject,
      text: q.body_text,
      attachments,
    }, `vmq-${q.source_type}`);
    await pool.query(
      `UPDATE verwaltung_mail_queue SET status = 'gesendet', sent_at = NOW() WHERE id = $1`,
      [queueId],
    );

    // Source-spezifisches Tracking nachziehen
    if (q.source_type === 'auslage-auszahlung' && q.source_id) {
      const auslageR = await pool.query('SELECT * FROM auslagen WHERE id = $1', [q.source_id]);
      if (auslageR.rows.length > 0) {
        const verw = await findVerwaltungForStweg(auslageR.rows[0].stweg);
        await pool.query(
          `UPDATE auslagen
              SET auszahlung_mail_at = NOW(),
                  auszahlung_mail_to = $1,
                  auszahlung_mail_fallback = $2,
                  auszahlung_mail_verwaltung_id = $3,
                  auszahlung_mail_count = COALESCE(auszahlung_mail_count, 0) + 1,
                  updated_at = NOW()
            WHERE id = $4`,
          [q.mail_to, !!(verw && verw.fallback), verw?.id || null, q.source_id],
        );
      }
    }

    return { ok: true };
  } catch (err) {
    await pool.query(
      `UPDATE verwaltung_mail_queue SET status = 'fehler', send_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 1000), queueId],
    );
    throw err;
  }
}

// Fertige Auszahlungs-E-Mail an die Verwaltung mit allen Details + Beleg-Attachment.
// opts.nachgereicht=true → Betreff/Body markieren als Nach-Reichung an die neue Verwaltung
//                          nach Ende einer Vakanz-Phase.
// Statt direkt zu senden, wird die Mail in die Genehmigungs-Queue gestellt.
async function sendAuszahlungsMail(auslage, ausschussEmail, ausschussName, opts = {}) {
  try {
    const verw = await findVerwaltungForStweg(auslage.stweg);
    if (!verw || verw.mailTo.length === 0) {
      console.warn(`[auslagen] Keine Verwaltung mit E-Mail fuer STWEG ${auslage.stweg || '-'} hinterlegt`);
      return { ok: false, reason: 'keine Verwaltung mit E-Mail hinterlegt' };
    }
    // Projekt-Titel nachladen (auslage hat nur slug)
    if (auslage.projekt_slug && !auslage.projekt_title) {
      const p = await pool.query('SELECT title FROM projects WHERE slug = $1', [auslage.projekt_slug]);
      auslage.projekt_title = p.rows[0]?.title || null;
    }
    const stwegLabel = auslage.stweg ? `STWEG ${auslage.stweg}` : 'STWEG-uebergreifend (Kooperation)';
    const betrag = Number(auslage.betrag_chf).toFixed(2);
    const datum = auslage.datum ? new Date(auslage.datum).toLocaleDateString('de-CH') : '-';
    const today = new Date().toLocaleDateString('de-CH');
    const isNachgereicht = !!opts.nachgereicht;

    // Belege als Anhaenge: alle aus auslagen_belege, mit Fallback auf Legacy-beleg_path
    const queueAttachments = [];
    const belegeRows = await pool.query(
      'SELECT beleg_path, beleg_filename FROM auslagen_belege WHERE auslage_id = $1 ORDER BY sort_order, id',
      [auslage.id],
    );
    for (const b of belegeRows.rows) {
      queueAttachments.push({
        filename: b.beleg_filename || pathModule.basename(b.beleg_path),
        docs_path: b.beleg_path,
      });
    }
    // Legacy: wenn keine multi-belege aber alte beleg_path noch da
    if (queueAttachments.length === 0 && auslage.beleg_path) {
      queueAttachments.push({
        filename: auslage.beleg_filename || pathModule.basename(auslage.beleg_path),
        docs_path: auslage.beleg_path,
      });
    }
    const hasAttachment = queueAttachments.length > 0;

    let subjectPrefix = '';
    if (verw.fallback) subjectPrefix = '⚠ KEINE VERWALTUNG HINTERLEGT — ';
    else if (isNachgereicht) subjectPrefix = '[NACHGEREICHT] ';

    const freigabeAm = auslage.bearbeitet_am
      ? new Date(auslage.bearbeitet_am).toLocaleDateString('de-CH')
      : today;
    const freigebender = auslage.bearbeitet_von || ausschussEmail;

    // Template aus DB versuchen (source_type = 'auslage-auszahlung' bzw. -nachgereicht)
    const sourceTypeForTpl = isNachgereicht ? 'auslage-auszahlung-nachgereicht' : 'auslage-auszahlung';
    const tpl = await findMailTemplate(sourceTypeForTpl, 'verwaltung');
    let subject, text;
    if (tpl) {
      const tplContext = {
        auslage: { ...auslage, betrag_chf: Number(auslage.betrag_chf) },
        stweg_label: stwegLabel, datum: datum, today: today, betrag: betrag,
        freigeber: freigebender, freigabe_am: freigabeAm,
        verwaltung: { firma: verw.firma },
        projekt: auslage.projekt_slug ? { slug: auslage.projekt_slug, title: auslage.projekt_title } : null,
        nachgereicht: isNachgereicht,
        has_attachment: hasAttachment,
        site_url: SITE_URL, ausschuss_email: ausschussEmail,
      };
      subject = subjectPrefix + renderTemplate(tpl.subject_template, tplContext);
      text = renderTemplate(tpl.body_template, tplContext);
    } else {
      subject = `${subjectPrefix}Auszahlungsauftrag ${stwegLabel}: ${auslage.user_name} – CHF ${betrag} (Auslage ${auslage.id})`;
      text = [
      verw.fallback === 'ausschuss'
        ? `ACHTUNG: Fuer ${stwegLabel} ist KEINE aktive Verwaltung mit E-Mail-Adresse hinterlegt.\n`
          + `Diese Auszahlungs-Aufforderung geht deshalb ersatzweise an den Ausschuss.\n`
          + `Bitte unter ${SITE_URL}/verwaltung-admin.html die Verwaltung pflegen, danach geht die Mail kuenftig automatisch dorthin.\n`
          + `\n────────────────────────────────────────\n`
        : '',
      isNachgereicht
        ? `HINWEIS: Diese Auslage wurde bereits am ${freigabeAm} vom Ausschuss zur Auszahlung freigegeben,\n`
          + `als noch keine externe Verwaltung beauftragt war (Vakanz). Da Sie nun als zustaendige\n`
          + `Verwaltung wirksam sind, wird der Auftrag automatisch an Sie nachgereicht.\n`
          + `\n────────────────────────────────────────\n`
        : '',
      `Sehr geehrte Damen und Herren`,
      ``,
      isNachgereicht
        ? `der Ausschuss hat folgende Auslage waehrend der Vakanz-Phase geprueft und freigegeben.`
        : `der Ausschuss hat folgende Auslage geprueft und zur Auszahlung freigegeben.`,
      `Bitte ueberweisen Sie den Betrag an die unten angegebene IBAN.`,
      ``,
      `── Auftrag ──`,
      `STWEG:           ${stwegLabel}`,
      `Auslage-Nr:      ${auslage.id}`,
      auslage.projekt_slug ? `Projekt:         ${auslage.projekt_title || auslage.projekt_slug}` : null,
      `Eingereicht von: ${auslage.user_name} <${auslage.user_email}>`,
      `Beleg-Datum:     ${datum}`,
      `Kategorie:       ${auslage.kategorie || '-'}`,
      `Betrag:          CHF ${betrag}`,
      `IBAN:            ${auslage.iban || '⚠ NICHT angegeben – bitte beim Eigentuemer erfragen'}`,
      ``,
      `── Beschreibung ──`,
      auslage.beschreibung || '-',
      ``,
      auslage.bemerkung_eigentuemer ? `── Bemerkung Eigentuemer ──\n${auslage.bemerkung_eigentuemer}\n` : '',
      auslage.bemerkung_ausschuss ? `── Bemerkung Ausschuss ──\n${auslage.bemerkung_ausschuss}\n` : '',
      `── Freigabe ──`,
      `Geprueft und freigegeben durch: ${freigebender} am ${freigabeAm}`,
      ``,
      hasAttachment
        ? `Der Beleg ist als Anhang beigefuegt.`
        : `Achtung: kein Beleg hinterlegt.`,
      ``,
      `Nach erfolgter Ueberweisung bitte als Bestaetigung kurze Rueckmeldung an ${ausschussEmail}, der Eigentuemer markiert die Auslage selbst als "erhalten" auf:`,
      `${SITE_URL}/auslagen.html`,
      ``,
      `Freundliche Gruesse`,
      `STWEG-Kooperation Rosenweg`,
      ].filter(Boolean).join('\n');
    }

    // Beim Ausschuss-Fallback (keine Verwaltung) → direkt an Ausschuss senden ohne Queue,
    // weil Ausschuss-interne Mails keine Freigabe brauchen.
    if (verw.fallback === 'ausschuss') {
      const liveAtt = [];
      for (const a of queueAttachments) {
        if (a.docs_path) {
          try {
            const buf = await fs.readFile(pathModule.join(DOCS_PATH, a.docs_path));
            liveAtt.push({ filename: a.filename, content: buf });
          } catch {}
        }
      }
      // C1-Fix: nur tracken wenn Mail wirklich raus ist — sonst weiss der
      // Eigentuemer nicht, dass der Versand fehlgeschlagen ist.
      try {
        await loggedSendMail({
          from: MAIL_FROM,
          to: verw.mailTo.join(', '),
          cc: [auslage.user_email].filter(v => v).join(', '),
          replyTo: ausschussEmail,
          subject,
          text,
          attachments: liveAtt,
        }, 'auslage-auszahlung-ausschuss-fallback');
      } catch (e) {
        console.error('[auslagen] Ausschuss-Direktversand Fehler:', e.message);
        return { ok: false, reason: 'Mail-Versand an Ausschuss-Fallback fehlgeschlagen: ' + e.message, fallback: 'ausschuss', queued: false };
      }
      await pool.query(
        `UPDATE auslagen
            SET auszahlung_mail_at = NOW(), auszahlung_mail_to = $1,
                auszahlung_mail_fallback = true, auszahlung_mail_verwaltung_id = NULL,
                auszahlung_mail_count = COALESCE(auszahlung_mail_count, 0) + 1, updated_at = NOW()
          WHERE id = $2`,
        [verw.mailTo.join(', '), auslage.id],
      );
      return { ok: true, to: verw.mailTo, firma: verw.firma, fallback: 'ausschuss', queued: false, direct: true, nachgereicht: isNachgereicht };
    }

    // Externe Verwaltung → in Genehmigungs-Queue stellen
    const ccList = [...verw.mailCc, auslage.user_email, ausschussEmail].filter((v, i, a) => v && a.indexOf(v) === i);
    const queueId = await enqueueVerwaltungMail({
      source_type: isNachgereicht ? 'auslage-auszahlung-nachgereicht' : 'auslage-auszahlung',
      source_id: auslage.id,
      mailTo: verw.mailTo,
      mailCc: ccList,
      mailReplyTo: ausschussEmail,
      subject,
      bodyText: text,
      attachments: queueAttachments,
      createdBy: ausschussEmail || 'system',
    });
    return { ok: true, to: verw.mailTo, firma: verw.firma, fallback: null, queued: true, queue_id: queueId, nachgereicht: isNachgereicht };
  } catch (err) {
    console.error('[auslagen] Auszahlungs-Mail Fehler:', err);
    return { ok: false, reason: err.message };
  }
}

// Objektverwaltungs-Aenderungen an die Verwaltung melden.
// Coalescing: solange ein pending Queue-Eintrag fuer den STWEG existiert,
// wird er um die neue Aenderung erweitert (eine Sammel-Mail pro STWEG).
// Bei Ausschuss-Fallback wird gar nichts gemacht (Ausschuss kennt die Aenderungen).
async function recordObjektChange(stweg, line, changedBy) {
  try {
    const stwegInt = parseInt(stweg, 10);
    const stwegVal = Number.isFinite(stwegInt) && stwegInt >= 1 && stwegInt <= 8 ? stwegInt : null;
    const verw = await findVerwaltungForStweg(stwegVal);
    if (!verw || verw.fallback) return; // keine wirksame Verwaltung → ueberspringen

    const stwegLabel = stwegVal ? `STWEG ${stwegVal}` : 'STWEG-uebergreifend';
    const stamp = new Date().toLocaleString('de-CH');
    const newLine = `  • ${stamp} (${changedBy || 'unbekannt'}): ${line}`;

    const existing = await pool.query(
      `SELECT id, body_text FROM verwaltung_mail_queue
        WHERE source_type = 'objekt-aenderung'
          AND source_id = $1
          AND status = 'pending'
        LIMIT 1`,
      [stwegVal || 0],
    );

    if (existing.rows.length > 0) {
      // Bestehenden pending Eintrag erweitern (keine erneute Notification)
      await pool.query(
        `UPDATE verwaltung_mail_queue
            SET body_text = body_text || E'\\n' || $1
          WHERE id = $2`,
        [newLine, existing.rows[0].id],
      );
      return;
    }

    // Neuen Sammel-Eintrag in die Queue stellen — Template aus DB versuchen
    const tpl = await findMailTemplate('objekt-aenderung', 'verwaltung');
    const tplContext = {
      stweg_label: stwegLabel, stweg: stwegVal, today_de: new Date().toLocaleDateString('de-CH'),
      erste_aenderung: newLine, site_url: SITE_URL,
    };
    const subject = tpl
      ? renderTemplate(tpl.subject_template, tplContext)
      : `Objektverwaltungs-Aenderungen ${stwegLabel} (${new Date().toLocaleDateString('de-CH')})`;
    const body = tpl
      ? renderTemplate(tpl.body_template, tplContext)
      : [
          `Sehr geehrte Damen und Herren`,
          ``,
          `folgende Aenderungen wurden in der Objektverwaltung der STWEG-Kooperation`,
          `erfasst und sind fuer Ihre Unterlagen relevant:`,
          ``,
          `── Aenderungen (${stwegLabel}) ──`,
          newLine,
          ``,
          `Diese Mail wird automatisch um weitere Aenderungen erweitert, solange sie`,
          `noch nicht freigegeben ist. Sobald Technik oder Praesident die Mail`,
          `freigibt, geht sie an Sie raus.`,
          ``,
          `Bitte aktualisieren Sie Ihre Stamm- und Kontaktdaten entsprechend.`,
          ``,
          `Mit freundlichen Gruessen`,
          `STWEG-Kooperation Rosenweg`,
        ].join('\n');

    await enqueueVerwaltungMail({
      source_type: 'objekt-aenderung',
      source_id: stwegVal || 0,
      mailTo: verw.mailTo,
      mailCc: verw.mailCc,
      mailReplyTo: null,
      subject,
      bodyText: body,
      attachments: [],
      createdBy: changedBy || 'system',
    });
  } catch (err) {
    console.warn('[objekt-aenderung] recordObjektChange Fehler:', err.message);
  }
}

// Wird aufgerufen, wenn eine Verwaltung neu wirksam wird (Anlage / Update / Cron).
// Reicht alle genehmigten, noch nicht ausbezahlten Auslagen, deren letzte Auszahlungs-Mail
// nur an den Ausschuss ging (auszahlung_mail_fallback = true), automatisch an die nun
// zustaendige Verwaltung nach.
async function resendOffeneAuszahlungenFuerWirksameVerwaltung(stwegOrNull) {
  try {
    const stwegInt = parseInt(stwegOrNull, 10);
    const params = [];
    let stwegFilter;
    if (Number.isFinite(stwegInt) && stwegInt >= 1 && stwegInt <= 8) {
      params.push(stwegInt);
      // Stweg-spezifische Verwaltung: schlaegt fuer Auslagen DIESES Stwegs zu
      stwegFilter = `stweg = $${params.length}`;
    } else {
      // Uebergreifende Verwaltung: schlaegt fuer Auslagen ohne Verwaltung des eigenen Stwegs zu
      stwegFilter = `TRUE`;
    }
    const offene = await pool.query(
      `SELECT * FROM auslagen
        WHERE status = 'genehmigt'
          AND COALESCE(auszahlung_mail_fallback, false) = true
          AND ${stwegFilter}
          AND NOT EXISTS (
            SELECT 1 FROM verwaltung_mail_queue vmq
             WHERE vmq.source_id = auslagen.id
               AND vmq.source_type LIKE 'auslage-auszahlung%'
               AND vmq.status IN ('pending','freigegeben')
          )
        ORDER BY id`,
      params,
    );
    if (offene.rows.length === 0) return { resent: 0, results: [] };

    const results = [];
    for (const auslage of offene.rows) {
      // Doppelt sicher: nur weiter wenn die nun aufgelaufene Verwaltung NICHT mehr Fallback ist
      const verw = await findVerwaltungForStweg(auslage.stweg);
      if (!verw || verw.fallback) continue;
      const res = await sendAuszahlungsMail(
        auslage,
        auslage.bearbeitet_von || 'ausschuss@rosenweg4303.ch',
        null,
        { nachgereicht: true },
      );
      results.push({ id: auslage.id, ok: res.ok, to: res.to, queued: res.queued, reason: res.reason });
    }
    const resent = results.filter(r => r.ok).length;
    if (resent > 0) console.log(`[auslagen] ${resent} offene Auslagen an neue Verwaltung nachgereicht (STWEG ${stwegOrNull || '*'})`);
    return { resent, results };
  } catch (err) {
    console.error('[auslagen] Resend-Fehler:', err);
    return { resent: 0, error: err.message };
  }
}

function canSeeAuslage(row, user) {
  const groups = user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return true;
  if (row.user_email && row.user_email.toLowerCase() === (user.email || '').toLowerCase()) return true;
  // Ausschuss seines STWEGs sieht Auslagen seines STWEGs
  if (row.stweg && getAusschussStwegs(groups).has(parseInt(row.stweg, 10))) return true;
  // M6: STWEG-uebergreifende Auslagen (stweg=NULL) sind fuer alle Ausschuss-Mitglieder sichtbar
  // — analog zu canEditAuslageStatus
  if (!row.stweg && isAusschussForAny(groups)) return true;
  return false;
}

function canEditAuslageStatus(row, user) {
  const groups = user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return true;
  if (row.stweg && getAusschussStwegs(groups).has(parseInt(row.stweg, 10))) return true;
  // Auslagen ohne STWEG-Bezug duerfen alle Ausschuss-Mitglieder bearbeiten
  if (!row.stweg && isAusschussForAny(groups)) return true;
  return false;
}

// "Ausbezahlt" / "erhalten" duerfen setzen:
// - Verwaltung / Technik / Praesident (offizielle Auszahlung)
// - der einreichende Eigentuemer selbst (Bestaetigung "Geld erhalten")
function canMarkPaid(user, row = null) {
  const groups = user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return true;
  if (groups.some(g => g.toLowerCase() === 'verwaltung')) return true;
  if (row && row.user_email && row.user_email.toLowerCase() === (user.email || '').toLowerCase()) return true;
  return false;
}

// GET /api/auslagen — Liste (eigene + ggf. STWEG-Auslagen falls Ausschuss/Technik)
// GET /api/dashboard — aggregierte Daten fuer Startseite je nach Rolle
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const email = (req.user.email || '').toLowerCase();
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const ausschussStwegs = [...getAusschussStwegs(groups)];
    const canReview = isAdmin || ausschussStwegs.length > 0;
    const widgets = {};

    // 1) Eigene Auslagen-Status
    try {
      const r = await pool.query(
        `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(betrag_chf),0)::numeric AS s
           FROM auslagen WHERE LOWER(user_email) = $1 GROUP BY status`,
        [email],
      );
      const by = {};
      for (const row of r.rows) by[row.status] = { count: row.n, summe: Number(row.s) };
      widgets.meine_auslagen = by;
    } catch {}

    // 2) Auslagen zu pruefen (fuer Ausschuss/Technik)
    if (canReview) {
      try {
        const stwegFilter = isAdmin ? 'TRUE' : `stweg = ANY($1::int[])`;
        const params = isAdmin ? [] : [ausschussStwegs];
        const r = await pool.query(
          `SELECT id, user_name, stweg, beschreibung, betrag_chf, created_at
             FROM auslagen
            WHERE status = 'eingereicht' AND ${stwegFilter}
              AND LOWER(user_email) != $${params.length + 1}
            ORDER BY created_at LIMIT 10`,
          [...params, email],
        );
        widgets.auslagen_zu_pruefen = r.rows;
      } catch {}
    }

    // 3) Mail-Outbox pending (nur Technik/Praesident)
    if (isAdmin) {
      try {
        const r = await pool.query(
          `SELECT id, source_type, subject, mail_to, created_at FROM verwaltung_mail_queue
            WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10`,
        );
        widgets.mail_outbox_pending = r.rows;
      } catch {}
    }

    // 4) Anstehende Handwerker-Vertraege (alle die Berechtigung haben)
    try {
      const r = await pool.query(
        `SELECT v.id, v.titel, v.naechster_termin, v.stweg, h.firma
           FROM handwerker_vertraege v JOIN handwerker h ON h.id = v.handwerker_id
          WHERE v.status = 'aktiv' AND v.naechster_termin IS NOT NULL
            AND v.naechster_termin <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY v.naechster_termin LIMIT 10`,
      );
      widgets.anstehende_vertraege = r.rows;
    } catch {}

    // 5) Verwaltungs-Vertragskuendigungen anstehend (innerhalb 90 Tage Vertrag-Ende)
    try {
      const r = await pool.query(
        `SELECT id, firma_name, stweg, vertrag_bis, kuendigungsfrist_monate
           FROM verwaltungen
          WHERE aktiv = true
            AND vertrag_bis IS NOT NULL AND vertrag_bis <= CURRENT_DATE + INTERVAL '180 days'
          ORDER BY vertrag_bis LIMIT 5`,
      );
      widgets.verwaltungs_vertraege = r.rows;
    } catch {}

    // 6) Projekt-Budget-Status (alle aktiven Projekte)
    try {
      const r = await pool.query(`
        SELECT p.slug, p.title, p.budget_chf, p.budget_warnung_pct,
               COALESCE((SELECT SUM(betrag_chf) FROM auslagen WHERE projekt_slug = p.slug), 0) AS verbraucht
          FROM projects p WHERE COALESCE(p.status,'aktiv') != 'archiviert'
         ORDER BY p.title
      `);
      widgets.projekt_budgets = r.rows
        .filter(p => Number(p.budget_chf) > 0 || Number(p.verbraucht) > 0)
        .map(p => ({
          ...p,
          budget_chf: Number(p.budget_chf) || 0,
          verbraucht: Number(p.verbraucht) || 0,
        }));
    } catch {}

    // 7a) Mails die an die Verwaltung rausgegangen sind (gesendet, letzte 14 Tage)
    if (isAdmin || ausschussStwegs.length > 0) {
      try {
        const r = await pool.query(`
          SELECT id, source_type, source_id, subject, mail_to, sent_at, freigegeben_von
            FROM verwaltung_mail_queue
           WHERE status = 'gesendet' AND sent_at >= NOW() - INTERVAL '14 days'
           ORDER BY sent_at DESC LIMIT 15
        `);
        widgets.mails_an_verwaltung = r.rows;
      } catch {}
    }

    // 7) Genehmigt aber nicht ausbezahlt (lange offen — Reminder-Liste)
    if (canReview) {
      try {
        const r = await pool.query(`
          SELECT id, user_name, stweg, beschreibung, betrag_chf, bearbeitet_am,
                 EXTRACT(DAY FROM NOW() - bearbeitet_am)::int AS tage_offen
            FROM auslagen
           WHERE status = 'genehmigt' AND bearbeitet_am < NOW() - INTERVAL '14 days'
           ORDER BY bearbeitet_am LIMIT 10
        `);
        widgets.auszahlung_offen = r.rows;
      } catch {}
    }

    // 8) WhatsApp-Outbox-Status (Technik/Praesident)
    if (isAdmin) {
      try {
        const r = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE direction='outbound' AND status='pending')::int     AS pending,
            COUNT(*) FILTER (WHERE direction='outbound' AND status='failed')::int      AS failed,
            COUNT(*) FILTER (WHERE direction='outbound' AND status='sent'
                              AND sent_at >= NOW() - INTERVAL '24 hours')::int        AS sent_24h,
            COUNT(*) FILTER (WHERE direction='inbound'
                              AND created_at >= NOW() - INTERVAL '24 hours')::int     AS inbound_24h,
            (SELECT COUNT(*) FROM personen WHERE whatsapp_opt_in = true)::int          AS opt_in_count
          FROM whatsapp_messages
        `);
        widgets.whatsapp_outbox = r.rows[0];
      } catch {}
    }

    res.json({
      user: { email: req.user.email, name: req.user.name, isAdmin, ausschussStwegs },
      widgets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auslagen', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const ausschussStwegs = [...getAusschussStwegs(groups)];
    const email = (req.user.email || '').toLowerCase();
    const params = [];
    let where;
    if (isAdmin) {
      where = 'TRUE';
    } else if (ausschussStwegs.length > 0) {
      params.push(email, ausschussStwegs);
      where = `LOWER(user_email) = $1 OR stweg = ANY($2::int[])`;
    } else {
      params.push(email);
      where = `LOWER(user_email) = $1`;
    }
    const statusFilter = String(req.query.status || '').trim();
    if (statusFilter && AUSLAGEN_STATUS.includes(statusFilter)) {
      params.push(statusFilter);
      where += ` AND status = $${params.length}`;
    }
    const stwegFilter = parseInt(req.query.stweg, 10);
    if (Number.isFinite(stwegFilter)) {
      params.push(stwegFilter);
      where += ` AND stweg = $${params.length}`;
    }
    const projektFilter = String(req.query.projekt || '').trim();
    if (projektFilter) {
      params.push(projektFilter);
      where += ` AND projekt_slug = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT a.id, a.user_email, a.user_name, a.stweg, a.datum, a.kategorie, a.beschreibung, a.betrag_chf,
              a.iban, a.beleg_path, a.beleg_filename, a.status, a.bemerkung_eigentuemer, a.bemerkung_ausschuss,
              a.bearbeitet_von, a.bearbeitet_am, a.ausbezahlt_am, a.created_at, a.updated_at,
              a.projekt_slug, p.title AS projekt_title,
              a.auszahlung_mail_at, a.auszahlung_mail_to, a.auszahlung_mail_fallback, a.auszahlung_mail_count,
              COALESCE((SELECT COUNT(*) FROM auslagen_belege WHERE auslage_id = a.id),
                       CASE WHEN a.beleg_path IS NOT NULL THEN 1 ELSE 0 END) AS belege_count,
              COALESCE((SELECT COUNT(*) FROM auslagen_positionen WHERE auslage_id = a.id), 0) AS positionen_count,
              (SELECT status FROM verwaltung_mail_queue
                 WHERE source_type LIKE 'auslage-auszahlung%' AND source_id = a.id
                 ORDER BY created_at DESC LIMIT 1) AS mail_queue_status
         FROM auslagen a
         LEFT JOIN projects p ON p.slug = a.projekt_slug
        WHERE ${where.replace(/(?<!\.)(\bstatus\b|\bstweg\b|\buser_email\b|\bprojekt_slug\b)/g, 'a.$1')}
        ORDER BY a.created_at DESC
        LIMIT 500`,
      params,
    );
    // Aktive Projekte fuer Dropdown
    const projektsRes = await pool.query(`SELECT slug, title FROM projects WHERE COALESCE(status,'aktiv') != 'archiviert' ORDER BY title`);
    res.json({
      auslagen: result.rows,
      kategorien: AUSLAGEN_KATEGORIEN,
      projekte: projektsRes.rows,
      can_review: isAdmin || ausschussStwegs.length > 0,
      can_mark_paid: canMarkPaid(req.user),
      review_stwegs: isAdmin ? 'all' : ausschussStwegs,
    });
  } catch (err) {
    console.error('Auslagen list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden der Auslagen' });
  }
});

// POST /api/auslagen — neue Auslage einreichen (Eigentuemer)
app.post('/api/auslagen', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const { datum, kategorie, beschreibung, betrag_chf, iban, stweg, bemerkung_eigentuemer, beleg_base64, beleg_filename, projekt_slug } = req.body || {};
    if (!datum || !beschreibung || betrag_chf == null) {
      return res.status(400).json({ error: 'datum, beschreibung und betrag_chf sind Pflichtfelder' });
    }
    const betrag = Number(betrag_chf);
    if (!Number.isFinite(betrag) || betrag <= 0) return res.status(400).json({ error: 'Ungueltiger Betrag' });
    if (betrag > 100000) return res.status(400).json({ error: 'Betrag > 100000 CHF nicht plausibel' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(datum))) return res.status(400).json({ error: 'Datum muss YYYY-MM-DD sein' });
    const kat = kategorie && AUSLAGEN_KATEGORIEN.includes(kategorie) ? kategorie : null;
    const stwegInt = parseInt(stweg, 10);
    const stwegVal = Number.isFinite(stwegInt) && stwegInt >= 1 && stwegInt <= 8 ? stwegInt : null;
    const ibanClean = iban ? String(iban).replace(/\s+/g, '').toUpperCase().slice(0, 40) : null;
    if (ibanClean && !/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(ibanClean)) {
      return res.status(400).json({ error: 'IBAN-Format ungueltig' });
    }

    let belegPath = null, belegFilename = null;
    if (beleg_base64) {
      const ext = (beleg_filename || 'pdf').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) {
        return res.status(400).json({ error: 'Beleg muss PDF, JPG, PNG, WEBP oder HEIC sein' });
      }
      const buf = Buffer.from(beleg_base64, 'base64');
      if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Beleg > 15MB' });
      const folder = auslagenStwegFolder(stwegVal);
      const dir = pathModule.join(DOCS_PATH, folder, 'auslagen');
      await fs.mkdir(dir, { recursive: true });
      const safeName = String(beleg_filename || 'beleg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'beleg';
      const stamp = Date.now();
      const finalName = `${stamp}_${safeName}${safeName.toLowerCase().endsWith('.' + ext) ? '' : '.' + ext}`;
      const fullPath = pathModule.join(dir, finalName);
      await fs.writeFile(fullPath, buf);
      belegPath = `${folder}/auslagen/${finalName}`;
      belegFilename = beleg_filename || finalName;
    }

    // Projekt-Validierung: muss existieren falls angegeben
    let projektSlug = null;
    if (projekt_slug) {
      const pr = await pool.query('SELECT slug FROM projects WHERE slug = $1', [String(projekt_slug).slice(0, 100)]);
      if (pr.rows.length === 0) return res.status(400).json({ error: `Projekt '${projekt_slug}' nicht gefunden` });
      projektSlug = pr.rows[0].slug;
    }

    const userEmail = req.user.email;
    const userName = req.user.name || req.user.email;
    const result = await pool.query(
      `INSERT INTO auslagen
         (user_email, user_name, stweg, datum, kategorie, beschreibung, betrag_chf, iban,
          beleg_path, beleg_filename, bemerkung_eigentuemer, projekt_slug, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'eingereicht')
       RETURNING *`,
      [userEmail, userName, stwegVal, datum, kat, String(beschreibung).slice(0, 2000), betrag,
       ibanClean, belegPath, belegFilename,
       bemerkung_eigentuemer ? String(bemerkung_eigentuemer).slice(0, 1000) : null, projektSlug],
    );

    // Ausschuss informieren (Best-Effort, kein Fehler wenn Mail scheitert)
    try {
      const stwegLabel = stwegVal ? `STWEG ${stwegVal}` : 'STWEG-uebergreifend';
      const adminEmails = [];
      if (stwegVal && STWEG_GROUPS[stwegVal]?.ausschuss) {
        const ausschussRes = await pool.query(
          `SELECT DISTINCT u.email FROM users u
            WHERE u.active = true AND u.groups_json::jsonb ? $1`,
          [STWEG_GROUPS[stwegVal].ausschuss],
        );
        for (const r of ausschussRes.rows) if (r.email) adminEmails.push(r.email);
      }
      if (adminEmails.length > 0) {
        await loggedSendMail({
          from: MAIL_FROM,
          to: adminEmails.join(', '),
          subject: `Neue Auslage von ${userName} (${stwegLabel}, CHF ${betrag.toFixed(2)})`,
          text: `${userName} (${userEmail}) hat eine Auslage zur Pruefung eingereicht.\n\n`
            + `STWEG: ${stwegLabel}\nDatum: ${datum}\nKategorie: ${kat || '-'}\nBetrag: CHF ${betrag.toFixed(2)}\n`
            + `Beschreibung: ${beschreibung}\n\nZum Pruefen: ${SITE_URL}/auslagen.html`,
        }, 'auslage-neu');
        // WhatsApp-Push an Approver mit Opt-In
        pushWhatsappBroadcast({
          emails: adminEmails, sourceType: 'auslage-neu', sourceId: result.rows[0].id,
          body: `🔔 *Neue Auslage zur Prüfung*\n${userName}, ${stwegLabel}\nCHF ${betrag.toFixed(2)} — ${beschreibung.slice(0, 100)}\n\n${SITE_URL}/auslagen.html`,
        }).catch(() => {});
      }
    } catch (mailErr) {
      console.warn('[auslagen] Notification mail failed:', mailErr.message);
    }

    res.json({ success: true, auslage: result.rows[0] });
  } catch (err) {
    console.error('Auslagen create error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// PUT /api/auslagen/:id — Aendern (Eigentuemer nur eigene+eingereicht; Ausschuss Status/Bemerkung)
app.put('/api/auslagen/:id', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const cur = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = cur.rows[0];
    if (!canSeeAuslage(row, req.user)) return res.status(403).json({ error: 'Kein Zugriff' });

    const groups = req.user.groups || [];
    const isOwner = row.user_email.toLowerCase() === (req.user.email || '').toLowerCase();
    const canReview = canEditAuslageStatus(row, req.user);

    const updates = [];
    const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };

    if (isOwner && row.status === 'eingereicht') {
      if (req.body.datum !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.datum))) return res.status(400).json({ error: 'Datum YYYY-MM-DD' });
        push('datum', req.body.datum);
      }
      if (req.body.kategorie !== undefined) {
        push('kategorie', AUSLAGEN_KATEGORIEN.includes(req.body.kategorie) ? req.body.kategorie : null);
      }
      if (req.body.beschreibung !== undefined) push('beschreibung', String(req.body.beschreibung).slice(0, 2000));
      if (req.body.betrag_chf !== undefined) {
        const b = Number(req.body.betrag_chf);
        if (!Number.isFinite(b) || b <= 0 || b > 100000) return res.status(400).json({ error: 'Ungueltiger Betrag' });
        push('betrag_chf', b);
      }
      if (req.body.iban !== undefined) {
        const ibn = req.body.iban ? String(req.body.iban).replace(/\s+/g, '').toUpperCase().slice(0, 40) : null;
        if (ibn && !/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(ibn)) return res.status(400).json({ error: 'IBAN ungueltig' });
        push('iban', ibn);
      }
      if (req.body.bemerkung_eigentuemer !== undefined) {
        push('bemerkung_eigentuemer', req.body.bemerkung_eigentuemer ? String(req.body.bemerkung_eigentuemer).slice(0, 1000) : null);
      }
      if (req.body.stweg !== undefined) {
        const s = parseInt(req.body.stweg, 10);
        push('stweg', Number.isFinite(s) && s >= 1 && s <= 8 ? s : null);
      }
      if (req.body.projekt_slug !== undefined) {
        let ps = req.body.projekt_slug ? String(req.body.projekt_slug).slice(0, 100) : null;
        if (ps) {
          const pr = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [ps]);
          if (pr.rows.length === 0) return res.status(400).json({ error: `Projekt '${ps}' nicht gefunden` });
        }
        push('projekt_slug', ps);
      }
    }

    // Status-Aenderung: Ausschuss/Technik/Praesident voll;
    // Eigentuemer darf eigene "genehmigte" Auslage als "ausbezahlt" (erhalten) bestaetigen.
    if (req.body.status !== undefined) {
      const newStatus = req.body.status;
      if (!AUSLAGEN_STATUS.includes(newStatus)) return res.status(400).json({ error: 'Ungueltiger Status' });
      const isOwnerConfirmPaid = isOwner && newStatus === 'ausbezahlt' && row.status === 'genehmigt';
      if (canReview) {
        if (newStatus === 'ausbezahlt' && !canMarkPaid(req.user, row)) {
          return res.status(403).json({ error: '"Ausbezahlt" duerfen nur Verwaltung, Technik, Praesident oder der einreichende Eigentuemer (nach Genehmigung) setzen' });
        }
      } else if (!isOwnerConfirmPaid) {
        return res.status(403).json({ error: 'Keine Berechtigung fuer diese Status-Aenderung' });
      }
      push('status', newStatus);
      push('bearbeitet_von', req.user.email);
      push('bearbeitet_am', new Date());
      if (newStatus === 'ausbezahlt') {
        push('ausbezahlt_am', req.body.ausbezahlt_am && /^\d{4}-\d{2}-\d{2}$/.test(req.body.ausbezahlt_am)
          ? req.body.ausbezahlt_am
          : new Date().toISOString().slice(0, 10));
      }
    }
    if (canReview && req.body.bemerkung_ausschuss !== undefined) {
      push('bemerkung_ausschuss', req.body.bemerkung_ausschuss ? String(req.body.bemerkung_ausschuss).slice(0, 1000) : null);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Keine erlaubten Aenderungen' });
    params.push(id);
    updates.push('updated_at = NOW()');
    const result = await pool.query(
      `UPDATE auslagen SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );

    const updated = result.rows[0];

    // Mail an Eigentuemer bei Status-Wechsel
    try {
      if (req.body.status && req.body.status !== row.status) {
        const labelMap = { genehmigt: 'genehmigt', abgelehnt: 'abgelehnt', ausbezahlt: 'als ausbezahlt markiert', eingereicht: 'wieder eroeffnet' };
        const label = labelMap[req.body.status] || req.body.status;
        // Eigentuemer-Bestaetigung "erhalten" → keine Mail an sich selbst
        const skipOwnerMail = (req.body.status === 'ausbezahlt' && isOwner && !canReview);
        if (!skipOwnerMail) {
          await loggedSendMail({
            from: MAIL_FROM,
            to: row.user_email,
            subject: `Auslage ${label}: CHF ${Number(row.betrag_chf).toFixed(2)} (${row.beschreibung.slice(0, 60)})`,
            text: `Hallo ${row.user_name},\n\n`
              + `deine Auslage vom ${row.datum} ueber CHF ${Number(row.betrag_chf).toFixed(2)} wurde ${label}.\n`
              + (req.body.bemerkung_ausschuss ? `\nBemerkung Ausschuss: ${req.body.bemerkung_ausschuss}\n` : '')
              + `\nDetails: ${SITE_URL}/auslagen.html`,
          }, 'auslage-status');
          // WhatsApp-Push an Eigentuemer
          const emoji = req.body.status === 'genehmigt' ? '✅' : req.body.status === 'ausbezahlt' ? '💰' : req.body.status === 'abgelehnt' ? '❌' : '🔄';
          pushWhatsappIfOptIn({
            email: row.user_email, sourceType: 'auslage-status', sourceId: row.id,
            body: `${emoji} *Auslage ${label}*\nCHF ${Number(row.betrag_chf).toFixed(2)} — ${row.beschreibung.slice(0, 80)}`
              + (req.body.bemerkung_ausschuss ? `\n\n_Bemerkung:_ ${req.body.bemerkung_ausschuss}` : '')
              + `\n\n${SITE_URL}/auslagen.html`,
          }).catch(() => {});
        }
      }
    } catch (mailErr) {
      console.warn('[auslagen] Status-Mail failed:', mailErr.message);
    }

    // Bei Freigabe (genehmigt) → fertige Auszahlungs-Mail an die zustaendige Verwaltung
    let auszahlungInfo = null;
    if (canReview && req.body.status === 'genehmigt' && row.status !== 'genehmigt') {
      auszahlungInfo = await sendAuszahlungsMail(updated, req.user.email, req.user.name);
    }

    res.json({ success: true, auslage: updated, auszahlung_mail: auszahlungInfo });
  } catch (err) {
    console.error('Auslagen update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

// DELETE /api/auslagen/:id — eigener Entwurf (eingereicht) oder Ausschuss/Technik
app.delete('/api/auslagen/:id', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const cur = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = cur.rows[0];
    const isOwner = row.user_email.toLowerCase() === (req.user.email || '').toLowerCase();
    const canReview = canEditAuslageStatus(row, req.user);
    if (!canReview && !(isOwner && row.status === 'eingereicht')) {
      return res.status(403).json({ error: 'Loeschen nur fuer eigene eingereichte Auslagen oder Ausschuss/Technik' });
    }
    if (row.beleg_path) {
      try {
        const full = pathModule.join(DOCS_PATH, row.beleg_path);
        if (full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) await fs.unlink(full).catch(() => {});
      } catch {}
    }
    // M1: Verwaiste Mail-Queue-Eintraege vorher cleanen (FK-Referenz wird sonst broken)
    // Pending + freigegebene Auszahlungs-Mails dieser Auslage abbrechen
    const qDel = await pool.query(
      `DELETE FROM verwaltung_mail_queue
        WHERE source_type LIKE 'auslage-auszahlung%' AND source_id = $1
          AND status IN ('pending', 'freigegeben')
        RETURNING id`,
      [id],
    );
    // Bei bereits gesendeten Mails source_id auf NULL setzen (Audit-Trail erhalten)
    await pool.query(
      `UPDATE verwaltung_mail_queue SET source_id = NULL
        WHERE source_type LIKE 'auslage-auszahlung%' AND source_id = $1
          AND status IN ('gesendet', 'abgelehnt', 'fehler')`,
      [id],
    );
    await pool.query('DELETE FROM auslagen WHERE id = $1', [id]);
    res.json({ success: true, cancelled_queue_mails: qDel.rowCount });
  } catch (err) {
    console.error('Auslagen delete error:', err);
    res.status(500).json({ error: 'Fehler beim Loeschen' });
  }
});

// GET /api/auslagen/:id/beleg — Beleg-Datei ausliefern
// Legacy: ersten Beleg ausliefern (Backward-Compat). Bevorzugt /api/auslagen/:id/belege/:bid
app.get('/api/auslagen/:id/beleg', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).end();
    const r = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).end();
    const row = r.rows[0];
    if (!canSeeAuslage(row, req.user)) return res.status(403).end();
    // Erst Multi-Beleg-Tabelle versuchen, dann Legacy-Spalte
    const beleg = await pool.query(
      'SELECT beleg_path FROM auslagen_belege WHERE auslage_id = $1 ORDER BY sort_order, id LIMIT 1',
      [id],
    );
    const path = beleg.rows[0]?.beleg_path || row.beleg_path;
    if (!path) return res.status(404).json({ error: 'Kein Beleg vorhanden' });
    const full = pathModule.join(DOCS_PATH, path);
    if (!full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (err) {
    console.error('Auslagen beleg error:', err);
    res.status(500).end();
  }
});

// Multi-Belege: list, download, upload, delete
app.get('/api/auslagen/:id/belege', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const aus = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    if (!canSeeAuslage(aus.rows[0], req.user)) return res.status(403).json({ error: 'Kein Zugriff' });
    const r = await pool.query(
      `SELECT id, beleg_filename, size_bytes, waehrung_original, wechselkurs_chf, kurs_quelle, sort_order, created_at
         FROM auslagen_belege WHERE auslage_id = $1 ORDER BY sort_order, id`,
      [id],
    );
    res.json({ belege: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auslagen/:id/belege/:bid', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const bid = parseInt(req.params.bid, 10);
    const aus = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).end();
    if (!canSeeAuslage(aus.rows[0], req.user)) return res.status(403).end();
    const r = await pool.query('SELECT beleg_path, beleg_filename FROM auslagen_belege WHERE id = $1 AND auslage_id = $2', [bid, id]);
    if (r.rows.length === 0) return res.status(404).end();
    const full = pathModule.join(DOCS_PATH, r.rows[0].beleg_path);
    if (!full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  } catch (err) { res.status(500).end(); }
});

app.post('/api/auslagen/:id/belege', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const aus = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = aus.rows[0];
    const isOwner = row.user_email.toLowerCase() === (req.user.email || '').toLowerCase();
    if (!(isOwner && row.status === 'eingereicht') && !canEditAuslageStatus(row, req.user)) {
      return res.status(403).json({ error: 'Belege hinzufuegen nur bei eigener eingereichter Auslage oder Ausschuss' });
    }
    const { beleg_base64, beleg_filename, waehrung_original, wechselkurs_chf, kurs_quelle } = req.body || {};
    if (!beleg_base64) return res.status(400).json({ error: 'beleg_base64 fehlt' });
    const ext = (beleg_filename || 'pdf').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!['pdf','jpg','jpeg','png','webp','heic'].includes(ext)) {
      return res.status(400).json({ error: 'Nur PDF/JPG/PNG/WEBP/HEIC erlaubt' });
    }
    const buf = Buffer.from(beleg_base64, 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Beleg > 15 MB' });
    const folder = auslagenStwegFolder(row.stweg);
    const dir = pathModule.join(DOCS_PATH, folder, 'auslagen');
    await fs.mkdir(dir, { recursive: true });
    const safe = String(beleg_filename || 'beleg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'beleg';
    const finalName = `${Date.now()}_${safe}${safe.toLowerCase().endsWith('.' + ext) ? '' : '.' + ext}`;
    await fs.writeFile(pathModule.join(dir, finalName), buf);
    const belegPath = `${folder}/auslagen/${finalName}`;
    const sortMax = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM auslagen_belege WHERE auslage_id = $1', [id]);
    const r = await pool.query(
      `INSERT INTO auslagen_belege (auslage_id, beleg_path, beleg_filename, size_bytes, waehrung_original, wechselkurs_chf, kurs_quelle, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, belegPath, beleg_filename || finalName, buf.length,
       waehrung_original || null, wechselkurs_chf || null, kurs_quelle || null, sortMax.rows[0].n],
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('Beleg upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/auslagen/:id/belege/:bid', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const bid = parseInt(req.params.bid, 10);
    const aus = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = aus.rows[0];
    const isOwner = row.user_email.toLowerCase() === (req.user.email || '').toLowerCase();
    if (!(isOwner && row.status === 'eingereicht') && !canEditAuslageStatus(row, req.user)) {
      return res.status(403).json({ error: 'Loeschen nur bei eigener eingereichter Auslage oder Ausschuss' });
    }
    const beleg = await pool.query('SELECT beleg_path FROM auslagen_belege WHERE id = $1 AND auslage_id = $2', [bid, id]);
    if (beleg.rows.length === 0) return res.status(404).json({ error: 'Beleg nicht gefunden' });
    try {
      const full = pathModule.join(DOCS_PATH, beleg.rows[0].beleg_path);
      if (full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) await fs.unlink(full).catch(() => {});
    } catch {}
    await pool.query('DELETE FROM auslagen_belege WHERE id = $1', [bid]);
    res.json({ success: true });
  } catch (err) {
    console.error('Beleg delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Auslagen: Positionen + KI-Belegleser + Stundensatz + Multi-Belege + FX ─────

// FX-Helper: holt Wechselkurs am Datum von exchangerate.host (kostenlos, kein Key).
// Cache: 24h pro (Datum + Waehrung) damit nicht jeder Scan ein Hit ist.
const _fxCache = new Map();
async function getWechselkursChf(waehrung, datum) {
  const wkn = String(waehrung || 'CHF').toUpperCase();
  if (wkn === 'CHF' || !wkn) return { kurs: 1, quelle: null };
  const dat = (datum && /^\d{4}-\d{2}-\d{2}$/.test(datum)) ? datum : new Date().toISOString().slice(0, 10);
  const cacheKey = `${dat}:${wkn}`;
  const cached = _fxCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return cached.value;
  try {
    const url = `https://api.exchangerate.host/${dat}?base=${wkn}&symbols=CHF`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const kurs = data?.rates?.CHF;
    if (!Number.isFinite(kurs) || kurs <= 0) throw new Error('Kein gueltiger Kurs');
    const value = { kurs: Number(kurs), quelle: `exchangerate.host ${dat}` };
    _fxCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
  } catch (e) {
    console.warn(`[fx] Kurs ${wkn}→CHF am ${dat} nicht verfuegbar:`, e.message);
    return { kurs: 1, quelle: `fallback 1:1 (Kurs nicht verfuegbar)` };
  }
}

// POST /api/auslagen/scan-beleg — Foto/PDF eines Belegs hochladen, KI extrahiert
// Positionen, Datum, Total. Returns {datum, lieferant, positionen[], total_chf, waehrung, kurs}.
app.post('/api/auslagen/scan-beleg', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    // Rate-Limit: max 30 Scans/h pro User (KI-Kosten)
    const rl = rateLimitGuard('auslagen-scan', (req.user.email || 'anon').toLowerCase(), 30, 60 * 60 * 1000);
    if (!rl.ok) return res.status(429).json({ error: `Zu viele Scans. Bitte ${Math.ceil(rl.retryAfter / 60)} Min warten.` });

    const { bild_base64, bild_filename } = req.body || {};
    if (!bild_base64) return res.status(400).json({ error: 'bild_base64 fehlt' });
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    const ext = (bild_filename || 'jpeg').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(ext)) {
      return res.status(400).json({ error: 'Nur JPG/PNG/WEBP/PDF erlaubt' });
    }
    const buf = Buffer.from(bild_base64, 'base64');
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Datei > 15 MB' });
    const mime = ext === 'png' ? 'image/png'
               : ext === 'webp' ? 'image/webp'
               : ext === 'pdf' ? 'application/pdf'
               : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${bild_base64}`;

    const systemPrompt = `Du extrahierst Positionen aus einem Beleg (Kassenbon, Rechnung, Quittung).
Antworte AUSSCHLIESSLICH mit gueltigem JSON, keine Markdown-Codebloecke.

Schema:
{
  "datum": "YYYY-MM-DD" | null,
  "lieferant": string | null,        // Geschaeft, Firma
  "waehrung": "CHF" | "EUR" | null,
  "positionen": [
    {
      "beschreibung": string,       // Artikelname / Leistung
      "menge": number,              // Stueckzahl/Menge, default 1
      "einheit": string | null,     // "Stk", "kg", "l", "h", "m", ...
      "einzelpreis": number | null, // pro Einheit, optional
      "gesamt": number              // total fuer diese Position
    }
  ],
  "subtotal": number | null,         // ohne MWST, falls erkennbar
  "mwst": number | null,             // Mehrwertsteuer
  "total": number                    // Endbetrag des Belegs
}

WICHTIG:
- Alle Betraege als Zahlen in der Waehrung (z.B. 12.50 fuer 12.50 CHF)
- Wenn Datum nicht erkennbar: null
- Mengen und Einheiten so genau wie moeglich extrahieren
- Bei Restaurant-Beleg: jede Speise/Getraenk als eigene Position
- Bei Baumarkt-Rechnung: jeden Artikel separat`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Auslagen-Belegleser',
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Extrahiere die Positionen aus diesem Beleg.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
      }),
    });
    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      console.error('[auslagen-scan] OpenRouter error', orRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})` });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[auslagen-scan] JSON-Parse failed:', jsonText.slice(0, 300));
      return res.status(502).json({ error: 'OCR-Antwort kein gueltiges JSON', raw: content.slice(0, 500) });
    }
    const waehrung = String(parsed.waehrung || 'CHF').toUpperCase();
    const fx = await getWechselkursChf(waehrung, parsed.datum);
    const conv = (v) => Number.isFinite(v) ? Math.round(v * fx.kurs * 100) / 100 : v;
    res.json({
      datum: parsed.datum || null,
      lieferant: parsed.lieferant || null,
      waehrung,
      wechselkurs_chf: fx.kurs,
      kurs_quelle: fx.quelle,
      positionen: Array.isArray(parsed.positionen) ? parsed.positionen.map(p => ({
        beschreibung: String(p.beschreibung || '').slice(0, 500),
        menge: Number(p.menge) || 1,
        einheit: p.einheit ? String(p.einheit).slice(0, 20) : null,
        einzelpreis_original: Number(p.einzelpreis) || null,
        einzelpreis: conv(Number(p.einzelpreis)) || null, // umgerechnet in CHF
        gesamt_original: Number(p.gesamt) || 0,
        gesamt: conv(Number(p.gesamt) || 0),              // umgerechnet in CHF
      })) : [],
      subtotal_original: Number(parsed.subtotal) || null,
      subtotal: Number(parsed.subtotal) ? conv(Number(parsed.subtotal)) : null,
      mwst_original: Number(parsed.mwst) || null,
      mwst: Number(parsed.mwst) ? conv(Number(parsed.mwst)) : null,
      total_original: Number(parsed.total) || 0,
      total: conv(Number(parsed.total) || 0),
    });
  } catch (err) {
    console.error('Auslagen-scan error:', err);
    res.status(500).json({ error: 'Scan fehlgeschlagen: ' + err.message });
  }
});

// CRUD Positionen
app.get('/api/auslagen/:id/positionen', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const aus = await pool.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).json({ error: 'Auslage nicht gefunden' });
    if (!canSeeAuslage(aus.rows[0], req.user)) return res.status(403).json({ error: 'Kein Zugriff' });
    const r = await pool.query('SELECT * FROM auslagen_positionen WHERE auslage_id = $1 ORDER BY sort_order, id', [id]);
    res.json({ positionen: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/auslagen/:id/positionen', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const aus = await client.query('SELECT * FROM auslagen WHERE id = $1', [id]);
    if (aus.rows.length === 0) return res.status(404).json({ error: 'Auslage nicht gefunden' });
    const row = aus.rows[0];
    const isOwner = row.user_email.toLowerCase() === (req.user.email || '').toLowerCase();
    if (!(isOwner && row.status === 'eingereicht') && !canEditAuslageStatus(row, req.user)) {
      return res.status(403).json({ error: 'Positionen nur bei eigener eingereichter Auslage oder Ausschuss editierbar' });
    }
    const positionen = Array.isArray(req.body?.positionen) ? req.body.positionen : [];
    await client.query('BEGIN');
    await client.query('DELETE FROM auslagen_positionen WHERE auslage_id = $1', [id]);
    let total = 0;
    for (let i = 0; i < positionen.length; i++) {
      const p = positionen[i];
      const typ = (p.position_typ === 'arbeitszeit') ? 'arbeitszeit' : 'material';
      const menge = Number(p.menge) || 1;
      const einzelpreis = Number(p.einzelpreis);
      const gesamt = Number(p.gesamt_chf);
      const finalGesamt = Number.isFinite(gesamt) ? gesamt
                       : Number.isFinite(einzelpreis) ? menge * einzelpreis : 0;
      if (finalGesamt < 0) continue;
      total += finalGesamt;
      await client.query(
        `INSERT INTO auslagen_positionen
           (auslage_id, position_typ, beschreibung, menge, einheit, einzelpreis_chf, gesamt_chf, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, typ, String(p.beschreibung || '').slice(0, 500), menge,
         p.einheit ? String(p.einheit).slice(0, 20) : null,
         Number.isFinite(einzelpreis) ? einzelpreis : null,
         finalGesamt, i],
      );
    }
    // Aktualisiere auslagen.betrag_chf wenn aktuell noch nicht gleich Summe
    if (positionen.length > 0 && Math.abs(Number(row.betrag_chf) - total) > 0.01) {
      await client.query('UPDATE auslagen SET betrag_chf = $1, updated_at = NOW() WHERE id = $2', [total, id]);
    }
    await client.query('COMMIT');
    res.json({ success: true, total_chf: total, positionen_count: positionen.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Positionen update error:', err);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Stundensatz-Config
app.get('/api/auslagen-stundensatz', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM auslagen_stundensatz ORDER BY stweg NULLS FIRST');
    res.json({ saetze: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/auslagen-stundensatz', authMiddleware, requirePermission('auslagen-stundensatz', 'write'), async (req, res) => {
  try {
    const b = req.body || {};
    const stwegInt = b.stweg === null || b.stweg === '' ? null : parseInt(b.stweg, 10);
    if (b.stweg !== null && b.stweg !== '' && (!Number.isFinite(stwegInt) || stwegInt < 1 || stwegInt > 8)) {
      return res.status(400).json({ error: 'Ungueltiger STWEG' });
    }
    const satz = Number(b.satz_chf);
    if (!Number.isFinite(satz) || satz <= 0 || satz > 500) return res.status(400).json({ error: 'Stundensatz muss 0 < satz <= 500' });
    const r = await pool.query(
      `INSERT INTO auslagen_stundensatz (stweg, satz_chf, beschreibung, gueltig_ab)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE))
       ON CONFLICT (COALESCE(stweg, -1))
         DO UPDATE SET satz_chf = EXCLUDED.satz_chf, beschreibung = EXCLUDED.beschreibung,
                       gueltig_ab = EXCLUDED.gueltig_ab, updated_at = NOW()
       RETURNING *`,
      [stwegInt, satz, b.beschreibung || null, b.gueltig_ab || null],
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/auslagen-stundensatz/:id', authMiddleware, requirePermission('auslagen-stundensatz', 'write'), async (req, res) => {
  try {
    await pool.query('DELETE FROM auslagen_stundensatz WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper-API: liefert den gueltigen Stundensatz fuer einen STWEG (mit Fallback auf uebergreifend)
app.get('/api/auslagen-stundensatz/aktuell', authMiddleware, requirePermission('auslagen', 'read'), async (req, res) => {
  try {
    const stwegInt = parseInt(req.query.stweg, 10);
    const stwegVal = Number.isFinite(stwegInt) && stwegInt >= 1 && stwegInt <= 8 ? stwegInt : null;
    const r = await pool.query(
      `SELECT * FROM auslagen_stundensatz
        WHERE (stweg = $1) OR (stweg IS NULL)
        ORDER BY (stweg = $1) DESC NULLS LAST, stweg NULLS LAST LIMIT 1`,
      [stwegVal],
    );
    if (r.rows.length === 0) return res.json({ satz_chf: null });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Seed: Auslagen-Stundensatz read fuer Ausschuss + Eigentuemer (zum Anzeigen)
// → wird im initDB-Seed unten ergaenzt

// ─── Mail-Empfaenger Stammdaten ──────────────────────────────────────
// Generische Stammdaten fuer Mail-Adressaten (Anwalt, Bank, Versicherung,
// Handwerker, Behoerde, Energieversorger etc.). Wird genutzt von der
// Ad-hoc-Compose-Funktion und kann von automatischen Workflows referenziert
// werden ueber findEmpfaenger(kategorie, stweg).

const EMPFAENGER_KATEGORIEN = [
  'verwaltung',     // virtuell — sucht in verwaltungen-Tabelle
  'anwalt',
  'bank',
  'versicherung',
  'behoerde',
  'energie',
  'handwerker',
  'lieferant',
  'sonstige',
];

// Liefert die zustaendigen Empfaenger fuer (kategorie, stweg).
// Reihenfolge: STWEG-spezifisch → STWEG-uebergreifend. Mehrere Treffer moeglich (alle).
async function findEmpfaenger(kategorie, stweg) {
  if (kategorie === 'verwaltung') {
    const verw = await findVerwaltungForStweg(stweg);
    if (!verw) return [];
    return [{
      id: verw.id, name: verw.firma, mailTo: verw.mailTo, mailCc: verw.mailCc,
      replyTo: null, requires_approval: true, fallback: verw.fallback,
    }];
  }
  const stwegInt = parseInt(stweg, 10);
  const stwegVal = Number.isFinite(stwegInt) && stwegInt >= 1 && stwegInt <= 8 ? stwegInt : null;
  // STWEG-spezifisch zuerst
  let r = stwegVal
    ? await pool.query(
        'SELECT * FROM mail_empfaenger WHERE aktiv = true AND kategorie = $1 AND stweg = $2 ORDER BY id',
        [kategorie, stwegVal])
    : { rows: [] };
  if (r.rows.length === 0) {
    r = await pool.query(
      'SELECT * FROM mail_empfaenger WHERE aktiv = true AND kategorie = $1 AND stweg IS NULL ORDER BY id',
      [kategorie]);
  }
  return r.rows.map(e => {
    const kontaktEmails = (e.kontakte || []).map(k => k.email).filter(Boolean);
    const ccList = [...(e.default_cc || '').split(',').map(s => s.trim()).filter(Boolean), ...kontaktEmails]
      .filter((v, i, a) => v && a.indexOf(v) === i);
    return {
      id: e.id, name: e.name, mailTo: e.email ? [e.email] : [],
      mailCc: ccList, replyTo: e.default_reply_to || null,
      requires_approval: e.requires_approval !== false, fallback: null,
    };
  });
}

// CRUD-API
app.get('/api/mail-empfaenger', authMiddleware, requirePermission('mail-empfaenger', 'read'), async (req, res) => {
  try {
    const kategorie = String(req.query.kategorie || '').trim();
    const stwegFilter = parseInt(req.query.stweg, 10);
    const params = [];
    let where = 'TRUE';
    if (kategorie) { params.push(kategorie); where += ` AND kategorie = $${params.length}`; }
    if (Number.isFinite(stwegFilter)) { params.push(stwegFilter); where += ` AND (stweg = $${params.length} OR stweg IS NULL)`; }
    const r = await pool.query(
      `SELECT * FROM mail_empfaenger WHERE ${where} ORDER BY aktiv DESC, kategorie, stweg NULLS FIRST, name`,
      params,
    );
    res.json({ empfaenger: r.rows, kategorien: EMPFAENGER_KATEGORIEN });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mail-empfaenger', authMiddleware, requirePermission('mail-empfaenger', 'write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.kategorie || !EMPFAENGER_KATEGORIEN.includes(b.kategorie)) {
      return res.status(400).json({ error: 'Ungueltige Kategorie' });
    }
    if (b.kategorie === 'verwaltung') {
      return res.status(400).json({ error: 'Kategorie "verwaltung" bitte in der Verwaltungs-Stammdaten-Verwaltung pflegen' });
    }
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const r = await pool.query(
      `INSERT INTO mail_empfaenger
         (kategorie, name, email, telefon, adresse, website, stweg, kontakte,
          default_cc, default_reply_to, requires_approval, notiz, aktiv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10, COALESCE($11, true), $12, COALESCE($13, true))
       RETURNING *`,
      [b.kategorie, String(b.name).trim().slice(0, 255), b.email || null, normalizePhone(b.telefon),
       b.adresse || null, b.website || null, b.stweg || null,
       JSON.stringify(b.kontakte || []),
       b.default_cc || null, b.default_reply_to || null, b.requires_approval, b.notiz || null, b.aktiv],
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mail-empfaenger/:id', authMiddleware, requirePermission('mail-empfaenger', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const b = req.body || {};
    if (b.kategorie && !EMPFAENGER_KATEGORIEN.includes(b.kategorie)) {
      return res.status(400).json({ error: 'Ungueltige Kategorie' });
    }
    const r = await pool.query(
      `UPDATE mail_empfaenger SET
         kategorie = COALESCE($1, kategorie),
         name = COALESCE($2, name),
         email = $3, telefon = $4, adresse = $5, website = $6,
         stweg = $7, kontakte = COALESCE($8::jsonb, kontakte),
         default_cc = $9, default_reply_to = $10,
         requires_approval = COALESCE($11, requires_approval),
         notiz = $12, aktiv = COALESCE($13, aktiv), updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [b.kategorie || null, b.name ? String(b.name).trim().slice(0, 255) : null,
       b.email || null, normalizePhone(b.telefon), b.adresse || null, b.website || null,
       b.stweg || null,
       b.kontakte !== undefined ? JSON.stringify(b.kontakte) : null,
       b.default_cc || null, b.default_reply_to || null,
       b.requires_approval, b.notiz || null, b.aktiv, id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mail-empfaenger/:id', authMiddleware, requirePermission('mail-empfaenger', 'write'), async (req, res) => {
  try {
    await pool.query('DELETE FROM mail_empfaenger WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Personen-API ────────────────────────────────────────────────────
// Personen sind die Single Source of Truth fuer Kontaktdaten. Aenderungen
// werden automatisch via DB-Trigger auf alle verknuepften wohnungen_kontakte
// propagiert.

// Lese-Zugriff: alle die wohnungsverwaltung lesen koennen
function requireWohnungsverwaltungRead(req, res, next) {
  return requirePermission('wohnungsverwaltung', 'read')(req, res, next);
}
function requireWohnungsverwaltungWrite(req, res, next) {
  return requirePermission('wohnungsverwaltung', 'write')(req, res, next);
}

// H4: Pruefe ob User berechtigt ist, eine Person zu editieren.
// Technik/Praesident: alle Personen. Ausschuss: nur Personen aus dem eigenen STWEG
// (mind. eine wohnungen_kontakte-Zeile zu einer Wohnung im STWEG des Users).
async function userCanEditPerson(user, personId) {
  const groups = user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return true;
  const ausschussStwegs = [...getAusschussStwegs(groups)];
  if (ausschussStwegs.length === 0) return false;
  const r = await pool.query(
    `SELECT 1 FROM wohnungen_kontakte k
       JOIN wohnungen w ON w.id = k.wohnung_id
      WHERE k.person_id = $1 AND w.stweg = ANY($2::int[])
      LIMIT 1`,
    [personId, ausschussStwegs],
  );
  return r.rows.length > 0;
}

// GET /api/personen — Liste aller Personen mit ihren Wohnungen
app.get('/api/personen', authMiddleware, requireWohnungsverwaltungRead, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const params = [];
    let where = 'TRUE';
    if (search) {
      params.push(`%${search}%`);
      where = `(LOWER(p.name) LIKE $1 OR LOWER(COALESCE(p.email,'')) LIKE $1)`;
    }
    const r = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM wohnungen_kontakte k WHERE k.person_id = p.id AND k.archiviert_am IS NULL) AS n_wohnungen,
              (SELECT json_agg(json_build_object(
                 'wohnung_id', w.id, 'stweg', w.stweg, 'bezeichnung', w.bezeichnung,
                 'rolle', k.rolle, 'kontakt_id', k.id, 'archiviert_am', k.archiviert_am
               ) ORDER BY w.stweg, w.bezeichnung)
                 FROM wohnungen_kontakte k
                 JOIN wohnungen w ON w.id = k.wohnung_id
                WHERE k.person_id = p.id AND k.archiviert_am IS NULL) AS wohnungen
         FROM personen p
        WHERE ${where}
        ORDER BY p.name LIMIT 1000`,
      params,
    );
    res.json({ personen: r.rows });
  } catch (err) {
    console.error('Personen list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// GET /api/personen/:id — eine Person mit Details
app.get('/api/personen/:id', authMiddleware, requireWohnungsverwaltungRead, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const r = await pool.query(
      `SELECT p.*,
              (SELECT json_agg(json_build_object(
                 'wohnung_id', w.id, 'stweg', w.stweg, 'bezeichnung', w.bezeichnung,
                 'rolle', k.rolle, 'kontakt_id', k.id, 'archiviert_am', k.archiviert_am
               ) ORDER BY w.stweg, w.bezeichnung)
                 FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
                WHERE k.person_id = p.id) AS wohnungen
         FROM personen p WHERE p.id = $1`,
      [id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/personen/:id — Person aktualisieren (Trigger propagiert auf alle Kontakte)
app.put('/api/personen/:id', authMiddleware, requireWohnungsverwaltungWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    // H4: STWEG-Scope-Check: Ausschuss darf nur Personen aus eigenem STWEG editieren
    const allowed = await userCanEditPerson(req.user, id);
    if (!allowed) return res.status(403).json({ error: 'Diese Person gehoert nicht zu einem STWEG fuer den du Ausschuss-Berechtigung hast' });
    const b = req.body || {};
    const updates = [];
    const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };
    if (b.name !== undefined) push('name', String(b.name).slice(0, 255).trim() || null);
    if (b.vorname !== undefined) push('vorname', b.vorname ? String(b.vorname).slice(0, 120) : null);
    if (b.nachname !== undefined) push('nachname', b.nachname ? String(b.nachname).slice(0, 120) : null);
    if (b.anrede !== undefined) push('anrede', b.anrede ? String(b.anrede).slice(0, 20) : null);
    if (b.email !== undefined) push('email', b.email ? String(b.email).trim().slice(0, 255) : null);
    if (b.telefon !== undefined) push('telefon', normalizePhone(b.telefon ? String(b.telefon).slice(0, 60) : null));
    if (b.mobile !== undefined) push('mobile', normalizePhone(b.mobile ? String(b.mobile).slice(0, 60) : null));
    if (b.telefone !== undefined) {
      const t = Array.isArray(b.telefone) ? b.telefone.map(x => ({
        typ: String(x.typ || 'sonstige').slice(0, 30),
        label: x.label ? String(x.label).slice(0, 80) : null,
        nummer: normalizePhone(String(x.nummer || '').slice(0, 60)),
      })).filter(x => x.nummer) : [];
      push('telefone', JSON.stringify(t));
    }
    if (b.adresse !== undefined) push('adresse', b.adresse || null);
    if (b.geburtsdatum !== undefined) push('geburtsdatum', b.geburtsdatum || null);
    if (b.notiz !== undefined) push('notiz', b.notiz || null);
    if (b.review_needed !== undefined) push('review_needed', !!b.review_needed);
    if (updates.length === 0) return res.status(400).json({ error: 'Keine Aenderungen' });
    params.push(id);
    const r = await pool.query(
      `UPDATE personen SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });

    // Verwaltung informieren wenn Email/Telefon/Adresse geaendert
    const relevantChanged = ['email', 'telefon', 'adresse'].some(f => b[f] !== undefined);
    if (relevantChanged) {
      try {
        const wRes = await pool.query(
          `SELECT DISTINCT w.stweg FROM wohnungen_kontakte k
             JOIN wohnungen w ON w.id = k.wohnung_id
            WHERE k.person_id = $1 AND k.archiviert_am IS NULL`,
          [id],
        );
        for (const row of wRes.rows) {
          const summary = `Kontaktdaten von ${r.rows[0].name} aktualisiert (gilt fuer alle ${wRes.rows.length} Wohnung(en) der Person)`;
          recordObjektChange(row.stweg, summary, req.user.email).catch(() => {});
        }
      } catch {}
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Personen update error:', err);
    res.status(500).json({ error: 'Fehler beim Aktualisieren' });
  }
});

// POST /api/personen — neue Person anlegen
app.post('/api/personen', authMiddleware, requireWohnungsverwaltungWrite, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const r = await pool.query(
      `INSERT INTO personen (name, vorname, nachname, anrede, email, telefon, mobile, adresse, geburtsdatum, notiz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [String(b.name).trim().slice(0,255), b.vorname || null, b.nachname || null, b.anrede || null,
       b.email || null, normalizePhone(b.telefon), normalizePhone(b.mobile), b.adresse || null, b.geburtsdatum || null, b.notiz || null],
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/personen-dedup/kandidaten — moegliche Duplikate vorschlagen.
// Drei Heuristiken:
//   1. 'exakt': gleicher Name (LOWER+TRIM) → klare Dubletten
//   2. 'token': gleicher Token-Set (Vorname Nachname vs Nachname Vorname)
//   3. 'email': gleiche Email aber sehr aehnliche Namen
app.get('/api/personen-dedup/kandidaten', authMiddleware, requireWohnungsverwaltungWrite, async (req, res) => {
  try {
    const r = await pool.query(`
      WITH normed AS (
        SELECT id, name, email, telefon,
               LOWER(TRIM(name)) AS name_norm,
               -- Token-Set: alphabetisch sortierte Woerter (lower-case)
               (SELECT string_agg(t, ' ' ORDER BY t)
                  FROM unnest(string_to_array(LOWER(TRIM(name)), ' ')) AS t
                 WHERE t <> '') AS token_key
          FROM personen
      ),
      exakt AS (
        SELECT 'exakt' AS art, name_norm AS schluessel, 1 AS sort,
               array_agg(id ORDER BY id) AS ids, COUNT(*) AS n
          FROM normed GROUP BY name_norm HAVING COUNT(*) > 1
      ),
      token AS (
        -- Nur wenn Token-Set duplikat ist UND exakte Form nicht greift (sonst doppelte Anzeige)
        SELECT 'token' AS art, token_key AS schluessel, 2 AS sort,
               array_agg(id ORDER BY id) AS ids, COUNT(*) AS n
          FROM normed
         WHERE token_key IS NOT NULL
         GROUP BY token_key HAVING COUNT(*) > 1
            AND COUNT(DISTINCT name_norm) > 1
      ),
      gleich_email AS (
        -- Email-Duplikate (Familien) mit unterschiedlichem Namen — kein Merge-Hinweis,
        -- nur als Info ob es echte Dubletten geben koennte (z.B. Tippfehler im Namen)
        SELECT 'email' AS art, LOWER(TRIM(email)) AS schluessel, 3 AS sort,
               array_agg(id ORDER BY id) AS ids, COUNT(*) AS n
          FROM normed
         WHERE email IS NOT NULL AND email <> ''
         GROUP BY LOWER(TRIM(email))
        HAVING COUNT(*) > 1 AND COUNT(DISTINCT name_norm) > 1
      ),
      all_dups AS (
        SELECT * FROM exakt UNION ALL SELECT * FROM token UNION ALL SELECT * FROM gleich_email
      )
      SELECT art, schluessel, ids, n,
             (SELECT json_agg(json_build_object(
                'id', p.id, 'name', p.name, 'email', p.email, 'telefon', p.telefon, 'mobile', p.mobile,
                'n_wohnungen', (SELECT COUNT(*) FROM wohnungen_kontakte k
                                  WHERE k.person_id = p.id AND k.archiviert_am IS NULL)
              ) ORDER BY p.id)
                FROM personen p WHERE p.id = ANY(ids)) AS personen
        FROM all_dups
       ORDER BY sort, n DESC, schluessel
       LIMIT 200
    `);
    res.json({ kandidaten: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/personen/merge — zwei Personen zusammenfuehren
// body: { keep_id, merge_id } — alle Kontakte von merge_id werden auf keep_id umgehaengt,
// merge_id wird geloescht. Daten aus merge_id ueberschreiben die in keep_id nur wenn keep_id-Feld leer ist.
app.post('/api/personen/merge', authMiddleware, requireWohnungsverwaltungWrite, async (req, res) => {
  const client = await pool.connect();
  try {
    const keepId = parseInt(req.body?.keep_id, 10);
    const mergeId = parseInt(req.body?.merge_id, 10);
    if (!Number.isFinite(keepId) || !Number.isFinite(mergeId) || keepId === mergeId) {
      return res.status(400).json({ error: 'keep_id und merge_id (verschieden) erforderlich' });
    }
    // H4: beide Personen muessen im Scope sein
    const [canKeep, canMerge] = await Promise.all([
      userCanEditPerson(req.user, keepId), userCanEditPerson(req.user, mergeId),
    ]);
    if (!canKeep || !canMerge) {
      return res.status(403).json({ error: 'Mindestens eine Person gehoert nicht zu deinem STWEG-Scope' });
    }
    await client.query('BEGIN');
    const k = await client.query('SELECT * FROM personen WHERE id = $1', [keepId]);
    const m = await client.query('SELECT * FROM personen WHERE id = $1', [mergeId]);
    if (k.rows.length === 0 || m.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Person(en) nicht gefunden' });
    }
    // Fields aus merge → keep falls keep leer
    const fields = ['vorname','nachname','anrede','email','telefon','mobile','adresse','geburtsdatum','notiz'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (!k.rows[0][f] && m.rows[0][f]) {
        params.push(m.rows[0][f]);
        updates.push(`${f} = $${params.length}`);
      }
    }
    if (updates.length > 0) {
      params.push(keepId);
      await client.query(`UPDATE personen SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    }
    // Alle Kontakte umhaengen
    const reassigned = await client.query(
      `UPDATE wohnungen_kontakte SET person_id = $1 WHERE person_id = $2`,
      [keepId, mergeId],
    );
    // Merge-Person loeschen
    await client.query('DELETE FROM personen WHERE id = $1', [mergeId]);
    await client.query('COMMIT');
    res.json({ success: true, reassigned_kontakte: reassigned.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Personen merge error:', err);
    res.status(500).json({ error: 'Merge fehlgeschlagen: ' + err.message });
  } finally {
    client.release();
  }
});

// ─── Ad-hoc Mail-Composer ─────────────────────────────────────────────
// Erlaubt das Schreiben einer freien Mail an einen beliebigen Empfaenger
// (entweder direkt eingegeben oder aus mail_empfaenger-Stammdaten gewaehlt).
// Geht durch den gleichen Genehmigungs-Workflow wie automatische Mails.
// Attachments werden inline base64 in der Queue gespeichert.
app.post('/api/mail-compose', authMiddleware, requirePermission('mail-compose', 'write'), async (req, res) => {
  try {
    // H1: Rate-Limit gegen Mail-Spam-Abuse — 50 Mails / Stunde pro User
    const rl = rateLimitGuard('mail-compose', (req.user.email || 'anon').toLowerCase(), 50, 60 * 60 * 1000);
    if (!rl.ok) {
      return res.status(429).json({ error: `Rate-Limit erreicht (max 50 Mails/h). Bitte ${Math.ceil(rl.retryAfter / 60)} Min warten.` });
    }
    const b = req.body || {};

    // Empfaenger entweder direkt (mail_to) oder via Stammdaten (empfaenger_id)
    let mailTo = b.mail_to;
    let mailCc = b.mail_cc;
    let mailReplyTo = b.mail_reply_to;
    let requiresApproval = b.requires_approval !== false;
    let sourceType = 'ad-hoc';
    let sourceId = null;
    let firma = null;

    if (b.empfaenger_id) {
      const empfId = parseInt(b.empfaenger_id, 10);
      const er = await pool.query('SELECT * FROM mail_empfaenger WHERE id = $1 AND aktiv = true', [empfId]);
      if (er.rows.length === 0) return res.status(404).json({ error: 'Empfaenger nicht gefunden oder inaktiv' });
      const e = er.rows[0];
      firma = e.name;
      sourceType = `ad-hoc-${e.kategorie}`;
      sourceId = e.id;
      if (!mailTo) mailTo = e.email ? [e.email] : [];
      if (!mailCc) {
        const kontaktEmails = (e.kontakte || []).map(k => k.email).filter(Boolean);
        const def = (e.default_cc || '').split(',').map(s => s.trim()).filter(Boolean);
        mailCc = [...def, ...kontaktEmails].filter((v, i, a) => v && a.indexOf(v) === i);
      }
      if (!mailReplyTo) mailReplyTo = e.default_reply_to || null;
      if (b.requires_approval === undefined) requiresApproval = e.requires_approval !== false;
    }

    if (!mailTo || (Array.isArray(mailTo) ? mailTo.length === 0 : !String(mailTo).trim())) {
      return res.status(400).json({ error: 'Empfaenger (mail_to oder empfaenger_id) erforderlich' });
    }
    if (!b.subject || !String(b.subject).trim()) return res.status(400).json({ error: 'Betreff erforderlich' });
    if (!b.body_text || !String(b.body_text).trim()) return res.status(400).json({ error: 'Text erforderlich' });

    // Attachments: erwarten Liste [{filename, content_base64}]
    const attachments = [];
    for (const a of (b.attachments || [])) {
      if (!a.filename || !a.content_base64) continue;
      const sizeApprox = Math.floor(a.content_base64.length * 0.75);
      if (sizeApprox > 20 * 1024 * 1024) return res.status(400).json({ error: `Anhang ${a.filename} > 20 MB` });
      attachments.push({
        filename: String(a.filename).slice(0, 255),
        size: sizeApprox,
        content_base64: a.content_base64,
        docs_path: null,
      });
    }

    if (requiresApproval) {
      const queueId = await enqueueVerwaltungMail({
        source_type: sourceType,
        source_id: sourceId,
        mailTo, mailCc, mailReplyTo,
        subject: String(b.subject).trim().slice(0, 500),
        bodyText: String(b.body_text).slice(0, 100000),
        attachments,
        createdBy: req.user.email,
      });
      res.json({ ok: true, queued: true, queue_id: queueId, firma, requires_approval: true });
    } else {
      // Direktversand ohne Freigabe (z.B. an interne Empfaenger)
      const toStr = Array.isArray(mailTo) ? mailTo.join(', ') : String(mailTo);
      const ccStr = Array.isArray(mailCc) ? mailCc.join(', ') : (mailCc ? String(mailCc) : undefined);
      const liveAttachments = attachments.map(a => ({
        filename: a.filename,
        content: Buffer.from(a.content_base64, 'base64'),
      }));
      await loggedSendMail({
        from: MAIL_FROM, to: toStr, cc: ccStr, replyTo: mailReplyTo || undefined,
        subject: String(b.subject).trim(),
        text: String(b.body_text),
        attachments: liveAttachments,
      }, sourceType);
      res.json({ ok: true, queued: false, firma, requires_approval: false });
    }
  } catch (err) {
    console.error('Mail-compose error:', err);
    res.status(500).json({ error: 'Fehler beim Einstellen/Versand: ' + err.message });
  }
});

// ─── Mail-Templates ────────────────────────────────────────────────
// Erlaubt es, Subject/Body fuer ausgehende Mails pro source_type
// (+ optional Empfaenger-Kategorie) zu konfigurieren statt hartcodiert.
// Platzhalter-Syntax: {{path.to.field}}, z.B. {{auslage.betrag_chf}}.
// Erweiterte Helpers: {{#if x}}…{{/if}}, {{date x}}, {{chf x}}.

function tplGet(obj, path) {
  if (!path) return '';
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return '';
    cur = cur[p];
  }
  return cur == null ? '' : cur;
}

function tplFormat(value, helper) {
  if (value == null) return '';
  switch (helper) {
    case 'chf':
      return 'CHF ' + Number(value).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'date':
      try { return new Date(value).toLocaleDateString('de-CH'); } catch { return String(value); }
    case 'datetime':
      try { return new Date(value).toLocaleString('de-CH'); } catch { return String(value); }
    case 'upper':
      return String(value).toUpperCase();
    case 'lower':
      return String(value).toLowerCase();
    default:
      return String(value);
  }
}

function renderTemplate(template, context) {
  if (!template) return '';
  // {{#if path}}…{{/if}} — einfacher Bedingungsblock (nur top-level, kein nested)
  let out = template.replace(/\{\{#if\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, path, body) => {
    return tplGet(context, path.trim()) ? body : '';
  });
  // {{helper path}} oder {{path}}
  out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, expr) => {
    const parts = expr.trim().split(/\s+/);
    if (parts.length >= 2) {
      // helper path
      return tplFormat(tplGet(context, parts.slice(1).join(' ')), parts[0]);
    }
    return tplFormat(tplGet(context, parts[0]), null);
  });
  return out;
}

// Findet Template-Match. Reihenfolge: source_type + kategorie spezifisch,
// dann source_type allgemein. Returns null wenn kein Template aktiv.
async function findMailTemplate(sourceType, empfaengerKategorie) {
  const r = await pool.query(
    `SELECT * FROM mail_templates
      WHERE aktiv = true
        AND source_type = $1
        AND (empfaenger_kategorie = $2 OR empfaenger_kategorie IS NULL)
      ORDER BY (empfaenger_kategorie = $2) DESC NULLS LAST
      LIMIT 1`,
    [sourceType, empfaengerKategorie || null],
  );
  return r.rows[0] || null;
}

// CRUD fuer Templates (Technik/Praesident)
app.get('/api/mail-templates', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM mail_templates ORDER BY source_type, empfaenger_kategorie NULLS LAST');
    res.json({ templates: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mail-templates', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.source_type || !b.subject_template || !b.body_template) {
      return res.status(400).json({ error: 'source_type, subject_template und body_template erforderlich' });
    }
    const r = await pool.query(
      `INSERT INTO mail_templates (source_type, empfaenger_kategorie, subject_template, body_template, notiz, aktiv)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, true)) RETURNING *`,
      [String(b.source_type).trim().slice(0, 120), b.empfaenger_kategorie || null,
       b.subject_template, b.body_template, b.notiz || null, b.aktiv],
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mail-templates/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const r = await pool.query(
      `UPDATE mail_templates SET
         source_type = COALESCE($1, source_type),
         empfaenger_kategorie = $2,
         subject_template = COALESCE($3, subject_template),
         body_template = COALESCE($4, body_template),
         notiz = $5, aktiv = COALESCE($6, aktiv), updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [b.source_type || null, b.empfaenger_kategorie || null,
       b.subject_template || null, b.body_template || null,
       b.notiz || null, b.aktiv, id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mail-templates/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    await pool.query('DELETE FROM mail_templates WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview-Endpoint: rendert Template gegen ein Beispiel-Context oder echte source_id
app.post('/api/mail-templates/preview', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const b = req.body || {};
    const subj = renderTemplate(b.subject_template || '', b.context || {});
    const body = renderTemplate(b.body_template || '', b.context || {});
    res.json({ subject: subj, body });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Mail-Approval-Config + 4-Augen-Logik ──────────────────────────
// Pro source_type-Pattern eine Regel. Bei Auslagen-Auszahlung auch
// betrags-abhaengig (z.B. >5000 CHF nur Praesident).

async function getApprovalRuleForQueueItem(queueRow) {
  // Betrag ermitteln (nur fuer auslage-auszahlung relevant)
  let betrag = 0;
  if (queueRow.source_type.startsWith('auslage-auszahlung') && queueRow.source_id) {
    const a = await pool.query('SELECT betrag_chf FROM auslagen WHERE id = $1', [queueRow.source_id]);
    if (a.rows[0]) betrag = Number(a.rows[0].betrag_chf) || 0;
  }
  // Suche passende Regel: zuerst source_type-spezifisch + betrag, dann ohne betrag, dann default
  const r = await pool.query(
    `SELECT * FROM mail_approval_config
      WHERE aktiv = true
        AND (source_type_pattern = $1 OR source_type_pattern = 'default')
        AND (min_betrag_chf IS NULL OR $2 >= min_betrag_chf)
      ORDER BY (source_type_pattern = $1) DESC,
               (min_betrag_chf IS NOT NULL) DESC,
               COALESCE(min_betrag_chf, 0) DESC,
               sort_order
      LIMIT 1`,
    [queueRow.source_type, betrag],
  );
  if (r.rows.length === 0) {
    // Fallback Default falls niemand was gepflegt hat
    return { required_groups: 'technik,praesident', min_approvers: 1, source_type_pattern: 'fallback' };
  }
  return r.rows[0];
}

function userHasAnyGroup(user, groupsCsv) {
  const userGroups = (user.groups || []).map(g => String(g).toLowerCase());
  const required = String(groupsCsv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return required.some(g => userGroups.includes(g));
}

// CRUD fuer Approval-Config (nur Technik/Praesident)
app.get('/api/mail-approval-config', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM mail_approval_config ORDER BY sort_order, source_type_pattern');
    res.json({ regeln: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mail-approval-config', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.source_type_pattern || !String(b.source_type_pattern).trim()) return res.status(400).json({ error: 'source_type_pattern erforderlich' });
    if (!b.required_groups || !String(b.required_groups).trim()) return res.status(400).json({ error: 'required_groups erforderlich (Komma-Liste)' });
    const minApprovers = parseInt(b.min_approvers, 10);
    const r = await pool.query(
      `INSERT INTO mail_approval_config
         (source_type_pattern, min_betrag_chf, required_groups, min_approvers, sort_order, notiz, aktiv)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), $6, COALESCE($7, true))
       RETURNING *`,
      [String(b.source_type_pattern).trim().slice(0, 120),
       b.min_betrag_chf || null,
       String(b.required_groups).trim(),
       Number.isFinite(minApprovers) && minApprovers >= 1 ? minApprovers : 1,
       b.sort_order, b.notiz || null, b.aktiv],
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/mail-approval-config/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const minApprovers = parseInt(b.min_approvers, 10);
    const r = await pool.query(
      `UPDATE mail_approval_config SET
         source_type_pattern = COALESCE($1, source_type_pattern),
         min_betrag_chf = $2,
         required_groups = COALESCE($3, required_groups),
         min_approvers = COALESCE($4, min_approvers),
         sort_order = COALESCE($5, sort_order),
         notiz = $6,
         aktiv = COALESCE($7, aktiv),
         updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [b.source_type_pattern || null, b.min_betrag_chf || null, b.required_groups || null,
       Number.isFinite(minApprovers) ? minApprovers : null,
       b.sort_order, b.notiz || null, b.aktiv, id],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/mail-approval-config/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    await pool.query('DELETE FROM mail_approval_config WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Verwaltungs-Mail-Outbox API ────────────────────────────────────
// Nur Technik + Praesident duerfen die Queue sehen/bearbeiten/freigeben.
function requireTechnikOrPraesident(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return next();
  return res.status(403).json({ error: 'Nur fuer Technik oder Praesident' });
}

// Liste aller Mails in der Queue (mit Filter)
app.get('/api/verwaltung-mail-queue', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const params = [];
    let where = 'TRUE';
    if (status && ['pending','freigegeben','abgelehnt','gesendet','fehler'].includes(status)) {
      params.push(status);
      where = `status = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, source_type, source_id, mail_to, mail_cc, mail_reply_to,
              subject, status, created_by, created_at, edited_by, edited_at,
              freigegeben_von, freigegeben_am, abgelehnt_von, abgelehnt_am, abgelehnt_grund,
              sent_at, send_error,
              COALESCE((SELECT COUNT(*) FROM verwaltung_mail_attachments WHERE queue_id = verwaltung_mail_queue.id),
                       jsonb_array_length(COALESCE(attachments, '[]'::jsonb))) AS attachment_count,
              LENGTH(body_text) AS body_size
         FROM verwaltung_mail_queue
        WHERE ${where}
        ORDER BY CASE WHEN status='pending' THEN 0 WHEN status='freigegeben' THEN 1 WHEN status='fehler' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 500`,
      params,
    );
    const pendingCount = await pool.query(`SELECT COUNT(*) AS cnt FROM verwaltung_mail_queue WHERE status = 'pending'`);
    res.json({ mails: r.rows, pending_count: parseInt(pendingCount.rows[0].cnt, 10) });
  } catch (err) {
    console.error('Mail-Queue list error:', err);
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Anzahl pending (fuer Nav-Badge)
app.get('/api/verwaltung-mail-queue/pending-count', authMiddleware, async (req, res) => {
  try {
    const groups = req.user?.groups || [];
    if (!isTechnik(groups) && !isPraesident(groups)) return res.json({ count: 0 });
    const r = await pool.query(`SELECT COUNT(*) AS cnt FROM verwaltung_mail_queue WHERE status = 'pending'`);
    res.json({ count: parseInt(r.rows[0].cnt, 10) });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// Detail (volle Mail inkl. body_text + Approval-Info)
app.get('/api/verwaltung-mail-queue/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const r = await pool.query('SELECT * FROM verwaltung_mail_queue WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const row = r.rows[0];
    const rule = await getApprovalRuleForQueueItem(row);
    const approvals = await pool.query(
      `SELECT approver_email, approved_at FROM mail_approval_log WHERE queue_id = $1 ORDER BY approved_at`,
      [id],
    );
    // M7: separate Attachments-Tabelle bevorzugen, sonst Legacy-JSONB
    const sepAtt = await pool.query(
      `SELECT filename, size_bytes AS size, docs_path FROM verwaltung_mail_attachments
        WHERE queue_id = $1 ORDER BY sort_order, id`,
      [id],
    );
    const attachmentsOut = sepAtt.rows.length > 0 ? sepAtt.rows : (row.attachments || []);
    res.json({
      ...row,
      attachments: attachmentsOut,
      _approval_rule: rule,
      _approvals: approvals.rows,
      _approvals_count: approvals.rows.length,
      _can_approve: userHasAnyGroup(req.user, rule.required_groups),
      _already_approved_by_me: approvals.rows.some(a => a.approver_email === req.user.email),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit (To/CC/Subject/Body) — nur solange pending.
// C2-Fix: Bei jeder inhaltlichen Aenderung werden alle bisherigen Approvals
// invalidiert, damit das 4-Augen-Prinzip nicht durch nachtraegliches Editieren
// umgangen werden kann.
app.put('/api/verwaltung-mail-queue/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM verwaltung_mail_queue WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nicht gefunden' });
    }
    const row = cur.rows[0];
    if (row.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Editieren nur bei Status 'pending' moeglich (aktuell: ${row.status})` });
    }
    // Beim ersten Edit Original-Snapshot speichern
    let snapshot = row.original_snapshot;
    if (!snapshot) {
      snapshot = {
        mail_to: row.mail_to, mail_cc: row.mail_cc, mail_reply_to: row.mail_reply_to,
        subject: row.subject, body_text: row.body_text,
      };
    }
    const b = req.body || {};
    const updates = [];
    const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };
    // Pruefen ob inhaltliche Aenderung vorliegt (fuer Approval-Reset)
    let contentChanged = false;
    const isDifferent = (a, b) => (a == null ? '' : String(a)) !== (b == null ? '' : String(b));
    if (b.mail_to !== undefined) {
      const v = String(b.mail_to).slice(0, 2000);
      if (isDifferent(v, row.mail_to)) contentChanged = true;
      push('mail_to', v);
    }
    if (b.mail_cc !== undefined) {
      const v = b.mail_cc ? String(b.mail_cc).slice(0, 2000) : null;
      if (isDifferent(v, row.mail_cc)) contentChanged = true;
      push('mail_cc', v);
    }
    if (b.mail_reply_to !== undefined) {
      const v = b.mail_reply_to ? String(b.mail_reply_to).slice(0, 255) : null;
      if (isDifferent(v, row.mail_reply_to)) contentChanged = true;
      push('mail_reply_to', v);
    }
    if (b.subject !== undefined) {
      const v = String(b.subject).slice(0, 500);
      if (isDifferent(v, row.subject)) contentChanged = true;
      push('subject', v);
    }
    if (b.body_text !== undefined) {
      const v = String(b.body_text).slice(0, 100000);
      if (isDifferent(v, row.body_text)) contentChanged = true;
      push('body_text', v);
    }
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Keine Aenderungen' });
    }
    push('original_snapshot', JSON.stringify(snapshot));
    push('edited_by', req.user.email);
    push('edited_at', new Date());
    params.push(id);
    const r = await client.query(
      `UPDATE verwaltung_mail_queue SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    let invalidatedApprovals = 0;
    if (contentChanged) {
      const del = await client.query('DELETE FROM mail_approval_log WHERE queue_id = $1 RETURNING id', [id]);
      invalidatedApprovals = del.rowCount;
    }
    await client.query('COMMIT');
    res.json({ ...r.rows[0], _invalidated_approvals: invalidatedApprovals });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Mail-Queue edit error:', err);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  } finally {
    client.release();
  }
});

// Freigeben (Multi-Approver-faehig). Bei 4-Augen-Prinzip braucht's
// >= min_approvers verschiedene User aus required_groups. Erst dann Versand.
// H3-Fix: Race-Safe durch SELECT ... FOR UPDATE auf queue-Row im selben
// Transaktionsblock. Status-Wechsel auf 'freigegeben' atomar mit COUNT.
app.post('/api/verwaltung-mail-queue/:id/freigeben', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    await client.query('BEGIN');
    // Lock die queue-Row → andere parallele Freigaben warten
    const cur = await client.query('SELECT * FROM verwaltung_mail_queue WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nicht gefunden' }); }
    if (cur.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Status ist '${cur.rows[0].status}', erwartet 'pending'` });
    }
    const rule = await getApprovalRuleForQueueItem(cur.rows[0]);
    if (!userHasAnyGroup(req.user, rule.required_groups)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `Freigabe erfordert eine der Gruppen: ${rule.required_groups}` });
    }
    // Approval logen (UNIQUE constraint verhindert Doppel-Freigabe vom gleichen User)
    try {
      await client.query(
        `INSERT INTO mail_approval_log (queue_id, approver_email) VALUES ($1, $2)`,
        [id, req.user.email],
      );
    } catch (e) {
      await client.query('ROLLBACK');
      if (String(e.code) === '23505') {
        return res.status(409).json({ error: 'Du hast bereits freigegeben — fuer ' + rule.min_approvers + '-Augen-Prinzip braucht es weitere Approver' });
      }
      throw e;
    }
    const cnt = await client.query('SELECT COUNT(*) AS n FROM mail_approval_log WHERE queue_id = $1', [id]);
    const approvalsSoFar = parseInt(cnt.rows[0].n, 10);
    if (approvalsSoFar < rule.min_approvers) {
      await client.query('COMMIT');
      return res.json({
        success: true, sent: false, awaiting_more_approvers: true,
        approvals: approvalsSoFar, required: rule.min_approvers,
        required_groups: rule.required_groups,
      });
    }
    // Genug Approver → status freigegeben innerhalb der Transaktion (atomic mit COUNT)
    await client.query(
      `UPDATE verwaltung_mail_queue SET status = 'freigegeben', freigegeben_von = $1, freigegeben_am = NOW() WHERE id = $2`,
      [req.user.email, id],
    );
    await client.query('COMMIT');
    // Mail-Versand erst NACH COMMIT (sendVerwaltungMailFromQueue nutzt eigene Connection)
    try {
      await sendVerwaltungMailFromQueue(id, req.user.email);
      res.json({ success: true, sent: true, approvals: approvalsSoFar, required: rule.min_approvers });
    } catch (sendErr) {
      console.error(`[mail-queue ${id}] Send error:`, sendErr);
      res.status(500).json({ success: false, error: 'Freigegeben, aber Versand schlug fehl: ' + sendErr.message });
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Mail-Queue freigeben error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Ablehnen mit Grund
app.post('/api/verwaltung-mail-queue/:id/ablehnen', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungueltige ID' });
    const grund = String(req.body?.grund || '').slice(0, 1000);
    if (!grund.trim()) return res.status(400).json({ error: 'Grund erforderlich' });
    const cur = await pool.query('SELECT status, source_type, source_id, subject FROM verwaltung_mail_queue WHERE id = $1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    if (cur.rows[0].status !== 'pending') {
      return res.status(409).json({ error: `Status ist '${cur.rows[0].status}', erwartet 'pending'` });
    }
    await pool.query(
      `UPDATE verwaltung_mail_queue
          SET status = 'abgelehnt', abgelehnt_von = $1, abgelehnt_am = NOW(), abgelehnt_grund = $2
        WHERE id = $3`,
      [req.user.email, grund, id],
    );
    // Optional: bei source=auslage-auszahlung den Ausschuss informieren damit die Auslage neu bewertet werden kann
    try {
      const row = cur.rows[0];
      if (row.source_type.startsWith('auslage-auszahlung') && row.source_id) {
        const aR = await pool.query('SELECT user_email, user_name, bearbeitet_von FROM auslagen WHERE id = $1', [row.source_id]);
        if (aR.rows.length > 0) {
          const a = aR.rows[0];
          const cc = [a.user_email, a.bearbeitet_von].filter(v => v).join(', ');
          await loggedSendMail({
            from: MAIL_FROM,
            to: a.bearbeitet_von || a.user_email,
            cc,
            subject: `Auszahlungs-Mail abgelehnt: ${row.subject.slice(0, 80)}`,
            text:
              `Die Auszahlungs-Mail an die Verwaltung wurde von ${req.user.email} abgelehnt.\n\n`
              + `Grund: ${grund}\n\n`
              + `Auslage: ${SITE_URL}/auslagen.html\n`
              + `Mail-Queue: ${SITE_URL}/verwaltung-mail-outbox.html`,
          }, 'verwaltung-mail-abgelehnt');
          // WhatsApp an Eigentuemer + Freigeber
          pushWhatsappBroadcast({
            emails: [a.user_email, a.bearbeitet_von].filter(v => v),
            sourceType: 'verwaltung-mail-abgelehnt', sourceId: row.source_id,
            body: `❌ *Auszahlungs-Mail abgelehnt* von ${req.user.email}\nAuslage: ${row.subject.slice(0, 80)}\n\n_Grund:_ ${grund}\n\n${SITE_URL}/auslagen.html`,
          }).catch(() => {});
        }
      }
    } catch (mailErr) {
      console.warn('[mail-queue] Ablehn-Notification fehlgeschlagen:', mailErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attachment-Download zur Vorschau
app.get('/api/verwaltung-mail-queue/:id/attachment/:idx', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isFinite(id) || !Number.isFinite(idx)) return res.status(400).end();
    // M7: separate Attachments-Tabelle, mit Fallback auf Legacy-JSONB
    let att = null;
    const sep = await pool.query(
      `SELECT filename, docs_path, content_base64 FROM verwaltung_mail_attachments
        WHERE queue_id = $1 ORDER BY sort_order, id OFFSET $2 LIMIT 1`,
      [id, idx],
    );
    if (sep.rows.length > 0) {
      att = sep.rows[0];
    } else {
      const r = await pool.query('SELECT attachments FROM verwaltung_mail_queue WHERE id = $1', [id]);
      if (r.rows.length === 0) return res.status(404).end();
      att = (r.rows[0].attachments || [])[idx];
    }
    if (!att) return res.status(404).end();
    // L4-Bonus: Safe filename + Null-Byte-Filter
    const safeFilename = (att.filename || 'beleg').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.').slice(0, 200) || 'beleg';
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    if (att.content_base64) {
      res.send(Buffer.from(att.content_base64, 'base64'));
      return;
    }
    if (att.docs_path) {
      const full = pathModule.join(DOCS_PATH, att.docs_path);
      if (!full.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
      return res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    }
    res.status(404).end();
  } catch (err) {
    res.status(500).end();
  }
});

// ─── PBX / Voicemail Integration ─────────────────────────────────────
// Asterisk-AGI laedt aufgenommene Voicemails hier hoch. Wir transkribieren
// via OpenRouter (Whisper-1), erstellen mit Claude eine kurze Zusammenfassung
// und mailen Audio + Transkript + Summary an Technik+Praesident.
//
// Authentifizierung: gleiches Pattern wie WhatsApp-Bot — Shared-Secret im
// X-PBX-Secret-Header, der mit PBX_SHARED_SECRET env var matched.

const PBX_SHARED_SECRET = process.env.PBX_SHARED_SECRET || '';

function requirePbxSecret(req, res, next) {
  if (!PBX_SHARED_SECRET) return res.status(503).json({ error: 'PBX_SHARED_SECRET nicht konfiguriert' });
  const provided = req.headers['x-pbx-secret'];
  if (provided !== PBX_SHARED_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function transcribeWhisper(audioBuf, mimeType = 'audio/wav') {
  // OpenRouter unterstuetzt Whisper-large-v3 ueber den /audio/transcriptions endpoint.
  // Falls OPENROUTER_API_KEY fehlt → leerer Transkript als Fallback.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { text: '', error: 'OPENROUTER_API_KEY nicht gesetzt' };
  const form = new FormData();
  form.append('file', new Blob([audioBuf], { type: mimeType }), 'voicemail.wav');
  form.append('model', 'openai/whisper-1');
  form.append('language', 'de');
  try {
    const r = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) return { text: '', error: `Whisper ${r.status}: ${await r.text().catch(() => '')}` };
    const data = await r.json();
    return { text: data.text || '', error: null };
  } catch (e) { return { text: '', error: e.message }; }
}

// Formatiert eine Verteiler-Email fuer WhatsApp-Gruppen-Mirror:
// - kompakter Titel (Subject)
// - 2-4 Bullet-Points mit Kernaussage
// - Action-Items wenn erkennbar
// - WhatsApp-Markdown (*fett* _kursiv_)
// Fallback: gestripptes Plain-Text wenn OpenRouter nicht verfuegbar
async function reformatEmailForWhatsapp({ subject, senderName, body, attachmentCount }) {
  const fallback = () => {
    const clipped = (body || '').slice(0, 1200);
    const attHint = attachmentCount > 0 ? `\n\n📎 ${attachmentCount} Anhang${attachmentCount > 1 ? 'e' : ''} per Email.` : '';
    return `📧 *${subject}*\nvon: ${senderName}\n\n${clipped}${attHint}`;
  };
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !body) return fallback();
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 1400,
        messages: [
          {
            role: 'system',
            content: `Du formatierst Emails fuer einen WhatsApp-Gruppen-Mirror der Rosenweg-STWEG.
Liefere eine WhatsApp-gerechte, AUSFUEHRLICHE Zusammenfassung in genau diesem Format:
📧 *<Titel mit max 70 Zeichen, evtl. gekuerzt>*
_von: <Absender>_

📝 *Worum geht's:*
<2-3 Saetze Kontext: was ist der Anlass, wer ist betroffen, worauf bezieht sich die Mail>

🔑 *Die wichtigsten Punkte:*
• <Bullet 1 — konkret, mit Zahlen/Daten/Namen wenn vorhanden, max 180 Zeichen>
• <Bullet 2>
• <Bullet 3>
• <weitere Bullets nach Bedarf, insgesamt 4-8 Stueck>

<Wenn Termine/Fristen erwaehnt: 📅 *Termine:* <Auflistung Datum/Frist>>
<Wenn Geldbetraege erwaehnt: 💰 *Betraege:* <Liste mit Posten + CHF>>
<Wenn klare Aktion verlangt: 👉 *Was ist zu tun:* <konkret, 1-2 Saetze, wer/was/wann>>

Regeln:
- WhatsApp-Markdown (*fett*, _kursiv_, kein Markdown-#)
- Maximal 3500 Zeichen Total — lieber ausfuehrlich als zu knapp
- Alle inhaltlich relevanten Details aus der Mail uebernehmen (Zahlen, Daten, Namen, Beschluesse, Begruendungen)
- Keine Floskeln, keine Gruessformeln, keine Signatur, keine Footer/Disclaimer, keine HTML-Reste
- Bei laengeren Mails: lieber 6-8 Bullets als alles in 3 zu quetschen
- Auf Deutsch (Schweizer Hochdeutsch, kein ß)`,
          },
          {
            role: 'user',
            content: `Absender: ${senderName}\nSubject: ${subject}\nAnhaenge: ${attachmentCount}\n\nEmail-Body:\n${body.slice(0, 8000)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return fallback();
    const data = await r.json();
    const txt = data.choices?.[0]?.message?.content?.trim();
    if (!txt || txt.length < 20) return fallback();
    // Anhang-Hint anhaengen falls nicht schon drin
    if (attachmentCount > 0 && !/📎/.test(txt)) {
      return txt + `\n\n📎 ${attachmentCount} Anhang${attachmentCount > 1 ? 'e' : ''} per Email.`;
    }
    return txt;
  } catch (err) {
    console.warn('[Verteiler-AI] Reformat fehlgeschlagen:', err.message);
    return fallback();
  }
}

async function summarizeVoicemail(transcript, callerId) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !transcript) return '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content: 'Du fasst Anrufbeantworter-Nachrichten der Rosenweg-STWEG zusammen. Liefere genau drei Zeilen: (1) Anliegen in 1 Satz, (2) Dringlichkeit niedrig/mittel/hoch, (3) Vorgeschlagene Aktion. Knapp, keine Hoeflichkeitsfloskeln.',
          },
          { role: 'user', content: `Anrufer: ${callerId}\nTranskript:\n${transcript}` },
        ],
      }),
    });
    if (!r.ok) return '';
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  } catch { return ''; }
}

app.post('/api/pbx/voicemail', requirePbxSecret, async (req, res) => {
  try {
    const audioBuf = req.body;
    if (!Buffer.isBuffer(audioBuf) || audioBuf.length < 1024) {
      return res.status(400).json({ error: 'Audio-Body fehlt oder zu klein' });
    }
    const callerId = String(req.headers['x-caller-id'] || 'unbekannt').slice(0, 50);
    const uniqueid = String(req.headers['x-unique-id'] || Date.now()).slice(0, 60);
    console.log(`[pbx-voicemail] empfangen: caller=${callerId} uid=${uniqueid} size=${audioBuf.length}`);

    // Transkription (parallel mit Mail-Vorbereitung)
    const { text: transcript, error: whErr } = await transcribeWhisper(audioBuf);
    if (whErr) console.warn('[pbx-voicemail] Whisper-Fehler:', whErr);
    const summary = await summarizeVoicemail(transcript, callerId);

    // Empfaenger: Technik + Praesident
    const r = await pool.query(
      `SELECT DISTINCT email FROM users
        WHERE active = true AND email IS NOT NULL
          AND (groups_json::jsonb ? 'technik' OR groups_json::jsonb ? 'Präsident')`,
    );
    const adminEmails = r.rows.map(x => x.email).filter(Boolean);

    // Audio als Attachment + Text-Email
    const subject = transcript
      ? `📞 Voicemail von ${callerId} — ${transcript.slice(0, 60).replace(/\n/g, ' ')}…`
      : `📞 Voicemail von ${callerId} (keine Transkription)`;
    const body = [
      `Eingang einer Voicemail an der Rosenweg-Nummer.`,
      ``,
      `Anrufer: ${callerId}`,
      `Zeit: ${new Date().toLocaleString('de-CH')}`,
      ``,
      `── KI-Zusammenfassung ──`,
      summary || '(keine Zusammenfassung verfuegbar)',
      ``,
      `── Volltranskript ──`,
      transcript || '(keine Transkription verfuegbar)',
      ``,
      whErr ? `(Whisper-Fehler: ${whErr})` : '',
    ].join('\n');

    if (adminEmails.length > 0) {
      await loggedSendMail({
        from: MAIL_FROM,
        to: adminEmails.join(', '),
        subject,
        text: body,
        attachments: [{ filename: `voicemail-${uniqueid}.wav`, content: audioBuf, contentType: 'audio/wav' }],
      }, 'pbx-voicemail').catch(err => console.warn('[pbx-voicemail] Mail-Fehler:', err.message));

      // WhatsApp-Push an Admins mit Opt-In: kompakte Variante
      pushWhatsappBroadcast({
        emails: adminEmails,
        sourceType: 'pbx-voicemail',
        body: `📞 *Voicemail* von ${callerId}\n${summary ? summary.split('\n').slice(0,2).join('\n') : (transcript ? transcript.slice(0, 200) : '(keine Transkription)')}\n\nDetails per Email.`,
      }).catch(() => {});
    }

    res.json({ ok: true, transcript_len: transcript.length, summary_present: !!summary });
  } catch (err) {
    console.error('[pbx-voicemail] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PBX Ring-Members: Admin-Verwaltung der Empfaengerliste ─────────────
// Asterisk-AGI holt die aktive Liste live via /active-Endpoint.

app.get('/api/pbx/ring-members', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, phone, enabled, is_temporary, valid_until, priority, person_id, added_by, notiz, created_at, updated_at
         FROM pbx_ring_members
        ORDER BY priority, name`
    );
    res.json({ members: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pbx/ring-members', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const { name, phone, is_temporary, valid_until, priority, person_id, notiz } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'name + phone erforderlich' });
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'Telefonnummer ungueltig' });
  try {
    const r = await pool.query(
      `INSERT INTO pbx_ring_members (name, phone, is_temporary, valid_until, priority, person_id, notiz, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, normalized, !!is_temporary, valid_until || null, priority || 100, person_id || null, notiz || null, req.user.email || req.user.name],
    );
    res.json({ member: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pbx/ring-members/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = ['name', 'phone', 'enabled', 'is_temporary', 'valid_until', 'priority', 'notiz'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(f === 'phone' ? (normalizePhone(req.body[f]) || req.body[f]) : req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Keine Aenderung' });
  params.push(id);
  try {
    const r = await pool.query(
      `UPDATE pbx_ring_members SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ member: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pbx/ring-members/:id', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pbx_ring_members WHERE id = $1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PBX Config (Geschaeftszeiten + Ring-Timeout) ─────────────────────────
app.get('/api/pbx/config', authMiddleware, requireTechnikOrPraesident, async (_req, res) => {
  try {
    const r = await pool.query(`SELECT key, value, updated_at, updated_by FROM pbx_config ORDER BY key`);
    const config = {};
    for (const row of r.rows) config[row.key] = { value: row.value, updated_at: row.updated_at, updated_by: row.updated_by };
    res.json({ config });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pbx/config', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const updates = req.body || {};
  const allowed = ['hours_open_from', 'hours_open_to', 'ring_timeout', 'weekdays'];
  // Validation
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) return res.status(400).json({ error: `Unbekannter Key: ${k}` });
    if ((k === 'hours_open_from' || k === 'hours_open_to') && !hhmm.test(v)) {
      return res.status(400).json({ error: `${k} muss HH:MM sein` });
    }
    if (k === 'ring_timeout' && (!Number.isFinite(+v) || +v < 5 || +v > 120)) {
      return res.status(400).json({ error: 'ring_timeout muss 5-120 Sekunden sein' });
    }
  }
  try {
    for (const [k, v] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO pbx_config (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [k, String(v), req.user.email || req.user.name],
      );
    }
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AGI-Endpoint: liefert ob jetzt Geschaeftszeit ist (timezone Europe/Zurich)
app.get('/api/pbx/hours/check', requirePbxSecret, async (_req, res) => {
  try {
    const r = await pool.query(`SELECT key, value FROM pbx_config WHERE key IN ('hours_open_from','hours_open_to','weekdays')`);
    const cfg = {};
    for (const row of r.rows) cfg[row.key] = row.value;
    const from = cfg.hours_open_from || '06:00';
    const to   = cfg.hours_open_to   || '20:00';
    // Aktuelle Schweizer Zeit
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(now);
    const hh = fmt.find(p => p.type === 'hour').value;
    const mm = fmt.find(p => p.type === 'minute').value;
    const wd = fmt.find(p => p.type === 'weekday').value.toLowerCase(); // mo,di,…
    const nowHM = `${hh}:${mm}`;
    const inHours = nowHM >= from && nowHM < to;
    res.json({
      is_open: inHours, // simpler: ignoriert weekdays vorerst
      now_local: nowHM,
      weekday: wd,
      from, to,
      ring_timeout: parseInt(cfg.ring_timeout || '30', 10),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aktive Liste fuer AGI-Lookup: nur enabled + nicht abgelaufen, geordnet
app.get('/api/pbx/ring-members/active', requirePbxSecret, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, phone, priority FROM pbx_ring_members
        WHERE enabled = true
          AND (valid_until IS NULL OR valid_until > NOW())
        ORDER BY priority, name`
    );
    res.json({ members: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PBX Call-Log Events (von Asterisk-AGI gepostet) ─────────────────────
// Body: { event: 'start' | 'answer' | 'end', direction, caller_id, dialed,
//          uniqueid, answered_by, hangup_cause, started_at, answered_at, ended_at }
app.post('/api/pbx/call-event', requirePbxSecret, async (req, res) => {
  const { event, direction, caller_id, dialed, uniqueid, answered_by, hangup_cause,
          started_at, answered_at, ended_at, meta } = req.body || {};
  if (!event || !uniqueid) return res.status(400).json({ error: 'event + uniqueid erforderlich' });
  try {
    if (event === 'start') {
      await pool.query(
        `INSERT INTO pbx_calls (direction, caller_id, dialed, uniqueid, started_at, meta)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6::jsonb)
         ON CONFLICT (uniqueid) DO NOTHING`,
        [direction || 'inbound', caller_id, dialed, uniqueid, started_at || null, JSON.stringify(meta || {})],
      );
    } else if (event === 'answer') {
      await pool.query(
        `UPDATE pbx_calls SET answered_at = COALESCE($2::timestamptz, NOW()), answered_by = $3 WHERE uniqueid = $1`,
        [uniqueid, answered_at || null, answered_by || null],
      );
    } else if (event === 'end') {
      await pool.query(
        `UPDATE pbx_calls SET ended_at = COALESCE($2::timestamptz, NOW()),
                              hangup_cause = $3,
                              duration_seconds = CASE WHEN answered_at IS NOT NULL THEN
                                EXTRACT(EPOCH FROM (COALESCE($2::timestamptz, NOW()) - answered_at))::int
                              END
          WHERE uniqueid = $1`,
        [uniqueid, ended_at || null, hangup_cause || null],
      );
    }
    res.json({ ok: true });
  } catch (err) { console.error('[pbx-call-event]', err); res.status(500).json({ error: err.message }); }
});

// ── PBX Call-Log (Admin-View) ────────────────────────────────────────────
app.get('/api/pbx/calls', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const r = await pool.query(
      `SELECT id, direction, caller_id, dialed, started_at, answered_at, ended_at,
              answered_by, duration_seconds, hangup_cause,
              voicemail_transcript, voicemail_summary
         FROM pbx_calls ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ calls: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PBX Test-Outbound (Sandbox) + Trunk-Status ─────────────────────────────
// Asterisk-Manager-Interface auf 100.64.2.29:5038 (siehe manager.conf in pbx/)
const PBX_HOST = process.env.PBX_HOST || '100.64.2.29';
const PBX_AMI_USER = process.env.PBX_AMI_USER || 'rosenweg';
const PBX_AMI_SECRET = process.env.PBX_AMI_SECRET || '';

function amiCommand(action, extraFields = {}) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const client = net.connect(5038, PBX_HOST, () => {
      client.write(`Action: Login\r\nUsername: ${PBX_AMI_USER}\r\nSecret: ${PBX_AMI_SECRET}\r\n\r\n`);
      const fields = Object.entries(extraFields).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      client.write(`Action: ${action}\r\n${fields}\r\nActionID: rw1\r\n\r\n`);
      client.write(`Action: Logoff\r\n\r\n`);
    });
    let buf = '';
    client.on('data', d => buf += d.toString());
    client.on('end', () => resolve(buf));
    client.on('error', reject);
    setTimeout(() => { try { client.destroy(); } catch {} reject(new Error('AMI-Timeout')); }, 8000);
  });
}

app.get('/api/pbx/trunk-status', authMiddleware, requireTechnikOrPraesident, async (_req, res) => {
  try {
    const out = await amiCommand('Command', { Command: 'pjsip show registrations' });
    const reg = /Registered\s+\(exp\.\s+(\d+)s\)/.exec(out);
    res.json({
      registered: !!reg,
      expires_in_seconds: reg ? parseInt(reg[1], 10) : null,
      raw: out.slice(0, 2000),
    });
  } catch (err) {
    res.status(503).json({ error: 'PBX nicht erreichbar (AMI): ' + err.message });
  }
});

app.post('/api/pbx/test-call', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const normalized = normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'phone erforderlich (intl Format)' });
  try {
    const out = await amiCommand('Originate', {
      Channel: `PJSIP/${normalized}@peoplefone`,
      Context: 'internal',
      Exten: '1000',
      Priority: '1',
      CallerID: 'Rosenweg <90765821559>',
      Async: 'true',
      Timeout: '30000',
    });
    res.json({ ok: true, dialed: normalized, raw: out.slice(0, 500) });
  } catch (err) {
    res.status(503).json({ error: 'AMI-Fehler: ' + err.message });
  }
});

// ─── WhatsApp-Bot Integration ────────────────────────────────────────
// Schnittstellen-Design: agnostisch zur Provider-Wahl (whatsapp-web.js,
// Cloud API, etc.). Bot-Service ruft /api/whatsapp/inbound auf, holt
// ausgehende Mails via /api/whatsapp/outbox-poll oder erhaelt sie per
// /api/whatsapp/send (intern).
//
// Authentifizierung Webhook: Shared-Secret im Header X-WA-Secret.
// User-Identifikation: Telefonnummer → personen via findPersonByPhone().

const WHATSAPP_SHARED_SECRET = process.env.WHATSAPP_SHARED_SECRET || '';

function requireWhatsappSecret(req, res, next) {
  const provided = req.headers['x-wa-secret'] || req.query.secret;
  if (!WHATSAPP_SHARED_SECRET) return res.status(503).json({ error: 'WHATSAPP_SHARED_SECRET nicht konfiguriert' });
  if (provided !== WHATSAPP_SHARED_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Sucht eine Person via Telefonnummer (gegen normalisierte telefon/mobile/telefone-JSONB).
// Liefert null wenn nicht gefunden. Match auch wenn Bot-Nummer mit/ohne '+', mit/ohne Leerzeichen.
async function findPersonByPhone(phoneInput) {
  if (!phoneInput) return null;
  const norm = normalizePhone(phoneInput);
  if (!norm) return null;
  const normNoSpace = norm.replace(/\s/g, '');
  // 1) Exakt match auf telefon, mobile oder JSONB telefone[].nummer
  const r = await pool.query(
    `SELECT * FROM personen
      WHERE REPLACE(COALESCE(telefon,''), ' ', '') = $1
         OR REPLACE(COALESCE(mobile,''),  ' ', '') = $1
         OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(telefone, '[]'::jsonb)) t
               WHERE REPLACE(COALESCE(t->>'nummer',''), ' ', '') = $1
            )
      LIMIT 1`,
    [normNoSpace],
  );
  return r.rows[0] || null;
}

// Universelle Notification: wenn die Person Opt-In hat und eine Nummer
// hinterlegt ist, wird zusaetzlich zur (bereits versandten) Email eine
// WhatsApp-Nachricht in die Outbox gestellt. Lookup via Email ODER Person-ID.
// Nimmt nur kompakten body (kein subject — wird vom Aufrufer integriert).
async function pushWhatsappIfOptIn({ email, personId, body, sourceType, sourceId }) {
  try {
    let person = null;
    if (personId) {
      const r = await pool.query('SELECT * FROM personen WHERE id = $1', [personId]);
      person = r.rows[0] || null;
    } else if (email) {
      // Matcht primary email ODER irgendeinen Alias im emails JSONB-Array.
      // Erst exakt-primary, dann Alias (deterministisch, primary gewinnt).
      const r = await pool.query(
        `SELECT * FROM personen
          WHERE LOWER(email) = LOWER($1)
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(COALESCE(emails, '[]'::jsonb)) e
                   WHERE LOWER(e) = LOWER($1)
                )
          ORDER BY (LOWER(email) = LOWER($1)) DESC
          LIMIT 1`,
        [email],
      );
      person = r.rows[0] || null;
    }
    if (!person || !person.whatsapp_opt_in) return false;
    // Sammle alle Empfaengernummern:
    //   - primary (mobile bevorzugt, sonst telefon)
    //   - jede telefone[]-Entry mit explizitem whatsapp:true Flag
    // Dedupliziert ueber Ziffer-Normalisierung (verhindert Doppel-Sends
    // wenn jemand dieselbe Nummer doppelt eintraegt).
    const targets = [];
    const seen = new Set();
    const addPhone = (raw) => {
      if (!raw) return;
      const key = String(raw).replace(/\D/g, '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      targets.push(raw);
    };
    addPhone(person.mobile || person.telefon);
    if (Array.isArray(person.telefone)) {
      for (const t of person.telefone) if (t?.whatsapp) addPhone(t.nummer);
    }
    if (targets.length === 0) return false;
    let success = false;
    for (const phone of targets) {
      try {
        await queueWhatsappMessage({
          phone, body, sourceType: sourceType || 'notification', sourceId, personId: person.id,
        });
        success = true;
      } catch (err) { console.warn('[pushWhatsapp] queue Fehler:', err.message); }
    }
    return success;
  } catch (err) {
    console.warn('[pushWhatsapp] Fehler:', err.message);
    return false;
  }
}

// Variante: an mehrere Empfaenger (Emails-Array)
async function pushWhatsappBroadcast({ emails, body, sourceType, sourceId }) {
  if (!Array.isArray(emails) || emails.length === 0) return 0;
  let n = 0;
  for (const e of emails) {
    if (await pushWhatsappIfOptIn({ email: e, body, sourceType, sourceId })) n++;
  }
  return n;
}

// Queue eine ausgehende Nachricht. Bot-Service holt sie und versendet.
async function queueWhatsappMessage({ phone, body, attachments, sourceType, sourceId, personId, chatId }) {
  // chatId hat Vorrang: bei LID-Privacy-Chats ist die echte Nummer
  // nicht aufloesbar, dann muessen wir die @lid-JID direkt zurueck-routen.
  const norm = chatId || normalizePhone(phone);
  if (!norm) throw new Error('Ungueltige Telefonnummer');
  const r = await pool.query(
    `INSERT INTO whatsapp_messages
       (direction, phone, chat_id, body, attachments, person_id, source_type, source_id, status)
     VALUES ('outbound', $1, $2, $3, $4::jsonb, $5, $6, $7, 'queued')
     RETURNING id`,
    [norm, chatId || null, body || '', JSON.stringify(attachments || []), personId || null, sourceType || null, sourceId || null],
  );
  return r.rows[0].id;
}

// Command-Handler: parst Body und antwortet entsprechend.
function buildWhatsappMenu(person) {
  const first = (person?.name || '').split(' ')[0] || '';
  const greet = first ? `Hallo ${first}! 👋` : 'Hallo! 👋';
  return `🌹 *Rosenweg-Bot — Hauptmenue*

${greet}

Antworte mit der *Zahl* oder dem *Befehl*:

1️⃣  Notfall-Kontakte (Polizei, Feuerwehr, Verwaltung)
2️⃣  Handwerker-Liste (alle Kategorien)
3️⃣  Meine Auslagen anzeigen
4️⃣  Schaden / Reklamation melden
5️⃣  Webseite oeffnen
6️⃣  Alle Befehle (Hilfe)

Tipp: Du kannst auch einfach in eigenen Worten beschreiben, was du brauchst — oder einen Beleg als Foto senden. Schreib *menu* fuer dieses Menue jederzeit erneut.`;
}

async function handleWhatsappCommand(person, body) {
  const text = String(body || '').trim();
  const lower = text.toLowerCase();
  // Menue-Trigger: Begruessung oder explizit "menu/start"
  const MENU_TRIGGERS = ['start', '/start', 'menu', '/menu', 'menü', '/menü',
    'hi', 'hallo', 'hey', 'hoi', 'salü', 'salu', 'guten tag', 'gruezi', 'grüezi', 'moin'];
  if (MENU_TRIGGERS.includes(lower)) {
    return buildWhatsappMenu(person);
  }
  // Numerische Menue-Auswahl: "1", "1.", "1)", "1 "
  const numMatch = lower.match(/^([1-6])[\s.)]*$/);
  if (numMatch) {
    const choice = numMatch[1];
    if (choice === '1') return handleWhatsappCommand(person, '/notfall');
    if (choice === '2') return handleWhatsappCommand(person, '/handwerker');
    if (choice === '3') return handleWhatsappCommand(person, '/meineauslagen');
    if (choice === '4') {
      return `📝 *Schaden / Reklamation melden*

Schreibe in einer Nachricht was passiert ist — am besten mit *Ort* und *was los ist*. Z.B.:

\`/reklamation Aufzug im Haus 9 steht still seit heute morgen\`

Oder schick ein Foto vom Schaden mit kurzer Beschreibung als Bildunterschrift.

Der Ausschuss bekommt sofort eine Mail und WhatsApp-Push.

🔙 Zurueck zum Menue: *menu*`;
    }
    if (choice === '5') {
      return `🌐 *Webseite Rosenweg*

${SITE_URL}

• Auslagen einreichen: ${SITE_URL}/auslagen.html
• Reservationen: ${SITE_URL}/reservationen.html
• Hilfe & FAQ: ${SITE_URL}/hilfe.html
• Verwaltung: ${SITE_URL}/verwaltung.html

🔙 Zurueck zum Menue: *menu*`;
    }
    if (choice === '6') return handleWhatsappCommand(person, '/hilfe');
  }
  // Hilfe
  if (lower === '/hilfe' || lower === '/help' || lower === '?') {
    return `🤖 *Rosenweg-Bot — Befehle*

/menu — Hauptmenue (numerische Auswahl)
/meineauslagen — Deine eingereichten Auslagen
/notfall — Notfall-Kontakte
/handwerker — Handwerker-Liste (alle Kategorien)
/handwerker <kategorie> — z.B. /handwerker sanitaer
/reklamation <text> — Schaden melden
/hilfe — diese Liste

Du kannst auch einfach beschreiben was du brauchst, oder einen Beleg als Foto schicken.`;
  }
  if (lower === '/meineauslagen' || lower === '/auslagen') {
    if (!person) return '⚠ Du bist nicht in der Personen-Datenbank — bitte beim Ausschuss melden, damit deine Nummer hinterlegt wird.';
    const r = await pool.query(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(betrag_chf), 0) AS summe
         FROM auslagen WHERE LOWER(user_email) = LOWER($1) GROUP BY status`,
      [person.email || ''],
    );
    if (r.rows.length === 0) return '📋 Du hast aktuell keine Auslagen erfasst.\n\nNeue Auslage einreichen: ' + SITE_URL + '/auslagen.html';
    const lines = r.rows.map(row => `• ${row.status}: ${row.n}× = CHF ${Number(row.summe).toFixed(2)}`);
    return `📋 *Deine Auslagen:*\n${lines.join('\n')}\n\n${SITE_URL}/auslagen.html`;
  }
  if (lower === '/notfall') {
    const cfg = await fs.readFile(pathModule.join(__dirname, 'site-config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    const n = cfg.notfall || {};
    return `🚨 *Notfall-Kontakte:*

🚓 Polizei: ${n.polizei || '117'}
🚒 Feuerwehr: ${n.feuerwehr || '118'}
🚑 Sanität: ${n.sanitaet || '144'}
🆘 Vergiftung: ${n.vergiftung || '145'}

Hausverwaltung / Technik:
${SITE_URL}/verwaltung.html`;
  }
  if (lower === '/handwerker' || lower.startsWith('/handwerker ')) {
    const kategorieArg = text.replace(/^\/handwerker\s*/i, '').trim();
    if (kategorieArg) {
      const r = await pool.query(
        `SELECT firma, telefon, mobile, ansprechpartner, kategorie, bewertung FROM handwerker
          WHERE archiviert = false AND LOWER(kategorie) LIKE LOWER($1)
          ORDER BY bewertung DESC NULLS LAST, firma LIMIT 20`,
        ['%' + kategorieArg + '%'],
      ).catch(() => ({ rows: [] }));
      if (r.rows.length === 0) {
        return `🔧 Keine Handwerker zur Kategorie "${kategorieArg}" gefunden.\n\nAlle Kategorien: \`/handwerker\`\nVolle Liste: ${SITE_URL}/handwerker.html`;
      }
      const lines = r.rows.map(h => {
        const stars = h.bewertung ? ' ' + '⭐'.repeat(h.bewertung) : '';
        const ap = h.ansprechpartner ? ` (${h.ansprechpartner})` : '';
        return `• *${h.firma}*${stars}\n  📞 ${h.mobile || h.telefon || '—'}${ap}`;
      });
      return `🔧 *Handwerker — ${kategorieArg}* (${r.rows.length})\n\n${lines.join('\n\n')}\n\nVolle Liste mit Details: ${SITE_URL}/handwerker.html\n🔙 Menue: *menu*`;
    }
    // Komplette Uebersicht, gruppiert
    const r = await pool.query(
      `SELECT firma, telefon, mobile, kategorie, bewertung FROM handwerker
        WHERE archiviert = false
        ORDER BY kategorie, bewertung DESC NULLS LAST, firma`,
    ).catch(() => ({ rows: [] }));
    if (r.rows.length === 0) {
      return '🔧 Keine Handwerker hinterlegt.\n\n' + SITE_URL + '/handwerker.html';
    }
    const grouped = {};
    for (const h of r.rows) {
      const k = h.kategorie || 'Sonstige';
      (grouped[k] = grouped[k] || []).push(h);
    }
    const parts = [];
    for (const [kat, list] of Object.entries(grouped)) {
      const top = list.slice(0, 2).map(h =>
        `  • ${h.firma} — 📞 ${h.mobile || h.telefon || '—'}`
      ).join('\n');
      const more = list.length > 2 ? `\n  _+${list.length - 2} weitere_` : '';
      parts.push(`*${kat}* (${list.length})\n${top}${more}`);
    }
    return `🔧 *Handwerker-Uebersicht* (${r.rows.length} Eintraege)\n\n${parts.join('\n\n')}\n\nFilter nach Kategorie: \`/handwerker sanitaer\`\nVolle Liste mit Bewertungen: ${SITE_URL}/handwerker.html\n🔙 Menue: *menu*`;
  }
  if (lower.startsWith('/reklamation') || lower.startsWith('/schaden')) {
    const beschreibung = text.replace(/^\/(reklamation|schaden)\s*/i, '').trim();
    if (!beschreibung) return '📝 Bitte gib eine Beschreibung an, z.B.: `/reklamation Aufzug im Haus 9 steht still`';
    if (!person) return '⚠ Du bist nicht in der Personen-Datenbank — bitte beim Ausschuss melden, damit dein Anliegen zugeordnet werden kann.';
    // STWEG aus erster verknuepfter Wohnung der Person
    const wRes = await pool.query(
      `SELECT w.stweg FROM wohnungen_kontakte k JOIN wohnungen w ON w.id = k.wohnung_id
        WHERE k.person_id = $1 AND k.archiviert_am IS NULL LIMIT 1`,
      [person.id],
    );
    const stweg = wRes.rows[0]?.stweg || null;
    const ins = await pool.query(
      `INSERT INTO reklamationen (person_id, stweg, beschreibung, eingang_kanal)
       VALUES ($1, $2, $3, 'whatsapp') RETURNING id`,
      [person.id, stweg, beschreibung.slice(0, 2000)],
    );
    // Ausschuss per Mail-Outbox informieren (Direktversand intern)
    try {
      const stwegLabel = stweg ? `STWEG ${stweg}` : 'STWEG-uebergreifend';
      const adminEmails = stweg && STWEG_GROUPS[stweg]?.ausschuss
        ? (await pool.query(
            `SELECT DISTINCT email FROM users u
              WHERE active = true AND email IS NOT NULL AND email <> ''
                AND u.groups_json::jsonb ? $1`,
            [STWEG_GROUPS[stweg].ausschuss],
          )).rows.map(r => r.email).filter(Boolean)
        : [];
      if (adminEmails.length > 0) {
        await loggedSendMail({
          from: MAIL_FROM, to: adminEmails.join(', '),
          subject: `📝 Reklamation #${ins.rows[0].id} (${stwegLabel}): ${beschreibung.slice(0, 60)}`,
          text: `Neue Reklamation via WhatsApp:\n\nVon: ${person.name} (${person.email || '-'})\nSTWEG: ${stwegLabel}\nBeschreibung:\n${beschreibung}\n\nVerwalten: ${SITE_URL}/reklamationen.html`,
        }, 'reklamation-whatsapp');
        pushWhatsappBroadcast({
          emails: adminEmails, sourceType: 'reklamation-neu', sourceId: ins.rows[0].id,
          body: `📝 *Neue Reklamation #${ins.rows[0].id}*\n${person.name} · ${stwegLabel}\n${beschreibung.slice(0, 100)}\n\n${SITE_URL}/reklamationen.html`,
        }).catch(() => {});
      }
    } catch (e) { console.warn('[whatsapp] Reklamation Mail Fehler:', e.message); }
    return `✓ Reklamation #${ins.rows[0].id} aufgenommen und an den Ausschuss weitergeleitet. Du wirst über den Status informiert.`;
  }
  return null; // Kein Befehl — leer = keine Antwort, oder Default-Help
}

// Webhook fuer eingehende Nachrichten (vom Bot-Service aufgerufen)
app.post('/api/whatsapp/inbound', requireWhatsappSecret, async (req, res) => {
  try {
    const { phone, chat_id, body, whatsapp_msg_id, attachments } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone fehlt' });
    const person = await findPersonByPhone(phone);
    // Speichern
    const ins = await pool.query(
      `INSERT INTO whatsapp_messages (direction, phone, chat_id, whatsapp_msg_id, body, attachments, person_id, status)
       VALUES ('inbound', $1, $2, $3, $4, $5::jsonb, $6, 'received') RETURNING id`,
      [normalizePhone(phone) || phone, chat_id || null, whatsapp_msg_id || null, body || '', JSON.stringify(attachments || []), person?.id || null],
    );
    // Letzte-Aktivitaet auf Person
    if (person) {
      await pool.query('UPDATE personen SET whatsapp_letzte_aktivitaet = NOW() WHERE id = $1', [person.id]);
    }
    // Command-Handler
    let reply = await handleWhatsappCommand(person, body);
    if (!reply && body && String(body).startsWith('/')) {
      reply = 'Unbekannter Befehl. Schreibe `/menu` fuer das Hauptmenue oder `/hilfe` fuer die Befehls-Liste.';
    }
    if (reply) {
      const repliedId = await queueWhatsappMessage({
        phone, chatId: chat_id, body: reply, sourceType: 'command-response', sourceId: ins.rows[0].id, personId: person?.id,
      });
      return res.json({ ok: true, message_id: ins.rows[0].id, reply_queued: repliedId });
    }
    res.json({ ok: true, message_id: ins.rows[0].id });
  } catch (err) {
    console.error('WhatsApp inbound error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Outbox-Poll: Bot-Service holt anstehende Nachrichten
app.get('/api/whatsapp/outbox-poll', requireWhatsappSecret, async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const r = await pool.query(
      `UPDATE whatsapp_messages SET status = 'sent', sent_at = NOW()
        WHERE id IN (
          SELECT id FROM whatsapp_messages
           WHERE direction = 'outbound' AND status = 'queued'
           ORDER BY created_at LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, phone, chat_id, body, attachments`,
      [limit],
    );
    res.json({ messages: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send-Status-Update vom Bot (falls Versand fehlschlaegt)
app.post('/api/whatsapp/status', requireWhatsappSecret, async (req, res) => {
  try {
    const { message_id, status, error_message, whatsapp_msg_id } = req.body || {};
    await pool.query(
      `UPDATE whatsapp_messages SET status = COALESCE($1, status),
                                    error_message = COALESCE($2, error_message),
                                    whatsapp_msg_id = COALESCE($3, whatsapp_msg_id)
        WHERE id = $4`,
      [status, error_message, whatsapp_msg_id, message_id],
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bot-Heartbeat: in-memory, alarmiert Admins wenn stale (>5min).
let waBotHeartbeat = null; // { is_ready, ready_at, phone, pid, uptime_seconds, received_at }
let waBotStaleAlertSent = false; // verhindert Alert-Spam
app.post('/api/whatsapp/heartbeat', requireWhatsappSecret, (req, res) => {
  waBotHeartbeat = {
    ...req.body,
    received_at: new Date(),
  };
  waBotStaleAlertSent = false; // Bot lebt → Alert-Sperre aufheben
  res.json({ ok: true });
});

// Stale-Detector: wenn der letzte Heartbeat > 5min her ist, einmal Alarm
// an Technik/Praesident senden (direkt-Email + WA falls Opt-In).
async function checkBotHeartbeat() {
  const STALE_MS = 5 * 60 * 1000;
  const lastHb = waBotHeartbeat?.received_at;
  if (!lastHb) return; // noch nie ein Heartbeat → Bot startet vielleicht gerade
  const age = Date.now() - new Date(lastHb).getTime();
  if (age < STALE_MS || waBotStaleAlertSent) return;
  waBotStaleAlertSent = true;
  const ageMin = Math.round(age / 60000);
  console.warn(`[WA-Watchdog] Bot stale seit ${ageMin}min — Alarm.`);
  try {
    // Technik + Praesident-Emails sammeln
    const r = await pool.query(
      `SELECT DISTINCT email FROM users
        WHERE active = true AND email IS NOT NULL
          AND (groups_json::jsonb ? 'technik' OR groups_json::jsonb ? 'Präsident')`,
    );
    const adminEmails = r.rows.map(x => x.email).filter(Boolean);
    if (adminEmails.length === 0) return;
    const lastReady = waBotHeartbeat?.is_ready ? 'ready' : 'nicht ready';
    const phone = waBotHeartbeat?.phone || '(unbekannt)';
    await loggedSendMail({
      from: MAIL_FROM,
      to: adminEmails.join(', '),
      subject: '⚠ WhatsApp-Bot reagiert nicht',
      text: `Der WhatsApp-Bot hat seit ${ageMin} Minuten keinen Heartbeat gesendet.\n\n`
        + `Letzte Meldung: ${new Date(lastHb).toLocaleString('de-CH')}\n`
        + `Letzter Status: ${lastReady}\n`
        + `Telefon: ${phone}\n\n`
        + `Pruefen: docker service ps rosenweg_whatsapp-bot\n`
        + `Logs:    docker service logs rosenweg_whatsapp-bot --tail 50\n`
        + `Admin-UI: ${SITE_URL}/whatsapp-bot-admin.html`,
    }, 'whatsapp-bot-stale').catch(() => {});
    pushWhatsappBroadcast({
      emails: adminEmails,
      sourceType: 'bot-watchdog',
      body: `⚠ *WhatsApp-Bot stale*\nKein Heartbeat seit ${ageMin}min.\nDocker-Logs pruefen.`,
    }).catch(() => {});
  } catch (err) {
    console.warn('[WA-Watchdog] Alarm konnte nicht gesendet werden:', err.message);
  }
}
setInterval(checkBotHeartbeat, 60_000); // jede Minute pruefen

// QR-Code-Bridge: Bot pusht den aktuellen QR; Admin holt ihn als PNG.
// In-Memory (volatile, kein DB-Stoerfaktor; QR rotiert eh alle 60s).
let waCurrentQrPng = null;
let waCurrentQrAt  = null;
app.post('/api/whatsapp/qr', requireWhatsappSecret, (req, res) => {
  const b64 = req.body?.png_base64;
  if (!b64) return res.status(400).json({ error: 'png_base64 fehlt' });
  waCurrentQrPng = Buffer.from(b64, 'base64');
  waCurrentQrAt  = new Date();
  res.json({ ok: true, bytes: waCurrentQrPng.length });
});
app.delete('/api/whatsapp/qr', requireWhatsappSecret, (_req, res) => {
  waCurrentQrPng = null;
  waCurrentQrAt  = null;
  res.json({ ok: true });
});
app.get('/api/whatsapp/qr.png', authMiddleware, requireTechnikOrPraesident, (_req, res) => {
  if (!waCurrentQrPng) return res.status(404).json({ error: 'Kein QR aktiv. Bot ist entweder gepairt oder nicht bereit.' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(waCurrentQrPng);
});
app.get('/api/whatsapp/qr-status', authMiddleware, requireTechnikOrPraesident, (_req, res) => {
  res.json({
    available: !!waCurrentQrPng,
    received_at: waCurrentQrAt,
    age_seconds: waCurrentQrAt ? Math.round((Date.now() - waCurrentQrAt.getTime()) / 1000) : null,
  });
});

// Admin-API: Broadcast-Recipients-Preview
// Query: target=all | stweg:<N> | group:<authentik-group>
app.get('/api/whatsapp/admin/recipients', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const target = String(req.query.target || 'all');
  try {
    const list = await resolveBroadcastRecipients(target);
    res.json({
      target,
      count: list.length,
      recipients: list.slice(0, 50).map(p => ({ id: p.id, name: p.name, phone: p.phone })),
      truncated: list.length > 50,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-API: Broadcast senden
// Body: { target, body }
app.post('/api/whatsapp/admin/broadcast', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  const target = String(req.body?.target || '');
  const body   = String(req.body?.body   || '').slice(0, 2000);
  if (!target || !body) return res.status(400).json({ error: 'target und body erforderlich' });
  try {
    const list = await resolveBroadcastRecipients(target);
    let queued = 0;
    for (const p of list) {
      try {
        await queueWhatsappMessage({
          phone: p.phone, body, personId: p.id,
          sourceType: 'admin-broadcast', sourceId: null,
        });
        queued++;
      } catch (err) { console.warn('[broadcast] queue Fehler:', err.message); }
    }
    res.json({ ok: true, queued, total: list.length, target });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Hilfs-Funktion: aufloesen welche Personen welcher Zielgruppe entsprechen.
// Liefert [{id, name, phone}] mit allen WA-faehigen Nummern pro Person.
async function resolveBroadcastRecipients(target) {
  let personSqlFilter = 'p.whatsapp_opt_in = true';
  const params = [];
  if (target.startsWith('stweg:')) {
    const stwegNr = parseInt(target.slice(6), 10);
    if (!Number.isFinite(stwegNr)) throw new Error('Ungueltiger STWEG-Filter');
    // Personen ueber wohnungen_kontakte zu STWEG zugeordnet
    params.push(stwegNr);
    personSqlFilter += ` AND EXISTS (
      SELECT 1 FROM wohnungen_kontakte wk
        JOIN wohnungen w ON w.id = wk.wohnung_id
       WHERE wk.person_id = p.id AND w.stweg = $${params.length}
    )`;
  } else if (target.startsWith('group:')) {
    const groupName = target.slice(6);
    if (!groupName) throw new Error('Ungueltiger Gruppen-Filter');
    // Personen sind via Email mit users-Tabelle verknuepft, dort liegt die Gruppe
    params.push(groupName);
    personSqlFilter += ` AND EXISTS (
      SELECT 1 FROM users u
       WHERE u.active = true
         AND u.groups_json::jsonb ? $${params.length}
         AND (
              LOWER(u.email) = LOWER(p.email)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.emails,'[]'::jsonb)) e
                       WHERE LOWER(e) = LOWER(u.email))
         )
    )`;
  } else if (target !== 'all') {
    throw new Error('Unbekannter Target-Typ. Erwartet: all | stweg:<N> | group:<name>');
  }
  const r = await pool.query(
    `SELECT p.id, p.name, p.mobile, p.telefon, p.telefone
       FROM personen p
      WHERE ${personSqlFilter}
      ORDER BY p.name`,
    params,
  );
  // Flatten: pro Person eine Liste von Empfaengernummern (primary + alle whatsapp:true im Array)
  const result = [];
  const seen = new Set();
  for (const p of r.rows) {
    const phones = [];
    const primary = p.mobile || p.telefon;
    if (primary) phones.push(primary);
    if (Array.isArray(p.telefone)) for (const t of p.telefone) if (t?.whatsapp && t?.nummer) phones.push(t.nummer);
    for (const ph of phones) {
      const key = String(ph).replace(/\D/g, '');
      if (!key) continue;
      const dedupKey = `${p.id}:${key}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      result.push({ id: p.id, name: p.name, phone: ph });
    }
  }
  return result;
}

// Admin-API: Liste der WhatsApp-Gruppen in denen der Bot Mitglied ist.
// Proxy zum Bot-HTTP-Endpoint /groups (Bot laeuft auf 100.64.2.29 in CT 220 ... NEIN,
// Bot laeuft im Docker-Swarm). Wir koennen den Bot via Docker-Service-Namen erreichen.
app.get('/api/whatsapp/admin/groups', authMiddleware, requireTechnikOrPraesident, async (_req, res) => {
  try {
    const r = await fetch('http://rosenweg_whatsapp-bot:8080/groups', {
      headers: { 'X-WA-Secret': WHATSAPP_SHARED_SECRET },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Bot nicht erreichbar: ' + err.message });
  }
});

// Admin-API fuer UI: Status + letzte Nachrichten + Outbox
app.get('/api/whatsapp/admin/status', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const [pending, recent, byPerson, optIn] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM whatsapp_messages WHERE direction = 'outbound' AND status = 'queued'`),
      pool.query(`SELECT id, direction, phone, body, status, person_id, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 30`),
      pool.query(`SELECT COUNT(DISTINCT person_id)::int AS n FROM whatsapp_messages WHERE person_id IS NOT NULL`),
      pool.query(`SELECT COUNT(*)::int AS n FROM personen WHERE whatsapp_opt_in = true`),
    ]);
    const hbAgeSec = waBotHeartbeat?.received_at
      ? Math.round((Date.now() - new Date(waBotHeartbeat.received_at).getTime()) / 1000)
      : null;
    res.json({
      bot_secret_configured: !!WHATSAPP_SHARED_SECRET,
      outbox_pending: pending.rows[0].n,
      total_persons_active: byPerson.rows[0].n,
      opt_in_count: optIn.rows[0].n,
      recent_messages: recent.rows,
      bot_heartbeat: waBotHeartbeat,
      bot_heartbeat_age_seconds: hbAgeSec,
      bot_alive: hbAgeSec !== null && hbAgeSec < 90, // grosszuegig: 3x Intervall
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manuelle Test-Nachricht senden (Admin)
app.post('/api/whatsapp/admin/send', authMiddleware, requireTechnikOrPraesident, async (req, res) => {
  try {
    const { phone, body } = req.body || {};
    if (!phone || !body) return res.status(400).json({ error: 'phone + body erforderlich' });
    const id = await queueWhatsappMessage({ phone, body, sourceType: 'admin-test' });
    res.json({ ok: true, message_id: id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Reklamationen-API ───────────────────────────────────────────────
app.get('/api/reklamationen', authMiddleware, requirePermission('reklamationen', 'read'), async (req, res) => {
  try {
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const ausschussStwegs = [...getAusschussStwegs(groups)];
    const params = [];
    let where = isAdmin ? 'TRUE' : (ausschussStwegs.length > 0 ? `r.stweg = ANY($${params.push(ausschussStwegs)}::int[]) OR r.stweg IS NULL` : `r.person_id = (SELECT id FROM personen WHERE LOWER(email) = LOWER($${params.push(req.user.email)}) LIMIT 1)`);
    const status = String(req.query.status || '').trim();
    if (status && ['offen','weitergeleitet','erledigt','abgewiesen'].includes(status)) {
      params.push(status); where += ` AND r.status = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT r.*, p.name AS person_name, p.email AS person_email, h.firma AS handwerker_firma
         FROM reklamationen r
         LEFT JOIN personen p ON p.id = r.person_id
         LEFT JOIN handwerker h ON h.id = r.handwerker_id
        WHERE ${where} ORDER BY r.created_at DESC LIMIT 500`,
      params,
    );
    res.json({ reklamationen: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/reklamationen/:id', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const updates = []; const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };
    if (b.status !== undefined) {
      if (!['offen','weitergeleitet','erledigt','abgewiesen'].includes(b.status)) return res.status(400).json({ error: 'Ungueltiger Status' });
      push('status', b.status);
      if (b.status === 'erledigt') push('erledigt_am', new Date());
    }
    if (b.kategorie !== undefined) push('kategorie', b.kategorie ? String(b.kategorie).slice(0, 60) : null);
    if (b.handwerker_id !== undefined) push('handwerker_id', b.handwerker_id || null);
    if (b.zugewiesen_an !== undefined) push('zugewiesen_an', b.zugewiesen_an || null);
    if (b.notiz !== undefined) push('notiz', b.notiz || null);
    if (updates.length === 0) return res.status(400).json({ error: 'Keine Aenderungen' });
    push('updated_at', new Date());
    params.push(id);
    const r = await pool.query(
      `UPDATE reklamationen SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const updated = r.rows[0];
    // Notification an Melder bei Status-Wechsel
    if (b.status && updated.person_id) {
      try {
        const p = await pool.query('SELECT name, email FROM personen WHERE id = $1', [updated.person_id]);
        if (p.rows[0]) {
          const labelMap = { weitergeleitet: 'an Handwerker weitergeleitet', erledigt: 'als erledigt markiert', abgewiesen: 'abgewiesen', offen: 'wieder geoeffnet' };
          const label = labelMap[b.status] || b.status;
          if (p.rows[0].email) {
            await loggedSendMail({
              from: MAIL_FROM, to: p.rows[0].email,
              subject: `Deine Reklamation #${updated.id} wurde ${label}`,
              text: `Hallo ${p.rows[0].name},\n\ndeine Reklamation "${(updated.beschreibung || '').slice(0, 100)}" wurde ${label}.\n`
                + (b.notiz ? `\nBemerkung: ${b.notiz}\n` : '')
                + `\nDetails: ${SITE_URL}/reklamationen.html`,
            }, 'reklamation-status');
          }
          const emoji = b.status === 'erledigt' ? '✅' : b.status === 'abgewiesen' ? '❌' : b.status === 'weitergeleitet' ? '➡️' : '🔄';
          pushWhatsappIfOptIn({
            personId: updated.person_id, sourceType: 'reklamation-status', sourceId: updated.id,
            body: `${emoji} *Reklamation #${updated.id} ${label}*\n${(updated.beschreibung || '').slice(0, 80)}`
              + (b.notiz ? `\n\n_Bemerkung:_ ${b.notiz}` : ''),
          }).catch(() => {});
        }
      } catch (e) { console.warn('[reklamation] Status-Mail:', e.message); }
    }
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Vollmachten ────────────────────────────────────────────────────
// Eigentuemer erteilt Vollmacht an Verwalter/Mieter/andere Person.
// Berechtigung 'vollmachten-eigene' (jeder Eigentuemer) zum Erfassen
// eigener Vollmachten; 'vollmachten-admin' (technik/praesident/verwaltung)
// um alle zu sehen/widerrufen. Auto-Status-Update: Vollmachten mit
// gueltig_bis < heute werden bei jedem List-Call als 'abgelaufen' markiert.

function vmEscapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Lesefreundliches Doc-Token: 8 Zeichen, kryptografisch sicher gezogen,
// nur Buchstaben/Ziffern ohne verwechselbare 0/O/1/I/L. 31^8 = ~852G
// Kombinationen — Kollision praktisch ausgeschlossen, UNIQUE-Constraint
// faengt theoretischen Restfall auf (siehe Retry-Loop bei INSERT).
function vmGenerateDocHash() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

async function vmInsertWithRetry(client, sqlBuilder, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const hash = vmGenerateDocHash();
      const r = await (client || pool).query(sqlBuilder(hash), [hash, ...params]);
      return r;
    } catch (e) {
      if (e.code === '23505' && e.constraint && e.constraint.includes('doc_hash')) continue;
      throw e;
    }
  }
  throw new Error('Konnte keinen eindeutigen Doc-Hash erzeugen (5 Versuche)');
}

function buildVollmachtHtml(v) {
  const artLabel = { generell: 'Generelle Vertretungs-Vollmacht', spezifisch: 'Spezifische Vollmacht (Einzelgeschäft)', auskunft: 'Datenschutz- / Auskunfts-Vollmacht' }[v.art] || v.art;
  const typLabel = { eigentuemer: 'Miteigentümer/in', verwaltung: 'Verwaltung', mieter: 'Mieter/in der Liegenschaft', extern: 'Externe Person' }[v.bevollmaechtigter_typ] || v.bevollmaechtigter_typ;
  const fmtDate = d => d ? new Date(d).toLocaleDateString('de-CH', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  const fmtTime = d => d ? new Date(d).toLocaleTimeString('de-CH') : '';
  const gueltigBis = v.gueltig_bis ? fmtDate(v.gueltig_bis) : '<em>bis Widerruf</em>';
  // Vollmachtgeber-Liste (kann mehrere bei Miteigentum sein)
  const vgList = Array.isArray(v.vollmachtgeber_liste) && v.vollmachtgeber_liste.length > 0
    ? v.vollmachtgeber_liste
    : [{ name: v.vollmachtgeber_name, email: v.vollmachtgeber_email, adresse: v.vollmachtgeber_adresse, signatur_typ: v.signatur_typ, signed_at: v.digital_signed_at, signed_ip: v.digital_signed_ip }];
  // Pro Vollmachtgeber ein Signatur-Block (digital = audit-info, sonst Unterschriftsfeld)
  const sigBlocks = vgList.map(g => {
    if (g.signatur_typ === 'digital' && g.signed_at) {
      return `<div class="sig-digital">
        <div class="sig-badge">✓ Elektronisch signiert — ${vmEscapeHtml(g.name)}</div>
        <p style="margin:6px 0 4px 0;font-size:9pt;color:#166534;">Einfache elektronische Signatur nach ZertES Art.2</p>
        <table class="kv" style="margin-top:4px;">
          <tr><td class="lbl">Signiert am</td><td>${fmtDate(g.signed_at)} · ${fmtTime(g.signed_at)}</td></tr>
          <tr><td class="lbl">Identität</td><td>${vmEscapeHtml(g.email || '')}</td></tr>
          <tr><td class="lbl">IP-Adresse</td><td>${vmEscapeHtml(g.signed_ip || '—')}</td></tr>
        </table>
      </div>`;
    }
    return `<div class="sig-paper">
      <div style="font-weight:600;color:#1f2937;margin-bottom:4px;">${vmEscapeHtml(g.name)}</div>
      ${g.email ? `<div style="font-size:9pt;color:#6b7280;margin-bottom:24px;">${vmEscapeHtml(g.email)}</div>` : '<div style="height:24px;"></div>'}
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="width:50%;vertical-align:bottom;padding-right:18px;">
            <div style="border-top:1px solid #1f2937;padding-top:5px;font-size:8.5pt;color:#6b7280;">Ort, Datum</div>
          </td>
          <td style="width:50%;vertical-align:bottom;">
            <div style="border-top:1px solid #1f2937;padding-top:5px;font-size:8.5pt;color:#6b7280;">Unterschrift</div>
          </td>
        </tr>
      </table>
    </div>`;
  }).join('');
  const sigSection = vgList.length === 1
    ? sigBlocks
    : `<div style="margin-top:8px;padding:10px 14px;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;font-size:9.5pt;color:#92400e;">
         <strong>Wichtig:</strong> Bei Miteigentum müssen <strong>alle ${vgList.length} Vollmachtgeber</strong> einzeln unterzeichnen. Erst dann wird die Vollmacht wirksam.
       </div>` + sigBlocks;
  // Vollmachtgeber-Cards (Anzeige)
  const vgCards = vgList.map((g, i) => `
    <div class="card" style="${i > 0 ? 'margin-top:6px;' : ''}">
      <table class="kv">
        <tr><td class="lbl">Name</td><td><strong>${vmEscapeHtml(g.name)}</strong>${vgList.length > 1 ? ` <span style="color:#6b7280;font-weight:400;">(Miteigentümer/in ${i + 1} von ${vgList.length})</span>` : ''}</td></tr>
        ${g.adresse ? `<tr><td class="lbl">Adresse</td><td>${vmEscapeHtml(g.adresse).replace(/\n/g,'<br>')}</td></tr>` : ''}
        ${g.email ? `<tr><td class="lbl">E-Mail</td><td>${vmEscapeHtml(g.email)}</td></tr>` : ''}
      </table>
    </div>`).join('');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Vollmacht ${v.doc_hash || v.id}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* A4 mit sicheren Druckraendern: 15mm rundum (Standard auch fuer
     Tintenstrahler ohne randlos-Druck). Header-bar ist KEIN full-bleed
     mehr, sondern als Karte innerhalb des Satzspiegels. */
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2937; font-size: 10.5pt; line-height: 1.55; }
  .header-bar {
    background: linear-gradient(90deg, #2563eb 0%, #1e40af 100%);
    color: #fff; padding: 18px 22px; display: flex; align-items: center; gap: 18px;
    margin-bottom: 18px; border-radius: 8px;
  }
  .header-bar img { width: 56px; height: 56px; background: #fff; padding: 4px; border-radius: 50%; object-fit: cover; }
  .header-bar .title { flex: 1; }
  .header-bar h1 { font-size: 18pt; margin: 0; font-weight: 700; letter-spacing: -0.3pt; }
  .header-bar .sub { font-size: 9.5pt; opacity: 0.85; margin-top: 2px; }
  .header-bar .doc-id { font-size: 9pt; opacity: 0.7; text-align: right; }
  .doc-meta { color: #6b7280; font-size: 9pt; margin-bottom: 22px; display: flex; gap: 16px; flex-wrap: wrap; }
  .doc-meta .badge { background: #dbeafe; color: #1e40af; padding: 3px 10px; border-radius: 12px; font-weight: 500; font-size: 8.5pt; }
  h2 {
    font-size: 11.5pt; font-weight: 600; color: #1e40af;
    margin: 22px 0 8px 0; padding-bottom: 4px;
    border-bottom: 2px solid #dbeafe;
    display: flex; align-items: center; gap: 6px;
    page-break-after: avoid; break-after: avoid;
  }
  h2 .icon { font-size: 13pt; }
  .card {
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px;
    background: #f9fafb; margin: 8px 0;
    page-break-inside: avoid; break-inside: avoid;
  }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 3px 0; vertical-align: top; font-size: 10pt; }
  table.kv td.lbl { color: #6b7280; width: 30%; font-size: 9pt; font-weight: 500; }
  .geltung { white-space: pre-wrap; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; margin-top: 6px; font-size: 10pt; line-height: 1.6; }
  .declaration {
    margin: 24px 0; padding: 16px 18px;
    border-left: 4px solid #1e40af; background: #eff6ff;
    font-size: 10pt; line-height: 1.7;
    page-break-inside: avoid; break-inside: avoid;
  }
  .sig-digital {
    margin-top: 14px; padding: 14px 16px;
    border: 2px solid #16a34a; background: #f0fdf4; border-radius: 8px;
    page-break-inside: avoid; break-inside: avoid;
  }
  .sig-badge {
    display: inline-block; background: #16a34a; color: #fff;
    padding: 4px 10px; border-radius: 12px; font-size: 9pt; font-weight: 600;
  }
  .sig-paper {
    margin-top: 14px; padding: 16px 18px;
    border: 1px dashed #f59e0b; background: #fffbeb; border-radius: 8px;
    page-break-inside: avoid; break-inside: avoid;
  }
  .footer {
    margin-top: 28px; padding-top: 10px; border-top: 1px solid #e5e7eb;
    color: #9ca3af; font-size: 8.5pt; display: flex; justify-content: space-between;
  }
  .validity {
    display: flex; align-items: stretch; gap: 12px; margin: 8px 0;
    page-break-inside: avoid; break-inside: avoid;
  }
  .validity-block {
    flex: 1; padding: 14px 18px; border: 1px solid #bfdbfe;
    border-radius: 8px; background: #eff6ff;
  }
  .validity-label {
    color: #1e40af; font-size: 8.5pt; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5pt; margin-bottom: 4px;
  }
  .validity-value {
    font-size: 13pt; font-weight: 600; color: #1f2937;
  }
  .validity-arrow {
    display: flex; align-items: center; color: #1e40af; font-size: 20pt; font-weight: 300;
  }
  .objekt-card {
    display: flex; gap: 14px; align-items: flex-start;
    padding: 14px 18px; margin: 8px 0;
    border: 2px solid #1e40af; background: #eff6ff; border-radius: 8px;
    page-break-inside: avoid; break-inside: avoid;
  }
  .objekt-card.objekt-warn { border-color: #f59e0b; background: #fffbeb; }
  .objekt-icon { font-size: 22pt; line-height: 1; flex-shrink: 0; padding-top: 2px; }
  .objekt-info { flex: 1; }
  .objekt-titel { font-size: 12pt; font-weight: 600; color: #1f2937; }
  .objekt-adresse { font-size: 10pt; color: #4b5563; margin-top: 3px; }
  .objekt-details { font-size: 9.5pt; color: #6b7280; margin-top: 4px; }
</style></head>
<body>
  <div class="header-bar">
    <img src="https://www.rosenweg4303.ch/logo-rosenweg.png" alt="">
    <div class="title">
      <h1>Vollmachtserklärung</h1>
      <div class="sub">STWEG-Kooperation Rosenweg · Rosenweg 1–18, 4303 Kaiseraugst</div>
    </div>
    <div class="doc-id">
      Dokument-Nr.<br><strong style="font-family:'JetBrains Mono','Courier New',monospace;letter-spacing:0.5pt;">${vmEscapeHtml(v.doc_hash || ('#' + v.id))}</strong>
    </div>
  </div>

  <div>
    <div class="doc-meta">
      <span class="badge">${artLabel}</span>
      <span>Erstellt: ${fmtDate(v.created_at)}</span>
      ${v.status === 'entwurf' ? '<span style="color:#92400e;font-weight:500;">⚠ Entwurf — noch nicht signiert</span>' : ''}
      ${v.status === 'aktiv' ? '<span style="color:#15803d;font-weight:500;">✓ Aktiv</span>' : ''}
      ${v.status === 'widerrufen' ? '<span style="color:#991b1b;font-weight:500;">✕ Widerrufen</span>' : ''}
    </div>

    <h2><span class="icon">👤</span>Vollmachtgeber/in${vgList.length > 1 ? ` <span style="font-weight:400;font-size:9.5pt;color:#6b7280;">(${vgList.length} Miteigentümer)</span>` : ''}</h2>
    ${vgCards}

    <h2><span class="icon">🤝</span>Bevollmächtigte/r <span style="font-weight:400;font-size:9.5pt;color:#6b7280;">(${typLabel})</span></h2>
    <div class="card">
      <table class="kv">
        <tr><td class="lbl">Name</td><td><strong>${vmEscapeHtml(v.bevollmaechtigter_name)}</strong></td></tr>
        ${v.bevollmaechtigter_adresse ? `<tr><td class="lbl">Adresse</td><td>${vmEscapeHtml(v.bevollmaechtigter_adresse).replace(/\n/g,'<br>')}</td></tr>` : ''}
        ${v.bevollmaechtigter_email ? `<tr><td class="lbl">E-Mail</td><td>${vmEscapeHtml(v.bevollmaechtigter_email)}</td></tr>` : ''}
        ${v.bevollmaechtigter_telefon ? `<tr><td class="lbl">Telefon</td><td>${vmEscapeHtml(v.bevollmaechtigter_telefon)}</td></tr>` : ''}
      </table>
    </div>

    <h2><span class="icon">🏠</span>Vertretene Objekte</h2>
    ${(() => {
        if (v.wohnung_id && v.wohnung_bezeichnung) {
          const stwegHaeuser = { 1: 'Rosenweg 17/18', 2: 'Rosenweg 13/14/16', 3: 'Rosenweg 9', 4: 'Rosenweg 10/12', 5: 'Rosenweg 5/6/8', 6: 'Rosenweg 1', 7: 'Rosenweg 2/4', 8: 'Tiefgarage' };
          const haus = stwegHaeuser[v.stweg] || '';
          const details = [];
          if (v.wohnung_stockwerk) details.push(v.wohnung_stockwerk);
          if (v.wohnung_zimmer) details.push(v.wohnung_zimmer + ' Zimmer');
          if (v.wohnung_flaeche) details.push(v.wohnung_flaeche + ' m²');
          return `<div class="objekt-card">
            <div class="objekt-icon">🏠</div>
            <div class="objekt-info">
              <div class="objekt-titel">${vmEscapeHtml(v.wohnung_typ || 'Wohnung')} — ${vmEscapeHtml(v.wohnung_bezeichnung)}</div>
              <div class="objekt-adresse">${vmEscapeHtml(haus)}${v.stweg ? ` &middot; STWEG ${v.stweg}` : ''}, 4303 Kaiseraugst</div>
              ${details.length ? `<div class="objekt-details">${vmEscapeHtml(details.join(' &middot; '))}</div>` : ''}
            </div>
          </div>`;
        }
        if (v.stweg) {
          const stwegHaeuser = { 1: 'Rosenweg 17/18', 2: 'Rosenweg 13/14/16', 3: 'Rosenweg 9', 4: 'Rosenweg 10/12', 5: 'Rosenweg 5/6/8', 6: 'Rosenweg 1', 7: 'Rosenweg 2/4', 8: 'Tiefgarage' };
          return `<div class="objekt-card">
            <div class="objekt-icon">🏘</div>
            <div class="objekt-info">
              <div class="objekt-titel">Alle Wohnungen im Stockwerkeigentum des Vollmachtgebers</div>
              <div class="objekt-adresse">STWEG ${v.stweg} &middot; ${vmEscapeHtml(stwegHaeuser[v.stweg] || '')}, 4303 Kaiseraugst</div>
            </div>
          </div>`;
        }
        return `<div class="objekt-card objekt-warn">
            <div class="objekt-icon">⚠</div>
            <div class="objekt-info">
              <div class="objekt-titel">Keine Objekt-Einschränkung</div>
              <div class="objekt-adresse">Diese Vollmacht ist nicht auf eine bestimmte Wohnung oder STWEG beschränkt — sie gilt allgemein im durch den Geltungsbereich beschriebenen Umfang.</div>
            </div>
          </div>`;
      })()}

    <h2><span class="icon">📋</span>Umfang der Vollmacht</h2>
    <div class="card">
      <table class="kv">
        <tr><td class="lbl">Art</td><td>${artLabel}</td></tr>
      </table>
      ${v.geltungsbereich
        ? `<div style="margin-top:10px;"><div style="color:#6b7280;font-size:9pt;font-weight:500;margin-bottom:4px;">Geltungsbereich / konkrete Befugnisse</div><div class="geltung">${vmEscapeHtml(v.geltungsbereich)}</div></div>`
        : '<p style="color:#9ca3af;font-style:italic;margin:8px 0 0;">(kein spezifischer Geltungsbereich angegeben)</p>'}
    </div>

    <h2><span class="icon">📅</span>Gültigkeit</h2>
    <div class="validity">
      <div class="validity-block">
        <div class="validity-label">Gültig ab</div>
        <div class="validity-value">${fmtDate(v.gueltig_ab)}</div>
      </div>
      <div class="validity-arrow">→</div>
      <div class="validity-block">
        <div class="validity-label">Gültig bis</div>
        <div class="validity-value">${v.gueltig_bis ? fmtDate(v.gueltig_bis) : 'bis auf Widerruf'}</div>
      </div>
    </div>

    <div class="declaration">
      ${vgList.length > 1
        ? 'Hiermit erteilen wir, die oben genannten Miteigentümer/innen, gemeinsam'
        : `Hiermit erteile ich, <strong>${vmEscapeHtml(vgList[0].name)}</strong>,`}
      der/dem oben genannten Bevollmächtigten die hier beschriebene Vollmacht im angegebenen Umfang.
      Die Vollmacht ist jederzeit schriftlich widerrufbar.
    </div>

    <h2 style="margin-top:18px;"><span class="icon">✍</span>Unterschrift${vgList.length > 1 ? 'en' : ''}</h2>
    ${sigSection}

    <div class="footer">
      <span>STWEG-Kooperation Rosenweg · www.rosenweg4303.ch</span>
      <span>Generiert ${new Date().toLocaleString('de-CH')}</span>
    </div>
  </div>
</body></html>`;
}

async function generateVollmachtPdf(v) {
  const html = buildVollmachtHtml(v);
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const r = await fetch(`${DOC_CONVERTER_URL}/forms/chromium/convert/html`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`PDF-Converter Fehler ${r.status}: ${await r.text().catch(() => '')}`);
  return Buffer.from(await r.arrayBuffer());
}

// Lookup-Helper fuer das Vollmachten-Formular (jeder eingeloggte User darf
// lesen — limitierte Felder, kein PII-Leak).
app.get('/api/vollmachten/lookup/verwaltungen', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, firma_name, stweg, email, telefon, adresse FROM verwaltungen
        WHERE aktiv = true ORDER BY stweg NULLS FIRST, firma_name`,
    );
    res.json({ verwaltungen: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vollmachten/lookup/personen', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ personen: [] });
    const r = await pool.query(
      `SELECT id, name, email, telefon, mobile, adresse FROM personen
        WHERE LOWER(name) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1)
        ORDER BY name LIMIT 10`,
      ['%' + q + '%'],
    );
    res.json({ personen: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vollmachten/lookup/my-wohnungen', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email || '';
    const r = await pool.query(
      `SELECT DISTINCT w.id, w.bezeichnung, w.stweg
         FROM wohnungen w
         JOIN wohnungen_kontakte k ON k.wohnung_id = w.id
         JOIN personen p ON p.id = k.person_id
        WHERE LOWER(p.email) = LOWER($1) AND k.archiviert_am IS NULL
        ORDER BY w.stweg, w.bezeichnung`,
      [email],
    );
    res.json({ wohnungen: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kontakte (Verwalter / Mieter / Miteigentuemer) aus den Wohnungen des aktuellen
// Users — fuer Quick-Pick im Vollmachten-Modal. So muss der Eigentuemer nicht
// die Daten nochmal eintippen die schon in der Objektverwaltung stehen.
app.get('/api/vollmachten/lookup/my-kontakte', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email || '';
    const role = String(req.query.rolle || '').trim(); // 'verwalter' | 'mieter' | 'eigentuemer' | ''
    const params = [email];
    let roleClause = '';
    if (['verwalter','mieter','eigentuemer'].includes(role)) {
      params.push(role);
      roleClause = `AND k.rolle = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT DISTINCT ON (LOWER(k.email))
              k.rolle, k.name, k.email, k.telefon, k.adresse, k.person_id,
              w.id AS wohnung_id, w.bezeichnung AS wohnung_bezeichnung, w.stweg
         FROM wohnungen_kontakte k
         JOIN wohnungen w ON w.id = k.wohnung_id
        WHERE k.archiviert_am IS NULL
          AND k.email IS NOT NULL AND k.email <> ''
          AND k.wohnung_id IN (
            SELECT DISTINCT k2.wohnung_id FROM wohnungen_kontakte k2
              JOIN personen p ON p.id = k2.person_id
             WHERE LOWER(p.email) = LOWER($1) AND k2.archiviert_am IS NULL
          )
          ${roleClause}
        ORDER BY LOWER(k.email), k.rolle`,
      params,
    );
    res.json({ kontakte: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Liste Vollmachten — Admin sieht alle, sonst nur eigene (vergeben + erhalten)
app.get('/api/vollmachten', authMiddleware, async (req, res) => {
  try {
    const groups = req.user.groups || [];
    const isGlobalAdmin = isTechnik(groups) || isPraesident(groups) || groups.some(g => g.toLowerCase() === 'verwaltung');
    const ausschussStwegs = [...getAusschussStwegs(groups)];
    const isAusschuss = ausschussStwegs.length > 0;
    // Im UI: 'Alle (Admin)' Tab fuer alle die mindestens stweg-scoped sehen
    const isAdmin = isGlobalAdmin || isAusschuss;
    const email = req.user.email || '';
    // Status-Auto-Update: abgelaufene aktiv → abgelaufen
    await pool.query(
      `UPDATE vollmachten SET status='abgelaufen', updated_at=NOW()
        WHERE status='aktiv' AND gueltig_bis IS NOT NULL AND gueltig_bis < CURRENT_DATE`,
    );
    const params = [];
    let where;
    if (isGlobalAdmin) {
      where = 'TRUE';
    } else {
      params.push(email);
      const ownClause = `LOWER(v.vollmachtgeber_email) = LOWER($1) OR LOWER(v.bevollmaechtigter_email) = LOWER($1)
               OR v.vollmachtgeber_person_id = (SELECT id FROM personen WHERE LOWER(email) = LOWER($1) LIMIT 1)
               OR v.bevollmaechtigter_person_id = (SELECT id FROM personen WHERE LOWER(email) = LOWER($1) LIMIT 1)`;
      if (isAusschuss) {
        params.push(ausschussStwegs);
        where = `(${ownClause}) OR v.stweg = ANY($${params.length}::int[])`;
      } else {
        where = ownClause;
      }
    }
    const r = await pool.query(
      `SELECT v.*, w.bezeichnung AS wohnung_bezeichnung, vw.firma_name AS verwaltung_firma,
              (SELECT COALESCE(json_agg(vg.* ORDER BY vg.sort_order, vg.id), '[]'::json)
                 FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id) AS vollmachtgeber_liste,
              (SELECT COUNT(*) FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id) AS vg_total,
              (SELECT COUNT(*) FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id AND vg.signed_at IS NOT NULL) AS vg_signed
         FROM vollmachten v
         LEFT JOIN wohnungen w ON w.id = v.wohnung_id
         LEFT JOIN verwaltungen vw ON vw.id = v.bevollmaechtigter_verwaltung_id
        WHERE ${where}
        ORDER BY (CASE v.status WHEN 'aktiv' THEN 0 WHEN 'entwurf' THEN 1 WHEN 'abgelaufen' THEN 2 ELSE 3 END), v.created_at DESC
        LIMIT 500`,
      params,
    );
    res.json({ vollmachten: r.rows, is_admin: isAdmin });
  } catch (err) { console.error('[vollmachten] list:', err); res.status(500).json({ error: err.message }); }
});

// Neue Vollmacht erfassen (status='entwurf')
app.post('/api/vollmachten', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.vollmachtgeber_name || !b.bevollmaechtigter_name || !b.bevollmaechtigter_typ || !b.art) {
      return res.status(400).json({ error: 'Pflichtfelder: vollmachtgeber_name, bevollmaechtigter_name, bevollmaechtigter_typ, art' });
    }
    if (!['eigentuemer','verwaltung','mieter','extern'].includes(b.bevollmaechtigter_typ)) {
      return res.status(400).json({ error: 'Ungueltiger bevollmaechtigter_typ' });
    }
    if (!['generell','spezifisch','auskunft'].includes(b.art)) {
      return res.status(400).json({ error: 'Ungueltige art' });
    }
    // Standard-Berechtigung: jeder eingeloggte User darf Vollmachten erfassen
    // (in der Regel fuer sich selbst als Vollmachtgeber)
    const sql = h => `INSERT INTO vollmachten (
         doc_hash,
         vollmachtgeber_person_id, vollmachtgeber_name, vollmachtgeber_email, vollmachtgeber_adresse,
         bevollmaechtigter_typ, bevollmaechtigter_person_id, bevollmaechtigter_verwaltung_id,
         bevollmaechtigter_name, bevollmaechtigter_email, bevollmaechtigter_adresse, bevollmaechtigter_telefon,
         art, geltungsbereich, wohnung_id, stweg, gueltig_ab, gueltig_bis,
         status, created_by_user_email
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'entwurf',$19)
       RETURNING *`;
    const r = await vmInsertWithRetry(null, sql, [
      b.vollmachtgeber_person_id || null, b.vollmachtgeber_name, b.vollmachtgeber_email || null, b.vollmachtgeber_adresse || null,
      b.bevollmaechtigter_typ, b.bevollmaechtigter_person_id || null, b.bevollmaechtigter_verwaltung_id || null,
      b.bevollmaechtigter_name, b.bevollmaechtigter_email || null, b.bevollmaechtigter_adresse || null, b.bevollmaechtigter_telefon || null,
      b.art, b.geltungsbereich || null, b.wohnung_id || null, b.stweg || null,
      b.gueltig_ab || new Date().toISOString().slice(0, 10), b.gueltig_bis || null,
      req.user.email || null,
    ]);
    const vollmacht = r.rows[0];
    // Vollmachtgeber-Liste: aus body.vollmachtgeber wenn vorhanden, sonst
    // implizit aus den vollmachtgeber_*-Feldern (Backward-Compat: Einzel-Eigentuemer)
    const vgList = Array.isArray(b.vollmachtgeber) && b.vollmachtgeber.length > 0
      ? b.vollmachtgeber
      : [{ person_id: b.vollmachtgeber_person_id || null, name: b.vollmachtgeber_name, email: b.vollmachtgeber_email || null, adresse: b.vollmachtgeber_adresse || null }];
    for (let i = 0; i < vgList.length; i++) {
      const g = vgList[i];
      await pool.query(
        `INSERT INTO vollmachten_vollmachtgeber (vollmacht_id, person_id, name, email, adresse, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [vollmacht.id, g.person_id || null, g.name, g.email || null, g.adresse || null, i],
      );
    }
    res.json(vollmacht);
  } catch (err) { console.error('[vollmachten] create:', err); res.status(500).json({ error: err.message }); }
});

// Vollmacht bearbeiten (nur Entwurf)
app.put('/api/vollmachten/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const existing = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = existing.rows[0];
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const isOwner = (v.vollmachtgeber_email || '').toLowerCase() === (req.user.email || '').toLowerCase()
                 || (v.created_by_user_email || '').toLowerCase() === (req.user.email || '').toLowerCase();
    if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Nur Vollmachtgeber oder Admin' });
    if (v.status !== 'entwurf') return res.status(400).json({ error: 'Nur Entwuerfe sind editierbar (Status: ' + v.status + ')' });
    const updates = []; const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };
    const allowed = ['vollmachtgeber_name','vollmachtgeber_email','vollmachtgeber_adresse',
      'bevollmaechtigter_typ','bevollmaechtigter_person_id','bevollmaechtigter_verwaltung_id',
      'bevollmaechtigter_name','bevollmaechtigter_email','bevollmaechtigter_adresse','bevollmaechtigter_telefon',
      'art','geltungsbereich','wohnung_id','stweg','gueltig_ab','gueltig_bis'];
    for (const k of allowed) {
      if (b[k] !== undefined) push(k, b[k] === '' ? null : b[k]);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Keine Aenderungen' });
    push('updated_at', new Date());
    params.push(id);
    const r = await pool.query(
      `UPDATE vollmachten SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params,
    );
    res.json(r.rows[0]);
  } catch (err) { console.error('[vollmachten] update:', err); res.status(500).json({ error: err.message }); }
});

// Digital signieren — signiert die eigene Vollmachtgeber-Zeile (per Email-Match).
// Status wird auf 'aktiv' gesetzt sobald ALLE Vollmachtgeber signiert haben.
// Bei Miteigentum (z.B. Ehepaar) muss jeder einzeln einloggen und signieren.
app.post('/api/vollmachten/:id/sign-digital', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = existing.rows[0];
    if (v.status !== 'entwurf') return res.status(400).json({ error: 'Nur Entwuerfe koennen signiert werden (Status: ' + v.status + ')' });
    const userEmail = (req.user.email || '').toLowerCase();
    // Eigene Vollmachtgeber-Zeile finden
    const my = await pool.query(
      'SELECT * FROM vollmachten_vollmachtgeber WHERE vollmacht_id = $1 AND LOWER(email) = $2',
      [id, userEmail],
    );
    if (my.rows.length === 0) {
      return res.status(403).json({ error: 'Du bist nicht als Vollmachtgeber dieser Vollmacht eingetragen' });
    }
    if (my.rows[0].signed_at) {
      return res.status(400).json({ error: 'Du hast bereits signiert' });
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || null;
    const sub = req.user.sub || req.user.id || null;
    await pool.query(
      `UPDATE vollmachten_vollmachtgeber
         SET signatur_typ='digital', signed_at=NOW(), signed_ip=$1, signed_user_agent=$2, signed_authentik_sub=$3
        WHERE id=$4`,
      [ip, ua, sub ? String(sub) : null, my.rows[0].id],
    );
    // Pruefen ob ALLE signiert haben → Status aktiv
    const counts = await pool.query(
      `SELECT COUNT(*) AS total, COUNT(signed_at) AS signed
         FROM vollmachten_vollmachtgeber WHERE vollmacht_id = $1`,
      [id],
    );
    const allSigned = counts.rows[0].total > 0 && counts.rows[0].total === counts.rows[0].signed;
    if (allSigned) {
      await pool.query(
        `UPDATE vollmachten SET status='aktiv', signatur_typ='digital',
           digital_signed_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [id],
      );
    }
    const updated = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    res.json({
      ...updated.rows[0],
      signed_by_me: true,
      all_signed: allSigned,
      signatures_remaining: Number(counts.rows[0].total) - Number(counts.rows[0].signed),
    });
  } catch (err) { console.error('[vollmachten] sign:', err); res.status(500).json({ error: err.message }); }
});

// Aktivieren mit Papier-Signatur (Status setzen; Upload des Scans separat ueber Documents)
app.post('/api/vollmachten/:id/activate-paper', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { papier_pdf_path } = req.body || {};
    const existing = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = existing.rows[0];
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups) || groups.some(g => g.toLowerCase() === 'verwaltung');
    const userEmail = (req.user.email || '').toLowerCase();
    if (!isAdmin && (v.vollmachtgeber_email || '').toLowerCase() !== userEmail) {
      return res.status(403).json({ error: 'Nur Vollmachtgeber oder Admin' });
    }
    if (v.status !== 'entwurf') return res.status(400).json({ error: 'Nur Entwuerfe koennen aktiviert werden' });
    const r = await pool.query(
      `UPDATE vollmachten SET status='aktiv', signatur_typ='papier',
         papier_pdf_path=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [papier_pdf_path || null, id],
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Signierte PDF hochladen — speichert nach /documents/Vollmachten/<doc_hash>.pdf,
// setzt papier_pdf_path und Status auf 'aktiv'. Akzeptiert nur application/pdf
// als Body (express.raw oben). Optional anschliessend KI-Check (siehe verify-ai).
app.post('/api/vollmachten/:id/upload-signed', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = r.rows[0];
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const userEmail = (req.user.email || '').toLowerCase();
    const isGeber = (v.vollmachtgeber_email || '').toLowerCase() === userEmail;
    if (!isAdmin && !isGeber) return res.status(403).json({ error: 'Nur Vollmachtgeber oder Admin' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      return res.status(400).json({ error: 'Keine PDF-Datei im Body (Content-Type: application/pdf)' });
    }
    if (!req.body.slice(0, 5).toString().startsWith('%PDF-')) {
      return res.status(400).json({ error: 'Datei ist kein PDF (Magic-Bytes fehlen)' });
    }
    // Pfad: /documents/Vollmachten/<doc_hash>-signed.pdf
    const dir = pathModule.join(DOCS_PATH, 'Vollmachten');
    await fs.mkdir(dir, { recursive: true });
    const fileName = (v.doc_hash || ('id-' + v.id)) + '-signed.pdf';
    const fullPath = pathModule.join(dir, fileName);
    await fs.writeFile(fullPath, req.body);
    const relPath = 'Vollmachten/' + fileName;
    // Status auf aktiv falls noch entwurf
    const newStatus = v.status === 'entwurf' ? 'aktiv' : v.status;
    await pool.query(
      `UPDATE vollmachten SET papier_pdf_path = $1, signatur_typ = 'papier',
         status = $2, updated_at = NOW() WHERE id = $3`,
      [relPath, newStatus, id],
    );
    // Alle Vollmachtgeber-Zeilen als papier-signiert markieren
    await pool.query(
      `UPDATE vollmachten_vollmachtgeber SET signatur_typ='papier', signed_at=NOW()
        WHERE vollmacht_id=$1 AND signed_at IS NULL`,
      [id],
    );
    res.json({ ok: true, papier_pdf_path: relPath, status: newStatus, size_bytes: req.body.length });
  } catch (err) { console.error('[vollmachten] upload:', err); res.status(500).json({ error: err.message }); }
});

// KI-Check der signierten PDF: pruefe ob der Doc-Hash gefunden wird,
// ob die Vollmachtgeber-Namen vorkommen, ob Unterschriften-Indikatoren da
// sind. Reine Text-Analyse (PDF → Text via Gotenberg).
app.post('/api/vollmachten/:id/verify-ai', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `SELECT v.*, (SELECT json_agg(vg.* ORDER BY vg.sort_order) FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id) AS vollmachtgeber_liste
         FROM vollmachten v WHERE v.id = $1`,
      [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = r.rows[0];
    if (!v.papier_pdf_path) return res.status(400).json({ error: 'Keine signierte PDF hochgeladen' });
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    // PDF laden + an Gotenberg fuer PDF→PNG-Konversion senden (Vision-Check)
    const fullPath = pathModule.join(DOCS_PATH, v.papier_pdf_path);
    const pdfBuf = await fs.readFile(fullPath);

    // Gotenberg: /forms/libreoffice/convert kann Office-Dateien zu PDF, fuer
    // PDF→PNG nutzen wir /forms/pdfengines/convert mit Format-Header. Falls
    // nicht verfuegbar: fallback auf PDF-Text-Extraktion.
    // Erstmal direkter Versuch: PDF als data-URL an Claude (unterstuetzt direkt
    // application/pdf via 'document'-content-type bei OpenRouter Claude-Modellen).
    const pdfBase64 = pdfBuf.toString('base64');
    const expectedNames = (v.vollmachtgeber_liste || []).map(g => g.name);
    const expectedHash = v.doc_hash || ('#' + v.id);

    const systemPrompt = `Du pruefst eine unterschriebene Vollmacht-PDF. Antworte in JSON.

Erwartete Daten:
- Dokument-Nr (Hash): ${expectedHash}
- Vollmachtgeber: ${expectedNames.join(', ')}

Pruefe und liefere JSON mit folgenden Feldern:
{
  "hash_gefunden": boolean,         // Dokument-Hash kommt im PDF vor
  "alle_namen_gefunden": boolean,   // alle erwarteten Vollmachtgeber-Namen finden sich
  "fehlende_namen": [string],       // Namen aus Erwartung die NICHT im PDF zu finden sind
  "unterschriften_indikatoren": number, // Anzahl Signaturfelder/Hinweise auf Unterschriften
  "auffaelligkeiten": [string],     // freie Hinweise: gestrichene Stellen, abweichender Text, etc.
  "gesamtbewertung": "ok" | "warnung" | "problem",
  "kommentar": string               // 1-2 Saetze Zusammenfassung
}`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Vollmacht-Verify',
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Pruefe diese unterschriebene Vollmacht.' },
            { type: 'file', file: { filename: 'vollmacht.pdf', file_data: 'data:application/pdf;base64,' + pdfBase64 } },
          ]},
        ],
      }),
    });
    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      return res.status(502).json({ error: 'KI-Service-Fehler ' + orRes.status, detail: errText.slice(0, 300) });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (e) {
      parsed = { raw: content, parse_error: e.message };
    }
    res.json(parsed);
  } catch (err) { console.error('[vollmachten] verify-ai:', err); res.status(500).json({ error: err.message }); }
});

// Widerrufen
app.post('/api/vollmachten/:id/revoke', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { grund } = req.body || {};
    const existing = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = existing.rows[0];
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const userEmail = (req.user.email || '').toLowerCase();
    const isGeber = (v.vollmachtgeber_email || '').toLowerCase() === userEmail;
    if (!isAdmin && !isGeber) return res.status(403).json({ error: 'Nur Vollmachtgeber oder Admin' });
    if (v.status === 'widerrufen') return res.status(400).json({ error: 'Bereits widerrufen' });
    const r = await pool.query(
      `UPDATE vollmachten SET status='widerrufen', widerrufen_am=NOW(),
         widerrufen_von_user_email=$1, widerrufen_grund=$2, updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [req.user.email || null, grund || null, id],
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PDF
app.get('/api/vollmachten/:id/pdf', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(
      `SELECT v.*,
              w.bezeichnung AS wohnung_bezeichnung,
              w.stockwerk AS wohnung_stockwerk,
              w.zimmer AS wohnung_zimmer,
              w.flaeche_m2 AS wohnung_flaeche,
              w.typ AS wohnung_typ,
              (SELECT COALESCE(json_agg(vg.* ORDER BY vg.sort_order, vg.id), '[]'::json)
                 FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id) AS vollmachtgeber_liste
         FROM vollmachten v
         LEFT JOIN wohnungen w ON w.id = v.wohnung_id
        WHERE v.id = $1`,
      [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = r.rows[0];
    const groups = req.user.groups || [];
    const isGlobalAdmin = isTechnik(groups) || isPraesident(groups) || groups.some(g => g.toLowerCase() === 'verwaltung');
    const ausschussStwegs = getAusschussStwegs(groups);
    const isAusschussForStweg = v.stweg && ausschussStwegs.has(v.stweg);
    const userEmail = (req.user.email || '').toLowerCase();
    const involved = (v.vollmachtgeber_email || '').toLowerCase() === userEmail
                  || (v.bevollmaechtigter_email || '').toLowerCase() === userEmail;
    if (!isGlobalAdmin && !isAusschussForStweg && !involved) return res.status(403).json({ error: 'Kein Zugriff' });
    const pdf = await generateVollmachtPdf(v);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="vollmacht-${id}.pdf"`);
    res.send(pdf);
  } catch (err) { console.error('[vollmachten] pdf:', err); res.status(500).json({ error: err.message }); }
});

// Loeschen (nur Entwurf)
app.delete('/api/vollmachten/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT * FROM vollmachten WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    const v = existing.rows[0];
    const groups = req.user.groups || [];
    const isAdmin = isTechnik(groups) || isPraesident(groups);
    const isOwner = (v.vollmachtgeber_email || '').toLowerCase() === (req.user.email || '').toLowerCase()
                 || (v.created_by_user_email || '').toLowerCase() === (req.user.email || '').toLowerCase();
    if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Nur Vollmachtgeber oder Admin' });
    if (v.status !== 'entwurf' && !isAdmin) return res.status(400).json({ error: 'Nur Entwuerfe koennen geloescht werden (Admin darf alle)' });
    await pool.query('DELETE FROM vollmachten WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      -- Mail-Chain-Visibility: Verkettung von Folge-Mails (z.B. Print-Notifications
      -- aus inbound-Mail an druckerr+, Delivery-Report aus Verteiler-Batch, etc.)
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS parent_message_id VARCHAR(500);
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS parent_source TEXT;
      CREATE INDEX IF NOT EXISTS idx_email_log_trigger ON email_log (trigger, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_log_parent ON email_log (parent_message_id) WHERE parent_message_id IS NOT NULL;

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
      -- WhatsApp-Gruppen-Mirror: wenn gesetzt, wird jede an die Verteiler-Adresse
      -- gehende Mail zusaetzlich in die hinterlegte WhatsApp-Gruppe gepostet.
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS whatsapp_group_id VARCHAR(120);
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS whatsapp_group_name VARCHAR(255);
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
        gueltig_ab DATE,
        archiviert_am DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wohnungen_kontakte_wohnung ON wohnungen_kontakte(wohnung_id);
      ALTER TABLE wohnungen_kontakte ADD COLUMN IF NOT EXISTS gueltig_ab DATE;
      ALTER TABLE wohnungen_kontakte ADD COLUMN IF NOT EXISTS archiviert_am DATE;
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

    // Handwerker- und Lieferantenliste
    await client.query(`
      CREATE TABLE IF NOT EXISTS handwerker (
        id SERIAL PRIMARY KEY,
        kategorie VARCHAR(80) NOT NULL,
        firma VARCHAR(255) NOT NULL,
        ansprechpartner VARCHAR(255),
        telefon VARCHAR(100),
        mobile VARCHAR(100),
        email VARCHAR(255),
        website VARCHAR(255),
        adresse TEXT,
        plz VARCHAR(20),
        ort VARCHAR(120),
        notiz TEXT,
        bewertung INTEGER CHECK (bewertung >= 1 AND bewertung <= 5),
        letzter_auftrag DATE,
        empfohlen_von VARCHAR(255),
        archiviert BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_handwerker_kategorie ON handwerker(kategorie);
      CREATE INDEX IF NOT EXISTS idx_handwerker_archiviert ON handwerker(archiviert);
      ALTER TABLE handwerker ADD COLUMN IF NOT EXISTS leistungen TEXT[];
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS handwerker_auftraege (
        id SERIAL PRIMARY KEY,
        handwerker_id INTEGER NOT NULL REFERENCES handwerker(id) ON DELETE CASCADE,
        datum DATE NOT NULL,
        beschreibung TEXT NOT NULL,
        kosten DECIMAL(10,2),
        stweg INTEGER,
        notiz TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_handwerker_auftraege_handwerker ON handwerker_auftraege(handwerker_id);
      CREATE INDEX IF NOT EXISTS idx_handwerker_auftraege_datum ON handwerker_auftraege(datum DESC);
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_auftraege_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_auftraege_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker_auftraege FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS handwerker_personen (
        id SERIAL PRIMARY KEY,
        handwerker_id INTEGER NOT NULL REFERENCES handwerker(id) ON DELETE CASCADE,
        rolle VARCHAR(80),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        telefon VARCHAR(100),
        mobile VARCHAR(100),
        notiz TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_handwerker_personen_h ON handwerker_personen(handwerker_id);
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_personen_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_personen_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker_personen FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS handwerker_event_typen (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        icon VARCHAR(8),
        beschreibung TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS handwerker_event_zuweisungen (
        id SERIAL PRIMARY KEY,
        event_typ_id INTEGER NOT NULL REFERENCES handwerker_event_typen(id) ON DELETE CASCADE,
        handwerker_id INTEGER NOT NULL REFERENCES handwerker(id) ON DELETE CASCADE,
        prioritaet INTEGER DEFAULT 1,
        stweg INTEGER,
        hinweis TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_handwerker_event_zuw_event ON handwerker_event_zuweisungen(event_typ_id);
      CREATE INDEX IF NOT EXISTS idx_handwerker_event_zuw_handwerker ON handwerker_event_zuweisungen(handwerker_id);

      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_event_typen_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_event_typen_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker_event_typen FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_event_zuw_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_event_zuw_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker_event_zuweisungen FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;

      INSERT INTO handwerker_event_typen (name, icon, beschreibung, sort_order) VALUES
        ('Wasserschaden',    '💧', 'Rohrbruch, Leck, eindringendes Wasser',     10),
        ('Heizungsausfall',  '🔥', 'Heizung defekt, kein warmes Wasser',        20),
        ('Stromausfall',     '⚡', 'Strom- oder Sicherungsprobleme',            30),
        ('Schlüsseldienst',  '🔑', 'Ausgesperrt, Schloss defekt',               40),
        ('Glasbruch',        '🪟', 'Fensterscheibe oder Glastür beschädigt',    50),
        ('Sturmschaden',     '🌪', 'Sturmschäden an Dach, Fassade, Bäumen',     60),
        ('Dachschaden',      '🏠', 'Undichtes Dach, lose Ziegel',               70),
        ('Kanalverstopfung', '🚽', 'Abfluss, Toilette, Kanalisation verstopft', 80),
        ('Schädlingsbefall', '🪳', 'Mäuse, Ratten, Insekten',                   90),
        ('Liftstörung',      '🛗', 'Aufzug steckt, Tür schließt nicht',        100)
      ON CONFLICT (name) DO NOTHING;

      CREATE TABLE IF NOT EXISTS imap_state (
        mailbox VARCHAR(120) PRIMARY KEY,
        uid_validity BIGINT NOT NULL,
        last_uid BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS handwerker_vertraege (
        id SERIAL PRIMARY KEY,
        handwerker_id INTEGER NOT NULL REFERENCES handwerker(id) ON DELETE CASCADE,
        titel VARCHAR(255) NOT NULL,
        beschreibung TEXT,
        frequenz_einheit VARCHAR(20),    -- 'tage' | 'wochen' | 'monate' | 'jahre' | NULL=einmalig
        frequenz_intervall INTEGER,
        naechster_termin DATE,
        startet_am DATE,
        endet_am DATE,
        kuendigungsfrist_tage INTEGER,
        jahres_kosten_chf DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'aktiv',
        vertragsdokument_url TEXT,
        notiz TEXT,
        stweg INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_handwerker_vertraege_h ON handwerker_vertraege(handwerker_id);
      CREATE INDEX IF NOT EXISTS idx_handwerker_vertraege_naechst ON handwerker_vertraege(naechster_termin) WHERE status = 'aktiv';

      ALTER TABLE handwerker_auftraege ADD COLUMN IF NOT EXISTS vertrag_id INTEGER REFERENCES handwerker_vertraege(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_handwerker_auftraege_vertrag ON handwerker_auftraege(vertrag_id);

      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='handwerker_vertraege_audit') THEN
          EXECUTE 'CREATE TRIGGER handwerker_vertraege_audit AFTER INSERT OR UPDATE OR DELETE ON handwerker_vertraege FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;
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

      CREATE TABLE IF NOT EXISTS verwaltungen (
        id SERIAL PRIMARY KEY,
        stweg INTEGER,
        firma_name VARCHAR(255) NOT NULL,
        adresse TEXT,
        telefon VARCHAR(100),
        email VARCHAR(255),
        plattform_name VARCHAR(120),
        plattform_url VARCHAR(500),
        plattform_user VARCHAR(255),
        plattform_pass TEXT,
        vertrag_von DATE,
        vertrag_bis DATE,
        kuendigungsfrist_monate INTEGER,
        kuendigung_eingereicht_am DATE,
        dokument_pfad VARCHAR(500),
        notizen TEXT,
        aktiv BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_verwaltungen_stweg ON verwaltungen(stweg, aktiv);
      ALTER TABLE verwaltungen ADD COLUMN IF NOT EXISTS website VARCHAR(255);
      ALTER TABLE verwaltungen ADD COLUMN IF NOT EXISTS oeffnungszeiten TEXT;

      CREATE TABLE IF NOT EXISTS verwaltungs_kontakte (
        id SERIAL PRIMARY KEY,
        verwaltung_id INTEGER NOT NULL REFERENCES verwaltungen(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        funktion VARCHAR(120),
        email VARCHAR(255),
        telefon VARCHAR(100),
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_verwaltungs_kontakte_verw ON verwaltungs_kontakte(verwaltung_id);

      CREATE TABLE IF NOT EXISTS unterschriftenliste_rueckläufe (
        id SERIAL PRIMARY KEY,
        snapshot_hash VARCHAR(20) NOT NULL,
        brief_idx INTEGER NOT NULL,
        brief_typ VARCHAR(20) NOT NULL DEFAULT 'einzel',
        einheit VARCHAR(255),
        empfaenger_name VARCHAR(500),
        empfaenger_adresse TEXT,
        retourniert_am TIMESTAMPTZ,
        vote VARCHAR(20),
        notiz TEXT,
        erfasst_von VARCHAR(255),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (snapshot_hash, brief_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_rueckl_snap ON unterschriftenliste_rueckläufe (snapshot_hash);
      CREATE INDEX IF NOT EXISTS idx_connlog_mac ON connection_log(mac);
      CREATE INDEX IF NOT EXISTS idx_connlog_network ON connection_log(network_name);
      CREATE INDEX IF NOT EXISTS idx_connlog_ip ON connection_log(ip);
      CREATE INDEX IF NOT EXISTS idx_connlog_dst ON connection_log(dst_ip);

      CREATE TABLE IF NOT EXISTS auslagen (
        id SERIAL PRIMARY KEY,
        user_email VARCHAR(255) NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        stweg INTEGER,
        datum DATE NOT NULL,
        kategorie VARCHAR(50),
        beschreibung TEXT NOT NULL,
        betrag_chf DECIMAL(10,2) NOT NULL,
        iban VARCHAR(40),
        beleg_path TEXT,
        beleg_filename VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'eingereicht',
        bemerkung_eigentuemer TEXT,
        bemerkung_ausschuss TEXT,
        bearbeitet_von VARCHAR(255),
        bearbeitet_am TIMESTAMPTZ,
        ausbezahlt_am DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT auslagen_status_chk CHECK (status IN ('eingereicht','genehmigt','abgelehnt','ausbezahlt')),
        CONSTRAINT auslagen_betrag_chk CHECK (betrag_chf > 0 AND betrag_chf <= 100000),
        CONSTRAINT auslagen_beschreibung_len CHECK (LENGTH(beschreibung) <= 2000),
        CONSTRAINT auslagen_bem_eig_len CHECK (bemerkung_eigentuemer IS NULL OR LENGTH(bemerkung_eigentuemer) <= 2000),
        CONSTRAINT auslagen_bem_aus_len CHECK (bemerkung_ausschuss IS NULL OR LENGTH(bemerkung_ausschuss) <= 2000)
      );
      CREATE INDEX IF NOT EXISTS idx_auslagen_user ON auslagen(user_email);
      CREATE INDEX IF NOT EXISTS idx_auslagen_stweg_status ON auslagen(stweg, status);
      CREATE INDEX IF NOT EXISTS idx_auslagen_created ON auslagen(created_at DESC);

      -- Generische Mail-Empfaenger-Stammdaten (Anwalt, Bank, Versicherung,
      -- Handwerker, Behoerde, Energieversorger etc.). Die "Verwaltung" bleibt
      -- in eigener verwaltungen-Tabelle (Vertrag/Plattform-Felder), wird aber
      -- von Empfaenger-Helper-Funktion als Kategorie 'verwaltung' mit-gequeried.
      CREATE TABLE IF NOT EXISTS mail_empfaenger (
        id SERIAL PRIMARY KEY,
        kategorie VARCHAR(60) NOT NULL,        -- 'anwalt','bank','versicherung','behoerde','energie','handwerker','sonstige', ...
        name VARCHAR(255) NOT NULL,             -- Firmen-/Personenname
        email VARCHAR(255),
        telefon VARCHAR(60),
        adresse TEXT,
        website VARCHAR(255),
        stweg INTEGER,                          -- NULL = STWEG-uebergreifend
        kontakte JSONB DEFAULT '[]'::jsonb,    -- [{name, funktion, email, telefon}, ...]
        default_cc TEXT,                        -- automatisch immer mit-CCen (Komma-Liste)
        default_reply_to VARCHAR(255),
        requires_approval BOOLEAN DEFAULT true, -- Outbox-Freigabe-Pflicht?
        notiz TEXT,
        aktiv BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mail_empf_kategorie ON mail_empfaenger(kategorie, aktiv);
      CREATE INDEX IF NOT EXISTS idx_mail_empf_stweg ON mail_empfaenger(stweg, aktiv);

      -- Personen-Entitaet (Single Source of Truth fuer Kontaktdaten).
      -- Eine Person kann mehrere Wohnungen besitzen/bewohnen. Aenderungen an
      -- Email/Telefon/Adresse propagieren automatisch via Trigger auf alle
      -- verknuepften wohnungen_kontakte-Zeilen.
      CREATE TABLE IF NOT EXISTS personen (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,           -- Anzeigename (z.B. "Stefan Mueller")
        vorname VARCHAR(120),                  -- optional, fuer strukturierte Anzeige
        nachname VARCHAR(120),                 -- optional
        email VARCHAR(255),
        telefon VARCHAR(60),
        mobile VARCHAR(60),
        adresse TEXT,
        geburtsdatum DATE,
        anrede VARCHAR(20),                    -- Herr / Frau / Familie / etc.
        notiz TEXT,
        review_needed BOOLEAN DEFAULT false,   -- markiert moegliche Duplikate fuer Dedup
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_personen_email ON personen(LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_personen_name ON personen(LOWER(name));
      -- H2: Eindeutigkeits-Index gegen parallele Duplikate (findOrCreatePerson Race)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_personen_name_email
        ON personen (LOWER(TRIM(COALESCE(name, ''))), LOWER(TRIM(COALESCE(email, ''))));

      ALTER TABLE wohnungen_kontakte ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL;
      ALTER TABLE wohnungen_kontakte ADD COLUMN IF NOT EXISTS mobile VARCHAR(60);
      -- Multiple weitere Telefonnummern pro Person als JSONB
      -- Format: [{typ: 'mobile2'|'festnetz2'|'geschaeft'|'sonstige', label?: string, nummer: string}]
      ALTER TABLE personen ADD COLUMN IF NOT EXISTS telefone JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE personen ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN DEFAULT false;
      ALTER TABLE personen ADD COLUMN IF NOT EXISTS whatsapp_letzte_aktivitaet TIMESTAMPTZ;

      -- PBX (Asterisk) Konfiguration + Call-Log
      CREATE TABLE IF NOT EXISTS pbx_ring_members (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        phone VARCHAR(60) NOT NULL,             -- internationales Format z.B. +41765199970
        enabled BOOLEAN DEFAULT true,           -- Toggle (auch fuer permanente)
        is_temporary BOOLEAN DEFAULT false,     -- Vertretung
        valid_until TIMESTAMPTZ,                -- NULL = permanent, sonst Ablauf
        priority INTEGER DEFAULT 100,           -- niedrigere zuerst, gleiche parallel
        person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        added_by VARCHAR(255),
        notiz TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pbx_ring_enabled ON pbx_ring_members(enabled) WHERE enabled = true;

      CREATE TABLE IF NOT EXISTS pbx_config (
        key VARCHAR(60) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by VARCHAR(255)
      );
      INSERT INTO pbx_config (key, value) VALUES
        ('hours_open_from', '06:00'),
        ('hours_open_to', '20:00'),
        ('ring_timeout', '30'),
        ('weekdays', 'mon-sun')
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS pbx_calls (
        id SERIAL PRIMARY KEY,
        direction VARCHAR(10) NOT NULL,         -- 'inbound' | 'outbound'
        caller_id VARCHAR(60),
        dialed VARCHAR(60),
        uniqueid VARCHAR(60) UNIQUE,            -- Asterisk Channel UniqueID
        started_at TIMESTAMPTZ DEFAULT NOW(),
        answered_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        answered_by VARCHAR(60),                -- welche Ring-Group-Nummer abgenommen hat
        duration_seconds INTEGER,
        hangup_cause VARCHAR(40),               -- z.B. 'NORMAL', 'NOANSWER', 'BUSY'
        voicemail_path TEXT,                    -- Pfad zur WAV im CT 220
        voicemail_transcript TEXT,
        voicemail_summary TEXT,
        meta JSONB DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_pbx_calls_started ON pbx_calls(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pbx_calls_direction ON pbx_calls(direction);
      -- Mehrfach-Emails pro Person (Alias-Adressen, z.B. privat + geschaeft).
      -- Format: ["alias1@example.com","alias2@example.com"]. Primary bleibt
      -- in der email-Spalte. Lookup matcht email OR irgendeinen Eintrag hier.
      ALTER TABLE personen ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT '[]'::jsonb;
      -- GIN-Index fuer schnellen JSONB-Array-Contains-Lookup
      CREATE INDEX IF NOT EXISTS idx_personen_emails_gin ON personen USING gin (emails);

      -- WhatsApp-Bot: ein-/ausgehende Nachrichten
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id SERIAL PRIMARY KEY,
        direction VARCHAR(10) NOT NULL,             -- 'inbound' | 'outbound'
        phone VARCHAR(60) NOT NULL,                 -- normalisierte Nummer
        whatsapp_msg_id VARCHAR(120),               -- ID vom WA-Provider
        body TEXT,
        attachments JSONB DEFAULT '[]'::jsonb,      -- [{type, url, mimetype, caption?}]
        person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        source_type VARCHAR(60),                    -- z.B. 'auslage-status' | 'reklamation-bestaetigung' | 'command-response'
        source_id INTEGER,
        status VARCHAR(20) DEFAULT 'received',      -- received | queued | sent | failed | bounced
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        CONSTRAINT wa_msg_dir_chk CHECK (direction IN ('inbound', 'outbound'))
      );
      CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON whatsapp_messages(phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wa_msg_pending ON whatsapp_messages(status, created_at)
        WHERE direction = 'outbound' AND status = 'queued';
      CREATE INDEX IF NOT EXISTS idx_wa_msg_person ON whatsapp_messages(person_id, created_at DESC);
      -- chat_id (WhatsApp JID: <id>@c.us, <id>@lid, <id>@g.us) — fuer Reply
      -- an LID-Privacy-Chats, wo die echte Nummer nicht aufgeloest werden kann.
      ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS chat_id VARCHAR(120);

      -- Reklamationen / Schadensmeldungen via WhatsApp
      CREATE TABLE IF NOT EXISTS reklamationen (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        stweg INTEGER,
        kategorie VARCHAR(60),                      -- 'aufzug' | 'heizung' | 'wasser' | 'tuer' | 'reinigung' | 'sonstige'
        beschreibung TEXT NOT NULL,
        bild_pfad TEXT,                             -- Pfad im DOCS-Volume falls Foto mitgeschickt
        status VARCHAR(20) DEFAULT 'offen',         -- offen | weitergeleitet | erledigt | abgewiesen
        eingang_kanal VARCHAR(20) DEFAULT 'whatsapp', -- whatsapp | web | mail
        handwerker_id INTEGER REFERENCES handwerker(id) ON DELETE SET NULL,
        zugewiesen_an VARCHAR(255),
        erledigt_am TIMESTAMPTZ,
        notiz TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT rekl_status_chk CHECK (status IN ('offen','weitergeleitet','erledigt','abgewiesen'))
      );
      CREATE INDEX IF NOT EXISTS idx_rekl_status ON reklamationen(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rekl_person ON reklamationen(person_id);
      CREATE INDEX IF NOT EXISTS idx_wk_person ON wohnungen_kontakte(person_id);

      -- Vollmachten: Eigentuemer bevollmaechtigt Verwalter/Mieter/andere
      -- Person zur Vertretung in laufender Verwaltung, Einzel-Geschaeft
      -- oder Datenschutz-Auskunft. Schweizer ZertES Art.2: digital signiert
      -- per Authentik-Login = einfache elektronische Signatur (mit
      -- Audit-Log: timestamp, IP, user-agent). Papier-Pfad fuer
      -- gedruckt+unterschrieben+gescannt.
      CREATE TABLE IF NOT EXISTS vollmachten (
        id SERIAL PRIMARY KEY,
        -- Vollmachtgeber (= Eigentuemer/Berechtigter, der die Vollmacht erteilt)
        vollmachtgeber_person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        vollmachtgeber_name TEXT NOT NULL,
        vollmachtgeber_email TEXT,
        vollmachtgeber_adresse TEXT,
        -- Bevollmaechtigter
        bevollmaechtigter_typ VARCHAR(20) NOT NULL,    -- 'eigentuemer' | 'verwaltung' | 'mieter' | 'extern'
        bevollmaechtigter_person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        bevollmaechtigter_verwaltung_id INTEGER REFERENCES verwaltungen(id) ON DELETE SET NULL,
        bevollmaechtigter_name TEXT NOT NULL,
        bevollmaechtigter_email TEXT,
        bevollmaechtigter_adresse TEXT,
        bevollmaechtigter_telefon TEXT,
        -- Geltungsbereich
        art VARCHAR(20) NOT NULL,                       -- 'generell' | 'spezifisch' | 'auskunft'
        geltungsbereich TEXT,                           -- Freitext: was darf der Bevollmaechtigte
        wohnung_id INTEGER REFERENCES wohnungen(id) ON DELETE SET NULL,
        stweg INTEGER,
        -- Zeit
        gueltig_ab DATE NOT NULL DEFAULT CURRENT_DATE,
        gueltig_bis DATE,                               -- NULL = bis Widerruf
        -- Signatur
        signatur_typ VARCHAR(20),                       -- 'digital' | 'papier'
        digital_signed_at TIMESTAMPTZ,
        digital_signed_ip TEXT,
        digital_signed_user_agent TEXT,
        digital_signed_authentik_sub TEXT,              -- Authentik User-Sub als Identitaets-Anker
        papier_pdf_path TEXT,                           -- Pfad im /documents/Vollmachten/
        -- Status
        status VARCHAR(20) DEFAULT 'entwurf',           -- 'entwurf' | 'aktiv' | 'widerrufen' | 'abgelaufen'
        widerrufen_am TIMESTAMPTZ,
        widerrufen_von_user_email TEXT,
        widerrufen_grund TEXT,
        -- Audit
        created_by_user_email TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT vm_art_chk CHECK (art IN ('generell','spezifisch','auskunft')),
        CONSTRAINT vm_typ_chk CHECK (bevollmaechtigter_typ IN ('eigentuemer','verwaltung','mieter','extern')),
        CONSTRAINT vm_status_chk CHECK (status IN ('entwurf','aktiv','widerrufen','abgelaufen')),
        CONSTRAINT vm_signatur_chk CHECK (signatur_typ IS NULL OR signatur_typ IN ('digital','papier'))
      );
      CREATE INDEX IF NOT EXISTS idx_vm_geber ON vollmachten(vollmachtgeber_person_id, status);
      CREATE INDEX IF NOT EXISTS idx_vm_nehmer ON vollmachten(bevollmaechtigter_person_id, status);
      CREATE INDEX IF NOT EXISTS idx_vm_status ON vollmachten(status, gueltig_bis);
      CREATE INDEX IF NOT EXISTS idx_vm_wohnung ON vollmachten(wohnung_id) WHERE wohnung_id IS NOT NULL;
      -- Oeffentliches, zufaelliges Dokumentenkennzeichen (8 Zeichen base32-aehnlich)
      -- statt aufsteigender ID, damit Vollmachts-Nummer keine Mengenrueckschluesse
      -- erlaubt und bei Drucken nicht verwechselbar ist.
      ALTER TABLE vollmachten ADD COLUMN IF NOT EXISTS doc_hash VARCHAR(16) UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_vm_doc_hash ON vollmachten(doc_hash);
      -- Hash fuer Bestands-Vollmachten nachgenerieren
      UPDATE vollmachten SET doc_hash = SUBSTRING(MD5(id::TEXT || created_at::TEXT) FROM 1 FOR 8)
        WHERE doc_hash IS NULL;

      -- CH-Recht: bei Miteigentum (Ehepaar, Erbengemeinschaft, etc.) muessen
      -- ALLE Vollmachtgeber unterschreiben damit die Vollmacht gueltig ist.
      -- Separate Tabelle pro Vollmachtgeber mit eigener Signatur. Die alte
      -- vollmachtgeber_*-Spalten im Haupt-Record bleiben als 'Primaer-Vollmachtgeber'
      -- (Snapshot, fuer Anzeige in Listen + Backward-Compatibility).
      CREATE TABLE IF NOT EXISTS vollmachten_vollmachtgeber (
        id SERIAL PRIMARY KEY,
        vollmacht_id INTEGER NOT NULL REFERENCES vollmachten(id) ON DELETE CASCADE,
        person_id INTEGER REFERENCES personen(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        email TEXT,
        adresse TEXT,
        sort_order INTEGER DEFAULT 0,
        -- Individuelle Signatur pro Vollmachtgeber
        signatur_typ VARCHAR(20),                  -- 'digital' | 'papier' | NULL (offen)
        signed_at TIMESTAMPTZ,
        signed_ip TEXT,
        signed_user_agent TEXT,
        signed_authentik_sub TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT vmvg_sig_chk CHECK (signatur_typ IS NULL OR signatur_typ IN ('digital','papier'))
      );
      CREATE INDEX IF NOT EXISTS idx_vmvg_vollmacht ON vollmachten_vollmachtgeber(vollmacht_id);
      CREATE INDEX IF NOT EXISTS idx_vmvg_email ON vollmachten_vollmachtgeber(LOWER(email));

      -- Migration: Bestands-Vollmachten bekommen den Primaer-Vollmachtgeber
      -- als ersten Eintrag in der Liste, falls noch keiner existiert.
      INSERT INTO vollmachten_vollmachtgeber (vollmacht_id, person_id, name, email, adresse, sort_order, signatur_typ, signed_at, signed_ip, signed_user_agent, signed_authentik_sub)
      SELECT v.id, v.vollmachtgeber_person_id, v.vollmachtgeber_name, v.vollmachtgeber_email, v.vollmachtgeber_adresse,
             0, v.signatur_typ,
             CASE WHEN v.signatur_typ = 'digital' THEN v.digital_signed_at ELSE NULL END,
             v.digital_signed_ip, v.digital_signed_user_agent, v.digital_signed_authentik_sub
        FROM vollmachten v
       WHERE NOT EXISTS (SELECT 1 FROM vollmachten_vollmachtgeber vg WHERE vg.vollmacht_id = v.id);
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='audit_trigger_fn')
           AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name='vollmachten_audit') THEN
          EXECUTE 'CREATE TRIGGER vollmachten_audit AFTER INSERT OR UPDATE OR DELETE ON vollmachten FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()';
        END IF;
      END $$;

      -- Trigger: bei UPDATE personen → email/telefon/adresse/name auf alle
      -- aktiven wohnungen_kontakte mit dieser person_id propagieren.
      -- AFTER UPDATE (statt BEFORE) damit der reverse Trigger nicht
      -- die selbe Person-Zeile mid-update modifiziert. Recursion-Schutz
      -- via session-Setting rosenweg.person_sync = 'on'.
      CREATE OR REPLACE FUNCTION personen_propagate_to_kontakte() RETURNS TRIGGER AS $$
      DECLARE
        is_syncing BOOLEAN;
      BEGIN
        BEGIN
          is_syncing := current_setting('rosenweg.person_sync', true) = 'on';
        EXCEPTION WHEN OTHERS THEN
          is_syncing := false;
        END;
        IF is_syncing THEN RETURN NULL; END IF;
        IF NEW.name IS DISTINCT FROM OLD.name
           OR NEW.email IS DISTINCT FROM OLD.email
           OR NEW.telefon IS DISTINCT FROM OLD.telefon
           OR NEW.adresse IS DISTINCT FROM OLD.adresse THEN
          PERFORM set_config('rosenweg.person_sync', 'on', true);
          UPDATE wohnungen_kontakte
             SET name = NEW.name,
                 email = NEW.email,
                 telefon = NEW.telefon,
                 adresse = NEW.adresse
           WHERE person_id = NEW.id AND archiviert_am IS NULL;
          PERFORM set_config('rosenweg.person_sync', 'off', true);
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_personen_propagate ON personen;
      CREATE TRIGGER trg_personen_propagate
        AFTER UPDATE ON personen
        FOR EACH ROW EXECUTE FUNCTION personen_propagate_to_kontakte();

      -- Trigger: bei UPDATE wohnungen_kontakte mit person_id → die Person
      -- (master) aktualisieren. Damit alte Code-Pfade (saveKontakte etc.)
      -- transparent weiterhin funktionieren. Gleicher Rekursions-Schutz.
      CREATE OR REPLACE FUNCTION kontakte_propagate_to_person() RETURNS TRIGGER AS $$
      DECLARE
        is_syncing BOOLEAN;
      BEGIN
        BEGIN
          is_syncing := current_setting('rosenweg.person_sync', true) = 'on';
        EXCEPTION WHEN OTHERS THEN
          is_syncing := false;
        END;
        IF is_syncing THEN RETURN NULL; END IF;
        IF NEW.person_id IS NULL THEN RETURN NULL; END IF;
        IF NEW.name IS DISTINCT FROM OLD.name
           OR NEW.email IS DISTINCT FROM OLD.email
           OR NEW.telefon IS DISTINCT FROM OLD.telefon
           OR NEW.adresse IS DISTINCT FROM OLD.adresse THEN
          PERFORM set_config('rosenweg.person_sync', 'on', true);
          UPDATE personen
             SET name = COALESCE(NEW.name, name),
                 email = NEW.email,
                 telefon = NEW.telefon,
                 adresse = NEW.adresse,
                 updated_at = NOW()
           WHERE id = NEW.person_id;
          PERFORM set_config('rosenweg.person_sync', 'off', true);
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_kontakte_propagate ON wohnungen_kontakte;
      CREATE TRIGGER trg_kontakte_propagate
        AFTER UPDATE ON wohnungen_kontakte
        FOR EACH ROW EXECUTE FUNCTION kontakte_propagate_to_person();

      -- Verwaltungs-Mail-Genehmigungs-Queue
      -- Alle ausgehenden Mails an externe Verwaltung werden zuerst hier
      -- abgelegt und brauchen Freigabe durch Technik oder Praesident
      -- bevor sie versendet werden. Inhalt kann editiert werden.
      CREATE TABLE IF NOT EXISTS verwaltung_mail_queue (
        id SERIAL PRIMARY KEY,
        source_type VARCHAR(60) NOT NULL,
        source_id INTEGER,
        mail_to TEXT NOT NULL,
        mail_cc TEXT,
        mail_reply_to VARCHAR(255),
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        attachments JSONB DEFAULT '[]'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        original_snapshot JSONB,
        edited_by VARCHAR(255),
        edited_at TIMESTAMPTZ,
        freigegeben_von VARCHAR(255),
        freigegeben_am TIMESTAMPTZ,
        abgelehnt_von VARCHAR(255),
        abgelehnt_am TIMESTAMPTZ,
        abgelehnt_grund TEXT,
        sent_at TIMESTAMPTZ,
        send_error TEXT,
        CONSTRAINT vmq_status_chk CHECK (status IN ('pending','freigegeben','abgelehnt','gesendet','fehler'))
      );
      CREATE INDEX IF NOT EXISTS idx_vmq_pending ON verwaltung_mail_queue(status, created_at) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_vmq_source ON verwaltung_mail_queue(source_type, source_id);

      -- M7: Separate Tabelle fuer Mail-Attachments. Inline-base64 in JSONB skaliert
      -- nicht (20 MB Anhang × 100 Mails = 2 GB Tabelle). Hier nur Metadaten +
      -- Referenz auf Disk-Pfad (docs_path) ODER kleine inline content_base64.
      CREATE TABLE IF NOT EXISTS verwaltung_mail_attachments (
        id SERIAL PRIMARY KEY,
        queue_id INTEGER NOT NULL REFERENCES verwaltung_mail_queue(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL,
        size_bytes INTEGER,
        docs_path TEXT,                       -- live aus DOCS_PATH lesen (Standard fuer Belege)
        content_base64 TEXT,                  -- inline (fuer Ad-hoc-Compose-Uploads)
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT vma_source_chk CHECK (docs_path IS NOT NULL OR content_base64 IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_vma_queue ON verwaltung_mail_attachments(queue_id, sort_order);

      -- Freigabe-Regeln pro source_type-Pattern. Praezedenz: spezifischer
      -- source_type vor 'default'. Erste passende Regel gilt.
      CREATE TABLE IF NOT EXISTS mail_approval_config (
        id SERIAL PRIMARY KEY,
        source_type_pattern VARCHAR(120) NOT NULL,        -- z.B. 'auslage-auszahlung', 'ad-hoc-anwalt', 'objekt-aenderung' oder 'default'
        min_betrag_chf NUMERIC(10,2),                     -- optional, gilt nur fuer Auslagen ueber diesem Betrag
        required_groups TEXT NOT NULL,                    -- Komma-Liste, z.B. 'technik,praesident'
        min_approvers INTEGER NOT NULL DEFAULT 1,         -- Anzahl Freigaben fuer Versand (4-Augen-Prinzip ab 2)
        sort_order INTEGER DEFAULT 0,                     -- bei mehreren passenden zaehlt niedrigster sort_order zuerst
        notiz TEXT,
        aktiv BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Eindeutigkeit: Pattern + (Betrag oder kein Betrag) - via expression index
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mac_pattern_betrag
        ON mail_approval_config (source_type_pattern, COALESCE(min_betrag_chf, 0));
      CREATE INDEX IF NOT EXISTS idx_mac_pattern ON mail_approval_config(source_type_pattern, aktiv);

      -- Log einzelner Freigaben (4-Augen-Audit). Eine Mail kann mehrere Approver brauchen.
      CREATE TABLE IF NOT EXISTS mail_approval_log (
        id SERIAL PRIMARY KEY,
        queue_id INTEGER NOT NULL REFERENCES verwaltung_mail_queue(id) ON DELETE CASCADE,
        approver_email VARCHAR(255) NOT NULL,
        approved_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (queue_id, approver_email)
      );
      CREATE INDEX IF NOT EXISTS idx_mal_queue ON mail_approval_log(queue_id);

      -- Mail-Templates pro source_type + optional Empfaenger-Kategorie.
      -- Platzhalter im Format {{path.to.field}} (z.B. {{auslage.betrag_chf}}).
      -- Wenn kein Template gefunden wird, wird der hartcodierte Default verwendet.
      CREATE TABLE IF NOT EXISTS mail_templates (
        id SERIAL PRIMARY KEY,
        source_type VARCHAR(120) NOT NULL,                -- z.B. 'auslage-auszahlung', 'objekt-aenderung'
        empfaenger_kategorie VARCHAR(60),                  -- z.B. 'verwaltung', 'bank', NULL = alle
        subject_template TEXT NOT NULL,
        body_template TEXT NOT NULL,
        notiz TEXT,
        aktiv BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_templates ON mail_templates (source_type, COALESCE(empfaenger_kategorie, '_all'));
      CREATE INDEX IF NOT EXISTS idx_templates_source ON mail_templates(source_type, aktiv);

      -- Outbox-Tracking: wann ging die letzte Auszahlungs-Mail an wen?
      -- Damit koennen wir genehmigte Auslagen, die waehrend einer Vakanz
      -- nur an den Ausschuss gingen, automatisch an eine neue Verwaltung
      -- nachreichen, sobald diese wirksam wird.
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_mail_at TIMESTAMPTZ;
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_mail_to TEXT;
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_mail_fallback BOOLEAN DEFAULT false;
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_mail_verwaltung_id INTEGER;
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_mail_count INTEGER DEFAULT 0;
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS auszahlung_reminder_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_auslagen_offen_fallback ON auslagen(status, auszahlung_mail_fallback) WHERE status = 'genehmigt';

      -- Projekt-Budget (Soll-Wert) fuer Budget-Tracking
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_chf NUMERIC(12,2);
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_warnung_pct INTEGER DEFAULT 80;

      -- Optional: Auslage einem Projekt zuordnen (Budget-Tracking)
      ALTER TABLE auslagen ADD COLUMN IF NOT EXISTS projekt_slug VARCHAR(100);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auslagen_projekt_fk') THEN
          ALTER TABLE auslagen ADD CONSTRAINT auslagen_projekt_fk
            FOREIGN KEY (projekt_slug) REFERENCES projects(slug) ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_auslagen_projekt ON auslagen(projekt_slug) WHERE projekt_slug IS NOT NULL;

      -- L1+L6: CHECK-Constraints nachtraeglich hinzufuegen (CREATE TABLE IF NOT EXISTS
      -- fuegt neue Constraints nicht zu existierender Tabelle hinzu)
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auslagen_betrag_chk' AND conrelid = 'auslagen'::regclass) THEN
          ALTER TABLE auslagen ADD CONSTRAINT auslagen_betrag_chk CHECK (betrag_chf > 0 AND betrag_chf <= 100000);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auslagen_beschreibung_len' AND conrelid = 'auslagen'::regclass) THEN
          ALTER TABLE auslagen ADD CONSTRAINT auslagen_beschreibung_len CHECK (LENGTH(beschreibung) <= 2000);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auslagen_bem_eig_len' AND conrelid = 'auslagen'::regclass) THEN
          ALTER TABLE auslagen ADD CONSTRAINT auslagen_bem_eig_len CHECK (bemerkung_eigentuemer IS NULL OR LENGTH(bemerkung_eigentuemer) <= 2000);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auslagen_bem_aus_len' AND conrelid = 'auslagen'::regclass) THEN
          ALTER TABLE auslagen ADD CONSTRAINT auslagen_bem_aus_len CHECK (bemerkung_ausschuss IS NULL OR LENGTH(bemerkung_ausschuss) <= 2000);
        END IF;
      END $$;

      -- Mehrere Belege pro Auslage. Migration: bestehendes auslagen.beleg_path
      -- wird beim ersten Start in auslagen_belege als erster Eintrag uebernommen.
      CREATE TABLE IF NOT EXISTS auslagen_belege (
        id SERIAL PRIMARY KEY,
        auslage_id INTEGER NOT NULL REFERENCES auslagen(id) ON DELETE CASCADE,
        beleg_path TEXT NOT NULL,             -- relativer Pfad im DOCS-Volume
        beleg_filename VARCHAR(255),
        size_bytes INTEGER,
        waehrung_original VARCHAR(3),         -- z.B. EUR, CHF (vom Scan extrahiert)
        wechselkurs_chf NUMERIC(10,6) DEFAULT 1, -- 1 X = Y CHF, am Beleg-Datum
        kurs_quelle VARCHAR(60),              -- z.B. 'exchangerate.host 2026-05-10'
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_auslagen_belege_auslage ON auslagen_belege(auslage_id, sort_order);

      -- Migration: bestehende beleg_path-Werte in neue Tabelle uebernehmen
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM auslagen WHERE beleg_path IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM auslagen_belege WHERE auslage_id = auslagen.id)) THEN
          INSERT INTO auslagen_belege (auslage_id, beleg_path, beleg_filename, sort_order)
          SELECT id, beleg_path, beleg_filename, 0 FROM auslagen
           WHERE beleg_path IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM auslagen_belege WHERE auslage_id = auslagen.id);
        END IF;
      END $$;

      -- Detaillierte Positionen pro Auslage (KI-Belegleser-Output oder manuell)
      -- Positionen koennen einem konkreten Beleg zugeordnet sein (beleg_id)
      CREATE TABLE IF NOT EXISTS auslagen_positionen (
        id SERIAL PRIMARY KEY,
        auslage_id INTEGER NOT NULL REFERENCES auslagen(id) ON DELETE CASCADE,
        position_typ VARCHAR(20) NOT NULL DEFAULT 'material',   -- 'material' | 'arbeitszeit'
        beschreibung TEXT NOT NULL,
        menge NUMERIC(10,3) DEFAULT 1,                          -- Stueck / Stunden / Liter etc.
        einheit VARCHAR(20),                                    -- 'Stk', 'h', 'kg', 'l', 'm', ...
        einzelpreis_chf NUMERIC(10,2),                          -- pro Einheit
        gesamt_chf NUMERIC(10,2) NOT NULL,                      -- berechnet oder manuell
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT auslagen_pos_typ_chk CHECK (position_typ IN ('material','arbeitszeit')),
        CONSTRAINT auslagen_pos_gesamt_chk CHECK (gesamt_chf >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_auslagen_pos_auslage ON auslagen_positionen(auslage_id, sort_order);
      ALTER TABLE auslagen_positionen ADD COLUMN IF NOT EXISTS beleg_id INTEGER REFERENCES auslagen_belege(id) ON DELETE SET NULL;
      ALTER TABLE auslagen_positionen ADD COLUMN IF NOT EXISTS waehrung_original VARCHAR(3);
      ALTER TABLE auslagen_positionen ADD COLUMN IF NOT EXISTS gesamt_original NUMERIC(10,2);

      -- Stundensatz-Config: pro STWEG oder uebergreifend (stweg=NULL).
      -- Wird beim KI-Belegleser bei "Arbeitszeit"-Positionen automatisch fuer
      -- die Berechnung genutzt.
      CREATE TABLE IF NOT EXISTS auslagen_stundensatz (
        id SERIAL PRIMARY KEY,
        stweg INTEGER UNIQUE,                                   -- NULL = uebergreifend
        satz_chf NUMERIC(10,2) NOT NULL,
        beschreibung TEXT,
        gueltig_ab DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT auslagen_satz_chk CHECK (satz_chf > 0 AND satz_chf <= 500)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_auslagen_satz_stweg
        ON auslagen_stundensatz (COALESCE(stweg, -1));
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
      // Ausschuss kann Auslagen seines STWEGs pruefen/freigeben
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'auslagen', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }

    // Seed auslagen read fuer alle Eigentuemer-Gruppen (eigene Auslagen einsehen/einreichen)
    const eigentuemerGroups = Object.values(STWEG_GROUPS).map(g => g.eigentuemer).filter(Boolean);
    for (const groupName of eigentuemerGroups) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'auslagen', 'read')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }
    // Generische "eigentuemer" Gruppe (Authentik Hierarchy Parent) auch
    await client.query(`
      INSERT INTO permissions (group_name, page, access) VALUES ('eigentuemer', 'auslagen', 'read')
      ON CONFLICT (group_name, page) DO NOTHING
    `);

    // Auslagen-Stundensatz: Ausschuss write fuer den eigenen STWEG (vereinfacht: alle Ausschuss write)
    for (const groupName of ausschussGroups) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'auslagen-stundensatz', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
      // Reklamationen: Ausschuss kann verwalten
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'reklamationen', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }

    // PBX-Admin (Asterisk-Konfiguration): nur Technik + Praesident
    await client.query(`
      INSERT INTO permissions (group_name, page, access) VALUES
      ('technik', 'pbx-admin', 'write'),
      ('Präsident', 'pbx-admin', 'write')
      ON CONFLICT (group_name, page) DO NOTHING
    `);

    // Loeschungen-Admin (Pending Authentik-Deletions): Technik + Praesident
    await client.query(`
      INSERT INTO permissions (group_name, page, access) VALUES
      ('technik', 'loeschungen', 'write'),
      ('Präsident', 'loeschungen', 'write')
      ON CONFLICT (group_name, page) DO NOTHING
    `);

    // Default Approval-Regel: technik ODER praesident, 1 Freigabe genuegt.
    await client.query(`
      INSERT INTO mail_approval_config (source_type_pattern, required_groups, min_approvers, sort_order, notiz)
      SELECT 'default', 'technik,praesident', 1, 100, 'Standard: 1 Freigabe von Technik oder Praesident'
      WHERE NOT EXISTS (SELECT 1 FROM mail_approval_config WHERE source_type_pattern = 'default' AND min_betrag_chf IS NULL)
    `);

    // Mail-Empfaenger Stammdaten: Ausschuss read, Technik/Praesident sowieso write via isTechnik/isPraesident
    // Mail-Compose: Ausschuss write (kann Mails entwerfen, aber Freigabe macht Technik/Praesident)
    for (const groupName of ausschussGroups) {
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'mail-empfaenger', 'read')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
      await client.query(`
        INSERT INTO permissions (group_name, page, access) VALUES ($1, 'mail-compose', 'write')
        ON CONFLICT (group_name, page) DO NOTHING
      `, [groupName]);
    }

    // ─── Einmalige Personen-Migration ──────────────────────────────
    // Wenn die personen-Tabelle leer ist UND es aktive Kontakte gibt,
    // konsolidieren wir die Kontakte zu Personen via (Name + Email).
    // Email-Sharing (Ehepaare) bleibt erhalten — die Person wird ueber
    // person_id eindeutig referenziert, nicht ueber die Email.
    try {
      const personCount = await client.query('SELECT COUNT(*) AS cnt FROM personen');
      const kontaktCount = await client.query('SELECT COUNT(*) AS cnt FROM wohnungen_kontakte WHERE archiviert_am IS NULL AND person_id IS NULL');
      if (parseInt(personCount.rows[0].cnt) === 0 && parseInt(kontaktCount.rows[0].cnt) > 0) {
        console.log('[personen-migration] Konsolidiere wohnungen_kontakte → personen ...');
        // M8: Cluster-Strategie geschaerft:
        //   - Wenn Email vorhanden: cluster per (name_norm, email_norm) — Ehepaare mit
        //     shared Email werden korrekt als getrennte Personen behandelt
        //   - Wenn KEINE Email: jeder Kontakt bekommt eigene Person (per id partition),
        //     statt versehentlich verschiedene "Hans Mueller" zusammenzufuehren.
        //     Admin kann spaeter per Merge-Tool zusammenfuehren wenn gewollt.
        const inserted = await client.query(`
          WITH active AS (
            SELECT id, name, email, telefon, adresse,
                   LOWER(TRIM(COALESCE(name, ''))) AS name_norm,
                   LOWER(TRIM(COALESCE(email, ''))) AS email_norm,
                   CASE WHEN email IS NOT NULL AND email <> '' THEN 'mit-email' ELSE 'ohne-email' END AS bucket,
                   ROW_NUMBER() OVER (
                     PARTITION BY
                       LOWER(TRIM(COALESCE(name,''))),
                       -- ohne email: id als zusaetzlichen Partition-Key → jeder Kontakt eigene Person
                       CASE WHEN email IS NOT NULL AND email <> '' THEN LOWER(TRIM(email)) ELSE id::text END
                     ORDER BY (CASE WHEN telefon IS NOT NULL THEN 0 ELSE 1 END),
                              (CASE WHEN adresse IS NOT NULL THEN 0 ELSE 1 END),
                              id DESC
                   ) AS rn
              FROM wohnungen_kontakte
             WHERE archiviert_am IS NULL
          ),
          inserted AS (
            INSERT INTO personen (name, email, telefon, adresse)
            SELECT name, email, telefon, adresse FROM active WHERE rn = 1
            RETURNING id, LOWER(TRIM(COALESCE(name,''))) AS name_norm, LOWER(TRIM(COALESCE(email,''))) AS email_norm
          )
          SELECT COUNT(*) AS n FROM inserted
        `);
        console.log(`[personen-migration] ${inserted.rows[0].n} Personen angelegt`);

        // person_id auf Kontakte mit Email mappen (eindeutig via name+email)
        const linkedMitEmail = await client.query(`
          UPDATE wohnungen_kontakte k
             SET person_id = p.id
            FROM personen p
           WHERE k.archiviert_am IS NULL
             AND k.person_id IS NULL
             AND k.email IS NOT NULL AND k.email <> ''
             AND LOWER(TRIM(k.name))  = LOWER(TRIM(COALESCE(p.name,'')))
             AND LOWER(TRIM(k.email)) = LOWER(TRIM(COALESCE(p.email,'')))
        `);
        // person_id fuer Email-lose Kontakte: jeder Kontakt wurde als eigene Person
        // eingefuegt → einzeln matchen ueber name + name+telefon+adresse Heuristik nicht
        // moeglich; daher: pro Kontakt INSERT (oder Subquery) wenn nicht gemappt.
        // Da Migration nur einmal laeuft und alle ohne-email Personen 1:1 mit Kontakten
        // korrespondieren, einfache nachgelagerte Logik:
        const orphan = await client.query(
          `SELECT id, name FROM wohnungen_kontakte WHERE archiviert_am IS NULL AND person_id IS NULL`,
        );
        for (const row of orphan.rows) {
          // Erstelle eine eigene Person (kein Match-Versuch um Cluster-Bug zu vermeiden)
          const p = await client.query(
            `INSERT INTO personen (name) VALUES ($1) RETURNING id`,
            [row.name || null],
          );
          await client.query('UPDATE wohnungen_kontakte SET person_id = $1 WHERE id = $2', [p.rows[0].id, row.id]);
        }
        console.log(`[personen-migration] ${linkedMitEmail.rowCount} Email-Kontakte + ${orphan.rows.length} Email-lose verknuepft`);
      }
    } catch (e) {
      console.warn('[personen-migration] uebersprungen:', e.message);
    }

    // Einmaliger Seed: wenn verwaltungen-Tabelle leer ist, statische Verwaltung
    // aus site-config.json als STWEG-uebergreifender Eintrag importieren.
    // Damit nach Deploy keine Seite ohne Verwaltungsdaten dasteht.
    try {
      const verwExists = await client.query('SELECT COUNT(*) AS cnt FROM verwaltungen');
      if (parseInt(verwExists.rows[0].cnt) === 0) {
        const candidates = [
          pathModule.join(__dirname, 'site-config.json'),
          pathModule.join(__dirname, '..', 'site-config.json'),
        ];
        let cfgRaw = null;
        for (const p of candidates) {
          try { cfgRaw = await fs.readFile(p, 'utf8'); break; } catch {}
        }
        if (!cfgRaw) {
          console.warn(`[Verwaltungen-Seed] site-config.json nicht gefunden (gesucht: ${candidates.join(', ')})`);
        } else {
          const cfg = JSON.parse(cfgRaw);
          const v = cfg.verwaltung;
          if (v && v.firma) {
            const adresse = [v.strasse, v.plz_ort].filter(Boolean).join(', ');
            await client.query(`
              INSERT INTO verwaltungen
                (stweg, firma_name, adresse, telefon, email, website, oeffnungszeiten, aktiv)
              VALUES (NULL, $1, $2, $3, $4, $5, $6, true)
            `, [v.firma, adresse || null, v.telefon || null, v.email || null, v.website || null, v.oeffnungszeiten || null]);
            console.log(`[Verwaltungen-Seed] Importiert aus site-config.json: ${v.firma}`);
          } else {
            console.warn('[Verwaltungen-Seed] site-config.json hat keine verwaltung.firma');
          }
        }
      }
    } catch (e) {
      console.warn('[Verwaltungen-Seed] Fehler:', e.message);
    }

    // Einmalige Telefon-Normalisierung (idempotent via app_config-Flag)
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(100) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`);
      const flag = await client.query("SELECT value FROM app_config WHERE key = 'phone_normalize_v1'");
      if (flag.rows.length === 0) {
        console.log('[phone-normalize] Starte einmalige Bereinigung...');
        const tables = [
          { table: 'personen', cols: ['telefon', 'mobile'] },
          { table: 'wohnungen_kontakte', cols: ['telefon', 'mobile'] },
          { table: 'handwerker', cols: ['telefon', 'mobile', 'notfall_telefon'] },
          { table: 'handwerker_personen', cols: ['telefon', 'mobile'] },
          { table: 'mail_empfaenger', cols: ['telefon'] },
          { table: 'verwaltungen', cols: ['telefon'] },
          { table: 'verwaltungs_kontakte', cols: ['telefon'] },
        ];
        let totalUpdated = 0;
        for (const { table, cols } of tables) {
          for (const col of cols) {
            try {
              const exists = await client.query(
                `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
                [table, col],
              );
              if (exists.rows.length === 0) continue;
              const rows = await client.query(`SELECT id, ${col} AS val FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> ''`);
              for (const r of rows.rows) {
                const norm = normalizePhone(r.val);
                if (norm && norm !== r.val) {
                  await client.query(`UPDATE ${table} SET ${col} = $1 WHERE id = $2`, [norm, r.id]);
                  totalUpdated++;
                }
              }
            } catch (e) { console.warn(`[phone-normalize] ${table}.${col}:`, e.message); }
          }
        }
        await client.query(`INSERT INTO app_config (key, value) VALUES ('phone_normalize_v1', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [`done ${new Date().toISOString()}, updated ${totalUpdated}`]);
        console.log(`[phone-normalize] ${totalUpdated} Telefonnummern bereinigt`);
      }
    } catch (e) {
      console.warn('[phone-normalize] Fehler:', e.message);
    }

    // V2: Misch-Strings "Mobil: X / Festnetz: Y" splitten + E-Mail-in-Tel-Felder leeren
    try {
      const flag = await client.query("SELECT value FROM app_config WHERE key = 'phone_cleanup_v2'");
      if (flag.rows.length === 0) {
        console.log('[phone-cleanup-v2] Starte Misch-String-Split + Email-Fehler-Cleanup...');
        const splitRegex = /^Mobil(?:e)?:\s*(.+?)\s*\/\s*Festnetz:\s*(.+?)\s*$/i;
        let splitOk = 0, emailFix = 0;

        // 1) personen: Misch-String → mobile + telefon
        const pRows = await client.query(
          `SELECT id, telefon FROM personen WHERE telefon ~* '^Mobil'`,
        );
        for (const r of pRows.rows) {
          const m = String(r.telefon).match(splitRegex);
          if (m) {
            await client.query(
              `UPDATE personen SET mobile = $1, telefon = $2 WHERE id = $3`,
              [normalizePhone(m[1]), normalizePhone(m[2]), r.id],
            );
            splitOk++;
          }
        }

        // wohnungen_kontakte: gleicher Split (fuer Eintraege ohne person_id; mit person_id
        // wird durch Trigger automatisch ueberschrieben sobald personen.telefon/mobile sich
        // aendert; aber falls noch nicht propagiert, sicherheitshalber direkt)
        const wkRows = await client.query(
          `SELECT id, telefon FROM wohnungen_kontakte WHERE telefon ~* '^Mobil' AND archiviert_am IS NULL`,
        );
        for (const r of wkRows.rows) {
          const m = String(r.telefon).match(splitRegex);
          if (m) {
            await client.query(
              `UPDATE wohnungen_kontakte SET mobile = $1, telefon = $2 WHERE id = $3`,
              [normalizePhone(m[1]), normalizePhone(m[2]), r.id],
            );
            splitOk++;
          }
        }

        // 2) E-Mail-in-Tel-Felder bereinigen: '@' in Tel-Spalte → leeren (in alle relevanten Tabellen)
        const emailInTelTargets = [
          { table: 'personen', cols: ['telefon', 'mobile'] },
          { table: 'wohnungen_kontakte', cols: ['telefon', 'mobile'] },
          { table: 'handwerker', cols: ['telefon', 'mobile'] },
          { table: 'handwerker_personen', cols: ['telefon', 'mobile'] },
          { table: 'mail_empfaenger', cols: ['telefon'] },
          { table: 'verwaltungen', cols: ['telefon'] },
          { table: 'verwaltungs_kontakte', cols: ['telefon'] },
        ];
        for (const { table, cols } of emailInTelTargets) {
          for (const col of cols) {
            try {
              const exists = await client.query(
                `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
                [table, col],
              );
              if (exists.rows.length === 0) continue;
              const r = await client.query(
                `UPDATE ${table} SET ${col} = NULL WHERE ${col} LIKE '%@%' AND ${col} ~ '\\..{2,}' RETURNING id`,
              );
              emailFix += r.rowCount || 0;
            } catch (e) { console.warn(`[phone-cleanup-v2] ${table}.${col}:`, e.message); }
          }
        }

        await client.query(
          `INSERT INTO app_config (key, value) VALUES ('phone_cleanup_v2', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [`done ${new Date().toISOString()}, split ${splitOk}, email-fix ${emailFix}`],
        );
        console.log(`[phone-cleanup-v2] ${splitOk} Misch-Strings gesplittet, ${emailFix} Email-in-Tel-Felder geleert`);
      }
    } catch (e) {
      console.warn('[phone-cleanup-v2] Fehler:', e.message);
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
