// ═══════════════════════════════════════════════════════════════════
// Persönliche App-Daten abgleichen (alle Geräte einer Person gleich)
// ═══════════════════════════════════════════════════════════════════
// Erste App: Rosenweg Uhr (Wecker, Weltuhren, Timer-Vorlagen). Modell,
// Konfliktregel und Grenzen: lib/app-daten.js.
//
//   GET /api/me/app-daten/:app?seit=<version>
//       -> { app, version, person, eintraege: [{art,id,geaendert,geloescht,daten,version}] }
//       Ohne seit: alles (auch Grabsteine). ETag "v<version>"; If-None-Match -> 304.
//   PUT /api/me/app-daten/:app   { seit, eintraege: [{art,id,geaendert,geloescht,daten}], geraet? }
//       Einträge hochladen; je Eintrag gilt die letzte Änderung. Antwort wie GET
//       (alles seit [seit], dazu abgelehnte Einträge mit dem Stand des Servers)
//       plus { uebernommen, abgelehnt }.
//
// Ausweise: alle der Haupt-API (Rosenweg-Konto der App, Karten-/QR-Sitzung,
// geteiltes Telefon über Rosenweg Gerät und die Anlage, Browser, PAT). Nur die
// Person selbst; keine Technik-Ansicht — Weckzeiten sind persönlich. Karten-
// Sitzung und Anlage-Token gelten nur für ihre eigene App (zugriffVerweigert).
//
// Warum hier und nicht in der Nextcloud der Person (Entscheid 27.11.2026):
// geteilte Telefone reichen jede Anfrage einzeln über Rosenweg Gerät und die
// Anlage weiter (portal_anfrage) — die Nextcloud geht dort nur über ein App-
// Passwort der Sitzung, das z.B. nach dem Neustart erst wieder geholt werden
// muss, und Konflikte je Eintrag bräuchten dort eine Datei je Eintrag (ETags
// je Datei, PROPFIND). Hier: ein Aufruf je Abgleich, Version statt Dateiliste,
// gleicher Weg wie die übrigen Portal-Daten der Apps.

const ad = require('../lib/app-daten');

const schemaVersprechen = new WeakMap();
function ensureSchema(pool) {
  if (!schemaVersprechen.has(pool)) {
    schemaVersprechen.set(pool, pool.query(`
      CREATE TABLE IF NOT EXISTS app_daten (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app TEXT NOT NULL,
        art TEXT NOT NULL,
        schluessel TEXT NOT NULL,
        daten JSONB,
        geloescht BOOLEAN NOT NULL DEFAULT false,
        geaendert BIGINT NOT NULL,
        version BIGINT NOT NULL,
        geraet TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, app, art, schluessel)
      );
      CREATE INDEX IF NOT EXISTS app_daten_version ON app_daten (user_id, app, version);
    `).catch((e) => { schemaVersprechen.delete(pool); throw e; }));
  }
  return schemaVersprechen.get(pool);
}

const SPALTEN = 'art, schluessel, daten, geloescht, geaendert, version';

async function stand(q, userId, app) {
  const r = await q.query(
    `/* app-daten:stand */ SELECT COALESCE(MAX(version), 0) AS version, COUNT(*) AS anzahl
       FROM app_daten WHERE user_id = $1 AND app = $2`, [userId, app]);
  return { version: Number(r.rows[0]?.version || 0), anzahl: Number(r.rows[0]?.anzahl || 0) };
}

async function seitLesen(q, userId, app, seit) {
  const r = await q.query(
    `/* app-daten:seit */ SELECT ${SPALTEN} FROM app_daten
      WHERE user_id = $1 AND app = $2 AND version > $3 ORDER BY version`, [userId, app, seit]);
  return r.rows;
}

/** GET: alles seit [seit]. */
async function holen({ pool, userId, app, seit }) {
  await ensureSchema(pool);
  const { version } = await stand(pool, userId, app);
  const zeilen = seit >= version ? [] : await seitLesen(pool, userId, app, seit);
  return { app, version, person: { id: userId }, eintraege: ad.antwortEintraege(zeilen) };
}

