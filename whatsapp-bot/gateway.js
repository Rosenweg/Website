// ─────────────────────────────────────────────────────────────────────────
// Messaging-Gateway — eigenstaendiger API-Server IM whatsapp-bot-Container.
//
// Zwei Eingaenge -> WhatsApp:
//   1. Keyed JSON-API  (POST /gateway/send, Named API-Key im Header)
//   2. E-Mail->WhatsApp (eigener SMTP-Server; Empfaenger-Adresse = WhatsApp-Ziel)
// Plus Web-UI (whatsapp.rosenweg4303.ch) mit Authentik-Login (Reverse-Proxy auf
// die Haupt-API) zum Senden/Lesen/Loggen + Key-/Alias-Verwaltung.
//
// Self-contained: eigene SQLite (/data/gateway.sqlite), KEIN Postgres. Versendet
// KEINE E-Mails (nur Empfang->WhatsApp). Rosenweg-Spezifika nur via ENV.
// ─────────────────────────────────────────────────────────────────────────
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { createProxyMiddleware } = require('http-proxy-middleware');

const DATA_DIR        = process.env.WA_DATA_DIR || '/data';
const GATEWAY_PORT     = parseInt(process.env.WA_GATEWAY_PORT, 10) || 8090;
const SMTP_PORT        = parseInt(process.env.GW_SMTP_PORT, 10) || 2525;
const SMTP_USER        = process.env.GW_SMTP_USER || '';
const SMTP_PASS        = process.env.GW_SMTP_PASS || '';
const MAIN_API_BASE    = process.env.MAIN_API_BASE || process.env.API_BASE || '';
const PUBLIC_HOST      = process.env.GW_PUBLIC_HOST || 'whatsapp.rosenweg4303.ch';
const MAX_BODY         = process.env.GW_MAX_BODY || '25mb';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function startGateway(botCore) {
  // botCore: { isReady(), sendViaClient(chatId,body,atts), revokeByMsgId(id),
  //            findGroupByName(name), getGroups() }
  const db = new Database(path.join(DATA_DIR, 'gateway.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes TEXT DEFAULT '*',
      created_by TEXT,
      created_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS aliases (
      address TEXT PRIMARY KEY,           -- lowercased Adresse/Local-Part, z.B. 'technik'
      target TEXT NOT NULL,               -- Nummer | Gruppenname | JID
      target_kind TEXT NOT NULL,          -- 'number' | 'group' | 'jid'
      note TEXT,
      created_by TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,            -- 'outbound' | 'inbound'
      source TEXT,                        -- 'api-key' | 'smtp-email' | 'web-ui' | 'inbound'
      sender TEXT,                        -- Key-Name | Mail-From | User-Email
      target TEXT,
      target_kind TEXT,
      subject TEXT,
      body TEXT,
      attachments_json TEXT DEFAULT '[]',
      whatsapp_msg_id TEXT,
      status TEXT,                        -- 'sent' | 'failed' | 'received'
      error TEXT,
      created_at TEXT,
      sent_at TEXT,
      deleted_at TEXT,
      delete_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_dir ON messages(direction, id DESC);
  `);

  const q = {
    keyByHash: db.prepare(`SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL`),
    keyTouch: db.prepare(`UPDATE api_keys SET last_used_at=? WHERE id=?`),
    keyInsert: db.prepare(`INSERT INTO api_keys (name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?)`),
    keyList: db.prepare(`SELECT id,name,key_prefix,scopes,created_by,created_at,revoked_at,last_used_at FROM api_keys ORDER BY id DESC`),
    keyRevoke: db.prepare(`UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL`),
    aliasGet: db.prepare(`SELECT * FROM aliases WHERE address=?`),
    aliasList: db.prepare(`SELECT * FROM aliases ORDER BY address`),
    aliasUpsert: db.prepare(`INSERT INTO aliases (address,target,target_kind,note,created_by,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET target=excluded.target,
      target_kind=excluded.target_kind, note=excluded.note`),
    aliasDel: db.prepare(`DELETE FROM aliases WHERE address=?`),
    msgInsert: db.prepare(`INSERT INTO messages
      (direction,source,sender,target,target_kind,subject,body,attachments_json,whatsapp_msg_id,status,error,created_at,sent_at)
      VALUES (@direction,@source,@sender,@target,@target_kind,@subject,@body,@attachments_json,@whatsapp_msg_id,@status,@error,@created_at,@sent_at)`),
    msgList: db.prepare(`SELECT id,direction,source,sender,target,target_kind,subject,body,
      whatsapp_msg_id,status,error,created_at,sent_at,deleted_at,delete_error
      FROM messages WHERE (@direction IS NULL OR direction=@direction) ORDER BY id DESC LIMIT @limit`),
    msgGet: db.prepare(`SELECT * FROM messages WHERE id=?`),
    msgDeleted: db.prepare(`UPDATE messages SET deleted_at=?, delete_error=NULL WHERE id=?`),
    msgDeleteErr: db.prepare(`UPDATE messages SET delete_error=? WHERE id=?`),
  };

  // ── Ziel-Aufloesung (gemeinsam fuer JSON-API + SMTP-in) ──────────────────
  // Reihenfolge: Alias > JID > Nummer > Gruppenname.
  async function resolveTarget(to) {
    const raw = String(to || '').trim();
    if (!raw) throw new Error('Leeres Ziel');
    const alias = q.aliasGet.get(raw.toLowerCase());
    if (alias) {
      if (alias.target_kind === 'jid') return { chatId: alias.target, kind: 'jid', label: raw };
      if (alias.target_kind === 'number') return { chatId: alias.target.replace(/\D/g, '') + '@c.us', kind: 'number', label: raw };
      if (alias.target_kind === 'group') return { chatId: await botCore.findGroupByName(alias.target), kind: 'group', label: alias.target };
    }
    if (/@(c\.us|g\.us|lid)$/.test(raw)) return { chatId: raw, kind: 'jid', label: raw };
    // Nummer (auch mit Leerzeichen/Trennern formatiert)
    const cleaned = raw.replace(/[\s()\-./]/g, '');
    if (/^\+?\d{6,15}$/.test(cleaned)) return { chatId: cleaned.replace(/\D/g, '') + '@c.us', kind: 'number', label: raw };
    // sonst: Gruppenname (exakter Titel-Match)
    return { chatId: await botCore.findGroupByName(raw), kind: 'group', label: raw };
  }

  // ── Senden + Loggen (gemeinsam) ──────────────────────────────────────────
  async function sendAndLog({ source, sender, to, title, body, attachments }) {
    const text = title ? `*${title}*\n\n${body || ''}`.trim() : (body || '');
    let target = null, target_kind = null;
    const base = {
      direction: 'outbound', source, sender: sender || null,
      subject: title || null, body: body || null,
      attachments_json: JSON.stringify((attachments || []).map(a => ({
        filename: a.filename, mimetype: a.mimetype, size: (a.data_base64 || a.content_base64 || '').length,
      }))),
      whatsapp_msg_id: null, created_at: nowIso(), sent_at: null,
    };
    try {
      const resolved = await resolveTarget(to);
      target = resolved.chatId; target_kind = resolved.kind;
      if (!botCore.isReady()) { const e = new Error('WhatsApp nicht bereit'); e.notReady = true; throw e; }
      const { msgId } = await botCore.sendViaClient(resolved.chatId, text, attachments || []);
      const info = q.msgInsert.run({ ...base, target, target_kind, whatsapp_msg_id: msgId, status: 'sent', error: null, sent_at: nowIso() });
      return { id: info.lastInsertRowid, status: 'sent', target, whatsapp_msg_id: msgId };
    } catch (err) {
      q.msgInsert.run({ ...base, target, target_kind, status: 'failed', error: String(err.message || err).slice(0, 500) });
      throw err;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // HTTP / Express
  // ════════════════════════════════════════════════════════════════════════
  const app = express();
  app.disable('x-powered-by');

  // 1) Reverse-Proxy fuer /api/* -> Haupt-API (Authentik-Login + /api/me).
  //    MUSS vor express.json() stehen, sonst wird der Body konsumiert.
  if (MAIN_API_BASE) {
    app.use('/api', createProxyMiddleware({
      target: MAIN_API_BASE,
      changeOrigin: true,
      xfwd: true,
      onProxyReq: (proxyReq) => {
        proxyReq.setHeader('X-Forwarded-Host', PUBLIC_HOST);
        proxyReq.setHeader('X-Forwarded-Proto', 'https');
      },
    }));
  }

  const jsonBody = express.json({ limit: MAX_BODY });

  // ── Auth: Named API-Key (Maschinen) ──────────────────────────────────────
  function keyAuth(req, res, next) {
    let key = req.headers['x-messaging-key'] || '';
    const auth = req.headers.authorization || '';
    if (!key && auth.startsWith('Bearer mg_')) key = auth.slice(7);
    if (!key || !key.startsWith('mg_')) return res.status(401).json({ error: 'API-Key fehlt' });
    const row = q.keyByHash.get(sha256(key));
    if (!row) return res.status(401).json({ error: 'API-Key ungueltig oder widerrufen' });
    const scopes = String(row.scopes || '*').split(',').map(s => s.trim());
    if (!(scopes.includes('*') || scopes.includes('whatsapp'))) {
      return res.status(403).json({ error: 'Key hat keinen whatsapp-Scope' });
    }
    q.keyTouch.run(nowIso(), row.id);
    req.apiKey = { id: row.id, name: row.name };
    next();
  }

  // ── Auth: Web-UI via Bearer -> Haupt-API /api/me -> Technik/Präsident ─────
  async function uiAuth(req, res, next) {
    if (!MAIN_API_BASE) return res.status(503).json({ error: 'UI-Auth nicht konfiguriert (MAIN_API_BASE fehlt)' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Login erforderlich' });
    try {
      const r = await fetch(`${MAIN_API_BASE}/api/me`, { headers: { Authorization: auth } });
      if (!r.ok) return res.status(401).json({ error: 'Ungueltige Session' });
      const me = await r.json();
      const groups = (me.groups || []).map(g => String(g).toLowerCase());
      const ok = me.is_admin || groups.includes('technik') || groups.includes('präsident') || groups.includes('praesident');
      if (!ok) return res.status(403).json({ error: 'Nur Technik/Präsident' });
      req.uiUser = me;
      next();
    } catch (e) {
      return res.status(502).json({ error: 'Auth-Backend nicht erreichbar' });
    }
  }

  // ── Maschinen-API: keyed Send ────────────────────────────────────────────
  app.post('/gateway/send', jsonBody, keyAuth, async (req, res) => {
    const { channel = 'whatsapp', to, title, body, attachments } = req.body || {};
    if (channel !== 'whatsapp') return res.status(400).json({ error: "channel muss 'whatsapp' sein" });
    if (!to) return res.status(400).json({ error: 'to fehlt' });
    if (!body && !(attachments && attachments.length)) return res.status(400).json({ error: 'body oder attachments erforderlich' });
    try {
      const out = await sendAndLog({ source: 'api-key', sender: req.apiKey.name, to, title, body, attachments });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(err.notReady ? 503 : 422).json({ error: err.message });
    }
  });

  // ── Web-UI-Endpoints ─────────────────────────────────────────────────────
  app.get('/gateway/ui/whoami', uiAuth, (req, res) => res.json({ email: req.uiUser.email, name: req.uiUser.name }));

  app.post('/gateway/ui/send', jsonBody, uiAuth, async (req, res) => {
    const { to, title, body, attachments } = req.body || {};
    if (!to) return res.status(400).json({ error: 'to fehlt' });
    if (!body && !(attachments && attachments.length)) return res.status(400).json({ error: 'body oder attachments erforderlich' });
    try {
      const out = await sendAndLog({ source: 'web-ui', sender: req.uiUser.email, to, title, body, attachments });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(err.notReady ? 503 : 422).json({ error: err.message });
    }
  });

  app.get('/gateway/ui/messages', uiAuth, (req, res) => {
    const direction = req.query.direction === 'inbound' || req.query.direction === 'outbound' ? req.query.direction : null;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    res.json({ messages: q.msgList.all({ direction, limit }) });
  });

  app.post('/gateway/ui/messages/:id/delete', uiAuth, async (req, res) => {
    const row = q.msgGet.get(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'Nicht gefunden' });
    if (row.deleted_at) return res.status(409).json({ error: 'Bereits geloescht' });
    if (!row.whatsapp_msg_id) return res.status(422).json({ error: 'Keine WhatsApp-Message-ID — nicht loeschbar' });
    try {
      await botCore.revokeByMsgId(row.whatsapp_msg_id);
      q.msgDeleted.run(nowIso(), row.id);
      res.json({ ok: true });
    } catch (err) {
      q.msgDeleteErr.run(String(err.message || err).slice(0, 500), row.id);
      res.status(422).json({ error: err.message });
    }
  });

  app.get('/gateway/ui/groups', uiAuth, async (req, res) => {
    if (!botCore.isReady()) return res.status(503).json({ error: 'WhatsApp nicht bereit', groups: [] });
    try { res.json({ groups: await botCore.getGroups() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Keys
  app.get('/gateway/ui/keys', uiAuth, (req, res) => res.json({ keys: q.keyList.all() }));
  app.post('/gateway/ui/keys', jsonBody, uiAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name erforderlich' });
    const scopes = String(req.body?.scopes || '*').trim() || '*';
    const plain = 'mg_' + crypto.randomBytes(32).toString('hex');
    q.keyInsert.run(name, sha256(plain), plain.slice(0, 11), scopes, req.uiUser.email, nowIso());
    res.json({ ok: true, key: plain, note: 'Key nur jetzt sichtbar — sicher speichern.' });
  });
  app.delete('/gateway/ui/keys/:id', uiAuth, (req, res) => {
    const info = q.keyRevoke.run(nowIso(), parseInt(req.params.id, 10));
    res.json({ ok: info.changes > 0 });
  });

  // Aliases
  app.get('/gateway/ui/aliases', uiAuth, (req, res) => res.json({ aliases: q.aliasList.all() }));
  app.post('/gateway/ui/aliases', jsonBody, uiAuth, (req, res) => {
    const address = String(req.body?.address || '').trim().toLowerCase();
    const target = String(req.body?.target || '').trim();
    const kind = String(req.body?.target_kind || '').trim();
    if (!address || !target || !['number', 'group', 'jid'].includes(kind)) {
      return res.status(400).json({ error: 'address, target, target_kind (number|group|jid) erforderlich' });
    }
    q.aliasUpsert.run(address, target, kind, req.body?.note || null, req.uiUser.email, nowIso());
    res.json({ ok: true });
  });
  app.delete('/gateway/ui/aliases/:address', uiAuth, (req, res) => {
    q.aliasDel.run(String(req.params.address).toLowerCase());
    res.json({ ok: true });
  });

  // Public health (kein Auth)
  app.get('/gateway/health', (req, res) => res.json({ ok: true, wa_ready: botCore.isReady(), smtp_port: SMTP_PORT }));

  // 2) Statisches Web-UI (zuletzt).
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(GATEWAY_PORT, () => console.log(`[Gateway] HTTP auf Port ${GATEWAY_PORT} (proxy:${!!MAIN_API_BASE})`));

  // ════════════════════════════════════════════════════════════════════════
  // SMTP-Server: E-Mail -> WhatsApp (Empfang, KEIN Versand)
  // ════════════════════════════════════════════════════════════════════════
  const smtp = new SMTPServer({
    banner: 'Rosenweg Messaging-Gateway (E-Mail->WhatsApp)',
    authOptional: !SMTP_USER,
    disabledCommands: SMTP_USER ? [] : ['STARTTLS'],
    onAuth(auth, session, cb) {
      if (SMTP_USER && auth.username === SMTP_USER && auth.password === SMTP_PASS) return cb(null, { user: auth.username });
      return cb(new Error('Ungueltige SMTP-Zugangsdaten'));
    },
    async onData(stream, session, cb) {
      try {
        const parsed = await simpleParser(stream);
        const rcpts = (session.envelope.rcptTo || []).map(r => r.address).filter(Boolean);
        if (rcpts.length === 0) { const e = new Error('Kein Empfaenger'); e.responseCode = 550; return cb(e); }
        const from = (session.envelope.mailFrom && session.envelope.mailFrom.address) || parsed.from?.text || 'unknown';
        const subject = parsed.subject || null;
        const body = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
        const attachments = (parsed.attachments || []).map(a => ({
          filename: a.filename || 'anhang', mimetype: a.contentType,
          data_base64: a.content ? a.content.toString('base64') : null,
        })).filter(a => a.data_base64);

        if (!botCore.isReady()) { const e = new Error('WhatsApp nicht bereit — bitte spaeter erneut'); e.responseCode = 451; return cb(e); }

        let anySent = false; const errors = [];
        for (const rcpt of rcpts) {
          const local = rcpt.split('@')[0];
          try {
            await sendAndLog({ source: 'smtp-email', sender: from, to: local, title: subject, body, attachments });
            anySent = true;
          } catch (e) { errors.push(`${rcpt}: ${e.message}`); }
        }
        if (!anySent) { const e = new Error(`Kein Ziel zustellbar (${errors.join('; ')})`); e.responseCode = 550; return cb(e); }
        cb(null, `OK${errors.length ? ' (teilweise: ' + errors.join('; ') + ')' : ''}`);
      } catch (err) {
        const e = new Error('Verarbeitungsfehler: ' + (err.message || err)); e.responseCode = 451; cb(e);
      }
    },
  });
  smtp.on('error', (e) => console.warn('[Gateway-SMTP] Fehler:', e.message));
  smtp.listen(SMTP_PORT, () => console.log(`[Gateway] SMTP-in auf Port ${SMTP_PORT} (auth:${!!SMTP_USER})`));

  // ── Hooks zurueck an index.js (Inbound-Logging) ──────────────────────────
  function logInbound({ phone, chatId, body, whatsappMsgId, attachments, isGroup, groupName }) {
    q.msgInsert.run({
      direction: 'inbound', source: 'inbound', sender: phone || chatId || null,
      // Bei Gruppen: target = Gruppenname (fuers Display), sonst die 1:1-JID.
      target: isGroup ? (groupName || chatId) : (chatId || phone || null),
      target_kind: isGroup ? 'group' : 'jid',
      subject: null, body: body || null,
      attachments_json: JSON.stringify((attachments || []).map(a => ({ filename: a.filename, mimetype: a.mimetype }))),
      whatsapp_msg_id: whatsappMsgId || null, status: 'received', error: null,
      created_at: nowIso(), sent_at: null,
    });
  }

  return { logInbound, db, _internal: { resolveTarget, sendAndLog } };
}

module.exports = { startGateway };
