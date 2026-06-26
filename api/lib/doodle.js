// ─────────────────────────────────────────────────────────────────────────
// Sitzungs-Doodle: Terminumfragen für Sitzungen.
//   - Anlegen: jede:r eingeloggte Mitglied (Authentik ODER E-Mail-Code-Session)
//   - Mitstimmen: Mitglieder + pro Umfrage eingeladene externe E-Mails
//     (z.B. Verwaltung) via E-Mail-Code (wie Reklamationen)
//   - Pro Terminvorschlag: Ja / Vielleicht / Nein; Ersteller gibt Optionen vor,
//     kann optional erlauben, dass Teilnehmer eigene Optionen ergänzen.
// Auth: Bearer-Token. Mitglieder = sessions-Tabelle (Authentik/OTP). Externe =
// eigene doodle_sessions (per E-Mail-Code). Beide landen in req.actor.
// ─────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { pool } = require('./db');
const { loggedSendMail, generateOTP, MAIL_FROM } = require('./mail');

const SITE_URL = process.env.SITE_URL || 'https://www.rosenweg4303.ch';
const pollUrl = (id) => `${SITE_URL}/sitzungs-doodle.html` + (id ? `?poll=${id}` : '');
const isAdminGroups = (groups) => (groups || []).some(g => ['technik', 'präsident', 'praesident'].includes(String(g).toLowerCase()));
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VOTE_VALUES = ['ja', 'vielleicht', 'nein'];

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doodle_polls (
      id SERIAL PRIMARY KEY,
      creator_email VARCHAR(255),
      creator_name  VARCHAR(255),
      titel         VARCHAR(255) NOT NULL,
      beschreibung  TEXT,
      ort           VARCHAR(255),
      allow_add_options BOOLEAN NOT NULL DEFAULT false,
      status        VARCHAR(20) NOT NULL DEFAULT 'offen',   -- offen | geschlossen
      final_option_id INTEGER,
      deadline      TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS doodle_options (
      id SERIAL PRIMARY KEY,
      poll_id    INTEGER REFERENCES doodle_polls(id) ON DELETE CASCADE,
      label      VARCHAR(255) NOT NULL,
      starts_at  TIMESTAMPTZ,
      sort_order INTEGER DEFAULT 0,
      added_by   VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS doodle_votes (
      id SERIAL PRIMARY KEY,
      poll_id     INTEGER REFERENCES doodle_polls(id) ON DELETE CASCADE,
      option_id   INTEGER REFERENCES doodle_options(id) ON DELETE CASCADE,
      voter_email VARCHAR(255) NOT NULL,
      voter_name  VARCHAR(255),
      wert        VARCHAR(12) NOT NULL DEFAULT 'ja',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(option_id, voter_email)
    );
    CREATE TABLE IF NOT EXISTS doodle_invites (
      id SERIAL PRIMARY KEY,
      poll_id    INTEGER REFERENCES doodle_polls(id) ON DELETE CASCADE,
      email      VARCHAR(255) NOT NULL,
      name       VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(poll_id, email)
    );
    CREATE TABLE IF NOT EXISTS doodle_sessions (
      token      VARCHAR(64) PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      name       VARCHAR(255),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_doodle_options_poll ON doodle_options(poll_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_doodle_votes_poll   ON doodle_votes(poll_id);
    CREATE INDEX IF NOT EXISTS idx_doodle_invites_poll ON doodle_invites(poll_id);
    CREATE INDEX IF NOT EXISTS idx_doodle_invites_mail ON doodle_invites(LOWER(email));
  `);
}

// ── Actor-Auflösung: Mitglied (sessions) ODER externer Code-Voter (doodle_sessions)
async function resolveActor(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const s = await pool.query(
    `SELECT u.email, u.name, u.role, u.groups_json
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > NOW()`, [token]);
  if (s.rows[0]) {
    let groups = []; try { groups = JSON.parse(s.rows[0].groups_json || '[]'); } catch { /* */ }
    return {
      email: normEmail(s.rows[0].email), name: s.rows[0].name, token,
      isMember: true, isAdmin: s.rows[0].role === 'admin' || isAdminGroups(groups),
    };
  }
  const d = await pool.query('SELECT email, name FROM doodle_sessions WHERE token = $1 AND expires_at > NOW()', [token]);
  if (d.rows[0]) return { email: normEmail(d.rows[0].email), name: d.rows[0].name, token, isMember: false, isAdmin: false };
  return null;
}
function doodleAuth(req, res, next) {
  resolveActor(req).then(a => { if (!a) return res.status(401).json({ error: 'Nicht angemeldet' }); req.actor = a; next(); })
    .catch(e => { console.error('[doodle] auth', e.message); res.status(500).json({ error: 'Auth-Fehler' }); });
}
function memberOnly(req, res, next) {
  if (!req.actor || !req.actor.isMember) return res.status(403).json({ error: 'Nur für eingeloggte Mitglieder' });
  next();
}

// Darf diese E-Mail einen Code bekommen? -> Name (string|null) wenn erlaubt, sonst undefined
async function emailAllowed(email) {
  const p = await pool.query('SELECT name FROM personen WHERE LOWER(email) = $1 LIMIT 1', [email]);
  if (p.rows[0]) return p.rows[0].name || null;
  const u = await pool.query('SELECT name FROM users WHERE LOWER(email) = $1 AND active = true LIMIT 1', [email]);
  if (u.rows[0]) return u.rows[0].name || null;
  const i = await pool.query('SELECT name FROM doodle_invites WHERE LOWER(email) = $1 ORDER BY id DESC LIMIT 1', [email]);
  if (i.rows[0]) return i.rows[0].name || null;
  return undefined;
}

// Zugriff auf eine Umfrage? Mitglieder immer; Externe nur wenn eingeladen.
async function canAccessPoll(actor, pollId) {
  if (actor.isMember) return true;
  const r = await pool.query('SELECT 1 FROM doodle_invites WHERE poll_id = $1 AND LOWER(email) = $2 LIMIT 1', [pollId, actor.email]);
  return r.rows.length > 0;
}

const codeRate = new Map(); // email -> [timestamps]
function rateLimited(email) {
  const now = Date.now();
  const arr = (codeRate.get(email) || []).filter(t => now - t < 600000);
  if (arr.length >= 3) return true;
  arr.push(now); codeRate.set(email, arr);
  return false;
}

function mountDoodle({ app }) {
  initSchema()
    .then(() => console.log('[doodle] Sitzungs-Doodle aktiv'))
    .catch(e => console.error('[doodle] initSchema:', e.message));

  // ── E-Mail-Code anfordern ────────────────────────────────────────────────
  app.post('/api/doodle/code', async (req, res) => {
    try {
      const email = normEmail(req.body?.email);
      if (!validEmail(email)) return res.status(400).json({ error: 'Ungültige E-Mail' });
      if (rateLimited(email)) return res.status(429).json({ error: 'Zu viele Anfragen — bitte in 10 Minuten erneut.' });
      const name = await emailAllowed(email);
      if (name === undefined) return res.status(403).json({ error: 'Diese E-Mail ist (noch) zu keiner Umfrage eingeladen.' });
      const code = generateOTP();
      await pool.query('UPDATE otp_codes SET used = true WHERE email = $1 AND used = false', [email]);
      await pool.query('INSERT INTO otp_codes (email, code, expires_at) VALUES ($1,$2,$3)',
        [email, code, new Date(Date.now() + 10 * 60 * 1000)]);
      await loggedSendMail({
        from: MAIL_FROM, to: email,
        subject: 'Ihr Code für die Terminumfrage – Rosenweg',
        html: `<div style="font-family:sans-serif;max-width:480px">
          <p>Ihr Anmeldecode für die Sitzungs-Terminumfrage:</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:16px 0">${code}</p>
          <p style="color:#666">Gültig für 10 Minuten. Falls Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.</p>
        </div>`,
      }, 'doodle-code');
      res.json({ ok: true });
    } catch (e) { console.error('[doodle] code', e); res.status(500).json({ error: 'Fehler beim Versand' }); }
  });

  // ── Code verifizieren -> doodle_session-Token ────────────────────────────
  app.post('/api/doodle/verify', async (req, res) => {
    try {
      const email = normEmail(req.body?.email);
      const code = String(req.body?.code || '').trim();
      if (!validEmail(email) || !code) return res.status(400).json({ error: 'E-Mail und Code erforderlich' });
      const vr = await pool.query(
        'SELECT id, code, expires_at FROM otp_codes WHERE email = $1 AND used = false ORDER BY created_at DESC LIMIT 1', [email]);
      const row = vr.rows[0];
      if (!row) return res.status(400).json({ error: 'Kein Code gefunden — bitte neu anfordern.' });
      if (new Date() > new Date(row.expires_at)) {
        await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [row.id]);
        return res.status(400).json({ error: 'Code ist abgelaufen.' });
      }
      const a = Buffer.from(row.code), b = Buffer.from(code);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Ungültiger Code' });
      await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [row.id]);
      let name = await emailAllowed(email); if (name === undefined) name = null;
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query('INSERT INTO doodle_sessions (token, email, name, expires_at) VALUES ($1,$2,$3,$4)',
        [token, email, name, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]);
      res.json({ ok: true, token, voter: { email, name } });
    } catch (e) { console.error('[doodle] verify', e); res.status(500).json({ error: 'Fehler' }); }
  });

  // ── Wer bin ich? ─────────────────────────────────────────────────────────
  app.get('/api/doodle/me', doodleAuth, (req, res) => {
    res.json({ email: req.actor.email, name: req.actor.name, isMember: req.actor.isMember, isAdmin: req.actor.isAdmin });
  });

  // ── Umfragen-Liste ───────────────────────────────────────────────────────
  app.get('/api/doodle/polls', doodleAuth, async (req, res) => {
    try {
      const a = req.actor;
      const params = [];
      let where = '';
      if (!a.isMember) { params.push(a.email); where = `WHERE p.id IN (SELECT poll_id FROM doodle_invites WHERE LOWER(email) = $1)`; }
      const r = await pool.query(
        `SELECT p.id, p.titel, p.ort, p.status, p.deadline, p.created_at, p.creator_name, p.final_option_id,
                (SELECT COUNT(*) FROM doodle_options o WHERE o.poll_id = p.id) AS options_count,
                (SELECT COUNT(DISTINCT voter_email) FROM doodle_votes v WHERE v.poll_id = p.id) AS voters_count,
                EXISTS(SELECT 1 FROM doodle_votes v WHERE v.poll_id = p.id AND LOWER(v.voter_email) = $${params.push(a.email)}) AS i_voted
           FROM doodle_polls p ${where}
          ORDER BY (p.status = 'offen') DESC, p.created_at DESC LIMIT 300`, params);
      res.json({ polls: r.rows, me: { email: a.email, name: a.name, isMember: a.isMember, isAdmin: a.isAdmin } });
    } catch (e) { console.error('[doodle] list', e); res.status(500).json({ error: 'Fehler' }); }
  });

  // ── Umfrage anlegen (nur Mitglieder) ─────────────────────────────────────
  app.post('/api/doodle/polls', doodleAuth, memberOnly, async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      const titel = String(b.titel || '').trim().slice(0, 255);
      if (!titel) return res.status(400).json({ error: 'Titel erforderlich' });
      const options = Array.isArray(b.options) ? b.options
        .map(o => ({ label: String(o.label || '').trim().slice(0, 255), starts_at: o.starts_at || null }))
        .filter(o => o.label) : [];
      if (options.length < 1) return res.status(400).json({ error: 'Mindestens ein Terminvorschlag erforderlich' });
      const invites = Array.isArray(b.invites) ? b.invites
        .map(i => (typeof i === 'string' ? { email: normEmail(i), name: null } : { email: normEmail(i.email), name: i.name || null }))
        .filter(i => validEmail(i.email)) : [];
      const beschreibung = b.beschreibung ? String(b.beschreibung).trim().slice(0, 4000) : null;
      const ort = b.ort ? String(b.ort).trim().slice(0, 255) : null;
      const deadline = b.deadline ? new Date(b.deadline) : null;
      const allowAdd = !!b.allow_add_options;

      await client.query('BEGIN');
      const pr = await client.query(
        `INSERT INTO doodle_polls (creator_email, creator_name, titel, beschreibung, ort, allow_add_options, deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.actor.email, req.actor.name, titel, beschreibung, ort, allowAdd, deadline && !isNaN(deadline) ? deadline : null]);
      const pollId = pr.rows[0].id;
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const sa = o.starts_at ? new Date(o.starts_at) : null;
        await client.query('INSERT INTO doodle_options (poll_id, label, starts_at, sort_order) VALUES ($1,$2,$3,$4)',
          [pollId, o.label, sa && !isNaN(sa) ? sa : null, i]);
      }
      for (const inv of invites) {
        await client.query('INSERT INTO doodle_invites (poll_id, email, name) VALUES ($1,$2,$3) ON CONFLICT (poll_id, email) DO NOTHING',
          [pollId, inv.email, inv.name]);
      }
      await client.query('COMMIT');

      // Einladungs-Mails (best effort, ausserhalb der Transaktion)
      for (const inv of invites) {
        loggedSendMail({
          from: MAIL_FROM, to: inv.email,
          subject: `Terminumfrage: ${titel} – bitte abstimmen`,
          html: `<div style="font-family:sans-serif;max-width:560px">
            <p>Hallo${inv.name ? ' ' + esc(inv.name) : ''},</p>
            <p>${esc(req.actor.name || 'Die Rosenweg-Gemeinschaft')} lädt dich zu einer Terminumfrage ein:</p>
            <p style="font-size:18px;font-weight:bold">${esc(titel)}</p>
            ${ort ? `<p>📍 ${esc(ort)}</p>` : ''}
            ${beschreibung ? `<p>${esc(beschreibung)}</p>` : ''}
            <p><a href="${pollUrl(pollId)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Jetzt abstimmen</a></p>
            <p style="color:#666;font-size:13px">Beim Öffnen meldest du dich einfach mit dieser E-Mail-Adresse an — du erhältst dann einen kurzen Code per Mail.</p>
          </div>`,
        }, 'doodle-invite').catch(e => console.warn('[doodle] invite-mail', e.message));
      }
      res.json({ ok: true, poll_id: pollId });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* */ }
      console.error('[doodle] create', e); res.status(500).json({ error: 'Fehler beim Anlegen' });
    } finally { client.release(); }
  });

  // ── Umfrage-Details + Ergebnisse ─────────────────────────────────────────
  app.get('/api/doodle/polls/:id', doodleAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
      if (!(await canAccessPoll(req.actor, id))) return res.status(403).json({ error: 'Kein Zugriff auf diese Umfrage' });
      const pr = await pool.query('SELECT * FROM doodle_polls WHERE id = $1', [id]);
      const poll = pr.rows[0];
      if (!poll) return res.status(404).json({ error: 'Nicht gefunden' });
      const opts = await pool.query('SELECT id, label, starts_at, sort_order, added_by FROM doodle_options WHERE poll_id = $1 ORDER BY sort_order, id', [id]);
      const votes = await pool.query('SELECT option_id, voter_email, voter_name, wert FROM doodle_votes WHERE poll_id = $1', [id]);
      const canManage = req.actor.isMember && (req.actor.isAdmin || normEmail(poll.creator_email) === req.actor.email);
      const out = {
        poll: {
          id: poll.id, titel: poll.titel, beschreibung: poll.beschreibung, ort: poll.ort,
          allow_add_options: poll.allow_add_options, status: poll.status, final_option_id: poll.final_option_id,
          deadline: poll.deadline, creator_name: poll.creator_name, created_at: poll.created_at,
        },
        options: opts.rows,
        votes: votes.rows,
        me: { email: req.actor.email, name: req.actor.name, isMember: req.actor.isMember, canManage },
      };
      if (canManage) {
        const inv = await pool.query('SELECT email, name FROM doodle_invites WHERE poll_id = $1 ORDER BY id', [id]);
        out.invites = inv.rows;
      }
      res.json(out);
    } catch (e) { console.error('[doodle] detail', e); res.status(500).json({ error: 'Fehler' }); }
  });

  // ── Abstimmen (+ optional eigene Optionen ergänzen) ──────────────────────
  app.post('/api/doodle/polls/:id/vote', doodleAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
      if (!(await canAccessPoll(req.actor, id))) return res.status(403).json({ error: 'Kein Zugriff' });
      const pr = await pool.query('SELECT id, status, allow_add_options FROM doodle_polls WHERE id = $1', [id]);
      const poll = pr.rows[0];
      if (!poll) return res.status(404).json({ error: 'Nicht gefunden' });
      if (poll.status !== 'offen') return res.status(409).json({ error: 'Diese Umfrage ist geschlossen' });

      const b = req.body || {};
      const voterName = (b.name ? String(b.name).trim().slice(0, 255) : null) || req.actor.name || null;
      const votes = b.votes && typeof b.votes === 'object' ? b.votes : {};
      const newOptions = (poll.allow_add_options && Array.isArray(b.new_options))
        ? b.new_options.map(l => String(l || '').trim().slice(0, 255)).filter(Boolean).slice(0, 20) : [];

      await client.query('BEGIN');
      // neue Optionen anlegen
      const newIds = [];
      if (newOptions.length) {
        const mx = await client.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM doodle_options WHERE poll_id = $1', [id]);
        let so = (mx.rows[0].m | 0) + 1;
        for (const label of newOptions) {
          const r = await client.query('INSERT INTO doodle_options (poll_id, label, sort_order, added_by) VALUES ($1,$2,$3,$4) RETURNING id',
            [id, label, so++, req.actor.email]);
          newIds.push(r.rows[0].id);
        }
      }
      // gültige Options-IDs dieser Umfrage
      const valid = await client.query('SELECT id FROM doodle_options WHERE poll_id = $1', [id]);
      const validSet = new Set(valid.rows.map(r => r.id));
      // Stimmen dieses Voters ersetzen
      if (b.name) await client.query('UPDATE doodle_sessions SET name = $1 WHERE token = $2', [voterName, req.actor.token]).catch(() => {});
      await client.query('DELETE FROM doodle_votes WHERE poll_id = $1 AND LOWER(voter_email) = $2', [id, req.actor.email]);
      for (const [optId, wert] of Object.entries(votes)) {
        const oid = parseInt(optId, 10);
        if (!validSet.has(oid) || !VOTE_VALUES.includes(wert)) continue;
        await client.query(
          'INSERT INTO doodle_votes (poll_id, option_id, voter_email, voter_name, wert) VALUES ($1,$2,$3,$4,$5)',
          [id, oid, req.actor.email, voterName, wert]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, new_option_ids: newIds });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* */ }
      console.error('[doodle] vote', e); res.status(500).json({ error: 'Fehler beim Abstimmen' });
    } finally { client.release(); }
  });

  // ── Umfrage verwalten: schliessen / Termin festlegen / wieder öffnen ──────
  app.put('/api/doodle/polls/:id', doodleAuth, memberOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ungültige ID' });
      const pr = await pool.query('SELECT * FROM doodle_polls WHERE id = $1', [id]);
      const poll = pr.rows[0];
      if (!poll) return res.status(404).json({ error: 'Nicht gefunden' });
      if (!req.actor.isAdmin && normEmail(poll.creator_email) !== req.actor.email)
        return res.status(403).json({ error: 'Nur Ersteller:in oder Admin' });
      const b = req.body || {};
      const sets = [], params = [];
      if (b.status && ['offen', 'geschlossen'].includes(b.status)) { params.push(b.status); sets.push(`status = $${params.length}`); }
      if ('final_option_id' in b) {
        let fid = b.final_option_id == null ? null : parseInt(b.final_option_id, 10);
        if (fid != null) { const ck = await pool.query('SELECT 1 FROM doodle_options WHERE id = $1 AND poll_id = $2', [fid, id]); if (!ck.rows[0]) fid = null; }
        params.push(fid); sets.push(`final_option_id = $${params.length}`);
      }
      if (typeof b.titel === 'string' && b.titel.trim()) { params.push(b.titel.trim().slice(0, 255)); sets.push(`titel = $${params.length}`); }
      if (!sets.length) return res.status(400).json({ error: 'Nichts zu ändern' });
      params.push(id);
      await pool.query(`UPDATE doodle_polls SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);

      // Bei Schliessen mit finalem Termin: Teilnehmer informieren
      if (b.status === 'geschlossen' && b.final_option_id) {
        const fo = await pool.query('SELECT label, starts_at FROM doodle_options WHERE id = $1', [parseInt(b.final_option_id, 10)]);
        const label = fo.rows[0]?.label;
        if (label) {
          const rec = await pool.query(
            `SELECT DISTINCT email FROM (
               SELECT voter_email AS email FROM doodle_votes WHERE poll_id = $1
               UNION SELECT email FROM doodle_invites WHERE poll_id = $1
             ) t WHERE email IS NOT NULL`, [id]);
          for (const r of rec.rows) {
            loggedSendMail({
              from: MAIL_FROM, to: r.email,
              subject: `Termin steht fest: ${poll.titel}`,
              html: `<div style="font-family:sans-serif;max-width:560px">
                <p>Der Termin für <b>${esc(poll.titel)}</b> steht fest:</p>
                <p style="font-size:18px;font-weight:bold">${esc(label)}</p>
                ${poll.ort ? `<p>📍 ${esc(poll.ort)}</p>` : ''}
                <p><a href="${pollUrl(id)}">Zur Umfrage</a></p>
              </div>`,
            }, 'doodle-result').catch(e => console.warn('[doodle] result-mail', e.message));
          }
        }
      }
      res.json({ ok: true });
    } catch (e) { console.error('[doodle] update', e); res.status(500).json({ error: 'Fehler' }); }
  });

  // ── Umfrage löschen (Ersteller/Admin) ────────────────────────────────────
  app.delete('/api/doodle/polls/:id', doodleAuth, memberOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const pr = await pool.query('SELECT creator_email FROM doodle_polls WHERE id = $1', [id]);
      if (!pr.rows[0]) return res.status(404).json({ error: 'Nicht gefunden' });
      if (!req.actor.isAdmin && normEmail(pr.rows[0].creator_email) !== req.actor.email)
        return res.status(403).json({ error: 'Nur Ersteller:in oder Admin' });
      await pool.query('DELETE FROM doodle_polls WHERE id = $1', [id]);
      res.json({ ok: true });
    } catch (e) { console.error('[doodle] delete', e); res.status(500).json({ error: 'Fehler' }); }
  });
}

module.exports = { mountDoodle };
