// Android-Dauertest im NOC: Annahme der Läufe aus CT 149, Lesen fürs Cockpit,
// Meldungen an die Technik. Entscheidungen in lib/android-dauertest.js.
//
//   POST /api/isp/noc/android-dauertest          CT 149 (X-Dauertest-Token, Absender-IP)
//   GET  /api/isp/noc/public/android-dauertest   NOC (X-Noc-Token)  | ohne public: angemeldet
//   GET  /api/isp/noc/public/android-dauertest/:kennung/schirmbild
//
// Meldung: WhatsApp-Gruppe Technik (wie die Stations-Wächter); findet sich die
// Gruppe nicht oder klemmt die Queue, Mail an technik@.
const { pool } = require('../lib/db');
const { geheimnisGleich } = require('../lib/utils');
const { loggedSendMail } = require('../lib/mail');
const { queueWhatsappMessage, resolveTechnikWhatsappGroupId } = require('../lib/whatsapp');
const ad = require('../lib/android-dauertest');

const TOKEN = process.env.ANDROID_DAUERTEST_TOKEN || '';
// Nur von diesen Adressen (direkt an die API, nicht über den Proxy). Leer = nicht prüfen.
const IPS = (process.env.ANDROID_DAUERTEST_IPS ?? '100.64.2.69').split(/[\s,]+/).filter(Boolean);
const TECHNIK_MAIL = process.env.ANDROID_DAUERTEST_MAIL || 'technik@rosenweg4303.ch';

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS android_dauertest (
      kennung VARCHAR(40) PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      paket VARCHAR(120) NOT NULL,
      version VARCHAR(40),
      ok BOOLEAN NOT NULL,
      grund TEXT,
      dauer_s INTEGER,
      zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rot_in_folge INTEGER NOT NULL DEFAULT 0,
      alarmiert BOOLEAN NOT NULL DEFAULT FALSE,
      schirmbild BYTEA
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS android_dauertest_still (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      gemeldet_fuer TIMESTAMPTZ
    )`);
}

async function technikMelden(text, betreff) {
  try {
    const gid = await resolveTechnikWhatsappGroupId();
    if (gid) {
      await queueWhatsappMessage({ chatId: gid, body: text.slice(0, 3500), sourceType: 'android-dauertest' });
      return;
    }
    console.warn('[android-dauertest] keine Technik-Gruppe gefunden - Mail an technik@');
  } catch (e) {
    console.warn('[android-dauertest] WhatsApp:', e.message, '- Mail an technik@');
  }
  try {
    await loggedSendMail({ to: TECHNIK_MAIL, subject: betreff, text }, 'android-dauertest');
  } catch (e) { console.warn('[android-dauertest] Mail:', e.message); }
}

function absender(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

async function annehmen(req, res) {
  if (!TOKEN) return res.status(503).json({ error: 'ANDROID_DAUERTEST_TOKEN nicht gesetzt' });
  if (!geheimnisGleich(req.headers['x-dauertest-token'], TOKEN)) return res.status(403).json({ error: 'Token ungueltig' });
  if (IPS.length && !IPS.includes(absender(req))) {
    console.warn(`[android-dauertest] POST von ${absender(req)} abgewiesen`);
    return res.status(403).json({ error: 'Absender nicht zugelassen' });
  }
  const e = ad.eingabePruefen(req.body);
  if (e.fehler) return res.status(400).json({ error: e.fehler });

  const meldungen = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of e.apps) {
      const v = (await client.query(
        'SELECT version, rot_in_folge, alarmiert FROM android_dauertest WHERE kennung = $1 FOR UPDATE', [a.kennung])).rows[0] || null;
      const b = ad.bewerten(v, a);
      await client.query(`
        INSERT INTO android_dauertest (kennung, name, paket, version, ok, grund, dauer_s, zeit, rot_in_folge, alarmiert, schirmbild)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10)
        ON CONFLICT (kennung) DO UPDATE SET name = $2, paket = $3, version = $4, ok = $5, grund = $6,
          dauer_s = $7, zeit = NOW(), rot_in_folge = $8, alarmiert = $9, schirmbild = COALESCE($10, android_dauertest.schirmbild)`,
        [a.kennung, a.name, a.paket, b.version, a.ok, a.grund, a.dauer_s, b.rot_in_folge, b.alarmiert, a.schirmbild]);
      if (b.meldung) meldungen.push({ app: { ...a, version: b.version }, art: b.meldung, b });
    }
    // Ein Lauf ist da: eine frühere "Prüfer still"-Meldung gilt als erledigt.
    await client.query('DELETE FROM android_dauertest_still');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[android-dauertest] speichern:', err.message);
    return res.status(500).json({ error: 'Speichern fehlgeschlagen' });
  } finally { client.release(); }

  for (const m of meldungen) {
    const text = ad.meldungText(m.app, m.art, { rot_in_folge: m.b.rot_in_folge, neuesRelease: m.b.neues_release });
    technikMelden(text, `Android-Dauertest: ${m.app.name} ${m.art === 'rot' ? 'rot' : 'wieder grün'}`);
  }
  res.json({ ok: true, apps: e.apps.length, meldungen: meldungen.length });
}

async function lesen(req, res) {
  try {
    const r = await pool.query(`SELECT kennung, name, paket, version, ok, grund, dauer_s, zeit, rot_in_folge,
                                       schirmbild IS NOT NULL AS hat_schirmbild FROM android_dauertest`);
    const z = ad.zusammenfassung(r.rows);
    res.json(req.nocOffen ? ad.oeffentlich(z) : z);
  } catch (e) {
    console.warn('[android-dauertest] lesen:', e.message);
    res.status(500).json({ error: 'Android-Dauertest nicht lesbar' });
  }
}

async function schirmbild(req, res) {
  if (req.nocOffen) return res.status(403).json({ error: 'nur mit Token' });
  try {
    const r = await pool.query('SELECT schirmbild FROM android_dauertest WHERE kennung = $1', [String(req.params.kennung || '')]);
    const b = r.rows[0]?.schirmbild;
    if (!b) return res.status(404).json({ error: 'kein Schirmbild' });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(b);
  } catch (e) {
    console.warn('[android-dauertest] schirmbild:', e.message);
    res.status(500).json({ error: 'Schirmbild nicht lesbar' });
  }
}

// Prüfer still (CT aus, Emulator kaputt): einmal je Ausfall melden.
async function stillePruefen() {
  try {
    const r = await pool.query('SELECT MAX(zeit) AS letzter FROM android_dauertest');
    const letzter = r.rows[0]?.letzter;
    if (!letzter || Date.now() - new Date(letzter).getTime() < ad.CT_STILL_MS) return;
    const neu = await pool.query(
      `INSERT INTO android_dauertest_still (id, gemeldet_fuer) VALUES (1, $1)
       ON CONFLICT (id) DO NOTHING RETURNING id`, [letzter]);
    if (!neu.rows.length) return;
    const stunden = Math.round((Date.now() - new Date(letzter).getTime()) / 3600000);
    await technikMelden(`⚪ Android-Dauertest: seit ${stunden} h kein Lauf von CT 149 (android-dauertest auf pve2). Emulator oder Timer prüfen.`,
      'Android-Dauertest: kein Lauf');
  } catch (e) { console.warn('[android-dauertest] still:', e.message); }
}

function starten(intervalle) {
  ensureSchema()
    .then(() => { const t = setInterval(stillePruefen, 15 * 60 * 1000); t.unref?.(); intervalle?.push(t); })
    .catch(e => console.error('[android-dauertest] Schema:', e.message));
}

module.exports = { annehmen, lesen, schirmbild, stillePruefen, ensureSchema, starten };
