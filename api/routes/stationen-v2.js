// ═══════════════════════════════════════════════════════════════════
// STATIONEN-PROTOKOLL v2 — ein Agent für alle Geräte
// (Rosenweg/rosenweg-agent, Beschreibung dort in docs/protokoll-v2.md)
//
// Bis hierher sprach jede Geräteart ihr eigenes Protokoll: Linux-Stationen
// das Lebenszeichen von station-agent.sh (routes/stations.js, POST /:id/seen),
// Windows-PCs gar keins — sie standen nur aus dem AD-Abgleich auf /stationen,
// ohne Zustand, ohne Sperre, ohne Anschluss-Wächter. Stefan, 27.11.2026:
// „den Agenten für alle Systeme, die wir haben, einheitlich machen".
//
// Gemeinsam sind seither: ein Lebenszeichen mit demselben Inventar, Befehle,
// die beim Lebenszeichen abgeholt und quittiert werden, und die Sperre als
// Zustand in jeder Antwort. Die Tabelle bleibt `stations`, das Token bleibt
// rw_station_… — ein Gerät ist dieselbe Zeile, egal welches Protokoll es spricht.
//
//   Agent
//     POST /api/stations/v2/anmelden       Kerberos (Computerkonto) -> Token
//     POST /api/stations/v2/lebenszeichen  Inventar, Quittungen -> Sperre, Befehle
//
//   Verwaltung (Gruppe technik)
//     GET    /api/stations/v2/admin/:id/befehle        letzte Befehle
//     POST   /api/stations/v2/admin/:id/befehle        { art, parameter }
//     DELETE /api/stations/v2/admin/:id/befehle/:bid   zurückziehen (nur unabgeholt)
//
// Während der Umstellung spricht die API beide Protokolle: v1 (/:id/seen,
// /:id/config …) bleibt für os-stationen unverändert. Ein Windows-Token gilt
// dort nicht (stationAuth weist es ab) — es soll keine Linux-Konfiguration mit
// WLAN-Schlüsseln und Beitrittskonto bekommen.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const { isTechnik } = require('../lib/groups');
const P = require('../lib/stationprotokoll');
const kerberos = require('../lib/kerberos');

const STATION_PREFIX = 'rw_station_';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Linux-Rollen von os-stationen. Eine Station dieser Rollen spricht v2 nur mit
// agent.plattform 'linux'; ein Windows-PC nur mit 'windows'. Wer mit einem
// fremden Token eine andere Plattform behauptet, bekommt 400 statt einer
// halb passenden Antwort.
const LINUX_ROLLEN = ['desktop', 'display', 'laptop'];

/**
 * @param {object} intern  Helfer aus routes/stations.js (ensureSchema,
 *   ereignis, clientIp, nurAusDemHausnetz, lebenszeichenPruefen, adAbgleichen,
 *   adLesbar) — derselbe Weg wie dort, kein zweiter Nachbau.
 */
