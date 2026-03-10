const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

const app = express();

// Raw body parser for email inbound (must be before json parser for this route)
app.use('/api/email/inbound', express.raw({ type: '*/*', limit: '25mb' }));
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
    const isAdmin = userInfo.groups?.includes('stweg3-ausschuss') || false;

    // Create/update user in DB
    const userResult = await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING id, email, name, wohnung, stweg, role`,
      [email, name, isAdmin ? 'admin' : 'bewohner']
    );
    const user = userResult.rows[0];

    // Create session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [sessionToken, user.id, new Date(Date.now() + 24 * 60 * 60 * 1000)]
    );

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
      [email.toLowerCase(), name, data.groups?.includes('stweg3-ausschuss') ? 'admin' : 'bewohner']
    );
    const user = result.rows[0];
    user.isAdmin = user.role === 'admin';
    user.user_id = user.id;
    user.auth_source = 'authentik';

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
      `SELECT s.user_id, u.name, u.email, u.role, u.wohnung, u.stweg
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (result.rows.length > 0) {
      req.user = result.rows[0];
      req.user.isAdmin = req.user.role === 'admin';
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

// Get current user from session token
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const userId = req.user.user_id || req.user.id;
  const result = await pool.query(
    'SELECT id, email, name, wohnung, stweg, role, phone, strasse, plz, ort FROM users WHERE id = $1',
    [userId]
  );
  const u = result.rows[0] || req.user;
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
      isAdmin: u.role === 'admin',
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

app.get('/api/users/:id/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed') as total_sessions,
         COALESCE(SUM(energy_consumed) FILTER (WHERE status = 'completed'), 0) as total_energy,
         COALESCE(SUM(cost) FILTER (WHERE status = 'completed'), 0) as total_cost,
         COUNT(*) FILTER (WHERE status = 'active') as active_sessions
       FROM wasch_sessions WHERE user_id = $1`,
      [req.params.id]
    );
    const user = await pool.query('SELECT balance FROM users WHERE id = $1', [req.params.id]);
    res.json({
      ...stats.rows[0],
      balance: user.rows[0]?.balance || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.get('/api/users/:id/transactions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wasch_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - DEVICES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wasch_devices WHERE active = true ORDER BY location, device_name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.post('/api/devices/:id/control', authMiddleware, async (req, res) => {
  const { action } = req.body; // 'on' or 'off'
  try {
    const device = await pool.query('SELECT * FROM wasch_devices WHERE id = $1', [req.params.id]);
    if (device.rows.length === 0) return res.status(404).json({ error: 'Gerät nicht gefunden' });

    const d = device.rows[0];
    if (!d.shelly_ip) return res.status(400).json({ error: 'Keine Shelly-IP konfiguriert' });

    // Call Shelly API
    const shellyUrl = `http://${d.shelly_ip}/rpc/Switch.Set?id=0&on=${action === 'on'}`;
    const response = await fetch(shellyUrl, { signal: AbortSignal.timeout(5000) });
    const result = await response.json();

    res.json({ success: true, result });
  } catch (err) {
    console.error('Device control error:', err);
    res.status(500).json({ error: 'Fehler bei Gerätesteuerung' });
  }
});

