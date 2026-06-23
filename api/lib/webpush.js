// api/lib/webpush.js — Web-Push (VAPID) Opt-in-Benachrichtigungen.
// VAPID-Keys werden EINMAL generiert und in der DB gehalten (stabil ueber
// Restarts — wechselnde Keys wuerden alle bestehenden Subscriptions brechen).
// Subscriptions liegen pro user_email; abgelaufene (404/410) werden beim
// Versand automatisch entfernt.
const webpush = require('web-push');
const { pool } = require('./db');

let vapidPublicKey = null;
let ready = false;

async function initWebPush() {
  await pool.query(`CREATE TABLE IF NOT EXISTS push_vapid_keys (
    id INT PRIMARY KEY DEFAULT 1,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (id = 1))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_email TEXT,
    person_id INT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_ok_at TIMESTAMPTZ)`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_push_sub_email ON push_subscriptions(LOWER(user_email))');

  let r = await pool.query('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1');
  if (r.rows.length === 0) {
    const keys = webpush.generateVAPIDKeys();
    await pool.query(
      'INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING',
      [keys.publicKey, keys.privateKey]);
    r = await pool.query('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1');
  }
  const { public_key, private_key } = r.rows[0];
  vapidPublicKey = public_key;
  const subject = process.env.VAPID_SUBJECT || 'mailto:technik@rosenweg4303.ch';
  webpush.setVapidDetails(subject, public_key, private_key);
  ready = true;
  return vapidPublicKey;
}

function getPublicKey() { return vapidPublicKey; }
function isReady() { return ready; }

async function saveSubscription(sub, { userEmail = null, personId = null, userAgent = null } = {}) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Ungueltige Subscription');
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_email, person_id, endpoint, p256dh, auth, user_agent, last_ok_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (endpoint) DO UPDATE SET
       user_email = EXCLUDED.user_email, person_id = EXCLUDED.person_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, last_ok_at = NOW()`,
    [userEmail ? userEmail.toLowerCase() : null, personId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent]);
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// payload: { title, body, url?, tag?, icon? }
async function sendToEmails(emails, payload) {
  if (!ready || !Array.isArray(emails) || emails.length === 0) return { sent: 0 };
  const lower = [...new Set(emails.filter(Boolean).map(e => String(e).toLowerCase()))];
  if (lower.length === 0) return { sent: 0 };
  const r = await pool.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(user_email) = ANY($1)', [lower]);
  const body = JSON.stringify({
    title: payload.title || 'Rosenweg',
    body: payload.body || '',
    url: payload.url || 'https://pwa.rosenweg4303.ch/',
    tag: payload.tag, icon: payload.icon || '/icons/icon-192.png',
  });
  let sent = 0;
  await Promise.all(r.rows.map(async (row) => {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body);
      sent++;
      pool.query('UPDATE push_subscriptions SET last_ok_at = NOW() WHERE endpoint = $1', [row.endpoint]).catch(() => {});
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await removeSubscription(row.endpoint).catch(() => {});
      }
    }
  }));
  return { sent };
}

module.exports = { initWebPush, getPublicKey, isReady, saveSubscription, removeSubscription, sendToEmails };
