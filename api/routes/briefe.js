// ═══════════════════════════════════════════════════════════════════
// BRIEFE TRACKING — Versendete Briefe, Empfänger via OpenRouter Vision
// Aus server.js ausgelagert. Entscheide Stefan 28.11.2026 (Klaerung Briefe):
//  - Texterkennung bleibt extern (OpenRouter), aber erst nach klarem Hinweis
//    (bestaetigt_extern: true, wie die KI-Pruefung der Vollmachten), nicht per
//    Zugangstoken/MCP, mit Tageslimit je Konto (Zaehler in der Datenbank).
//  - STWEG beim Erfassen; der Ausschuss sieht nur seine STWEG, Technik/Praesident alles.
//  - Loeschen nur mit Begruendung, Vier-Augen und Protokoll.
//  - Upload: Inhalt per Magic Bytes pruefen; 15 MB gelten wirklich (eigener
//    JSON-Parser in server.js fuer diese Route).
//  - Ablage bleibt allgemein/fotos_von_versendeten_briefen/ (JPEG, PNG bleibt
//    PNG), kein PDF, keine Benachrichtigungen. Die Dokumenten-API aendert den
//    Ordner nicht mehr (server.js docNurEigeneRoute).
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fsSync = require('fs');
const fs = require('fs').promises;
const pathModule = require('path');
const { pool } = require('../lib/db');
const { authMiddleware, absenderIp } = require('../middleware/auth');
const regeln = require('../lib/briefe-rechte');

const router = express.Router();
const DOCS_PATH = process.env.DOCS_PATH || '/documents';

const BRIEFE_DIR = 'allgemein/fotos_von_versendeten_briefen';
const BRIEFE_PFAD = pathModule.resolve(DOCS_PATH, BRIEFE_DIR);
// WebStamp-Tracking-Format: 98.01.018499.705XXXXX (8-stellige laufende Nr, beginnt mit 705)
const TRACKING_PREFIX_DOTTED = '98.01.018499.705';
const TRACKING_PREFIX_PLAIN = '9801018499705';

