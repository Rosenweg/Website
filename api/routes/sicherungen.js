// ═══════════════════════════════════════════════════════════════════
// SICHERUNGEN — Übersicht des PBS und PC-Sicherungen per Netzstart
// (Seite sicherungen.html, nur Technik/Präsident wie /stationen)
//
//   GET    /api/sicherungen/pbs                  Gruppen je Namespace, Warnungen (nur lesend)
//   GET    /api/sicherungen/pcs                  Stationen/PCs mit Vormerkung, Stand im
//                                                Sicherungs-System und letztem Lauf
//   PUT    /api/sicherungen/pcs/:id              MAC und Adresse von Hand  {mac, adresse}
//   POST   /api/sicherungen/pcs/:id/vormerkung   beim nächsten Netzstart ins Sicherungs-System
//   DELETE /api/sicherungen/pcs/:id/vormerkung   Vormerkung entfernen
//   POST   /api/sicherungen/pcs/:id/start        `sichern … --hintergrund` im Sicherungs-System
//
// Wie es mit der Infrastruktur spricht — alles vom Server aus, nie vom
// Browser, und kein Geheimnis verlässt die API:
//
//   PBS (lesend)    https://100.64.2.23:8007, Token mit DatastoreAudit
//                   (PBS_AUDIT_TOKEN), Zertifikat gegen PBS_FINGERPRINT
//                   geprüft — NODE_TLS_REJECT_UNAUTHORIZED=0 gilt hier nicht.
//   Proxmox VE      pveAPI aus server.js (/cluster/resources): Namen der VMs
//                   und freie VM-Nummern ab 9001.
//   UniFi           stat/sta: welche Adresse hat die MAC gerade. Das
//                   Sicherungs-System holt per DHCP mit ClientIdentifier=mac
//                   dieselbe Adresse wie Windows.
//   CT 135 (PXE)    SSH mit eigenem Schlüssel und erzwungenem Befehl
//                   (pxe-vormerkung liste|setzen|entfernen <mac>). Der setzt
//                   genau den Verweis aus sicherung/README.md,
//                   /srv/pxe/sicherung/vorgemerkt/<mac>.ipxe -> ../sicherung.ipxe.
//   Sicherungs-     SSH als root mit dem Wartungsschlüssel. Lesen:
//   System (PC)     `rosenweg-status --json` (sonst /run/sichern/status).
//                   Starten: `sichern … --token-stdin --hintergrund`, das
//                   Token des Benutzers sicherung@pbs!pc kommt über stdin,
//                   nie auf eine Befehlszeile.
//
// Ablauf und Hintergrund: Rosenweg/os-stationen, sicherung/README.md.
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('../lib/db');
const { authMiddleware } = require('../middleware/auth');
const kartenAdmin = require('../lib/kartenadmin'); // Admin-Aktionen mit der Karte
const { isTechnik, isPraesident } = require('../lib/groups');
const { createSemaphore } = require('../lib/utils');
const S = require('../lib/sicherungen');

const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Einstellungen (Geheimnisse nur aus der Umgebung) ──────────────
const PBS_URL = process.env.PBS_URL || 'https://100.64.2.23:8007';
const PBS_DATASTORE = process.env.PBS_DATASTORE || 'storage';
const PBS_AUDIT_TOKEN = process.env.PBS_AUDIT_TOKEN || '';          // user@realm!name:geheimnis
const PBS_FINGERPRINT = (process.env.PBS_FINGERPRINT || '').trim();  // sha256, aa:bb:…
const PBS_ERWARTUNG = S.erwartungenParsen(process.env.PBS_ERWARTUNG || 'Rosenweg9/pc=0,*=36');

const PC_REPO = process.env.PBS_PC_REPO || 'sicherung@pbs!pc@100.64.2.23:storage';
const PC_NS = process.env.PBS_PC_NS || 'Rosenweg9/pc';
const PC_TOKEN = process.env.PBS_PC_TOKEN || '';                      // nur das Geheimnis von sicherung@pbs!pc

const SSH_SCHLUESSEL = process.env.SICHERUNG_SSH_KEY || '/sicherung/id_ed25519';
const PXE_ZIEL = process.env.PXE_VORMERK_ZIEL || '';                  // z. B. pxe-vormerkung@<CT 135>
const PXE_SCHLUESSEL = process.env.PXE_VORMERK_SSH_KEY || '/sicherung/pxe_vormerkung';
const PXE_KNOWN_HOSTS = process.env.PXE_KNOWN_HOSTS || '/sicherung/known_hosts_pxe';

const UNIFI_HOST = process.env.UNIFI_HOST || 'https://100.64.2.1';
const UNIFI_API_KEY = process.env.UNIFI_API_KEY || '';

