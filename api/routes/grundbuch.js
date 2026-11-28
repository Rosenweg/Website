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
const { isTechnik, isPraesident } = require('../lib/groups');
const gb = require('../lib/grundbuch-rechte');
const gbVorschlag = require('../lib/grundbuch-vorschlag');
const adminProtokoll = require('../lib/admin-protokoll');
const kartenAdmin = require('../lib/kartenadmin');

const router = express.Router();

// DOCS_PATH ist SHARED (auch von documents-Routes genutzt) — Router definiert
// hier seine eigene, identische Konstante; in server.js bleibt sie ebenfalls.
const DOCS_PATH = process.env.DOCS_PATH || '/documents';
const GRUNDBUCH_BILDER_DIR = 'allgemein/grundbuch-bilder';

// Rechte: lib/grundbuch-rechte.js (STWEG-gebunden, keine Mieter; Entscheid Stefan 28.11.2026)
const gruppen = (req) => req.user?.groups || [];
const istTP = (req) => isTechnik(gruppen(req)) || isPraesident(gruppen(req));
const ich = (req) => req.user?.email || req.user?.name || 'unknown';
const KEIN_ERFASSEN = 'Grundbuch erfassen nur Eigentümer, Ausschuss und Technik/Präsident (für Anteile der eigenen STWEG)';