/** PUT: Einträge zusammenführen. -> { status, json } */
async function abgleichen({ pool, userId, app, body, jetzt = Date.now() }) {
  const b = body && typeof body === 'object' ? body : {};
  const p = ad.eintraegePruefen(b.eintraege ?? [], jetzt);
  if (p.fehler) return { status: 400, json: { error: p.fehler } };
  const seit = ad.seitAus(b.seit);
  const geraet = ad.geraetName(b.geraet);
  await ensureSchema(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Je Person und App nacheinander: sonst koennten zwei Geraete dieselbe Version vergeben
    // oder eines eine Aenderung uebersehen (Version vergeben, aber noch nicht sichtbar).
    await c.query(`/* app-daten:sperre */ SELECT pg_advisory_xact_lock(hashtext('app_daten'), hashtext($1))`,
      [`${userId}:${app}`]);
    const gespeichert = new Map();
    if (p.eintraege.length) {
      const r = await c.query(
        `/* app-daten:lesen */ SELECT ${SPALTEN} FROM app_daten
          WHERE user_id = $1 AND app = $2
            AND (art, schluessel) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
        [userId, app, p.eintraege.map(e => e.art), p.eintraege.map(e => e.id)]);
      for (const z of r.rows) gespeichert.set(`${z.art}\u0000${z.schluessel}`, z);
    }
    const { schreiben, abgelehnt } = ad.entscheiden(p.eintraege, gespeichert);
    const s = await stand(c, userId, app);
    let version = s.version;
    if (schreiben.length) {
      const neu = schreiben.filter(e => !gespeichert.has(`${e.art}\u0000${e.id}`)).length;
      if (s.anzahl + neu > ad.GRENZEN.eintraegeJeApp) {
        await c.query('ROLLBACK');
        return { status: 413, json: { error: `Höchstens ${ad.GRENZEN.eintraegeJeApp} Einträge je App` } };
      }
      version += 1;
      await c.query(
        `/* app-daten:schreiben */ INSERT INTO app_daten
           (user_id, app, art, schluessel, daten, geloescht, geaendert, version, geraet, updated_at)
         SELECT $1, $2, x.art, x.schluessel, x.daten, x.geloescht, x.geaendert, $3, $4, NOW()
           FROM unnest($5::text[], $6::text[], $7::jsonb[], $8::boolean[], $9::bigint[])
             AS x(art, schluessel, daten, geloescht, geaendert)
         ON CONFLICT (user_id, app, art, schluessel) DO UPDATE SET
           daten = EXCLUDED.daten, geloescht = EXCLUDED.geloescht, geaendert = EXCLUDED.geaendert,
           version = EXCLUDED.version, geraet = EXCLUDED.geraet, updated_at = NOW()`,
        [userId, app, version, geraet,
          schreiben.map(e => e.art), schreiben.map(e => e.id),
          schreiben.map(e => (e.geloescht ? null : JSON.stringify(e.daten))),
          schreiben.map(e => e.geloescht), schreiben.map(e => e.geaendert)]);
    }
    // Alte Grabsteine aufraeumen (selten: nur wenn ohnehin geschrieben wird)
    if (schreiben.length) {
      await c.query(
        `/* app-daten:aufraeumen */ DELETE FROM app_daten WHERE user_id = $1 AND app = $2 AND geloescht
            AND updated_at < NOW() - make_interval(days => $3)`, [userId, app, ad.GRENZEN.grabsteinTage]);
    }
    const zeilen = seit >= version ? [] : await seitLesen(c, userId, app, seit);
    await c.query('COMMIT');
    return {
      status: 200,
      json: {
        app, version, person: { id: userId }, eintraege: ad.antwortEintraege(zeilen, abgelehnt),
        uebernommen: schreiben.length, abgelehnt: abgelehnt.length,
      },
    };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* Verbindung weg */ }
    throw e;
  } finally {
    c.release();
  }
}

function appDatenRoutes(app, { pool, authMiddleware }) {
  const pruefen = (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = String(req.params.app || '').toLowerCase();
    if (!ad.appGueltig(name)) {
      res.status(400).json({ error: 'App unbekannt (erwartet ch.rosenweg4303.<name>)' });
      return null;
    }
    const nein = ad.zugriffVerweigert(req, name);
    if (nein) {
      res.status(403).json({ error: nein });
      return null;
    }
    return name;
  };

  app.get('/api/me/app-daten/:app', authMiddleware, async (req, res) => {
    const name = pruefen(req, res);
    if (!name) return;
    try {
      const a = await holen({ pool, userId: ad.benutzerId(req), app: name, seit: ad.seitAus(req.query.seit) });
      const etag = `"v${a.version}"`;
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.json(a);
    } catch (e) {
      console.error('[app-daten] holen:', e.message);
      res.status(500).json({ error: 'Interner Fehler' });
    }
  });

  app.put('/api/me/app-daten/:app', authMiddleware, async (req, res) => {
    const name = pruefen(req, res);
    if (!name) return;
    try {
      const r = await abgleichen({ pool, userId: ad.benutzerId(req), app: name, body: req.body });
      if (r.status === 200) res.set('ETag', `"v${r.json.version}"`);
      res.status(r.status).json(r.json);
    } catch (e) {
      console.error('[app-daten] abgleichen:', e.message);
      res.status(500).json({ error: 'Interner Fehler' });
    }
  });
}

module.exports = { appDatenRoutes, holen, abgleichen, ensureSchema };
