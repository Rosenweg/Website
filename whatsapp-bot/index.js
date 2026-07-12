// Rosenweg WhatsApp-Bot — whatsapp-web.js Wrapper
// Bridged WhatsApp ↔ Rosenweg-API (server.js Endpoints /api/whatsapp/*)
//
// Setup:
//   1. Container starten → QR-Code im Log scannen
//   2. Session wird in /data persistiert
//   3. Bot polled API stündlich für ausgehende Nachrichten

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { spawn } = require('node:child_process');

// Konvertiert audio/wav -> audio/ogg (opus) via ffmpeg.
// WhatsApp Web verarbeitet WAV in Gruppen oft nicht (silent drop bei Upload),
// OGG Opus ist das native Format und wird zuverlaessig akzeptiert.
async function convertWavToOgg(base64Wav) {
  return new Promise((resolve, reject) => {
    const wav = Buffer.from(base64Wav, 'base64');
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'wav', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '16000', '-ac', '1',
      '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    let err = '';
    ff.stdout.on('data', c => out.push(c));
    ff.stderr.on('data', c => err += c.toString());
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`));
      resolve(Buffer.concat(out).toString('base64'));
    });
    ff.stdin.end(wav);
  });
}
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
// Wohin eingehende Nachrichten weitergeleitet werden (Command-Bot der Haupt-API).
// Rosenweg: gesetzt; anderes Projekt: leer -> nur SQLite-Log im Gateway.
const FORWARD_INBOUND_URL = process.env.FORWARD_INBOUND_URL
  || (process.env.WA_SECRET_FORWARD_OFF ? '' : `${API_BASE}/api/whatsapp/inbound`);
// Eingehende Nachrichten als gelesen markieren (blaue Haken), NACHDEM die API sie
// bestaetigt gespeichert hat. Default an; via WA_MARK_SEEN=0 abschaltbar.
const MARK_SEEN = process.env.WA_MARK_SEEN !== '0';

// Hooks aus dem Gateway (gateway.js) — fuer Inbound-Logging in die SQLite.
let gatewayHooks = null;

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
  try {
    const png = await qrPng.toBuffer(qr, { width: 512, margin: 2 });
    const b64 = png.toString('base64');
    // a) Direkt ins Gateway-Webinterface (whatsapp.rosenweg4303.ch) — self-contained.
    gatewayHooks?.setQr(b64);
    // b) Auch an die Haupt-API pushen (Legacy whatsapp-bot-admin Seite).
    await fetch(`${API_BASE}/api/whatsapp/qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
      body: JSON.stringify({ png_base64: b64 }),
    });
  } catch (e) { console.warn('[WA] QR-Verteilung fehlgeschlagen:', e.message); }
});

client.on('authenticated', async () => {
  console.log('[WA] Authentifiziert');
  try { fs.unlinkSync(QR_PNG_PATH); } catch {}
  gatewayHooks?.setQr(null); // QR im Gateway loeschen (gepairt)
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
  gatewayHooks?.setQr(null);
  console.log('[WA] Bot ist bereit, Nummer:', client.info?.wid?.user);
});

// Zustell-/Lesebestaetigung: ACK-Aenderungen unserer gesendeten Nachrichten
// ans Gateway melden (delivered/read + ggf. Status-Mail an E-Mail-Absender).
// ack: 1=server, 2=zugestellt(Geraet), 3=gelesen(blau), 4=abgespielt.
client.on('message_ack', (msg, ack) => {
  try {
    if (!msg.fromMe) return;
    gatewayHooks?.updateAck(msg.id?._serialized, ack);
  } catch (e) { /* best effort */ }
});

