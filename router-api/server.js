#!/usr/bin/env node
// Rosenweg Router-LXC API
// Lauscht auf eth1 (VLAN 3, RK-Technik) und verwaltet User-VLANs auf eth0.
//   POST   /vlans          -> {vlan, gateway, mask, dhcp_from, dhcp_to}
//                             Idempotent: bei bereits konfiguriertem VLAN
//                             sofort 200 mit applied:false. Sonst 202 mit
//                             {job_id} — Worker laeuft im Hintergrund.
//   GET    /jobs/:id       -> Job-Status: pending|done|failed (mit result/error)
//   DELETE /vlans/:vlan    -> Cleanup ip link + dnsmasq config + nftables rules
//   GET    /vlans          -> Liste aktuelle eth0.X Interfaces
//   GET    /health         -> hostname + Anzahl aktiver VLANs
// Auth: Bearer-Token aus /etc/rosenweg-router-api/token (chmod 600 root).
//
// Async-Apply: dnsmasq+nft Reload kann unter Last >15s dauern. Statt den
// HTTP-Request synchron warten zu lassen (Caller-Timeout = unklarer State
// im Router), gibt POST sofort job_id zurueck. API-Caller pollt /jobs/:id.

const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const TOKEN_FILE = '/etc/rosenweg-router-api/token';
const PORT = 8080;
const LISTEN = process.env.LISTEN_IP || '0.0.0.0';

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch (e) { console.error('Token-Datei fehlt:', TOKEN_FILE); process.exit(1); }
}
const TOKEN = readToken();

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function shTry(cmd) {
  try { return { ok: true, out: sh(cmd) }; }
  catch (e) { return { ok: false, error: e.message, stderr: (e.stderr || '').toString() }; }
}

function listVlans() {
  const out = shTry("ip -o link show | awk -F': ' '{print $2}' | grep -oE 'eth0\\.[0-9]+' | sort -u");
  if (!out.ok) return [];
  return out.out.trim().split('\n').filter(Boolean).map(s => Number(s.replace('eth0.', '')));
}

// Idempotenz-Check: ist dieses VLAN bereits voll konfiguriert?
// Wenn Interface, dnsmasq-Conf UND alle nft-Regeln existieren, kann der
// Apply uebersprungen werden — der teure systemctl restart faellt weg.
function vlanFullyConfigured(vlan) {
  const iface = `eth0.${vlan}`;
  if (!shTry(`ip link show ${iface}`).ok) return false;
  if (!fs.existsSync(`/etc/dnsmasq.d/vlan-${vlan}.conf`)) return false;
  const fwd = shTry('nft list chain inet rosenweg forward').out || '';
  if (!fwd.includes(`"${iface}"`)) return false;
  return true;
}

function addVlan({ vlan, gateway, mask, dhcp_from, dhcp_to }) {
  if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error('vlan invalid');
  if (!gateway || !mask || !dhcp_from || !dhcp_to) throw new Error('gateway/mask/dhcp_from/dhcp_to Pflicht');
  const iface = `eth0.${vlan}`;
  const steps = [];
  // 1. Interface
  if (!shTry(`ip link show ${iface}`).ok) {
    const r = shTry(`ip link add link eth0 name ${iface} type vlan id ${vlan}`);
    steps.push({ step: 'ip_link_add', ok: r.ok, error: r.error });
    if (!r.ok) throw new Error(`ip link add: ${r.error}`);
  } else { steps.push({ step: 'ip_link_add', ok: true, skipped: 'exists' }); }
  shTry(`ip link set ${iface} up`);
  const ar = shTry(`ip addr replace ${gateway}/${mask} dev ${iface}`);
  steps.push({ step: 'ip_addr', ok: ar.ok, error: ar.error });
  if (!ar.ok) throw new Error(`ip addr: ${ar.error}`);
  // 2. dnsmasq
  const conf = [
    `interface=${iface}`,
    `bind-interfaces`,
    `dhcp-range=${dhcp_from},${dhcp_to},12h`,
    `dhcp-option=tag:${iface},3,${gateway}`,
    `dhcp-option=tag:${iface},6,1.1.1.1,1.0.0.1`,
  ].join('\n') + '\n';
  fs.writeFileSync(`/etc/dnsmasq.d/vlan-${vlan}.conf`, conf);
  const ds = shTry('systemctl restart dnsmasq');
  steps.push({ step: 'dnsmasq', ok: ds.ok, error: ds.error });
  // 3. nftables
  const rules = [
    [`forward`, `iifname "${iface}" oifname "eth0" accept`],
    [`forward`, `iifname "eth0" oifname "${iface}" ct state established,related accept`],
    [`nat_post`, `oifname "eth0" masquerade`],
  ];
  for (const [chain, rule] of rules) {
    const exists = shTry(`nft list chain inet rosenweg ${chain} | grep -F '${rule}'`).ok;
    if (!exists) shTry(`nft add rule inet rosenweg ${chain} ${rule}`);
  }
  steps.push({ step: 'nftables', ok: true });
  return { ok: true, vlan, gateway, mask, dhcp_from, dhcp_to, iface, steps };
}

