// Mail-Versand + Allowlist + OTP — aus server.js ausgelagert (Router-Split).
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { pool } = require('./db');

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

// ─── Mailcow-Submission (für rosenweg9.ch-Absender) ────────────────
// SMTP2GO verifiziert rosenweg9.ch NICHT (550 not verified). Mails mit Absender @rosenweg9.ch
// gehen daher über Mailcow (Auth als zev@) -> PMG -> Relay (smtp-relay), der die Domain sauber
// zustellt (per-Domain-DKIM/SRS). Antworten landen im echten Postfach zev@rosenweg9.ch.
const ZEV_SMTP_USER = process.env.ZEV_SMTP_USER || 'zev@rosenweg9.ch';
const ZEV_SMTP_PASS = process.env.ZEV_SMTP_PASS || '';
const MAILCOW_SMTP_HOST = process.env.IMAP_HOST || process.env.MAILCOW_SMTP_HOST || '';
const MAILCOW_SMTP_SERVERNAME = process.env.ZEV_IMAP_SERVERNAME || process.env.IMAP_SERVERNAME || '';
const mailcowTransporter = (ZEV_SMTP_PASS && MAILCOW_SMTP_HOST) ? nodemailer.createTransport({
  host: MAILCOW_SMTP_HOST, port: 587, secure: false, requireTLS: true,
  auth: { user: ZEV_SMTP_USER, pass: ZEV_SMTP_PASS },
  tls: MAILCOW_SMTP_SERVERNAME ? { servername: MAILCOW_SMTP_SERVERNAME } : { rejectUnauthorized: false },
}) : null;
// Transport-Auswahl nach Absender-Domain: rosenweg9.ch -> Mailcow/Relay, sonst SMTP2GO.
function pickTransporter(fromEmail) {
  if (mailcowTransporter && /@rosenweg9\.ch$/i.test(String(fromEmail || '').trim())) return mailcowTransporter;
  return transporter;
}

// External sender allowlist for all rosenweg email functions (verteiler, drucker, etc.)
// Format: comma-separated emails. Senders from VERTEILER_DOMAIN, users table, or Authentik
// are always allowed; this covers external addresses that should be trusted.
const EMAIL_ALLOWLIST = (process.env.EMAIL_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

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
    result = await pickTransporter(fromEmail).sendMail(mailOpts);
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

module.exports = {
  transporter, MAIL_FROM, SMTP2GO_API_KEY, SMTP2GO_API_URL, EMAIL_ALLOWLIST,
  generateOTP, loggedSendMail, isAllowlistedSender,
};