// ─── Schema ─────────────────────────────────────────────────────────
const SQL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS briefe_ablage (
    id SERIAL PRIMARY KEY,
    dateiname VARCHAR(255) NOT NULL UNIQUE,
    stweg INTEGER,
    empfaenger TEXT,
    tracking5 VARCHAR(5),
    erfasst_von_id INTEGER,
    erfasst_von_email VARCHAR(255),
    erfasst_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    geloescht_am TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS briefe_loeschantraege (
    id SERIAL PRIMARY KEY,
    brief_id INTEGER NOT NULL REFERENCES briefe_ablage(id) ON DELETE CASCADE,
    grund TEXT NOT NULL,
    beantragt_von_id INTEGER NOT NULL,
    beantragt_von_email VARCHAR(255),
    beantragt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entschieden_von_id INTEGER,
    entschieden_von_email VARCHAR(255),
    entschieden_am TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
    CONSTRAINT briefe_vier_augen CHECK (entschieden_von_id IS NULL OR entschieden_von_id <> beantragt_von_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_briefe_loeschantrag_offen ON briefe_loeschantraege(brief_id) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS briefe_protokoll (
    id BIGSERIAL PRIMARY KEY,
    zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    aktion VARCHAR(30) NOT NULL,
    dateiname VARCHAR(255),
    detail TEXT,
    user_id INTEGER,
    email VARCHAR(255),
    weg VARCHAR(40),
    ip VARCHAR(64)
  );
  CREATE TABLE IF NOT EXISTS briefe_ocr_nutzung (
    konto VARCHAR(255) NOT NULL,
    tag DATE NOT NULL,
    anzahl INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (konto, tag)
  );`;

async function schemaSicherstellen(db) {
  await db.query(SQL_SCHEMA);
}

// ─── Hilfen ─────────────────────────────────────────────────────────
function parseBriefFilename(filename) {
  const m = filename.match(/^(.+)-(\d{5})\.(jpe?g|png)$/i);
  if (!m) return null;
  const nameSlug = m[1];
  const tracking5 = m[2];
  const display = nameSlug
    .replace(/-und-/g, ' & ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  return {
    filename,
    name: display,
    nameSlug,
    tracking5,
    trackingDotted: `${TRACKING_PREFIX_DOTTED}${tracking5}`,
    trackingPlain: `${TRACKING_PREFIX_PLAIN}${tracking5}`,
  };
}

function nameToSlug(name) {
  return String(name)
    .replace(/&/g, ' und ')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Pfad einer Datei im Brief-Ordner, oder null (Ausbruch / kein Brief-Dateiname). */
function briefPfad(name) {
  if (!regeln.sichererDateiname(name)) return null;
  const p = pathModule.resolve(BRIEFE_PFAD, name);
  return pathModule.dirname(p) === BRIEFE_PFAD ? p : null;
}

function weg(req) {
  if (String(req.headers['x-rosenweg-kanal'] || '').toLowerCase() === 'mcp') return 'mcp';
  if (req.pat) return 'token';
  if (req.appKarte) return 'karte';
  return String(req.auth?.art || 'konto').slice(0, 40);
}

async function protokoll(req, aktion, dateiname, detail, db = pool) {
  await db.query(
    `INSERT INTO briefe_protokoll (aktion, dateiname, detail, user_id, email, weg, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [aktion, dateiname || null, detail == null ? null : String(detail).slice(0, 1000), req.user?.id ?? null,
     String(req.user?.email || '').toLowerCase().slice(0, 255) || null, weg(req), String(absenderIp(req) || '').slice(0, 64) || null]);
}

function requireBriefZugang(req, res, next) {
  if (!regeln.darfZugang(req.user?.groups || [])) return res.status(403).json({ error: 'Nur für Ausschuss/Technik' });
  next();
}

/** Brief samt Ablage-Zeile, wenn das Konto ihn sehen darf; sonst null. */
async function briefLesen(req, dateiname) {
  const p = briefPfad(dateiname);
  if (!p) return null;
  const r = await pool.query('SELECT * FROM briefe_ablage WHERE dateiname = $1 AND geloescht_am IS NULL', [dateiname]);
  const zeile = r.rows[0] || null;
  if (!regeln.darfSehen(req.user?.groups || [], zeile ? zeile.stweg : null)) return null;
  try { await fs.access(p); } catch { return null; }
  return { pfad: p, zeile };
}

// ─── Liste ──────────────────────────────────────────────────────────
// GET /api/briefe — Brief-Fotos der sichtbaren STWEG(s) mit Tracking-Nummern
router.get('/', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    const groups = req.user?.groups || [];
    let files;
    try { files = await fs.readdir(BRIEFE_PFAD); }
    catch (e) {
      if (e.code === 'ENOENT') return res.json({ briefe: [], dir: BRIEFE_DIR });
      throw e;
    }
    const zeilen = new Map((await pool.query(
      `SELECT b.*, d.id AS antrag_id, d.grund AS antrag_grund, d.beantragt_von_id, d.beantragt_von_email, d.beantragt_am
         FROM briefe_ablage b LEFT JOIN briefe_loeschantraege d ON d.brief_id = b.id AND d.status = 'pending'
        WHERE b.geloescht_am IS NULL`)).rows.map(z => [z.dateiname, z]));
    const briefe = [];
    for (const f of files) {
      const parsed = parseBriefFilename(f);
      if (!parsed || !regeln.sichererDateiname(f)) continue;
      const z = zeilen.get(f);
      const stweg = z ? z.stweg : null;
      if (!regeln.darfSehen(groups, stweg)) continue;
      try {
        const stat = await fs.stat(pathModule.join(BRIEFE_PFAD, f));
        const b = {
          ...parsed, mtime: (z && z.erfasst_am ? new Date(z.erfasst_am) : stat.mtime).toISOString(), size: stat.size,
          stweg, empfaenger: z && z.empfaenger ? z.empfaenger : parsed.name,
        };
        if (z && z.antrag_id) {
          const e = regeln.darfEntscheiden(req.user, z, stweg);
          b.loeschantrag = {
            id: z.antrag_id, grund: z.antrag_grund, beantragt_von: z.beantragt_von_email, beantragt_am: z.beantragt_am,
            eigener_antrag: e.grund === 'eigener-antrag', darf_entscheiden: e.ok,
          };
        }
        briefe.push(b);
      } catch {}
    }
    briefe.sort((a, b) => b.mtime.localeCompare(a.mtime) || b.tracking5.localeCompare(a.tracking5));
    const s = regeln.sichtStwegs(groups);
    res.json({
      briefe, dir: BRIEFE_DIR,
      erfass_stwegs: s === null ? require('../lib/groups').ALLE_STWEGS : [...s].sort((a, b) => a - b),
      hinweis_extern: regeln.HINWEIS_EXTERN, ocr_tageslimit: regeln.OCR_TAGESLIMIT,
      darf_zuordnen: s === null,
    });
  } catch (err) {
    console.error('[Briefe-List]', err.message);
    res.status(500).json({ error: 'Liste konnte nicht geladen werden' });
  }
});

