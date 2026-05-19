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

const API_BASE   = process.env.API_BASE   || 'http://api:3000';
const WA_SECRET  = process.env.WHATSAPP_SHARED_SECRET;
const POLL_MS    = parseInt(process.env.WA_POLL_MS, 10) || 15_000;
const DATA_DIR   = process.env.WA_DATA_DIR || '/data';

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
client.on('disconnected', (r) => { console.warn('[WA] Disconnected:', r); isReady = false; });

client.on('ready', () => {
  isReady = true;
  console.log('[WA] Bot ist bereit, Nummer:', client.info?.wid?.user);
});

// Eingehende Nachrichten → an API
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    if (!msg.from.endsWith('@c.us')) return; // nur 1:1 Chats, keine Gruppen
    const phone = '+' + msg.from.replace('@c.us', '');
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
      body: JSON.stringify({ phone, body, whatsapp_msg_id: msg.id?._serialized, attachments }),
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
        const chatId = m.phone.replace(/\D/g, '') + '@c.us';
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

client.initialize().catch(err => { console.error('Init-Fehler:', err); process.exit(1); });

// Graceful shutdown
process.on('SIGTERM', async () => { try { await client.destroy(); } catch {} process.exit(0); });
process.on('SIGINT',  async () => { try { await client.destroy(); } catch {} process.exit(0); });
