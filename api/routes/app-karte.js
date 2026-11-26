// ─── Karten-Anmeldung der Rosenweg-Apps auf privaten Geräten ────────────────
//
// Entscheid Stefan 26.11.2026: Jede Rosenweg-App mit Anmeldung zeigt auf einem
// privaten Gerät (ohne Rosenweg Gerät) denselben Anmeldeschirm wie der
// Sperrbildschirm der geteilten Telefone — Rosenweg-Karte hinten ans Telefon
// halten oder mit dem Rosenweg-Konto im Browser anmelden. Die Karte ALLEIN
// meldet an, ohne PIN (die PIN gibt es nur auf geteilten Telefonen).
//
// Jede App hat ihre EIGENE Sitzung (keine geräteweite Anmeldung): wer drei
// Rosenweg-Apps hat, hält die Karte dreimal hin. Abmelden in einer App betrifft
// nur diese App; die Technik sieht und widerruft jede Sitzung einzeln.
//
// Warum nicht Authentik: Authentik stellt Tokens nur über den Browser aus. Die
// Karte prüft UniFi Access, also stellt die API hier selbst einen Ausweis aus,
// den authMiddleware wie ein App-Token behandelt (middleware/auth.js, Präfix
// rw_app_). Die pbx-api nimmt ihn über /api/auth/me an.
//
// Absicherung (die Karten-UID ist kopierbar, und wer ein privates Gerät nutzt,
// steht nicht im Haus) — siehe lib/appkarte.js für die Einzelheiten:
//  1. Bindung ans Gerät: Schlüsselpaar im Android-Keystore, Zugang 15 min,
//     Erneuern nur mit Unterschrift über eine Herausforderung des Servers.
//  2. Ratenbegrenzung je Absender-IP, Karte, Gerät und gesamt (Tabelle
//     app_karten_versuche, überlebt Neustarts und mehrere Instanzen).
//  3. Mail an die Person bei der ersten Karten-Anmeldung auf einem neuen Gerät.
//  4. Karte bei jedem Erneuern live in UniFi Access: entzogen = Sitzung weg.
//     Die Kartenpruefung ist dieselbe wie fuer die geteilten Telefone
//     (karteNachschlagen in server.js, auch hinter GET /api/pbx/karte/:nfcId).
//  5. Höchstens APP_KARTE_MAX_SITZUNGEN (20) aktive Sitzungen je Person; eine
//     neue löst die am längsten unbenutzte ab (statt die Person auszusperren,
//     die eine App neu installiert hat und deren alte Sitzung noch zählt).
//  6. Feste Laufzeit (APP_KARTE_TAGE, 30 Tage wie die Browser-Anmeldung der
//     Apps), danach Karte erneut hinhalten.
//  7. Eine Karten-Sitzung darf keine stärkeren Ausweise erzeugen (Token,
//     Passkeys, Passwort, MQTT-Zugänge) — gleiche Sperrliste wie die PATs.
//  8. Fehlermeldungen unterscheiden "unbekannt" und "gesperrt" nicht (kein
//     Orakel, welche UIDs es gibt); das Protokoll schon.
const ak = require('../lib/appkarte');

const MAX_SITZUNGEN = Math.max(1, parseInt(process.env.APP_KARTE_MAX_SITZUNGEN || '20', 10) || 20);
const LAUFZEIT_TAGE = Math.max(1, parseInt(process.env.APP_KARTE_TAGE || '30', 10) || 30);
const ZUGANG_MIN = 15;
const HERAUSFORDERUNG_S = 120;
// UniFi Access nicht erreichbar: so lange darf eine Sitzung ohne Kartenprüfung weiterlaufen.
const OHNE_PRUEFUNG_STUNDEN = 24;
const PORTAL_URL = process.env.SITE_URL || 'https://www.rosenweg4303.ch';