const REPO_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z0-9._-]+@[A-Za-z0-9.:[\]-]+:[A-Za-z0-9._-]+$/;
const NS_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*){0,7}$/;
const FP_RE = /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/;

const dateiDa = (p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } };

/** Was fehlt, damit ein Teil geht — nur Namen, nie Werte. */
function einrichtung() {
  const pbs = [];
  if (!PBS_AUDIT_TOKEN) pbs.push('PBS_AUDIT_TOKEN');
  if (!FP_RE.test(PBS_FINGERPRINT.toLowerCase())) pbs.push('PBS_FINGERPRINT');
  const vormerken = [];
  if (!PXE_ZIEL) vormerken.push('PXE_VORMERK_ZIEL');
  if (!dateiDa(PXE_SCHLUESSEL)) vormerken.push(`Schlüssel ${PXE_SCHLUESSEL}`);
  if (!dateiDa(PXE_KNOWN_HOSTS)) vormerken.push(`known_hosts ${PXE_KNOWN_HOSTS}`);
  const sichern = [];
  if (!PC_TOKEN) sichern.push('PBS_PC_TOKEN');
  if (!REPO_RE.test(PC_REPO)) sichern.push('PBS_PC_REPO (Form user@realm!token@host:datastore)');
  if (!NS_RE.test(PC_NS)) sichern.push('PBS_PC_NS');
  if (!FP_RE.test(PBS_FINGERPRINT.toLowerCase())) sichern.push('PBS_FINGERPRINT');
  if (!dateiDa(SSH_SCHLUESSEL)) sichern.push(`Schlüssel ${SSH_SCHLUESSEL}`);
  const adressen = UNIFI_API_KEY ? [] : ['UNIFI_API_KEY (sonst Adresse von Hand eintragen)'];
  return { pbs, vormerken, sichern, adressen };
}

// ─── PBS (nur lesend, Zertifikat gepinnt) ──────────────────────────

const fpNorm = (s) => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * GET auf die PBS-API. Die TLS-Verbindung steht zuerst und wird gegen den
 * Fingerabdruck geprüft; erst danach geht die Anfrage mit dem Token hinaus.
 * Ein falscher Server sieht das Token also nie.
 */
function pbsHolen(pfad, timeoutMs = 10000) {
  const u = new URL(PBS_URL);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 8007;
  return new Promise((resolve, reject) => {
    let fertig = false;
    const ende = (fn, v) => { if (!fertig) { fertig = true; fn(v); } };
    const sock = tls.connect({
      host, port, rejectUnauthorized: false,
      servername: net.isIP(host) ? undefined : host,
    });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('PBS antwortet nicht')));
    sock.once('error', (e) => ende(reject, e));
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate()?.fingerprint256;
      if (!fp || fpNorm(fp) !== fpNorm(PBS_FINGERPRINT)) {
        sock.destroy();
        return ende(reject, new Error('PBS-Zertifikat passt nicht zu PBS_FINGERPRINT'));
      }
      const req = http.request({
        // Ohne `agent`: nur dann nimmt http.request createConnection, also
        // genau diesen schon geprüften Socket (agent:false baute eine neue,
        // ungeprüfte Verbindung auf).
        host, port, method: 'GET', path: `/api2/json${pfad}`,
        createConnection: () => sock,
        headers: { Authorization: `PBSAPIToken=${PBS_AUDIT_TOKEN}`, Accept: 'application/json', Host: u.host },
      }, (res) => {
        const teile = [];
        let laenge = 0;
        res.on('data', (c) => {
          laenge += c.length;
          if (laenge > 32 * 1024 * 1024) { res.destroy(); return ende(reject, new Error('PBS-Antwort zu gross')); }
          teile.push(c);
        });
        res.on('end', () => {
          const roh = Buffer.concat(teile).toString('utf8');
          if (res.statusCode !== 200) {
            // Die Fehlermeldung des PBS enthält kein Token; gekürzt weiterreichen.
            return ende(reject, new Error(`PBS ${res.statusCode}: ${roh.slice(0, 200).replace(/\s+/g, ' ')}`));
          }
          try { ende(resolve, JSON.parse(roh).data); } catch { ende(reject, new Error('PBS-Antwort ist kein JSON')); }
        });
        res.on('error', (e) => ende(reject, e));
      });
      req.on('error', (e) => ende(reject, e));
      req.end();
    });
  });
}

const ds = encodeURIComponent(PBS_DATASTORE);

