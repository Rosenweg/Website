// Rosenweg WhatsApp-Bot — whatsapp-web.js Wrapper
// Bridged WhatsApp ↔ Rosenweg-API (server.js Endpoints /api/whatsapp/*)
//
// Setup:
//   1. Container starten → QR-Code im Log scannen
//   2. Session wird in /data persistiert
//   3. Bot polled API stündlich für ausgehende Nachrichten

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrPng = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');

const API_BASE       = process.env.API_BASE       || 'http://api:3000';
const WA_SECRET      = process.env.WHATSAPP_SHARED_SECRET;
const POLL_MS        = parseInt(process.env.WA_POLL_MS, 10)        || 15_000;
const HEARTBEAT_MS   = parseInt(process.env.WA_HEARTBEAT_MS, 10)   || 30_000;
const HEALTH_PORT    = parseInt(process.env.WA_HEALTH_PORT, 10)    || 8080;
const RECONNECT_MS   = parseInt(process.env.WA_RECONNECT_MS, 10)   || 30_000;
const DATA_DIR       = process.env.WA_DATA_DIR || '/data';

if (!WA_SECRET) {
  console.error('FATAL: WHATSAPP_SHARED_SECRET env var fehlt');
  process.exit(1);
}

// Chromium SingletonLock-Cleanup: nach Crash/SIGKILL bleiben Lock-Files
// im Profil zurueck (Hostname-spezifisch); naechster Start kann das Profil
// dann nicht oeffnen → permanenter Crashloop. Defensiv vor jedem Start.
function cleanupChromiumLocks() {
  const sessionDir = path.join(DATA_DIR, 'session');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(sessionDir, f)); console.log('[WA] entferntes Lock:', f); } catch {}
  }
}
cleanupChromiumLocks();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: DATA_DIR }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

let isReady = false;

const QR_PNG_PATH = path.join(DATA_DIR, 'qr.png');
client.on('qr', async (qr) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SCAN QR CODE mit WhatsApp → Einstellungen → Verknüpfte Geräte:');
  console.log(`(QR als PNG: ${QR_PNG_PATH} im Container | URL: /api/whatsapp/qr.png)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  qrcode.generate(qr, { small: true });
  try {
    await qrPng.toFile(QR_PNG_PATH, qr, { width: 512, margin: 2 });
  } catch (e) { console.warn('[WA] QR-PNG schreiben fehlgeschlagen:', e.message); }
  // Auch an die API pushen, damit Admin den QR via Browser holen kann
  try {
    const png = await qrPng.toBuffer(qr, { width: 512, margin: 2 });
    await fetch(`${API_BASE}/api/whatsapp/qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
      body: JSON.stringify({ png_base64: png.toString('base64') }),
    });
  } catch (e) { console.warn('[WA] QR an API pushen fehlgeschlagen:', e.message); }
});

client.on('authenticated', async () => {
  console.log('[WA] Authentifiziert');
  try { fs.unlinkSync(QR_PNG_PATH); } catch {}
  // QR aus API loeschen (paired)
  try {
    await fetch(`${API_BASE}/api/whatsapp/qr`, {
      method: 'DELETE',
      headers: { 'X-WA-Secret': WA_SECRET },
    });
  } catch {}
});
client.on('auth_failure', (m) => console.error('[WA] Auth fehlgeschlagen:', m));

// Auto-Reconnect bei Disconnect: ohne diesen Mechanismus bleibt der Bot
// nach z.B. WiFi-Hickups oder WhatsApp-Server-Wartung permanent offline,
// bis der Container neugestartet wird. Wir reinitialisieren den Client
// nach einer kurzen Pause; LocalAuth-Session im /data-Volume sorgt dafuer
// dass kein neuer QR-Scan noetig ist.
let reconnectScheduled = false;
client.on('disconnected', async (reason) => {
  console.warn('[WA] Disconnected:', reason);
  isReady = false;
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  setTimeout(async () => {
    reconnectScheduled = false;
    console.log('[WA] Auto-Reconnect-Versuch …');
    try {
      try { await client.destroy(); } catch {}
      cleanupChromiumLocks();
      await client.initialize();
    } catch (err) {
      console.error('[WA] Reconnect fehlgeschlagen:', err.message);
      // Bei wiederholtem Fehlschlag: Prozess beenden → Swarm restart_policy
      // startet neuen Container (sauberer State als haengender Browser).
      process.exit(1);
    }
  }, RECONNECT_MS);
});

let readyAt = null;
client.on('ready', () => {
  isReady = true;
  readyAt = new Date();
  console.log('[WA] Bot ist bereit, Nummer:', client.info?.wid?.user);
});