function removeVlan(vlan) {
  const iface = `eth0.${vlan}`;
  const steps = [];
  steps.push({ step: 'ip_link_del', ...shTry(`ip link delete ${iface}`) });
  try {
    fs.unlinkSync(`/etc/dnsmasq.d/vlan-${vlan}.conf`);
    steps.push({ step: 'dnsmasq_conf_rm', ok: true });
  } catch (e) { steps.push({ step: 'dnsmasq_conf_rm', ok: false, error: e.message }); }
  steps.push({ step: 'dnsmasq_restart', ...shTry('systemctl restart dnsmasq') });
  // nftables-Cleanup: ohne handles muessten wir die rules per handle entfernen,
  // einfacher: alle Regeln zu diesem iface neu suchen + handle parsen + del.
  const list = shTry('nft -a list chain inet rosenweg forward').out || '';
  const handles = [];
  for (const line of list.split('\n')) {
    if (line.includes(`"${iface}"`)) {
      const m = /# handle (\d+)/.exec(line);
      if (m) handles.push(m[1]);
    }
  }
  for (const h of handles) shTry(`nft delete rule inet rosenweg forward handle ${h}`);
  steps.push({ step: 'nftables_rm', ok: true, removed: handles.length });
  return { ok: true, vlan, iface, steps };
}

// ----------------------------------- Job-Queue --------------------------
// In-memory Map: job_id -> {status, result?, error?, started_at, finished_at?}
// Pro VLAN gibt's nur einen aktiven Job zur gleichen Zeit (Coalescing).
const jobs = new Map();
const vlanJobs = new Map(); // vlan -> job_id (nur fuer aktive Jobs)

function newJobId() { return crypto.randomBytes(8).toString('hex'); }

function runJob(jobId, fn) {
  jobs.set(jobId, { status: 'pending', started_at: Date.now() });
  setImmediate(() => {
    try {
      const result = fn();
      jobs.set(jobId, { status: 'done', result, started_at: Date.now(), finished_at: Date.now() });
    } catch (e) {
      jobs.set(jobId, { status: 'failed', error: e.message, started_at: Date.now(), finished_at: Date.now() });
    }
  });
}

// Cleanup: Jobs > 5 Min fertig oder > 10 Min pending (zombie) loeschen.
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    const stale = (j.finished_at && now - j.finished_at > 5 * 60 * 1000)
               || (!j.finished_at && now - j.started_at > 10 * 60 * 1000);
    if (stale) {
      jobs.delete(id);
      for (const [v, jid] of vlanJobs) if (jid === id) vlanJobs.delete(v);
    }
  }
}, 60 * 1000).unref?.();

// ----------------------------------- HTTP -------------------------------

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const json = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && path === '/health') {
        return res.end(JSON.stringify({ ok: true, hostname: os.hostname(), vlans: listVlans(), uptime_s: Math.floor(os.uptime()) }));
      }
      if (req.method === 'GET' && path === '/vlans') {
        return res.end(JSON.stringify({ vlans: listVlans() }));
      }
      if (req.method === 'POST' && path === '/vlans') {
        const vlan = Number(json.vlan);
        if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) {
          res.writeHead(400); return res.end(JSON.stringify({ error: 'vlan invalid' }));
        }
        // Schritt 1: Idempotenz — wenn VLAN bereits voll konfiguriert ist,
        // sofort done. Spart 1-3s systemctl-restart.
        if (vlanFullyConfigured(vlan)) {
          return res.end(JSON.stringify({
            ok: true, vlan, applied: false, skipped: 'already_configured',
          }));
        }
        // Schritt 2: Job-Coalescing — wenn fuer dieses VLAN schon ein Job
        // laeuft, dessen ID zurueckgeben. Verhindert doppelte konkurrente
        // Apply-Versuche bei retry-happy Callern.
        const existingJobId = vlanJobs.get(vlan);
        if (existingJobId && jobs.has(existingJobId)) {
          const j = jobs.get(existingJobId);
          if (j.status === 'pending') {
            res.writeHead(202);
            return res.end(JSON.stringify({ job_id: existingJobId, status: 'pending', coalesced: true }));
          }
        }
        // Schritt 3: neuer Job — sofort 202 + job_id zurueck, Apply async.
        const jobId = newJobId();
        vlanJobs.set(vlan, jobId);
        runJob(jobId, () => addVlan(json));
        res.writeHead(202);
        return res.end(JSON.stringify({ job_id: jobId, status: 'pending' }));
      }
      const jm = /^\/jobs\/([0-9a-f]+)$/.exec(path);
      if (req.method === 'GET' && jm) {
        const j = jobs.get(jm[1]);
        if (!j) { res.writeHead(404); return res.end(JSON.stringify({ error: 'job_not_found' })); }
        return res.end(JSON.stringify({ job_id: jm[1], ...j }));
      }
      const dm = /^\/vlans\/(\d+)$/.exec(path);
      if (req.method === 'DELETE' && dm) return res.end(JSON.stringify(removeVlan(Number(dm[1]))));
      res.writeHead(404); return res.end(JSON.stringify({ error: 'not_found' }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, LISTEN, () => console.log(`router-api ${LISTEN}:${PORT}`));
