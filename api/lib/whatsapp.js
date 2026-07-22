// WhatsApp-Versand-Queue + Technik-Gruppen-Resolver — aus server.js ausgelagert.
// Der eigentliche Versand laeuft im separaten Service rosenweg_whatsapp-bot;
// hier wird nur in die DB-Queue geschrieben bzw. die Gruppen-ID geholt.
const { pool } = require('./db');
const { normalizePhone } = require('./utils');

// Gateway-Endpoints. Default = Overlay-Name (Swarm); nach LXC-Migration via
// Env GATEWAY_GROUPS_URL / GATEWAY_SEND_URL auf die CT-IP gesetzt.
const GATEWAY_GROUPS_URL = process.env.GATEWAY_GROUPS_URL || 'http://tasks.rosenweg_whatsapp-bot:8080/groups';

// Cache für WA-Group-ID "Rosenweg Technik" (5 Min TTL)
let _technikWaCache = { id: null, fetched_at: 0 };
async function resolveTechnikWhatsappGroupId() {
  // Feste Gruppen-JID per Env bevorzugen — unabhaengig vom flaky /groups-Endpoint.
  // whatsapp-web.js getChats liefert zeitweise leer -> resolveTechnik... gab null zurueck
  // -> Technik-Alerts (Zaehler-Watchdog, PBX-Voicemail...) fielen seit 2026-07-08 lautlos aus.
  const envId = (process.env.TECHNIK_WA_GROUP_ID || '').trim();
  if (envId) return envId;
  const TTL_MS = 5 * 60 * 1000;
  if (_technikWaCache.id && (Date.now() - _technikWaCache.fetched_at) < TTL_MS) {
    return _technikWaCache.id;
  }
  try {
    const r = await fetch(GATEWAY_GROUPS_URL, {
      headers: { 'X-WA-Secret': process.env.WHATSAPP_SHARED_SECRET || '' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const { groups } = await r.json();
    // Match: enthält "rosenweg" UND "technik" (case-insensitive)
    const found = (groups || []).find(g => {
      const n = (g.name || '').toLowerCase();
      return n.includes('rosenweg') && n.includes('technik');
    });
    if (found) {
      _technikWaCache = { id: found.id, fetched_at: Date.now() };
      console.log(`[pbx-voicemail] Group "${found.name}" -> ${found.id}`);
      return found.id;
    }
  } catch (e) { console.warn('[pbx-voicemail] /groups Fehler:', e.message); }
  return null;
}

// Ausgehende Nachricht. PRIMAER ueber das dedizierte Gateway (/gateway/send,
// keyed). Faellt das aus (WA nicht bereit / Gateway unerreichbar): Fallback in
// die Postgres-Queue -> Bot pollt + retried (Durability). Der Postgres-Record
// bleibt fuer "letzte 30 Nachrichten" + "fuer alle loeschen"-Tracking — bei
// Gateway-Erfolg als 'sent' (NICHT 'queued', sonst sendet pollOutbox doppelt).
const GATEWAY_SEND_URL = process.env.GATEWAY_SEND_URL || 'http://tasks.rosenweg_whatsapp-bot:8090/gateway/send';
const GATEWAY_API_KEY  = process.env.GATEWAY_API_KEY || '';

async function queueWhatsappMessage({ phone, body, attachments, sourceType, sourceId, personId, chatId }) {
  // chatId hat Vorrang: bei LID-Privacy-Chats ist die echte Nummer
  // nicht aufloesbar, dann müssen wir die @lid-JID direkt zurück-routen.
  const norm = chatId || normalizePhone(phone);
  if (!norm) throw new Error('Ungueltige Telefonnummer');

  if (GATEWAY_API_KEY) {
    try {
      const gw = await fetch(GATEWAY_SEND_URL, {
        method: 'POST',
        headers: { 'X-Messaging-Key': GATEWAY_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'whatsapp', to: norm, body: body || '', attachments: attachments || [] }),
        signal: AbortSignal.timeout(20000),
      });
      if (gw.ok) {
        const d = await gw.json().catch(() => ({}));
        const ins = await pool.query(
          `INSERT INTO whatsapp_messages
             (direction, phone, chat_id, body, attachments, person_id, source_type, source_id, status, whatsapp_msg_id, sent_at)
           VALUES ('outbound', $1, $2, $3, $4::jsonb, $5, $6, $7, 'sent', $8, NOW())
           RETURNING id`,
          [norm, chatId || null, body || '', JSON.stringify(attachments || []), personId || null, sourceType || null, sourceId || null, d.whatsapp_msg_id || null],
        );
        return ins.rows[0].id;
      }
      console.warn(`[wa] Gateway-Send HTTP ${gw.status} -> Fallback Queue`);
    } catch (e) {
      console.warn('[wa] Gateway-Send fehlgeschlagen, Fallback Queue:', e.message);
    }
  }

  // Fallback: Postgres-Queue (Bot pollt + retried).
  const r = await pool.query(
    `INSERT INTO whatsapp_messages
       (direction, phone, chat_id, body, attachments, person_id, source_type, source_id, status)
     VALUES ('outbound', $1, $2, $3, $4::jsonb, $5, $6, $7, 'queued')
     RETURNING id`,
    [norm, chatId || null, body || '', JSON.stringify(attachments || []), personId || null, sourceType || null, sourceId || null],
  );
  return r.rows[0].id;
}

module.exports = { queueWhatsappMessage, resolveTechnikWhatsappGroupId };