async function pbsNamespaces() {
  const liste = await pbsHolen(`/admin/datastore/${ds}/namespace?max-depth=7`);
  return (liste || []).map((n) => n.ns || '').filter((ns) => ns === '' || NS_RE.test(ns)).sort();
}

async function pbsSnapshots(ns) {
  const q = ns ? `?ns=${encodeURIComponent(ns)}` : '';
  return (await pbsHolen(`/admin/datastore/${ds}/snapshots${q}`)) || [];
}

// ─── Proxmox VE ────────────────────────────────────────────────────

let pveAPI = null; // aus server.js (sicherungenRouter({ pveAPI }))

/** Map vmid -> {name, type, status, template} aller VMs und CTs. */
async function clusterVms() {
  if (!pveAPI) throw new Error('Proxmox-Anbindung fehlt');
  const r = await pveAPI('GET', '/cluster/resources?type=vm');
  return new Map((r || []).map((x) => [Number(x.vmid), {
    name: x.name || null, type: x.type, status: x.status, template: Boolean(x.template),
  }]));
}

// ─── Übersicht (eine Minute zwischengespeichert) ───────────────────

let pbsCache = { zeit: 0, daten: null, laeuft: null };

async function pbsUebersicht() {
  const fehlt = einrichtung().pbs;
  if (fehlt.length) return { eingerichtet: false, fehlt };
  const jetzt = new Date();
  let cluster = null;
  let clusterFehler = null;
  try { cluster = await clusterVms(); } catch (e) { clusterFehler = e.message; }

  const [namespaces, status] = await Promise.all([
    pbsNamespaces(),
    pbsHolen(`/admin/datastore/${ds}/status`).catch(() => null),
  ]);
  const bereiche = [];
  const alle = [];
  for (const ns of namespaces) {
    const snaps = await pbsSnapshots(ns);
    const stunden = S.erwartungFuer(ns, PBS_ERWARTUNG);
    // PC-Abbilder tragen VM-Nummern, die es im Cluster absichtlich nicht gibt.
    const gruppen = S.gruppenAusSnapshots(snaps, { ns, stunden, cluster: ns === PC_NS ? null : cluster, jetzt });
    alle.push(...gruppen);
    // Leere Zwischenebenen (nur Eltern weiterer Namespaces) weglassen.
    if (!gruppen.length && ns === '') continue;
    bereiche.push({
      ns, erwartung_stunden: stunden, gruppen,
      warnungen: gruppen.filter((g) => g.warnung).length,
      groesse: gruppen.reduce((s, g) => s + (g.groesse || 0), 0),
    });
  }
  return {
    eingerichtet: true,
    stand: jetzt.toISOString(),
    datastore: PBS_DATASTORE,
    belegung: status ? { gesamt: status.total ?? null, belegt: status.used ?? null, frei: status.avail ?? null } : null,
    bereiche,
    warnungen: alle.filter((g) => g.warnung).length,
    ohne_sicherung: cluster ? S.ohneSicherung(cluster, alle) : null,
    cluster_fehler: clusterFehler,
  };
}

async function pbsUebersichtGecacht(frisch) {
  if (!frisch && pbsCache.daten && Date.now() - pbsCache.zeit < 60 * 1000) return pbsCache.daten;
  if (!pbsCache.laeuft) {
    pbsCache.laeuft = pbsUebersicht()
      .then((d) => { pbsCache = { zeit: Date.now(), daten: d, laeuft: null }; return d; })
      .catch((e) => { pbsCache.laeuft = null; throw e; });
  }
  return pbsCache.laeuft;
}

// ─── SSH ───────────────────────────────────────────────────────────

const sshPlatz = createSemaphore(4);

/**
 * Ein Befehl über SSH. Die Umgebung des Kindprozesses ist absichtlich leer
 * bis auf PATH und das, was ausdrücklich mitgehen soll (SendEnv) — die
 * Geheimnisse der API gehören nicht in den Prozess.
 */