// Eingehende Nachrichten → an API
// WhatsApp hat seit ~2026 das @lid-Format (Linked-ID) fuer Privacy: viele
// 1:1-Chats kommen als from=<lid>@lid statt <phone>@c.us. Das alte 'message'-
// Event feuert dafuer teilweise nicht — wir hoeren auf 'message_create' und
// filtern fromMe selbst. Die echte Telefonnummer holen wir via getContact().
client.on('message_create', async (msg) => {
  try {
    if (msg.fromMe) return;
    const isGroup = msg.from.endsWith('@g.us');
    // 1:1 (klassisch @c.us oder neu @lid) ODER Gruppe (@g.us). Gruppen werden
    // NUR ins Gateway-Log geschrieben (kein Command-Bot-Forward -> kein Auto-Reply).
    if (!isGroup && !msg.from.endsWith('@c.us') && !msg.from.endsWith('@lid')) return;

    // Absender-JID: bei Gruppen der Teilnehmer (author), sonst der Chat selbst.
    const senderJid = isGroup ? (msg.author || msg.from) : msg.from;

    // Phone aufloesen — bei @lid liefert getContact() typischerweise nur die LID.
    let phone = null;
    let contactDebug = {};
    try {
      const contact = await msg.getContact(); // bei Gruppen: der Author
      contactDebug = {
        id: contact?.id?._serialized, number: contact?.number, pushname: contact?.pushname,
        name: contact?.name, shortName: contact?.shortName, verifiedName: contact?.verifiedName,
        isMyContact: contact?.isMyContact,
      };
      if (contact?.number && /^\d{8,15}$/.test(contact.number) && !senderJid.startsWith(contact.number)) {
        phone = '+' + contact.number;
      }
    } catch (e) { /* fallback unten */ }
    if (!phone && senderJid.endsWith('@lid')) {
      try {
        const arr = await client.getContactLidAndPhone([senderJid]);
        const entry = Array.isArray(arr) ? arr[0] : arr;
        const pn = entry?.pn || '';
        const digits = String(pn).split('@')[0].replace(/^\+/, '');
        if (/^\d{8,15}$/.test(digits)) phone = '+' + digits;
      } catch (e) { console.warn('[WA-LID] getContactLidAndPhone Fehler:', e.message); }
    }
    if (!phone && senderJid.endsWith('@c.us')) phone = '+' + senderJid.replace('@c.us', '');
    if (!phone) {
      phone = '+' + senderJid.replace(/@(lid|c\.us|g\.us)$/, '');
      if (!isGroup) console.warn(`[WA] Inbound ohne aufloesbare echte Nummer, fallback=${phone} debug=`, contactDebug);
    }

    // Gruppenname (fuers Web-UI-Display).
    let groupName = null;
    if (isGroup) { try { groupName = (await msg.getChat())?.name || null; } catch {} }

    console.log(`[WA] Inbound ${isGroup ? '(Gruppe '+(groupName||msg.from)+') ' : ''}von ${phone}: ${(msg.body||'').slice(0,80)}`);
    const chatId = msg.from; // Gruppe: @g.us | 1:1: @c.us/@lid
    const body = msg.body || '';
    const attachments = [];
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        attachments.push({
          type: 'image', mimetype: media.mimetype,
          filename: media.filename || `media-${Date.now()}`,
          data_base64: media.data, caption: msg.body || null,
        });
      } catch (e) { console.warn('[WA] Media-Download fehlgeschlagen:', e.message); }
    }
    // 1) Gateway-SQLite-Log (1:1 UND Gruppe) — best effort.
    try {
      gatewayHooks?.logInbound({
        phone, chatId, body, whatsappMsgId: msg.id?._serialized || null, attachments,
        isGroup, groupName,
      });
    } catch (e) { console.warn('[WA] Gateway-Inbound-Log Fehler:', e.message); }
    // 2) An die API weiterleiten — fuer ALLE Chats, in denen der Bot Mitglied ist
    //    (1:1 UND Gruppen), damit das System die volle Konversation erfasst.
    //    `is_group` steuert API-seitig: 1:1 -> Command-Bot antwortet; Gruppe -> nur erfassen,
    //    KEIN Auto-Reply (intelligente Gruppen-Antworten kommen separat via Technik-Bot).
    let storedOk = false;
    if (FORWARD_INBOUND_URL) {
      const res = await fetch(FORWARD_INBOUND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
        body: JSON.stringify({ phone, chat_id: chatId, body, whatsapp_msg_id: msg.id?._serialized, attachments, is_group: isGroup, group_name: groupName }),
      });
      storedOk = res.ok;
      if (!res.ok) console.warn('[WA] API inbound rejected:', res.status, await res.text().catch(() => ''));
    }
    // 3) Erst NACH bestaetigter Persistenz (API res.ok) den Chat als gelesen markieren
    //    (blaue Haken fuer den Absender). Schlaegt das Speichern fehl -> bleibt ungelesen
    //    = sichtbares "unverarbeitet"-Signal. wwebjs kann nur pro Chat (sendSeen),
    //    nicht pro Einzelnachricht. Gilt fuer 1:1 UND Gruppen. Abschaltbar via WA_MARK_SEEN=0.
    if (storedOk && MARK_SEEN) {
      try { const chat = await msg.getChat(); await chat.sendSeen(); }
      catch (e) { console.warn('[WA] sendSeen fehlgeschlagen:', e.message); }
    }
  } catch (err) {
    console.error('[WA] Inbound-Handler Fehler:', err);
  }
});

