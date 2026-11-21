// ═══════════════════════════════════════════════════════════════════
// RAUM-QR: Tuerschilder und Aushaenge mit Token-QR-Codes
// ═══════════════════════════════════════════════════════════════════
// Die QR-Codes auf Tuerschildern und Postern enthalten einen Zufalls-Token
// (Tabelle raum_qr). Nur wer den Code scannt, sieht die Raum-Infos auf
// /raum.html?t=<token>; ohne gueltigen Token zeigt die Seite nichts.
// Die Druckvorlagen liegen hier im API-Image (api/vorlagen/aushaenge/) und
// werden nur angemeldeten Personen mit Reklamations-Rechten ausgegeben –
// das Repo ist oeffentlich, Tokens duerfen daher nie in Dateien stehen.
// Rechte wie bei den Melde-Orten (requirePermission('reklamationen', …)).
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { pool } = require('../lib/db');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { SITE_URL } = require('../lib/config');

const router = express.Router();
const VORLAGEN_DIR = path.join(__dirname, '..', 'vorlagen', 'aushaenge');

// ─── Inhalte je Raum ────────────────────────────────────────────────
// Bausteine: text (HTML, nur von uns geschrieben), liste, kontakt
// (technik|verwaltung|meg, Daten laedt die Seite aus den oeffentlichen
// APIs), notruf, defekt, link. Die Abschnitts-IDs sind die "themen", fuer
// die je ein Token erzeugt wird; sie entsprechen den {{QR:<thema>}} der Vorlagen.
const zugang = raum => ({ t: 'text', html: `<p>Der ${raum} ist abgeschlossen. Zutritt nur für Hauswart, berechtigte Bewohnerinnen und Bewohner sowie beauftragte Servicetechniker.</p><p>Schlüssel und Zutrittsberechtigungen vergibt der <strong>Technische Dienst</strong>. Bitte Schlüssel nicht weitergeben und die Tür nach dem Verlassen immer verschliessen.</p>` });
const unterlagen = was => ({ t: 'text', html: `<p>${was} sind aus Sicherheitsgründen nicht öffentlich. Berechtigte Fachpersonen erhalten sie beim <strong>Technischen Dienst</strong>.</p>` });
const kontakt = wer => ({ t: 'kontakt', wer });

