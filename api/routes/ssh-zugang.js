// ═══════════════════════════════════════════════════════════════════
// SSH-ZUGANG — Schluessel im Profil, Hosts, Zugriffsmatrix
//
// Drei Teile:
//   1. Selbstbedienung: Jede Person pflegt ihre oeffentlichen
//      Schluessel selbst — von Hand und/oder aus einem GitHub-Konto.
//      Die beiden Quellen ergaenzen sich.
//   2. Host-Schnittstelle: sshd fragt beim Anmelden ueber
//      AuthorizedKeysCommand hier nach. Der Host nennt dabei seinen
//      Namen und traegt sich damit selbst in die Hostliste ein.
//   3. Zugriffsmatrix: Wer darf auf welchen Host, mit oder ohne
//      passwortloses sudo. Grundregel ist Technik/Praesident ueberall;
//      einzelne Hosts oder Personen lassen sich davon abweichend regeln.
//
// Sicherheitsgrenze: Lesen ist unkritisch, oeffentliche Schluessel sind
// oeffentlich. Kritisch ist das Schreiben — wer einen Schluessel in ein
// Profil legt, bekommt eine Shell, und mit sudo eine Wurzel. Darum
// schreibt hier nur eine per SSO angemeldete Person ihre eigenen
// Schluessel, die Matrix nur Technik/Praesident, und jede Aenderung
// laeuft ueber den Audit-Trigger der Tabellen.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { pool } = require('../lib/db');
const { authMiddleware, requireUserLogin } = require('../middleware/auth');
const { isTechnik, isPraesident } = require('../lib/groups');
const { schluesselPruefen, alsZeile, githubSchluessel, GITHUB_BENUTZER } = require('../lib/sshkeys');
const { queueWhatsappMessage, resolveTechnikWhatsappGroupId } = require('../lib/whatsapp');

const router = express.Router();

const HOST_TOKEN = process.env.SSH_HOST_TOKEN || '';
const HOSTNAME_MUSTER = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,118}[a-zA-Z0-9])?$/;
// Unix-Login. Bewusst eng: Dieser Wert geht in eine Datei, die sudo liest,
// und in einen Dateinamen im Zwischenspeicher auf dem Host. Punkte sind
// erlaubt, weil die Anmeldenamen aus dem Verzeichnis so aussehen
// (stefan.mueller); das fuehrende [a-z_] schliesst '.' und '..' aus, und
// ein Schraegstrich kommt gar nicht erst vor.
const LOGIN_MUSTER = /^[a-z_][a-z0-9._-]{0,31}$/;