// Wartet bis die Nachricht den gewuenschten ACK-Level erreicht hat.
// ACK: -1=fehler, 0=pending, 1=server-ack, 2=device-ack, 3=read.
// wwebjs aktualisiert die ursprung. Message-Property nicht automatisch —
// wir muessen via getMessageById neu lesen.
async function waitForAck(msg, minAck = 1, timeoutMs = 8000) {
  if (!msg) return;
  const id = msg.id?._serialized;
  if (!id) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fresh = await client.getMessageById(id);
      if (fresh && (fresh.ack ?? 0) >= minAck) {
        console.log(`[WA] ack=${fresh.ack} fuer ${id}`);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`[WA] ACK-Timeout fuer ${id}`);
}

// ─── Geteilte Sende-/Loesch-Kernfunktionen ──────────────────────────────
// Wird von BEIDEN genutzt: pollOutbox (Postgres-App-Queue der Haupt-API) UND
// dem Standalone-Gateway (gateway.js: keyed JSON-API, SMTP-in, Web-UI).
// Gibt die _serialized WhatsApp-Message-ID zurueck (fuer Tracking/Loeschen).
// attachments: [{ mimetype, data_base64|content_base64, filename, caption }]
async function sendViaClient(chatId, body, attachments = []) {
  // Bei Gruppen: chat erst laden — client.sendMessage schlaegt sonst gerne
  // ohne Fehler "sent" zurueck ohne tatsaechliche Zustellung.
  const isGroup = chatId.endsWith('@g.us');
  const chat = isGroup ? await client.getChatById(chatId) : null;
  let mediaSent = false;
  let sentMsg = null;
  for (const a of (attachments || [])) {
    if (a.docs_path) continue; // Disk-Pfade: spezielle Behandlung — vorerst skippen
    const b64 = a.data_base64 || a.content_base64;
    if (b64) {
      let mime = a.mimetype || 'application/octet-stream';
      let dataB64 = b64;
      let filename = a.filename || 'anhang';
      // WAV -> OGG opus konvertieren (zuverlaessigere Zustellung als Voice)
      if (mime === 'audio/wav' || mime === 'audio/wave' || mime === 'audio/x-wav') {
        try {
          dataB64 = await convertWavToOgg(b64);
          mime = 'audio/ogg; codecs=opus';
          filename = filename.replace(/\.wav$/i, '.ogg');
        } catch (e) { console.warn(`[WA] ffmpeg-Konvertierung fehlgeschlagen, sende WAV: ${e.message}`); }
      }
      const media = new MessageMedia(mime, dataB64, filename);
      const opts = { caption: body || a.caption || '', sendAudioAsVoice: mime.startsWith('audio/ogg') };
      sentMsg = chat ? await chat.sendMessage(media, opts) : await client.sendMessage(chatId, media, opts);
      mediaSent = true;
    }
  }
  if (!mediaSent && body) {
    sentMsg = chat ? await chat.sendMessage(body) : await client.sendMessage(chatId, body);
  }
  if (!sentMsg) throw new Error('sendMessage liefert null/undefined (kein Body, keine Anhaenge?)');
  // Warten bis die Nachricht WIRKLICH beim WA-Server ist (ack>=1) — sonst
  // ueberholt eine schnell hochgeladene Voice-Note die unbestaetigte Textnachricht.
  await waitForAck(sentMsg, 1, 6000);
  return { msgId: sentMsg.id?._serialized || null, ack: sentMsg.ack ?? null };
}

// "Fuer alle loeschen" per gespeicherter WhatsApp-Message-ID.
async function revokeByMsgId(msgId) {
  const msg = await client.getMessageById(msgId);
  if (!msg) throw new Error('Nachricht nicht (mehr) auffindbar');
  await msg.delete(true); // true = fuer alle
}

// Gruppen-Info inkl. Community-Metadaten: parentGroupId = Community-Zuordnung (welche
// Community-Elterngruppe), announce = Ankuendigungsgruppe, isParentGroup = Elterngruppe.
// HINWEIS: WhatsApp/whatsapp-web.js koennen NICHT beigetretene Community-Subgruppen NICHT
// auflisten -> hier erscheinen nur Gruppen, in denen der Bot Mitglied ist.
function groupInfo(c) {
  const gm = c.groupMetadata || {};
  const pg = gm.parentGroupId;
  return {
    id: c.id._serialized,
    name: c.name,
    participants: (gm.participants || []).length,
    parentGroupId: pg ? (pg._serialized || (pg.user && pg.server ? pg.user + '@' + pg.server : String(pg))) : null,
    isParentGroup: !!gm.isParentGroup,
    isAnnounce: !!gm.announce,
    desc: gm.desc || null,
  };
}

// Alle Gruppen des Bots (inkl. Community-Metadaten).
async function getGroups() {
  const chats = await client.getChats();
  return chats.filter(c => c.isGroup).map(groupInfo);
}

