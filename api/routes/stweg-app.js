// Rosenweg STWEG (App „Meine Gemeinschaft“): Gemeinschaften des Kontos,
// Mitteilungen (Markdown, Liste von Eintraegen) und deren Bilder.
// Regeln: lib/stweg-app.js. Die alten Abschnitte (stweg_sections) werden beim
// Start einmal als Mitteilungen uebernommen; die alte Tabelle bleibt unveraendert.
const express = require('express');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { getUserPermissions } = require('../lib/auth');
const kartenAdmin = require('../lib/kartenadmin');
const { isTechnik, isPraesident } = require('../lib/groups');
const app = require('../lib/stweg-app');
const text = require('../lib/mitteilungen-text');

const router = express.Router();
const optional = (req, res, next) => (req.headers.authorization ? authMiddleware(req, res, next) : next());

const SANITIZE = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'code', 'hr', 'img'],
  allowedAttributes: { a: ['href', 'rel'], img: ['src', 'alt'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) },
};
const zuHtml = (md) => sanitizeHtml(text.markdownZuHtml(md), SANITIZE);

const LABEL = { willkommen: 'Willkommen', aktuelles: 'Aktuelles', infos: 'Wichtige Infos', termine: 'Termine' };

async function tabellen() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stweg_mitteilungen (
    id BIGSERIAL PRIMARY KEY, stweg INTEGER NOT NULL, titel TEXT NOT NULL, text_md TEXT NOT NULL DEFAULT '',
    sichtbarkeit TEXT NOT NULL DEFAULT 'bewohner', wichtig BOOLEAN NOT NULL DEFAULT false,
    angeheftet BOOLEAN NOT NULL DEFAULT false, gueltig_bis DATE,
    erstellt TIMESTAMPTZ NOT NULL DEFAULT NOW(), erstellt_von TEXT,
    geaendert TIMESTAMPTZ NOT NULL DEFAULT NOW(), geaendert_von TEXT,
    geloescht_am TIMESTAMPTZ, herkunft TEXT UNIQUE)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stweg_mitteilungen_stweg ON stweg_mitteilungen (stweg, geloescht_am)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stweg_mitteilungen_verlauf (
    id BIGSERIAL PRIMARY KEY, mitteilung_id BIGINT NOT NULL, zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    wer TEXT, aktion TEXT NOT NULL, titel TEXT, text_md TEXT, sichtbarkeit TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stweg_bilder (
    id TEXT PRIMARY KEY, stweg INTEGER NOT NULL, typ TEXT NOT NULL, daten BYTEA NOT NULL,
    erstellt TIMESTAMPTZ NOT NULL DEFAULT NOW(), erstellt_von TEXT)`);
}

async function bildSpeichern(stweg, typ, bytes, wer) {
  const id = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO stweg_bilder (id, stweg, typ, daten, erstellt_von) VALUES ($1,$2,$3,$4,$5)', [id, stweg, typ, bytes, wer]);
  return id;
}

// Einmalige, wiederholbare Uebernahme: je Abschnitt ein Eintrag (herkunft eindeutig). Sichtbarkeit
// bleibt wie bisher 'oeffentlich'; Willkommen und Wichtige Infos angeheftet.
async function sectionsUebernehmen() {
  const t = await pool.query(`SELECT to_regclass('stweg_sections') AS t`);
  if (!t.rows[0].t) return 0;
  const r = await pool.query('SELECT stweg, section, html, updated_at, updated_by FROM stweg_sections ORDER BY stweg, section');
  let n = 0;
  for (const x of r.rows) {
    if (!String(x.html || '').trim()) continue;
    const herkunft = `stweg_sections:${x.stweg}:${x.section}`;
    if ((await pool.query('SELECT 1 FROM stweg_mitteilungen WHERE herkunft=$1', [herkunft])).rows.length) continue;
    const { md, bilder } = text.htmlZuMarkdown(x.html);
    let t2 = md;
    for (const b of bilder) {
      const id = await bildSpeichern(x.stweg, b.typ, b.bytes, x.updated_by || null);
      t2 = t2.split(`bild:${b.platzhalter}`).join(`bild:${id}`);
    }
    if (!t2.trim()) continue;
    await pool.query(
      `INSERT INTO stweg_mitteilungen (stweg, titel, text_md, sichtbarkeit, angeheftet, erstellt, erstellt_von, geaendert, geaendert_von, herkunft)
       VALUES ($1,$2,$3,'oeffentlich',$4,$5,$6,$5,$6,$7) ON CONFLICT (herkunft) DO NOTHING`,
      [x.stweg, LABEL[x.section] || x.section, t2, x.section === 'willkommen' || x.section === 'infos', x.updated_at, x.updated_by || null, herkunft]);
    n++;
  }
  return n;
}
const bereit = tabellen().then(() => new Promise(r => setTimeout(r, 3000))).then(sectionsUebernehmen)
  .then(n => { if (n) console.log(`[stweg-mitteilungen] ${n} alte Abschnitte uebernommen`); })
  .catch(e => console.error('[stweg-mitteilungen] Start:', e.message));

const seitenRecht = async (user) => (await getUserPermissions(user?.groups || []))[app.SEITE] || 'none';
const admin = (user) => isTechnik(user?.groups || []) || isPraesident(user?.groups || []) || user?.isAdmin === true;

function zeile(r, schreiber) {
  const o = {
    id: Number(r.id), stweg: r.stweg, titel: r.titel, text: r.text_md, html: zuHtml(r.text_md),
    sichtbarkeit: r.sichtbarkeit, wichtig: r.wichtig, angeheftet: r.angeheftet,
    gueltig_bis: r.gueltig_bis ? new Date(r.gueltig_bis).toISOString().slice(0, 10) : null,
    erstellt: r.erstellt, geaendert: r.geaendert,
  };
  if (schreiber) { o.von = r.geaendert_von || r.erstellt_von || null; o.abgelaufen = !!r.abgelaufen; }
  return o;
}

// GET /api/stweg/meine
router.get('/meine', authMiddleware, async (req, res) => {
  try {
    const g = req.user?.groups || [];
    const rechte = await getUserPermissions(g);
    const mod = await pool.query('SELECT stweg, module FROM stweg_modules WHERE active = true');
    const module = {};
    for (const m of mod.rows) if (app.MODULE.includes(m.module)) (module[m.stweg] = module[m.stweg] || []).push(m.module);
    res.json({
      stwegs: app.meineStwegs(g, rechte, req.user?.isAdmin === true).map(s => ({ ...s, module: module[s.nr] || [] })),
      kooperation: { schreiben: app.mitteilungSchreibenErlaubt(g, app.KOOPERATION, 'none', req.user?.isAdmin === true) },
    });
  } catch (e) { console.error('[stweg/meine]', e.message); res.status(500).json({ error: 'Gemeinschaften konnten nicht geladen werden' }); }
});

function nrPruefen(req, res, next) {
  const nr = parseInt(req.params.nr, 10);
  if (!app.gueltigeNr(nr)) return res.status(404).json({ error: 'Gemeinschaft nicht gefunden' });
  req.nr = nr;
  next();
}

// GET /api/stweg/:nr/mitteilungen[?wichtig=1][&alle=1] (nr 0 = Kooperation). Ohne Anmeldung nur 'oeffentlich'.
router.get('/:nr/mitteilungen', optional, nrPruefen, async (req, res) => {
  try {
    const g = req.user ? (req.user.groups || []) : null;
    const darfSchreiben = !!req.user && app.mitteilungSchreibenErlaubt(g, req.nr, await seitenRecht(req.user), req.user.isAdmin === true);
    const erlaubt = [...app.sichtbarkeitenFuer(g, req.nr)];
    if (darfSchreiben) for (const s of app.SICHTBARKEITEN) if (!erlaubt.includes(s)) erlaubt.push(s);
    const alle = darfSchreiben && req.query.alle === '1';
    const r = await pool.query(
      `SELECT *, (gueltig_bis IS NOT NULL AND gueltig_bis < CURRENT_DATE) AS abgelaufen FROM stweg_mitteilungen
        WHERE stweg=$1 AND geloescht_am IS NULL AND sichtbarkeit = ANY($2::text[])
          AND ($3 OR gueltig_bis IS NULL OR gueltig_bis >= CURRENT_DATE) AND ($4 = false OR wichtig)
        ORDER BY angeheftet DESC, erstellt DESC, id DESC LIMIT 100`,
      [req.nr, erlaubt, alle, req.query.wichtig === '1']);
    res.json({ stweg: req.nr, name: app.stwegName(req.nr), darf: { schreiben: darfSchreiben }, mitteilungen: r.rows.map(x => zeile(x, darfSchreiben)) });
  } catch (e) { console.error('[mitteilungen]', e.message); res.status(500).json({ error: 'Mitteilungen konnten nicht geladen werden' }); }
});

async function schreibGate(req, res, next) {
  try {
    const g = req.user?.groups || [];
    if (!app.mitteilungSchreibenErlaubt(g, req.nr, await seitenRecht(req.user), req.user?.isAdmin === true)) {
      return res.status(403).json({ error: req.nr === app.KOOPERATION
        ? 'Kooperations-Mitteilungen schreiben nur Technik und Präsident'
        : `Mitteilungen der ${app.stwegName(req.nr)} schreiben nur Ausschuss und Verwaltung dieser Gemeinschaft (Recht „stweg-mitteilungen“)` });
    }
    if (admin(req.user)) kartenAdmin.vermerken(req, res);
    next();
  } catch (e) { res.status(500).json({ error: 'Rechte konnten nicht geprüft werden' }); }
}
const wer = (req) => req.user?.email || req.user?.name || null;
const verlauf = (id, req, aktion, r) => pool.query(
  'INSERT INTO stweg_mitteilungen_verlauf (mitteilung_id, wer, aktion, titel, text_md, sichtbarkeit) VALUES ($1,$2,$3,$4,$5,$6)',
  [id, wer(req), aktion, r?.titel ?? null, r?.text_md ?? null, r?.sichtbarkeit ?? null]);

router.post('/:nr/mitteilungen', authMiddleware, nrPruefen, schreibGate, async (req, res) => {
  try {
    const f = app.mitteilungAusFormular(req.body);
    if (f.error) return res.status(f.status).json({ error: f.error, feld: f.feld });
    const w = f.werte;
    const r = await pool.query(
      `INSERT INTO stweg_mitteilungen (stweg, titel, text_md, sichtbarkeit, wichtig, angeheftet, gueltig_bis, erstellt_von, geaendert_von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [req.nr, w.titel, w.text, w.sichtbarkeit, w.wichtig, w.angeheftet, w.gueltig_bis, wer(req)]);
    await verlauf(r.rows[0].id, req, 'angelegt', r.rows[0]);
    res.status(201).json(zeile(r.rows[0], true));
  } catch (e) { console.error('[mitteilungen]', e.message); res.status(500).json({ error: 'Speichern fehlgeschlagen' }); }
});