function requireHostToken(req, res, next) {
  if (!HOST_TOKEN) return res.status(503).json({ error: 'SSH_HOST_TOKEN nicht gesetzt' });
  const gesendet = req.headers['x-host-token'] || '';
  // Laengengleicher Vergleich waere schoener, aber der Token ist ein
  // fixes Geheimnis ohne Rateflaeche pro Request — Ratelimit steht davor.
  if (gesendet !== HOST_TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}

function requireTechnik(req, res, next) {
  const groups = req.user?.groups || [];
  if (isTechnik(groups) || isPraesident(groups)) return next();
  return res.status(403).json({ error: 'Nur für Technik oder Präsident' });
}

// 'Präsident' und 'praesident' sind dieselbe Gruppe — in der Matrix
// steht die schriftlose Form, damit ein Vergleich genuegt.
function gruppenNormieren(groups) {
  return (groups || []).map(g => String(g).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'));
}

function gruppenVonUser(row) {
  try { return gruppenNormieren(JSON.parse(row.groups_json || '[]')); } catch { return []; }
}

// ─── Host meldet sich an ────────────────────────────────────────────
// Jeder Abruf haelt die Liste aktuell. Ein Host, der seit Monaten nicht
// mehr gefragt hat, faellt dadurch von selbst auf.
async function hostRegistrieren(hostname, adresse) {
  const r = await pool.query(
    `INSERT INTO ssh_hosts (hostname, adresse, abfragen)
     VALUES ($1, $2, 1)
     ON CONFLICT (hostname) DO UPDATE
       SET zuletzt_gesehen = NOW(),
           abfragen = ssh_hosts.abfragen + 1,
           adresse = COALESCE(EXCLUDED.adresse, ssh_hosts.adresse)
     RETURNING id, hostname, aktiv, sitzungsgebunden`,
    [hostname, adresse || null]);
  return r.rows[0];
}

// ─── Zugriff aufloesen ──────────────────────────────────────────────
// Spezifischer schlaegt allgemeiner: Benutzer vor Gruppe, ein einzelner
// Host vor der Regel fuer alle. Findet sich keine Regel, gibt es nichts.
async function zugriffErmitteln(login, host) {
  const u = await pool.query(
    `SELECT id, email, name, username, groups_json, active
       FROM users WHERE LOWER(username) = LOWER($1)`, [login]);
  const user = u.rows[0];
  if (!user || user.active === false) return { erlaubt: false, grund: 'Kein aktiver Benutzer' };
  if (host && host.aktiv === false) return { erlaubt: false, grund: 'Host stillgelegt', user };

  const gruppen = gruppenVonUser(user);

  // Technik ist fest verdrahtet und kommt ueberall hin, mit sudo. Das
  // steht bewusst hier im Code und nicht als Regel in der Matrix: Eine
  // Regel laesst sich ueber die Oberflaeche loeschen, und wer die
  // Technik aus der Matrix wirft, sperrt genau die Leute aus, die den
  // Fehler wieder beheben muessten. Ein Entzug greift fuer sie nicht —
  // das ist der Sinn der Sache, nicht ein Versehen.
  if (isTechnik(gruppen)) {
    return { erlaubt: true, sudo: true, user, regel: { fest: true, subjekt_typ: 'gruppe', subjekt: 'technik', ssh: true, sudo: true } };
  }

  const r = await pool.query(
    `SELECT ssh, sudo, subjekt_typ, subjekt, host_id,
            (CASE WHEN subjekt_typ = 'benutzer' THEN 2 ELSE 0 END)
          + (CASE WHEN host_id IS NOT NULL     THEN 1 ELSE 0 END) AS rang
       FROM ssh_zugriff
      WHERE (host_id IS NULL OR host_id = $1)
        AND ( (subjekt_typ = 'benutzer' AND LOWER(subjekt) = LOWER($2))
           OR (subjekt_typ = 'gruppe'   AND LOWER(subjekt) = ANY($3::text[])) )
      ORDER BY rang DESC
      LIMIT 1`,
    [host ? host.id : null, user.username || '', gruppen]);

  const regel = r.rows[0];
  if (!regel) return { erlaubt: false, grund: 'Keine Regel trifft zu', user };
  if (!regel.ssh) return { erlaubt: false, grund: 'Zugang ausdrücklich entzogen', user, regel };

  // Auf einer Station gilt die Regel nur, solange die Person dort auch
  // angemeldet ist. Technik ist oben schon durch — sonst waere eine
  // Station ohne Sitzung fuer niemanden mehr erreichbar.
  if (host && host.sitzungsgebunden) {
    const sitz = await pool.query(
      `SELECT 1 FROM ssh_sitzung
        WHERE host = $1 AND login = LOWER($2)
          AND zuletzt_gesehen > NOW() - ($3 || ' hours')::interval`,
      [host.hostname, user.username || '', String(SITZUNG_FRIST_STUNDEN)]);
    if (!sitz.rows.length) {
      return { erlaubt: false, grund: 'Station: keine laufende Sitzung dieser Person', user, regel };
    }
  }

  return { erlaubt: true, sudo: !!regel.sudo, user, regel };
}

async function schluesselVonUser(userId) {
  const r = await pool.query(
    `SELECT id, quelle, typ, blob_b64, kommentar, fingerprint, label, erstellt_am, zuletzt_gesehen
       FROM ssh_schluessel WHERE user_id = $1 ORDER BY quelle, erstellt_am`, [userId]);
  return r.rows;
}

// ─── GitHub-Abgleich ────────────────────────────────────────────────
// Ersetzt genau die Zeilen mit quelle='github'. Von Hand hinterlegte
// Schluessel bleiben unberuehrt — die beiden Quellen ergaenzen sich.
async function githubAbgleich(userId, benutzer) {
  if (!benutzer) {
    const w = await pool.query(`DELETE FROM ssh_schluessel WHERE user_id = $1 AND quelle = 'github'`, [userId]);
    return { entfernt: w.rowCount, uebernommen: 0 };
  }
  const keys = await githubSchluessel(benutzer);
  const behalten = [];
  let uebernommen = 0;
  for (const k of keys) {
    behalten.push(k.fingerprint);
    // Liegt derselbe Schluessel schon von Hand vor, bleibt er 'manuell'
    // — sonst wuerde ein Abgleich ihn stillschweigend uebernehmen und
    // beim Entfernen des GitHub-Kontos mitloeschen.
    const r = await pool.query(
      `INSERT INTO ssh_schluessel (user_id, quelle, typ, blob_b64, kommentar, fingerprint, label)
       VALUES ($1, 'github', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, fingerprint) DO NOTHING`,
      [userId, k.typ, k.blobB64, k.kommentar || null, k.fingerprint, `GitHub: ${benutzer}`]);
    uebernommen += r.rowCount;
  }
  const w = await pool.query(
    `DELETE FROM ssh_schluessel
      WHERE user_id = $1 AND quelle = 'github' AND NOT (fingerprint = ANY($2::text[]))`,
    [userId, behalten]);
  return { entfernt: w.rowCount, uebernommen, gefunden: keys.length };
}

// Periodischer Lauf. Ein Fehler bei einer Person darf die uebrigen
// nicht aufhalten — GitHub ist erreichbar oder eben nicht.
async function githubAbgleichAlle() {
  const r = await pool.query(
    `SELECT id, github_benutzer FROM users WHERE github_benutzer IS NOT NULL AND active = true`);
  let ok = 0, fehler = 0;
  for (const u of r.rows) {
    try { await githubAbgleich(u.id, u.github_benutzer); ok++; }
    catch (e) { fehler++; console.warn(`[ssh] GitHub-Abgleich für User ${u.id} fehlgeschlagen:`, e.message); }
  }
  if (ok || fehler) console.log(`[ssh] GitHub-Abgleich: ${ok} erfolgreich, ${fehler} fehlgeschlagen`);
  return { ok, fehler };
}

// ════════════════════════════════════════════════════════════════════
// 1. Selbstbedienung im Profil
// ════════════════════════════════════════════════════════════════════

// GET /api/ssh/me — eigene Schluessel und wo man damit hinkommt
router.get('/me', authMiddleware, requireUserLogin, async (req, res) => {
  try {
    const u = await pool.query(
      `SELECT id, username, github_benutzer, groups_json FROM users WHERE id = $1`, [req.user.id]);
    const user = u.rows[0];
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

    const hosts = await pool.query(
      `SELECT id, hostname, adresse, zuletzt_gesehen, aktiv FROM ssh_hosts ORDER BY hostname`);
    const erreichbar = [];
    for (const h of hosts.rows) {
      const z = await zugriffErmitteln(user.username, h);
      if (z.erlaubt) erreichbar.push({ hostname: h.hostname, sudo: z.sudo, zuletzt_gesehen: h.zuletzt_gesehen });
    }

    res.json({
      username: user.username,
      github_benutzer: user.github_benutzer,
      schluessel: await schluesselVonUser(user.id),
      hosts: erreichbar,
      hinweis: user.username ? null : 'Ohne Benutzernamen im Konto lässt sich kein Systemzugang zuordnen.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ssh/me/schluessel — einen Schluessel von Hand hinterlegen
router.post('/me/schluessel', authMiddleware, requireUserLogin, async (req, res) => {
  try {
    const { pubkey, label } = req.body || {};
    let k;
    try { k = schluesselPruefen(pubkey); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const r = await pool.query(
      `INSERT INTO ssh_schluessel (user_id, quelle, typ, blob_b64, kommentar, fingerprint, label)
       VALUES ($1, 'manuell', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, fingerprint) DO NOTHING
       RETURNING id, quelle, typ, kommentar, fingerprint, label, erstellt_am`,
      [req.user.id, k.typ, k.blobB64, k.kommentar || null, k.fingerprint,
       (label || k.kommentar || 'Schlüssel').slice(0, 100)]);
    if (!r.rows.length) return res.status(409).json({ error: 'Dieser Schlüssel ist bereits hinterlegt' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ssh/me/schluessel/:id
router.delete('/me/schluessel/:id', authMiddleware, requireUserLogin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const r = await pool.query(
      `DELETE FROM ssh_schluessel WHERE id = $1 AND user_id = $2 RETURNING id, quelle`, [id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    // Ein GitHub-Schluessel kommt beim naechsten Abgleich wieder — das
    // ist kein Fehler, sondern der Sinn der Quelle. Sagen wir es aber.
    res.json({ ok: true, wiederkehrend: r.rows[0].quelle === 'github' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/ssh/me/github  { benutzer: 'name' | null }
router.put('/me/github', authMiddleware, requireUserLogin, async (req, res) => {
  try {
    const roh = req.body?.benutzer;
    const benutzer = roh === null || roh === '' ? null : String(roh).trim();
    if (benutzer !== null && !GITHUB_BENUTZER.test(benutzer)) {
      return res.status(400).json({ error: 'Ungültiger GitHub-Benutzername' });
    }
    let ergebnis;
    try { ergebnis = await githubAbgleich(req.user.id, benutzer); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    await pool.query(`UPDATE users SET github_benutzer = $1, updated_at = NOW() WHERE id = $2`,
      [benutzer, req.user.id]);
    res.json({ github_benutzer: benutzer, ...ergebnis, schluessel: await schluesselVonUser(req.user.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ssh/me/github/abgleich — von Hand nachziehen
router.post('/me/github/abgleich', authMiddleware, requireUserLogin, async (req, res) => {
  try {
    const u = await pool.query(`SELECT github_benutzer FROM users WHERE id = $1`, [req.user.id]);
    const benutzer = u.rows[0]?.github_benutzer;
    if (!benutzer) return res.status(400).json({ error: 'Kein GitHub-Konto hinterlegt' });
    const ergebnis = await githubAbgleich(req.user.id, benutzer);
    res.json({ ...ergebnis, schluessel: await schluesselVonUser(req.user.id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 2. Host-Schnittstelle
// ════════════════════════════════════════════════════════════════════

// GET /api/ssh/authorized-keys/:login — von sshd aufgerufen.
// Antwortet in text/plain, eine Zeile je Schluessel. Bei jedem Zweifel
// eine leere Liste: Ein stiller Fehlschlag sperrt aus, ein falsches
// Ja liesse jemanden herein.
router.get('/authorized-keys/:login', requireHostToken, async (req, res) => {
  res.type('text/plain');
  try {
    const login = String(req.params.login || '').toLowerCase();
    const hostname = String(req.headers['x-host-name'] || req.query.host || '').trim();
    if (!LOGIN_MUSTER.test(login)) return res.status(400).send('');
    if (!HOSTNAME_MUSTER.test(hostname)) return res.status(400).send('');

    const host = await hostRegistrieren(hostname, req.headers['x-host-adresse'] || null);
    const z = await zugriffErmitteln(login, host);
    if (!z.erlaubt) return res.send('');

    const keys = await schluesselVonUser(z.user.id);
    if (keys.length) {
      await pool.query(`UPDATE ssh_schluessel SET zuletzt_gesehen = NOW() WHERE user_id = $1`, [z.user.id]);
    }
    res.send(keys.map(alsZeile).join('\n') + (keys.length ? '\n' : ''));
  } catch (err) {
    console.error('[ssh] authorized-keys:', err.message);
    res.status(500).send('');
  }
});

// GET /api/ssh/konten — wer auf diesem Host ein Konto haben soll.
// Der Host legt danach an, was fehlt, und sperrt, was hier nicht mehr
// steht. Anders als bei den Schluesseln geht das nicht live beim
// Anmelden: Ein Unix-Konto muss existieren, bevor sshd ueberhaupt nach
// Schluesseln fragt — sonst weist es die Anmeldung vorher ab.
router.get('/konten', requireHostToken, async (req, res) => {
  try {
    const hostname = String(req.headers['x-host-name'] || req.query.host || '').trim();
    if (!HOSTNAME_MUSTER.test(hostname)) return res.status(400).json({ error: 'Hostname fehlt oder ist ungültig' });
    const host = await hostRegistrieren(hostname, req.headers['x-host-adresse'] || null);

    // Nur Personen mit Schluessel. Ein Konto ohne Schluessel waere eine
    // Tuer ohne Klinke — niemand kaeme hinein, und beim Aufraeumen
    // wuesste niemand mehr, wozu es einmal da war.
    const u = await pool.query(
      `SELECT DISTINCT u.username, u.name
         FROM users u
         JOIN ssh_schluessel s ON s.user_id = u.id
        WHERE u.active = true AND u.username IS NOT NULL
        ORDER BY u.username`);

    const konten = [];
    for (const row of u.rows) {
      const login = String(row.username).toLowerCase();
      if (!LOGIN_MUSTER.test(login)) continue;
      const z = await zugriffErmitteln(row.username, host);
      if (z.erlaubt) konten.push({ login, name: row.name || login, sudo: !!z.sudo });
    }
    res.json({ host: hostname, konten });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 2a. Sitzungsgebundener Zugang — Stationen und Laptops
//
// Ein Server steht dauerhaft; eine Station gehoert waehrend einer
// Sitzung einem Menschen. Dort soll der Zugang mit der Anmeldung
// entstehen und mit der Abmeldung vergehen. Die Matrix bleibt gueltig,
// bekommt aber eine zweite Bedingung: Wer nicht angemeldet ist, kommt
// nicht hinein — auch mit gueltigem Schluessel nicht.
//
// Technik bleibt davon ausgenommen. Eine Station, an der niemand sitzt,
// waere sonst fuer niemanden erreichbar, und ausgerechnet dann braucht
// man sie am ehesten.
// ════════════════════════════════════════════════════════════════════

// Eine Sitzung, von der wir zu lange nichts gehoert haben, gilt als
// beendet. Ein abgestuerztes Geraet meldet sich nie ab — ohne diese
// Frist bliebe sein Zugang fuer immer offen.
const SITZUNG_FRIST_STUNDEN = 16;

// POST /api/ssh/sitzung  { login }  — Anmeldung an einer Station
router.post('/sitzung', requireHostToken, async (req, res) => {
  try {
    const hostname = String(req.headers['x-host-name'] || req.query.host || '').trim();
    const login = String(req.body?.login || '').trim().toLowerCase();
    if (!HOSTNAME_MUSTER.test(hostname)) return res.status(400).json({ error: 'Hostname fehlt oder ist ungültig' });
    if (!LOGIN_MUSTER.test(login)) return res.status(400).json({ error: 'Ungültiger Anmeldename' });

    await hostRegistrieren(hostname, req.headers['x-host-adresse'] || null);
    // Wer Sitzungen meldet, ist eine Station. Das muss niemand von Hand
    // eintragen — der erste Anmeldevorgang sagt es.
    await pool.query(`UPDATE ssh_hosts SET sitzungsgebunden = true WHERE hostname = $1`, [hostname]);

    await pool.query(
      `INSERT INTO ssh_sitzung (host, login) VALUES ($1, $2)
       ON CONFLICT (host, login) DO UPDATE SET zuletzt_gesehen = NOW()`,
      [hostname, login]);
    res.json({ ok: true, host: hostname, login });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ssh/sitzung  { login }  — Abmeldung
router.delete('/sitzung', requireHostToken, async (req, res) => {
  try {
    const hostname = String(req.headers['x-host-name'] || req.query.host || '').trim();
    const login = String(req.body?.login || req.query.login || '').trim().toLowerCase();
    if (!HOSTNAME_MUSTER.test(hostname)) return res.status(400).json({ error: 'Hostname fehlt oder ist ungültig' });
    const r = login
      ? await pool.query(`DELETE FROM ssh_sitzung WHERE host = $1 AND login = $2`, [hostname, login])
      : await pool.query(`DELETE FROM ssh_sitzung WHERE host = $1`, [hostname]);
    res.json({ ok: true, beendet: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ssh/sitzungen — wer sitzt gerade wo (Technik)
router.get('/sitzungen', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT host, login, angemeldet_seit, zuletzt_gesehen,
              (zuletzt_gesehen < NOW() - ($1 || ' hours')::interval) AS veraltet
         FROM ssh_sitzung ORDER BY host, login`, [String(SITZUNG_FRIST_STUNDEN)]);
    res.json({ sitzungen: r.rows, frist_stunden: SITZUNG_FRIST_STUNDEN });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 2b. Dienstwacht
//
// Proxmox weiss nur, ob ein Container laeuft. Das genuegt nicht: Am
// 29. August 2026 standen drei Ausfaelle zwischen vier und siebzehn
// Tagen unbemerkt — leere VLAN-Tabellen im VPN, ein haengendes
// networking.service, ein toter Domaenencontroller. Alle drei Container
// liefen die ganze Zeit tadellos. Kaputt war der Dienst darin.
//
// Also meldet jeder Knoten, was bei ihm und in seinen Containern
// fehlgeschlagen ist oder seit Ewigkeiten "activating" sagt.
// ════════════════════════════════════════════════════════════════════

// POST /api/ssh/dienste  { knoten, befunde: [{host, ebene, unit, zustand}] }
// Der Bericht ist vollstaendig: Was nicht drinsteht, gilt als behoben.
router.post('/dienste', requireHostToken, async (req, res) => {
  try {
    const knoten = String(req.body?.knoten || '').trim();
    if (!HOSTNAME_MUSTER.test(knoten)) return res.status(400).json({ error: 'knoten fehlt oder ist ungültig' });
    const befunde = Array.isArray(req.body?.befunde) ? req.body.befunde.slice(0, 2000) : [];

    const gesehen = [];
    let neuGemeldet = 0;
    for (const b of befunde) {
      const host = String(b.host || '').slice(0, 120);
      const unit = String(b.unit || '').slice(0, 160);
      const zustand = b.zustand === 'activating' ? 'activating' : 'failed';
      const ebene = b.ebene === 'knoten' ? 'knoten' : 'container';
      if (!host || !unit) continue;
      gesehen.push(`${host}|${unit}`);
      const r = await pool.query(
        `INSERT INTO dienst_wacht (host, knoten, ebene, unit, zustand, seit, zuletzt_gesehen)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (host, unit) DO UPDATE
           SET zustand = EXCLUDED.zustand, zuletzt_gesehen = NOW(), knoten = EXCLUDED.knoten
         RETURNING (xmax = 0) AS ist_neu`,
        [host, knoten, ebene, unit, zustand]);
      if (r.rows[0]?.ist_neu) neuGemeldet++;
    }

    // Was dieser Knoten nicht mehr meldet, ist behoben. Nur seine
    // eigenen Zeilen anfassen — die anderen Knoten melden fuer sich.
    const weg = await pool.query(
      `DELETE FROM dienst_wacht
        WHERE knoten = $1 AND NOT (host || '|' || unit = ANY($2::text[]))`,
      [knoten, gesehen]);

    // Neue Befunde melden. Eine Wacht, die niemanden weckt, ist keine —
    // genau daran sind die drei Ausfaelle vom 29. August vorbeigelaufen.
    // Nur Neues, sonst wird die Meldung zur Tapete und niemand liest sie.
    if (neuGemeldet > 0) {
      try {
        const frisch = await pool.query(
          `SELECT host, unit, zustand FROM dienst_wacht
            WHERE knoten = $1 AND seit > NOW() - INTERVAL '5 minutes'
            ORDER BY host, unit LIMIT 12`, [knoten]);
        if (frisch.rows.length) {
          const zeilen = frisch.rows.map(f => `• ${f.host}: ${f.unit} (${f.zustand})`).join('\n');
          const gid = await resolveTechnikWhatsappGroupId();
          if (gid) await queueWhatsappMessage({
            chatId: gid,
            body: `Dienstwacht ${knoten}: ${neuGemeldet} neue Befunde\n${zeilen}`,
            sourceType: 'dienst-wacht',
          });
        }
      } catch (e) { console.warn('[dienstwacht] Meldung fehlgeschlagen:', e.message); }
    }

    res.json({ aufgenommen: gesehen.length, neu: neuGemeldet, behoben: weg.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ssh/dienste — was gerade im Argen liegt (Technik)
router.get('/dienste', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT host, knoten, ebene, unit, zustand, seit, zuletzt_gesehen,
              EXTRACT(EPOCH FROM (NOW() - seit))::bigint AS sekunden
         FROM dienst_wacht
        ORDER BY seit, host, unit`);
    // Knoten, die sich laenger nicht gemeldet haben, sind selbst ein
    // Befund — eine stille Wacht ist keine.
    const stumm = await pool.query(
      `SELECT DISTINCT knoten, MAX(zuletzt_gesehen) AS zuletzt
         FROM dienst_wacht GROUP BY knoten
        HAVING MAX(zuletzt_gesehen) < NOW() - INTERVAL '30 minutes'`);
    res.json({ befunde: r.rows, stumme_knoten: stumm.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// 3. Zugriffsmatrix (Technik/Praesident)
// ════════════════════════════════════════════════════════════════════

// GET /api/ssh/hosts — was sich bisher gemeldet hat
router.get('/hosts', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, hostname, adresse, erst_gesehen, zuletzt_gesehen, abfragen, aktiv, notiz
         FROM ssh_hosts ORDER BY aktiv DESC, hostname`);
    res.json({ hosts: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/ssh/hosts/:id  { aktiv, notiz }
router.patch('/hosts/:id', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const { aktiv, notiz } = req.body || {};
    const r = await pool.query(
      `UPDATE ssh_hosts
          SET aktiv = COALESCE($2, aktiv),
              notiz = COALESCE($3, notiz)
        WHERE id = $1 RETURNING id, hostname, aktiv, notiz`,
      [id, typeof aktiv === 'boolean' ? aktiv : null, notiz === undefined ? null : String(notiz).slice(0, 500)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ssh/matrix — Regeln, dazu die aufgeloeste Wirkung je Person
router.get('/matrix', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const regeln = await pool.query(
      `SELECT z.id, z.host_id, h.hostname, z.subjekt_typ, z.subjekt, z.ssh, z.sudo, z.notiz, z.erstellt_am
         FROM ssh_zugriff z LEFT JOIN ssh_hosts h ON h.id = z.host_id
        ORDER BY h.hostname NULLS FIRST, z.subjekt_typ, z.subjekt`);

    // Wirkung: nur Personen, die ueberhaupt einen Schluessel haben —
    // ohne Schluessel ist jede Regel folgenlos.
    const hosts = await pool.query(`SELECT id, hostname, aktiv FROM ssh_hosts ORDER BY hostname`);
    const personen = await pool.query(
      `SELECT DISTINCT u.id, u.username, u.name
         FROM users u JOIN ssh_schluessel s ON s.user_id = u.id
        WHERE u.active = true AND u.username IS NOT NULL ORDER BY u.username`);
    const wirkung = [];
    for (const p of personen.rows) {
      const zeile = { username: p.username, name: p.name, hosts: {} };
      for (const h of hosts.rows) {
        const z = await zugriffErmitteln(p.username, h);
        zeile.hosts[h.hostname] = z.erlaubt ? (z.sudo ? 'sudo' : 'ssh') : '—';
      }
      wirkung.push(zeile);
    }
    // Die feste Regel steht nicht in der Tabelle, gehoert aber ins Bild —
    // sonst sieht die Oberflaeche eine Matrix, die nicht die ganze
    // Wahrheit ist.
    const fest = [{
      subjekt_typ: 'gruppe', subjekt: 'technik', ssh: true, sudo: true,
      notiz: 'Fest im Code verdrahtet — gilt auf allen Hosts und lässt sich hier nicht entziehen.',
    }];
    res.json({ regeln: regeln.rows, fest, hosts: hosts.rows, wirkung });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ssh/matrix — Regel anlegen oder aendern
router.post('/matrix', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const { host_id, subjekt_typ, subjekt, ssh, sudo, notiz } = req.body || {};
    if (!['gruppe', 'benutzer'].includes(subjekt_typ)) {
      return res.status(400).json({ error: "subjekt_typ muss 'gruppe' oder 'benutzer' sein" });
    }
    const wert = String(subjekt || '').trim();
    if (!wert || wert.length > 120) return res.status(400).json({ error: 'Subjekt fehlt' });
    const hostId = host_id === null || host_id === undefined || host_id === '' ? null : parseInt(host_id, 10);
    if (hostId !== null && !Number.isInteger(hostId)) return res.status(400).json({ error: 'Ungültige host_id' });

    // sudo ohne ssh waere wirkungslos und nur verwirrend.
    const sshWert = ssh !== false;
    const sudoWert = sshWert && sudo === true;

    // Erst aendern, dann anlegen. Die Eindeutigkeit haengt an zwei
    // Teil-Indizes (mit und ohne host_id); ein ON CONFLICT koennte
    // darauf nur mit genau passendem Index-Ausdruck schliessen, und
    // ein Griff daneben liefe in eine Ausnahme statt in den Update.
    const upd = await pool.query(
      `UPDATE ssh_zugriff SET ssh = $1, sudo = $2, notiz = $3
        WHERE subjekt_typ = $4 AND LOWER(subjekt) = LOWER($5)
          AND (($6::int IS NULL AND host_id IS NULL) OR host_id = $6)
        RETURNING id`,
      [sshWert, sudoWert, notiz ? String(notiz).slice(0, 500) : null, subjekt_typ, wert, hostId]);
    if (upd.rows.length) return res.json({ id: upd.rows[0].id, neu: false });

    const r = await pool.query(
      `INSERT INTO ssh_zugriff (host_id, subjekt_typ, subjekt, ssh, sudo, notiz)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [hostId, subjekt_typ, wert, sshWert, sudoWert, notiz ? String(notiz).slice(0, 500) : null]);
    res.json({ id: r.rows[0].id, neu: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ssh/matrix/:id
router.delete('/matrix/:id', authMiddleware, requireTechnik, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ungültige ID' });
    const r = await pool.query(`DELETE FROM ssh_zugriff WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.githubAbgleichAlle = githubAbgleichAlle;
module.exports = router;
