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

// Der Server schickt an den endpoint einen POST — ohne Pruefung waere das eine
// SSRF-Quelle (interne Adressen). Darum nur https auf Port 443 zu den bekannten
// Push-Diensten der Browser zulassen.
const PUSH_HOSTS_EXAKT = new Set([
  'fcm.googleapis.com', 'android.googleapis.com',                 // Chrome, Android, Opera, Samsung
  'updates.push.services.mozilla.com', 'push.services.mozilla.com', // Firefox
  'web.push.apple.com',                                            // Safari / iOS
]);
const PUSH_HOSTS_SUFFIX = ['.push.apple.com', '.notify.windows.com']; // Apple-Regionen, Edge (WNS)
function endpointErlaubt(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS_EXAKT.has(h) || PUSH_HOSTS_SUFFIX.some(s => h.endsWith(s));
}
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

async function saveSubscription(sub, { userEmail = null, personId = null, userAgent = null } = {}) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('Ungueltige Subscription');
  }
  if (!endpointErlaubt(sub.endpoint)) throw new Error('Push-Dienst nicht erlaubt');
  if (typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string'
      || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100
      || !B64URL.test(sub.keys.p256dh) || !B64URL.test(sub.keys.auth)) {
    throw new Error('Ungueltige Subscription');
  }
  // Fremde Subscription nicht uebernehmen: ein bestehender endpoint wird nur fuer
  // denselben Benutzer aktualisiert (sonst liefe dessen Push zum Angreifer-Konto).
  // Ausnahme: gleiche p256dh+auth = dasselbe Geraet (Kontowechsel im selben
  // Browser); diese Schluessel kennt nur der Browser, nicht ein Dritter.
  const r = await pool.query(
    `INSERT INTO push_subscriptions (user_email, person_id, endpoint, p256dh, auth, user_agent, last_ok_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (endpoint) DO UPDATE SET
       user_email = EXCLUDED.user_email, person_id = EXCLUDED.person_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, last_ok_at = NOW()
     WHERE LOWER(COALESCE(push_subscriptions.user_email, '')) = LOWER(COALESCE(EXCLUDED.user_email, ''))
        OR (push_subscriptions.p256dh = EXCLUDED.p256dh AND push_subscriptions.auth = EXCLUDED.auth)`,
    [userEmail ? userEmail.toLowerCase() : null, personId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent]);
  if (r.rowCount === 0) throw new Error('Subscription gehoert einem anderen Konto');
}

// userEmail gesetzt: nur eigene Subscription loeschen (API-Aufruf durch Nutzer).
async function removeSubscription(endpoint, userEmail) {
  if (!endpoint) return;
  if (userEmail !== undefined) {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND LOWER(user_email) = LOWER($2)', [endpoint, String(userEmail || '')]);
    return;
  }
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
    // Altbestand vor der Endpoint-Pruefung: nicht erlaubte Ziele nie anfragen.
    if (!endpointErlaubt(row.endpoint)) return;
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { timeout: 10000 });
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