async function ssh({ ziel, schluessel, knownHosts, befehl, eingabe = null, sendEnv = {}, timeoutMs = 15000 }) {
  const frei = await sshPlatz();
  try {
    const args = [
      '-i', schluessel, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '-o', 'LogLevel=ERROR', '-F', '/dev/null',
    ];
    if (knownHosts) {
      args.push('-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`);
    } else {
      // Das Sicherungs-System erzeugt seine Host-Schlüssel bei jedem Start
      // neu (sicherung/README.md) — es gibt nichts, gegen das man prüfen könnte.
      args.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'GlobalKnownHostsFile=/dev/null');
    }
    for (const k of Object.keys(sendEnv)) args.push('-o', `SendEnv=${k}`);
    args.push('--', ziel, befehl);
    return await new Promise((resolve) => {
      const kind = spawn('ssh', args, {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/tmp', ...sendEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const t = setTimeout(() => kind.kill('SIGKILL'), timeoutMs);
      kind.stdout.on('data', (c) => { if (out.length < 256 * 1024) out += c; });
      kind.stderr.on('data', (c) => { if (err.length < 16 * 1024) err += c; });
      kind.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
      kind.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      if (eingabe != null) kind.stdin.end(eingabe); else kind.stdin.end();
    });
  } finally { frei(); }
}

const letzteZeile = (s) => String(s || '').trim().split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 400);

// ─── CT 135: Vormerkungen ──────────────────────────────────────────

let vormerkCache = { zeit: 0, macs: null, fehler: null };

async function pxe(befehl) {
  if (einrichtung().vormerken.length) throw new Error('Vormerken ist noch nicht eingerichtet');
  const r = await ssh({ ziel: PXE_ZIEL, schluessel: PXE_SCHLUESSEL, knownHosts: PXE_KNOWN_HOSTS, befehl });
  if (r.code !== 0) throw new Error(`CT 135: ${letzteZeile(r.err || r.out) || 'Exit ' + r.code}`);
  return r.out;
}

async function vormerkungen(frisch = false) {
  if (einrichtung().vormerken.length) return { macs: null, fehler: null };
  if (!frisch && Date.now() - vormerkCache.zeit < 10 * 1000) return vormerkCache;
  try {
    const out = await pxe('liste');
    const macs = new Set(out.split('\n').map(S.macNorm).filter(Boolean));
    vormerkCache = { zeit: Date.now(), macs, fehler: null };
  } catch (e) {
    vormerkCache = { zeit: Date.now(), macs: null, fehler: e.message };
  }
  return vormerkCache;
}

// ─── UniFi: Adresse zur MAC ────────────────────────────────────────

let unifiCache = { zeit: 0, clients: [] };

async function unifiClients() {
  if (!UNIFI_API_KEY) return [];
  if (Date.now() - unifiCache.zeit < 20 * 1000) return unifiCache.clients;
  try {
    const r = await fetch(`${UNIFI_HOST}/proxy/network/api/s/default/stat/sta`, {
      headers: { 'X-API-Key': UNIFI_API_KEY }, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`unifi stat/sta -> ${r.status}`);
    unifiCache = { zeit: Date.now(), clients: (await r.json()).data || [] };
  } catch (e) {
    console.warn('[sicherungen] UniFi:', e.message);
    unifiCache.zeit = Date.now();
  }
  return unifiCache.clients;
}

// ─── Sicherungs-System: Stand lesen ────────────────────────────────

const STATUS_BEFEHL = 'if command -v rosenweg-status >/dev/null 2>&1; then rosenweg-status --json; '
  + 'else echo "#kv"; cat /run/sichern/status 2>/dev/null; fi';

const liveCache = new Map(); // ip -> {zeit, wert}

/** {erreichbar, status?, fehler?} — kurz zwischengespeichert, damit Abfragen sich nicht stapeln. */
async function liveLesen(ip) {
  // Antwortet nichts (PC noch in Windows, aus, unterwegs), seltener fragen.
  const c = liveCache.get(ip);
  if (c && Date.now() - c.zeit < (c.wert.erreichbar ? 4000 : 15000)) return c.wert;
  let wert;
  if (!dateiDa(SSH_SCHLUESSEL)) {
    wert = { erreichbar: false, fehler: 'Wartungsschlüssel fehlt auf dem Server' };
  } else {
    const r = await ssh({ ziel: `root@${ip}`, schluessel: SSH_SCHLUESSEL, befehl: STATUS_BEFEHL, timeoutMs: 12000 });
    wert = r.code === 0
      ? { erreichbar: true, status: S.liveStatus(r.out) }
      : { erreichbar: false, fehler: letzteZeile(r.err) || `Exit ${r.code}` };
  }
  liveCache.set(ip, { zeit: Date.now(), wert });
  if (liveCache.size > 200) liveCache.delete(liveCache.keys().next().value);
  return wert;
}

// ─── Datenbank ─────────────────────────────────────────────────────

let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS pc_sicherung (
      station_id   TEXT PRIMARY KEY,
      mac          TEXT,
      adresse      TEXT,
      vmid         INT UNIQUE,
      geaendert_von TEXT,
      geaendert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pc_sicherung_lauf (
      id             BIGSERIAL PRIMARY KEY,
      station_id     TEXT NOT NULL,
      sicherungs_id  TEXT NOT NULL,
      vmid           INT NOT NULL,
      mac            TEXT,
      adresse        TEXT NOT NULL,
      ns             TEXT,
      gestartet_von  TEXT,
      gestartet_am   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      zustand        TEXT NOT NULL DEFAULT 'gestartet',
      status         JSONB,
      grund          TEXT,
      snapshot       TEXT,
      zuletzt_erreicht TIMESTAMPTZ,
      beendet_am     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS pc_sicherung_lauf_station_idx ON pc_sicherung_lauf (station_id, gestartet_am DESC);
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/** Ins Ereignisprotokoll der Station — erscheint auch auf /stationen. */
function ereignis(stationId, art, wer, text) {
  return pool.query('INSERT INTO station_events (station_id, art, wer, text) VALUES ($1,$2,$3,$4)',
    [stationId, art, wer || null, text || null])
    .catch((e) => console.warn('[sicherungen] Ereignis nicht geschrieben:', e.message));
}

const wer = (req) => req.user?.email || req.user?.username || req.user?.name || null;

// ─── Die PCs zusammenstellen ───────────────────────────────────────

async function stationenLesen(id = null) {
  const r = await pool.query(`
    SELECT s.id, s.role, s.hostname, s.haus, s.standort, s.hardware, s.last_seen_ip, s.status,
           p.mac AS p_mac, p.adresse AS p_adresse, p.vmid AS p_vmid,
           l.id AS l_id, l.vmid AS l_vmid, l.sicherungs_id AS l_sid, l.adresse AS l_adresse,
           l.gestartet_von AS l_von, l.gestartet_am AS l_am, l.zustand AS l_zustand,
           l.status AS l_status, l.grund AS l_grund, l.snapshot AS l_snapshot,
           l.zuletzt_erreicht AS l_erreicht, l.beendet_am AS l_ende
      FROM stations s
      LEFT JOIN pc_sicherung p ON p.station_id = s.id
      LEFT JOIN LATERAL (
        SELECT * FROM pc_sicherung_lauf WHERE station_id = s.id ORDER BY gestartet_am DESC LIMIT 1) l ON true
     WHERE s.revoked_at IS NULL ${id ? 'AND s.id = $1' : ''}
     ORDER BY lower(COALESCE(s.hostname, s.id))`, id ? [id] : []);
  return r.rows;
}

function macsDerStation(z) {
  return [...new Set(Object.values(z.hardware?.macs || {}).map(S.macNorm).filter(Boolean))];
}

/** Eine Zeile für die Seite, ohne Live-Abfrage. */
function pcGrund(z, clients, vorgemerkt) {
  const eigene = macsDerStation(z);
  const name = (z.hostname || '').toLowerCase();
  const ausUnifi = name
    ? [...new Set(clients.filter((c) => [c.hostname, c.name].some((n) => n && String(n).toLowerCase() === name))
      .map((c) => S.macNorm(c.mac)).filter(Boolean))]
    : [];
  let mac = S.macNorm(z.p_mac);
  let macQuelle = mac ? 'eingetragen' : null;
  if (!mac && eigene.length === 1) { mac = eigene[0]; macQuelle = 'station'; }
  if (!mac && !eigene.length && ausUnifi.length === 1) { mac = ausUnifi[0]; macQuelle = 'unifi'; }

  const client = mac ? clients.find((c) => S.macNorm(c.mac) === mac) : null;
  let ip = null;
  let ipQuelle = null;
  if (z.p_adresse) { ip = z.p_adresse; ipQuelle = 'eingetragen'; }
  else if (client?.ip) { ip = client.ip; ipQuelle = 'unifi'; }

  const lauf = z.l_id ? {
    id: Number(z.l_id), vmid: z.l_vmid, sicherungs_id: z.l_sid, adresse: z.l_adresse,
    von: z.l_von, am: z.l_am, zustand: z.l_zustand, status: z.l_status, grund: z.l_grund,
    snapshot: z.l_snapshot, zuletzt_erreicht: z.l_erreicht, beendet_am: z.l_ende,
  } : null;

  return {
    id: z.id,
    hostname: z.hostname || z.id,
    role: z.role,
    haus: z.haus ?? null,
    standort: z.standort || null,
    gesperrt: z.status === 'gesperrt',
    mac,
    mac_quelle: macQuelle,
    mac_vorschlaege: [...new Set([...eigene, ...ausUnifi])],
    adresse_eingetragen: z.p_adresse || null,
    ip,
    ip_quelle: ipQuelle,
    unifi_name: client ? (client.hostname || client.name || null) : null,
    vmid: z.p_vmid || null,
    sicherungs_id: S.sicherungsId(z.hostname || z.id),
    vorgemerkt: vorgemerkt ? (mac ? vorgemerkt.has(mac) : false) : null,
    lauf,
  };
}

const aktiverLauf = (l) => l && !l.beendet_am;

// ─── Hintergrund: laufende Sicherungen nachführen ──────────────────

async function laufNachfuehren(l) {
  const live = await liveLesen(l.adresse);
  if (!live.erreichbar) {
    // Lange nichts gehört (PC aus, Netz weg): nach zwei Tagen abschliessen,
    // sonst stünde „läuft“ für immer da.
    const seit = new Date(l.zuletzt_erreicht || l.gestartet_am);
    if (Date.now() - seit > 48 * 60 * 60 * 1000) {
      await pool.query(`UPDATE pc_sicherung_lauf SET zustand='verloren', grund=$2, beendet_am=NOW() WHERE id=$1`,
        [l.id, `Seit ${seit.toISOString()} keine Verbindung zum Sicherungs-System`]);
      await ereignis(l.station_id, 'sicherung-verloren', null, `VM ${l.vmid}: keine Verbindung mehr`);
    }
    return;
  }
  const st = live.status;
  // Eine Sicherung eines anderen PCs auf derselben Adresse übernimmt diesen Lauf nicht.
  if (st.id && !st.id.startsWith(l.sicherungs_id)) return;
  // Direkt nach dem Start kann noch der Endzustand eines früheren Durchgangs
  // in /run/sichern/status stehen, bis der neue „läuft“ schreibt. Ein
  // Endzustand zählt deshalb erst, wenn dieser Lauf schon „läuft“ gesehen hat
  // oder seit zwei Minuten besteht (dann ist die Datei sicher neu).
  const altGenug = Date.now() - new Date(l.gestartet_am) > 2 * 60 * 1000;
  let zustand = l.zustand;
  if (st.zustand === 'laeuft') zustand = 'laeuft';
  else if (S.ENDZUSTAENDE.includes(st.zustand) && (l.zustand === 'laeuft' || altGenug)) zustand = st.zustand;
  const ende = S.ENDZUSTAENDE.includes(zustand);
  await pool.query(`
    UPDATE pc_sicherung_lauf SET zustand=$2, status=$3, grund=NULLIF($4,''), snapshot=NULLIF($5,''),
           zuletzt_erreicht=NOW(), beendet_am=CASE WHEN $6 THEN NOW() ELSE NULL END
     WHERE id=$1`, [l.id, zustand, JSON.stringify(st), st.grund, st.snapshot, ende]);
  if (ende && l.zustand !== zustand) {
    const text = zustand === 'erfolg' ? `VM ${l.vmid}: Sicherung vollständig und geprüft${st.snapshot ? ' (' + st.snapshot + ')' : ''}`
      : `VM ${l.vmid}: ${zustand === 'fehler' ? 'Fehler' : 'nicht in Ordnung'}${st.grund ? ' – ' + st.grund : ''}`;
    await ereignis(l.station_id, `sicherung-${zustand}`, null, text);
    pbsCache.zeit = 0;
  }
}

let nachfuehrenLaeuft = false;
async function alleNachfuehren() {
  if (nachfuehrenLaeuft) return;
  nachfuehrenLaeuft = true;
  try {
    await ensureSchema();
    const r = await pool.query('SELECT * FROM pc_sicherung_lauf WHERE beendet_am IS NULL');
    for (const l of r.rows) {
      try { await laufNachfuehren(l); } catch (e) { console.warn('[sicherungen] Lauf', l.id, e.message); }
    }
  } catch (e) {
    console.warn('[sicherungen] Nachführen:', e.message);
  } finally { nachfuehrenLaeuft = false; }
}

function starteNachfuehren(intervalle) {
  const t = setInterval(alleNachfuehren, 20 * 1000);
  if (Array.isArray(intervalle)) intervalle.push(t);
  return t;
}

// ─── Router ────────────────────────────────────────────────────────

function nurTechnik(req, res, next) {
  const g = req.user?.groups || [];
  if (!(req.user?.isAdmin || isTechnik(g) || isPraesident(g))) return res.status(403).json({ error: 'Nur Technik darf Sicherungen sehen und starten' });
  kartenAdmin.vermerken(req, res); // mit der Karte: Protokoll + Quittung
  next();
}

function sicherungenRouter(deps = {}) {
  pveAPI = deps.pveAPI || null;
  const router = express.Router();
  router.use(authMiddleware, nurTechnik);
  router.use(a(async (req, res, next) => { await ensureSchema(); next(); }));

  router.get('/pbs', a(async (req, res) => {
    try {
      res.json(await pbsUebersichtGecacht(req.query.frisch === '1'));
    } catch (e) {
      console.warn('[sicherungen] PBS:', e.message);
      res.status(502).json({ error: `PBS nicht lesbar: ${e.message}` });
    }
  }));

  router.get('/pcs', a(async (req, res) => {
    const [zeilen, clients, vm] = await Promise.all([stationenLesen(), unifiClients(), vormerkungen()]);
    const pcs = zeilen.map((z) => pcGrund(z, clients, vm.macs));

    // Live nur, wo es etwas zu sehen gibt: vorgemerkt, Lauf offen oder
    // ausdrücklich angefragt. Sonst ginge bei jedem Laden ein SSH-Versuch an
    // jeden PC im Haus.
    const pruefen = new Set(String(req.query.pruefen || '').split(',').filter(Boolean));
    await Promise.all(pcs.map(async (p) => {
      const ip = aktiverLauf(p.lauf) ? p.lauf.adresse : p.ip;
      if (!ip || !(p.vorgemerkt || aktiverLauf(p.lauf) || pruefen.has(p.id))) return;
      p.live = await liveLesen(ip);
      p.live_adresse = ip;
    }));

    // Letzte PC-Sicherung je VM-Nummer aus dem PBS, wenn die Übersicht schon da ist.
    const pbs = pbsCache.daten;
    if (pbs?.bereiche) {
      const imPc = new Map((pbs.bereiche.find((b) => b.ns === PC_NS)?.gruppen || [])
        .filter((g) => g.typ === 'vm').map((g) => [Number(g.id), g]));
      for (const p of pcs) {
        const g = p.vmid ? imPc.get(Number(p.vmid)) : null;
        if (g) p.letzte_pbs = { zeit: g.letzte, groesse: g.groesse, pruefung: g.pruefung, anzahl: g.anzahl };
      }
    }
    res.json({ pcs, einrichtung: einrichtung(), vormerk_fehler: vm.fehler, ns: PC_NS });
  }));

  router.put('/pcs/:id', a(async (req, res) => {
    const [z] = await stationenLesen(req.params.id);
    if (!z) return res.status(404).json({ error: 'Station nicht gefunden' });
    const rohMac = String(req.body?.mac ?? '').trim();
    const mac = rohMac ? S.macNorm(rohMac) : null;
    if (rohMac && !mac) return res.status(400).json({ error: 'Das ist keine MAC-Adresse (z. B. aa:bb:cc:dd:ee:ff)' });
    const rohIp = String(req.body?.adresse ?? '').trim();
    if (rohIp && net.isIP(rohIp) !== 4) return res.status(400).json({ error: 'Adresse: bitte eine IPv4-Adresse' });
    // Eine geänderte MAC bei liegender Vormerkung liesse die alte stehen.
    const alt = S.macNorm(z.p_mac);
    if (alt && alt !== mac) {
      const vm = await vormerkungen(true);
      if (vm.macs?.has(alt)) return res.status(409).json({ error: 'Erst die Vormerkung entfernen, dann die MAC ändern' });
    }
    await pool.query(`
      INSERT INTO pc_sicherung (station_id, mac, adresse, geaendert_von, geaendert_am)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (station_id) DO UPDATE SET mac=$2, adresse=$3, geaendert_von=$4, geaendert_am=NOW()`,
    [z.id, mac, rohIp || null, wer(req)]);
    res.json({ ok: true });
  }));

  async function pcFuer(req) {
    const [z] = await stationenLesen(req.params.id);
    if (!z) return null;
    return pcGrund(z, await unifiClients(), null);
  }

  router.post('/pcs/:id/vormerkung', a(async (req, res) => {
    const p = await pcFuer(req);
    if (!p) return res.status(404).json({ error: 'Station nicht gefunden' });
    if (!p.mac) return res.status(400).json({ error: 'Zuerst die MAC-Adresse eintragen' });
    try { await pxe(`setzen ${p.mac}`); } catch (e) { return res.status(502).json({ error: e.message }); }
    vormerkCache.zeit = 0;
    await ereignis(p.id, 'sicherung-vorgemerkt', wer(req), `MAC ${p.mac}: nächster Netzstart ins Sicherungs-System`);
    res.json({ ok: true });
  }));

  router.delete('/pcs/:id/vormerkung', a(async (req, res) => {
    const p = await pcFuer(req);
    if (!p) return res.status(404).json({ error: 'Station nicht gefunden' });
    if (!p.mac) return res.status(400).json({ error: 'Keine MAC-Adresse bekannt' });
    try { await pxe(`entfernen ${p.mac}`); } catch (e) { return res.status(502).json({ error: e.message }); }
    vormerkCache.zeit = 0;
    await ereignis(p.id, 'sicherung-vormerkung-weg', wer(req), `MAC ${p.mac}`);
    res.json({ ok: true });
  }));

  router.post('/pcs/:id/start', a(async (req, res) => {
    const fehlt = einrichtung().sichern;
    if (fehlt.length) return res.status(503).json({ error: `Sichern ist noch nicht eingerichtet: ${fehlt.join(', ')}` });
    const p = await pcFuer(req);
    if (!p) return res.status(404).json({ error: 'Station nicht gefunden' });
    if (!p.sicherungs_id) return res.status(400).json({ error: 'Aus dem Rechnernamen lässt sich keine Kennung bilden' });
    if (!p.ip) return res.status(400).json({ error: 'Adresse des PCs unbekannt – in UniFi nicht gefunden, bitte von Hand eintragen' });
    if (aktiverLauf(p.lauf)) return res.status(409).json({ error: 'Für diesen PC läuft schon eine Sicherung' });

    // Ist da wirklich das Sicherungs-System, und wartet es?
    liveCache.delete(p.ip);
    const live = await liveLesen(p.ip);
    if (!live.erreichbar) return res.status(409).json({ error: `Das Sicherungs-System antwortet nicht (${live.fehler})` });
    if (live.status.zustand === 'laeuft') return res.status(409).json({ error: 'Dort läuft schon eine Sicherung' });

    // VM-Nummer: die zugeordnete, sonst eine bestehende PC-Sicherung dieses
    // PCs (Notiz „<id> – PC-Abbild …“), sonst die nächste freie ab 9001.
    let vmid = p.vmid;
    if (!vmid) {
      let cluster;
      try { cluster = await clusterVms(); } catch (e) {
        return res.status(502).json({ error: `Proxmox nicht lesbar – ohne Liste der VMs keine sichere Nummer (${e.message})` });
      }
      const belegt = new Set(cluster.keys());
      for (const r of (await pool.query('SELECT vmid FROM pc_sicherung WHERE vmid IS NOT NULL')).rows) belegt.add(r.vmid);
      try {
        const snaps = einrichtung().pbs.length ? [] : await pbsSnapshots(PC_NS);
        for (const g of S.gruppenAusSnapshots(snaps, { ns: PC_NS })) {
          if (g.typ !== 'vm') continue;
          if (!vmid && g.notiz && g.notiz.toLowerCase().startsWith(p.sicherungs_id + ' ') && !belegt.has(Number(g.id))) vmid = Number(g.id);
          belegt.add(Number(g.id));
        }
      } catch (e) {
        console.warn('[sicherungen] PBS beim Vergeben der VM-Nummer:', e.message);
      }
      if (!vmid) vmid = S.naechsteVmid(belegt);
      if (!vmid) return res.status(409).json({ error: 'Keine freie VM-Nummer zwischen 9001 und 9999' });
      await pool.query(`
        INSERT INTO pc_sicherung (station_id, vmid, geaendert_von) VALUES ($1, $2, $3)
        ON CONFLICT (station_id) DO UPDATE SET vmid=$2, geaendert_von=$3, geaendert_am=NOW()`,
      [p.id, vmid, wer(req)]);
    }

    const befehl = ['sichern', '--repo', S.shQuote(PC_REPO), '--ns', S.shQuote(PC_NS),
      '--id', S.shQuote(p.sicherungs_id), '--vmid', String(Number(vmid)), '--token-stdin', '--hintergrund'].join(' ');
    const r = await ssh({
      ziel: `root@${p.ip}`, schluessel: SSH_SCHLUESSEL, befehl,
      eingabe: PC_TOKEN + '\n', sendEnv: { PBS_FINGERPRINT }, timeoutMs: 60000,
    });
    if (r.code !== 0) {
      return res.status(502).json({ error: `sichern hat nicht gestartet: ${letzteZeile(r.err || r.out) || 'Exit ' + r.code}` });
    }
    const l = await pool.query(`
      INSERT INTO pc_sicherung_lauf (station_id, sicherungs_id, vmid, mac, adresse, ns, gestartet_von, zuletzt_erreicht)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
    [p.id, p.sicherungs_id, vmid, p.mac, p.ip, PC_NS, wer(req)]);
    liveCache.delete(p.ip);
    await ereignis(p.id, 'sicherung-gestartet', wer(req), `VM ${vmid}, ${p.ip}, Namespace ${PC_NS}`);
    res.json({ ok: true, lauf: Number(l.rows[0].id), vmid });
  }));

  router.use((err, req, res, _next) => {
    console.error('[sicherungen]', err.message);
    res.status(500).json({ error: 'Interner Fehler' });
  });
  return router;
}

module.exports = { sicherungenRouter, ensureSchema, starteNachfuehren };
