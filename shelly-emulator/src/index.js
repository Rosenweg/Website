#!/usr/bin/env node
/**
 * Rosenweg PV-Ueberschuss Shelly-Emulator
 *
 * Emuliert ein Shelly Pro 3EM Gen2 Energiemessgeraet. Liefert via Shelly-RPC
 * (Gen2) HTTP-API die zwei Ueberschuss-Werte als Phase-Leistungen:
 *   Phase A (em:0/a) = Ueberschuss OHNE Boiler  → "wirklich frei" in W
 *   Phase B (em:0/b) = Ueberschuss MIT Boiler   → "verfuegbar wenn Heizstab aus"
 *   Phase C (em:0/c) = Heizstab-Verbrauch       → Bonus-Sichtbarkeit
 *
 * Daten werden alle 10s vom Backend gepollt (cached zwischen Calls).
 *
 * Auto-Discovery: mDNS Announce _shelly._tcp + _http._tcp
 *
 * Endpunkte (Shelly Gen2 RPC kompatibel):
 *   GET  /shelly                           — Basic info (legacy compat)
 *   GET  /rpc/Shelly.GetDeviceInfo
 *   GET  /rpc/Shelly.GetStatus
 *   GET  /rpc/Shelly.GetConfig
 *   GET  /rpc/EM.GetStatus?id=0
 *   GET  /rpc/EM.GetConfig?id=0
 *   POST /rpc                              — JSON-RPC 2.0 multiplex
 */
import http from 'node:http';
import os from 'node:os';
import bonjourPkg from 'bonjour-service';
const Bonjour = bonjourPkg.Bonjour || bonjourPkg.default?.Bonjour || bonjourPkg.default || bonjourPkg;

const PORT = parseInt(process.env.PORT, 10) || 80;
const BACKEND = process.env.BACKEND_URL || 'https://www.rosenweg4303.ch/api/energy/shelly';
const POLL_MS = parseInt(process.env.POLL_MS, 10) || 10_000;
const GROUP = process.env.ENERGY_GROUP || 'r9';

// Device-Identitaet — deterministisch aus Hostname + Group damit MAC stabil bleibt
const HOSTNAME = process.env.SHELLY_HOSTNAME || `shellypvrosenweg9`;
const MAC = (process.env.SHELLY_MAC || generateMac(HOSTNAME + GROUP)).toLowerCase().replace(/:/g, '');
const FW = '1.4.4';
const APP = 'Pro3EM';

function generateMac(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hex = Math.abs(h).toString(16).padStart(12, '0').slice(-12);
  return ('a4' + hex.slice(2)).match(/.{2}/g).join(':');
}

// ─── Backend-Cache ──────────────────────────────────────────────────
let cache = {
  ts: 0,
  // Generische Phasen (vom Backend variant-spezifisch befuellt)
  phase_a_w: 0, phase_a_label: '',
  phase_b_w: 0, phase_b_label: '',
  phase_c_w: 0, phase_c_label: '',
  // Backward-compat Felder
  heizstab_w: 0,
  production_w: 0,
  grid_w: 0,
  battery_soc: null,
  error: null,
};

