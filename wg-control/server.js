// wg-control — kleiner HTTP-Steuerdienst für den WireGuard-Server.
// Keine externen Abhängigkeiten (nur Node built-ins).
//
// Endpoints (Authorization: Bearer <WG_CONTROL_TOKEN>):
//   GET    /health                 ohne Auth
//   POST   /peers                  body: {name, email, vlan}
//   GET    /peers
//   GET    /peers/:id
//   GET    /peers/:id/config       text/plain
//   GET    /peers/:id/qr           image/png
//   DELETE /peers/:id
//
// State: /var/lib/wg-control/state.json (Single Source of Truth)
// WG-Config: /etc/wireguard/wg0.conf wird aus State regeneriert,
//   appliziert via `wg syncconf` (kein Disconnect).
// Routing: pro Heim-VLAN eine Routing-Tabelle (default via 100.64.<vlan>.1)
//   + MASQUERADE pro eth-Egress; pro Peer `ip rule from <peer_ip> table <vlan>`.

import { createServer } from 'node:http';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT             = parseInt(process.env.WG_CONTROL_PORT || '3001', 10);
const TOKEN            = process.env.WG_CONTROL_TOKEN || '';
const STATE_PATH       = process.env.WG_CONTROL_STATE || '/var/lib/wg-control/state.json';
const WG_CONF_PATH     = '/etc/wireguard/wg0.conf';
const WG_INTERFACE     = 'wg0';
const WG_SUBNET_CIDR   = '192.168.2.0/24';
const WG_SERVER_IP     = '192.168.2.1';
const WG_PEER_START    = 10;
const WG_PEER_END      = 250;
const WG_LISTEN_PORT   = parseInt(process.env.WG_LISTEN_PORT || '51830', 10);
const WG_ENDPOINT_HOST = process.env.WG_ENDPOINT_HOST || 'kooperation.rosenweg4303.ch';
const CLIENT_DNS       = process.env.WG_CLIENT_DNS || '100.64.2.1';

const VLAN_TO_IFACE = {
  9:   'eth1',  // Tiefgarage
  19:  'eth2',  // RW1
  29:  'eth3',  // RW2
  49:  'eth4',  // RW4
  59:  'eth5',  // RW5
  69:  'eth6',  // RW6
  89:  'eth7',  // RW8
  99:  'eth8',  // RW9
  109: 'eth9',  // RW10
  129: 'eth10', // RW12
  139: 'eth11', // RW13
  149: 'eth12', // RW14
  169: 'eth13', // RW16
  179: 'eth14', // RW17
  189: 'eth15', // RW18
};
const ALL_VLANS = Object.keys(VLAN_TO_IFACE).map(Number);

if (!TOKEN) {
  console.error('FATAL: WG_CONTROL_TOKEN not set');
  process.exit(1);
}

// ----------------------------------- State ----------------------------------