app.get('/api/devices/:id/status', authMiddleware, async (req, res) => {
  try {
    const device = await pool.query('SELECT * FROM wasch_devices WHERE id = $1', [req.params.id]);
    if (device.rows.length === 0) return res.status(404).json({ error: 'Gerät nicht gefunden' });

    const d = device.rows[0];
    if (!d.shelly_ip) return res.json({ available: false });

    const response = await fetch(`http://${d.shelly_ip}/rpc/Switch.GetStatus?id=0`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();

    res.json({
      available: true,
      power: data.apower || 0,
      voltage: data.voltage || 0,
      current: data.current || 0,
      totalEnergy: (data.aenergy?.total || 0) / 1000,
      isOn: data.output || false,
    });
  } catch (err) {
    res.json({ available: false });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - SESSIONS
// ═══════════════════════════════════════════════════════════════════

app.post('/api/sessions/start', authMiddleware, async (req, res) => {
  const { device_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO wasch_sessions (user_id, device_id, status, started_at)
       VALUES ($1, $2, 'active', NOW()) RETURNING *`,
      [req.user.user_id, device_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.get('/api/sessions/user/:userId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, d.device_name, d.location
       FROM wasch_sessions s
       JOIN wasch_devices d ON d.id = s.device_id
       WHERE s.user_id = $1
       ORDER BY s.started_at DESC LIMIT 20`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WASCHKÜCHE - RESERVIERUNGEN
// ═══════════════════════════════════════════════════════════════════

app.get('/api/reservations', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name as user_name, d.device_name
       FROM wasch_reservations r
       JOIN users u ON u.id = r.user_id
       JOIN wasch_devices d ON d.id = r.device_id
       WHERE r.date >= CURRENT_DATE
       ORDER BY r.date, r.time_slot`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.post('/api/reservations', authMiddleware, async (req, res) => {
  const { device_id, date, time_slot } = req.body;
  try {
    // Check for conflicts
    const conflict = await pool.query(
      `SELECT id FROM wasch_reservations
       WHERE device_id = $1 AND date = $2 AND time_slot = $3 AND cancelled = false`,
      [device_id, date, time_slot]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: 'Zeitslot bereits reserviert' });
    }

    const result = await pool.query(
      `INSERT INTO wasch_reservations (user_id, device_id, date, time_slot)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.user_id, device_id, date, time_slot]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

app.delete('/api/reservations/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE wasch_reservations SET cancelled = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
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

app.get('/api/verteiler/:stweg', authMiddleware, async (req, res) => {
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
    for (const to of recipients) {
      await transporter.sendMail({
        from: MAIL_FROM,
        to,
        subject,
        html: body,
      });
      sent++;
    }
    res.json({ success: true, sent });
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
// SMS INBOX (Peoplefon SMS GW API)
// Base: https://api.peoplefone.com/customer/sms
// ═══════════════════════════════════════════════════════════════════

const PEOPLEFON_API_URL = process.env.PEOPLEFON_API_URL || 'https://api.peoplefone.com/customer/sms';
const PEOPLEFON_API_KEY = process.env.PEOPLEFON_API_KEY || '';
const PEOPLEFON_NUMBER = process.env.PEOPLEFON_NUMBER || '+41615510152';

async function peoplefonRequest(method, path, body) {
  const url = `${PEOPLEFON_API_URL}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${PEOPLEFON_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Peoplefon API ${resp.status}: ${text}`);
  }
  if (!text || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Peoplefon API invalid JSON: ${text.substring(0, 200)}`);
  }
}

// SMS webhook handler (shared between /incoming and /status)
async function handleSmsWebhook(body) {
  // SmsMessageEvent: eventType, status, text, to, from, messageId, binary, validityPeriod
  // SmsStatusUpdateEvent: eventType, messageId, status, direction, updatedAt, to, from
  console.log('SMS webhook received:', JSON.stringify(body));

  if (body.eventType === 'smsStatusUpdateEvent') {
    // Status update for a sent message - update existing record
    if (body.messageId) {
      await pool.query(
        `UPDATE sms_inbox SET status = $1 WHERE message_id = $2`,
        [body.status, body.messageId]
      );
    }
  } else {
    // Incoming SMS (SmsMessageEvent or unknown format)
    const messageId = body.messageId || null;
    const sender = body.from || body.From || 'unknown';
    const recipient = body.to || body.To || PEOPLEFON_NUMBER;
    const message = body.text || body.Body || body.message || '';
    const status = body.status || 'received';

    await pool.query(
      `INSERT INTO sms_inbox (message_id, direction, sender, recipient, message, status, received_at)
       VALUES ($1, 'MO', $2, $3, $4, $5, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, sender, recipient, message, status]
    );
  }
}

// Webhook endpoint - receives SmsMessageEvent from Peoplefon (incoming SMS)
app.post('/api/sms/incoming', async (req, res) => {
  try {
    await handleSmsWebhook(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('SMS webhook error:', err);
    res.status(500).json({ error: 'Fehler beim Verarbeiten der SMS' });
  }
});

// Status callback endpoint (configured in Peoplefon portal)
app.post('/api/sms/status', async (req, res) => {
  try {
    await handleSmsWebhook(req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('SMS status webhook error:', err);
    res.status(500).json({ error: 'Fehler beim Verarbeiten des Status' });
  }
});

// Fetch SMS from Peoplefon API and sync to local DB (admin only)
app.post('/api/sms/fetch', authMiddleware, adminOnly, async (req, res) => {
  if (!PEOPLEFON_API_KEY) {
    return res.status(400).json({ error: 'Peoplefon API-Key nicht konfiguriert' });
  }
  try {
    const data = await peoplefonRequest('GET', '/v1/sms/messages?pageSize=50');
    let imported = 0;
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        const direction = msg.direction || (msg.to === PEOPLEFON_NUMBER ? 'MO' : 'MT');
        const sender = direction === 'MO' ? msg.from : (msg.from || PEOPLEFON_NUMBER);
        const recipient = direction === 'MO' ? PEOPLEFON_NUMBER : msg.to;
        let text = msg.text || '';
        if (!text && msg.messageId) {
          try {
            const details = await peoplefonRequest('GET', `/v1/sms/messages/${msg.messageId}`);
            text = details.text || '';
          } catch {}
        }
        const result = await pool.query(
          `INSERT INTO sms_inbox (message_id, direction, sender, recipient, message, status, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()))
           ON CONFLICT (message_id) DO UPDATE SET status = EXCLUDED.status, message = CASE WHEN sms_inbox.message = '' OR sms_inbox.message IS NULL THEN EXCLUDED.message ELSE sms_inbox.message END
           RETURNING id`,
          [msg.messageId, direction, sender, recipient, text, msg.status || 'unknown', msg.receivedAt || msg.sentAt || null]
        );
        if (result.rows.length > 0) imported++;
      }
    }
    res.json({ success: true, imported, total: data.totalElements || 0 });
  } catch (err) {
    console.error('SMS fetch error:', err);
    res.status(500).json({ error: `Peoplefon-Abruf fehlgeschlagen: ${err.message}` });
  }
});

// Send SMS via Peoplefon (admin only)
app.post('/api/sms/send', authMiddleware, adminOnly, async (req, res) => {
  if (!PEOPLEFON_API_KEY) {
    return res.status(400).json({ error: 'Peoplefon API-Key nicht konfiguriert' });
  }
  const { to, text } = req.body;
  if (!to || !text) {
    return res.status(400).json({ error: 'Empfänger und Text erforderlich' });
  }
  try {
    const result = await peoplefonRequest('POST', '/v1/sms/messages', {
      to: Array.isArray(to) ? to : [to],
      text
    });
    // Store sent messages locally
    const messages = result.messages || [result];
    for (const msg of messages) {
      await pool.query(
        `INSERT INTO sms_inbox (message_id, direction, sender, recipient, message, status, received_at)
         VALUES ($1, 'MT', $2, $3, $4, $5, COALESCE($6::timestamp, NOW()))
         ON CONFLICT (message_id) DO NOTHING`,
        [msg.messageId, PEOPLEFON_NUMBER, msg.to || to, text, msg.status || 'sent', msg.receivedAt || null]
      );
    }
    res.json({ success: true, messageId: messages[0]?.messageId });
  } catch (err) {
    console.error('SMS send error:', err);
    res.status(500).json({ error: `SMS-Versand fehlgeschlagen: ${err.message}` });
  }
});

// Get received SMS (admin only)
app.get('/api/sms/inbox', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sms_inbox ORDER BY received_at DESC LIMIT 50'
    );
    res.json({ messages: result.rows, number: PEOPLEFON_NUMBER });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der SMS' });
  }
});

// Mark SMS as read
app.patch('/api/sms/inbox/:id/read', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE sms_inbox SET read = true WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Delete SMS
app.delete('/api/sms/inbox/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM sms_inbox WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EMAIL VERTEILERLISTEN (Cloudflare Worker → API → SMTP2GO)
// ═══════════════════════════════════════════════════════════════════

const EMAIL_INBOUND_SECRET = process.env.EMAIL_INBOUND_SECRET || 'rosenweg-email-2026';

// Inbound email webhook - receives raw email from Cloudflare Worker
app.post('/api/email/inbound', async (req, res) => {
  // Verify secret
  const secret = req.headers['x-email-secret'] || req.query.secret;
  if (secret !== EMAIL_INBOUND_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const rawEmail = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const parsed = await simpleParser(rawEmail);

    const toAddress = parsed.to?.value?.[0]?.address?.toLowerCase();
    if (!toAddress) {
      return res.status(400).json({ error: 'No recipient found' });
    }

    console.log(`Email inbound: ${parsed.from?.text} → ${toAddress} | Subject: ${parsed.subject}`);

    // Look up verteiler
    const verteiler = await pool.query(
      'SELECT * FROM email_verteiler WHERE email_address = $1 AND active = true',
      [toAddress]
    );

    if (verteiler.rows.length === 0) {
      console.log(`No verteiler found for ${toAddress}, dropping`);
      return res.json({ success: true, action: 'dropped', reason: 'no verteiler' });
    }

    const list = verteiler.rows[0];
    const members = list.members || [];
    const senderEmail = parsed.from?.value?.[0]?.address || '';
    const senderName = parsed.from?.value?.[0]?.name || senderEmail;

    // Filter: don't send back to original sender
    const recipients = members
      .map(m => m.email)
      .filter(e => e && e !== senderEmail && !e.endsWith('.invalid'));

    if (recipients.length === 0) {
      return res.json({ success: true, action: 'dropped', reason: 'no valid recipients' });
    }

    // Build forwarded email
    const subjectPrefix = list.subject_prefix || `[${list.name}]`;
    const subject = parsed.subject?.startsWith(subjectPrefix)
      ? parsed.subject
      : `${subjectPrefix} ${parsed.subject || '(kein Betreff)'}`;

    // Determine reply-to based on verteiler config
    let replyTo;
    if (list.reply_to === 'list') {
      replyTo = toAddress; // Reply goes back to the list
    } else if (list.reply_to === 'sender') {
      replyTo = senderEmail; // Reply goes to original sender
    } else {
      replyTo = list.reply_to || senderEmail; // Custom or default to sender
    }

    // Prepare attachments from parsed email
    const attachments = (parsed.attachments || []).map(att => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType,
      cid: att.cid || undefined,
    }));

    // Send to all recipients
    const mailOptions = {
      from: `"${senderName} via ${list.name}" <${MAIL_FROM}>`,
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
    };

    await transporter.sendMail(mailOptions);
    console.log(`Distributed email to ${recipients.length} recipients for ${toAddress}`);

    // Log to DB
    await pool.query(
      `INSERT INTO email_log (verteiler_id, from_email, from_name, subject, recipients_count, has_attachments)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [list.id, senderEmail, senderName, parsed.subject, recipients.length, attachments.length > 0]
    );

    res.json({ success: true, action: 'distributed', recipients: recipients.length });
  } catch (err) {
    console.error('Email inbound error:', err);
    res.status(500).json({ error: `Email-Verarbeitung fehlgeschlagen: ${err.message}` });
  }
});

// ─── Verteiler CRUD (admin only) ────────────────────────────────────

// List all Verteiler
app.get('/api/verteiler', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, stweg, name, email_address, members, active,
              reply_to, subject_prefix, created_at,
              jsonb_array_length(members) as member_count
       FROM email_verteiler ORDER BY stweg, name`
    );
    res.json({ verteiler: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Verteiler' });
  }
});

// Get single Verteiler
app.get('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM email_verteiler WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// Create Verteiler
app.post('/api/verteiler', authMiddleware, adminOnly, async (req, res) => {
  const { stweg, name, email_address, members, reply_to, subject_prefix } = req.body;
  if (!name || !email_address) return res.status(400).json({ error: 'Name und Email-Adresse erforderlich' });
  try {
    const result = await pool.query(
      `INSERT INTO email_verteiler (stweg, name, email_address, members, reply_to, subject_prefix)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [stweg || 0, name, email_address, JSON.stringify(members || []), reply_to || 'sender', subject_prefix || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email-Adresse existiert bereits' });
    res.status(500).json({ error: 'Fehler beim Erstellen' });
  }
});

// Update Verteiler
app.put('/api/verteiler/:id', authMiddleware, adminOnly, async (req, res) => {
  const { stweg, name, email_address, members, active, reply_to, subject_prefix } = req.body;
  try {
    const result = await pool.query(
      `UPDATE email_verteiler SET stweg=$1, name=$2, email_address=$3, members=$4, active=$5,
              reply_to=$6, subject_prefix=$7
       WHERE id=$8 RETURNING *`,
      [stweg, name, email_address, JSON.stringify(members || []), active !== false, reply_to || 'sender', subject_prefix || null, req.params.id]
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
    const result = await pool.query(
      `SELECT l.*, v.name as verteiler_name FROM email_log l
       LEFT JOIN email_verteiler v ON v.id = l.verteiler_id
       ORDER BY l.created_at DESC LIMIT 50`
    );
    res.json({ log: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Fehler' });
  }
});

// ─── SMS Auto-Fetch (poll Peoplefon every 60s) ─────────────────────
let smsFetchInterval = null;

async function autoFetchSms() {
  if (!PEOPLEFON_API_KEY) return;
  try {
    const data = await peoplefonRequest('GET', '/v1/sms/messages?pageSize=50');
    if (data.messages && data.messages.length > 0) {
      for (const msg of data.messages) {
        // Determine direction: if 'to' matches our number, it's incoming (MO), otherwise outgoing (MT)
        const direction = msg.direction || (msg.to === PEOPLEFON_NUMBER ? 'MO' : 'MT');
        const sender = direction === 'MO' ? msg.from : (msg.from || PEOPLEFON_NUMBER);
        const recipient = direction === 'MO' ? PEOPLEFON_NUMBER : msg.to;
        // Fetch full message details if text is missing
        let text = msg.text || '';
        if (!text && msg.messageId) {
          try {
            const details = await peoplefonRequest('GET', `/v1/sms/messages/${msg.messageId}`);
            text = details.text || '';
          } catch {}
        }
        await pool.query(
          `INSERT INTO sms_inbox (message_id, direction, sender, recipient, message, status, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()))
           ON CONFLICT (message_id) DO UPDATE SET status = EXCLUDED.status, message = CASE WHEN sms_inbox.message = '' OR sms_inbox.message IS NULL THEN EXCLUDED.message ELSE sms_inbox.message END`,
          [msg.messageId, direction, sender, recipient, text, msg.status || 'unknown', msg.receivedAt || msg.sentAt || null]
        );
      }
    }
  } catch (err) {
    console.error('SMS auto-fetch error:', err.message);
  }
}

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

      CREATE TABLE IF NOT EXISTS wasch_devices (
        id SERIAL PRIMARY KEY,
        device_name VARCHAR(255) NOT NULL,
        device_type VARCHAR(100),
        location VARCHAR(255),
        shelly_ip VARCHAR(45),
        shelly_id VARCHAR(100),
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wasch_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        device_id INTEGER REFERENCES wasch_devices(id),
        status VARCHAR(50) DEFAULT 'active',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        energy_consumed DECIMAL(10,4),
        cost DECIMAL(10,2)
      );

      CREATE TABLE IF NOT EXISTS wasch_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(10,2) NOT NULL,
        type VARCHAR(50) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wasch_reservations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        device_id INTEGER REFERENCES wasch_devices(id),
        date DATE NOT NULL,
        time_slot VARCHAR(20) NOT NULL,
        cancelled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
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

      CREATE TABLE IF NOT EXISTS sms_inbox (
        id SERIAL PRIMARY KEY,
        message_id VARCHAR(255) UNIQUE,
        direction VARCHAR(10) DEFAULT 'MO',
        sender VARCHAR(50),
        recipient VARCHAR(50),
        message TEXT,
        status VARCHAR(50),
        received_at TIMESTAMP DEFAULT NOW(),
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

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

      -- Migrate email_verteiler if missing new columns
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS reply_to VARCHAR(255) DEFAULT 'sender';
      ALTER TABLE email_verteiler ADD COLUMN IF NOT EXISTS subject_prefix VARCHAR(100);

      -- Migrate existing sms_inbox if missing new columns
      ALTER TABLE sms_inbox ADD COLUMN IF NOT EXISTS message_id VARCHAR(255) UNIQUE;
      ALTER TABLE sms_inbox ADD COLUMN IF NOT EXISTS direction VARCHAR(10) DEFAULT 'MO';
      ALTER TABLE sms_inbox ADD COLUMN IF NOT EXISTS status VARCHAR(50);
    `);
    console.log('Database schema initialized');
  } finally {
    client.release();
  }
}

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Rosenweg API running on port ${PORT}`);
      // Start SMS auto-fetch every 60 seconds
      if (PEOPLEFON_API_KEY) {
        autoFetchSms(); // initial fetch
        smsFetchInterval = setInterval(autoFetchSms, 60 * 1000);
        console.log('SMS auto-fetch enabled (60s interval)');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