router.put('/:nr/mitteilungen/:id', authMiddleware, nrPruefen, schreibGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const alt = await pool.query('SELECT * FROM stweg_mitteilungen WHERE id=$1 AND stweg=$2 AND geloescht_am IS NULL', [id, req.nr]);
    if (!alt.rows.length) return res.status(404).json({ error: 'Mitteilung nicht gefunden' });
    const f = app.mitteilungAusFormular(req.body, { teilweise: true });
    if (f.error) return res.status(f.status).json({ error: f.error, feld: f.feld });
    const w = { titel: alt.rows[0].titel, text: alt.rows[0].text_md, sichtbarkeit: alt.rows[0].sichtbarkeit, wichtig: alt.rows[0].wichtig,
      angeheftet: alt.rows[0].angeheftet, gueltig_bis: alt.rows[0].gueltig_bis, ...f.werte };
    await verlauf(id, req, 'vorher', alt.rows[0]); // die alte Fassung bleibt im Verlauf
    const r = await pool.query(
      `UPDATE stweg_mitteilungen SET titel=$3, text_md=$4, sichtbarkeit=$5, wichtig=$6, angeheftet=$7, gueltig_bis=$8,
              geaendert=NOW(), geaendert_von=$9 WHERE id=$1 AND stweg=$2 RETURNING *`,
      [id, req.nr, w.titel, w.text, w.sichtbarkeit, w.wichtig, w.angeheftet, w.gueltig_bis, wer(req)]);
    await verlauf(id, req, 'geaendert', r.rows[0]);
    res.json(zeile(r.rows[0], true));
  } catch (e) { console.error('[mitteilungen]', e.message); res.status(500).json({ error: 'Speichern fehlgeschlagen' }); }
});