function loadState() {
  if (!existsSync(STATE_PATH)) {
    mkdirSync('/var/lib/wg-control', { recursive: true });
    const init = { server_private_key: null, server_public_key: null, peers: [] };
    writeFileSync(STATE_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
let state = loadState();

// ----------------------------------- Helpers --------------------------------

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (err) { throw new Error(`shell failed: ${cmd}\n${err.stderr || err.message}`); }
}
function wgGenKey()  { return execSync('wg genkey', { encoding: 'utf8' }).trim(); }
function wgPubKey(priv) { return execFileSync('wg', ['pubkey'], { input: priv, encoding: 'utf8' }).trim(); }
function wgPresharedKey() { return execSync('wg genpsk', { encoding: 'utf8' }).trim(); }

function nextFreeIp() {
  const used = new Set(state.peers.map(p => p.assigned_ip));
  for (let i = WG_PEER_START; i <= WG_PEER_END; i++) {
    const ip = `192.168.2.${i}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error('peer IP pool exhausted');
}

// ----------------------------------- WireGuard ------------------------------

function ensureServerKeys() {
  if (!state.server_private_key) {
    const priv = wgGenKey();
    state.server_private_key = priv;
    state.server_public_key  = wgPubKey(priv);
    saveState(state);
  }
}
function renderWgConf() {
  const lines = [
    '[Interface]',
    `Address = ${WG_SERVER_IP}/24`,
    `PrivateKey = ${state.server_private_key}`,
    `ListenPort = ${WG_LISTEN_PORT}`,
    '',
  ];
  for (const p of state.peers) {
    lines.push(`# ${p.id} | ${p.name} | vlan=${p.vlan}`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${p.public_key}`);
    if (p.preshared_key) lines.push(`PresharedKey = ${p.preshared_key}`);
    lines.push(`AllowedIPs = ${p.assigned_ip}/32`);
    lines.push('');
  }
  return lines.join('\n');
}
function writeWgConf() { writeFileSync(WG_CONF_PATH, renderWgConf(), { mode: 0o600 }); }
function syncWgInterface() { sh(`bash -c 'wg syncconf ${WG_INTERFACE} <(wg-quick strip ${WG_INTERFACE})'`); }
function ensureWgUp() {
  try { sh(`ip link show ${WG_INTERFACE}`); }
  catch { sh(`wg-quick up ${WG_INTERFACE}`); }
}

// ----------------------------------- Routing / NAT --------------------------

function nftReady() {
  sh(`bash -c 'nft list table inet wg-control >/dev/null 2>&1 || nft -f - <<EOF
table inet wg-control {
  chain postrouting {
    type nat hook postrouting priority srcnat;
  }
}
EOF'`);
}
function ensureMasqueradeRules() {
  sh('nft flush chain inet wg-control postrouting');
  for (const vlan of ALL_VLANS) {
    const iface = VLAN_TO_IFACE[vlan];
    sh(`nft add rule inet wg-control postrouting oifname "${iface}" ip saddr ${WG_SUBNET_CIDR} masquerade`);
  }
}
function ensureVlanRoutingTables() {
  for (const vlan of ALL_VLANS) {
    try { sh(`ip route flush table ${vlan} 2>/dev/null`); } catch {}
    try { sh(`ip route replace default via 100.64.${vlan}.1 dev ${VLAN_TO_IFACE[vlan]} table ${vlan}`); }
    catch (e) { console.warn(`[wg-control] route add table ${vlan} failed:`, e.message); }
  }
}
function clearAllPeerRules() {
  const out = sh('ip rule list');
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+:\s+from\s+(192\.168\.2\.\d+)\s+lookup\s+(\d+)/);
    if (m) { try { sh(`ip rule del from ${m[1]} table ${m[2]}`); } catch {} }
  }
}
function addPeerRule(peer)  { sh(`ip rule add from ${peer.assigned_ip} table ${peer.vlan}`); }
function delPeerRule(peer)  { try { sh(`ip rule del from ${peer.assigned_ip} table ${peer.vlan}`); } catch {} }

// ----------------------------------- Live-Status ----------------------------

function wgDump() {
  try {
    const out = execSync(`wg show ${WG_INTERFACE} dump`, { encoding: 'utf8' });
    const lines = out.trim().split('\n').slice(1);
    const map = new Map();
    for (const line of lines) {
      const [pub, , endpoint, allowedIps, handshake, rx, tx] = line.split('\t');
      map.set(pub, {
        endpoint: endpoint === '(none)' ? null : endpoint,
        allowed_ips: allowedIps,
        latest_handshake: handshake === '0' ? null : new Date(parseInt(handshake, 10) * 1000).toISOString(),
        rx_bytes: parseInt(rx, 10) || 0,
        tx_bytes: parseInt(tx, 10) || 0,
      });
    }
    return map;
  } catch { return new Map(); }
}
function peerWithStatus(p, dump) {
  const live = (dump || wgDump()).get(p.public_key);
  return {
    id: p.id, name: p.name, email: p.email, vlan: p.vlan,
    assigned_ip: p.assigned_ip, public_key: p.public_key,
    created_at: p.created_at,
    endpoint: live?.endpoint || null,
    latest_handshake: live?.latest_handshake || null,
    rx_bytes: live?.rx_bytes || 0,
    tx_bytes: live?.tx_bytes || 0,
  };
}

// ----------------------------------- Client-Config --------------------------

function renderClientConf(peer) {
  return [
    '[Interface]',
    `PrivateKey = ${peer.private_key}`,
    `Address = ${peer.assigned_ip}/32`,
    `DNS = ${CLIENT_DNS}`,
    '',
    '[Peer]',
    `PublicKey = ${state.server_public_key}`,
    peer.preshared_key ? `PresharedKey = ${peer.preshared_key}` : '',
    `AllowedIPs = ${peer.allowed_ips || '0.0.0.0/0, ::/0'}`,
    `Endpoint = ${WG_ENDPOINT_HOST}:${WG_LISTEN_PORT}`,
    'PersistentKeepalive = 25',
    '',
  ].filter(Boolean).join('\n');
}