// GET /api/briefe/:datei/bild — Foto (STWEG-Pruefung statt Dokumenten-API)
router.get('/:datei/bild', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    const b = await briefLesen(req, req.params.datei);
    if (!b) return res.status(404).json({ error: 'Brief nicht gefunden' });
    const png = /\.png$/i.test(req.params.datei);
    res.setHeader('Content-Type', png ? 'image/png' : 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = fsSync.createReadStream(b.pfad);
    stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'Datei nicht gefunden' }); else res.destroy(); });
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Foto konnte nicht geladen werden' });
  }
});

// PUT /api/briefe/:datei/stweg — Altbestand ohne STWEG zuordnen (nur Technik/Praesident)
router.put('/:datei/stweg', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    if (regeln.sichtStwegs(req.user?.groups || []) !== null) return res.status(403).json({ error: 'Nur Technik/Präsident' });
    const b = await briefLesen(req, req.params.datei);
    if (!b) return res.status(404).json({ error: 'Brief nicht gefunden' });
    const stweg = regeln.erfassStweg(req.user.groups, req.body?.stweg);
    if (!stweg) return res.status(400).json({ error: 'Ungültige STWEG' });
    const parsed = parseBriefFilename(req.params.datei);
    await pool.query(
      `INSERT INTO briefe_ablage (dateiname, stweg, empfaenger, tracking5) VALUES ($1, $2, $3, $4)
       ON CONFLICT (dateiname) DO UPDATE SET stweg = EXCLUDED.stweg`,
      [req.params.datei, stweg, parsed ? parsed.name : null, parsed ? parsed.tracking5 : null]);
    await protokoll(req, 'stweg', req.params.datei, `${b.zeile?.stweg ?? 'ohne'} → ${stweg}`);
    res.json({ success: true, stweg });
  } catch (err) {
    console.error('[Briefe-STWEG]', err.message);
    res.status(500).json({ error: 'STWEG konnte nicht gesetzt werden' });
  }
});

// ─── Loeschen (Vier-Augen) ──────────────────────────────────────────
// POST /api/briefe/:datei/loeschantrag  { grund }
router.post('/:datei/loeschantrag', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    if (req.user?.id == null) return res.status(403).json({ error: 'Löschantrag nur mit Rosenweg-Konto' });
    const grund = String(req.body?.grund || '').trim().slice(0, 2000);
    if (!grund) return res.status(400).json({ error: 'Begründung erforderlich' });
    const b = await briefLesen(req, req.params.datei);
    if (!b) return res.status(404).json({ error: 'Brief nicht gefunden' });
    let briefId = b.zeile?.id;
    if (!briefId) {
      // Altbestand ohne Zeile (nur Technik/Praesident sehen ihn): Zeile anlegen
      const parsed = parseBriefFilename(req.params.datei);
      const r = await pool.query(
        `INSERT INTO briefe_ablage (dateiname, empfaenger, tracking5) VALUES ($1, $2, $3)
         ON CONFLICT (dateiname) DO UPDATE SET dateiname = EXCLUDED.dateiname RETURNING id`,
        [req.params.datei, parsed ? parsed.name : null, parsed ? parsed.tracking5 : null]);
      briefId = r.rows[0].id;
    }
    try {
      await pool.query(
        `INSERT INTO briefe_loeschantraege (brief_id, grund, beantragt_von_id, beantragt_von_email) VALUES ($1, $2, $3, $4)`,
        [briefId, grund, req.user.id, String(req.user.email || '').toLowerCase() || null]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Es gibt bereits einen offenen Löschantrag' });
      throw e;
    }
    await protokoll(req, 'loeschantrag', req.params.datei, grund);
    res.json({ success: true, message: 'Löschantrag erstellt. Eine zweite Person muss bestätigen.' });
  } catch (err) {
    console.error('[Briefe-Loeschantrag]', err.message);
    res.status(500).json({ error: 'Löschantrag konnte nicht erstellt werden' });
  }
});

