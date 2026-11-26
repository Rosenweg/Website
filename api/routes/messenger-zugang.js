// ═══════════════════════════════════════════════════════════════════
// Rosenweg Messenger auf dem eigenen Handy: Zugaenge je Geraet
// ═══════════════════════════════════════════════════════════════════
// Ablauf und Sicherheitsgedanken: lib/messenger-zugang.js.
//
//   POST   /api/messenger/zugang            Bearer (App-Token rosenweg-apps oder Portal) -> neuer Zugang
//                                            { geraet, geraet_kennung? }: gleiche Kennung = gleiches Handy,
//                                            der neue Zugang ersetzt den alten (App neu installiert)
//   POST   /api/messenger/zugang/token      { zugang, geheimnis, geraet_kennung? } -> Messenger-Token (1 h)
//   POST   /api/messenger/zugang/abmelden   { zugang, geheimnis } -> Zugang loeschen (App)
//   GET    /api/messenger/zugaenge          eigene Handys; Technik/Praesident mit ?alle=1 alle
//   DELETE /api/messenger/zugaenge/:id      eigenes Handy abmelden, Technik/Praesident jedes
//
// Die beiden Aufrufe mit { zugang, geheimnis } brauchen kein Token: der Zugang
// selbst ist der Ausweis (wie /api/telefon/privat/stand bei Rosenweg Telefon).
// Falsche Angaben -> 401; die App fragt danach nicht weiter.

const express = require('express');
const { pool } = require('../lib/db');
const { authMiddleware, absenderIp } = require('../middleware/auth');
const { isTechnik, isPraesident } = require('../lib/groups');
const mz = require('../lib/messenger-zugang');
const gg = require('../lib/geraet-gruppe');

const MESSENGER_URL = (process.env.MESSENGER_URL || 'https://chat.rosenweg4303.ch').replace(/\/+$/, '');

let schemaVersprechen = null;
function ensureSchema() {
  if (!schemaVersprechen) {
    schemaVersprechen = pool.query(`
      CREATE TABLE IF NOT EXISTS messenger_privat (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        geraet TEXT NOT NULL DEFAULT '',
        geheimnis_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        zuletzt_at TIMESTAMPTZ,
        zuletzt_ip TEXT
      );
      CREATE INDEX IF NOT EXISTS messenger_privat_user ON messenger_privat (user_id);
      -- sha256("rosenweg:"+ANDROID_ID) wie bei Telefon und Karten-Sitzungen (lib/geraet-gruppe.js)
      ALTER TABLE messenger_privat ADD COLUMN IF NOT EXISTS geraet_kennung TEXT;
    `).catch((e) => { schemaVersprechen = null; throw e; });
  }
  return schemaVersprechen;
}

// Broker-Auth (server.js /api/mqtt/*) fragt bei jedem Connect/ACL-Check, ob es
// den Zugang noch gibt. go-auth puffert selbst 60 s; hier zusaetzlich 20 s,
// damit eine Nachrichtenflut nicht jedes Mal die DB trifft.
const gueltigCache = new Map(); // id -> { ok, zeit }
const GUELTIG_MS = 20 * 1000;
async function zugangGueltig(id) {
  const n = mz.zugangId(id);
  if (!n) return false;
  const c = gueltigCache.get(n);
  if (c && Date.now() - c.zeit < GUELTIG_MS) return c.ok;
  await ensureSchema();
  const r = await pool.query(
    `SELECT 1 FROM messenger_privat p JOIN users u ON u.id = p.user_id
      WHERE p.id = $1 AND u.active IS NOT FALSE`, [n]);
  const ok = r.rowCount > 0;
  if (gueltigCache.size > 5000) gueltigCache.clear();
  gueltigCache.set(n, { ok, zeit: Date.now() });
  return ok;
}
const vergiss = (id) => gueltigCache.delete(Number(id));

const darfAlle = (user) => {
  const g = (user && user.groups) || [];
  return isTechnik(g) || isPraesident(g);
};
const gruppenAus = (json) => { try { const g = JSON.parse(json || '[]'); return Array.isArray(g) ? g.map(String) : []; } catch { return []; } };