const RAEUME = {
  heizung: {
    titel: '🔥 Heizungs- und Technikraum', sub: 'Zentrale Heizungsanlage für alle 8 Gebäude',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'zugang', titel: '🔑 Schlüssel & Zugang', bloecke: [zugang('Heizungs- und Technikraum')] },
      { id: 'notfall', titel: '🚨 Notfall & Service', bloecke: [
        { t: 'text', html: '<p><strong>Heizungsausfall, Wasseraustritt oder Gasgeruch:</strong> bei Gefahr sofort die Feuerwehr, sonst den Technischen Dienst anrufen.</p>' },
        { t: 'notruf' }, kontakt('technik'), { t: 'defekt' }] },
    ],
  },
  waschkueche: {
    titel: '🧺 Waschküche', sub: 'Gemeinschaftliche Waschküche',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'regeln', titel: '📅 Regeln & Buchung', bloecke: [
        { t: 'liste', items: ['Mo–Sa: 07:00–22:00 Uhr', 'Sonntag und Feiertage: Ruhetag', 'Waschen nur mit Reservation',
          'Fenster geschlossen halten; zum Trocknen Trockner oder die fest verbauten Wäscheleinen nutzen',
          'Maschinen und Raum nach Gebrauch sauber hinterlassen'] },
        { t: 'link', href: 'https://stweg3.rosenweg4303.ch/#waschkueche', text: 'Waschküche reservieren' }] },
      { id: 'zugang', titel: '🔑 Schlüssel & Zugang', bloecke: [
        { t: 'text', html: '<p>Zugang und Schlüssel für die Waschküche erhalten Bewohnerinnen und Bewohner über den <strong>Technischen Dienst</strong>. Defekte an Maschinen bitte sofort melden.</p>' },
        { t: 'defekt' }] },
    ],
  },
  lift: {
    titel: '🛗 Liftmaschinenraum', sub: 'Rosenweg 7–43 · Kaiseraugst',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'servicefirma', titel: '🔧 Liftfirma', bloecke: [
        { t: 'text', html: '<p>Wartung und Störungsbehebung der Lifte erfolgen durch <strong>Otis</strong>. Aufträge an Otis laufen über den <strong>Technischen Dienst</strong> bzw. die Verwaltung.</p>' },
        kontakt('technik')] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p><strong>Im Lift eingeschlossen?</strong> Ruhe bewahren und die <strong>Notruftaste im Lift</strong> drücken; sie ist direkt mit der Notrufzentrale von Otis verbunden. Bei Rauch oder Feuer: Feuerwehr 118.</p>' },
        { t: 'notruf' }] },
    ],
  },
  telekom: {
    titel: '📡 Telekommunikation', sub: 'Zentrale Telekommunikationsanlage für alle 8 Gebäude',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik')] },
      { id: 'dokumentation', titel: '📄 Dokumentation', bloecke: [unterlagen('Netzwerkplan und Anlagendokumentation')] },
      { id: 'support', titel: '🛠 Störungen & Support', bloecke: [
        { t: 'text', html: '<p>Die Erschliessung der Gebäude (Glasfaser) stammt von der <strong>Swisscom</strong>.</p><p>Internet, TV oder Telefon gestört? Bitte zuerst den <strong>Technischen Dienst</strong> informieren; er klärt, ob die Hausanlage, die Swisscom-Erschliessung oder der eigene Anbieter zuständig ist.</p>' },
        kontakt('technik'), { t: 'defekt' }] },
    ],
  },
  hauptverteilung: {
    titel: '⚡ Hauptverteilung', sub: 'Elektrische Hauptverteilung für alle 8 Gebäude',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('technik'), kontakt('verwaltung')] },
      { id: 'schema', titel: '📐 Schaltschema', bloecke: [unterlagen('Verteilplan und Schaltschema'),
        { t: 'text', html: '<p><strong>Arbeiten an der Anlage nur durch konzessionierte Elektrofachpersonen.</strong></p>' }] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p><strong>Lebensgefahr – Hochspannung.</strong> Bei Brand, Rauch oder Stromunfall sofort Notruf wählen; verunfallte Personen erst berühren, wenn der Strom abgeschaltet ist. Stromausfall im Haus: Technischen Dienst anrufen.</p>' },
        { t: 'notruf' }, kontakt('technik')] },
    ],
  },
  tiefgarage: {
    titel: '🚗 Tiefgarage', sub: 'MEG Rosenweg', org: 'MEG Rosenweg',
    teile: [
      { id: 'ansprechpartner', titel: '👤 Ansprechpartner', bloecke: [kontakt('meg'), kontakt('technik')] },
      { id: 'hausordnung', titel: '📋 Hausordnung', bloecke: [
        { t: 'text', html: '<p><strong>Erlaubt</strong></p>' },
        { t: 'liste', items: ['Parkieren von Fahrzeugen', 'Fahrzeugpflege', 'Fahrräder und E-Bikes'] },
        { t: 'text', html: '<p><strong>Verboten</strong></p>' },
        { t: 'liste', items: ['Lagern von brennbaren Flüssigkeiten und gefährlichen Stoffen', 'Werkstattbetrieb', 'Lagern von Gegenständen (Zweckentfremdung als Lagerraum)'] },
        { t: 'text', html: '<p><strong>Sicherheit (VKF/AGV)</strong></p>' },
        { t: 'liste', items: ['Fluchtwege frei halten', 'Hydranten und Löscher zugänglich halten'] }] },
      { id: 'notfall', titel: '🚨 Notfall', bloecke: [
        { t: 'text', html: '<p>Bei Feuer oder Rauch: Tiefgarage verlassen und Feuerwehr 118 alarmieren.</p>' },
        { t: 'notruf' }] },
    ],
  },
};

// Druckvorlagen -> Raum. Die {{QR:<thema>}} in der Datei werden ersetzt.
const VORLAGEN = {
  'heizung-technikraum': { raum: 'heizung', titel: 'Türschild Heizungs- und Technikraum', art: 'Türschild' },
  'waschkueche': { raum: 'waschkueche', titel: 'Türschild Waschküche', art: 'Türschild' },
  'liftmaschinenraum': { raum: 'lift', titel: 'Türschild Liftmaschinenraum', art: 'Türschild' },
  'telekommunikation': { raum: 'telekom', titel: 'Türschild Telekommunikation', art: 'Türschild' },
  'hauptverteilung': { raum: 'hauptverteilung', titel: 'Türschild Hauptverteilung', art: 'Türschild' },
  'tiefgarage': { raum: 'tiefgarage', titel: 'Türschild Tiefgarage', art: 'Türschild' },
  'waschkueche-poster-a4': { raum: 'waschkueche', titel: 'Waschküche-Poster A4', art: 'Poster' },
  'waschkueche-kompakt': { raum: 'waschkueche', titel: 'Waschküche-Poster kompakt', art: 'Poster' },
  'waschkueche-poster': { raum: 'waschkueche', titel: 'Waschküche-Poster (Bildschirm)', art: 'Poster' },
};

