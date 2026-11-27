// Mail-Versand + Allowlist + OTP — aus server.js ausgelagert (Router-Split).
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { pool } = require('./db');

const { gatewaysLesen, gatewayWaehlen, absenderSetzen, adresseZerlegen } = require('./mailgateway');

const MAIL_FROM = process.env.MAIL_FROM || 'noreply@rosenweg4303.ch';

// ─── Mailcow-Submission ────────────────────────────────────────────
// Alle Mails der API gehen über Mailcow (587, STARTTLS) -> PMG -> Relay. Bis 11/2026
// lief der Versand über SMTP2GO; dessen Login scheiterte ab 16.11.2026 (535) und
// niemand merkte es. Jede Funktion meldet sich mit ihrem eigenen Mailcow-Benutzer
// an (Gateway-User, siehe lib/mailgateway.js), der zugleich Absender ist.
const MAILCOW_SMTP_HOST = process.env.MAILCOW_SMTP_HOST || process.env.IMAP_HOST || '';
const MAILCOW_SMTP_PORT = parseInt(process.env.MAILCOW_SMTP_PORT || '587', 10);
// Zertifikatsname: Verbindung läuft per IP, geprüft wird gegen den echten Namen.
const MAILCOW_SMTP_SERVERNAME = process.env.MAILCOW_SMTP_SERVERNAME || process.env.ZEV_IMAP_SERVERNAME
  || process.env.IMAP_SERVERNAME || 'mail.rosenweg4303.ch';

function mailcowTransport(user, pass, { tlsUnsicher = false } = {}) {
  return nodemailer.createTransport({
    host: MAILCOW_SMTP_HOST, port: MAILCOW_SMTP_PORT, secure: false,
    // STARTTLS erzwingen: ohne requireTLS sendet nodemailer bei fehlendem STARTTLS-Angebot
    // (Mann in der Mitte streicht es) Zugangsdaten und Mails im Klartext.
    requireTLS: true,
    auth: { user, pass },
    // Zertifikat immer pruefen (ausdruecklich, damit NODE_TLS_REJECT_UNAUTHORIZED=0 nicht greift).
    tls: { rejectUnauthorized: !tlsUnsicher, servername: MAILCOW_SMTP_SERVERNAME },
  });
}

const GATEWAYS = gatewaysLesen();
const gatewayTransporte = new Map();
function gatewayTransport(gw) {
  if (!gatewayTransporte.has(gw.name)) gatewayTransporte.set(gw.name, mailcowTransport(gw.user, gw.pass));
  return gatewayTransporte.get(gw.name);
}
if (!MAILCOW_SMTP_HOST) console.error('[mail] ACHTUNG: MAILCOW_SMTP_HOST/IMAP_HOST fehlt — die API kann keine Mails senden.');
else if (!GATEWAYS.noreply) console.error('[mail] ACHTUNG: MAIL_NOREPLY_USER/_PASS fehlen — Systemmails ohne eigenen Gateway-User scheitern.');
console.log(`[mail] Versand über Mailcow ${MAILCOW_SMTP_HOST}:${MAILCOW_SMTP_PORT}, Gateway-User: ${Object.values(GATEWAYS).map(g => g.user).join(', ') || '(keine)'}`);

// rosenweg9.ch-Absender: über Mailcow als zev@ (echtes Postfach, Antworten landen dort).
const ZEV_SMTP_USER = process.env.ZEV_SMTP_USER || 'zev@rosenweg9.ch';
const ZEV_SMTP_PASS = process.env.ZEV_SMTP_PASS || '';
// Notausgang nur explizit wie beim ZEV-Poller (ZEV_IMAP_TLS_INSECURE=1).
const zevTransporter = (ZEV_SMTP_PASS && MAILCOW_SMTP_HOST) ? mailcowTransport(ZEV_SMTP_USER, ZEV_SMTP_PASS, {
  tlsUnsicher: process.env.ZEV_IMAP_TLS_INSECURE === '1' || process.env.ZEV_IMAP_TLS_INSECURE === 'true',
}) : null;

/**
 * Versendet eine Mail über den passenden Mailcow-Zugang (ohne Protokoll).
 * -> { result, gateway } ; gateway = Name des Gateway-Users bzw. 'zev'.
 * Wirft mit err.gateway gesetzt, damit der Aufrufer protokollieren kann.
 */
async function mailSenden(mailOpts, trigger) {
  const { address } = adresseZerlegen(mailOpts.from || MAIL_FROM);
  if (zevTransporter && /@rosenweg9\.ch$/i.test(address)) {
    try {
      return { result: await zevTransporter.sendMail(mailOpts), gateway: 'zev' };
    } catch (err) { err.gateway = 'zev'; throw err; }
  }
  const gw = gatewayWaehlen(trigger, GATEWAYS);
  if (!gw || !MAILCOW_SMTP_HOST) {
    const err = new Error(`Kein Mailcow-Gateway-User für "${trigger}" eingerichtet (MAIL_NOREPLY_USER/_PASS?)`);
    err.gateway = null;
    throw err;
  }
  const opts = absenderSetzen(mailOpts, gw, MAIL_FROM);
  try {
    return { result: await gatewayTransport(gw).sendMail(opts), gateway: gw.name };
  } catch (err) { err.gateway = gw.name; throw err; }
}

// External sender allowlist for all rosenweg email functions (verteiler, drucker, etc.)
// Format: comma-separated emails. Senders from VERTEILER_DOMAIN, users table, or Authentik
// are always allowed; this covers external addresses that should be trusted.
const EMAIL_ALLOWLIST = (process.env.EMAIL_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Wrapper um mailSenden() der jeden Versand in email_log protokolliert (inkl. Gateway-User).
// trigger ist ein kurzer Slug ('print-notification', 'otp-login', ...) zur Nachvollziehbarkeit.
async function loggedSendMail(mailOpts, trigger, extra = {}) {
  const toRaw = mailOpts.to || '';
  const toAddresses = Array.isArray(toRaw) ? toRaw.join(', ') : String(toRaw);
  const recipientsCount = (toAddresses ? toAddresses.split(',').filter(s => s.trim()).length : 0);
  const { name: fromName, address: fromEmail } = adresseZerlegen(mailOpts.from || MAIL_FROM);
  let result, error, gateway = null;
  try {
    ({ result, gateway } = await mailSenden(mailOpts, trigger));
  } catch (err) {
    error = err;
    gateway = err.gateway || null;
  }
  try {
    await pool.query(
      `INSERT INTO email_log (trigger, from_email, from_name, subject, to_addresses, recipients_count, has_attachments, status, message_id, error_message, verteiler_id, recipients_list, parent_message_id, parent_source, gateway)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
        gateway,
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

module.exports = {
  MAIL_FROM, EMAIL_ALLOWLIST,
  generateOTP, mailSenden, loggedSendMail, isAllowlistedSender,
};