// POST /api/briefe/:datei/loeschentscheid  { aktion: 'confirm' | 'reject' }
router.post('/:datei/loeschentscheid', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    const aktion = req.body?.aktion;
    if (!['confirm', 'reject'].includes(aktion)) return res.status(400).json({ error: 'Aktion muss "confirm" oder "reject" sein' });
    const b = await briefLesen(req, req.params.datei);
    if (!b || !b.zeile) return res.status(404).json({ error: 'Brief nicht gefunden' });
    const a = (await pool.query(
      `SELECT * FROM briefe_loeschantraege WHERE brief_id = $1 AND status = 'pending'`, [b.zeile.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Kein offener Löschantrag gefunden' });
    const e = regeln.darfEntscheiden(req.user, a, b.zeile.stweg);
    if (!e.ok) {
      return res.status(403).json({ error: e.grund === 'eigener-antrag'
        ? '4-Augen-Prinzip: Sie können Ihren eigenen Löschantrag nicht entscheiden'
        : '4-Augen-Prinzip: Entscheiden darf nur der Ausschuss derselben STWEG, Technik oder Präsident' });
    }
    const status = aktion === 'confirm' ? 'confirmed' : 'rejected';
    const upd = await pool.query(
      `UPDATE briefe_loeschantraege SET status = $1, entschieden_von_id = $2, entschieden_von_email = $3, entschieden_am = NOW()
        WHERE id = $4 AND status = 'pending' RETURNING id`,
      [status, req.user.id, String(req.user.email || '').toLowerCase() || null, a.id]);
    if (!upd.rows.length) return res.status(409).json({ error: 'Löschantrag wurde bereits entschieden' });
    if (aktion === 'reject') {
      await protokoll(req, 'loeschung-abgelehnt', req.params.datei, null);
      return res.json({ success: true, message: 'Löschantrag abgelehnt' });
    }
    let fehler = null;
    try { await fs.unlink(b.pfad); }
    catch (err) { if (err.code !== 'ENOENT') { fehler = err.code || err.message; console.error('[Briefe-Loeschen] Datei nicht entfernt:', err.message); } }
    if (fehler) {
      // Datei bleibt: Antrag wieder oeffnen, damit nichts als geloescht gilt, was noch da ist
      await pool.query(`UPDATE briefe_loeschantraege SET status = 'pending', entschieden_von_id = NULL, entschieden_von_email = NULL, entschieden_am = NULL WHERE id = $1`, [a.id]);
      await protokoll(req, 'loeschung-fehler', req.params.datei, String(fehler));
      return res.status(500).json({ error: 'Foto konnte nicht entfernt werden, der Antrag bleibt offen' });
    }
    await pool.query(`UPDATE briefe_ablage SET geloescht_am = NOW(), empfaenger = NULL WHERE id = $1`, [b.zeile.id]);
    await protokoll(req, 'loeschung-bestaetigt', req.params.datei, null);
    res.json({ success: true, message: 'Brief gelöscht (4-Augen bestätigt)' });
  } catch (err) {
    console.error('[Briefe-Loeschentscheid]', err.message);
    res.status(500).json({ error: 'Entscheid fehlgeschlagen' });
  }
});

// ─── Erfassen ───────────────────────────────────────────────────────
/** Einen Aufruf der externen Texterkennung zaehlen; false = Tageslimit erreicht. */
async function ocrZaehlen(req) {
  const konto = req.user?.id != null ? `id:${req.user.id}` : `mail:${String(req.user?.email || '').toLowerCase()}`;
  const r = await pool.query(
    `INSERT INTO briefe_ocr_nutzung (konto, tag, anzahl) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (konto, tag) DO UPDATE SET anzahl = briefe_ocr_nutzung.anzahl + 1
       WHERE briefe_ocr_nutzung.anzahl < $2
     RETURNING anzahl`, [konto, regeln.OCR_TAGESLIMIT]);
  return r.rows.length > 0;
}

// POST /api/briefe/upload — Foto hochladen, OCR via Haiku 4.5, umbenennen, ablegen
// Body: { bild_base64, bild_filename, stweg, bestaetigt_extern: true }
// Absender der Briefe als Hinweis fuer die Texterkennung (Name, Adresse). Steht
// in der Umgebung, nicht im Code: das Repo ist oeffentlich (Befund W28).
const BRIEF_ABSENDER = String(process.env.BRIEF_ABSENDER || '').replace(/[`$\\]/g, '').slice(0, 200);
router.post('/upload', authMiddleware, requireBriefZugang, async (req, res) => {
  try {
    const { bild_base64, stweg: stwegWunsch, bestaetigt_extern } = req.body || {};
    if (!bild_base64) return res.status(400).json({ error: 'bild_base64 fehlt' });

    // Wie die KI-Pruefung der Vollmachten: nur auf Knopfdruck nach dem Hinweis,
    // nicht per Zugangstoken oder MCP.
    if (req.pat || String(req.headers['x-rosenweg-kanal'] || '').toLowerCase() === 'mcp') {
      return res.status(403).json({ error: 'Erfassen nur im Portal oder in der App, nicht per Zugangstoken oder MCP' });
    }
    if (bestaetigt_extern !== true) {
      return res.status(400).json({ error: `Bitte bestätigen: ${regeln.HINWEIS_EXTERN} (bestaetigt_extern: true)`, bestaetigung_noetig: true, hinweis: regeln.HINWEIS_EXTERN });
    }

    const stweg = regeln.erfassStweg(req.user?.groups || [], stwegWunsch);
    if (!stweg) return res.status(400).json({ error: 'Bitte die STWEG des Briefs wählen (nur eigene STWEG)' });

    const buf = regeln.base64Bytes(bild_base64);
    if (!buf) return res.status(400).json({ error: 'Bild ist kein gültiges Base64' });
    if (buf.length > regeln.MAX_BYTES) return res.status(413).json({ error: 'Datei zu gross (>15MB)' });
    const typ = regeln.bildTyp(buf);
    if (!typ) return res.status(400).json({ error: 'Nur JPG/PNG erlaubt (Inhalt geprüft)' });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    if (!(await ocrZaehlen(req))) {
      return res.status(429).json({ error: `Tageslimit der Texterkennung erreicht (${regeln.OCR_TAGESLIMIT} je Konto und Tag)` });
    }

    const mime = typ === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    const systemPrompt = `Du extrahierst Empfänger und Tracking aus dem Foto eines Schweizer WebStamp-Couverts (A-Post Plus).
Antworte AUSSCHLIESSLICH mit gueltigem JSON, keine Markdown-Codebloecke, kein erklaerender Text.

Schema:
{
  "tracking": string|null,    // Volle Tracking-Nr unter dem Barcode, Format "98.01.018499.705XXXXX". 8 Ziffern beginnend mit 705.
  "empfänger": string|null,  // Vollstaendiger Empfänger-Name (Person ODER Firma), z.B. "Max Muster" oder "Anna Beispiel & Beat Beispiel" oder "Muster Immobilien AG"
  "strasse": string|null,
  "plz": string|null,
  "ort": string|null
}

WICHTIG: Der Empfänger ist NICHT der Absender (Absenderzeile ueber dem Adressfeld bzw. oben links${BRIEF_ABSENDER ? ': ' + BRIEF_ABSENDER : ''}). Lies das Empfänger-Adressfeld.
Wenn ein Feld nicht erkennbar ist, setze null.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Brief-Tracking-OCR',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Extrahiere Empfänger und Tracking aus diesem Brief-Foto.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      console.error('[Briefe-OCR] OpenRouter error', orRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})` });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[Briefe-OCR] JSON-Antwort nicht lesbar');
      return res.status(502).json({ error: 'OCR-Antwort ist kein gueltiges JSON' });
    }

    const trackDigits = String(parsed.tracking || '').replace(/\D/g, '');
    const tail8 = trackDigits.slice(-8);
    if (!/^705\d{5}$/.test(tail8)) {
      return res.status(422).json({ error: 'Tracking-Nr nicht erkannt oder Format unerwartet', ocr: parsed });
    }
    const tracking5 = tail8.slice(-5);

    if (!parsed.empfänger || typeof parsed.empfänger !== 'string') {
      return res.status(422).json({ error: 'Empfänger nicht erkannt', ocr: parsed });
    }
    const nameSlug = nameToSlug(parsed.empfänger);
    if (!nameSlug) return res.status(422).json({ error: 'Empfänger nicht in Dateiname konvertierbar' });

    const newFilename = `${nameSlug.slice(0, 200)}-${tracking5}.${typ}`;
    const newPath = briefPfad(newFilename);
    if (!newPath) return res.status(422).json({ error: 'Empfänger nicht in Dateiname konvertierbar' });
    await fs.mkdir(BRIEFE_PFAD, { recursive: true });
    try {
      await fs.access(newPath);
      return res.status(409).json({ error: `Datei existiert bereits: ${newFilename}`, filename: newFilename, ocr: parsed });
    } catch {}

    // Erst die Zeile (eindeutiger Name), dann die Datei: zwei gleichzeitige
    // Uploads desselben Briefs legen nicht beide ab.
    // Ein frueher geloeschter Brief gleichen Namens darf neu erfasst werden.
    const neu = await pool.query(
      `INSERT INTO briefe_ablage (dateiname, stweg, empfaenger, tracking5, erfasst_von_id, erfasst_von_email) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (dateiname) DO UPDATE SET stweg = EXCLUDED.stweg, empfaenger = EXCLUDED.empfaenger, tracking5 = EXCLUDED.tracking5,
         erfasst_von_id = EXCLUDED.erfasst_von_id, erfasst_von_email = EXCLUDED.erfasst_von_email, erfasst_am = NOW(), geloescht_am = NULL
       WHERE briefe_ablage.geloescht_am IS NOT NULL
       RETURNING id`,
      [newFilename, stweg, String(parsed.empfänger).slice(0, 300), tracking5, req.user?.id ?? null, String(req.user?.email || '').toLowerCase() || null]);
    if (!neu.rows.length) return res.status(409).json({ error: `Datei existiert bereits: ${newFilename}`, filename: newFilename, ocr: parsed });
    try { await fs.writeFile(newPath, buf, { flag: 'wx' }); }
    catch (e) {
      await pool.query('UPDATE briefe_ablage SET geloescht_am = NOW() WHERE id = $1', [neu.rows[0].id]).catch(() => {});
      if (e.code === 'EEXIST') return res.status(409).json({ error: `Datei existiert bereits: ${newFilename}`, filename: newFilename, ocr: parsed });
      throw e;
    }
    await protokoll(req, 'erfasst', newFilename, `STWEG ${stweg}`);
    res.json({
      success: true,
      filename: newFilename,
      stweg,
      tracking5,
      trackingDotted: `${TRACKING_PREFIX_DOTTED}${tracking5}`,
      trackingPlain: `${TRACKING_PREFIX_PLAIN}${tracking5}`,
      empfänger: parsed.empfänger,
      strasse: parsed.strasse,
      plz: parsed.plz,
      ort: parsed.ort,
      model: orJson.model,
    });
  } catch (err) {
    console.error('[Briefe-Upload]', err.message);
    res.status(500).json({ error: 'Erfassen fehlgeschlagen' });
  }
});

module.exports = router;
module.exports.schemaSicherstellen = schemaSicherstellen;
module.exports.parseBriefFilename = parseBriefFilename;
module.exports.nameToSlug = nameToSlug;
module.exports.BRIEFE_DIR = BRIEFE_DIR;