function appKarteRoutes(app, deps) {
  const {
    pool, authMiddleware, requireUserLogin, absenderIp, loggedSendMail, MAIL_FROM,
    karteNachschlagen, accessKarteLive, accessKartenBesitzerId, kartenPerson, kartenProtokollieren,
  } = deps;

  let bereit = null;
  const tabellen = () => (bereit ??= pool.query(`
    CREATE TABLE IF NOT EXISTS app_karten_sitzungen (
      id TEXT PRIMARY KEY,
      user_id INTEGER, email TEXT NOT NULL, name TEXT,
      app TEXT NOT NULL, app_name TEXT,
      geraet_kennung TEXT NOT NULL, geraet_name TEXT, plattform TEXT,
      schluessel TEXT NOT NULL,
      zugang_hash TEXT UNIQUE, zugang_bis TIMESTAMPTZ,
      herausforderung_hash TEXT, herausforderung_bis TIMESTAMPTZ,
      groups_json TEXT,
      access_karten_token TEXT, access_user_id TEXT, karte_anzeige TEXT,
      karte_geprueft_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), created_ip TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ, last_used_ip TEXT,
      revoked_at TIMESTAMPTZ, revoked_by TEXT, revoked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aks_email ON app_karten_sitzungen(LOWER(email)) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS app_karten_versuche (
      id BIGSERIAL PRIMARY KEY, uid_hash TEXT, ip TEXT, geraet_kennung TEXT,
      erfolg BOOLEAN NOT NULL, grund TEXT, email TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_akv_zeit ON app_karten_versuche(created_at);
  `).catch(e => { bereit = null; throw e; }));

  async function versuch(uidHash, ip, kennung, erfolg, grund, email) {
    try {
      await pool.query(`INSERT INTO app_karten_versuche (uid_hash, ip, geraet_kennung, erfolg, grund, email)
                        VALUES ($1,$2,$3,$4,$5,$6)`, [uidHash, ip, kennung, erfolg, grund, email || null]);
      // alte Versuche wegräumen (selten, billig)
      if (Math.random() < 0.02) pool.query("DELETE FROM app_karten_versuche WHERE created_at < NOW() - INTERVAL '90 days'").catch(() => {});
    } catch (e) { console.error('[app-karte] Versuch nicht gespeichert:', e.message); }
  }

  async function zahlen(uidHash, ip, kennung) {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE NOT erfolg AND ip = $2)            AS ip_fehl,
        COUNT(*) FILTER (WHERE ip = $2)                           AS ip_alle,
        COUNT(*) FILTER (WHERE NOT erfolg AND uid_hash = $1)      AS uid_fehl,
        COUNT(*) FILTER (WHERE NOT erfolg AND geraet_kennung = $3) AS geraet_fehl,
        COUNT(*) FILTER (WHERE NOT erfolg)                        AS global_fehl
      FROM app_karten_versuche WHERE created_at > NOW() - make_interval(mins => $4::int)`,
      [uidHash, ip, kennung, String(ak.GRENZEN.fensterMin)]);
    const z = r.rows[0] || {};
    return { ipFehl: +z.ip_fehl, ipAlle: +z.ip_alle, uidFehl: +z.uid_fehl, geraetFehl: +z.geraet_fehl, globalFehl: +z.global_fehl };
  }

  async function zugangAusstellen(id, ip) {
    const zugang = ak.neuesZugangsToken();
    const bis = new Date(Date.now() + ZUGANG_MIN * 60 * 1000);
    await pool.query(`UPDATE app_karten_sitzungen SET zugang_hash = $2, zugang_bis = $3,
                        herausforderung_hash = NULL, herausforderung_bis = NULL,
                        last_used_at = NOW(), last_used_ip = $4 WHERE id = $1`,
      [id, ak.hash(zugang), bis, ip]);
    return { zugang, zugang_bis: bis.toISOString(), expires_in: ZUGANG_MIN * 60 };
  }

  async function widerrufen(where, params, durch, grund) {
    const r = await pool.query(
      `UPDATE app_karten_sitzungen SET revoked_at = NOW(), revoked_by = $${params.length + 1},
              revoked_reason = $${params.length + 2}, zugang_hash = NULL, herausforderung_hash = NULL
        WHERE revoked_at IS NULL AND ${where} RETURNING id, email, app_name, geraet_name`,
      [...params, String(durch || '').slice(0, 200), String(grund || '').slice(0, 200)]);
    return r.rows;
  }

  async function neuesGeraetMelden(person, w, ip) {
    const wann = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
    const text = [
      `Hallo ${person.name || ''}`.trim() + ',',
      '',
      'mit deiner Rosenweg-Karte hat sich gerade jemand auf einem neuen Gerät angemeldet:',
      '',
      `  App:     ${w.appName}`,
      `  Gerät:   ${w.geraetName}${w.plattform ? ' (' + w.plattform + ')' : ''}`,
      `  Zeit:    ${wann}`,
      `  Adresse: ${ip}`,
      '',
      'Warst du das, ist alles in Ordnung.',
      '',
      'Warst du es NICHT: Melde dich sofort bei der Technik (technik@rosenweg4303.ch).',
      'Sie meldet die Sitzung ab und sperrt die Karte. Im Portal siehst du unter',
      `${PORTAL_URL}/profil.html#app-sitzungen alle Karten-Anmeldungen und kannst sie selbst abmelden.`,
      '',
      'Rosenweg 4303',
    ].join('\n');
    try {
      await loggedSendMail({ from: MAIL_FROM, to: person.email, subject: 'Neue Anmeldung mit deiner Rosenweg-Karte', text },
        'app-karte-neues-geraet');
    } catch (e) { console.error('[app-karte] Mail neues Gerät:', e.message); }
  }

  // ── Anmelden mit der Karte (ohne Anmeldung: die Karte IST der Ausweis) ──
  app.post('/api/apps/karte-anmelden', async (req, res) => {
    const ip = absenderIp(req);
    const p = ak.anmeldungPruefen(req.body);
    if (!p.ok) return res.status(400).json({ error: p.fehler });
    const w = p.werte;
    const uidHash = ak.hash(w.uid);
    try {
      await tabellen();
      const bremse = ak.gebremst(await zahlen(uidHash, ip, w.kennung));
      if (bremse) {
        await versuch(uidHash, ip, w.kennung, false, `gebremst:${bremse}`);
        return res.status(429).json({ error: 'Zu viele Versuche – bitte in einer Viertelstunde nochmals.', grund: 'gebremst' });
      }
      // Dieselbe Pruefung wie fuer die geteilten Telefone (GET /api/pbx/karte/:nfcId)
      let n;
      try { n = await karteNachschlagen(w.uid); } catch (e) {
        return res.status(502).json({ error: 'Die Kartenprüfung ist gerade nicht erreichbar.', grund: 'verbindung' });
      }
      const k = n.karte || null;
      const besitzer = accessKartenBesitzerId(k);
      const person = n.assigned ? n.person : null;
      const anzeige = n.display_id || w.uid.slice(-6);
      let grund = !n.found ? 'unbekannt' : !n.assigned ? 'gesperrt' : !person?.email ? 'ohne-person' : null;
      let zeile = null;
      if (!grund) {
        zeile = (await pool.query('SELECT id, email, name, active FROM users WHERE LOWER(email) = $1 ORDER BY id LIMIT 1',
          [person.email.toLowerCase()])).rows[0];
        if (!zeile) grund = 'kein-konto';
        else if (zeile.active === false) grund = 'konto-inaktiv';
      }
      if (grund) {
        await versuch(uidHash, ip, w.kennung, false, grund, person?.email);
        await kartenProtokollieren('app-anmeldung', { nfcId: null, displayId: anzeige, email: person?.email, name: person?.name,
          durch: `${w.appName} auf ${w.geraetName} (${ip})`, erfolg: false, detail: grund });
        if (grund === 'kein-konto') {
          return res.status(403).json({ error: 'Zu dieser Karte gibt es noch kein Rosenweg-Konto. Bitte einmal mit dem Rosenweg-Konto anmelden.', grund });
        }
        return res.status(403).json({ error: 'Diese Karte ist nicht bekannt oder gesperrt.', grund: 'abgelehnt' });
      }
      const email = String(zeile.email).toLowerCase();
      const groups = person.groups || [];
      // Neues Gerät für diese Person? (vor dem Anlegen fragen; auch widerrufene zählen als bekannt)
      const bekannt = (await pool.query(
        'SELECT 1 FROM app_karten_sitzungen WHERE LOWER(email) = $1 AND geraet_kennung = $2 LIMIT 1', [email, w.kennung])).rowCount > 0;
      // Dieselbe App auf demselben Gerät: alte Sitzung ersetzen (Neuinstallation, App-Daten gelöscht)
      await widerrufen('LOWER(email) = $1 AND app = $2 AND geraet_kennung = $3', [email, w.app, w.kennung], 'karte', 'ersetzt');
      // Obergrenze je Person
      const aktiv = (await pool.query(
        `SELECT id, COALESCE(last_used_at, created_at) AS zuletzt FROM app_karten_sitzungen
          WHERE LOWER(email) = $1 AND revoked_at IS NULL AND expires_at > NOW()`, [email])).rows;
      const weg = ak.abzuloesen(aktiv, MAX_SITZUNGEN);
      if (weg.length) await widerrufen('id = ANY($1)', [weg], 'karte', `abgeloest (hoechstens ${MAX_SITZUNGEN})`);

      const id = ak.neueSitzungsId();
      await pool.query(`INSERT INTO app_karten_sitzungen
          (id, user_id, email, name, app, app_name, geraet_kennung, geraet_name, plattform, schluessel, groups_json,
           access_karten_token, access_user_id, karte_anzeige, karte_geprueft_at, created_ip, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15, NOW() + make_interval(days => $16::int))`,
        [id, zeile.id, email, person.name || zeile.name, w.app, w.appName, w.kennung, w.geraetName, w.plattform,
         w.schluessel, JSON.stringify(groups), k.token || null, String(besitzer), anzeige, ip, String(LAUFZEIT_TAGE)]);
      const z = await zugangAusstellen(id, ip);
      await versuch(uidHash, ip, w.kennung, true, bekannt ? 'ok' : 'ok-neues-geraet', email);
      await kartenProtokollieren('app-anmeldung', { displayId: anzeige, email, name: person.name,
        durch: `${w.appName} auf ${w.geraetName} (${ip})`, erfolg: true,
        detail: `sitzung ${id}${bekannt ? '' : '; neues Geraet'}${weg.length ? `; ${weg.length} abgeloest` : ''}` });
      if (!bekannt) neuesGeraetMelden({ email, name: person.name || zeile.name }, w, ip);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, sitzung: id, ...z, name: person.name || zeile.name, email,
        gueltig_bis: new Date(Date.now() + LAUFZEIT_TAGE * 864e5).toISOString(), neues_geraet: !bekannt,
        abgeloest: weg.length });
    } catch (e) {
      console.error('[app-karte] anmelden:', e.message);
      res.status(500).json({ error: 'Anmelden fehlgeschlagen' });
    }
  });

  // ── Erneuern: Schritt 1 ohne Unterschrift -> Herausforderung; Schritt 2 mit ──
  app.post('/api/apps/sitzung/erneuern', async (req, res) => {
    const ip = absenderIp(req);
    const id = String(req.body?.sitzung || '');
    if (!ak.SITZUNG_RE.test(id)) return res.status(400).json({ error: 'Sitzung fehlt' });
    try {
      await tabellen();
      const s = (await pool.query(`SELECT s.*, u.active FROM app_karten_sitzungen s LEFT JOIN users u ON u.id = s.user_id
                                    WHERE s.id = $1`, [id])).rows[0];
      const weg = (grund) => res.status(401).json({ error: 'Anmeldung abgelaufen – bitte neu anmelden.', grund });
      if (!s || s.revoked_at) return weg(s?.revoked_reason || 'unbekannt');
      if (new Date(s.expires_at) <= new Date()) return weg('abgelaufen');
      if (s.active === false) {
        await widerrufen('id = $1', [id], 'system', 'konto inaktiv');
        return weg('konto-inaktiv');
      }
      const unterschrift = req.body?.unterschrift;
      if (!unterschrift) {
        const h = ak.zufall(24);
        await pool.query(`UPDATE app_karten_sitzungen SET herausforderung_hash = $2,
                            herausforderung_bis = NOW() + make_interval(secs => $3::int) WHERE id = $1`,
          [id, ak.hash(h), String(HERAUSFORDERUNG_S)]);
        return res.json({ herausforderung: h });
      }
      const h = String(req.body?.herausforderung || '');
      const passt = h && s.herausforderung_hash === ak.hash(h) && new Date(s.herausforderung_bis) > new Date()
        && ak.unterschriftGueltig(s.schluessel, ak.erneuernText(id, h), unterschrift);
      // Herausforderung ist verbraucht, ob es passt oder nicht
      await pool.query('UPDATE app_karten_sitzungen SET herausforderung_hash = NULL WHERE id = $1', [id]);
      if (!passt) {
        await versuch(null, ip, s.geraet_kennung, false, 'unterschrift', s.email);
        return res.status(401).json({ error: 'Gerät nicht erkannt – bitte neu anmelden.', grund: 'unterschrift' });
      }
      // Karte live in UniFi Access: noch zugewiesen, derselben Person?
      let geprueft = false;
      if (s.access_karten_token) {
        let d, erreicht = true;
        try { d = await accessKarteLive(s.access_karten_token); } catch (e) { erreicht = false; }
        if (erreicht) {
          const ok = d && String(d.status || '').toLowerCase() === 'assigned' && String(accessKartenBesitzerId(d)) === String(s.access_user_id);
          if (!ok) {
            await widerrufen('id = $1', [id], 'system', 'karte entzogen');
            await kartenProtokollieren('app-abmeldung', { displayId: s.karte_anzeige, email: s.email, name: s.name,
              durch: `${s.app_name} auf ${s.geraet_name}`, erfolg: true, detail: 'karte entzogen' });
            return weg('karte-entzogen');
          }
          geprueft = true;
          try {   // Gruppen frisch (Technik entzogen = sofort weniger Rechte)
            const person = await kartenPerson(s.access_user_id);
            if (person?.email && person.email.toLowerCase() !== s.email.toLowerCase()) {
              await widerrufen('id = $1', [id], 'system', 'karte andere person');
              return weg('karte-entzogen');
            }
            if (person?.groups) await pool.query('UPDATE app_karten_sitzungen SET groups_json = $2 WHERE id = $1', [id, JSON.stringify(person.groups)]);
          } catch (e) { console.warn('[app-karte] Gruppen:', e.message); }
        }
      }
      if (geprueft) {
        await pool.query('UPDATE app_karten_sitzungen SET karte_geprueft_at = NOW() WHERE id = $1', [id]);
      } else if (!s.karte_geprueft_at || Date.now() - new Date(s.karte_geprueft_at) > OHNE_PRUEFUNG_STUNDEN * 3600e3) {
        return res.status(503).json({ error: 'Die Kartenprüfung ist gerade nicht erreichbar.', grund: 'verbindung' });
      }
      const z = await zugangAusstellen(id, ip);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, sitzung: id, ...z, name: s.name, email: s.email });
    } catch (e) {
      console.error('[app-karte] erneuern:', e.message);
      res.status(500).json({ error: 'Erneuern fehlgeschlagen' });
    }
  });

  // ── Abmelden aus der App (nur die eigene Sitzung dieser App) ──
  app.post('/api/apps/sitzung/abmelden', authMiddleware, async (req, res) => {
    if (!req.appKarte) return res.status(400).json({ error: 'Keine Karten-Sitzung' });
    try {
      await widerrufen('id = $1', [req.appKarte.id], req.user.email, 'abgemeldet in der App');
      res.json({ ok: true });
    } catch (e) {
      console.error('[app-karte] abmelden:', e.message);
      res.status(500).json({ error: 'Abmelden fehlgeschlagen' });
    }
  });

  // ── Übersicht im Portal: eigene; Technik/Präsident mit ?alle=1 alle ──
  // Nur mit Browser-Anmeldung (requireUserLogin sperrt PATs und Karten-Sitzungen):
  // wer nur eine Karte hat, soll nicht die anderen Sitzungen der Person abräumen.
  const spalten = `id, email, name, app, app_name, geraet_name, plattform, LEFT(geraet_kennung, 8) AS geraet,
                   karte_anzeige, created_at, created_ip, last_used_at, last_used_ip, expires_at,
                   revoked_at, revoked_by, revoked_reason`;
  app.get('/api/apps/sitzungen', authMiddleware, requireUserLogin, async (req, res) => {
    try {
      await tabellen();
      const alle = req.query.alle === '1' && ak.istTechnikOderPraesident(req.user.groups);
      const auchAlte = req.query.alte === '1';
      const r = await pool.query(
        `SELECT ${spalten} FROM app_karten_sitzungen
          WHERE ($1::boolean OR LOWER(email) = LOWER($2))
            AND ($3::boolean OR (revoked_at IS NULL AND expires_at > NOW()))
          ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 500`,
        [alle, req.user.email || '', auchAlte]);
      res.json({ sitzungen: r.rows, alle, max_je_person: MAX_SITZUNGEN, laufzeit_tage: LAUFZEIT_TAGE });
    } catch (e) {
      console.error('[app-karte] liste:', e.message);
      res.status(500).json({ error: 'Abfrage fehlgeschlagen' });
    }
  });

  app.delete('/api/apps/sitzungen/:id', authMiddleware, requireUserLogin, async (req, res) => {
    const id = String(req.params.id || '');
    if (!ak.SITZUNG_RE.test(id)) return res.status(400).json({ error: 'Ungültige Sitzung' });
    try {
      await tabellen();
      const technik = ak.istTechnikOderPraesident(req.user.groups);
      const r = technik
        ? await widerrufen('id = $1', [id], req.user.email, 'widerrufen (Technik)')
        : await widerrufen('id = $1 AND LOWER(email) = LOWER($2)', [id, req.user.email || ''], req.user.email, 'abgemeldet im Portal');
      if (!r.length) return res.status(404).json({ error: 'Sitzung nicht gefunden' });
      await kartenProtokollieren('app-abmeldung', { email: r[0].email, durch: req.user.email, erfolg: true,
        detail: `${r[0].app_name} auf ${r[0].geraet_name} (${id})${technik ? ' durch Technik' : ''}` });
      res.json({ ok: true });
    } catch (e) {
      console.error('[app-karte] widerrufen:', e.message);
      res.status(500).json({ error: 'Widerrufen fehlgeschlagen' });
    }
  });

  // Alle Karten-Sitzungen einer Person (Karte verloren, Konto gesperrt) — Technik.
  app.post('/api/apps/sitzungen/alle-abmelden', authMiddleware, requireUserLogin, async (req, res) => {
    const technik = ak.istTechnikOderPraesident(req.user.groups);
    const email = String(req.body?.email || '').toLowerCase().trim();
    const ziel = technik && email ? email : String(req.user.email || '').toLowerCase();
    try {
      await tabellen();
      const r = await widerrufen('LOWER(email) = $1', [ziel], req.user.email,
        ziel === String(req.user.email || '').toLowerCase() ? 'alle abgemeldet (selbst)' : 'alle abgemeldet (Technik)');
      await kartenProtokollieren('app-abmeldung', { email: ziel, durch: req.user.email, erfolg: true, detail: `alle (${r.length})` });
      res.json({ ok: true, abgemeldet: r.length });
    } catch (e) {
      console.error('[app-karte] alle abmelden:', e.message);
      res.status(500).json({ error: 'Abmelden fehlgeschlagen' });
    }
  });

  return { tabellen };
}