// Eingehende Nachrichten → an API
// WhatsApp hat seit ~2026 das @lid-Format (Linked-ID) fuer Privacy: viele
// 1:1-Chats kommen als from=<lid>@lid statt <phone>@c.us. Das alte 'message'-
// Event feuert dafuer teilweise nicht — wir hoeren auf 'message_create' und
// filtern fromMe selbst. Die echte Telefonnummer holen wir via getContact().
client.on('message_create', async (msg) => {
  try {
    if (msg.fromMe) return;
    // Gruppen ignorieren (sonst antwortet Bot auf alles in jeder Gruppe).
    if (msg.from.endsWith('@g.us')) return;
    // Nur 1:1 (klassisch @c.us oder neu @lid)
    if (!msg.from.endsWith('@c.us') && !msg.from.endsWith('@lid')) return;
    // Phone via Contact aufloesen (bei @lid ist im from-Feld die echte
    // Nummer maskiert; getContact() liefert die tatsaechliche Nummer).
    let phone = null;
    try {
      const contact = await msg.getContact();
      if (contact?.number) phone = '+' + contact.number;
      else if (contact?.id?.user) phone = '+' + contact.id.user;
    } catch (e) { /* fallback unten */ }
    if (!phone && msg.from.endsWith('@c.us')) {
      phone = '+' + msg.from.replace('@c.us', '');
    }
    if (!phone) {
      console.warn(`[WA] Inbound ohne aufloesbare Nummer: from=${msg.from}`);
      return;
    }
    console.log(`[WA] Inbound von ${phone} (${msg.from}): ${(msg.body||'').slice(0,80)}`);
    const chatId = msg.from; // echte Chat-ID (@c.us oder @lid) fuer Reply
    const body = msg.body || '';
    const attachments = [];
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        attachments.push({
          type: 'image',
          mimetype: media.mimetype,
          filename: media.filename || `media-${Date.now()}`,
          data_base64: media.data,
          caption: msg.body || null,
        });
      } catch (e) { console.warn('[WA] Media-Download fehlgeschlagen:', e.message); }
    }
    const res = await fetch(`${API_BASE}/api/whatsapp/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
      body: JSON.stringify({ phone, chat_id: chatId, body, whatsapp_msg_id: msg.id?._serialized, attachments }),
    });
    if (!res.ok) console.warn('[WA] API inbound rejected:', res.status, await res.text().catch(() => ''));
  } catch (err) {
    console.error('[WA] Inbound-Handler Fehler:', err);
  }
});

// Outbox-Polling
async function pollOutbox() {
  if (!isReady) return;
  try {
    const res = await fetch(`${API_BASE}/api/whatsapp/outbox-poll?limit=10`, {
      headers: { 'X-WA-Secret': WA_SECRET },
    });
    if (!res.ok) { console.warn('[WA] Outbox-Poll fehlgeschlagen:', res.status); return; }
    const { messages } = await res.json();
    for (const m of (messages || [])) {
      try {
        // Wenn die API einen chat_id mitliefert (Reply auf Inbound mit @lid oder @c.us),
        // nutzen wir den direkt. Sonst Fallback: phone-Feld auswerten (kann @g.us-Group-JID
        // enthalten, sonst Nummer → @c.us).
        const chatId = m.chat_id
          ? m.chat_id
          : (m.phone.endsWith('@g.us') || m.phone.endsWith('@lid') || m.phone.endsWith('@c.us')
              ? m.phone
              : m.phone.replace(/\D/g, '') + '@c.us');
        // Anhaenge (falls vorhanden) als MessageMedia
        let mediaSent = false;
        for (const a of (m.attachments || [])) {
          if (a.docs_path) continue; // Disk-Pfade waeren spezielle Behandlung — vorerst skippen
          if (a.data_base64) {
            const media = new MessageMedia(a.mimetype || 'image/jpeg', a.data_base64, a.filename || 'beleg');
            await client.sendMessage(chatId, media, { caption: m.body || a.caption || '' });
            mediaSent = true;
          }
        }
        if (!mediaSent && m.body) await client.sendMessage(chatId, m.body);
        await fetch(`${API_BASE}/api/whatsapp/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
          body: JSON.stringify({ message_id: m.id, status: 'sent' }),
        });
      } catch (err) {
        console.error(`[WA] Send fehler msg=${m.id}:`, err.message);
        await fetch(`${API_BASE}/api/whatsapp/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
          body: JSON.stringify({ message_id: m.id, status: 'failed', error_message: String(err.message).slice(0, 500) }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[WA] Poll-Fehler:', err.message);
  }
}

setInterval(pollOutbox, POLL_MS);

// Heartbeat an API: damit der Admin sieht ob der Bot lebt und gepairt ist.
// Stale-Heartbeats (>5min) → API alarmiert Technik/Praesident.
async function sendHeartbeat() {
  try {
    await fetch(`${API_BASE}/api/whatsapp/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
      body: JSON.stringify({
        is_ready: isReady,
        ready_at: readyAt,
        phone: client.info?.wid?.user || null,
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
      }),
    });
  } catch (err) { /* API kurz unerreichbar → nicht crashen */ }
}
setInterval(sendHeartbeat, HEARTBEAT_MS);

// HTTP-Healthcheck + Groups-Endpoint
const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    if (isReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', phone: client.info?.wid?.user, uptime: process.uptime() }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_ready' }));
    }
    return;
  }
  if (req.url === '/groups') {
    if (req.headers['x-wa-secret'] !== WA_SECRET) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    if (!isReady) { res.writeHead(503); res.end('not_ready'); return; }
    try {
      const chats = await client.getChats();
      const groups = chats.filter(c => c.isGroup).map(c => ({
        id: c.id._serialized,
        name: c.name,
        participants: (c.groupMetadata?.participants || []).length,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ groups }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404); res.end();
});
healthServer.listen(HEALTH_PORT, () => console.log('[WA] Healthcheck-HTTP auf Port', HEALTH_PORT));

client.initialize().catch(err => { console.error('Init-Fehler:', err); process.exit(1); });

// Graceful shutdown
async function shutdown() {
  console.log('[WA] Shutdown …');
  try { healthServer.close(); } catch {}
  try { await client.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