// Loeschen = ausblenden (geloescht_am); Text und Verlauf bleiben erhalten.
router.delete('/:nr/mitteilungen/:id', authMiddleware, nrPruefen, schreibGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('UPDATE stweg_mitteilungen SET geloescht_am=NOW(), geaendert_von=$3 WHERE id=$1 AND stweg=$2 AND geloescht_am IS NULL RETURNING *', [id, req.nr, wer(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Mitteilung nicht gefunden' });
    await verlauf(id, req, 'geloescht', r.rows[0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Löschen fehlgeschlagen' }); }
});

router.get('/:nr/mitteilungen/:id/verlauf', authMiddleware, nrPruefen, schreibGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await pool.query('SELECT 1 FROM stweg_mitteilungen WHERE id=$1 AND stweg=$2', [id, req.nr]);
    if (!ok.rows.length) return res.status(404).json({ error: 'Mitteilung nicht gefunden' });
    const r = await pool.query('SELECT zeit, wer, aktion, titel, sichtbarkeit FROM stweg_mitteilungen_verlauf WHERE mitteilung_id=$1 ORDER BY id DESC LIMIT 200', [id]);
    res.json({ verlauf: r.rows });
  } catch (e) { res.status(500).json({ error: 'Verlauf konnte nicht geladen werden' }); }
});

// Bild hochladen (roh, Content-Type image/*): -> { id, text: '![](bild:<id>)' }
router.post('/:nr/bilder', authMiddleware, nrPruefen, schreibGate,
  express.raw({ type: app.BILD_TYPEN, limit: app.BILD_MAX }), async (req, res) => {
    try {
      const typ = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!app.bildTypPruefen(typ, req.body)) return res.status(400).json({ error: 'Nur Bilder (JPEG, PNG, WebP, GIF) bis 8 MB' });
      const id = await bildSpeichern(req.nr, typ, req.body, wer(req));
      res.status(201).json({ id, text: `![](bild:${id})` });
    } catch (e) { res.status(500).json({ error: 'Bild konnte nicht gespeichert werden' }); }
  });

module.exports = { router, bereit, sectionsUebernehmen };

// GET /api/stweg-bilder/:id – eigener Router, weil der Pfad nicht unter /api/stweg liegt.
// Zugriff: wer eine Mitteilung lesen darf, die das Bild benutzt; noch unbenutzte Bilder nur
// die Schreibenden der STWEG. Oeffentliche Mitteilungen: ohne Anmeldung.
const bilder = express.Router();
bilder.get('/:id', optional, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!text.BILD_ID.test(id)) return res.status(404).end();
    const b = await pool.query('SELECT stweg, typ, daten FROM stweg_bilder WHERE id=$1', [id]);
    if (!b.rows.length) return res.status(404).end();
    const g = req.user ? (req.user.groups || []) : null;
    const m = await pool.query(
      `SELECT stweg, sichtbarkeit FROM stweg_mitteilungen WHERE geloescht_am IS NULL AND text_md LIKE $1
          AND (gueltig_bis IS NULL OR gueltig_bis >= CURRENT_DATE)`, [`%bild:${id}%`]);
    let ok = m.rows.some(x => app.sichtbarkeitenFuer(g, x.stweg).has(x.sichtbarkeit));
    if (!ok && req.user) ok = app.mitteilungSchreibenErlaubt(g, b.rows[0].stweg, await seitenRecht(req.user), req.user.isAdmin === true);
    if (!ok) return res.status(req.user ? 403 : 401).end();
    res.set('Content-Type', b.rows[0].typ).set('Cache-Control', 'private, max-age=86400').set('X-Content-Type-Options', 'nosniff').send(b.rows[0].daten);
  } catch (e) { res.status(500).end(); }
});
module.exports.bilder = bilder;