function messengerZugangRouter({ rateLimitGuard }) {
  const router = express.Router();
  const grenze = (name, max, schluessel) => (req, res, next) => {
    const r = rateLimitGuard(`messenger-zugang-${name}`, schluessel(req), max, 60 * 60 * 1000);
    if (r.ok) return next();
    if (r.retryAfter) res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: 'Zu viele Anfragen — bitte später erneut.' });
  };
  const fehler = (res, e, wo) => {
    console.error(`[messenger-zugang] ${wo}:`, e.message);
    res.status(500).json({ error: 'Interner Fehler' });
  };
  const keinCache = (res) => res.set('Cache-Control', 'no-store');

  // Token fuer eine Zeile ausstellen (users-Daten frisch: Name/Gruppen/aktiv)
  async function tokenFuer(zeile) {
    const schluessel = mz.signierSchluessel();
    if (!schluessel) return null;
    const t = mz.signiereToken({
      userId: zeile.user_id, email: zeile.email, name: zeile.name,
      groups: gruppenAus(zeile.groups_json), zugangId: zeile.id,
    }, schluessel);
    return { token: t.token, gueltig_bis: t.gueltigBis, server: MESSENGER_URL };
  }

  // Zugang mit {zugang, geheimnis} pruefen; Zeile mit users-Daten oder null
  async function zugangAusBody(req) {
    const b = req.body || {};
    const id = mz.zugangId(b.zugang);
    if (!id || typeof b.geheimnis !== 'string') return null;
    await ensureSchema();
    const r = await pool.query(
      `SELECT p.id, p.user_id, p.geheimnis_hash, u.email, u.name, u.groups_json
         FROM messenger_privat p JOIN users u ON u.id = p.user_id
        WHERE p.id = $1 AND u.active IS NOT FALSE`, [id]);
    const z = r.rows[0];
    return z && mz.geheimnisPasst(b.geheimnis, z.geheimnis_hash) ? z : null;
  }

  // ── Neuer Zugang (App nach der Anmeldung mit dem Rosenweg-Konto) ──
  router.post('/zugang', authMiddleware,
    grenze('neu', 10, (req) => String(req.user.user_id || req.user.id)),
    async (req, res) => {
      keinCache(res);
      if (req.pat) return res.status(403).json({ error: 'Nur mit dem Rosenweg-Konto, nicht mit einem API-Token' });
      if (!mz.signierSchluessel()) return res.status(503).json({ error: 'Messenger-Zugang nicht eingerichtet' });
      const uid = Number(req.user.user_id || req.user.id);
      if (!Number.isInteger(uid) || uid <= 0) return res.status(403).json({ error: 'Kein Rosenweg-Konto' });
      const geraet = mz.geraeteName(req.body && req.body.geraet);
      const kennung = gg.kennung(req.body && req.body.geraet_kennung);
      try {
        await ensureSchema();
        const client = await pool.connect();
        let zeile, geheimnis;
        try {
          await client.query('BEGIN');
          // gleichzeitige Anmeldungen derselben Person nacheinander zaehlen
          await client.query('SELECT pg_advisory_xact_lock(43030, $1)', [uid]);
          // Dasselbe Handy (gleiche Kennung): alten Zugang ersetzen, sonst stuende das Handy doppelt da
          if (kennung) {
            const alt = await client.query(
              'DELETE FROM messenger_privat WHERE user_id = $1 AND geraet_kennung = $2 RETURNING id', [uid, kennung]);
            alt.rows.forEach((x) => vergiss(x.id));
            if (alt.rowCount) console.log(`[messenger-zugang] ${alt.rows.map((x) => 'z' + x.id).join(', ')} ersetzt (gleiches Handy)`);
          }
          const n = await client.query('SELECT COUNT(*)::int AS n FROM messenger_privat WHERE user_id = $1', [uid]);
          const max = mz.maxJePerson();
          if (n.rows[0].n >= max) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Schon ${max} Handys mit dem Messenger angemeldet – eines unter Smartphones im Portal abmelden`,
            });
          }
          const g = mz.neuesGeheimnis();
          geheimnis = g.geheimnis;
          const ins = await client.query(
            `INSERT INTO messenger_privat (user_id, geraet, geraet_kennung, geheimnis_hash, zuletzt_at, zuletzt_ip)
             VALUES ($1, $2, $3, $4, NOW(), $5) RETURNING id`, [uid, geraet, kennung, g.hash, absenderIp(req)]);
          const u = await client.query('SELECT id AS user_id, email, name, groups_json FROM users WHERE id = $1', [uid]);
          await client.query('COMMIT');
          zeile = { ...u.rows[0], id: ins.rows[0].id };
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
        vergiss(zeile.id);
        console.log(`[messenger-zugang] Zugang z${zeile.id} fuer users.id ${uid} angelegt (${geraet || 'ohne Namen'})`);
        const t = await tokenFuer(zeile);
        return res.json({ zugang: String(zeile.id), geheimnis, name: zeile.name || '', user_id: String(uid), ...t });
      } catch (e) { return fehler(res, e, 'anlegen'); }
    });

  // ── Messenger-Token holen (laufend, ohne Konto-Token) ──
  router.post('/zugang/token', grenze('token', 600, (req) => absenderIp(req)), async (req, res) => {
    keinCache(res);
    if (!mz.signierSchluessel()) return res.status(503).json({ error: 'Messenger-Zugang nicht eingerichtet' });
    try {
      const z = await zugangAusBody(req);
      if (!z) return res.status(401).json({ error: 'Unbekannter Zugang' });
      // geraet_kennung: Zugaenge aelterer App-Versionen bekommen sie so nachgetragen
      pool.query(`UPDATE messenger_privat SET zuletzt_at = NOW(), zuletzt_ip = $2,
                    geraet_kennung = COALESCE($3, geraet_kennung) WHERE id = $1`,
        [z.id, absenderIp(req), gg.kennung(req.body && req.body.geraet_kennung)]).catch(() => {});
      return res.json({ zugang: String(z.id), name: z.name || '', user_id: String(z.user_id), ...(await tokenFuer(z)) });
    } catch (e) { return fehler(res, e, 'token'); }
  });

  // ── App meldet ab ──
  router.post('/zugang/abmelden', grenze('abmelden', 60, (req) => absenderIp(req)), async (req, res) => {
    keinCache(res);
    try {
      const z = await zugangAusBody(req);
      if (!z) return res.status(401).json({ error: 'Unbekannter Zugang' });
      await pool.query('DELETE FROM messenger_privat WHERE id = $1', [z.id]);
      vergiss(z.id);
      console.log(`[messenger-zugang] Zugang z${z.id} (users.id ${z.user_id}) von der App abgemeldet`);
      return res.json({ ok: true });
    } catch (e) { return fehler(res, e, 'abmelden'); }
  });

  // ── Liste: eigene Handys, Technik alle ──
  router.get('/zugaenge', authMiddleware, async (req, res) => {
    try {
      await ensureSchema();
      const alle = req.query.alle === '1' && darfAlle(req.user);
      if (req.query.alle === '1' && !alle) return res.status(403).json({ error: 'Nur Technik' });
      const uid = Number(req.user.user_id || req.user.id);
      const r = await pool.query(
        `SELECT p.id, p.user_id, p.geraet, p.geraet_kennung, p.created_at, p.zuletzt_at, u.name, u.email
           FROM messenger_privat p JOIN users u ON u.id = p.user_id
          ${alle ? '' : 'WHERE p.user_id = $1'}
          ORDER BY u.name, p.id`, alle ? [] : [uid]);
      return res.json({
        max: mz.maxJePerson(),
        zugaenge: r.rows.map((z) => ({
          id: z.id, kennung: `z${z.id}`, geraet: z.geraet, seit: z.created_at, zuletzt: z.zuletzt_at,
          // dasselbe Handy wie Telefon/Karten-Apps (lib/geraet-gruppe.js); nie die Kennung selbst
          geraet_gruppe: gg.gruppe(z.email, z.geraet_kennung),
          ...(alle ? { user_id: z.user_id, name: z.name, email: z.email } : {}),
        })),
      });
    } catch (e) { return fehler(res, e, 'liste'); }
  });

  // ── Abmelden im Portal: eigenes Handy, Technik/Praesident jedes ──
  router.delete('/zugaenge/:id', authMiddleware, async (req, res) => {
    const id = mz.zugangId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Nicht gefunden' });
    try {
      await ensureSchema();
      const uid = Number(req.user.user_id || req.user.id);
      const technik = darfAlle(req.user);
      const r = await pool.query(
        `DELETE FROM messenger_privat WHERE id = $1 ${technik ? '' : 'AND user_id = $2'} RETURNING user_id, geraet`,
        technik ? [id] : [id, uid]);
      if (!r.rowCount) return res.status(404).json({ error: 'Nicht gefunden' });
      vergiss(id);
      console.log(`[messenger-zugang] Zugang z${id} (users.id ${r.rows[0].user_id}, ${r.rows[0].geraet || 'ohne Namen'}) `
        + `im Portal abgemeldet durch ${req.user.email || uid}${technik && r.rows[0].user_id !== uid ? ' (Technik)' : ''}`);
      return res.json({ ok: true });
    } catch (e) { return fehler(res, e, 'loeschen'); }
  });

  return router;
}

module.exports = { messengerZugangRouter, ensureSchema, zugangGueltig };
