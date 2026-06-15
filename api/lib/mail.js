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

module.exports = {
  transporter, MAIL_FROM, SMTP2GO_API_KEY, SMTP2GO_API_URL, EMAIL_ALLOWLIST,
  generateOTP, loggedSendMail, isAllowlistedSender,
};
