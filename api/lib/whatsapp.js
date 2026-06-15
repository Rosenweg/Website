// WhatsApp-Versand-Queue + Technik-Gruppen-Resolver — aus server.js ausgelagert.
// Der eigentliche Versand laeuft im separaten Service rosenweg_whatsapp-bot;
// hier wird nur in die DB-Queue geschrieben bzw. die Gruppen-ID geholt.
const { pool } = require('./db');
const { normalizePhone } = require('./utils');

// Cache für WA-Group-ID "Rosenweg Technik" (5 Min TTL)
let _technikWaCache = { id: null, fetched_at: 0 };
async function resolveTechnikWhatsappGroupId() {
  const TTL_MS = 5 * 60 * 1000;
  if (_technikWaCache.id && (Date.now() - _technikWaCache.fetched_at) < TTL_MS) {
    return _technikWaCache.id;
  }
  try {
    // tasks.* statt VIP weil Docker Swarm IPVS auf unserem Setup zickt
    const r = await fetch('http://tasks.rosenweg_whatsapp-bot:8080/groups', {
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

// Queue eine ausgehende Nachricht. Bot-Service holt sie und versendet.
async function queueWhatsappMessage({ phone, body, attachments, sourceType, sourceId, personId, chatId }) {
  // chatId hat Vorrang: bei LID-Privacy-Chats ist die echte Nummer
  // nicht aufloesbar, dann müssen wir die @lid-JID direkt zurück-routen.
  const norm = chatId || normalizePhone(phone);
  if (!norm) throw new Error('Ungueltige Telefonnummer');
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
