// Rosenweg Handwerker (App) — zusätzliche API (Klärung Welle 3.3; Entscheide Stefan 28.11.2026):
//
//   GET  /api/handwerker-erinnerungen        E7: fällige Erinnerungen (30/7 Tage vor Termin bzw. Ende der
//                                            Kündigungsfrist) für die Verwaltung der STWEG; T/P für „alle STWEG“.
//                                            Die App holt sie im Hintergrund und zeigt sie als Benachrichtigung.
//   GET  /api/handwerker-vorschlaege         E8: offene Vorschläge aus Reparatur (Einsatz nach „erledigt“,
//                                            Benachrichtigung an die Firma nach Zuweisung)
//   POST /api/handwerker-vorschlaege/:id/uebernehmen   Einsatz anlegen bzw. Mail an die Firma senden
//   POST /api/handwerker-vorschlaege/:id/verwerfen
//   POST /api/handwerker-export              E13: Export (Excel/CSV, in der App erzeugt) vorher anmelden:
//                                            nur die eigene STWEG, mit Protokolleintrag
//   DELETE /api/handwerker/:id/personen/:pid E12: einen Mitarbeiter einer Firma löschen
//   GET  /api/handwerker/:id                 eine Firma (Verweis aus einer Benachrichtigung)
//
// Alles hängt am Seitenrecht „handwerker“ und an der STWEG-Bindung (lib/handwerker-rechte.js).
const hwRechte = require('../lib/handwerker-rechte');
const ha = require('../lib/handwerker-app');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS handwerker_vorschlaege (
    id SERIAL PRIMARY KEY,
    art VARCHAR(20) NOT NULL CHECK (art IN ('einsatz', 'benachrichtigung')),
    reklamation_id INTEGER NOT NULL,
    handwerker_id INTEGER NOT NULL REFERENCES handwerker(id) ON DELETE CASCADE,
    stweg INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'uebernommen', 'verworfen')),
    auftrag_id INTEGER,
    bearbeitet_von VARCHAR(255),
    bearbeitet_am TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (reklamation_id, handwerker_id, art)
  );
  CREATE INDEX IF NOT EXISTS idx_handwerker_vorschlaege_offen ON handwerker_vorschlaege(status, stweg);