function genToken() {
  // 16 Zeichen aus 32 -> 80 Bit; ohne verwechselbare Zeichen wie bei den Melde-Orten.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

let tabelleBereit = null;
function tabelle() {
  if (!tabelleBereit) {
    tabelleBereit = pool.query(`
      CREATE TABLE IF NOT EXISTS raum_qr (
        id SERIAL PRIMARY KEY,
        token VARCHAR(32) UNIQUE NOT NULL,
        raum VARCHAR(40) NOT NULL,
        thema VARCHAR(40) NOT NULL,
        aktiv BOOLEAN NOT NULL DEFAULT true,
        erstellt_von VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deaktiviert_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_raum_qr_aktiv ON raum_qr (raum, thema) WHERE aktiv;
    `).catch(e => { tabelleBereit = null; throw e; });
  }
  return tabelleBereit;
}

// Aktive Tokens eines Raums; fehlende werden angelegt.
async function tokensFuer(raum, wer) {
  await tabelle();
  const r = await pool.query('SELECT thema, token FROM raum_qr WHERE raum = $1 AND aktiv', [raum]);
  const map = Object.fromEntries(r.rows.map(x => [x.thema, x.token]));
  for (const teil of RAEUME[raum].teile) {
    if (map[teil.id]) continue;
    const token = genToken();
    const ins = await pool.query(
      `INSERT INTO raum_qr (token, raum, thema, erstellt_von) VALUES ($1,$2,$3,$4)
       ON CONFLICT (raum, thema) WHERE aktiv DO NOTHING RETURNING token`, [token, raum, teil.id, wer || null]);
    if (ins.rows[0]) map[teil.id] = ins.rows[0].token;
    else map[teil.id] = (await pool.query('SELECT token FROM raum_qr WHERE raum=$1 AND thema=$2 AND aktiv', [raum, teil.id])).rows[0].token;
  }
  return map;
}

const qrUrl = token => `${SITE_URL}/raum.html?t=${token}`;

// GET /api/raum-qr/info/:token — oeffentlich, aber nur mit gueltigem Token.
router.get('/info/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').toLowerCase();
    if (!/^[a-z0-9]{16}$/.test(token)) return res.status(404).json({ error: 'Ungültiger Code' });
    await tabelle();
    const r = await pool.query('SELECT raum, thema FROM raum_qr WHERE token = $1 AND aktiv', [token]);
    const row = r.rows[0];
    if (!row || !RAEUME[row.raum]) return res.status(404).json({ error: 'Ungültiger Code' });
    const { titel, sub, org, teile } = RAEUME[row.raum];
    res.set('Cache-Control', 'no-store');
    res.json({ raum: row.raum, thema: row.thema, titel, sub, org: org || null, teile });
  } catch (e) { console.error('[raum-qr-info]', e); res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/raum-qr — Uebersicht fuer die Verwaltungsseite (ohne Tokens im Klartext).
router.get('/', authMiddleware, requirePermission('reklamationen', 'read'), async (req, res) => {
  try {
    await tabelle();
    const r = await pool.query('SELECT raum, MIN(created_at) AS seit, COUNT(*)::int AS anzahl FROM raum_qr WHERE aktiv GROUP BY raum');
    const stand = Object.fromEntries(r.rows.map(x => [x.raum, x]));
    res.json({
      raeume: Object.entries(RAEUME).map(([k, v]) => ({ raum: k, titel: v.titel, themen: v.teile.map(t => t.id), aktiv_seit: stand[k]?.seit || null })),
      vorlagen: Object.entries(VORLAGEN).map(([k, v]) => ({ vorlage: k, ...v })),
    });
  } catch (e) { console.error('[raum-qr-list]', e); res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/raum-qr/:raum/erneuern — alte Tokens ungueltig (alte Ausdrucke gehen nicht mehr), neue anlegen.
router.post('/:raum/erneuern', authMiddleware, requirePermission('reklamationen', 'write'), async (req, res) => {
  try {
    const raum = req.params.raum;
    if (!RAEUME[raum]) return res.status(404).json({ error: 'Unbekannter Raum' });
    await tabelle();
    await pool.query('UPDATE raum_qr SET aktiv = false, deaktiviert_at = NOW() WHERE raum = $1 AND aktiv', [raum]);
    await tokensFuer(raum, req.user?.email);
    res.json({ ok: true });
  } catch (e) { console.error('[raum-qr-erneuern]', e); res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/raum-qr/druck/:vorlage — fertige Druckvorlage mit Token-QR (lokal erzeugt).
router.get('/druck/:vorlage', authMiddleware, requirePermission('reklamationen', 'read'), async (req, res) => {
  try {
    const v = VORLAGEN[req.params.vorlage];
    if (!v) return res.status(404).json({ error: 'Unbekannte Vorlage' });
    let html = fs.readFileSync(path.join(VORLAGEN_DIR, `${req.params.vorlage}.html`), 'utf-8');
    const tokens = await tokensFuer(v.raum, req.user?.email);
    const qr = {};
    for (const [thema, token] of Object.entries(tokens)) qr[thema] = await QRCode.toDataURL(qrUrl(token), { width: 400, margin: 1, errorCorrectionLevel: 'M' });
    html = html.replace(/\{\{QR:([a-z]+)\}\}/g, (m, thema) => qr[thema] || '');
    // <base>, damit relative Pfade (Logo) auch im Druckfenster laden.
    html = html.replace('<head>', `<head><base href="${SITE_URL}/">`);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) { console.error('[raum-qr-druck]', e); res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
module.exports.RAEUME = RAEUME;
module.exports.VORLAGEN = VORLAGEN;