/**
 * Für authMiddleware: Zugangs-Token einer Karten-Sitzung -> req.user (wie ein
 * App-Token) oder null. Rolle aus den Gruppen der letzten Kartenprüfung.
 */
async function karteZugangPruefen(pool, token, ip) {
  if (!token.startsWith(ak.TOKEN_PRAEFIX) || token.length > 100) return null;
  let r;
  try {
    r = await pool.query(
      `SELECT s.id, s.app, s.groups_json, u.id AS user_id, u.email, u.name, u.wohnung, u.stweg
         FROM app_karten_sitzungen s JOIN users u ON u.id = s.user_id
        WHERE s.zugang_hash = $1 AND s.revoked_at IS NULL AND s.zugang_bis > NOW() AND s.expires_at > NOW()
          AND COALESCE(u.active, true)`, [ak.hash(token)]);
  } catch (e) {
    if (/does not exist/.test(e.message)) return null;   // Tabelle noch nie angelegt
    throw e;
  }
  const z = r.rows[0];
  if (!z) return null;
  let groups = [];
  try { groups = JSON.parse(z.groups_json || '[]').map(String); } catch {}
  const role = ak.istTechnikOderPraesident(groups) ? 'admin' : 'bewohner';
  pool.query('UPDATE app_karten_sitzungen SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1', [z.id, ip]).catch(() => {});
  return {
    user: {
      id: z.user_id, user_id: z.user_id, email: z.email, name: z.name, wohnung: z.wohnung, stweg: z.stweg,
      role, isAdmin: role === 'admin', groups, auth_source: 'karte', auth_client: 'rosenweg-apps',
    },
    sitzung: { id: z.id, app: z.app },
  };
}

module.exports = { appKarteRoutes, karteZugangPruefen };