// ----------------------------------- Startup-Sync ---------------------------

function applyAll() {
  ensureServerKeys();
  writeWgConf();
  ensureWgUp();
  syncWgInterface();
  nftReady();
  ensureMasqueradeRules();
  ensureVlanRoutingTables();
  clearAllPeerRules();
  for (const p of state.peers) addPeerRule(p);
}

// ----------------------------------- HTTP -----------------------------------

function send(res, status, payload, contentType) {
  if (Buffer.isBuffer(payload)) {
    res.writeHead(status, { 'Content-Type': contentType || 'application/octet-stream' });
    res.end(payload);
  } else if (typeof payload === 'string') {
    res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8' });
    res.end(payload);
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 65536) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

function routeMatch(req, method, pattern) {
  if (req.method !== method) return null;
  const re = new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$');
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(re);
  return m ? m.slice(1) : null;
}

const server = createServer(async (req, res) => {
  try {
    // Health (no auth)
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, peers: state.peers.length, listen_port: WG_LISTEN_PORT });
    }
    // Auth
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let m;
    if (req.method === 'GET' && req.url === '/peers') {
      const dump = wgDump();
      return send(res, 200, { peers: state.peers.map(p => peerWithStatus(p, dump)) });
    }

    if ((m = routeMatch(req, 'GET', '/peers/:id'))) {
      const p = state.peers.find(x => x.id === m[0]);
      if (!p) return send(res, 404, { error: 'not found' });
      return send(res, 200, peerWithStatus(p));
    }

    if ((m = routeMatch(req, 'GET', '/peers/:id/config'))) {
      const p = state.peers.find(x => x.id === m[0]);
      if (!p) return send(res, 404, { error: 'not found' });
      return send(res, 200, renderClientConf(p), 'text/plain; charset=utf-8');
    }

    if ((m = routeMatch(req, 'GET', '/peers/:id/qr'))) {
      const p = state.peers.find(x => x.id === m[0]);
      if (!p) return send(res, 404, { error: 'not found' });
      const png = execFileSync('qrencode', ['-t', 'PNG', '-o', '-', '-s', '6'], {
        input: renderClientConf(p), maxBuffer: 4 * 1024 * 1024,
      });
      return send(res, 200, png, 'image/png');
    }

    if (req.method === 'POST' && req.url === '/peers') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { name, email, vlan, allowed_ips } = body;
      if (!name) return send(res, 400, { error: 'name required' });
      if (!VLAN_TO_IFACE[vlan]) return send(res, 400, { error: `unknown vlan ${vlan}` });

      const priv = wgGenKey();
      const peer = {
        id: randomUUID(),
        name: String(name).slice(0, 80),
        email: email ? String(email).toLowerCase() : null,
        vlan: parseInt(vlan, 10),
        assigned_ip: nextFreeIp(),
        public_key: wgPubKey(priv),
        private_key: priv,
        preshared_key: wgPresharedKey(),
        // Welche Ziele durch den Tunnel gehen. Ohne Angabe wie bisher alles.
        // Laptops bekommen hier 100.64.0.0/16: sie behalten ausser Haus ihren
        // eigenen Weg ins Internet, nur das Hausnetz laeuft durch den Tunnel.
        allowed_ips: allowed_ips ? String(allowed_ips).slice(0, 200) : null,
        created_at: new Date().toISOString(),
      };

      state.peers.push(peer);
      saveState(state);
      writeWgConf();
      syncWgInterface();
      addPeerRule(peer);

      return send(res, 200, { ...peerWithStatus(peer), config: renderClientConf(peer) });
    }

    if ((m = routeMatch(req, 'DELETE', '/peers/:id'))) {
      const idx = state.peers.findIndex(x => x.id === m[0]);
      if (idx < 0) return send(res, 404, { error: 'not found' });
      const peer = state.peers[idx];
      delPeerRule(peer);
      state.peers.splice(idx, 1);
      saveState(state);
      writeWgConf();
      try { syncWgInterface(); } catch {}
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'route not found' });
  } catch (err) {
    console.error('[wg-control]', err);
    return send(res, 500, { error: err.message });
  }
});

applyAll();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`wg-control listening on :${PORT} | endpoint=${WG_ENDPOINT_HOST}:${WG_LISTEN_PORT} | peers=${state.peers.length}`);
});