/** Anteil laden. -> Zeile | null (Antwort gesendet) */
async function anteilLaden(req, res, felder = '*') {
  const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
  if (!Number.isFinite(p) || !Number.isFinite(s)) { res.status(400).json({ error: 'Ungültige Parzelle' }); return null; }
  const r = await pool.query(`SELECT ${felder} FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2`, [p, s]);
  if (!r.rows[0]) { res.status(404).json({ error: 'Anteil nicht gefunden' }); return null; }
  return r.rows[0];
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
    // Wer wie viel erfasst hat, sind E-Mail-Adressen ueber alle STWEG: Namen nur
    // fuer Technik/Praesident und den eigenen Eintrag, sonst nur die Anzahl.
    const me = ich(req);
    const topListe = istTP(req) ? top.rows
      : top.rows.map(t => ({ user: t.user === me ? t.user : null, anzahl: t.anzahl }));
    res.json({ stats: r.rows[0], top_contributors: topListe, rechte: gb.gbRechte(gruppen(req)) });
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
    if (req.query.stweg) { params.push(parseInt(req.query.stweg)); where.push(`stweg = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (req.query.mine === '1' && req.user?.email) { params.push(req.user.email); where.push(`(erfasst_von = $${params.length} OR reserviert_von = $${params.length})`); }
    const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await pool.query(`
      SELECT parzelle, sub_id, stweg, anteil_z, anteil_n, anteil_typ, gemeinde, flaeche_m2,
             eigentumsform, eigentuemer, wohnadressen, bild_path,
             status, reserviert_von, reserviert_am, erfasst_von, erfasst_am,
             verifiziert_von, verifiziert_am, notizen
      FROM grundbuch_anteile ${wsql}
      ORDER BY parzelle, sub_id`, params);
    // Namen, Wohnadressen, Notizen und das Auszugsbild sind Personendaten:
    // sie sieht Technik/Praesident, der Ausschuss nur fuer Anteile SEINER STWEG,
    // und wer den Anteil selbst reserviert oder erfasst hat. Alle anderen sehen
    // Status und Anteil, nicht wem er gehoert.
    const g = gruppen(req);
    const me = ich(req);
    // Auch wer erfasst/reserviert/verifiziert hat (E-Mail) bleibt Fremden verborgen.
    const anteile = r.rows.map(a => {
      const voll = gb.gbVollSicht(g, a.stweg);
      const out = (voll || a.erfasst_von === me || a.reserviert_von === me)
        ? a : { ...a, eigentuemer: null, wohnadressen: null, notizen: null, bild_path: null,
          erfasst_von: null, reserviert_von: null, verifiziert_von: null };
      return { ...out, darf_erfassen: gb.gbAnteilErfassen(g, a.stweg), darf_freigeben: voll };
    });
    res.json({ anteile, rechte: gb.gbRechte(g) });
  } catch (err) {
    console.error('grundbuch list err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/reserve — als „in Bearbeitung" markieren
router.post('/anteile/:parzelle/:sub_id/reserve', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = ich(req);
    const cur = await anteilLaden(req, res, 'stweg');
    if (!cur) return;
    if (!gb.gbAnteilErfassen(gruppen(req), cur.stweg)) return res.status(403).json({ error: KEIN_ERFASSEN });
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
// Jeder OCR-Aufruf kostet beim Anbieter Geld. Pro Konto hoechstens 30 je
// Stunde — fuer die Erfassung von Hand reicht das bei weitem.
const OCR_FENSTER_MS = 60 * 60 * 1000;
const OCR_MAX = 30;
const ocrAufrufe = new Map(); // konto -> [zeitpunkte]
setInterval(() => {
  const jetzt = Date.now();
  for (const [k, v] of ocrAufrufe) if (!v.some(t => jetzt - t < OCR_FENSTER_MS)) ocrAufrufe.delete(k);
}, 10 * 60 * 1000).unref();

// Der Auszug (Namen, Wohnadressen) geht an einen externen Dienst (OpenRouter,
// Modell Claude Haiku): nur fuer einen Anteil, den das Konto gerade erfassen
// darf (reserviert bzw. selbst erfasst, oder Ausschuss/T/P dieser STWEG), nur
// nach ausdruecklicher Bestaetigung auf der Seite (bestaetigt_extern: true)
// und nie per Zugangstoken/MCP (Entscheid Stefan 28.11.2026, F1/E3).
// Body: { parzelle, sub_id, bild_base64, bild_filename, bestaetigt_extern: true }
router.post('/ocr', authMiddleware, async (req, res) => {
  try {
    const { bild_base64, bild_filename } = req.body || {};
    if (gb.gbMaschinenKanal(req)) return res.status(403).json({ error: 'KI-Auslese nur auf Knopfdruck im Portal, nicht per Zugangstoken oder MCP' });
    if (!gb.gbErfassenDarf(gruppen(req))) return res.status(403).json({ error: KEIN_ERFASSEN });
    const p = parseInt(req.body?.parzelle), s = parseInt(req.body?.sub_id);
    if (!Number.isFinite(p) || !Number.isFinite(s)) return res.status(400).json({ error: 'parzelle und sub_id des Anteils fehlen' });
    const cur = (await pool.query('SELECT stweg, status, reserviert_von, erfasst_von FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Anteil nicht gefunden' });
    const me = ich(req);
    const g = gruppen(req);
    const eigen = (cur.status === 'reserviert' && cur.reserviert_von === me) || (cur.status === 'erfasst' && cur.erfasst_von === me);
    if (!gb.gbAnteilErfassen(g, cur.stweg) || !(eigen || gb.gbVollSicht(g, cur.stweg))) {
      return res.status(403).json({ error: 'Bitte den Anteil zuerst reservieren' });
    }
    if (req.body?.bestaetigt_extern !== true) {
      return res.status(400).json({ error: 'Bitte bestätigen, dass der Auszug an einen externen Dienst (OpenRouter/Anthropic) geht (bestaetigt_extern: true)', bestaetigung_noetig: true });
    }
    if (!bild_base64 || typeof bild_base64 !== 'string') return res.status(400).json({ error: 'bild_base64 fehlt' });
    // Wie beim Speichern: hoechstens 10 MB Bild (base64 ~ 4/3 davon).
    if (bild_base64.length > Math.ceil(10 * 1024 * 1024 * 4 / 3) + 4) return res.status(400).json({ error: 'Datei zu gross (>10MB)' });
    const konto = String(req.user?.email || req.user?.name || 'unknown').toLowerCase();
    const jetzt = Date.now();
    const bisher = (ocrAufrufe.get(konto) || []).filter(t => jetzt - t < OCR_FENSTER_MS);
    if (bisher.length >= OCR_MAX) return res.status(429).json({ error: 'Zu viele Auslese-Versuche — bitte später erneut oder von Hand erfassen' });
    ocrAufrufe.set(konto, [...bisher, jetzt]);
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
      return res.status(502).json({ error: `OCR-Service-Fehler (HTTP ${orRes.status})` });
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
    res.status(500).json({ error: 'OCR fehlgeschlagen' });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id — Daten + Bild speichern (multipart-base64)
// Body: { eigentumsform, eigentuemer:[], wohnadressen:[], anteil_z?, flaeche_m2?, notizen?, bild_base64?, bild_filename? }
router.post('/anteile/:parzelle/:sub_id', authMiddleware, async (req, res) => {
  try {
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    if (!Number.isFinite(p) || !Number.isFinite(s)) return res.status(400).json({ error: 'Ungültige Parzelle' });
    const me = ich(req);
    const b = req.body || {};
    // Speichern darf, wer den Anteil reserviert hat oder ihn selbst erfasst hat (Korrektur
    // vor der Freigabe); Ausschuss/Technik immer. Vorher konnte jedes Konto auch
    // freigegebene Anteile ueberschreiben (Status sprang auf 'erfasst' zurueck).
    const cur = (await pool.query('SELECT stweg, status, reserviert_von, erfasst_von, anteil_z FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Anteil nicht gefunden' });
    const g = gruppen(req);
    if (!gb.gbAnteilErfassen(g, cur.stweg)) return res.status(403).json({ error: KEIN_ERFASSEN });
    const darf = gb.gbVollSicht(g, cur.stweg)
      || (cur.status === 'reserviert' && cur.reserviert_von === me)
      || (cur.status === 'erfasst' && cur.erfasst_von === me);
    if (!darf) return res.status(403).json({ error: cur.status === 'freigegeben' ? 'Bereits freigegeben — nur Ausschuss dieser STWEG/Technik' : 'Bitte zuerst reservieren' });
    // Eigentuemer und Adressen landen in einer Tabelle, die andere im Browser
    // anzeigen: nur Listen kurzer Zeichenketten, keine spitzen Klammern.
    const textListe = (v) => v === undefined || v === null ? null
      : (Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && x.length <= 200 && !/[<>]/.test(x))
        ? v.map(x => x.trim()).filter(Boolean) : undefined);
    const eigentuemer = textListe(b.eigentuemer), wohnadressen = textListe(b.wohnadressen);
    if (eigentuemer === undefined || wohnadressen === undefined) {
      return res.status(400).json({ error: 'eigentuemer/wohnadressen: Liste von Texten (max. 20 × 200 Zeichen, ohne < >)' });
    }
    for (const [feld, max] of [['eigentumsform', 200], ['notizen', 2000]]) {
      if (b[feld] !== undefined && b[feld] !== null && (typeof b[feld] !== 'string' || b[feld].length > max || /[<>]/.test(b[feld]))) {
        return res.status(400).json({ error: `${feld}: Text bis ${max} Zeichen, ohne < >` });
      }
    }
    let bildPath = null;
    if (b.bild_base64 && b.bild_filename) {
      const ext = (b.bild_filename.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'pdf'].includes(ext)) return res.status(400).json({ error: 'Nur PNG/JPG/PDF erlaubt' });
      const buf = Buffer.from(b.bild_base64, 'base64');
      if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu gross (>10MB)' });
      const dir = pathModule.join(DOCS_PATH, GRUNDBUCH_BILDER_DIR);
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
      // Nur Ziffern in den Dateinamen ('../' aus dem Body schrieb sonst in fremde Ordner)
      const az = parseInt(b.anteil_z, 10) || parseInt(cur.anteil_z, 10) || null;
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
       eigentuemer ? JSON.stringify(eigentuemer) : null,
       wohnadressen ? JSON.stringify(wohnadressen) : null,
       b.flaeche_m2 || null, b.notizen || null,
       bildPath, me, p, s]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Anteil nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('grundbuch save err:', err.message);
    res.status(500).json({ error: 'Fehler' });
  }
});

// POST /api/grundbuch/anteile/:parzelle/:sub_id/verify — Ausschuss/Technik bestätigt
router.post('/anteile/:parzelle/:sub_id/verify', authMiddleware, async (req, res) => {
  try {
    const cur = await anteilLaden(req, res, 'stweg');
    if (!cur) return;
    if (!gb.gbVollSicht(gruppen(req), cur.stweg)) return res.status(403).json({ error: 'Nur der Ausschuss dieser STWEG oder Technik/Präsident darf verifizieren' });
    const p = parseInt(req.params.parzelle), s = parseInt(req.params.sub_id);
    const me = ich(req);
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
    const r = await pool.query('SELECT stweg, bild_path, erfasst_von, reserviert_von FROM grundbuch_anteile WHERE parzelle=$1 AND sub_id=$2', [p, s]);
    if (!r.rows[0]?.bild_path) return res.status(404).end();
    // Der Auszug zeigt Namen und Adressen — wie in der Liste nur fuer den
    // Ausschuss dieser STWEG, Technik/Praesident und wer den Anteil selbst bearbeitet.
    const me = ich(req);
    if (!gb.gbVollSicht(gruppen(req), r.rows[0].stweg) && r.rows[0].erfasst_von !== me && r.rows[0].reserviert_von !== me) {
      return res.status(403).json({ error: 'Nur der Ausschuss dieser STWEG, Technik/Präsident oder wer den Anteil erfasst hat' });
    }
    const fullPath = pathModule.join(DOCS_PATH, r.rows[0].bild_path);
    if (!fullPath.startsWith(pathModule.resolve(DOCS_PATH) + '/')) return res.status(400).end();
    const ext = r.rows[0].bild_path.split('.').pop().toLowerCase();
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf' };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Fehlt die Datei, darf der Stream-Fehler den Prozess nicht beenden.
    const strom = fsSync.createReadStream(fullPath);
    strom.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    strom.pipe(res);
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

// GET /api/grundbuch/parzellen/vorschlag — Vorschlag Parzelle -> STWEG aus Wertquoten
// der Wohnungen, Anzahl Anteile und erfassten Rosenweg-Adressen (lib/grundbuch-vorschlag.js).
// Nur Technik/Praesident, nur lesen: schreibt nichts; Antwort nur Parzellen, STWEG
// und Zahlen (keine Namen, keine Adressen). Uebernehmen: PUT …/:parzelle/stweg.
router.get('/parzellen/vorschlag', authMiddleware, async (req, res) => {
  if (!istTP(req)) return res.status(403).json({ error: 'Vorschlag nur für Technik/Präsident' });
  try {
    const [a, w] = await Promise.all([
      pool.query('SELECT parzelle, anteil_z, anteil_n, wohnadressen, stweg FROM grundbuch_anteile'),
      pool.query('SELECT stweg, wertquote_zaehler, wertquote_nenner FROM wohnungen'),
    ]);
    res.json({ vorschlaege: gbVorschlag.parzellenVorschlag(a.rows, w.rows) });
  } catch (err) { res.status(500).json({ error: 'Vorschlag konnte nicht berechnet werden' }); }
});

// PUT /api/grundbuch/parzellen/:parzelle/stweg — STWEG einer Parzelle setzen
// (alle Anteile der Parzelle). Nur Technik/Praesident, mit Protokoll. Body: { stweg: 1..8 | null }
router.put('/parzellen/:parzelle/stweg', authMiddleware, kartenAdmin.mitKarteProtokollieren, async (req, res) => {
  if (!istTP(req)) return res.status(403).json({ error: 'STWEG zuordnen nur Technik/Präsident' });
  try {
    const p = parseInt(req.params.parzelle);
    if (!Number.isFinite(p)) return res.status(400).json({ error: 'Ungültige Parzelle' });
    const roh = req.body?.stweg;
    const stweg = roh === null || roh === '' || roh === undefined ? null : parseInt(roh, 10);
    if (stweg !== null && !(Number.isInteger(stweg) && stweg >= 1 && stweg <= 8)) return res.status(400).json({ error: 'stweg: 1 bis 8 oder leer' });
    const r = await pool.query('UPDATE grundbuch_anteile SET stweg = $1, updated_at = now() WHERE parzelle = $2', [stweg, p]);
    if (!r.rowCount) return res.status(404).json({ error: 'Parzelle nicht gefunden' });
    await adminProtokoll.eintragen(pool, null, req, {
      bereich: 'grundbuch', aktion: 'stweg-zugeordnet', ziel: `Parzelle ${p}`, neu: stweg ? `STWEG ${stweg}` : 'ohne STWEG',
      detail: `${r.rowCount} Anteile`,
    }).catch(e => console.error('[grundbuch] Protokoll:', e.message));
    res.json({ ok: true, parzelle: p, stweg, anteile: r.rowCount });
  } catch (err) { res.status(500).json({ error: 'Fehler' }); }
});

module.exports = router;
