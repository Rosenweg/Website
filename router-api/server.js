#!/usr/bin/env node
// Rosenweg Router-LXC API
// Lauscht auf eth1 (VLAN 3, RK-Technik) und verwaltet User-VLANs auf eth0.
//   POST   /vlans          -> {vlan, gateway, mask, dhcp_from, dhcp_to}
//   DELETE /vlans/:vlan    -> Cleanup ip link + dnsmasq config + nftables rules
//   GET    /vlans          -> Liste aktuelle eth0.X Interfaces
//   GET    /health         -> hostname + Anzahl aktiver VLANs
// Auth: Bearer-Token aus /etc/rosenweg-router-api/token (chmod 600 root).

const http = require('http');
const fs = require('fs');
const os = require('os');
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
      if (req.method === 'GET' && path === '/vlans') return res.end(JSON.stringify({ vlans: listVlans() }));
      if (req.method === 'POST' && path === '/vlans') return res.end(JSON.stringify(addVlan(json)));
      const dm = /^\/vlans\/(\d+)$/.exec(path);
      if (req.method === 'DELETE' && dm) return res.end(JSON.stringify(removeVlan(Number(dm[1]))));
      res.writeHead(404); return res.end(JSON.stringify({ error: 'not_found' }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, LISTEN, () => console.log(`router-api ${LISTEN}:${PORT}`));
