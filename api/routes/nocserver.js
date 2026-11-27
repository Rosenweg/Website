// ═══════════════════════════════════════════════════════════════════
// NOC — Server: Proxmox-Cluster und PBS (Abschnitt „Server" im NOC)
//
//   GET /api/isp/noc/public/server   X-Noc-Token (wie dashboard/unifi)
//   GET /api/isp/noc/server          angemeldet, Technik/Präsident
//
// Die API holt alles selbst und gibt dem Browser nur das Ergebnis
// (lib/nocserver.js). Kein Token, keine Adresse verlässt die API.
//
// Zugänge — beide NUR lesend, beide eigens fürs Lesen angelegt:
//
//   PVE_AUDIT_TOKEN   user@realm!name=geheimnis, Rolle PVEAuditor auf /
//                     (Sys.Audit, VM.Audit, Datastore.Audit). Bewusst NICHT
//                     PVE_API_TOKEN: das ist root@pam!rosenweg-api und darf
//                     alles. Ein Wandbild soll nichts können, was es nicht
//                     braucht.
//   PVE_AUDIT_URLS    Knoten in der Reihenfolge, in der gefragt wird
//                     (Standard pve1, pve2, pve3) — fällt pve1 aus, sieht
//                     das NOC das über pve2, statt selbst schwarz zu werden.
//   PBS_AUDIT_TOKEN   derselbe wie für /sicherungen (routes/sicherungen.js),
//   PBS_FINGERPRINT   Rolle Audit auf / am PBS: Datastore.Audit für
//                     Belegung, Snapshots und Jobs, Sys.Audit für die Liste
//                     fehlgeschlagener Aufgaben. Zertifikat gepinnt.
//
// Zwischengespeichert: Gesamtbild 30 s, Platten (SMART) 10 min, onboot der
// gestoppten Gäste 5 min, PBS-Gruppen 60 s (Cache von /sicherungen).
// ═══════════════════════════════════════════════════════════════════
const N = require('../lib/nocserver');

const PVE_AUDIT_TOKEN = process.env.PVE_AUDIT_TOKEN || '';
const PVE_AUDIT_URLS = (process.env.PVE_AUDIT_URLS
  || 'https://100.64.2.20:8006,https://100.64.2.21:8006,https://100.64.2.22:8006')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const PBS_NOC_NAMESPACES = (process.env.PBS_NOC_NAMESPACES || 'Rosenweg9').split(',').map((s) => s.trim()).filter(Boolean);

const zahlEnv = (n, std) => (Number.isFinite(Number(process.env[n])) && process.env[n] !== '' ? Number(process.env[n]) : std);
const SCHWELLEN = {
  cpuGelb: zahlEnv('NOC_CPU_GELB', N.STANDARD.cpuGelb),
  ramGelb: zahlEnv('NOC_RAM_GELB', N.STANDARD.ramGelb),
  ssdGelb: zahlEnv('NOC_SSD_GELB', N.STANDARD.ssdGelb),
  ssdRot: zahlEnv('NOC_SSD_ROT', N.STANDARD.ssdRot),
  speicherGelb: zahlEnv('NOC_SPEICHER_GELB', N.STANDARD.speicherGelb),
  speicherRot: zahlEnv('NOC_SPEICHER_ROT', N.STANDARD.speicherRot),
  sicherungStunden: zahlEnv('NOC_SICHERUNG_STUNDEN', N.STANDARD.sicherungStunden),
};

// Welcher Knoten zuletzt geantwortet hat — dort zuerst fragen.
let pveBevorzugt = 0;

