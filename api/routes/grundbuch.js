// ═══════════════════════════════════════════════════════════════════
// GRUNDBUCH-CROWDSOURCING (Eigentümer erfassen Anteile per Upload)
// Aus server.js ausgelagert (Router-Split, PoC-Domäne). Verhalten identisch.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const fsSync = require('fs');
const fs = require('fs').promises;
const pathModule = require('path');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik, isPraesident, isAusschussForAny } = require('../lib/groups');

const router = express.Router();

// DOCS_PATH ist SHARED (auch von documents-Routes genutzt) — Router definiert
// hier seine eigene, identische Konstante; in server.js bleibt sie ebenfalls.
const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const GRUNDBUCH_BILDER_DIR = 'allgemein/grundbuch-bilder';

function isAusschussOrTechnik(req) {
  const groups = req.user?.groups || [];
  return isTechnik(groups) || isPraesident(groups) || isAusschussForAny(groups);
}

// GET /api/grundbuch/status — Übersicht-Statistik
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'offen') AS offen,
        COUNT(*) FILTER (WHERE status = 'reserviert') AS reserviert,
        COUNT(*) FILTER (WHERE status = 'erfasst') AS erfasst,
        COUNT(*) FILTER (WHERE status = 'freigegeben') AS freigegeben,
        COUNT(DISTINCT erfasst_von) FILTER (WHERE erfasst_von IS NOT NULL) AS contributors
      FROM grundbuch_anteile`);
    const top = await pool.query(`
      SELECT erfasst_von AS user, COUNT(*) AS anzahl
      FROM grundbuch_anteile WHERE erfasst_von IS NOT NULL
      GROUP BY erfasst_von ORDER BY anzahl DESC LIMIT 10`);
    res.json({ stats: r.rows[0], top_contributors: top.rows });
  } catch (err) {
    console.error('grundbuch status err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// GET /api/grundbuch/anteile — Liste mit Filtern (alle eingeloggten User)
router.get('/anteile', authMiddleware, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.parzelle) { params.push(parseInt(req.query.parzelle)); where.push(`parzelle = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.mine === '1' && req.user?.email) { params.push(req.user.email); where.push(`(erfasst_von = $${params.length} OR reserviert_von = $${params.length})`); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await pool.query(`
      SELECT parzelle, sub_id, anteil_z, anteil_n, anteil_typ, gemeinde, flaeche_m2,
             eigentumsform, eigentuemer, wohnadressen, bild_path,
             status, reserviert_von, reserviert_am, erfasst_von, erfasst_am,
             verifiziert_von, verifiziert_am, notizen
      FROM grundbuch_anteile ${wsql}
      ORDER BY parzelle, sub_id`, params);
    res.json({ anteile: r.rows });
  } catch (err) {
    console.error('grundbuch list err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/reserve — als „in Bearbeitung" markieren
router.post('/anteile/:parzelle/:sub_id/reserve', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    // Auto-release nach 30 Min
    await pool.query(`
      UPDATE grundbuch_anteile SET status='offen', reserviert_von=NULL, reserviert_am=NULL
      WHERE status='reserviert' AND reserviert_am < now() - interval '30 minutes'`);
    const r = await pool.query(`
      UPDATE grundbuch_anteile
      SET status='reserviert', reserviert_von=$1, reserviert_am=now(), updated_at=now()
      WHERE parzelle=$2 AND sub_id=$3 AND status IN ('offen','reserviert') AND (reserviert_von IS NULL OR reserviert_von=$1)
      RETURNING *`, [me, p, s]);
    if (r.rows.length === 0) return res.status(409).json({ error: 'Bereits reserviert oder erfasst' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('grundbuch reserve err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// DELETE /api/grundbuch/anteile/:parzelle/:sub_id/reserve — Reservierung freigeben
router.delete('/anteile/:parzelle/:sub_id/reserve', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const r = await pool.query(`
      UPDATE grundbuch_anteile SET status='offen', reserviert_von=NULL, reserviert_am=NULL, updated_at=now()
      WHERE parzelle=$1 AND sub_id=$2 AND reserviert_von=$3 AND status='reserviert'
      RETURNING parzelle, sub_id`, [p, s, me]);
    res.json({ released: r.rows.length > 0 });
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// POST /api/grundbuch/ocr — Grundbuchauszug-Bild via Claude Vision (OpenRouter) auslesen
// Body: { bild_base64, bild_filename }
// Returns: { eigentumsform?, eigentuemer:[], wohnadressen:[], anteil_z?, flaeche_m2?, raw }
router.post('/ocr', authMiddleware, async (req, res) => {
  try {
    const { bild_base64, bild_filename } = req.body || {};
    if (!bild_base64) return res.status(400).json({ error: 'bild_base64 fehlt' });
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY nicht konfiguriert' });

    const ext = (bild_filename || 'png').split('.').pop().toLowerCase();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' };
    const mime = mimeMap[ext] || 'image/png';
    const dataUrl = `data:${mime};base64,${bild_base64}`;

    const systemPrompt = `Du bist ein präziser Extraktor für schweizerische Grundbuchauszüge der Gemeinde Kaiseraugst (AG).
Lies den Grundbuchauszug aus dem Bild und extrahiere die folgenden Felder.
Antworte AUSSCHLIESSLICH mit gültigem JSON, ohne Markdown-Codeblöcke, ohne erklärenden Text.

Schema:
{
  "anteil_z": number|null,           // Zähler des Stockwerk-Anteils, z.B. 5 bei "5/1000"
  "eigentumsform": string|null,      // Wörtlich aus dem Auszug, z.B. "Alleineigentum" oder "Gesamteigentum (einf. Gesellschaft)" oder "Miteigentum"
  "eigentuemer": [string],           // Liste aller Eigentümer-Namen, je ein Eintrag pro Person, Format "Nachname Vorname". Bei Gesamteigentum alle Personen separat.
  "wohnadressen": [string],          // Wohnadresse(n) der Eigentümer, Format "Strasse Nr, PLZ Ort". Eine Adresse pro Eigentümer ODER eine gemeinsame, wenn nur eine angegeben ist.
  "flaeche_m2": number|null          // Quadratmeter falls aufgeführt
}

Wenn ein Feld nicht eindeutig erkennbar ist, setze null bzw. leeres Array. Korrigiere keine Namen — übernimm sie wörtlich aus dem Auszug.`;

    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.rosenweg4303.ch',
        'X-Title': 'Rosenweg Grundbuch-OCR',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Extrahiere die Felder aus diesem Grundbuchauszug.' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ],
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      console.error('[Grundbuch-OCR] OpenRouter error', orRes.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})`, detail: errText.slice(0, 200) });
    }
    const orJson = await orRes.json();
    const content = orJson.choices?.[0]?.message?.content || '';

    // JSON aus dem Modell-Output extrahieren (defensiv: code-fences entfernen)
    let jsonText = content.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();

    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) {
      console.error('[Grundbuch-OCR] JSON-Parse fehlgeschlagen:', jsonText.slice(0, 300));
      return res.status(502).json({ error: 'OCR-Antwort ist kein gültiges JSON', raw: content });
    }

    // Defensive Normalisierung
    const norm = {
      anteil_z: Number.isFinite(parsed.anteil_z) ? parsed.anteil_z : (parseInt(parsed.anteil_z) || null),
      eigentumsform: typeof parsed.eigentumsform === 'string' ? parsed.eigentumsform.trim() : null,
      eigentuemer: Array.isArray(parsed.eigentuemer) ? parsed.eigentuemer.map(s => String(s).trim()).filter(Boolean) : [],
      wohnadressen: Array.isArray(parsed.wohnadressen) ? parsed.wohnadressen.map(s => String(s).trim()).filter(Boolean) : [],
      flaeche_m2: Number.isFinite(parsed.flaeche_m2) ? parsed.flaeche_m2 : (parseInt(parsed.flaeche_m2) || null),
    };
    res.json({ ...norm, model: orJson.model, usage: orJson.usage });
  } catch (err) {
    console.error('[Grundbuch-OCR] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id — Daten + Bild speichern (multipart-base64)
// Body: { eigentumsform, eigentuemer:[], wohnadressen:[], anteil_z?, flaeche_m2?, notizen?, bild_base64?, bild_filename? }
router.post('/anteile/:parzelle/:sub_id', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const b = req.body || {};
    let bildPath = null;
    if (b.bild_base64 && b.bild_filename) {
      const ext = (b.bild_filename.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'pdf'].includes(ext)) return res.status(400).json({ error: 'Nur PNG/JPG/PDF erlaubt' });
      const buf = Buffer.from(b.bild_base64, 'base64');
      if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu gross (>10MB)' });
      const dir = pathModule.join(DOCS_PATH, GRUNDBUCH_BILDER_DIR);
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
      const az = b.anteil_z || (await pool.query('SELECT anteil_z FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s])).rows[0]?.anteil_z;
      const filename = `grundbuch_p${p}-${s}_${az || 'x'}-1000.${ext}`;
      const fullPath = pathModule.join(dir, filename);
      await fs.writeFile(fullPath, buf);
      bildPath = `${GRUNDBUCH_BILDER_DIR}/${filename}`;
    }
    const r = await pool.query(`
      UPDATE grundbuch_anteile
      SET eigentumsform = COALESCE($1, eigentumsform),
          eigentuemer = COALESCE($2::jsonb, eigentuemer),
          wohnadressen = COALESCE($3::jsonb, wohnadressen),
          flaeche_m2 = COALESCE($4, flaeche_m2),
          notizen = COALESCE($5, notizen),
          bild_path = COALESCE($6, bild_path),
          erfasst_von = $7, erfasst_am = now(),
          status = 'erfasst',
          reserviert_von = NULL, reserviert_am = NULL,
          updated_at = now()
      WHERE parzelle = $8 AND sub_id = $9
      RETURNING *`,
      [b.eigentumsform || null,
       b.eigentuemer ? JSON.stringify(b.eigentuemer) : null,
       b.wohnadressen ? JSON.stringify(b.wohnadressen) : null,
       b.flaeche_m2 || null, b.notizen || null,
       bildPath, me, p, s]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Anteil nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('grundbuch save err:', err.message);
    res.status(500).json({ error: 'Fehler', detail: err.message });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/verify — Ausschuss/Technik bestätigt
router.post('/anteile/:parzelle/:sub_id/verify', authMiddleware, async (req, res) => {
  if (!isAusschussOrTechnik(req)) return res.status(403).json({ error: 'Nur Ausschuss/Technik darf verifizieren' });
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = req.user?.email || req.user?.name || 'unknown';
    const r = await pool.query(`
      UPDATE grundbuch_anteile SET status='freigegeben', verifiziert_von=$1, verifiziert_am=now(), updated_at=now()
      WHERE parzelle=$2 AND sub_id=$3 AND status='erfasst' RETURNING *`, [me, p, s]);
    if (r.rows.length === 0) return res.status(409).json({ error: 'Nur erfasste Anteile können verifiziert werden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/grundbuch/anteile/:parzelle/:sub_id/bild — Auszug-Bild ausliefern
router.get('/anteile/:parzelle/:sub_id/bild', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const r = await pool.query('SELECT bild_path FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s]);
    if (!r.rows[0]?.bild_path) return res.status(404).end();
    const fullPath = pathModule.join(DOCS_PATH, r.rows[0].bild_path);
    if (!fullPath.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    const ext = r.rows[0].bild_path.split('.').pop().toLowerCase();
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    fsSync.createReadStream(fullPath).pipe(res);
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