module.exports = function stationenV2(intern) {
  const router = express.Router();
  const { ereignis, clientIp } = intern;

  // Spalten und Tabelle (station_befehle) legt routes/stations.js an:
  // /admin/list liest beides auch dann, wenn hier noch nie ein Agent ankam.
  const ensureSchema = () => intern.ensureSchema();

  // ─── Anmeldung mit dem Computerkonto ──────────────────────────────
  //
  // POST /api/stations/v2/anmelden   Authorization: Negotiate <SPNEGO>
  //   { protokoll: 2, agent: {version, plattform}, inventar: {...} }
  //   -> { station_id, token, intervall_sekunden, protokoll }
  //
  // Warum Kerberos und nicht ein Token, das bei der Einrichtung auf den PC
  // kommt: auf einem Windows-PC der Domäne gibt es keinen Menschen, der ihn
  // „einrichtet" — er bekommt den Agenten per Gruppenrichtlinie. Ein Geheimnis
  // dafür müsste im SYSVOL liegen, und das liest jedes Konto der Domäne. Das
  // Computerkonto dagegen hat jeder PC schon, sein Schlüssel ist nur ihm und
  // dem DC bekannt, und Windows erneuert ihn selbst.
  //
  // Das Token, das hier herauskommt, hält der Agent nur im Speicher. Startet
  // der Dienst neu, meldet er sich wieder an und bekommt ein neues; das alte
  // ist damit wertlos. Auf der Platte liegt also nichts, was jemand kopieren
  // könnte — und zwei Geräte mit demselben Token kann es so nicht geben.
  //
  // Nur aus dem Hausnetz, wie /drucker: der Weg von aussen braucht es nicht,
  // und ein KDC-Ticket ist ohnehin nur dort zu bekommen.
  router.post('/anmelden', a(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!intern.nurAusDemHausnetz(req)) return res.status(403).json({ error: 'Nur aus dem internen Netz' });
    if (!kerberos.bereit()) {
      return res.status(503).json({ error: 'Kerberos ist in der API nicht eingerichtet (STATION_KRB5_KEYTAB, ad-dc/gpo-rosenweg-agent/kerberos-dienstkonto.sh)' });
    }
    const header = req.headers.authorization || '';
    if (!/^Negotiate\s/i.test(header)) {
      res.set('WWW-Authenticate', 'Negotiate');
      return res.status(401).json({ error: 'Kerberos-Anmeldung nötig (Negotiate)' });
    }
    const k = await kerberos.pruefen(header);
    if (!k.ok) {
      console.warn(`[stationen-v2] Kerberos abgelehnt von ${clientIp(req)}: ${k.grund}`);
      res.set('WWW-Authenticate', 'Negotiate');
      return res.status(401).json({ error: 'Kerberos-Anmeldung abgelehnt', grund: k.grund });
    }
    const rechner = P.rechnerAusPrincipal(k.principal, k.realm, kerberos.REALM);
    if (!rechner) {
      console.warn(`[stationen-v2] Anmeldung als '${k.principal}@${k.realm}' abgewiesen — kein Computerkonto dieser Domäne`);
      return res.status(403).json({ error: 'Nur Computerkonten der Domäne können sich hier anmelden' });
    }
    const agent = P.agentBereinigen(req.body?.agent);
    if (agent.plattform !== 'windows') {
      // Linux-Stationen haben ihr Stationstoken aus der Einrichtung (install.sh)
      // und brauchen dieses Tor nicht. Erst wenn der neue Agent dort
      // gleichwertig ist, kommt hier 'linux' dazu (docs/protokoll-v2.md,
      // Umstellung).
      return res.status(400).json({ error: 'Anmeldung per Kerberos gibt es vorerst nur für Windows' });
    }
    await ensureSchema();

    let st = await windowsZeile(rechner);
    if (!st.zeile && !st.sperre && intern.adLesbar()) {
      // Neu in der Domäne und der Abgleich lief noch nicht: einmal anstossen,
      // statt eine zweite Regel zu bauen, wie ein PC auf /stationen kommt.
      await intern.adAbgleichen(`Agent-Anmeldung ${rechner}`).catch((e) =>
        console.warn('[stationen-v2] AD-Abgleich bei der Anmeldung:', e.message));
      st = await windowsZeile(rechner);
    }
    if (st.sperre) return res.status(st.sperre.code).json({ error: st.sperre.text });
    if (!st.zeile) {
      return res.status(404).json({ error: `„${rechner}" steht nicht auf /stationen (AD-Abgleich, oder „Windows-Rechner eintragen")` });
    }

    const token = STATION_PREFIX + crypto.randomBytes(32).toString('hex');
    const inventar = P.inventarBereinigen(req.body?.inventar);
    const macs = P.macsAus(inventar);
    await pool.query(
      `UPDATE stations SET token_hash = $2, agent_protokoll = $3, agent_version = $4,
              agent_plattform = $5, agent_modus = $6, agent_angemeldet_am = NOW(),
              hardware = CASE WHEN $7::jsonb = '{}'::jsonb THEN hardware
                              ELSE jsonb_set(COALESCE(hardware, '{}'::jsonb), '{macs}', $7::jsonb) END
        WHERE id = $1`,
      [st.zeile.id, sha256(token), P.PROTOKOLL, agent.version, agent.plattform, agent.modus, JSON.stringify(macs)]);
    // Bei jedem Dienststart eine Zeile — das ist gewollt: man sieht, wann der
    // PC lief. Ein Ereignis je Anmeldung, nicht je Lebenszeichen.
    await ereignis(st.zeile.id, 'agent-angemeldet', `${rechner}$`, `Kerberos, Agent ${agent.version || '?'}`);
    console.log(`[stationen-v2] '${st.zeile.id}' angemeldet (Kerberos ${k.principal}, Agent ${agent.version || '?'})`);
    res.json({
      protokoll: P.PROTOKOLL,
      station_id: st.zeile.id,
      token,
      intervall_sekunden: P.intervall(st.zeile.overrides),
    });
  }));

  /** Die Zeile eines Windows-PCs — oder warum es keine gibt. */
  async function windowsZeile(rechner) {
    const { rows } = await pool.query(
      `SELECT id, role, revoked_at, overrides FROM stations
        WHERE LOWER(COALESCE(hostname, id)) = LOWER($1)
        ORDER BY (revoked_at IS NULL) DESC, registered_at DESC`, [rechner]);
    const offen = rows.filter((z) => !z.revoked_at);
    const win = offen.find((z) => z.role === 'windows');
    if (win) return { zeile: win };
    if (offen.length) {
      return { sperre: { code: 409, text: `„${rechner}" ist auf /stationen schon als ${offen[0].role} '${offen[0].id}' eingetragen` } };
    }
    // Auf /stationen entfernt: das ist eine Entscheidung, die eine
    // Anmeldung nicht rückgängig machen soll — genau wie beim AD-Abgleich.
    if (rows.some((z) => z.role === 'windows')) {
      return { sperre: { code: 403, text: `„${rechner}" wurde auf /stationen entfernt` } };
    }
    return {};
  }

  // ─── Token prüfen ─────────────────────────────────────────────────
  async function agentAuth(req, res, next) {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token.startsWith(STATION_PREFIX)) return res.status(401).json({ error: 'Kein Stationstoken' });
      await ensureSchema();
      const r = await pool.query('SELECT * FROM stations WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
      if (!r.rows.length) return res.status(401).json({ error: 'Stationstoken ungültig' });
      req.station = r.rows[0];
      next();
    } catch (e) { next(e); }
  }

  // ─── Lebenszeichen ────────────────────────────────────────────────
  //
  // POST /api/stations/v2/lebenszeichen   Authorization: Bearer rw_station_…
  //   { protokoll: 2, agent, inventar, quittungen: [{id, ergebnis, text}], meldungen: [...] }
  //   -> { ok, protokoll, station_id, intervall_sekunden, gesperrt, sperr_grund, befehle: [...] }
  //
  // Auch eine gesperrte Station kommt durch: das Lebenszeichen ist der Weg,
  // auf dem sie von ihrer Sperre erfährt — und von der Aufhebung.
  router.post('/lebenszeichen', agentAuth, a(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const st = req.station;
    if (Number(req.body?.protokoll) !== P.PROTOKOLL) return res.status(400).json({ error: 'protokoll: 2 erwartet' });
    const agent = P.agentBereinigen(req.body?.agent);
    const erwartet = st.role === 'windows' ? 'windows' : LINUX_ROLLEN.includes(st.role) ? 'linux' : null;
    if (!agent.plattform || agent.plattform !== erwartet) {
      return res.status(400).json({ error: `Diese Station spricht nicht als ${agent.plattform || '?'} (erwartet ${erwartet || 'keine'})` });
    }
    const inventar = P.inventarBereinigen(req.body?.inventar);
    const ip = clientIp(req);
    const antwort = {
      ok: true,
      protokoll: P.PROTOKOLL,
      station_id: st.id,
      intervall_sekunden: P.intervall(st.overrides),
      gesperrt: st.status === 'gesperrt',
      sperr_grund: st.status === 'gesperrt' ? (st.sperr_grund || null) : null,
      modus: agent.modus,
      befehle: [],
    };

    // Umstellung Linux: der neue Agent läuft neben dem alten und sieht nur
    // zu. last_state, Lebenszeichen und Sperre gehören weiter station-agent.sh;
    // Befehle gibt es keine — sonst führten zwei Programme dieselbe Station.
    if (agent.modus === 'parallel') {
      await pool.query(
        `UPDATE stations SET agent_protokoll = $2, agent_version = $3, agent_plattform = $4,
                agent_modus = 'parallel', agent_gesehen_am = NOW(), agent_inventar = $5 WHERE id = $1`,
        [st.id, P.PROTOKOLL, agent.version, agent.plattform, JSON.stringify(inventar)]);
      return res.json(antwort);
    }

    const state = { ...P.v1Felder(inventar, agent, st.id), agent, inventar };
    await pool.query(
      `UPDATE stations SET last_seen_at = NOW(), last_seen_ip = $2, last_state = $3,
              agent_protokoll = $4, agent_version = $5, agent_plattform = $6, agent_modus = 'voll',
              agent_gesehen_am = NOW(), agent_inventar = $7 WHERE id = $1`,
      [st.id, ip, JSON.stringify(state), P.PROTOKOLL, agent.version, agent.plattform, JSON.stringify(inventar)]);

    // Windows: die MACs fürs Inventar nachführen (der Anschluss-Wächter liest
    // hardware.macs). Bei Linux kommen sie aus der Einrichtung und bleiben.
    if (st.role === 'windows') {
      const macs = P.macsAus(inventar);
      const alt = JSON.stringify(Object.values(st.hardware?.macs || {}).sort());
      const neu = JSON.stringify(Object.values(macs).sort());
      if (Object.keys(macs).length && alt !== neu) {
        await pool.query(
          `UPDATE stations SET hardware = jsonb_set(COALESCE(hardware, '{}'::jsonb), '{macs}', $2::jsonb) WHERE id = $1`,
          [st.id, JSON.stringify(macs)]);
        if (alt !== '[]') await ereignis(st.id, 'macs-geaendert', null, `${Object.values(macs).join(', ')}`);
      }
    }

    // Doppelte Station — dieselbe Prüfung wie bei v1. Fehler hier dürfen das
    // Lebenszeichen nicht kosten.
    await intern.lebenszeichenPruefen(st, state, ip)
      .catch((e) => console.error('[stationen-v2] Doppel-Prüfung:', e.message));

    // Quittungen: nur für Befehle dieser Station, die abgeholt und noch offen sind.
    for (const q of P.quittungenBereinigen(req.body?.quittungen)) {
      const r = await pool.query(
        `UPDATE station_befehle SET erledigt_am = NOW(), ergebnis = $3, ergebnis_text = $4
          WHERE id = $1 AND station_id = $2 AND abgeholt_am IS NOT NULL AND erledigt_am IS NULL
          RETURNING art`, [q.id, st.id, q.ergebnis, q.text]);
      if (r.rows.length) {
        const titel = P.BEFEHLE[r.rows[0].art]?.titel || r.rows[0].art;
        await ereignis(st.id, `befehl-${q.ergebnis}`, null, `${titel}${q.text ? ': ' + q.text : ''}`);
      }
    }
    for (const m of P.meldungenBereinigen(req.body?.meldungen)) {
      await ereignis(st.id, `agent-${m.art}`, null, m.text);
    }

    // Verfallene zuerst als solche markieren, dann die gültigen ausliefern.
    // Ausgeliefert wird höchstens einmal (siehe lib/stationprotokoll.js).
    await pool.query(
      `UPDATE station_befehle SET erledigt_am = NOW(), ergebnis = 'verfallen'
        WHERE station_id = $1 AND abgeholt_am IS NULL AND erledigt_am IS NULL AND gueltig_bis <= NOW()`, [st.id]);
    const neu = await pool.query(
      `UPDATE station_befehle SET abgeholt_am = NOW()
        WHERE station_id = $1 AND abgeholt_am IS NULL AND erledigt_am IS NULL AND gueltig_bis > NOW()
        RETURNING id, art, parameter, gueltig_bis`, [st.id]);
    antwort.befehle = neu.rows.sort((x, y) => Number(x.id) - Number(y.id)).map(P.befehlFuerAgent);
    res.json(antwort);
  }));

  // ─── Verwaltung ───────────────────────────────────────────────────
  //
  // Nur die Gruppe technik — strenger als nurTechnik in stations.js, das
  // auch Präsident und Admin zulässt: ein Neustart oder Abmelden trifft
  // jemanden, der gerade davorsitzt (Stefan, 27.11.2026: „nur Technik").
  function nurTechnikGruppe(req, res, next) {
    if (isTechnik(req.user?.groups || [])) return next();
    return res.status(403).json({ error: 'Befehle an Geräte nur für die Gruppe technik' });
  }
  const wer = (req) => req.user?.email || req.user?.name || 'unbekannt';
  const OFFEN_MAX = 10;

  router.get('/admin/:id/befehle', authMiddleware, nurTechnikGruppe, a(async (req, res) => {
    await ensureSchema();
    const r = await pool.query(
      `SELECT id, art, parameter, angelegt_von, angelegt_am, gueltig_bis, abgeholt_am, erledigt_am,
              ergebnis, ergebnis_text, zurueckgezogen_von
         FROM station_befehle WHERE station_id = $1 ORDER BY angelegt_am DESC LIMIT 30`, [req.params.id]);
    res.json({ befehle: r.rows, arten: Object.fromEntries(Object.entries(P.BEFEHLE).map(([k, b]) => [k, { titel: b.titel, plattformen: b.plattformen }])) });
  }));

  router.post('/admin/:id/befehle', authMiddleware, nurTechnikGruppe, a(async (req, res) => {
    await ensureSchema();
    const { rows: [st] } = await pool.query(
      'SELECT id, agent_protokoll, agent_plattform, agent_modus FROM stations WHERE id = $1 AND revoked_at IS NULL', [req.params.id]);
    if (!st) return res.status(404).json({ error: 'Station nicht gefunden' });
    if (st.agent_modus === 'parallel') return res.status(409).json({ error: 'Der neue Agent läuft hier nur zur Probe neben dem alten — Befehle gibt es erst nach der Umstellung' });
    const plattform = Number(st.agent_protokoll) === P.PROTOKOLL ? st.agent_plattform : null;
    const e = P.befehlPruefen(String(req.body?.art || ''), req.body?.parameter, plattform);
    if (e.fehler) return res.status(400).json({ error: e.fehler });
    const offen = await pool.query(
      'SELECT COUNT(*)::int AS n FROM station_befehle WHERE station_id = $1 AND abgeholt_am IS NULL AND erledigt_am IS NULL', [st.id]);
    if (offen.rows[0].n >= OFFEN_MAX) return res.status(429).json({ error: 'Schon zu viele offene Befehle für diese Station' });
    const { rows: [b] } = await pool.query(
      `INSERT INTO station_befehle (station_id, art, parameter, angelegt_von, gueltig_bis)
       VALUES ($1, $2, $3::jsonb, $4, NOW() + make_interval(mins => $5))
       RETURNING id, art, parameter, angelegt_von, angelegt_am, gueltig_bis`,
      [st.id, e.wert.art, JSON.stringify(e.wert.parameter), wer(req), e.wert.minuten]);
    const titel = P.BEFEHLE[e.wert.art].titel;
    const zusatz = e.wert.parameter.text ? `: ${e.wert.parameter.text}` : '';
    await ereignis(st.id, 'befehl-angelegt', wer(req), `${titel}${zusatz}`);
    console.log(`[stationen-v2] Befehl ${e.wert.art} an '${st.id}' von ${wer(req)}`);
    res.status(201).json(b);
  }));

  router.delete('/admin/:id/befehle/:bid', authMiddleware, nurTechnikGruppe, a(async (req, res) => {
    await ensureSchema();
    if (!/^\d+$/.test(req.params.bid)) return res.status(404).json({ error: 'Befehl nicht gefunden' });
    const r = await pool.query(
      `UPDATE station_befehle SET erledigt_am = NOW(), ergebnis = 'zurueckgezogen', zurueckgezogen_von = $3
        WHERE id = $1 AND station_id = $2 AND abgeholt_am IS NULL AND erledigt_am IS NULL RETURNING art`,
      [req.params.bid, req.params.id, wer(req)]);
    if (!r.rows.length) return res.status(409).json({ error: 'Schon abgeholt oder erledigt — zurückziehen geht nicht mehr' });
    await ereignis(req.params.id, 'befehl-zurueckgezogen', wer(req), P.BEFEHLE[r.rows[0].art]?.titel || r.rows[0].art);
    res.json({ ok: true });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error('[stationen-v2] unbehandelt:', err?.message || err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Unerwarteter Fehler im Stationen-Protokoll' });
  });

  router.ensureSchema = ensureSchema;
  return router;
};