async function pveLesen(pfad) {
  if (!PVE_AUDIT_TOKEN) throw new Error('PVE_AUDIT_TOKEN fehlt');
  let letzter = null;
  for (let i = 0; i < PVE_AUDIT_URLS.length; i++) {
    const idx = (pveBevorzugt + i) % PVE_AUDIT_URLS.length;
    try {
      const r = await fetch(`${PVE_AUDIT_URLS[idx]}/api2/json${pfad}`, {
        headers: { Authorization: `PVEAPIToken=${PVE_AUDIT_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401 || r.status === 403) {
        // Rechte fehlen: an einem anderen Knoten wird es nicht besser.
        throw Object.assign(new Error(`PVE ${r.status} für ${pfad.split('?')[0]} (Rechte des Tokens?)`), { endgueltig: true });
      }
      if (!r.ok) throw new Error(`PVE ${r.status}`);
      pveBevorzugt = idx;
      return (await r.json()).data;
    } catch (e) {
      if (e.endgueltig) throw e;
      letzter = e;
    }
  }
  throw new Error('kein Proxmox-Knoten erreichbar' + (letzter ? ` (${letzter.message})` : ''));
}

const merk = { disks: { zeit: 0, daten: {} }, onboot: { zeit: 0, daten: {} } };

async function pveRoh() {
  const [status, knoten, gaeste, ha, ceph] = await Promise.all([
    pveLesen('/cluster/status'),
    pveLesen('/cluster/resources?type=node'),
    pveLesen('/cluster/resources?type=vm'),
    pveLesen('/cluster/ha/status/current').catch(() => []),
    pveLesen('/cluster/ceph/status').catch(() => null),
  ]);
  const online = (knoten || []).filter((k) => k.status === 'online').map((k) => k.node);

  const knotenInfo = {};
  await Promise.all(online.map(async (n) => {
    knotenInfo[n] = await pveLesen(`/nodes/${encodeURIComponent(n)}/status`).catch(() => ({}));
  }));

  // SMART liest Proxmox mit smartctl — nicht alle 30 s.
  if (Date.now() - merk.disks.zeit > 10 * 60_000) {
    const disks = {};
    await Promise.all(online.map(async (n) => {
      disks[n] = await pveLesen(`/nodes/${encodeURIComponent(n)}/disks/list`).catch(() => merk.disks.daten[n] || []);
    }));
    merk.disks = { zeit: Date.now(), daten: disks };
  }

  // onboot steht nur in der Konfiguration des Gasts. Gelesen nur für die,
  // die gerade nicht laufen — die laufenden sind ohnehin in Ordnung.
  const gestoppt = (gaeste || []).filter((g) => !g.template && g.status !== 'running');
  if (Date.now() - merk.onboot.zeit > 5 * 60_000
      || gestoppt.some((g) => !(g.vmid in merk.onboot.daten))) {
    const onboot = {};
    for (const g of gestoppt.slice(0, 40)) {
      const art = g.type === 'lxc' ? 'lxc' : 'qemu';
      try {
        const c = await pveLesen(`/nodes/${encodeURIComponent(g.node)}/${art}/${Number(g.vmid)}/config`);
        onboot[g.vmid] = Number(c?.onboot) === 1;
      } catch { onboot[g.vmid] = merk.onboot.daten[g.vmid] ?? false; }
    }
    merk.onboot = { zeit: Date.now(), daten: onboot };
  }

  return { status, knoten, knotenInfo, ha, ceph, disks: merk.disks.daten, gaeste, onboot: merk.onboot.daten };
}

/**
 * @param {object} pbs  aus routes/sicherungen.js: { pbsHolen, pbsUebersichtGecacht, einrichtung }
 */
function nocServer(pbs) {
  let cache = { zeit: 0, daten: null, laeuft: null };

  async function pbsTeil() {
    const fehlt = pbs.einrichtung().pbs;
    if (fehlt.length) return { eingerichtet: false, fehlt };
    const seit = Math.floor(Date.now() / 1000) - 24 * 3600;
    const [usage, gc, verify, prune, sync, tasks, uebersicht] = await Promise.all([
      pbs.pbsHolen('/status/datastore-usage'),
      pbs.pbsHolen('/admin/gc').catch(() => []),
      pbs.pbsHolen('/admin/verify').catch(() => []),
      pbs.pbsHolen('/admin/prune').catch(() => []),
      pbs.pbsHolen('/admin/sync').catch(() => []),
      pbs.pbsHolen(`/nodes/localhost/tasks?errors=1&since=${seit}&limit=200`).catch(() => []),
      pbs.pbsUebersichtGecacht(false).catch(() => null),
    ]);
    const gruppen = uebersicht && uebersicht.bereiche ? uebersicht.bereiche.flatMap((b) => b.gruppen) : [];
    return {
      eingerichtet: true,
      ...N.pbsAuswerten({
        usage, gc, verify, prune, sync, tasks, gruppen,
        ohne: uebersicht?.ohne_sicherung || [], namespaces: PBS_NOC_NAMESPACES,
      }, SCHWELLEN),
    };
  }

  async function pveTeil() {
    if (!PVE_AUDIT_TOKEN) return { eingerichtet: false, fehlt: ['PVE_AUDIT_TOKEN'] };
    return { eingerichtet: true, ...N.pveAuswerten(await pveRoh(), SCHWELLEN) };
  }

  async function bauen() {
    const [pve, pbsErg] = await Promise.all([
      pveTeil().catch((e) => ({ eingerichtet: true, fehler: e.message, ampel: 'rot' })),
      pbsTeil().catch((e) => ({ eingerichtet: true, fehler: e.message, ampel: 'rot' })),
    ]);
    return { pve, pbs: pbsErg, schwellen: SCHWELLEN, ts: Date.now() };
  }

  async function lesen() {
    if (cache.daten && Date.now() - cache.zeit < 30_000) return cache.daten;
    if (!cache.laeuft) {
      cache.laeuft = bauen()
        .then((d) => { cache = { zeit: Date.now(), daten: d, laeuft: null }; return d; })
        .catch((e) => { cache.laeuft = null; throw e; });
    }
    return cache.laeuft;
  }

  return async function nocServerHandler(req, res) {
    try {
      const d = await lesen();
      res.json(req.nocOffen ? N.serverOeffentlich(d) : d);
    } catch (e) {
      console.warn('[noc] Server:', e.message);
      res.status(500).json({ error: 'Serverzustand nicht lesbar' });
    }
  };
}

module.exports = { nocServer };