// Gruppe per exaktem (case-insensitive) Titel -> chatId. 0/>1 Treffer -> Fehler.
async function findGroupByName(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) throw new Error('Leerer Gruppenname');
  const chats = await client.getChats();
  const matches = chats.filter(c => c.isGroup && (c.name || '').trim().toLowerCase() === target);
  if (matches.length === 0) throw new Error(`Keine WhatsApp-Gruppe mit Titel "${name}"`);
  if (matches.length > 1) throw new Error(`Mehrere Gruppen mit Titel "${name}" — bitte JID verwenden`);
  return matches[0].id._serialized;
}

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

        const { msgId } = await sendViaClient(chatId, m.body, m.attachments);
        console.log(`[WA] msg=${m.id} -> ${chatId} (id=${msgId || '?'})`);
        // whatsapp_msg_id IMMER mitschicken — damit die Nachricht spaeter
        // gezielt geloescht ("fuer alle loeschen") werden kann (Tracking).
        await fetch(`${API_BASE}/api/whatsapp/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
          body: JSON.stringify({ message_id: m.id, status: 'sent', whatsapp_msg_id: msgId }),
        });
      } catch (err) {
        // err.message kann bei whatsapp-web.js single-char sein; stack mitloggen
        const detailedErr = err.stack || `${err.name || ''}: ${err.message || ''}` || String(err);
        console.error(`[WA] Send fehler msg=${m.id}:`, detailedErr.slice(0, 1500));
        await fetch(`${API_BASE}/api/whatsapp/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
          body: JSON.stringify({ message_id: m.id, status: 'failed', error_message: detailedErr.slice(0, 500) }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[WA] Poll-Fehler:', err.message);
  }
}

setInterval(pollOutbox, POLL_MS);

// Delete-Polling: holt offene Loeschauftraege und revoked die jeweilige
// Nachricht "fuer alle". whatsapp-web.js: getMessageById(id).delete(true).
// Klappt nur solange WhatsApps Loesch-Zeitfenster offen ist; sonst Fehler ->
// wird als delete_error zurueckgemeldet.
async function pollDeletions() {
  if (!isReady) return;
  try {
    const res = await fetch(`${API_BASE}/api/whatsapp/delete-poll?limit=10`, {
      headers: { 'X-WA-Secret': WA_SECRET },
    });
    if (!res.ok) { console.warn('[WA] Delete-Poll fehlgeschlagen:', res.status); return; }
    const { messages } = await res.json();
    for (const m of (messages || [])) {
      let ok = false, errMsg = null;
      try {
        await revokeByMsgId(m.whatsapp_msg_id);
        ok = true;
        console.log(`[WA] geloescht msg=${m.id} (${m.whatsapp_msg_id})`);
      } catch (err) {
        errMsg = err.message || String(err);
        console.warn(`[WA] Loeschen msg=${m.id} fehlgeschlagen:`, errMsg);
      }
      await fetch(`${API_BASE}/api/whatsapp/delete-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WA-Secret': WA_SECRET },
        body: JSON.stringify({ message_id: m.id, deleted: ok, error_message: errMsg }),
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[WA] Delete-Poll-Fehler:', err.message);
  }
}
setInterval(pollDeletions, POLL_MS);

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
    // LIVENESS, nicht Readiness: solange der Prozess/Server antwortet, ist der
    // Container "healthy" — auch UNGEPAIRT (waiting_for_pairing ist ein gueltiger
    // Betriebszustand!). Sonst killt Swarm einen ungepairten Bot und man kann ihn
    // nie pairen (Deadlock). Verbindungsabbrueche faengt der Auto-Reconnect ab.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isReady ? 'ready' : 'waiting_for_pairing',
      ready: isReady,
      phone: client.info?.wid?.user || null,
      uptime: process.uptime(),
    }));
    return;
  }
  if (req.url === '/groups') {
    if (req.headers['x-wa-secret'] !== WA_SECRET) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    if (!isReady) { res.writeHead(503); res.end('not_ready'); return; }
    try {
      const chats = await client.getChats();
      const groups = chats.filter(c => c.isGroup).map(groupInfo);
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

// ─── Standalone Messaging-Gateway (eigener API-Server + SMTP-in + Web-UI) ──
// Laeuft unabhaengig vom WA-Client-Lifecycle; nur das tatsaechliche WA-*Senden*
// braucht isReady(). Wir reichen die geteilten Kernfunktionen als botCore rein.
try {
  gatewayHooks = require('./gateway').startGateway({
    isReady: () => isReady,
    sendViaClient,
    revokeByMsgId,
    findGroupByName,
    getGroups,
  });
} catch (e) {
  console.error('[Gateway] Start fehlgeschlagen (Bot laeuft weiter ohne Gateway):', e.stack || e.message);
}

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