`;

/** Vorschlag aus einer Reparatur-Meldung anlegen (Hook in updateReklamation). Doppelte werden ignoriert. */
async function vorschlagAnlegen(pool, art, rekl) {
  if (!rekl || !rekl.handwerker_id || !['einsatz', 'benachrichtigung'].includes(art)) return null;
  const r = await pool.query(
    `INSERT INTO handwerker_vorschlaege (art, reklamation_id, handwerker_id, stweg)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (reklamation_id, handwerker_id, art) DO NOTHING RETURNING id`,
    [art, rekl.id, rekl.handwerker_id, rekl.stweg ?? null]);
  return r.rows[0]?.id ?? null;
}

function handwerkerAppRoutes(app, d) {
  const { pool, authMiddleware, requirePermission, hwSchreibend, hwSichtVon, hwFirmaLesbar, hwFirmaAntwort,
    objProtokoll, loggedSendMail, logReklEvent } = d;  // d.kartenProtokollieren: Karte wie Schlüssel, nur vermerken
  const lesen = [authMiddleware, requirePermission('handwerker', 'read')];

  /** Darf das Konto Vorschläge dieser STWEG bearbeiten? (Verwaltung eigene STWEG; „alle“ T/P) */
  const darfVorschlag = (sicht, stweg) => ha.erinnerungEmpfaenger(sicht, stweg) || (sicht.alle && stweg !== null);

  app.get('/api/handwerker-erinnerungen', ...lesen, async (req, res) => {
    try {
      const sicht = hwSichtVon(req);
      const r = await pool.query(
        `SELECT v.id, v.handwerker_id, v.titel, v.stweg, v.kuendigungsfrist_tage, h.firma,
                to_char(v.naechster_termin, 'YYYY-MM-DD') AS naechster_termin,
                to_char(v.endet_am, 'YYYY-MM-DD') AS endet_am
           FROM handwerker_vertraege v JOIN handwerker h ON h.id = v.handwerker_id
          WHERE v.status = 'aktiv' AND h.archiviert = false`);
      res.set('Cache-Control', 'private, no-store');
      res.json({ erinnerungen: ha.erinnerungenFuer(sicht, r.rows, new Date()), stand: new Date().toISOString() });
    } catch (err) {
      console.error('Handwerker Erinnerungen:', err);
      res.status(500).json({ error: 'Fehler beim Laden der Erinnerungen' });
    }
  });

  app.get('/api/handwerker-vorschlaege', ...lesen, async (req, res) => {
    try {
      const sicht = hwSichtVon(req);
      const r = await pool.query(
        `SELECT p.*, h.firma, h.email AS firma_email,
                (SELECT email FROM handwerker_personen WHERE handwerker_id = h.id AND email IS NOT NULL AND email <> '' ORDER BY sort_order, id LIMIT 1) AS mitarbeiter_email,
                k.beschreibung, k.kategorie, k.erledigt_am
           FROM handwerker_vorschlaege p
           JOIN handwerker h ON h.id = p.handwerker_id
           JOIN reklamationen k ON k.id = p.reklamation_id
          WHERE p.status = 'offen' AND h.archiviert = false
          ORDER BY p.created_at DESC LIMIT 200`);
      const absender = { name: req.user?.name, email: req.user?.email };
      const liste = r.rows.filter(p => darfVorschlag(sicht, p.stweg ?? null)).map(p => {
        const rekl = { id: p.reklamation_id, kategorie: p.kategorie, beschreibung: p.beschreibung, stweg: p.stweg, erledigt_am: p.erledigt_am };
        const base = { id: p.id, art: p.art, reklamation_id: p.reklamation_id, handwerker_id: p.handwerker_id, firma: p.firma, stweg: p.stweg, erstellt: p.created_at };
        if (p.art === 'einsatz') return { ...base, ...ha.einsatzVorschlag(rekl) };
        const m = ha.auftragsMailText(rekl, absender);
        return { ...base, an: p.firma_email || p.mitarbeiter_email || null, betreff: m.betreff, text: m.text };
      });
      res.set('Cache-Control', 'private, no-store');
      res.json({ vorschlaege: liste });
    } catch (err) {
      console.error('Handwerker Vorschläge:', err);
      res.status(500).json({ error: 'Fehler beim Laden der Vorschläge' });
    }
  });

  async function offenerVorschlag(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) { res.status(400).json({ error: 'Ungültige ID' }); return null; }
    const r = await pool.query('SELECT * FROM handwerker_vorschlaege WHERE id = $1', [id]);
    const p = r.rows[0];
    const sicht = hwSichtVon(req);
    if (!p || !darfVorschlag(sicht, p.stweg ?? null)) { res.status(404).json({ error: 'Vorschlag nicht gefunden' }); return null; }
    if (p.status !== 'offen') { res.status(409).json({ error: 'Dieser Vorschlag ist schon erledigt' }); return null; }
    if (!hwRechte.hwSchreiben(sicht, p.stweg ?? null)) { res.status(403).json({ error: 'Nur Eigenes der Verwaltung dieser STWEG; für alle STWEG Technik und Präsident' }); return null; }
    return p;
  }

  app.post('/api/handwerker-vorschlaege/:id/uebernehmen', authMiddleware, ...hwSchreibend, async (req, res) => {
    const client = await pool.connect();
    try {
      const p = await offenerVorschlag(req, res);
      if (!p) return;
      const b = req.body || {};
      const wer = req.user?.name || req.user?.email || 'Verwaltung';
      if (p.art === 'einsatz') {
        const rk = (await pool.query('SELECT id, kategorie, beschreibung, erledigt_am FROM reklamationen WHERE id = $1', [p.reklamation_id])).rows[0];
        const vor = ha.einsatzVorschlag(rk || { id: p.reklamation_id });
        const datum = /^\d{4}-\d{2}-\d{2}$/.test(b.datum || '') ? b.datum : vor.datum;
        const beschreibung = (String(b.beschreibung || '').trim() || vor.beschreibung).slice(0, 2000);
        const kosten = b.kosten === undefined || b.kosten === null || b.kosten === '' ? null : parseFloat(b.kosten);
        if (kosten !== null && !Number.isFinite(kosten)) return res.status(400).json({ error: 'Kosten sind keine Zahl' });
        const bew = ha.bewertungNormal(b);
        await client.query('BEGIN');
        const a = await client.query(
          `INSERT INTO handwerker_auftraege (handwerker_id, datum, beschreibung, kosten, stweg, reklamation_id, bewertung, bewertung_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [p.handwerker_id, datum, beschreibung, kosten, p.stweg ?? null, p.reklamation_id, bew.bewertung, bew.bewertung_text]);
        await d.syncLetzterAuftrag(client, p.handwerker_id);
        await client.query(`UPDATE handwerker_vorschlaege SET status = 'uebernommen', auftrag_id = $2, bearbeitet_von = $3, bearbeitet_am = NOW() WHERE id = $1`,
          [p.id, a.rows[0].id, wer]);
        await client.query('COMMIT');
        logReklEvent?.(p.reklamation_id, wer, 'Einsatz bei der Firma erfasst (Rosenweg Handwerker)').catch?.(() => {});
        await objProtokoll(req, 'handwerker', 'einsatz-aus-meldung', `Firma ${p.handwerker_id}`, [`Meldung ${p.reklamation_id}`, p.stweg ? `STWEG ${p.stweg}` : 'alle STWEG']);
        return res.json({ ok: true, auftrag_id: a.rows[0].id });
      }
      // Benachrichtigung an die Firma: erst nach Bestätigung, Text und Empfänger darf die Verwaltung ändern
      const an = String(b.an || '').trim();
      const text = String(b.text || '').trim();
      if (!ha.mailOk(an)) return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse der Firma angeben', feld: 'an' });
      if (text.length < 20) return res.status(400).json({ error: 'Bitte den Text der Nachricht angeben', feld: 'text' });
      const betreff = String(b.betreff || '').trim().slice(0, 200) || 'Anfrage Rosenweg';
      try {
        await loggedSendMail({
          to: an, replyTo: req.user?.email || undefined, subject: betreff, text: text.slice(0, 5000),
        }, 'handwerker-auftrag');
      } catch (mailErr) {
        console.error('Handwerker Auftrag-Mail:', mailErr.message);
        return res.status(502).json({ error: 'Die Nachricht konnte nicht gesendet werden. Bitte später nochmals versuchen.' });
      }
      await pool.query(`UPDATE handwerker_vorschlaege SET status = 'uebernommen', bearbeitet_von = $2, bearbeitet_am = NOW() WHERE id = $1`, [p.id, wer]);
      logReklEvent?.(p.reklamation_id, wer, 'Nachricht an die zugewiesene Firma gesendet').catch?.(() => {});
      await objProtokoll(req, 'handwerker', 'auftrag-gesendet', `Firma ${p.handwerker_id}`, [`Meldung ${p.reklamation_id}`, p.stweg ? `STWEG ${p.stweg}` : 'alle STWEG']);
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Handwerker Vorschlag übernehmen:', err);
      res.status(500).json({ error: 'Fehler beim Übernehmen' });
    } finally {
      client.release();
    }
  });

  app.post('/api/handwerker-vorschlaege/:id/verwerfen', authMiddleware, ...hwSchreibend, async (req, res) => {
    try {
      const p = await offenerVorschlag(req, res);
      if (!p) return;
      await pool.query(`UPDATE handwerker_vorschlaege SET status = 'verworfen', bearbeitet_von = $2, bearbeitet_am = NOW() WHERE id = $1`,
        [p.id, req.user?.name || req.user?.email || 'Verwaltung']);
      res.json({ ok: true });
    } catch (err) {
      console.error('Handwerker Vorschlag verwerfen:', err);
      res.status(500).json({ error: 'Fehler beim Verwerfen' });
    }
  });

  // E13: Export nur im Umfang der eigenen STWEG, mit Protokolleintrag. Die Datei erzeugt die App aus
  // den Daten, die sie schon hat (die Liste ist bereits nach STWEG gefiltert); hier wird angemeldet.
  app.post('/api/handwerker-export', ...lesen, d.kartenProtokollieren, async (req, res) => {
    try {
      const sicht = hwSichtVon(req);
      const b = req.body || {};
      const stweg = b.stweg === undefined || b.stweg === null || b.stweg === '' ? null : parseInt(b.stweg, 10);
      if (b.stweg !== undefined && b.stweg !== null && b.stweg !== '' && !(stweg >= 1 && stweg <= 8)) return res.status(400).json({ error: 'Ungültige STWEG-Nummer' });
      if (stweg !== null && !sicht.alle && !sicht.lesen.has(stweg)) return res.status(403).json({ error: 'Export nur für die eigene STWEG' });
      if (stweg === null && !sicht.alle && sicht.lesen.size !== 1) return res.status(400).json({ error: 'Bitte die STWEG für den Export angeben' });
      const ziel = stweg ?? (sicht.alle ? null : [...sicht.lesen][0]);
      const format = ['xlsx', 'csv'].includes(b.format) ? b.format : null;
      const anzahl = Number.isFinite(Number(b.anzahl)) ? Math.max(0, Math.floor(Number(b.anzahl))) : null;
      await objProtokoll(req, 'handwerker', 'export', ziel ? `STWEG ${ziel}` : 'alle STWEG', [format, anzahl !== null ? `${anzahl} Firmen` : null]);
      res.json({ ok: true, stweg: ziel });
    } catch (err) {
      console.error('Handwerker Export:', err);
      res.status(500).json({ error: 'Fehler beim Protokollieren des Exports' });
    }
  });

  // E12: Mitarbeiter einer Firma löschen (einfacher Weg, z. B. auf Wunsch der Person). Wer die Stammdaten
  // der Firma ändern darf, darf auch ihre Mitarbeiter löschen; protokolliert ohne den Namen.
  app.delete('/api/handwerker/:id/personen/:pid', authMiddleware, ...hwSchreibend, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const pid = parseInt(req.params.pid, 10);
      if (!Number.isFinite(pid) || pid < 1) return res.status(400).json({ error: 'Ungültige ID' });
      const firma = await hwFirmaLesbar(req, res, id);
      if (!firma) return;
      if (!hwRechte.hwStammAendern(hwSichtVon(req), firma.stweg)) {
        return res.status(403).json({ error: 'Diese Firma gehört zu einer anderen STWEG; ihre Mitarbeiter ändern deren Verwaltung, Technik und Präsident.' });
      }
      const r = await pool.query('DELETE FROM handwerker_personen WHERE id = $1 AND handwerker_id = $2 RETURNING id', [pid, id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Mitarbeiter nicht gefunden' });
      await objProtokoll(req, 'handwerker', 'mitarbeiter-geloescht', `Firma ${id}`, [`Mitarbeiter ${pid}`, firma.stweg ? `STWEG ${firma.stweg}` : 'gemeinsamer Stamm']);
      res.json({ success: true });
    } catch (err) {
      console.error('Handwerker Mitarbeiter löschen:', err);
      res.status(500).json({ error: 'Fehler beim Löschen' });
    }
  });

  app.get('/api/handwerker/:id(\\d+)', ...lesen, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!(await hwFirmaLesbar(req, res, id))) return;
      const r = await pool.query('SELECT * FROM handwerker WHERE id = $1', [id]);
      res.json(await hwFirmaAntwort(req, r.rows[0]));
    } catch (err) {
      console.error('Handwerker Firma:', err);
      res.status(500).json({ error: 'Fehler beim Laden der Firma' });
    }
  });
}

module.exports = { handwerkerAppRoutes, vorschlagAnlegen, SCHEMA_SQL };