async function poll() {
  try {
    // Backend-URL kann schon ?variant=...&group=... enthalten; sonst defaults anhaengen
    const sep = BACKEND.includes('?') ? '&' : '?';
    const fullUrl = BACKEND.includes('group=') ? BACKEND : BACKEND + sep + 'group=' + encodeURIComponent(GROUP);
    const r = await fetch(fullUrl, {
      headers: { 'User-Agent': 'rosenweg-shelly-emu/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    cache = {
      ts: Date.now(),
      // Bevorzugt generische Phasen, sonst Fallback auf surplus-Felder
      phase_a_w: Math.round(d.phase_a_w ?? d.surplus_without_boiler_w ?? 0),
      phase_a_label: d.phase_a_label || 'Phase A',
      phase_b_w: Math.round(d.phase_b_w ?? d.surplus_with_boiler_w ?? 0),
      phase_b_label: d.phase_b_label || 'Phase B',
      phase_c_w: Math.round(d.phase_c_w ?? d.heizstab_w ?? 0),
      phase_c_label: d.phase_c_label || 'Phase C',
      heizstab_w: Math.round(d.heizstab_w || 0),
      production_w: Math.round(d.production_w || 0),
      grid_w: Math.round(d.grid_w || 0),
      battery_soc: d.battery_soc != null ? Math.round(d.battery_soc) : null,
      error: null,
    };
  } catch (e) {
    cache.error = e.message;
    console.error('[poll]', e.message);
  }
}
setInterval(poll, POLL_MS);
await poll();

// ─── Shelly-RPC Response-Builder ────────────────────────────────────
function rpcGetDeviceInfo() {
  return {
    name: 'Rosenweg 9 PV-Ueberschuss (virtual)',
    id: HOSTNAME + '-' + MAC.slice(-6),
    mac: MAC.toUpperCase(),
    model: 'SPEM-003CEBEU',
    gen: 2,
    fw_id: '20251015-' + FW,
    ver: FW,
    app: APP,
    auth_en: false,
    auth_domain: null,
    discoverable: true,
  };
}

function rpcShellyGetConfig() {
  return {
    ble: { enable: false, rpc: { enable: false } },
    cloud: { enable: false, server: null },
    em: { 0: rpcEmGetConfig() },
    mqtt: { enable: false },
    sys: { device: { name: 'Rosenweg 9 PV-Ueberschuss', mac: MAC.toUpperCase() }, location: { tz: 'Europe/Zurich' } },
    wifi: { ap: { enable: false }, sta: { enable: true } },
  };
}

function rpcEmGetConfig() {
  return {
    id: 0,
    name: null,
    blink_mode_selector: 'active_energy',
    phase_sequence: 'abc',
    monitor_phase_sequence: false,
    ct_type: '120A',
    reverse: { a: false, b: false, c: false },
  };
}

function rpcShellyGetStatus() {
  return {
    'em:0': rpcEmGetStatus(),
    'sys': {
      mac: MAC.toUpperCase(),
      restart_required: false,
      time: new Date().toTimeString().slice(0, 8),
      unixtime: Math.floor(Date.now() / 1000),
      uptime: Math.floor(process.uptime()),
      ram_size: 65536,
      ram_free: 32768,
      fs_size: 524288,
      fs_free: 262144,
      cfg_rev: 1,
      kvs_rev: 0,
      schedule_rev: 0,
      webhook_rev: 0,
      available_updates: {},
    },
    'cloud': { connected: false },
    'wifi': { sta_ip: null, status: 'got ip', ssid: 'rosenweg-internal', rssi: -50 },
  };
}

// EM-Status liefert pro Phase: voltage, current, power, pf, freq.
// Wir mappen die zwei Ueberschuss-Werte und Heizstab auf Phase A/B/C als
// active power (W). Voltage 230V fix.
function rpcEmGetStatus() {
  const stale = (Date.now() - cache.ts) > POLL_MS * 3;
  const a = stale ? 0 : cache.phase_a_w;
  const b = stale ? 0 : cache.phase_b_w;
  const c = stale ? 0 : cache.phase_c_w;
  const V = 230;
  return {
    id: 0,
    a_current: a / V, a_voltage: V, a_act_power: a, a_aprt_power: Math.abs(a), a_pf: 1.0, a_freq: 50.0,
    b_current: b / V, b_voltage: V, b_act_power: b, b_aprt_power: Math.abs(b), b_pf: 1.0, b_freq: 50.0,
    c_current: c / V, c_voltage: V, c_act_power: c, c_aprt_power: Math.abs(c), c_pf: 1.0, c_freq: 50.0,
    n_current: null,
    total_current: (a + b + c) / V,
    total_act_power: a + b + c,
    total_aprt_power: Math.abs(a) + Math.abs(b) + Math.abs(c),
    user_calibrated_phase: [],
  };
}

// Gen1-Legacy /shelly Endpoint fuer Discovery
function legacyShelly() {
  return {
    type: 'SPEM-003CEBEU',
    mac: MAC.toUpperCase(),
    auth: false,
    fw: FW,
    discoverable: true,
    longid: 1,
    num_outputs: 0,
    num_meters: 1,
    num_emeters: 3,
  };
}

// ─── RPC-Dispatcher ─────────────────────────────────────────────────
const RPC = {
  'Shelly.GetDeviceInfo': () => rpcGetDeviceInfo(),
  'Shelly.GetStatus': () => rpcShellyGetStatus(),
  'Shelly.GetConfig': () => rpcShellyGetConfig(),
  'EM.GetStatus': (p) => rpcEmGetStatus(p),
  'EM.GetConfig': (p) => rpcEmGetConfig(p),
};

// ─── HTTP-Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Server', 'Mongoose/' + FW);
  function json(obj, code = 200) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  if (req.method === 'GET' && url.pathname === '/shelly') return json(legacyShelly());

  if (req.method === 'GET' && url.pathname.startsWith('/rpc/')) {
    const method = url.pathname.slice(5);
    if (!RPC[method]) return json({ code: -32601, message: 'Method not found: ' + method }, 404);
    const params = Object.fromEntries(url.searchParams.entries());
    try { return json(RPC[method](params)); }
    catch (e) { return json({ code: -32000, message: e.message }, 500); }
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const rpcReq = JSON.parse(body);
        if (!RPC[rpcReq.method]) {
          return json({ id: rpcReq.id, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } });
        }
        const result = RPC[rpcReq.method](rpcReq.params || {});
        return json({ id: rpcReq.id, src: HOSTNAME, dst: rpcReq.src, result });
      } catch (e) {
        return json({ error: { code: -32700, message: 'Parse error: ' + e.message } }, 400);
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json({ status: 'ok', cache_age_s: Math.round((Date.now() - cache.ts) / 1000), cache });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><title>Rosenweg PV Emulator</title></head>
<body style="font-family:sans-serif;padding:20px;">
<h1>Rosenweg 9 — virtueller Shelly Pro 3EM</h1>
<p>Emuliert ein Shelly Pro 3EM Gen2. Aktuelles Mapping:</p>
<ul>
  <li><strong>Phase A</strong> = ${cache.phase_a_label}: ${cache.phase_a_w} W</li>
  <li><strong>Phase B</strong> = ${cache.phase_b_label}: ${cache.phase_b_w} W</li>
  <li><strong>Phase C</strong> = ${cache.phase_c_label}: ${cache.phase_c_w} W</li>
</ul>
<p>Backend: <code>${BACKEND}</code><br>
Last update: ${cache.ts ? new Date(cache.ts).toLocaleString('de-CH') : 'never'}<br>
MAC: ${MAC.toUpperCase()}<br>
Hostname: ${HOSTNAME}</p>
<p><a href="/rpc/Shelly.GetDeviceInfo">/rpc/Shelly.GetDeviceInfo</a> · <a href="/rpc/EM.GetStatus?id=0">/rpc/EM.GetStatus</a> · <a href="/health">/health</a></p>
</body></html>`);
  }

  res.writeHead(404);
  res.end('Not Found');
});
server.listen(PORT, () => {
  console.log(`[shelly-emulator] listening on :${PORT}, polling ${BACKEND} every ${POLL_MS}ms`);
  console.log(`[shelly-emulator] device id: ${HOSTNAME}, MAC: ${MAC.toUpperCase()}`);
});

// ─── mDNS-Announce ──────────────────────────────────────────────────
try {
  const bonjour = new Bonjour();
  bonjour.publish({
    name: HOSTNAME,
    type: 'shelly',
    protocol: 'tcp',
    port: PORT,
    txt: {
      arch: 'esp32',
      app: APP,
      ver: FW,
      gen: '2',
      id: HOSTNAME + '-' + MAC.slice(-6),
    },
  });
  bonjour.publish({ name: HOSTNAME, type: 'http', protocol: 'tcp', port: PORT });
  console.log(`[shelly-emulator] mDNS announce active for ${HOSTNAME}._shelly._tcp.local`);
} catch (e) { console.warn('[shelly-emulator] mDNS failed:', e.message); }
